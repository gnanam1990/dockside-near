import { createHash, randomBytes } from "node:crypto";
import {
  type AuthorityAction,
  assertCapabilityCompatible,
  type CanonicalValue,
  type Capability,
  type Clock,
  capabilityAllows,
  checkValidityWindow,
  DocksideError,
  digestHexFor,
  type ErrorCode,
  fail,
  fromHex,
  type IdGenerator,
  isHumanCapability,
  isServiceCapability,
  newNonce,
  parseCapability,
  parsePublicKey,
  requireSignature,
  type SigningPurpose,
  sha256,
  type TradeTerms,
  toHex,
  toTypedJson,
  tradeRevisionDigest,
  tradeTermsCanonical,
  verifyFor,
  verifyNep413,
} from "@dockside/core";
import { type AuditEventInput, AuditLog, type Database, SqliteNonceRegistry } from "@dockside/store";
import type {
  AuthContext,
  AuthorityConfig,
  BindingIssueCode,
  BindingStatus,
  ChallengeView,
  DirectoryPrincipal,
  DirectoryService,
  HumanChallengePayload,
  HumanChallengePurpose,
  KeyStatus,
  KeyVersionDetail,
  KeyVersionView,
  OrganizationDirectory,
  OwnKeys,
  PopProof,
  PrincipalBinding,
  PrincipalView,
  RebindingPlan,
  RebindingPlanRole,
  RecoveryView,
  RequestProof,
  RoleGrantView,
  ServiceBinding,
  ServiceChallengePurpose,
  ServiceChallengeView,
  ServiceEnrollmentView,
  ServiceScope,
  SessionGrant,
  VerifiedPrincipalAuthority,
  VerifiedServiceAuthority,
} from "./types.js";

const SOURCE = "authority";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const DISPLAY_NAME = /^[\p{L}\p{N} .,'&()_-]{1,120}$/u;
const SERVICE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REASON = /^[A-Z][A-Z0-9_]{0,63}$/;
const CUSTODY_REF = /^[A-Za-z0-9][A-Za-z0-9:/._@-]{0,127}$/;
const CUSTODY_KINDS = ["HSM", "KMS", "ISOLATED_SIGNER_PROCESS"] as const;
const USABLE: readonly KeyStatus[] = ["ACTIVE", "SUPERSEDED"];

type Row = Record<string, string | number | bigint | null | Uint8Array>;

export interface AuthorityDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly config: AuthorityConfig;
}

const hashToken = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/**
 * Organization and authority lifecycle (M01): proof-of-possession bootstrap,
 * one-time scoped invitations, separate-session acceptance, later admin grant,
 * versioned keys, revocation, delayed recovery, service enrollment for the
 * ManifestAttestor and deterministic-policy principals, and typed verification
 * contracts for later modules. Every state change is audited in the same transaction.
 */
export class AuthorityService {
  private readonly db: Database;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly cfg: AuthorityConfig;
  private readonly audit: AuditLog;
  private readonly nonces: SqliteNonceRegistry;

  constructor(deps: AuthorityDeps) {
    this.db = deps.db;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.cfg = deps.config;
    this.audit = new AuditLog(deps.db, deps.clock, deps.ids);
    this.nonces = new SqliteNonceRegistry(deps.db, deps.clock);
  }

  /* ================================================================ */
  /* Bootstrap and login                                               */
  /* ================================================================ */

  createBootstrapChallenge(input: { organizationName: string; publicKey: string }): ChallengeView {
    const name = this.displayName(input.organizationName);
    const pk = parsePublicKey(input.publicKey);
    this.assertKeyUnenrolled(pk);
    return this.issueHumanChallenge({
      purpose: "ORG_BOOTSTRAP",
      organizationId: this.ids.next("org"),
      principalId: this.ids.next("prn"),
      subjectName: name,
      requestedCapability: "ORG_SECURITY_ADMIN",
      invitationId: null,
      recoveryId: null,
      previousKeyVersionId: null,
      publicKey: pk,
      keyVersion: 1,
      keyVersionId: null,
    });
  }

  completeBootstrap(input: { challengeId: string; proof: PopProof }): SessionGrant {
    return this.db.transaction(() => {
      const c = this.consumeHumanChallenge(input.challengeId, "ORG_BOOTSTRAP", input.proof);
      this.assertKeyUnenrolled(c.publicKey);
      const now = this.clock.now();
      const orgId = c.organizationId;
      const correlationId = this.ids.next("cor");
      this.db.run(
        "INSERT INTO organizations (id, name, status, bootstrap_principal_id, created_at) VALUES (?, ?, 'ACTIVE', ?, ?)",
        orgId,
        c.subjectName ?? "",
        c.principalId,
        now,
      );
      this.db.run(
        `INSERT INTO principals (id, organization_id, kind, display_name, status, enrolled_via, created_at)
         VALUES (?, ?, 'HUMAN', ?, 'ACTIVE', 'BOOTSTRAP', ?)`,
        c.principalId,
        orgId,
        `${c.subjectName ?? "organization"} security admin`,
        now,
      );
      const keyId = this.insertKey(c.principalId, 1, c.publicKey, "ACTIVE", { proven: true });
      const actor = {
        organizationId: orgId,
        actorPrincipalId: c.principalId,
        actorKeyVersionId: keyId,
        sessionId: null,
        correlationId,
      };
      this.log(actor, "ORG_BOOTSTRAPPED", "organization", orgId, {
        principalId: c.principalId,
        challengeId: c.challengeId,
      });
      this.log(actor, "KEY_ACTIVATED", "key_version", keyId, { principalId: c.principalId, version: 1 });
      this.insertGrant(orgId, c.principalId, "ORG_SECURITY_ADMIN", null, null, null, actor);
      const grant = this.createSession(c.principalId, keyId, orgId, c.challengeId, actor);
      this.db.run(
        "UPDATE principals SET enrollment_session_id = ? WHERE id = ?",
        grant.sessionId,
        c.principalId,
      );
      return grant;
    });
  }

  createLoginChallenge(input: { principalId: string; publicKey: string }): ChallengeView {
    const pk = parsePublicKey(input.publicKey);
    const p = this.principalRow(input.principalId);
    if (p?.["kind"] !== "HUMAN") fail("UNAUTHENTICATED", "unknown principal or key");
    const k = this.db.get(
      "SELECT * FROM key_versions WHERE public_key = ? AND principal_id = ?",
      pk,
      input.principalId,
    );
    if (!k || k["activated_at"] === null) fail("UNAUTHENTICATED", "unknown principal or key");
    if (k["status"] !== "ACTIVE") fail("KEY_REVOKED", "key is not the principal's current active key");
    return this.issueHumanChallenge({
      purpose: "LOGIN",
      organizationId: String(p["organization_id"]),
      principalId: input.principalId,
      subjectName: null,
      requestedCapability: null,
      invitationId: null,
      recoveryId: null,
      previousKeyVersionId: null,
      publicKey: pk,
      keyVersion: Number(k["version"]),
      keyVersionId: String(k["id"]),
    });
  }

  completeLogin(input: { challengeId: string; proof: PopProof }): SessionGrant {
    return this.db.transaction(() => {
      const c = this.consumeHumanChallenge(input.challengeId, "LOGIN", input.proof);
      const k = this.keyRow(String(c.keyVersionId));
      if (k["status"] !== "ACTIVE") fail("KEY_REVOKED", "key is no longer active");
      const actor = this.actorOf(c.organizationId, c.principalId, String(k["id"]), null);
      return this.createSession(c.principalId, String(k["id"]), c.organizationId, c.challengeId, actor);
    });
  }

  /* ================================================================ */
  /* Sessions and per-request proof of possession                      */
  /* ================================================================ */

  authenticate(input: {
    sessionToken: string;
    proof: RequestProof;
    method: string;
    path: string;
    body: string | Uint8Array;
  }): AuthContext {
    try {
      return this.authenticateInner(input);
    } catch (e) {
      if (e instanceof DocksideError) {
        this.audit.append({
          eventType: "AUTH_DENIED",
          organizationId: null,
          actorPrincipalId: null,
          actorKeyVersionId: null,
          sessionId: null,
          subjectType: "request",
          subjectId: input.path.slice(0, 128) || "/",
          correlationId: this.ids.next("cor"),
          source: SOURCE,
          payload: { reason: e.code, method: input.method.slice(0, 8) },
        });
      }
      throw e;
    }
  }

  private authenticateInner(input: {
    sessionToken: string;
    proof: RequestProof;
    method: string;
    path: string;
    body: string | Uint8Array;
  }): AuthContext {
    if (typeof input.sessionToken !== "string" || !TOKEN.test(input.sessionToken)) {
      fail("UNAUTHENTICATED", "missing or malformed session token");
    }
    const s = this.db.get("SELECT * FROM sessions WHERE token_hash = ?", hashToken(input.sessionToken));
    if (!s) fail("UNAUTHENTICATED", "unknown session");
    if (input.proof?.sessionId !== s["id"]) fail("UNAUTHENTICATED", "proof does not name this session");
    const k = this.keyRow(String(s["key_version_id"]));
    if (k["status"] === "REVOKED" || k["status"] === "SUSPENDED")
      fail("KEY_REVOKED", "session key is revoked or suspended");
    if (s["revoked_at"] !== null) fail("UNAUTHENTICATED", "session revoked");
    const now = this.clock.now();
    if (now >= Number(s["expires_at"])) fail("UNAUTHENTICATED", "session expired");
    const skew = this.cfg.requestProofSkewMs;
    const issuedAt = Number(input.proof.issuedAt);
    checkValidityWindow({ issuedAt, expiresAt: issuedAt + 2 * skew }, now, {
      maxLifetimeMs: 2 * skew,
      maxSkewMs: skew,
    });
    if (typeof input.proof.nonce !== "string" || !/^[0-9a-f]{32,64}$/.test(input.proof.nonce)) {
      fail("VALIDATION_FAILED", "proof nonce must be hex");
    }
    const body = typeof input.body === "string" ? new TextEncoder().encode(input.body) : input.body;
    const payload = {
      sessionId: String(s["id"]),
      origin: this.cfg.origin,
      method: input.method.toUpperCase(),
      path: input.path,
      bodyDigest: toHex(sha256(body)),
      issuedAt,
      nonce: input.proof.nonce,
    };
    requireSignature(String(k["public_key"]), "REQUEST_PROOF", payload, input.proof.signature);
    this.db.transaction(() => this.nonces.consume(`req:${s["id"]}`, input.proof.nonce, issuedAt + 2 * skew));
    const p = this.principalRow(String(s["principal_id"]));
    if (!p) fail("UNAUTHENTICATED", "principal missing");
    if (p["status"] === "SUSPENDED") fail("FORBIDDEN", "principal suspended");
    return {
      session: { id: String(s["id"]), expiresAt: Number(s["expires_at"]) },
      principal: this.principalView(p),
      keyVersion: this.keyView(k),
      organizationId: String(s["organization_id"]),
      capabilities: this.capabilitiesOf(String(p["id"])),
      correlationId: this.ids.next("cor"),
    };
  }

