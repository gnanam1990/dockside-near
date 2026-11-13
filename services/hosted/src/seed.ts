import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { IsolatedSigner } from "@dockside/authority";
import {
  type CanonicalValue,
  digestHexFor,
  fromTypedJson,
  newNonce,
  privateKeyFromSeed,
  publicKeyOf,
  sha256,
  signFor,
  type TypedJson,
  toHex,
} from "@dockside/core";
import { commercialDocsPolicy } from "./demo-policy.js";

/**
 * Demo seed of a hosted deployment (M55, ADR-0027). It enrols three demo organisations through the
 * real control API over HTTP, exactly as their administrators would in the web app: bootstrap with
 * a proof of possession, the buyer organisation's first EvidencePolicy, the ManifestAttestor and
 * deterministic-policy service identities (proof of possession signed by the same isolated signer
 * processes the worker uses, after recomputing the challenge digest), and one invitation per trade
 * role. Nothing is written to the database directly and nothing is invented: every record is the
 * API's own answer.
 *
 * What it holds: the three administrators' keys (ORG_SECURITY_ADMIN only), in owner-only files next
 * to its state. What it never holds: a trade role. The buyer approver, risk resolver, supplier
 * signer and inspector are people who accept an invitation in their own browser with their own
 * device key; `seedGrant` then grants the invited capability. Invitation secrets are returned once
 * and never stored.
 */

export type OrgRole = "buyer" | "supplier" | "inspector";
type InvitedCapability = "BUYER_APPROVER" | "RISK_RESOLVER" | "SUPPLIER_SIGNER" | "INSPECTOR";
type ServiceCapability = "MANIFEST_ATTEST" | "DETERMINISTIC_POLICY_SET";

export interface SeedContext {
  /** Base URL of the control API (the loopback API of the container, or the public origin). */
  readonly apiBase: string;
  /** DOCKSIDE_ORIGIN of the deployment; bound into every proof. */
  readonly origin: string;
  /** Private directory for the seed's state and the administrators' key files. */
  readonly stateDir: string;
  readonly manifestAttestorKeyFile: string;
  readonly deterministicPolicyKeyFile: string;
  readonly policyId?: string;
  readonly organizationNames?: Partial<Record<OrgRole, string>>;
  /** Issue new invitations for roles that are not granted yet (for example after one expired). */
  readonly reissue?: boolean;
}

export class SeedError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly step: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

interface OrgState {
  name: string;
  organizationId: string;
  principalId: string;
  publicKey: string;
}
interface InvitationState {
  role: OrgRole;
  capability: InvitedCapability;
  invitationId: string;
  expiresAt: number;
  granted: boolean;
  principalId: string | null;
}
interface SeedState {
  version: 1;
  origin: string;
  policyId: string;
  organizations: Partial<Record<OrgRole, OrgState>>;
  invitations: InvitationState[];
}

const ROLES: readonly OrgRole[] = ["buyer", "supplier", "inspector"];
const DEFAULT_NAMES: Record<OrgRole, string> = {
  buyer: "Dockside Demo Buyer",
  supplier: "Dockside Demo Supplier",
  inspector: "Dockside Demo Inspection",
};
const INVITES: readonly { role: OrgRole; capability: InvitedCapability }[] = [
  { role: "buyer", capability: "BUYER_APPROVER" },
  { role: "buyer", capability: "RISK_RESOLVER" },
  { role: "supplier", capability: "SUPPLIER_SIGNER" },
  { role: "inspector", capability: "INSPECTOR" },
];
const SERVICES: readonly {
  serviceId: string;
  capability: ServiceCapability;
  purpose: "MANIFEST_ATTESTATION" | "HOLD_SET";
}[] = [
  { serviceId: "manifest-attestor", capability: "MANIFEST_ATTEST", purpose: "MANIFEST_ATTESTATION" },
  { serviceId: "deterministic-policy", capability: "DETERMINISTIC_POLICY_SET", purpose: "HOLD_SET" },
];

/* ------------------------------ state ------------------------------ */

