import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthContext, AuthorityService, RequestProof } from "@dockside/authority";
import {
  type AuthorityAction,
  CAPABILITIES,
  type Clock,
  capabilityAllows,
  type DocksideConfig,
  DocksideError,
  fail,
  type IdGenerator,
  parseStrictJson,
  parseWith,
  sha256,
  toHex,
} from "@dockside/core";
import { AuditLog, type Database, isUniqueViolation, loadMigrations, type SqlValue } from "@dockside/store";
import { z } from "zod";
import { assetRoutes } from "./assets.js";
import { addressKey, RateLimiter, sessionKey } from "./limits.js";
import { refundRoutes } from "./refunds.js";
import { type HandlerInput, type Route, route } from "./routing.js";
import { type TradeModules, tradeRoutes } from "./trades.js";

export { buildAuditExport, stableStringify, verifyAuditExport } from "./export.js";
export { hardenServer, RateLimiter, SERVER_LIMITS } from "./limits.js";
export { type Handler, type HandlerInput, type Route, route } from "./routing.js";
export { relationsOf, type TradeModules } from "./trades.js";

/**
 * Dockside control API — M01 authority surface. node:http, strict JSON bodies, exact
 * origin binding, session token + per-request Ed25519 proof of possession on every
 * authenticated call, typed error envelope, security headers on every response.
 */
export const MAX_BODY_BYTES = 64 * 1024;

export interface AppDeps {
  readonly config: DocksideConfig;
  readonly db: Database;
  readonly authority: AuthorityService;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly log?: (line: Record<string, unknown>) => void;
  /**
   * M03-M05 services over persisted state and chain observations (M07). Absent when the
   * process has no escrow contract / RPC configuration; trade routes then answer
   * NOT_FOUND "no such endpoint" with reason TRADE_MODULES_NOT_CONFIGURED.
   */
  readonly modules?: TradeModules;
  /** Request limiter; one per process by default (M09). */
  readonly limiter?: RateLimiter;
}

/* ------------------------------ schemas ------------------------------ */

const proof = z
  .object({ scheme: z.enum(["dockside-ed25519", "nep413"]), signature: z.string().max(128) })
  .strict();
const complete = z.object({ challengeId: z.string().max(64), proof }).strict();
const capability = z.enum(CAPABILITIES);
const custody = z.object({ kind: z.string().max(32), reference: z.string().max(160) }).strict();
const pk = z.string().max(64);
const scope = z
  .object({
    organizationId: z.string().max(64).optional(),
    tradeId: z.string().max(64).nullable(),
    evidencePolicyId: z.string().max(64),
    evidencePolicyRevision: z.number().int(),
  })
  .strict();
const empty = z.object({}).strict();

function challengeJson(c: {
  challengeId: string;
  purpose: string;
  typedPayload: unknown;
  digestHex: string;
  expiresAt: number;
  nep413?: unknown;
}) {
  return {
    challengeId: c.challengeId,
    purpose: c.purpose,
    payload: c.typedPayload,
    digestHex: c.digestHex,
    expiresAt: c.expiresAt,
    ...(c.nep413 === undefined ? {} : { nep413: c.nep413 }),
  };
}

function requireAction(ctx: AuthContext | null, action: AuthorityAction): AuthContext {
  if (!ctx) fail("UNAUTHENTICATED", "authentication required");
  if (!capabilityAllows(action, ctx.capabilities)) fail("FORBIDDEN", `capability required for ${action}`);
  return ctx;
}

function must(ctx: AuthContext | null): AuthContext {
  if (!ctx) fail("UNAUTHENTICATED", "authentication required");
  return ctx;
}