  /* ================================================================ */
  /* Invitations and role grants                                      */
  /* ================================================================ */

  createInvitation(
    ctx: AuthContext,
    input: { capability: Capability; expiresInMs?: number },
  ): {
    invitationId: string;
    secret: string;
    expiresAt: number;
    capability: Capability;
    organizationId: string;
  } {
    this.require(ctx, "INVITE_PRINCIPAL");
    const capability = parseCapability(input.capability);
    if (!isHumanCapability(capability)) {
      fail(
        "VALIDATION_FAILED",
        "service capabilities are enrolled through service enrollment, not invitations",
      );
    }
    const ttl = input.expiresInMs ?? this.cfg.invitationTtlMs;
    if (!Number.isSafeInteger(ttl) || ttl < 60_000 || ttl > this.cfg.invitationTtlMs) {
      fail("VALIDATION_FAILED", "invitation lifetime outside policy");
    }
    const secret = randomBytes(32).toString("base64url");
    const id = this.ids.next("inv");
    const now = this.clock.now();
    return this.db.transaction(() => {
      this.db.run(
        `INSERT INTO invitations (id, organization_id, capability, secret_hash, status, created_by_principal_id, created_session_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?, ?)`,
        id,
        ctx.organizationId,
        capability,
        hashToken(secret),
        ctx.principal.id,
        ctx.session.id,
        now,
        now + ttl,
      );
      this.log(this.actorCtx(ctx), "INVITATION_CREATED", "invitation", id, {
        capability,
        expiresAt: now + ttl,
      });
      return {
        invitationId: id,
        secret,
        expiresAt: now + ttl,
        capability,
        organizationId: ctx.organizationId,
      };
    });
  }

  createInvitationChallenge(input: {
    invitationSecret: string;
    publicKey: string;
    displayName?: string;
  }): ChallengeView {
    const inv = this.invitationBySecret(input.invitationSecret);
    if (inv["status"] !== "PENDING") fail("INVALID_STATE", "invitation is no longer pending");
    if (this.clock.now() >= Number(inv["expires_at"])) fail("EXPIRED", "invitation expired");
    const pk = parsePublicKey(input.publicKey);
    this.assertKeyUnenrolled(pk);
    return this.issueHumanChallenge({
      purpose: "INVITATION_ACCEPT",
      organizationId: String(inv["organization_id"]),
      principalId: this.ids.next("prn"),
      subjectName: input.displayName === undefined ? null : this.displayName(input.displayName),
      requestedCapability: parseCapability(inv["capability"]),
      invitationId: String(inv["id"]),
      recoveryId: null,
      previousKeyVersionId: null,
      publicKey: pk,
      keyVersion: 1,
      keyVersionId: null,
    });
  }

  acceptInvitation(input: {
    challengeId: string;
    proof: PopProof;
    presentedSessionToken?: string;
  }): SessionGrant {
    if (input.presentedSessionToken !== undefined) {
      // Acceptance must happen in a fresh, unauthenticated context owned by the recipient.
      const s =
        TOKEN.test(input.presentedSessionToken) &&
        this.db.get(
          "SELECT principal_id FROM sessions WHERE token_hash = ?",
          hashToken(input.presentedSessionToken),
        );
      this.deny(
        "SEPARATION_OF_DUTIES",
        "invitations must be accepted in the recipient's own new session",
        s ? String(s["principal_id"]) : null,
        "invitation",
        input.challengeId,
      );
    }
    return this.db.transaction(() => {
      const c = this.consumeHumanChallenge(input.challengeId, "INVITATION_ACCEPT", input.proof);
      const inv = this.db.get("SELECT * FROM invitations WHERE id = ?", String(c.invitationId));
      if (!inv) fail("NOT_FOUND", "invitation not found");
      if (inv["status"] !== "PENDING") fail("INVALID_STATE", "invitation is no longer pending");
      if (this.clock.now() >= Number(inv["expires_at"])) fail("EXPIRED", "invitation expired");
      this.assertKeyUnenrolled(c.publicKey);
      const now = this.clock.now();
      this.db.run(
        `INSERT INTO principals (id, organization_id, kind, display_name, status, enrolled_via, created_at)
         VALUES (?, ?, 'HUMAN', ?, 'PENDING_GRANT', 'INVITATION', ?)`,
        c.principalId,
        c.organizationId,
        c.subjectName ?? "invited principal",
        now,
      );
      const keyId = this.insertKey(c.principalId, 1, c.publicKey, "ACTIVE", { proven: true });
      const actor = this.actorOf(c.organizationId, c.principalId, keyId, null);
      const session = this.createSession(c.principalId, keyId, c.organizationId, c.challengeId, actor);
      const r = this.db.run(
        `UPDATE invitations SET status = 'ACCEPTED', accepted_principal_id = ?, accepted_session_id = ?, accepted_at = ?
         WHERE id = ? AND status = 'PENDING'`,
        c.principalId,
        session.sessionId,
        now,
        String(inv["id"]),
      );
      if (Number(r.changes) !== 1) fail("INVALID_STATE", "invitation is no longer pending");
      this.db.run(
        "UPDATE principals SET enrollment_session_id = ? WHERE id = ?",
        session.sessionId,
        c.principalId,
      );
      this.log(actor, "INVITATION_ACCEPTED", "invitation", String(inv["id"]), {
        principalId: c.principalId,
        capability: String(inv["capability"]),
      });
      this.log(actor, "KEY_ACTIVATED", "key_version", keyId, { principalId: c.principalId, version: 1 });
      return session;
    });
  }

  grantRole(ctx: AuthContext, input: { invitationId: string; capability?: Capability }): RoleGrantView {
    this.require(ctx, "GRANT_ROLE");
    const inv = this.db.get("SELECT * FROM invitations WHERE id = ?", input.invitationId);
    if (!inv) fail("NOT_FOUND", "invitation not found");
    if (inv["organization_id"] !== ctx.organizationId) {
      this.deny(
        "FORBIDDEN",
        "invitation belongs to another organization",
        ctx.principal.id,
        "invitation",
        input.invitationId,
      );
    }
    if (input.capability !== undefined && input.capability !== inv["capability"]) {
      this.deny(
        "FORBIDDEN",
        "grant must equal the invited capability",
        ctx.principal.id,
        "invitation",
        input.invitationId,
      );
    }
    if (inv["status"] !== "ACCEPTED")
      fail("INVALID_STATE", "invitation has not been accepted (or was already granted)");
    const grantee = String(inv["accepted_principal_id"]);
    if (grantee === ctx.principal.id || inv["accepted_session_id"] === ctx.session.id) {
      this.deny(
        "SEPARATION_OF_DUTIES",
        "the grant must come from a different principal and session",
        ctx.principal.id,
        "invitation",
        input.invitationId,
      );
    }
    return this.db.transaction(() => {
      const g = this.insertGrant(
        ctx.organizationId,
        grantee,
        parseCapability(inv["capability"]),
        ctx.principal.id,
        ctx.session.id,
        String(inv["id"]),
        this.actorCtx(ctx),
      );
      const r = this.db.run(
        "UPDATE invitations SET status = 'GRANTED', granted_at = ? WHERE id = ? AND status = 'ACCEPTED'",
        this.clock.now(),
        String(inv["id"]),
      );
      if (Number(r.changes) !== 1) fail("INVALID_STATE", "invitation already granted");
      return g;
    });
  }

  /** Grant an additional human capability to an existing principal of the admin's organization. */
  grantCapability(ctx: AuthContext, input: { principalId: string; capability: Capability }): RoleGrantView {
    this.require(ctx, "GRANT_ROLE");
    const capability = parseCapability(input.capability);
    if (!isHumanCapability(capability))
      fail("VALIDATION_FAILED", "service capabilities cannot be granted to principals");
    const p = this.principalRow(input.principalId);
    if (!p || p["organization_id"] !== ctx.organizationId) {
      this.deny(
        "FORBIDDEN",
        "principal belongs to another organization",
        ctx.principal.id,
        "principal",
        input.principalId,
      );
    }
    if (p["kind"] !== "HUMAN")
      fail("VALIDATION_FAILED", "service principals hold enrollment capabilities only");
    if (input.principalId === ctx.principal.id && capability !== "ORG_SECURITY_ADMIN") {
      this.deny(
        "SEPARATION_OF_DUTIES",
        "administrators cannot grant themselves capabilities",
        ctx.principal.id,
        "principal",
        input.principalId,
      );
    }
    return this.db.transaction(() =>
      this.insertGrant(
        ctx.organizationId,
        input.principalId,
        capability,
        ctx.principal.id,
        ctx.session.id,
        null,
        this.actorCtx(ctx),
      ),
    );
  }

  /**
   * INV-13 structural check for a trade's human parties: distinct enrolled principals,
   * each proven in its own enrollment session, holding exactly the slot capability with a
   * usable key; buyer and supplier in different organizations.
   */
  assertIndependentParties(parties: {
    buyer: { principalId: string; keyVersionId: string; publicKey?: string };
    supplier: { principalId: string; keyVersionId: string; publicKey?: string };
    inspector: { principalId: string; keyVersionId: string; publicKey?: string };
    riskResolver: { principalId: string; keyVersionId: string; publicKey?: string };
  }): { ok: true; organizations: Record<string, string> } {
    const slots: [keyof typeof parties, Capability][] = [
      ["buyer", "BUYER_APPROVER"],
      ["supplier", "SUPPLIER_SIGNER"],
      ["inspector", "INSPECTOR"],
      ["riskResolver", "RISK_RESOLVER"],
    ];
    const ids = slots.map(([s]) => parties[s].principalId);
    if (new Set(ids).size !== ids.length)
      fail("SEPARATION_OF_DUTIES", "each party must be a distinct principal");
    const sessions = new Set<string>();
    const orgs: Record<string, string> = {};
    for (const [slot, cap] of slots) {
      const b = parties[slot];
      const p = this.principalRow(b.principalId);
      if (p?.["kind"] !== "HUMAN") fail("NOT_FOUND", `${slot} principal is not an enrolled human`, { slot });
      const k = this.db.get(
        "SELECT * FROM key_versions WHERE id = ? AND principal_id = ?",
        b.keyVersionId,
        b.principalId,
      );
      if (!k) fail("KEY_NOT_BOUND", `${slot} key version does not belong to the principal`, { slot });
      if (b.publicKey !== undefined && k["public_key"] !== b.publicKey) {
        fail("KEY_NOT_BOUND", `${slot} public key does not match the enrolled version`, { slot });
      }
      this.assertUsableKey(k, slot);
      if (!this.capabilitiesOf(b.principalId).includes(cap)) {
        fail("FORBIDDEN", `${slot} principal does not hold ${cap}`, { slot });
      }
      const es = str(p["enrollment_session_id"]);
      if (es === null || sessions.has(es))
        fail("SEPARATION_OF_DUTIES", "parties must be enrolled in separate sessions", { slot });
      sessions.add(es);
      orgs[slot] = String(p["organization_id"]);
    }
    if (orgs["buyer"] === orgs["supplier"])
      fail("SEPARATION_OF_DUTIES", "buyer and supplier must be different organizations");
    return { ok: true, organizations: orgs };
  }