function writePrivate(file: string, text: string, exclusive: boolean): void {
  const fd = openSync(file, exclusive ? "wx" : "w", 0o600);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

function loadState(ctx: SeedContext): SeedState {
  mkdirSync(ctx.stateDir, { recursive: true, mode: 0o700 });
  const file = join(ctx.stateDir, "state.json");
  const policyId = ctx.policyId ?? "commercial-docs";
  if (!existsSync(file))
    return { version: 1, origin: ctx.origin, policyId, organizations: {}, invitations: [] };
  const state = JSON.parse(readFileSync(file, "utf8")) as SeedState;
  if (state.version !== 1 || state.origin !== ctx.origin || state.policyId !== policyId)
    throw new SeedError(
      "SEED_STATE_MISMATCH",
      "the seed state in this directory belongs to a deployment with another origin or policy id",
      "state",
    );
  return state;
}

function saveState(ctx: SeedContext, state: SeedState): void {
  const file = join(ctx.stateDir, "state.json");
  const tmp = `${file}.${process.pid}.tmp`;
  writePrivate(tmp, `${JSON.stringify(state, null, 2)}\n`, false);
  renameSync(tmp, file);
}

/** The administrator key of a demo organisation: created once, owner-only, never printed. */
function adminKey(ctx: SeedContext, role: OrgRole) {
  const file = join(ctx.stateDir, `${role}-admin.seed`);
  if (!existsSync(file)) writePrivate(file, `${randomBytes(32).toString("hex")}\n`, true);
  const seed = Buffer.from(readFileSync(file, "utf8").trim(), "hex");
  const privateKey = privateKeyFromSeed(new Uint8Array(seed));
  seed.fill(0);
  return { privateKey, publicKey: publicKeyOf(privateKey) };
}
type AdminKey = ReturnType<typeof adminKey>;

/* ------------------------------ API client ------------------------------ */

interface Grant {
  sessionId: string;
  sessionToken: string;
  organizationId: string;
  principalId: string;
}
interface ChallengeJson {
  challengeId: string;
  payload: TypedJson;
  digestHex: string;
}

class Session {
  constructor(
    private readonly ctx: SeedContext,
    private readonly key: AdminKey,
    readonly grant: Grant,
  ) {}

  private proof(method: string, path: string, body: string): Record<string, string> {
    const issuedAt = Date.now();
    const nonce = newNonce();
    const payload = {
      sessionId: this.grant.sessionId,
      origin: this.ctx.origin,
      method,
      path,
      bodyDigest: toHex(sha256(new TextEncoder().encode(body))),
      issuedAt,
      nonce,
    };
    const proof = {
      sessionId: this.grant.sessionId,
      issuedAt,
      nonce,
      signature: signFor(this.key.privateKey, "REQUEST_PROOF", payload),
    };
    return {
      authorization: `Dockside-Session ${this.grant.sessionToken}`,
      "dockside-proof": Buffer.from(JSON.stringify(proof)).toString("base64url"),
    };
  }

  get<T>(step: string, path: string): Promise<T> {
    return call<T>(this.ctx, step, "GET", path, undefined, this.proof("GET", path, ""));
  }

  post<T>(step: string, path: string, body: unknown): Promise<T> {
    const raw = JSON.stringify(body);
    return call<T>(this.ctx, step, "POST", path, raw, this.proof("POST", path, raw));
  }
}

async function call<T>(
  ctx: SeedContext,
  step: string,
  method: "GET" | "POST",
  path: string,
  raw: string | undefined,
  headers: Record<string, string> = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${ctx.apiBase}${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(raw === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(raw === undefined ? {} : { body: raw }),
    });
  } catch (e) {
    throw new SeedError("API_UNREACHABLE", `the API did not answer: ${(e as Error).message}`, step);
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new SeedError("API_INVALID_RESPONSE", "the API answered without JSON", step, res.status);
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } }).error;
    throw new SeedError(err?.code ?? "API_ERROR", err?.message ?? `HTTP ${res.status}`, step, res.status);
  }
  return json as T;
}

/** Recompute the digest from the served payload and check what it binds before signing it. */
function signChallenge(ctx: SeedContext, step: string, key: AdminKey, ch: ChallengeJson, purpose: string) {
  const payload = fromTypedJson(ch.payload) as Record<string, CanonicalValue>;
  if (digestHexFor("POP_CHALLENGE", payload) !== ch.digestHex)
    throw new SeedError("DIGEST_MISMATCH", "the challenge digest does not match its payload", step);
  if (
    payload["purpose"] !== purpose ||
    payload["publicKey"] !== key.publicKey ||
    payload["origin"] !== ctx.origin
  )
    throw new SeedError("CHALLENGE_MISMATCH", "the challenge is not for this key, purpose and origin", step);
  return {
    challengeId: ch.challengeId,
    proof: { scheme: "dockside-ed25519", signature: signFor(key.privateKey, "POP_CHALLENGE", payload) },
  };
}

