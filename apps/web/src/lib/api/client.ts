import { base64UrlEncode } from "../base58";
import { type CanonicalValue, canonicalDigest, fromHex, fromTypedJson, sha256, toHex } from "../canonical";
import { signBytes } from "../keys";
import { buildPath, ENDPOINTS, type EndpointSpec } from "./endpoints";
import type {
  ApiErrorBody,
  AuditEvent,
  Capability,
  ChallengeResponse,
  HumanCapability,
  HumanChallengePayload,
  HumanChallengePurpose,
  InvitationCreated,
  MeResponse,
  ReadyResponse,
  RoleGrantView,
  ServiceEnrollmentView,
  SessionGrant,
  TradeDetail,
  TradeListResponse,
} from "./types";

/** Signing domains used by the browser (packages/core/src/signing.ts SIGNING_DOMAINS). */
export const DOMAINS = {
  POP_CHALLENGE: "dockside/pop-challenge",
  REQUEST_PROOF: "dockside/request-proof",
} as const;

export type ApiFailure =
  /** The backend answered that this route does not exist in the running build. */
  | { readonly kind: "endpoint-unavailable"; readonly method: string; readonly path: string }
  | {
      readonly kind: "http";
      readonly status: number;
      readonly code: string;
      readonly message: string;
      readonly details: Record<string, unknown>;
    }
  | { readonly kind: "network"; readonly message: string }
  | { readonly kind: "no-session" }
  | { readonly kind: "invalid-response"; readonly message: string }
  /** The client refused to sign because the server-supplied facts did not match the request. */
  | { readonly kind: "refused-to-sign"; readonly reason: string };

export type ApiOutcome<T> =
  | { readonly ok: true; readonly data: T; readonly status: number; readonly receivedAt: number }
  | { readonly ok: false; readonly error: ApiFailure; readonly receivedAt: number };

export interface ActiveSession {
  readonly grant: SessionGrant;
  readonly publicKey: string;
  readonly privateKey: CryptoKey;
}

export interface ClientOptions {
  /** Base URL of the API. "" means same origin (the web server proxies /v1, /healthz, /readyz). */
  readonly baseUrl: string;
  /** The origin the API is configured with (DOCKSIDE_ORIGIN); bound into every proof. */
  readonly origin: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** Observer for connection freshness; called after every response or network failure. */
  readonly onTransport?: (event: { ok: boolean; at: number; networkError: boolean }) => void;
}

export interface ChallengeExpectation {
  readonly purpose: HumanChallengePurpose;
  readonly publicKey: string;
  readonly subjectName?: string;
}

export interface VerifiedChallenge {
  readonly challenge: ChallengeResponse;
  readonly payload: HumanChallengePayload;
  readonly digest: Uint8Array;
}

function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return toHex(b);
}

/**
 * Typed client for the Dockside control API. Every authenticated call carries the
 * session token plus a fresh `Dockside-Proof` signed by the device key over
 * {sessionId, origin, method, path+query, SHA-256(body), issuedAt, nonce}. The client
 * performs no authorization or state decisions; it only reports what the server said.
 */