export function buildRoutes(d: AppDeps): Route[] {
  const a = d.authority;
  const r = route;
  return [
    r("GET", "/healthz", false, undefined, () => ({ status: "ok" })),
    r("GET", "/readyz", false, undefined, () => {
      const v = d.db.schemaVersion();
      const expected = loadMigrations().length;
      if (v !== expected) fail("MIGRATION_FAILED", "database schema is not at the expected version");
      return {
        ready: true,
        schemaVersion: v,
        network: d.config.DOCKSIDE_NETWORK,
        fundedPayouts: d.config.DOCKSIDE_FUNDED_PAYOUTS,
      };
    }),
    r(
      "POST",
      "/v1/bootstrap/challenges",
      false,
      z.object({ organizationName: z.string().max(240), publicKey: pk }).strict(),
      ({ body }) =>
        challengeJson(a.createBootstrapChallenge(body as { organizationName: string; publicKey: string })),
    ),
    r("POST", "/v1/bootstrap/complete", false, complete, ({ body }) =>
      a.completeBootstrap(body as z.infer<typeof complete>),
    ),
    r(
      "POST",
      "/v1/sessions/challenges",
      false,
      z.object({ principalId: z.string().max(64), publicKey: pk }).strict(),
      ({ body }) => challengeJson(a.createLoginChallenge(body as { principalId: string; publicKey: string })),
    ),
    r("POST", "/v1/sessions/complete", false, complete, ({ body }) =>
      a.completeLogin(body as z.infer<typeof complete>),
    ),
    r("GET", "/v1/me", true, undefined, ({ ctx }) => {
      const c = must(ctx);
      return {
        principal: c.principal,
        keyVersion: c.keyVersion,
        organizationId: c.organizationId,
        capabilities: c.capabilities,
        session: c.session,
      };
    }),
    r("GET", "/v1/me/keys", true, undefined, ({ ctx }) => a.ownKeys(must(ctx))),
    r("GET", "/v1/organization/directory", true, undefined, ({ ctx }) => a.organizationDirectory(must(ctx))),
    r(
      "POST",
      "/v1/invitations",
      true,
      z.object({ capability, expiresInMs: z.number().int().optional() }).strict(),
      ({ ctx, body }) => {
        const b = body as { capability: (typeof CAPABILITIES)[number]; expiresInMs?: number };
        return a.createInvitation(
          must(ctx),
          b.expiresInMs === undefined
            ? { capability: b.capability }
            : { capability: b.capability, expiresInMs: b.expiresInMs },
        );
      },
    ),
    r(
      "POST",
      "/v1/invitations/challenges",
      false,
      z
        .object({
          invitationSecret: z.string().max(64),
          publicKey: pk,
          displayName: z.string().max(240).optional(),
        })
        .strict(),
      ({ body }) => {
        const b = body as { invitationSecret: string; publicKey: string; displayName?: string };
        return challengeJson(
          a.createInvitationChallenge(
            b.displayName === undefined
              ? { invitationSecret: b.invitationSecret, publicKey: b.publicKey }
              : { ...b, displayName: b.displayName },
          ),
        );
      },
    ),
    r("POST", "/v1/invitations/accept", false, complete, ({ body, presentedSessionToken }) => {
      const b = body as z.infer<typeof complete>;
      return a.acceptInvitation(presentedSessionToken === undefined ? b : { ...b, presentedSessionToken });
    }),
    r(
      "POST",
      "/v1/invitations/:id/grant",
      true,
      z.object({ capability: capability.optional() }).strict(),
      ({ ctx, params, body }) => {
        const b = body as { capability?: (typeof CAPABILITIES)[number] };
        const id = params["id"] as string;
        return a.grantRole(
          must(ctx),
          b.capability === undefined ? { invitationId: id } : { invitationId: id, capability: b.capability },
        );
      },
    ),
    r(
      "POST",
      "/v1/principals/:id/capabilities",
      true,
      z.object({ capability }).strict(),
      ({ ctx, params, body }) =>
        a.grantCapability(must(ctx), {
          principalId: params["id"] as string,
          capability: (body as { capability: (typeof CAPABILITIES)[number] }).capability,
        }),
    ),
    r(
      "POST",
      "/v1/keys/:id/revoke",
      true,
      z.object({ reason: z.string().max(64) }).strict(),
      ({ ctx, params, body }) =>
        a.revokeKey(must(ctx), {
          keyVersionId: params["id"] as string,
          reason: (body as { reason: string }).reason,
        }),
    ),
    r("POST", "/v1/keys/rotation/challenges", true, z.object({ publicKey: pk }).strict(), ({ ctx, body }) =>
      challengeJson(a.createKeyRotationChallenge(must(ctx), body as { publicKey: string })),
    ),
    r("POST", "/v1/keys/rotation/complete", true, complete, ({ ctx, body }) =>
      a.completeKeyRotation(must(ctx), body as z.infer<typeof complete>),
    ),
    r(
      "POST",
      "/v1/recoveries",
      true,
      z.object({ principalId: z.string().max(64), publicKey: pk }).strict(),
      ({ ctx, body }) => {
        const out = a.startRecovery(must(ctx), body as { principalId: string; publicKey: string });
        return { ...out, challenge: challengeJson(out.challenge) };
      },
    ),
    r("POST", "/v1/recoveries/prove", false, complete, ({ body }) =>
      a.proveRecovery(body as z.infer<typeof complete>),
    ),
    r("POST", "/v1/recoveries/:id/complete", true, empty, ({ ctx, params }) =>
      a.completeRecovery(must(ctx), { recoveryId: params["id"] as string }),
    ),
    r("POST", "/v1/recoveries/:id/cancel-challenges", false, empty, ({ params }) =>
      challengeJson(a.createRecoveryCancelChallenge({ recoveryId: params["id"] as string })),
    ),
    r("POST", "/v1/recoveries/cancel", false, complete, ({ body }) =>
      a.cancelRecovery(body as z.infer<typeof complete>),
    ),
    r(
      "POST",
      "/v1/service-enrollments",
      true,
      z.object({ serviceId: z.string().max(64), capability, publicKey: pk, scope, custody }).strict(),
      ({ ctx, body }) => {
        const out = a.createServiceEnrollment(
          must(ctx),
          body as Parameters<AuthorityService["createServiceEnrollment"]>[1],
        );
        return { ...out, challenge: challengeJson(out.challenge) };
      },
    ),
    r(
      "POST",
      "/v1/service-enrollments/prove",
      false,
      z.object({ challengeId: z.string().max(64), signature: z.string().max(128) }).strict(),
      ({ body }) => a.proveServiceKey(body as { challengeId: string; signature: string }),
    ),
    r(
      "POST",
      "/v1/service-enrollments/:id/activate",
      true,
      z.object({ keyVersion: z.number().int() }).strict(),
      ({ ctx, params, body }) =>
        a.activateServiceKey(must(ctx), {
          enrollmentId: params["id"] as string,
          keyVersion: (body as { keyVersion: number }).keyVersion,
        }),
    ),
    r(
      "POST",
      "/v1/service-enrollments/:id/rotate",
      true,
      z.object({ publicKey: pk, custody }).strict(),
      ({ ctx, params, body }) => {
        const out = a.rotateServiceKey(must(ctx), {
          enrollmentId: params["id"] as string,
          ...(body as { publicKey: string; custody: { kind: string; reference: string } }),
        });
        return { ...out, challenge: challengeJson(out.challenge) };
      },
    ),
    r(
      "POST",
      "/v1/service-enrollments/:id/recover",
      true,
      z.object({ publicKey: pk, custody }).strict(),
      ({ ctx, params, body }) => {
        const out = a.recoverServiceKey(must(ctx), {
          enrollmentId: params["id"] as string,
          ...(body as { publicKey: string; custody: { kind: string; reference: string } }),
        });
        return { ...out, challenge: challengeJson(out.challenge) };
      },
    ),
    r(
      "POST",
      "/v1/service-enrollments/:id/revoke",
      true,
      z.object({ keyVersion: z.number().int(), reason: z.string().max(64) }).strict(),
      ({ ctx, params, body }) =>
        a.revokeServiceKey(must(ctx), {
          enrollmentId: params["id"] as string,
          ...(body as { keyVersion: number; reason: string }),
        }),
    ),
    r("GET", "/v1/service-enrollments/:id", true, undefined, ({ ctx, params }) => {
      const c = must(ctx);
      const e = a.getServiceEnrollment(params["id"] as string);
      if (e.organizationId !== c.organizationId)
        fail("FORBIDDEN", "service enrollment belongs to another organization");
      return e;
    }),
    r("GET", "/v1/audit", true, undefined, ({ ctx, query }) => {
      const c = requireAction(ctx, "EXPORT_AUDIT");
      if (!c.capabilities.includes("ORG_SECURITY_ADMIN") && !c.capabilities.includes("AUDITOR"))
        fail("FORBIDDEN", "audit read requires security admin or auditor");
      const limit = Math.min(Number(query.get("limit") ?? "200") || 200, 1000);
      return { events: new AuditLog(d.db, d.clock, d.ids).list({ organizationId: c.organizationId }, limit) };
    }),
    ...tradeRoutes(d),
    ...refundRoutes(d),
    ...assetRoutes(d),
  ];
}