async function bootstrap(ctx: SeedContext, role: OrgRole, key: AdminKey, name: string): Promise<Session> {
  const step = `bootstrap:${role}`;
  const ch = await call<ChallengeJson>(
    ctx,
    step,
    "POST",
    "/v1/bootstrap/challenges",
    JSON.stringify({ organizationName: name, publicKey: key.publicKey }),
  );
  const grant = await call<Grant>(
    ctx,
    step,
    "POST",
    "/v1/bootstrap/complete",
    JSON.stringify(signChallenge(ctx, step, key, ch, "ORG_BOOTSTRAP")),
  );
  return new Session(ctx, key, grant);
}

async function login(ctx: SeedContext, role: OrgRole, key: AdminKey, org: OrgState): Promise<Session> {
  const step = `sign-in:${role}`;
  if (org.publicKey !== key.publicKey)
    throw new SeedError("SEED_STATE_MISMATCH", "the administrator key file is not the enrolled key", step);
  const ch = await call<ChallengeJson>(
    ctx,
    step,
    "POST",
    "/v1/sessions/challenges",
    JSON.stringify({ principalId: org.principalId, publicKey: key.publicKey }),
  );
  const grant = await call<Grant>(
    ctx,
    step,
    "POST",
    "/v1/sessions/complete",
    JSON.stringify(signChallenge(ctx, step, key, ch, "LOGIN")),
  );
  return new Session(ctx, key, grant);
}

/** Sign in as each demo organisation's administrator, bootstrapping the organisation if needed. */
async function administrators(ctx: SeedContext, state: SeedState, create: boolean) {
  const sessions = {} as Record<OrgRole, Session>;
  const created = {} as Record<OrgRole, boolean>;
  for (const role of ROLES) {
    const existing = state.organizations[role];
    if (existing) {
      sessions[role] = await login(ctx, role, adminKey(ctx, role), existing);
      created[role] = false;
      continue;
    }
    if (!create)
      throw new SeedError(
        "SEED_NOT_ENROLLED",
        "run the enroll step first: no demo organisation is recorded",
        "state",
      );
    const key = adminKey(ctx, role);
    const name = ctx.organizationNames?.[role] ?? DEFAULT_NAMES[role];
    const s = await bootstrap(ctx, role, key, name);
    state.organizations[role] = {
      name,
      organizationId: s.grant.organizationId,
      principalId: s.grant.principalId,
      publicKey: key.publicKey,
    };
    saveState(ctx, state);
    sessions[role] = s;
    created[role] = true;
  }
  return { sessions, created };
}

/* ------------------------------ enroll ------------------------------ */

interface Directory {
  organization: { id: string; name: string; status: string };
  principals: { id: string; displayName: string; status: string; capabilities: string[] }[];
  services: {
    id: string;
    serviceId: string;
    capability: string;
    status: string;
    versions: { version: number; publicKey: string; status: string }[];
  }[];
}

export interface SeedReport {
  readonly origin: string;
  readonly signInUrl: string;
  readonly organizations: {
    role: OrgRole;
    name: string;
    organizationId: string;
    adminPrincipalId: string;
    created: boolean;
  }[];
  readonly policy: { policyId: string; revision: number; digest: string; created: boolean };
  readonly services: {
    serviceId: string;
    capability: ServiceCapability;
    enrollmentId: string;
    publicKey: string;
    status: string;
    created: boolean;
  }[];
  readonly invitations: {
    role: OrgRole;
    capability: InvitedCapability;
    invitationId: string;
    expiresAt: number;
    granted: boolean;
    /** Present only in the run that created the invitation. Hand it to the person; it is not stored. */
    secret?: string;
  }[];
}

async function ensurePolicy(state: SeedState, buyer: Session): Promise<SeedReport["policy"]> {
  const step = "evidence-policy";
  const listed = await buyer.get<{
    policies: { policyId: string; revisions: { revision: number; digest: string }[] }[];
  }>(step, "/v1/evidence-policies");
  const have = listed.policies
    .find((p) => p.policyId === state.policyId)
    ?.revisions.find((r) => r.revision === 1);
  if (have) return { policyId: state.policyId, revision: 1, digest: have.digest, created: false };
  const out = await buyer.post<{ policyId: string; revision: number; digest: string }>(
    step,
    "/v1/evidence-policies",
    { policy: commercialDocsPolicy(state.policyId) },
  );
  return { ...out, created: true };
}