  /* ================================================================ */
  /* Human key revocation, rotation and recovery                      */
  /* ================================================================ */

  revokeKey(ctx: AuthContext, input: { keyVersionId: string; reason: string }): KeyVersionView {
    const reason = this.reason(input.reason);
    const k = this.db.get("SELECT * FROM key_versions WHERE id = ?", input.keyVersionId);
    if (!k) fail("NOT_FOUND", "key version not found");
    const owner = this.principalRow(String(k["principal_id"]));
    const own = k["principal_id"] === ctx.principal.id;
    if (!own) {
      if (
        !capabilityAllows("REVOKE_KEY", ctx.capabilities) ||
        owner?.["organization_id"] !== ctx.organizationId
      ) {
        this.deny(
          "FORBIDDEN",
          "only the owner or its organization's security admin may revoke a key",
          ctx.principal.id,
          "key_version",
          input.keyVersionId,
        );
      }
    }
    return this.db.transaction(() => this.revokeKeyTx(String(k["id"]), reason, this.actorCtx(ctx)));
  }

  createKeyRotationChallenge(ctx: AuthContext, input: { publicKey: string }): ChallengeView {
    if (ctx.principal.kind !== "HUMAN") fail("FORBIDDEN", "service keys rotate through service enrollment");
    if (ctx.keyVersion.status !== "ACTIVE")
      fail("KEY_REVOKED", "only the current active key can authorize rotation");
    const pk = parsePublicKey(input.publicKey);
    this.assertKeyUnenrolled(pk);
    return this.db.transaction(() => {
      const version = this.nextVersion(ctx.principal.id);
      const keyId = this.insertKey(ctx.principal.id, version, pk, "PENDING_PROOF", {});
      return this.issueHumanChallenge({
        purpose: "KEY_ROTATION",
        organizationId: ctx.organizationId,
        principalId: ctx.principal.id,
        subjectName: null,
        requestedCapability: null,
        invitationId: null,
        recoveryId: null,
        previousKeyVersionId: ctx.keyVersion.id,
        publicKey: pk,
        keyVersion: version,
        keyVersionId: keyId,
      });
    });
  }

  completeKeyRotation(ctx: AuthContext, input: { challengeId: string; proof: PopProof }): KeyVersionView {
    return this.db.transaction(() => {
      const c = this.consumeHumanChallenge(input.challengeId, "KEY_ROTATION", input.proof);
      if (c.principalId !== ctx.principal.id || c.previousKeyVersionId !== ctx.keyVersion.id) {
        fail("FORBIDDEN", "rotation must be completed by the principal's current key session");
      }
      const now = this.clock.now();
      const newId = String(c.keyVersionId);
      this.db.run(
        "UPDATE key_versions SET status = 'ACTIVE', proven_at = ?, activated_at = ? WHERE id = ? AND status = 'PENDING_PROOF'",
        now,
        now,
        newId,
      );
      this.db.run(
        "UPDATE key_versions SET status = 'SUPERSEDED', superseded_at = ? WHERE id = ? AND status = 'ACTIVE'",
        now,
        ctx.keyVersion.id,
      );
      this.revokeSessionsForKey(ctx.keyVersion.id, "KEY_ROTATED");
      const actor = this.actorCtx(ctx);
      this.log(actor, "KEY_ACTIVATED", "key_version", newId, {
        principalId: ctx.principal.id,
        version: c.keyVersion,
      });
      this.log(actor, "KEY_SUPERSEDED", "key_version", ctx.keyVersion.id, {
        principalId: ctx.principal.id,
        successor: newId,
      });
      return this.keyView(this.keyRow(newId));
    });
  }

  startRecovery(
    ctx: AuthContext,
    input: { principalId: string; publicKey: string },
  ): { recoveryId: string; notBefore: number; keyVersion: number; challenge: ChallengeView } {
    this.require(ctx, "START_RECOVERY");
    const target = this.principalRow(input.principalId);
    if (!target || target["organization_id"] !== ctx.organizationId) {
      this.deny(
        "FORBIDDEN",
        "principal belongs to another organization",
        ctx.principal.id,
        "principal",
        input.principalId,
      );
    }
    if (target["kind"] !== "HUMAN")
      fail("VALIDATION_FAILED", "service keys recover through service enrollment");
    if (input.principalId === ctx.principal.id) {
      this.deny(
        "SEPARATION_OF_DUTIES",
        "a different administrator must recover this principal",
        ctx.principal.id,
        "principal",
        input.principalId,
      );
    }
    const open = this.db.get(
      "SELECT id FROM recoveries WHERE principal_id = ? AND status IN ('PENDING_PROOF','WAITING')",
      input.principalId,
    );
    if (open) fail("INVALID_STATE", "a recovery is already in progress");
    const pk = parsePublicKey(input.publicKey);
    this.assertKeyUnenrolled(pk);
    return this.db.transaction(() => {
      const now = this.clock.now();
      const notBefore = now + this.cfg.recoveryDelayMs;
      const version = this.nextVersion(input.principalId);
      const keyId = this.insertKey(input.principalId, version, pk, "PENDING_PROOF", { notBefore });
      const actor = this.actorCtx(ctx);
      const suspended = this.suspendUsableKeys(input.principalId, actor);
      const recoveryId = this.ids.next("rec");
      this.db.run(
        `INSERT INTO recoveries (id, organization_id, principal_id, new_key_version_id, suspended_key_ids_json, status, requested_by, requested_session_id, requested_at, not_before)
         VALUES (?, ?, ?, ?, ?, 'PENDING_PROOF', ?, ?, ?, ?)`,
        recoveryId,
        ctx.organizationId,
        input.principalId,
        keyId,
        JSON.stringify(suspended),
        ctx.principal.id,
        ctx.session.id,
        now,
        notBefore,
      );
      this.log(actor, "RECOVERY_REQUESTED", "recovery", recoveryId, {
        principalId: input.principalId,
        notBefore,
        newKeyVersion: version,
      });
      const challenge = this.issueHumanChallenge({
        purpose: "RECOVERY_KEY",
        organizationId: ctx.organizationId,
        principalId: input.principalId,
        subjectName: null,
        requestedCapability: null,
        invitationId: null,
        recoveryId,
        previousKeyVersionId: null,
        publicKey: pk,
        keyVersion: version,
        keyVersionId: keyId,
      });
      return { recoveryId, notBefore, keyVersion: version, challenge };
    });
  }

  proveRecovery(input: { challengeId: string; proof: PopProof }): { recoveryId: string; status: "WAITING" } {
    return this.db.transaction(() => {
      const c = this.consumeHumanChallenge(input.challengeId, "RECOVERY_KEY", input.proof);
      const rec = this.recoveryRow(String(c.recoveryId));
      if (rec["status"] !== "PENDING_PROOF") fail("INVALID_STATE", "recovery is not awaiting proof");
      const now = this.clock.now();
      this.db.run(
        "UPDATE key_versions SET status = 'PENDING_ACTIVATION', proven_at = ? WHERE id = ?",
        now,
        String(rec["new_key_version_id"]),
      );
      this.db.run("UPDATE recoveries SET status = 'WAITING' WHERE id = ?", String(rec["id"]));
      this.log(
        this.actorOf(c.organizationId, c.principalId, String(rec["new_key_version_id"]), null),
        "RECOVERY_KEY_PROVEN",
        "recovery",
        String(rec["id"]),
        {},
      );
      return { recoveryId: String(rec["id"]), status: "WAITING" as const };
    });
  }

  completeRecovery(ctx: AuthContext, input: { recoveryId: string }): KeyVersionView {
    this.require(ctx, "START_RECOVERY");
    const rec = this.recoveryRow(input.recoveryId);
    if (rec["organization_id"] !== ctx.organizationId) {
      this.deny(
        "FORBIDDEN",
        "recovery belongs to another organization",
        ctx.principal.id,
        "recovery",
        input.recoveryId,
      );
    }
    if (rec["principal_id"] === ctx.principal.id) {
      this.deny(
        "SEPARATION_OF_DUTIES",
        "a principal cannot complete its own recovery",
        ctx.principal.id,
        "recovery",
        input.recoveryId,
      );
    }
    if (rec["status"] !== "WAITING")
      fail("INVALID_STATE", "recovery key has not been proven or recovery is closed");
    if (this.clock.now() < Number(rec["not_before"])) {
      fail("DELAY_NOT_ELAPSED", "recovery delay has not elapsed", { notBefore: Number(rec["not_before"]) });
    }
    return this.db.transaction(() => {
      const now = this.clock.now();
      const actor = this.actorCtx(ctx);
      const newId = String(rec["new_key_version_id"]);
      this.db.run(
        "UPDATE key_versions SET status = 'ACTIVE', activated_at = ? WHERE id = ? AND status = 'PENDING_ACTIVATION'",
        now,
        newId,
      );
      for (const s of JSON.parse(String(rec["suspended_key_ids_json"])) as { id: string }[]) {
        this.revokeKeyTx(s.id, "RECOVERED", actor);
      }
      this.db.run(
        "UPDATE recoveries SET status = 'COMPLETED', completed_by = ?, completed_at = ? WHERE id = ?",
        ctx.principal.id,
        now,
        input.recoveryId,
      );
      this.log(actor, "RECOVERY_COMPLETED", "recovery", input.recoveryId, {
        principalId: String(rec["principal_id"]),
      });
      this.log(actor, "KEY_ACTIVATED", "key_version", newId, { principalId: String(rec["principal_id"]) });
      return this.keyView(this.keyRow(newId));
    });
  }

  /** The principal can veto a recovery during the delay by proving its existing (suspended) key. */
  createRecoveryCancelChallenge(input: { recoveryId: string }): ChallengeView {
    const rec = this.recoveryRow(input.recoveryId);
    if (rec["status"] !== "PENDING_PROOF" && rec["status"] !== "WAITING")
      fail("INVALID_STATE", "recovery is closed");
    const suspended = JSON.parse(String(rec["suspended_key_ids_json"])) as { id: string; prior: KeyStatus }[];
    const current = suspended.find((s) => s.prior === "ACTIVE") ?? suspended[0];
    if (!current) fail("INVALID_STATE", "no prior key can veto this recovery");
    const k = this.keyRow(current.id);
    return this.issueHumanChallenge({
      purpose: "RECOVERY_CANCEL",
      organizationId: String(rec["organization_id"]),
      principalId: String(rec["principal_id"]),
      subjectName: null,
      requestedCapability: null,
      invitationId: null,
      recoveryId: input.recoveryId,
      previousKeyVersionId: null,
      publicKey: String(k["public_key"]),
      keyVersion: Number(k["version"]),
      keyVersionId: current.id,
    });
  }