/* ------------------------------ transport ------------------------------ */

function securityHeaders(res: ServerResponse, origin: string): void {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  if (origin.startsWith("https:"))
    res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
}

function readBody(req: IncomingMessage, max: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? "0");
    if (declared > max) {
      reject(new DocksideError("LIMIT_EXCEEDED", "request body too large"));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new DocksideError("LIMIT_EXCEEDED", "request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}

function parseProofHeader(raw: string | undefined): RequestProof {
  if (!raw || raw.length > 1024) fail("UNAUTHENTICATED", "Dockside-Proof header required");
  let v: unknown;
  try {
    v = parseStrictJson(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    fail("UNAUTHENTICATED", "Dockside-Proof header is malformed");
  }
  return parseWith(
    z
      .object({
        sessionId: z.string().max(64),
        issuedAt: z.number().int(),
        nonce: z.string().max(64),
        signature: z.string().max(128),
      })
      .strict(),
    v,
  ) as RequestProof;
}

export function createApp(d: AppDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const routes = buildRoutes(d);
  const origin = d.config.DOCKSIDE_ORIGIN;
  const limiter = d.limiter ?? new RateLimiter(d.clock);
  const unauthLimit = d.config.DOCKSIDE_RATE_LIMIT_UNAUTH_PER_MIN;
  const sessionLimit = d.config.DOCKSIDE_RATE_LIMIT_SESSION_PER_MIN;
  return (req, res) => {
    const started = Date.now();
    securityHeaders(res, origin);
    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString(10) : v)));
      d.log?.({
        at: new Date().toISOString(),
        method: req.method,
        path: (req.url ?? "").split("?")[0],
        status,
        ms: Date.now() - started,
      });
    };
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", origin);
        const method =
          req.method === "GET" || req.method === "POST"
            ? req.method
            : fail("VALIDATION_FAILED", "method not allowed");
        const route = routes.find((r) => r.method === method && r.pattern.test(url.pathname));
        const authz = req.headers.authorization;
        const presentedSessionToken = authz?.startsWith("Dockside-Session ")
          ? authz.slice("Dockside-Session ".length)
          : undefined;
        // Limits apply before any body is read or signature verified. Health probes are exempt.
        const probe = method === "GET" && (url.pathname === "/healthz" || url.pathname === "/readyz");
        if (!probe) {
          if (route?.auth && presentedSessionToken !== undefined)
            limiter.take(sessionKey(presentedSessionToken), sessionLimit);
          else limiter.take(addressKey(req.socket.remoteAddress), unauthLimit);
        }
        if (!route) fail("NOT_FOUND", "no such endpoint");
        const params = (route.pattern.exec(url.pathname)?.groups ?? {}) as Record<string, string>;
        const reqOrigin = req.headers.origin;
        if (reqOrigin !== undefined && reqOrigin !== origin)
          fail("WRONG_ORIGIN", "cross-origin request rejected");
        if (req.headers["sec-fetch-site"] === "cross-site")
          fail("WRONG_ORIGIN", "cross-site request rejected");
        const raw =
          method === "POST" ? await readBody(req, route.maxBody ?? MAX_BODY_BYTES) : new Uint8Array(0);
        if (method === "POST" && !(req.headers["content-type"] ?? "").startsWith("application/json")) {
          fail("VALIDATION_FAILED", "content-type must be application/json");
        }
        let ctx: AuthContext | null = null;
        if (route.auth) {
          if (presentedSessionToken === undefined)
            fail("UNAUTHENTICATED", "Authorization: Dockside-Session <token> required");
          try {
            const p = parseProofHeader(req.headers["dockside-proof"] as string | undefined);
            ctx = d.authority.authenticate({
              sessionToken: presentedSessionToken,
              proof: p,
              method,
              path: url.pathname + url.search,
              body: raw,
            });
          } catch (e) {
            // Invented tokens get a fresh session window each; failures also count per address.
            limiter.take(addressKey(req.socket.remoteAddress), unauthLimit);
            throw e;
          }
        }
        const body = method === "POST" ? (raw.byteLength ? parseStrictJson(raw) : {}) : undefined;
        const validated = route.schema ? parseWith(route.schema, body) : body;
        const input: HandlerInput = {
          params,
          query: url.searchParams,
          body: validated,
          ctx,
          presentedSessionToken,
        };
        const idemKey = req.headers["idempotency-key"];
        if (method === "POST" && ctx && idemKey !== undefined) {
          const out = await idempotent(d.db, d.clock, ctx, url.pathname, String(idemKey), raw, () =>
            route.handler(input),
          );
          if (out.replayed) res.setHeader("Idempotent-Replay", "true");
          send(201, out.result);
          return;
        }
        const out = await route.handler(input);
        send(method === "POST" ? 201 : 200, out);
      } catch (e) {
        if (e instanceof DocksideError && e.code === "RATE_LIMITED")
          res.setHeader("Retry-After", String(e.details["retryAfterSeconds"] ?? 60));
        if (e instanceof DocksideError) send(e.httpStatus, { error: e.toJSON() });
        else send(500, { error: { code: "INTERNAL", message: "internal error", details: {} } });
      }
    })();
  };
}