async function ensureService(
  ctx: SeedContext,
  state: SeedState,
  buyer: Session,
  svc: (typeof SERVICES)[number],
  keyFile: string,
): Promise<SeedReport["services"][number]> {
  const step = `service:${svc.serviceId}`;
  const signer = await IsolatedSigner.spawn({
    allowedPurposes: ["SERVICE_POP_CHALLENGE", svc.purpose],
    seedFile: keyFile,
  }).catch((e: unknown) => {
    throw new SeedError(
      "SERVICE_KEY_UNAVAILABLE",
      `the service key file could not be used: ${(e as Error).message}`,
      step,
    );
  });
  try {
    const dir = await buyer.get<Directory>(step, "/v1/organization/directory");
    const existing = dir.services.find((s) => s.serviceId === svc.serviceId);
    if (existing) {
      const active = existing.versions.find((v) => v.status === "ACTIVE");
      if (existing.status !== "ACTIVE" || active?.publicKey !== signer.publicKey)
        throw new SeedError(
          "SERVICE_NOT_ACTIVE",
          `${svc.serviceId} is enrolled but not active with this deployment's key; finish or revoke it under Organization -> Service identities`,
          step,
        );
      return {
        serviceId: svc.serviceId,
        capability: svc.capability,
        enrollmentId: existing.id,
        publicKey: signer.publicKey,
        status: existing.status,
        created: false,
      };
    }
    const enrolled = await buyer.post<{ enrollmentId: string; keyVersion: number; challenge: ChallengeJson }>(
      step,
      "/v1/service-enrollments",
      {
        serviceId: svc.serviceId,
        capability: svc.capability,
        publicKey: signer.publicKey,
        scope: { tradeId: null, evidencePolicyId: state.policyId, evidencePolicyRevision: 1 },
        custody: { kind: "ISOLATED_SIGNER_PROCESS", reference: `signer://${svc.serviceId}/v1` },
      },
    );
    // Never sign a digest handed in: recompute it, and check the challenge names this key.
    const payload = fromTypedJson(enrolled.challenge.payload) as Record<string, CanonicalValue>;
    if (digestHexFor("SERVICE_POP_CHALLENGE", payload) !== enrolled.challenge.digestHex)
      throw new SeedError("DIGEST_MISMATCH", "the service challenge digest does not match its payload", step);
    if (
      payload["publicKey"] !== signer.publicKey ||
      payload["capability"] !== svc.capability ||
      payload["origin"] !== ctx.origin
    )
      throw new SeedError(
        "CHALLENGE_MISMATCH",
        "the service challenge is not for this key and capability",
        step,
      );
    const signature = await signer.sign("SERVICE_POP_CHALLENGE", payload as never);
    await call(
      ctx,
      step,
      "POST",
      "/v1/service-enrollments/prove",
      JSON.stringify({ challengeId: enrolled.challenge.challengeId, signature }),
    );
    const view = await buyer.post<{ status: string }>(
      step,
      `/v1/service-enrollments/${enrolled.enrollmentId}/activate`,
      { keyVersion: enrolled.keyVersion },
    );
    return {
      serviceId: svc.serviceId,
      capability: svc.capability,
      enrollmentId: enrolled.enrollmentId,
      publicKey: signer.publicKey,
      status: view.status,
      created: true,
    };
  } finally {
    signer.close();
  }
}