  cancelRecovery(input: { challengeId: string; proof: PopProof }): {
    recoveryId: string;
    status: "CANCELLED";
  } {
    return this.db.transaction(() => {
      const c = this.consumeHumanChallenge(input.challengeId, "RECOVERY_CANCEL", input.proof);
      const rec = this.recoveryRow(String(c.recoveryId));
      if (rec["status"] !== "PENDING_PROOF" && rec["status"] !== "WAITING")
        fail("INVALID_STATE", "recovery is closed");
      const now = this.clock.now();
      for (const s of JSON.parse(String(rec["suspended_key_ids_json"])) as {
        id: string;
        prior: KeyStatus;
      }[]) {
        this.db.run(
          "UPDATE key_versions SET status = ?, suspended_at = NULL WHERE id = ? AND status = 'SUSPENDED'",
          s.prior,
          s.id,
        );
      }
      this.db.run(
        "UPDATE key_versions SET status = 'REVOKED', revoked_at = ?, revoke_reason = 'RECOVERY_CANCELLED' WHERE id = ?",
        now,
        String(rec["new_key_version_id"]),
      );
      this.db.run(
        "UPDATE recoveries SET status = 'CANCELLED', cancelled_at = ? WHERE id = ?",
        now,
        String(rec["id"]),
      );
      this.log(
        this.actorOf(c.organizationId, c.principalId, String(c.keyVersionId), null),
        "RECOVERY_CANCELLED",
        "recovery",
        String(rec["id"]),
        {},
      );
      return { recoveryId: String(rec["id"]), status: "CANCELLED" as const };
    });
  }

  /* ================================================================ */
  /* Service principals: ManifestAttestor and deterministic policy    */
  /* ================================================================ */

  createServiceEnrollment(
    ctx: AuthContext,
    input: {
      serviceId: string;
      capability: Capability;
      publicKey: string;
      scope: {
        organizationId?: string;
        tradeId: string | null;
        evidencePolicyId: string;
        evidencePolicyRevision: number;
      };
      custody: { kind: string; reference: string };
    },
  ): {
    enrollmentId: string;
    principalId: string;
    keyVersion: number;
    keyVersionId: string;
    challenge: ServiceChallengeView;
  } {
    this.require(ctx, "ENROLL_SERVICE_KEY");
    const capability = parseCapability(input.capability);
    if (!isServiceCapability(capability))
      fail("VALIDATION_FAILED", "service enrollment requires a service capability");
    if (typeof input.serviceId !== "string" || !SERVICE_ID.test(input.serviceId))
      fail("VALIDATION_FAILED", "serviceId must be a slug");
    const scope = this.parseScope(ctx.organizationId, input.scope);
    const custody = this.parseCustody(input.custody);
    const pk = parsePublicKey(input.publicKey);
    this.assertKeyUnenrolled(pk);
    if (
      this.db.get(
        "SELECT 1 AS x FROM service_enrollments WHERE organization_id = ? AND service_id = ?",
        ctx.organizationId,
        input.serviceId,
      )
    ) {
      fail("INVALID_STATE", "serviceId already enrolled in this organization");
    }
    return this.db.transaction(() => {
      const now = this.clock.now();
      const enrollmentId = this.ids.next("svc");
      const principalId = this.ids.next("prn");
      this.db.run(
        `INSERT INTO principals (id, organization_id, kind, display_name, status, enrolled_via, created_at)
         VALUES (?, ?, 'SERVICE', ?, 'PENDING_GRANT', 'SERVICE_ENROLLMENT', ?)`,
        principalId,
        ctx.organizationId,
        input.serviceId,
        now,
      );
      this.db.run(
        `INSERT INTO service_enrollments (id, organization_id, principal_id, service_id, capability, scope_json, scope_digest, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING_PROOF', ?, ?)`,
        enrollmentId,
        ctx.organizationId,
        principalId,
        input.serviceId,
        capability,
        JSON.stringify(scope),
        this.scopeDigest(scope),
        ctx.principal.id,
        now,
      );
      const keyId = this.insertKey(principalId, 1, pk, "PENDING_PROOF", { custody });
      this.log(this.actorCtx(ctx), "SERVICE_ENROLLMENT_CREATED", "service_enrollment", enrollmentId, {
        serviceId: input.serviceId,
        capability,
        custodyKind: custody.kind,
        scopeDigest: this.scopeDigest(scope),
      });
      const challenge = this.issueServiceChallenge("SERVICE_ENROLL", enrollmentId, keyId, 1);
      return { enrollmentId, principalId, keyVersion: 1, keyVersionId: keyId, challenge };
    });
  }

  proveServiceKey(input: { challengeId: string; signature: string }): {
    enrollmentId: string;
    keyVersion: number;
  } {
    return this.db.transaction(() => {
      const c = this.db.get(
        "SELECT * FROM proof_challenges WHERE id = ? AND domain = 'SERVICE_POP_CHALLENGE'",
        input.challengeId,
      );
      if (!c) fail("NOT_FOUND", "service challenge not found");
      this.checkChallengeOpen(c);
      const payload = JSON.parse(String(c["payload_json"])) as Record<string, CanonicalValue>;
      requireSignature(String(c["public_key"]), "SERVICE_POP_CHALLENGE", payload, input.signature);
      this.markConsumed(c);
      const keyId = String(c["key_version_id"]);
      this.db.run(
        "UPDATE key_versions SET status = 'PENDING_ACTIVATION', proven_at = ? WHERE id = ? AND status = 'PENDING_PROOF'",
        this.clock.now(),
        keyId,
      );
      const e = this.enrollmentRow(String(c["related_id"]));
      const k = this.keyRow(keyId);
      this.log(
        this.actorOf(String(e["organization_id"]), String(e["principal_id"]), keyId, null),
        "SERVICE_KEY_PROVEN",
        "service_enrollment",
        String(e["id"]),
        {
          keyVersion: Number(k["version"]),
        },
      );
      return { enrollmentId: String(e["id"]), keyVersion: Number(k["version"]) };
    });
  }

  activateServiceKey(
    ctx: AuthContext,
    input: { enrollmentId: string; keyVersion: number },
  ): ServiceEnrollmentView {
    this.require(ctx, "ENROLL_SERVICE_KEY");
    const e = this.enrollmentInOrg(ctx, input.enrollmentId);
    const k = this.db.get(
      "SELECT * FROM key_versions WHERE principal_id = ? AND version = ?",
      String(e["principal_id"]),
      input.keyVersion,
    );
    if (!k) fail("NOT_FOUND", "key version not found");
    if (k["status"] !== "PENDING_ACTIVATION")
      fail("INVALID_STATE", "key version is not proven and awaiting activation");
    const notBefore = num(k["not_before"]);
    if (notBefore !== null && this.clock.now() < notBefore)
      fail("DELAY_NOT_ELAPSED", "recovery delay has not elapsed", { notBefore });
    return this.db.transaction(() => {
      const now = this.clock.now();
      const actor = this.actorCtx(ctx);
      for (const old of this.db.all(
        "SELECT * FROM key_versions WHERE principal_id = ? AND status IN ('ACTIVE','SUSPENDED')",
        String(e["principal_id"]),
      )) {
        if (old["status"] === "ACTIVE") {
          this.db.run(
            "UPDATE key_versions SET status = 'SUPERSEDED', superseded_at = ? WHERE id = ?",
            now,
            String(old["id"]),
          );
          this.log(actor, "KEY_SUPERSEDED", "key_version", String(old["id"]), {
            enrollmentId: String(e["id"]),
          });
        } else {
          this.revokeKeyTx(String(old["id"]), "RECOVERED", actor);
        }
      }
      this.db.run(
        "UPDATE key_versions SET status = 'ACTIVE', activated_at = ? WHERE id = ?",
        now,
        String(k["id"]),
      );
      this.db.run("UPDATE service_enrollments SET status = 'ACTIVE' WHERE id = ?", String(e["id"]));
      this.db.run("UPDATE principals SET status = 'ACTIVE' WHERE id = ?", String(e["principal_id"]));
      this.log(actor, "SERVICE_KEY_ACTIVATED", "service_enrollment", String(e["id"]), {
        keyVersion: input.keyVersion,
      });
      return this.getServiceEnrollment(String(e["id"]));
    });
  }

  rotateServiceKey(
    ctx: AuthContext,
    input: { enrollmentId: string; publicKey: string; custody: { kind: string; reference: string } },
  ): { keyVersion: number; keyVersionId: string; challenge: ServiceChallengeView } {
    return this.newServiceVersion(ctx, input, "SERVICE_ROTATE");
  }

  /** Key loss/compromise: current versions are suspended at once; the new version activates only after the delay. */
  recoverServiceKey(
    ctx: AuthContext,
    input: { enrollmentId: string; publicKey: string; custody: { kind: string; reference: string } },
  ): { keyVersion: number; keyVersionId: string; notBefore: number; challenge: ServiceChallengeView } {
    const r = this.newServiceVersion(ctx, input, "SERVICE_RECOVER");
    return { ...r, notBefore: Number(this.keyRow(r.keyVersionId)["not_before"]) };
  }

  revokeServiceKey(
    ctx: AuthContext,
    input: { enrollmentId: string; keyVersion: number; reason: string },
  ): KeyVersionView {
    this.require(ctx, "REVOKE_KEY");
    const reason = this.reason(input.reason);
    const e = this.enrollmentInOrg(ctx, input.enrollmentId);
    const k = this.db.get(
      "SELECT * FROM key_versions WHERE principal_id = ? AND version = ?",
      String(e["principal_id"]),
      input.keyVersion,
    );
    if (!k) fail("NOT_FOUND", "key version not found");
    return this.db.transaction(() =>
      this.revokeKeyTx(String(k["id"]), reason, this.actorCtx(ctx), String(e["id"])),
    );
  }

  getServiceEnrollment(enrollmentId: string): ServiceEnrollmentView {
    const e = this.enrollmentRow(enrollmentId);
    return {
      id: String(e["id"]),
      organizationId: String(e["organization_id"]),
      principalId: String(e["principal_id"]),
      serviceId: String(e["service_id"]),
      capability: parseCapability(e["capability"]),
      scope: JSON.parse(String(e["scope_json"])) as ServiceScope,
      status: String(e["status"]) as ServiceEnrollmentView["status"],
      versions: this.db
        .all("SELECT * FROM key_versions WHERE principal_id = ? ORDER BY version", String(e["principal_id"]))
        .map((k) => this.keyView(k)),
    };
  }