/* ------------------------------ idempotency ------------------------------ */

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;
const PENDING = '{"pending":true}';

type IdemRow = { request_digest: string; response_json: string } & Record<string, SqlValue>;

/**
 * Optional `Idempotency-Key` on authenticated POSTs. The key is scoped to the principal and the
 * exact path, and bound to the SHA-256 of the exact body. The key is reserved before the handler
 * runs, so concurrent duplicates cannot both execute; an exact repeat replays the stored response;
 * a different body under the same key fails closed. A failed request releases its reservation and
 * stores nothing, so a replay can never turn a denied request into a stored success.
 */
async function idempotent(
  db: Database,
  clock: Clock,
  ctx: AuthContext,
  path: string,
  key: string,
  raw: Uint8Array,
  run: () => unknown,
): Promise<{ replayed: boolean; result: unknown }> {
  if (!IDEMPOTENCY_KEY.test(key)) fail("VALIDATION_FAILED", "Idempotency-Key malformed");
  const scope = `api:${ctx.principal.id}:POST ${path}`;
  const digest = toHex(sha256(raw));
  const existing = (): IdemRow | undefined =>
    db.get<IdemRow>(
      "SELECT request_digest, response_json FROM idempotency_keys WHERE scope = ? AND idem_key = ?",
      scope,
      key,
    );
  const decide = (row: IdemRow) => {
    if (row.request_digest !== digest)
      fail("IDEMPOTENCY_CONFLICT", "Idempotency-Key was used with a different request");
    if (row.response_json === PENDING)
      fail("VERSION_CONFLICT", "a request with this Idempotency-Key is in progress");
    return { replayed: true, result: JSON.parse(row.response_json) as unknown };
  };
  const prior = existing();
  if (prior) return decide(prior);
  try {
    db.run(
      "INSERT INTO idempotency_keys (scope, idem_key, request_digest, response_json, created_at) VALUES (?, ?, ?, ?, ?)",
      scope,
      key,
      digest,
      PENDING,
      clock.now(),
    );
  } catch (e) {
    const row = isUniqueViolation(e) ? existing() : undefined;
    if (row) return decide(row);
    throw e;
  }
  let result: unknown;
  try {
    result = await run();
  } catch (e) {
    db.run(
      "DELETE FROM idempotency_keys WHERE scope = ? AND idem_key = ? AND response_json = ?",
      scope,
      key,
      PENDING,
    );
    throw e;
  }
  const json = JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString(10) : v));
  db.run("UPDATE idempotency_keys SET response_json = ? WHERE scope = ? AND idem_key = ?", json, scope, key);
  return { replayed: false, result: JSON.parse(json) as unknown };
}