export async function seedEnroll(ctx: SeedContext): Promise<SeedReport> {
  const state = loadState(ctx);
  saveState(ctx, state);
  const { sessions, created } = await administrators(ctx, state, true);
  const policy = await ensurePolicy(state, sessions.buyer);
  const services: SeedReport["services"] = [];
  for (const svc of SERVICES)
    services.push(
      await ensureService(
        ctx,
        state,
        sessions.buyer,
        svc,
        svc.capability === "MANIFEST_ATTEST" ? ctx.manifestAttestorKeyFile : ctx.deterministicPolicyKeyFile,
      ),
    );
  const secrets = new Map<string, string>();
  for (const want of INVITES) {
    const idx = state.invitations.findIndex((i) => i.role === want.role && i.capability === want.capability);
    const have = idx === -1 ? undefined : state.invitations[idx];
    if (have && (have.granted || ctx.reissue !== true)) continue;
    const inv = await sessions[want.role].post<{ invitationId: string; secret: string; expiresAt: number }>(
      `invitation:${want.capability}`,
      "/v1/invitations",
      { capability: want.capability },
    );
    const record: InvitationState = {
      ...want,
      invitationId: inv.invitationId,
      expiresAt: inv.expiresAt,
      granted: false,
      principalId: null,
    };
    if (idx === -1) state.invitations.push(record);
    else state.invitations[idx] = record;
    saveState(ctx, state);
    secrets.set(inv.invitationId, inv.secret);
  }
  return {
    origin: ctx.origin,
    signInUrl: `${ctx.origin}/sign-in`,
    organizations: ROLES.map((role) => {
      const o = state.organizations[role] as OrgState;
      return {
        role,
        name: o.name,
        organizationId: o.organizationId,
        adminPrincipalId: o.principalId,
        created: created[role],
      };
    }),
    policy,
    services,
    invitations: INVITES.map((want) => {
      const i = state.invitations.find(
        (x) => x.role === want.role && x.capability === want.capability,
      ) as InvitationState;
      const secret = secrets.get(i.invitationId);
      return {
        role: i.role,
        capability: i.capability,
        invitationId: i.invitationId,
        expiresAt: i.expiresAt,
        granted: i.granted,
        ...(secret === undefined ? {} : { secret }),
      };
    }),
  };
}

/* ------------------------------ grant, status ------------------------------ */

export interface GrantResult {
  role: OrgRole;
  capability: InvitedCapability;
  invitationId: string;
  /** GRANTED: the person holds the role. PENDING: not accepted yet. EXPIRED: issue a new invitation. */
  state: "GRANTED" | "PENDING" | "EXPIRED";
  principalId?: string;
}

/** Grant the invited capability to everyone who accepted an invitation since the last run. */
export async function seedGrant(ctx: SeedContext): Promise<GrantResult[]> {
  const state = loadState(ctx);
  const { sessions } = await administrators(ctx, state, false);
  const out: GrantResult[] = [];
  for (const inv of state.invitations) {
    const base = { role: inv.role, capability: inv.capability, invitationId: inv.invitationId };
    if (inv.granted) {
      out.push({ ...base, state: "GRANTED", ...(inv.principalId ? { principalId: inv.principalId } : {}) });
      continue;
    }
    try {
      const g = await sessions[inv.role].post<{ principalId: string }>(
        `grant:${inv.capability}`,
        `/v1/invitations/${inv.invitationId}/grant`,
        {},
      );
      inv.granted = true;
      inv.principalId = g.principalId;
      saveState(ctx, state);
      out.push({ ...base, state: "GRANTED", principalId: g.principalId });
    } catch (e) {
      // INVALID_STATE is the API saying "not accepted yet"; every other refusal is reported.
      if (!(e instanceof SeedError) || e.code !== "INVALID_STATE") throw e;
      out.push({ ...base, state: Date.now() > inv.expiresAt ? "EXPIRED" : "PENDING" });
    }
  }
  return out;
}

export interface SeedStatus {
  readonly origin: string;
  readonly organizations: {
    role: OrgRole;
    organizationId: string;
    name: string;
    principals: { principalId: string; displayName: string; status: string; capabilities: string[] }[];
    services: { serviceId: string; capability: string; status: string }[];
  }[];
}

/** Each demo organisation's people and service identities, as the API lists them now. */
export async function seedStatus(ctx: SeedContext): Promise<SeedStatus> {
  const state = loadState(ctx);
  const { sessions } = await administrators(ctx, state, false);
  const organizations: SeedStatus["organizations"] = [];
  for (const role of ROLES) {
    const d = await sessions[role].get<Directory>(`directory:${role}`, "/v1/organization/directory");
    organizations.push({
      role,
      organizationId: d.organization.id,
      name: d.organization.name,
      principals: d.principals.map((p) => ({
        principalId: p.id,
        displayName: p.displayName,
        status: p.status,
        capabilities: p.capabilities,
      })),
      services: d.services.map((s) => ({
        serviceId: s.serviceId,
        capability: s.capability,
        status: s.status,
      })),
    });
  }
  return { origin: ctx.origin, organizations };
}