  /* ================================================================ */
  /* Read models for the key-management screens                      */
  /* ================================================================ */

  /**
   * Everything a security administrator needs to manage one organization's authority: human
   * principals with capabilities and every key version, service enrollments with custody kind
   * (never the custody locator), and recoveries. Read-only; denials are audited.
   */
  organizationDirectory(ctx: AuthContext): OrganizationDirectory {
    if (!ctx.capabilities.includes("ORG_SECURITY_ADMIN") && !ctx.capabilities.includes("AUDITOR")) {
      this.deny(
        "FORBIDDEN",
        "organization directory requires security admin or auditor",
        ctx.principal.id,
        "organization",
        ctx.organizationId,
      );
    }
    const org = this.db.get("SELECT * FROM organizations WHERE id = ?", ctx.organizationId);
    if (!org) fail("NOT_FOUND", "organization not found");
    const keysOf = (principalId: string) =>
      this.db
        .all("SELECT * FROM key_versions WHERE principal_id = ? ORDER BY version", principalId)
        .map((k) => this.keyDetail(k));
    const principals: DirectoryPrincipal[] = this.db
      .all(
        "SELECT * FROM principals WHERE organization_id = ? AND kind = 'HUMAN' ORDER BY created_at, id",
        ctx.organizationId,
      )
      .map((p) => ({
        ...this.principalView(p),
        enrolledVia: String(p["enrolled_via"]) as DirectoryPrincipal["enrolledVia"],
        createdAt: Number(p["created_at"]),
        capabilities: this.capabilitiesOf(String(p["id"])),
        keys: keysOf(String(p["id"])),
      }));
    const services: DirectoryService[] = this.db
      .all(
        "SELECT * FROM service_enrollments WHERE organization_id = ? ORDER BY created_at, id",
        ctx.organizationId,
      )
      .map((e) => ({
        id: String(e["id"]),
        organizationId: String(e["organization_id"]),
        principalId: String(e["principal_id"]),
        serviceId: String(e["service_id"]),
        capability: parseCapability(e["capability"]),
        scope: JSON.parse(String(e["scope_json"])) as ServiceScope,
        status: String(e["status"]) as ServiceEnrollmentView["status"],
        createdAt: Number(e["created_at"]),
        createdBy: String(e["created_by"]),
        versions: keysOf(String(e["principal_id"])),
      }));
    const recoveries = this.db
      .all(
        "SELECT * FROM recoveries WHERE organization_id = ? ORDER BY requested_at DESC, id",
        ctx.organizationId,
      )
      .map((r) => this.recoveryView(r));
    return {
      organization: { id: String(org["id"]), name: String(org["name"]), status: String(org["status"]) },
      recoveryDelayMs: this.cfg.recoveryDelayMs,
      principals,
      services,
      recoveries,
      observedAt: this.clock.now(),
    };
  }

  /** The calling principal's own key versions and any recovery that targets it. */
  ownKeys(ctx: AuthContext): OwnKeys {
    return {
      principalId: ctx.principal.id,
      currentKeyVersionId: ctx.keyVersion.id,
      keys: this.db
        .all("SELECT * FROM key_versions WHERE principal_id = ? ORDER BY version", ctx.principal.id)
        .map((k) => this.keyDetail(k)),
      recoveries: this.db
        .all(
          "SELECT * FROM recoveries WHERE principal_id = ? ORDER BY requested_at DESC, id",
          ctx.principal.id,
        )
        .map((r) => this.recoveryView(r)),
      observedAt: this.clock.now(),
    };
  }

  /* ================================================================ */
  /* Verification contracts for later modules                         */
  /* ================================================================ */

  /** Verify a service signature against an exact binding and use context (fails closed). */
  verifyServiceSignature(input: {
    binding: ServiceBinding;
    expectedCapability: Capability;
    context: ServiceScope;
    purpose: SigningPurpose;
    payload: CanonicalValue;
    signature: string;
  }): VerifiedServiceAuthority {
    const k = this.checkServiceBinding(input.binding, input.expectedCapability, input.context);
    requireSignature(input.binding.publicKey, input.purpose, input.payload, input.signature);
    return {
      enrollmentId: input.binding.enrollmentId,
      serviceId: input.binding.serviceId,
      capability: input.expectedCapability,
      keyVersion: Number(k["version"]),
      keyVersionId: String(k["id"]),
      publicKey: String(k["public_key"]),
      verifiedAt: this.clock.now(),
    };
  }

  /** Verify a service signature for a trade using only the binding the signed trade revision names. */
  verifyTradeServiceSignature(
    terms: TradeTerms,
    role: "manifestAttestor" | "policySetter",
    purpose: SigningPurpose,
    payload: CanonicalValue,
    signature: string,
  ): VerifiedServiceAuthority {
    const binding = terms[role];
    return this.verifyServiceSignature({
      binding,
      expectedCapability: binding.capability,
      context: this.tradeServiceContext(terms, role),
      purpose,
      payload,
      signature,
    });
  }

  verifyPrincipalSignature(input: {
    binding: PrincipalBinding;
    capability: Capability;
    purpose: SigningPurpose;
    payload: CanonicalValue;
    signature: string;
    organizationId?: string;
  }): VerifiedPrincipalAuthority {
    const { p, k } = this.checkPrincipalBinding(input.binding, input.capability, "principal");
    if (input.organizationId !== undefined && p["organization_id"] !== input.organizationId) {
      fail("SCOPE_MISMATCH", "principal belongs to another organization");
    }
    requireSignature(input.binding.publicKey, input.purpose, input.payload, input.signature);
    return {
      principalId: input.binding.principalId,
      organizationId: String(p["organization_id"]),
      capability: input.capability,
      keyVersionId: String(k["id"]),
      keyVersion: Number(k["version"]),
      verifiedAt: this.clock.now(),
    };
  }

  /**
   * Historical verification: valid when the signature verifies under the key version and
   * `signedAt` falls inside that version's active window. Revocation never rewrites history.
   */
  verifyHistorical(input: {
    keyVersionId: string;
    purpose: SigningPurpose;
    payload: CanonicalValue;
    signature: string;
    signedAt: number;
  }): { valid: boolean; keyStatusNow: KeyStatus; reason: string | null } {
    const k = this.keyRow(input.keyVersionId);
    const status = String(k["status"]) as KeyStatus;
    if (!verifyFor(String(k["public_key"]), input.purpose, input.payload, input.signature)) {
      return { valid: false, keyStatusNow: status, reason: "SIGNATURE_INVALID" };
    }
    const from = num(k["activated_at"]);
    if (from === null || input.signedAt < from)
      return { valid: false, keyStatusNow: status, reason: "BEFORE_ACTIVATION" };
    const ends = [num(k["revoked_at"]), num(k["suspended_at"])].filter((x): x is number => x !== null);
    const end = ends.length ? Math.min(...ends) : null;
    if (end !== null && input.signedAt >= end)
      return { valid: false, keyStatusNow: status, reason: "AFTER_REVOCATION" };
    return { valid: true, keyStatusNow: status, reason: null };
  }

  /**
   * Accept a trade revision only when buyer and supplier each signed its exact digest with
   * their bound keys, every bound authority is enrolled and usable, and the parties are independent.
   */
  verifyTradeRevisionAcceptance(
    terms: TradeTerms,
    sigs: { buyerSignature: string; supplierSignature: string },
  ): { ok: true; digest: string; buyer: VerifiedPrincipalAuthority; supplier: VerifiedPrincipalAuthority } {
    this.assertIndependentParties({
      buyer: terms.buyer,
      supplier: terms.supplier,
      inspector: terms.inspector,
      riskResolver: terms.riskResolver,
    });
    const canonical = tradeTermsCanonical(terms);
    const buyer = this.verifyPrincipalSignature({
      binding: terms.buyer,
      capability: "BUYER_APPROVER",
      purpose: "TRADE_REVISION",
      payload: canonical,
      signature: sigs.buyerSignature,
      organizationId: terms.buyer.organizationId,
    });
    const supplier = this.verifyPrincipalSignature({
      binding: terms.supplier,
      capability: "SUPPLIER_SIGNER",
      purpose: "TRADE_REVISION",
      payload: canonical,
      signature: sigs.supplierSignature,
      organizationId: terms.supplier.organizationId,
    });
    this.checkPrincipalBinding(terms.inspector, "INSPECTOR", "inspector");
    this.checkPrincipalBinding(terms.riskResolver, "RISK_RESOLVER", "riskResolver");
    for (const role of ["manifestAttestor", "policySetter"] as const) {
      this.checkServiceBinding(terms[role], terms[role].capability, this.tradeServiceContext(terms, role));
    }
    return { ok: true, digest: tradeRevisionDigest(terms), buyer, supplier };
  }

  /** Whether every authority bound by a revision is still the current, usable version. */
  bindingStatus(terms: TradeTerms): BindingStatus {
    const issues: { role: string; code: BindingIssueCode }[] = [];
    const statusIssue = (role: string, s: unknown) => {
      if (s === "SUPERSEDED") issues.push({ role, code: "KEY_SUPERSEDED" });
      else if (s === "SUSPENDED" || s === "REVOKED") issues.push({ role, code: "KEY_REVOKED" });
      else if (s !== "ACTIVE") issues.push({ role, code: "KEY_NOT_BOUND" });
    };
    const humans = [
      ["buyer", terms.buyer, "BUYER_APPROVER"],
      ["supplier", terms.supplier, "SUPPLIER_SIGNER"],
      ["inspector", terms.inspector, "INSPECTOR"],
      ["riskResolver", terms.riskResolver, "RISK_RESOLVER"],
    ] as const;
    for (const [role, b, cap] of humans) {
      const k = this.db.get(
        "SELECT * FROM key_versions WHERE id = ? AND principal_id = ?",
        b.keyVersionId,
        b.principalId,
      );
      if (!k || k["public_key"] !== b.publicKey) issues.push({ role, code: "KEY_NOT_BOUND" });
      else statusIssue(role, k["status"]);
      if (!this.capabilitiesOf(b.principalId).includes(cap))
        issues.push({ role, code: "CAPABILITY_MISSING" });
    }
    for (const role of ["manifestAttestor", "policySetter"] as const) {
      const b = terms[role];
      try {
        this.checkServiceScope(b, b.capability, this.tradeServiceContext(terms, role));
      } catch {
        issues.push({ role, code: "SCOPE_MISMATCH" });
        continue;
      }
      const e = this.db.get("SELECT principal_id FROM service_enrollments WHERE id = ?", b.enrollmentId);
      const k =
        e &&
        this.db.get(
          "SELECT * FROM key_versions WHERE principal_id = ? AND version = ?",
          String(e["principal_id"]),
          b.keyVersion,
        );
      if (!k || k["public_key"] !== b.publicKey) issues.push({ role, code: "KEY_NOT_BOUND" });
      else statusIssue(role, k["status"]);
    }
    return { current: issues.length === 0, requiresNewRevision: issues.length > 0, issues };
  }