export class DocksideClient {
  private session: ActiveSession | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: ClientOptions) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = opts.now ?? Date.now;
  }

  get origin(): string {
    return this.opts.origin;
  }

  setSession(s: ActiveSession | null): void {
    this.session = s;
  }

  getSession(): ActiveSession | null {
    return this.session;
  }

  /* ------------------------------ transport ------------------------------ */

  async call<T>(
    spec: EndpointSpec,
    options: {
      params?: Record<string, string>;
      query?: Record<string, string>;
      body?: unknown;
      signal?: AbortSignal;
    } = {},
  ): Promise<ApiOutcome<T>> {
    let path: string;
    try {
      path = buildPath(spec, options.params);
    } catch (e) {
      return {
        ok: false,
        error: { kind: "invalid-response", message: (e as Error).message },
        receivedAt: this.now(),
      };
    }
    const qs = options.query ? new URLSearchParams(options.query).toString() : "";
    const pathWithQuery = qs ? `${path}?${qs}` : path;
    const bodyText = spec.method === "POST" ? JSON.stringify(options.body ?? {}) : "";
    const bodyBytes = new TextEncoder().encode(bodyText);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (spec.method === "POST") headers["Content-Type"] = "application/json";
    if (spec.auth) {
      const s = this.session;
      if (!s) return { ok: false, error: { kind: "no-session" }, receivedAt: this.now() };
      const issuedAt = this.now();
      const nonce = randomHex(16);
      const payload: CanonicalValue = {
        sessionId: s.grant.sessionId,
        origin: this.opts.origin,
        method: spec.method,
        path: pathWithQuery,
        bodyDigest: toHex(await sha256(bodyBytes)),
        issuedAt,
        nonce,
      };
      const digest = await canonicalDigest(DOMAINS.REQUEST_PROOF, 1, payload);
      const signature = await signBytes(s.privateKey, digest);
      const proof = JSON.stringify({ sessionId: s.grant.sessionId, issuedAt, nonce, signature });
      headers["Authorization"] = `Dockside-Session ${s.grant.sessionToken}`;
      headers["Dockside-Proof"] = base64UrlEncode(new TextEncoder().encode(proof));
    }
    let res: Response;
    try {
      const init: RequestInit = { method: spec.method, headers, credentials: "omit", cache: "no-store" };
      if (spec.method === "POST") init.body = bodyText;
      if (options.signal) init.signal = options.signal;
      res = await this.fetchImpl(`${this.opts.baseUrl}${pathWithQuery}`, init);
    } catch (e) {
      const at = this.now();
      this.opts.onTransport?.({ ok: false, at, networkError: true });
      return { ok: false, error: { kind: "network", message: (e as Error).message }, receivedAt: at };
    }
    const at = this.now();
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      this.opts.onTransport?.({ ok: false, at, networkError: res.status >= 500 });
      return {
        ok: false,
        error: { kind: "invalid-response", message: `non-JSON response (HTTP ${res.status})` },
        receivedAt: at,
      };
    }
    this.opts.onTransport?.({ ok: true, at, networkError: false });
    if (res.ok) return { ok: true, data: json as T, status: res.status, receivedAt: at };
    const err = (json as { error?: ApiErrorBody }).error;
    if (!err || typeof err.code !== "string") {
      return {
        ok: false,
        error: { kind: "invalid-response", message: `unexpected error body (HTTP ${res.status})` },
        receivedAt: at,
      };
    }
    if (err.code === "NOT_FOUND" && err.message === "no such endpoint") {
      return {
        ok: false,
        error: { kind: "endpoint-unavailable", method: spec.method, path },
        receivedAt: at,
      };
    }
    return {
      ok: false,
      error: {
        kind: "http",
        status: res.status,
        code: err.code,
        message: err.message,
        details: err.details ?? {},
      },
      receivedAt: at,
    };
  }

  /* --------------------------- challenge signing --------------------------- */

  /**
   * Recompute the challenge digest from the typed payload and check that the server bound
   * exactly the origin, purpose, key and subject this user asked for. Returns the digest
   * to sign, or a refusal. Nothing is signed here; signing needs an explicit user action.
   */
  async verifyChallenge(
    c: ChallengeResponse,
    expect: ChallengeExpectation,
  ): Promise<{ ok: true; value: VerifiedChallenge } | { ok: false; reason: string }> {
    let value: CanonicalValue;
    try {
      value = fromTypedJson(c.payload);
    } catch (e) {
      return { ok: false, reason: `challenge payload is not canonical: ${(e as Error).message}` };
    }
    if (value === null || typeof value !== "object" || Array.isArray(value) || value instanceof Uint8Array)
      return { ok: false, reason: "challenge payload is not a struct" };
    const p = value as unknown as HumanChallengePayload;
    const digest = await canonicalDigest(DOMAINS.POP_CHALLENGE, 1, value);
    if (toHex(digest) !== c.digestHex) return { ok: false, reason: "server digest does not match payload" };
    if (p.challengeId !== c.challengeId) return { ok: false, reason: "challenge id mismatch" };
    if (p.origin !== this.opts.origin)
      return { ok: false, reason: `challenge is bound to origin ${p.origin}` };
    if (p.purpose !== expect.purpose) return { ok: false, reason: `unexpected purpose ${p.purpose}` };
    if (p.publicKey !== expect.publicKey) return { ok: false, reason: "challenge names a different key" };
    if (expect.subjectName !== undefined && p.subjectName !== expect.subjectName)
      return { ok: false, reason: "challenge names a different subject" };
    if (p.expiresAt <= this.now()) return { ok: false, reason: "challenge already expired" };
    return { ok: true, value: { challenge: c, payload: p, digest: fromHex(c.digestHex) } };
  }

  async signVerified(v: VerifiedChallenge, privateKey: CryptoKey): Promise<string> {
    return signBytes(privateKey, v.digest);
  }

  /* -------------------------------- M01 API -------------------------------- */

  ready(): Promise<ApiOutcome<ReadyResponse>> {
    return this.call(ENDPOINTS.ready);
  }
  health(): Promise<ApiOutcome<{ status: string }>> {
    return this.call(ENDPOINTS.health);
  }
  bootstrapChallenge(organizationName: string, publicKey: string): Promise<ApiOutcome<ChallengeResponse>> {
    return this.call(ENDPOINTS.bootstrapChallenge, { body: { organizationName, publicKey } });
  }
  bootstrapComplete(challengeId: string, signature: string): Promise<ApiOutcome<SessionGrant>> {
    return this.call(ENDPOINTS.bootstrapComplete, {
      body: { challengeId, proof: { scheme: "dockside-ed25519", signature } },
    });
  }
  loginChallenge(principalId: string, publicKey: string): Promise<ApiOutcome<ChallengeResponse>> {
    return this.call(ENDPOINTS.loginChallenge, { body: { principalId, publicKey } });
  }
  loginComplete(challengeId: string, signature: string): Promise<ApiOutcome<SessionGrant>> {
    return this.call(ENDPOINTS.loginComplete, {
      body: { challengeId, proof: { scheme: "dockside-ed25519", signature } },
    });
  }
  invitationChallenge(
    invitationSecret: string,
    publicKey: string,
    displayName?: string,
  ): Promise<ApiOutcome<ChallengeResponse>> {
    return this.call(ENDPOINTS.invitationChallenge, {
      body: displayName ? { invitationSecret, publicKey, displayName } : { invitationSecret, publicKey },
    });
  }
  acceptInvitation(challengeId: string, signature: string): Promise<ApiOutcome<SessionGrant>> {
    return this.call(ENDPOINTS.acceptInvitation, {
      body: { challengeId, proof: { scheme: "dockside-ed25519", signature } },
    });
  }
  me(): Promise<ApiOutcome<MeResponse>> {
    return this.call(ENDPOINTS.me);
  }
  createInvitation(capability: HumanCapability): Promise<ApiOutcome<InvitationCreated>> {
    return this.call(ENDPOINTS.createInvitation, { body: { capability } });
  }
  grantInvitation(invitationId: string, capability?: Capability): Promise<ApiOutcome<RoleGrantView>> {
    return this.call(ENDPOINTS.grantInvitation, {
      params: { id: invitationId },
      body: capability ? { capability } : {},
    });
  }
  getServiceEnrollment(enrollmentId: string): Promise<ApiOutcome<ServiceEnrollmentView>> {
    return this.call(ENDPOINTS.getServiceEnrollment, { params: { id: enrollmentId } });
  }
  audit(limit = 200): Promise<ApiOutcome<{ events: AuditEvent[] }>> {
    return this.call(ENDPOINTS.audit, { query: { limit: String(limit) } });
  }

  /* ------------------------------ planned API ------------------------------ */

  listTrades(): Promise<ApiOutcome<TradeListResponse>> {
    return this.call(ENDPOINTS.listTrades);
  }
  createTrade(draft: unknown): Promise<ApiOutcome<{ tradeId: string }>> {
    return this.call(ENDPOINTS.createTrade, { body: draft });
  }
  getTrade(tradeId: string): Promise<ApiOutcome<TradeDetail>> {
    return this.call(ENDPOINTS.getTrade, { params: { id: tradeId } });
  }
  tradeSection(
    section:
      | "tradeEvidence"
      | "tradeHolds"
      | "tradeRelease"
      | "tradePayout"
      | "tradeRefund"
      | "tradeTimeline",
    tradeId: string,
  ): Promise<ApiOutcome<Record<string, unknown>>> {
    return this.call(ENDPOINTS[section], { params: { id: tradeId } });
  }
  listInspections(): Promise<ApiOutcome<{ inspections: unknown[] }>> {
    return this.call(ENDPOINTS.listInspections);
  }
  listPayouts(): Promise<ApiOutcome<{ payouts: unknown[] }>> {
    return this.call(ENDPOINTS.listPayouts);
  }
}