  /**
   * What a key-rebinding revision of `terms` would bind (M14): for every role whose bound key is
   * no longer its current usable key, the principal's or enrollment's ACTIVE key version, or the
   * reason none can be bound (no active key yet, capability missing, enrollment revoked or out
   * of scope: those need another kind of revision, not a rebinding). The escrow contract lets
   * one rebinding change at most one party key, so when both the buyer's and the supplier's keys
   * changed, the buyer is rebound first and the supplier is deferred to the next rebinding.
   * Read-only; never key material beyond public keys.
   */
  rebindingPlan(terms: TradeTerms): RebindingPlan {
    const status = this.bindingStatus(terms);
    const roles: RebindingPlanRole[] = [];
    const issuesOf = (role: string) => status.issues.filter((i) => i.role === role).map((i) => i.code);
    const humans = [
      ["buyer", terms.buyer, "BUYER_APPROVER"],
      ["supplier", terms.supplier, "SUPPLIER_SIGNER"],
      ["inspector", terms.inspector, "INSPECTOR"],
      ["riskResolver", terms.riskResolver, "RISK_RESOLVER"],
    ] as const;
    for (const [role, b, cap] of humans) {
      const issues = issuesOf(role);
      const from = {
        keyVersionId: b.keyVersionId,
        publicKey: b.publicKey,
        keyVersion: null as number | null,
      };
      const bound = this.db.get("SELECT version FROM key_versions WHERE id = ?", b.keyVersionId);
      if (bound) from.keyVersion = Number(bound["version"]);
      if (!issues.length) {
        roles.push({ role, issues, from, to: null, blockedBy: null });
        continue;
      }
      if (issues.includes("CAPABILITY_MISSING")) {
        roles.push({ role, issues, from, to: null, blockedBy: "CAPABILITY_MISSING" });
        continue;
      }
      const k = this.db.get(
        "SELECT * FROM key_versions WHERE principal_id = ? AND status = 'ACTIVE' ORDER BY version DESC",
        b.principalId,
      );
      if (!k || k["public_key"] === b.publicKey) {
        roles.push({ role, issues, from, to: null, blockedBy: "NO_ACTIVE_KEY" });
        continue;
      }
      roles.push({
        role,
        issues,
        from,
        to: {
          keyVersionId: String(k["id"]),
          keyVersion: Number(k["version"]),
          publicKey: String(k["public_key"]),
        },
        blockedBy: null,
      });
    }
    for (const role of ["manifestAttestor", "policySetter"] as const) {
      const b = terms[role];
      const issues = issuesOf(role);
      const from = { keyVersionId: null as string | null, publicKey: b.publicKey, keyVersion: b.keyVersion };
      if (!issues.length) {
        roles.push({ role, issues, from, to: null, blockedBy: null });
        continue;
      }
      if (issues.includes("SCOPE_MISMATCH")) {
        roles.push({ role, issues, from, to: null, blockedBy: "SCOPE_MISMATCH" });
        continue;
      }
      const e = this.db.get("SELECT * FROM service_enrollments WHERE id = ?", b.enrollmentId);
      const k =
        e &&
        e["status"] === "ACTIVE" &&
        this.db.get(
          "SELECT * FROM key_versions WHERE principal_id = ? AND status = 'ACTIVE' ORDER BY version DESC",
          String(e["principal_id"]),
        );
      if (!k || Number(k["version"]) <= b.keyVersion) {
        roles.push({
          role,
          issues,
          from,
          to: null,
          blockedBy: e && e["status"] !== "ACTIVE" ? "ENROLLMENT_REVOKED" : "NO_ACTIVE_KEY",
        });
        continue;
      }
      from.keyVersionId = null;
      roles.push({
        role,
        issues,
        from,
        to: {
          keyVersionId: String(k["id"]),
          keyVersion: Number(k["version"]),
          publicKey: String(k["public_key"]),
        },
        blockedBy: null,
      });
    }
    const rebindable = roles.filter((r) => r.to !== null);
    const deferred: string[] = [];
    if (rebindable.some((r) => r.role === "buyer") && rebindable.some((r) => r.role === "supplier"))
      deferred.push("supplier");
    const rebind = rebindable.map((r) => r.role).filter((r) => !deferred.includes(r));
    const blocked = roles.filter((r) => r.blockedBy !== null).map((r) => r.role);
    return {
      requiresNewRevision: status.requiresNewRevision,
      roles,
      rebind,
      deferred,
      blocked,
      rebindsParty: rebind.includes("buyer") || rebind.includes("supplier"),
    };
  }

  /* ================================================================ */
  /* Internals                                                        */
  /* ================================================================ */

  private require(ctx: AuthContext, action: AuthorityAction): void {
    if (!capabilityAllows(action, ctx.capabilities)) {
      this.deny("FORBIDDEN", `capability required for ${action}`, ctx.principal.id, "action", action);
    }
  }

  /** Audit a denial in its own transaction, then throw. */
  private deny(
    code: ErrorCode,
    message: string,
    actorPrincipalId: string | null,
    subjectType: string,
    subjectId: string,
  ): never {
    if (!this.db.inTransaction) {
      this.audit.append({
        eventType: "AUTHORITY_DENIED",
        organizationId: null,
        actorPrincipalId,
        actorKeyVersionId: null,
        sessionId: null,
        subjectType,
        subjectId,
        correlationId: this.ids.next("cor"),
        source: SOURCE,
        payload: { reason: code },
      });
    }
    throw new DocksideError(code, message);
  }

  private actorCtx(ctx: AuthContext) {
    return {
      organizationId: ctx.organizationId,
      actorPrincipalId: ctx.principal.id,
      actorKeyVersionId: ctx.keyVersion.id,
      sessionId: ctx.session.id,
      correlationId: ctx.correlationId,
    };
  }

  private actorOf(
    organizationId: string,
    principalId: string | null,
    keyVersionId: string | null,
    sessionId: string | null,
  ) {
    return {
      organizationId,
      actorPrincipalId: principalId,
      actorKeyVersionId: keyVersionId,
      sessionId,
      correlationId: this.ids.next("cor"),
    };
  }

  private log(
    actor: Pick<
      AuditEventInput,
      "organizationId" | "actorPrincipalId" | "actorKeyVersionId" | "sessionId" | "correlationId"
    >,
    eventType: string,
    subjectType: string,
    subjectId: string,
    payload: Record<string, string | number | boolean | null>,
  ): void {
    this.audit.append({ ...actor, eventType, subjectType, subjectId, source: SOURCE, payload });
  }

  private displayName(raw: string): string {
    if (typeof raw !== "string") fail("VALIDATION_FAILED", "name must be a string");
    const s = raw.normalize("NFC").trim();
    if (!DISPLAY_NAME.test(s))
      fail("VALIDATION_FAILED", "name must be 1..120 letters, digits, spaces or . , ' & ( ) _ -");
    return s;
  }

  private reason(raw: string): string {
    if (typeof raw !== "string" || !REASON.test(raw))
      fail("VALIDATION_FAILED", "reason must be an UPPER_SNAKE code");
    return raw;
  }

  private parseScope(
    orgId: string,
    s: {
      organizationId?: string;
      tradeId: string | null;
      evidencePolicyId: string;
      evidencePolicyRevision: number;
    },
  ): ServiceScope {
    if (s === null || typeof s !== "object") fail("VALIDATION_FAILED", "scope required");
    const allowed = new Set(["organizationId", "tradeId", "evidencePolicyId", "evidencePolicyRevision"]);
    for (const k of Object.keys(s))
      if (!allowed.has(k)) fail("UNKNOWN_FIELD", "unknown scope field", { field: k });
    if (s.organizationId !== undefined && s.organizationId !== orgId) {
      fail("SCOPE_MISMATCH", "a service can only be scoped to the enrolling organization");
    }
    if (s.tradeId !== null && !/^trd_[0-9a-f]{32}$/.test(String(s.tradeId)))
      fail("VALIDATION_FAILED", "invalid trade id");
    if (typeof s.evidencePolicyId !== "string" || !SERVICE_ID.test(s.evidencePolicyId))
      fail("VALIDATION_FAILED", "invalid evidence policy id");
    if (!Number.isSafeInteger(s.evidencePolicyRevision) || s.evidencePolicyRevision < 1)
      fail("VALIDATION_FAILED", "invalid policy revision");
    return {
      organizationId: orgId,
      tradeId: s.tradeId,
      evidencePolicyId: s.evidencePolicyId,
      evidencePolicyRevision: s.evidencePolicyRevision,
    };
  }

  private scopeDigest(s: ServiceScope): string {
    return digestHexFor("SERVICE_POP_CHALLENGE", { scope: { ...s } });
  }

  private parseCustody(c: { kind: string; reference: string }): { kind: string; reference: string } {
    if (c === null || typeof c !== "object") fail("VALIDATION_FAILED", "custody metadata required");
    if (!(CUSTODY_KINDS as readonly string[]).includes(c.kind))
      fail("VALIDATION_FAILED", "custody kind must be HSM, KMS or ISOLATED_SIGNER_PROCESS");
    if (typeof c.reference !== "string" || !CUSTODY_REF.test(c.reference))
      fail("VALIDATION_FAILED", "custody reference must be an opaque locator");
    // Custody metadata is a pointer to the isolated signer, never key material.
    if (/[1-9A-HJ-NP-Za-km-z]{40,}|[0-9a-fA-F]{40,}|private|secret|seed/i.test(c.reference)) {
      fail("VALIDATION_FAILED", "custody reference looks like key material");
    }
    return { kind: c.kind, reference: c.reference };
  }

  private assertKeyUnenrolled(pk: string): void {
    if (this.db.get("SELECT 1 AS x FROM key_versions WHERE public_key = ?", pk)) {
      fail(
        "SEPARATION_OF_DUTIES",
        "this public key is already enrolled; every principal and version needs a distinct key",
      );
    }
  }

  private assertUsableKey(k: Row, slot: string): void {
    const s = k["status"];
    if (s === "REVOKED" || s === "SUSPENDED")
      fail("KEY_REVOKED", `${slot} key is revoked or suspended`, { slot });
    if (!USABLE.includes(s as KeyStatus)) fail("KEY_NOT_BOUND", `${slot} key is not active`, { slot });
  }

  private checkPrincipalBinding(
    b: PrincipalBinding,
    capability: Capability,
    slot: string,
  ): { p: Row; k: Row } {
    const p = this.principalRow(b.principalId);
    if (p?.["kind"] !== "HUMAN") fail("NOT_FOUND", `${slot} principal not enrolled`, { slot });
    const k = this.db.get(
      "SELECT * FROM key_versions WHERE id = ? AND principal_id = ?",
      b.keyVersionId,
      b.principalId,
    );
    if (!k || k["public_key"] !== b.publicKey)
      fail("KEY_NOT_BOUND", `${slot} key is not the enrolled version`, { slot });
    this.assertUsableKey(k, slot);
    if (!this.capabilitiesOf(b.principalId).includes(capability))
      fail("FORBIDDEN", `${slot} lacks ${capability}`, { slot });
    return { p, k };
  }

  private checkServiceScope(b: ServiceBinding, expected: Capability, context: ServiceScope): Row {
    if (b.capability !== expected) fail("FORBIDDEN", "binding capability is not the required capability");
    const e = this.db.get("SELECT * FROM service_enrollments WHERE id = ?", b.enrollmentId);
    if (!e) fail("NOT_FOUND", "service enrollment not found");
    if (e["capability"] !== expected)
      fail("FORBIDDEN", "enrolled service does not hold the required capability");
    if (e["service_id"] !== b.serviceId)
      fail("KEY_NOT_BOUND", "service identity does not match the enrollment");
    const s = JSON.parse(String(e["scope_json"])) as ServiceScope;
    const same =
      s.organizationId === b.scope.organizationId &&
      s.tradeId === b.scope.tradeId &&
      s.evidencePolicyId === b.scope.evidencePolicyId &&
      s.evidencePolicyRevision === b.scope.evidencePolicyRevision;
    if (!same) fail("SCOPE_MISMATCH", "binding scope differs from the enrolled scope");
    const covers =
      s.organizationId === context.organizationId &&
      (s.tradeId === null || s.tradeId === context.tradeId) &&
      s.evidencePolicyId === context.evidencePolicyId &&
      s.evidencePolicyRevision === context.evidencePolicyRevision;
    if (!covers)
      fail("SCOPE_MISMATCH", "enrolled scope does not cover this organization/trade/EvidencePolicy");
    return e;
  }

  private checkServiceBinding(b: ServiceBinding, expected: Capability, context: ServiceScope): Row {
    const e = this.checkServiceScope(b, expected, context);
    const k = this.db.get(
      "SELECT * FROM key_versions WHERE principal_id = ? AND version = ?",
      String(e["principal_id"]),
      b.keyVersion,
    );
    if (!k || k["public_key"] !== b.publicKey)
      fail("KEY_NOT_BOUND", "bound key version/public key is not enrolled for this service");
    this.assertUsableKey(k, b.serviceId);
    return k;
  }

  private tradeServiceContext(terms: TradeTerms, role: "manifestAttestor" | "policySetter"): ServiceScope {
    const org = terms[role].scope.organizationId;
    if (org !== terms.buyer.organizationId && org !== terms.supplier.organizationId) {
      fail("SCOPE_MISMATCH", "trade services must be operated by a trade counterparty organization");
    }
    return {
      organizationId: org,
      tradeId: terms.tradeId,
      evidencePolicyId: terms.evidencePolicy.id,
      evidencePolicyRevision: terms.evidencePolicy.revision,
    };
  }

  private newServiceVersion(
    ctx: AuthContext,
    input: { enrollmentId: string; publicKey: string; custody: { kind: string; reference: string } },
    purpose: "SERVICE_ROTATE" | "SERVICE_RECOVER",
  ): { keyVersion: number; keyVersionId: string; challenge: ServiceChallengeView } {
    this.require(ctx, purpose === "SERVICE_ROTATE" ? "ENROLL_SERVICE_KEY" : "START_RECOVERY");
    const e = this.enrollmentInOrg(ctx, input.enrollmentId);
    if (e["status"] !== "ACTIVE") fail("INVALID_STATE", "enrollment is not active");
    const pending = this.db.get(
      "SELECT 1 AS x FROM key_versions WHERE principal_id = ? AND status IN ('PENDING_PROOF','PENDING_ACTIVATION')",
      String(e["principal_id"]),
    );
    if (pending) fail("INVALID_STATE", "another key version is already pending");
    const custody = this.parseCustody(input.custody);
    const pk = parsePublicKey(input.publicKey);
    this.assertKeyUnenrolled(pk);
    return this.db.transaction(() => {
      const principalId = String(e["principal_id"]);
      const version = this.nextVersion(principalId);
      const actor = this.actorCtx(ctx);
      const notBefore =
        purpose === "SERVICE_RECOVER" ? this.clock.now() + this.cfg.recoveryDelayMs : undefined;
      if (purpose === "SERVICE_RECOVER") this.suspendUsableKeys(principalId, actor);
      const keyId = this.insertKey(
        principalId,
        version,
        pk,
        "PENDING_PROOF",
        notBefore === undefined ? { custody } : { custody, notBefore },
      );
      this.log(
        actor,
        purpose === "SERVICE_ROTATE" ? "SERVICE_KEY_ROTATION_REQUESTED" : "SERVICE_KEY_RECOVERY_REQUESTED",
        "service_enrollment",
        String(e["id"]),
        {
          keyVersion: version,
          notBefore: notBefore ?? null,
        },
      );
      return {
        keyVersion: version,
        keyVersionId: keyId,
        challenge: this.issueServiceChallenge(purpose, String(e["id"]), keyId, version),
      };
    });
  }

  private enrollmentRow(id: string): Row {
    const e = this.db.get("SELECT * FROM service_enrollments WHERE id = ?", id);
    if (!e) fail("NOT_FOUND", "service enrollment not found");
    return e;
  }

  private enrollmentInOrg(ctx: AuthContext, id: string): Row {
    const e = this.enrollmentRow(id);
    if (e["organization_id"] !== ctx.organizationId) {
      this.deny(
        "FORBIDDEN",
        "service enrollment belongs to another organization",
        ctx.principal.id,
        "service_enrollment",
        id,
      );
    }
    return e;
  }

  private recoveryRow(id: string): Row {
    const r = this.db.get("SELECT * FROM recoveries WHERE id = ?", id);
    if (!r) fail("NOT_FOUND", "recovery not found");
    return r;
  }

  private principalRow(id: string): Row | undefined {
    return this.db.get("SELECT * FROM principals WHERE id = ?", id);
  }

  private keyRow(id: string): Row {
    const k = this.db.get("SELECT * FROM key_versions WHERE id = ?", id);
    if (!k) fail("NOT_FOUND", "key version not found");
    return k;
  }

  private invitationBySecret(secret: string): Row {
    if (typeof secret !== "string" || !TOKEN.test(secret)) fail("NOT_FOUND", "invitation not found");
    const inv = this.db.get("SELECT * FROM invitations WHERE secret_hash = ?", hashToken(secret));
    if (!inv) fail("NOT_FOUND", "invitation not found");
    return inv;
  }

  private nextVersion(principalId: string): number {
    const r = this.db.get<{ v: number | null }>(
      "SELECT MAX(version) AS v FROM key_versions WHERE principal_id = ?",
      principalId,
    );
    return (r?.v ?? 0) + 1;
  }

  private insertKey(
    principalId: string,
    version: number,
    publicKey: string,
    status: KeyStatus,
    opts: { proven?: boolean; custody?: { kind: string; reference: string }; notBefore?: number },
  ): string {
    const id = this.ids.next("key");
    const now = this.clock.now();
    this.db.run(
      `INSERT INTO key_versions (id, principal_id, version, public_key, status, custody_kind, custody_ref, not_before, created_at, proven_at, activated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      principalId,
      version,
      publicKey,
      status,
      opts.custody?.kind ?? null,
      opts.custody?.reference ?? null,
      opts.notBefore ?? null,
      now,
      opts.proven ? now : null,
      status === "ACTIVE" ? now : null,
    );
    return id;
  }

  private insertGrant(
    orgId: string,
    principalId: string,
    capability: Capability,
    grantedBy: string | null,
    sessionId: string | null,
    invitationId: string | null,
    actor: Parameters<AuthorityService["log"]>[0],
  ): RoleGrantView {
    assertCapabilityCompatible(this.capabilitiesOf(principalId), capability);
    const id = this.ids.next("grt");
    const now = this.clock.now();
    this.db.run(
      `INSERT INTO role_grants (id, organization_id, principal_id, capability, status, granted_by_principal_id, granted_session_id, invitation_id, created_at)
       VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?)`,
      id,
      orgId,
      principalId,
      capability,
      grantedBy,
      sessionId,
      invitationId,
      now,
    );
    this.db.run(
      "UPDATE principals SET status = 'ACTIVE', version = version + 1 WHERE id = ? AND status = 'PENDING_GRANT'",
      principalId,
    );
    this.log(actor, "ROLE_GRANTED", "role_grant", id, { principalId, capability, invitationId });
    return {
      id,
      organizationId: orgId,
      principalId,
      capability,
      grantedByPrincipalId: grantedBy,
      invitationId,
      createdAt: now,
    };
  }

  private capabilitiesOf(principalId: string): Capability[] {
    return this.db
      .all(
        "SELECT capability FROM role_grants WHERE principal_id = ? AND status = 'ACTIVE' ORDER BY capability",
        principalId,
      )
      .map((r) => parseCapability(r["capability"]));
  }

  private createSession(
    principalId: string,
    keyVersionId: string,
    orgId: string,
    challengeId: string,
    actor: Parameters<AuthorityService["log"]>[0],
  ): SessionGrant {
    const token = randomBytes(32).toString("base64url");
    const id = this.ids.next("ses");
    const now = this.clock.now();
    const expiresAt = now + this.cfg.sessionTtlMs;
    this.db.run(
      `INSERT INTO sessions (id, token_hash, principal_id, key_version_id, organization_id, challenge_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      hashToken(token),
      principalId,
      keyVersionId,
      orgId,
      challengeId,
      now,
      expiresAt,
    );
    this.log({ ...actor, sessionId: id }, "SESSION_CREATED", "session", id, {
      principalId,
      keyVersionId,
      expiresAt,
    });
    const k = this.keyRow(keyVersionId);
    return {
      sessionId: id,
      sessionToken: token,
      expiresAt,
      organizationId: orgId,
      principalId,
      keyVersionId,
      keyVersion: Number(k["version"]),
      capabilities: this.capabilitiesOf(principalId),
    };
  }

  private revokeSessionsForKey(keyVersionId: string, reason: string): void {
    this.db.run(
      "UPDATE sessions SET revoked_at = ?, revoke_reason = ? WHERE key_version_id = ? AND revoked_at IS NULL",
      this.clock.now(),
      reason,
      keyVersionId,
    );
  }

  private suspendUsableKeys(
    principalId: string,
    actor: Parameters<AuthorityService["log"]>[0],
  ): { id: string; prior: KeyStatus }[] {
    const now = this.clock.now();
    const out: { id: string; prior: KeyStatus }[] = [];
    for (const k of this.db.all(
      "SELECT * FROM key_versions WHERE principal_id = ? AND status IN ('ACTIVE','SUPERSEDED')",
      principalId,
    )) {
      out.push({ id: String(k["id"]), prior: String(k["status"]) as KeyStatus });
      this.db.run(
        "UPDATE key_versions SET status = 'SUSPENDED', suspended_at = ? WHERE id = ?",
        now,
        String(k["id"]),
      );
      this.revokeSessionsForKey(String(k["id"]), "KEY_SUSPENDED");
      this.log(actor, "KEY_SUSPENDED", "key_version", String(k["id"]), { principalId });
    }
    return out;
  }

  private revokeKeyTx(
    keyId: string,
    reason: string,
    actor: Parameters<AuthorityService["log"]>[0],
    enrollmentId?: string,
  ): KeyVersionView {
    const k = this.keyRow(keyId);
    if (k["status"] === "REVOKED") fail("INVALID_STATE", "key already revoked");
    this.db.run(
      "UPDATE key_versions SET status = 'REVOKED', revoked_at = ?, revoke_reason = ? WHERE id = ?",
      this.clock.now(),
      reason,
      keyId,
    );
    this.revokeSessionsForKey(keyId, "KEY_REVOKED");
    this.log(actor, "KEY_REVOKED", "key_version", keyId, {
      principalId: String(k["principal_id"]),
      version: Number(k["version"]),
      reason,
      enrollmentId: enrollmentId ?? null,
    });
    return this.keyView(this.keyRow(keyId));
  }

  private principalView(p: Row): PrincipalView {
    return {
      id: String(p["id"]),
      organizationId: String(p["organization_id"]),
      kind: String(p["kind"]) as PrincipalView["kind"],
      displayName: String(p["display_name"]),
      status: String(p["status"]) as PrincipalView["status"],
    };
  }

  private keyView(k: Row): KeyVersionView {
    return {
      id: String(k["id"]),
      principalId: String(k["principal_id"]),
      version: Number(k["version"]),
      publicKey: String(k["public_key"]),
      status: String(k["status"]) as KeyStatus,
      custodyKind: str(k["custody_kind"]),
      notBefore: num(k["not_before"]),
      activatedAt: num(k["activated_at"]),
      revokedAt: num(k["revoked_at"]),
    };
  }

  private keyDetail(k: Row): KeyVersionDetail {
    return {
      ...this.keyView(k),
      createdAt: Number(k["created_at"]),
      provenAt: num(k["proven_at"]),
      supersededAt: num(k["superseded_at"]),
      suspendedAt: num(k["suspended_at"]),
      revokeReason: str(k["revoke_reason"]),
    };
  }

  private recoveryView(r: Row): RecoveryView {
    const k = this.keyRow(String(r["new_key_version_id"]));
    return {
      id: String(r["id"]),
      organizationId: String(r["organization_id"]),
      principalId: String(r["principal_id"]),
      newKeyVersionId: String(k["id"]),
      newKeyVersion: Number(k["version"]),
      newPublicKey: String(k["public_key"]),
      suspendedKeyVersionIds: (JSON.parse(String(r["suspended_key_ids_json"])) as { id: string }[]).map(
        (x) => x.id,
      ),
      status: String(r["status"]) as RecoveryView["status"],
      requestedBy: String(r["requested_by"]),
      requestedAt: Number(r["requested_at"]),
      notBefore: Number(r["not_before"]),
      completedBy: str(r["completed_by"]),
      completedAt: num(r["completed_at"]),
      cancelledAt: num(r["cancelled_at"]),
    };
  }

  /* ---------------- challenges ---------------- */

  private issueHumanChallenge(input: {
    purpose: HumanChallengePurpose;
    organizationId: string;
    principalId: string;
    subjectName: string | null;
    requestedCapability: Capability | null;
    invitationId: string | null;
    recoveryId: string | null;
    previousKeyVersionId: string | null;
    publicKey: string;
    keyVersion: number;
    keyVersionId: string | null;
  }): ChallengeView {
    const now = this.clock.now();
    const id = this.ids.next("chl");
    const payload: HumanChallengePayload = {
      challengeId: id,
      purpose: input.purpose,
      origin: this.cfg.origin,
      network: this.cfg.network,
      organizationId: input.organizationId,
      principalId: input.principalId,
      subjectName: input.subjectName,
      requestedCapability: input.requestedCapability,
      invitationId: input.invitationId,
      recoveryId: input.recoveryId,
      previousKeyVersionId: input.previousKeyVersionId,
      publicKey: input.publicKey,
      keyVersion: input.keyVersion,
      nonce: newNonce(),
      issuedAt: now,
      expiresAt: now + this.cfg.challengeTtlMs,
    };
    const digestHex = digestHexFor("POP_CHALLENGE", payload);
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO proof_challenges (id, purpose, domain, origin, organization_id, principal_id, key_version_id, related_id, public_key, payload_json, digest_hex, nonce, issued_at, expires_at, status)
         VALUES (?, ?, 'POP_CHALLENGE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
        id,
        input.purpose,
        this.cfg.origin,
        input.organizationId,
        input.principalId,
        input.keyVersionId,
        input.invitationId ?? input.recoveryId ?? input.previousKeyVersionId,
        input.publicKey,
        JSON.stringify(payload),
        digestHex,
        payload.nonce,
        now,
        payload.expiresAt,
      );
      this.log(
        this.actorOf(input.organizationId, null, null, null),
        "POP_CHALLENGE_ISSUED",
        "challenge",
        id,
        {
          purpose: input.purpose,
          principalId: input.principalId,
          expiresAt: payload.expiresAt,
        },
      );
    });
    return {
      challengeId: id,
      purpose: input.purpose,
      payload,
      canonicalPayload: payload,
      typedPayload: toTypedJson(payload),
      digestHex,
      nep413: {
        message: nep413Message(payload, digestHex),
        nonceHex: payload.nonce,
        recipient: this.cfg.origin,
      },
      expiresAt: payload.expiresAt,
    };
  }

  private issueServiceChallenge(
    purpose: ServiceChallengePurpose,
    enrollmentId: string,
    keyId: string,
    keyVersion: number,
  ): ServiceChallengeView {
    const e = this.enrollmentRow(enrollmentId);
    const k = this.keyRow(keyId);
    const now = this.clock.now();
    const id = this.ids.next("chl");
    const scope = JSON.parse(String(e["scope_json"])) as ServiceScope;
    const payload: Record<string, CanonicalValue> = {
      challengeId: id,
      purpose,
      origin: this.cfg.origin,
      network: this.cfg.network,
      organizationId: String(e["organization_id"]),
      enrollmentId,
      serviceId: String(e["service_id"]),
      capability: String(e["capability"]),
      scope: { ...scope },
      publicKey: String(k["public_key"]),
      keyVersion,
      custodyKind: str(k["custody_kind"]),
      nonce: newNonce(),
      issuedAt: now,
      expiresAt: now + this.cfg.challengeTtlMs,
    };
    const digestHex = digestHexFor("SERVICE_POP_CHALLENGE", payload);
    this.db.run(
      `INSERT INTO proof_challenges (id, purpose, domain, origin, organization_id, principal_id, key_version_id, related_id, public_key, payload_json, digest_hex, nonce, issued_at, expires_at, status)
       VALUES (?, ?, 'SERVICE_POP_CHALLENGE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
      id,
      purpose,
      this.cfg.origin,
      String(e["organization_id"]),
      String(e["principal_id"]),
      keyId,
      enrollmentId,
      String(k["public_key"]),
      JSON.stringify(payload),
      digestHex,
      String(payload["nonce"]),
      now,
      Number(payload["expiresAt"]),
    );
    return {
      challengeId: id,
      purpose,
      payload,
      canonicalPayload: payload,
      typedPayload: toTypedJson(payload),
      digestHex,
      expiresAt: Number(payload["expiresAt"]),
    };
  }

  private checkChallengeOpen(c: Row): void {
    if (c["status"] === "CONSUMED") fail("NONCE_REPLAYED", "challenge already consumed");
    if (c["origin"] !== this.cfg.origin) fail("WRONG_ORIGIN", "challenge was issued for a different origin");
    const payload = JSON.parse(String(c["payload_json"])) as { issuedAt: number; expiresAt: number };
    checkValidityWindow(payload, this.clock.now(), { maxLifetimeMs: this.cfg.challengeTtlMs, maxSkewMs: 0 });
  }

  private markConsumed(c: Row): void {
    const r = this.db.run(
      "UPDATE proof_challenges SET status = 'CONSUMED', consumed_at = ? WHERE id = ? AND status = 'PENDING'",
      this.clock.now(),
      String(c["id"]),
    );
    if (Number(r.changes) !== 1) fail("NONCE_REPLAYED", "challenge already consumed");
    this.nonces.consume(`pop:${c["domain"]}`, String(c["nonce"]), Number(c["expires_at"]));
  }

  /** Verify and atomically consume a human PoP challenge (must run inside a transaction). */
  private consumeHumanChallenge(
    challengeId: string,
    purpose: HumanChallengePurpose,
    proof: PopProof,
  ): HumanChallengePayload & { keyVersionId: string | null } {
    const c = this.db.get(
      "SELECT * FROM proof_challenges WHERE id = ? AND domain = 'POP_CHALLENGE'",
      challengeId,
    );
    if (!c) fail("NOT_FOUND", "challenge not found");
    this.checkChallengeOpen(c);
    if (c["purpose"] !== purpose) fail("INVALID_STATE", "challenge purpose mismatch");
    const payload = JSON.parse(String(c["payload_json"])) as HumanChallengePayload;
    const pk = String(c["public_key"]);
    if (proof?.scheme === "dockside-ed25519") {
      requireSignature(pk, "POP_CHALLENGE", payload, proof.signature);
    } else if (proof?.scheme === "nep413") {
      const ok = verifyNep413(
        pk,
        {
          message: nep413Message(payload, String(c["digest_hex"])),
          nonce: fromHex(payload.nonce),
          recipient: this.cfg.origin,
        },
        proof.signature,
      );
      if (!ok) fail("SIGNATURE_INVALID", "NEP-413 signature does not verify for this challenge and origin");
    } else {
      fail("VALIDATION_FAILED", "unsupported proof scheme");
    }
    this.markConsumed(c);
    return { ...payload, keyVersionId: str(c["key_version_id"]) };
  }
}

/** Human-readable NEP-413 message; it embeds the canonical digest so a wallet signature binds every fact. */
export function nep413Message(p: HumanChallengePayload, digestHex: string): string {
  return [
    "Dockside proof of possession",
    `purpose: ${p.purpose}`,
    `organization: ${p.organizationId}`,
    `principal: ${p.principalId}`,
    `capability: ${p.requestedCapability ?? "none"}`,
    `expires: ${new Date(p.expiresAt).toISOString()}`,
    `digest: ${digestHex}`,
  ].join("\n");
}
