import type { AuthContext, AuthorityService } from "@dockside/authority";
import {
  type CanonicalValue,
  type Clock,
  capabilityAllows,
  digestHexFor,
  fail,
  fromTypedJson,
  type IdGenerator,
  newNonce,
  type TradeTerms,
  type TypedJson,
  toTypedJson,
} from "@dockside/core";
import { holdSetPayload, tradeBinding } from "@dockside/near";
import { AuditLog, type Database, isUniqueViolation, SqliteNonceRegistry } from "@dockside/store";
import {
  checkHeader,
  checkWindow,
  exact,
  expectStr,
  isCode,
  isHex64,
  nonceOf,
  optStr,
  str,
} from "./check.js";
import type { AttestorSigner, EvidenceService } from "./evidence-service.js";

/**
 * HoldRecords (FR-12, FR-13, INV-10, INV-11), mirroring the escrow contract's set_hold /
 * resolve_hold. SET is accepted from the enrolled deterministic-policy service (naming the
 * versioned rule it executed) or from the separate risk/policy principal; RESOLVE only from the
 * risk/policy principal. Expiry never clears a hold: it reads EXPIRED_UNRESOLVED and keeps
 * blocking. Model output has no key and no entry point here.
 */
export const MAX_HOLD_LIFETIME_MS = 90 * 24 * 3600_000;
export const MAX_RESOLUTION_LIFETIME_MS = 24 * 3600_000;
export const RESOLUTION_CODES = ["RELEASE_HOLD", "RESOLVE_TO_REFUND", "RETRY_INSPECTION"] as const;
export type ResolutionCode = (typeof RESOLUTION_CODES)[number];
export type HoldStatus = "ACTIVE" | "EXPIRED_UNRESOLVED" | "RESOLVED";

const SOURCE = "hold-service";
const SET_FIELDS = [
  "contractId",
  "tradeId",
  "tradeRevision",
  "tradeDigest",
  "holdId",
  "manifestDigest",
  "reasonCode",
  "issuerRole",
  "ruleId",
  "schema",
  "issuedAt",
  "expiresAt",
  "nonce",
] as const;
const RESOLVE_FIELDS = [
  "contractId",
  "tradeId",
  "tradeRevision",
  "tradeDigest",
  "holdId",
  "holdReasonCode",
  "manifestDigest",
  "resolutionCode",
  "evidenceDigest",
  "resolverRole",
  "schema",
  "issuedAt",
  "expiresAt",
  "nonce",
] as const;

export interface HoldView {
  readonly id: string;
  readonly tradeId: string;
  readonly reasonCode: string;
  readonly issuerRole: "POLICY_SETTER" | "RISK_RESOLVER";
  readonly ruleId: string | null;
  readonly manifestDigest: string | null;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly status: HoldStatus;
  readonly setDigest: string;
  readonly setPayload: CanonicalValue;
  readonly setSignature: string;
  readonly resolution: {
    readonly code: string;
    readonly evidenceDigest: string;
    readonly resolvedAt: number;
    readonly digest: string;
  } | null;
}

/** A versioned deterministic rule: a pure function of the trade's evidence state. */
export interface DeterministicRule {
  readonly ruleId: string;
  readonly reasonCode: string;
  applies(state: ReturnType<typeof ruleState>): boolean;
}

function ruleState(evidence: EvidenceService, tradeId: string) {
  return {
    evaluation: evidence.evaluate(tradeId),
    inspection: evidence.currentInspection(tradeId),
    acceptedManifestDigest: evidence.currentAcceptedManifestDigest(tradeId),
  };
}

export const DETERMINISTIC_RULES: readonly DeterministicRule[] = [
  {
    ruleId: "inspection-fail@1",
    reasonCode: "INSPECTION_FAILED",
    applies: (s) => s.inspection?.decision === "FAIL",
  },
  {
    ruleId: "inspection-review@1",
    reasonCode: "INSPECTION_REVIEW_REQUIRED",
    applies: (s) => s.inspection?.decision === "REVIEW",
  },
  {
    ruleId: "evidence-stale@1",
    reasonCode: "EVIDENCE_STALE",
    applies: (s) => s.evaluation.slots.some((x) => x.status === "STALE"),
  },
];

export interface HoldDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly authority: AuthorityService;
  readonly evidence: EvidenceService;
  readonly rules?: readonly DeterministicRule[];
}

export class HoldService {
  private readonly db: Database;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly authority: AuthorityService;
  private readonly evidence: EvidenceService;
  private readonly rules: readonly DeterministicRule[];
  private readonly audit: AuditLog;
  private readonly nonces: SqliteNonceRegistry;

  constructor(deps: HoldDeps) {
    this.db = deps.db;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.authority = deps.authority;
    this.evidence = deps.evidence;
    this.rules = deps.rules ?? DETERMINISTIC_RULES;
    this.audit = new AuditLog(deps.db, deps.clock, deps.ids);
    this.nonces = new SqliteNonceRegistry(deps.db, deps.clock);
  }

  /** The deterministic-policy service SETs a hold for a rule it executed, signing in its isolated process. */
  async setByPolicy(
    tradeId: string,
    input: { ruleId: string; reasonCode: string; ttlMs: number; bindManifest?: boolean },
    signer: AttestorSigner,
  ): Promise<HoldView> {
    const terms = this.evidence.terms(tradeId);
    if (signer.publicKey !== terms.policySetter.publicKey)
      fail("KEY_NOT_BOUND", "signer is not the deterministic-policy key bound by this trade revision");
    const now = this.clock.now();
    const payload = holdSetPayload(tradeBinding(terms), {
      holdId: this.ids.next("hld"),
      manifestDigest:
        input.bindManifest === false ? null : this.evidence.currentAcceptedManifestDigest(tradeId),
      reasonCode: input.reasonCode,
      issuerRole: "POLICY_SETTER",
      ruleId: input.ruleId,
      issuedAt: now,
      expiresAt: now + input.ttlMs,
      nonce: newNonce(),
    });
    return this.recordSet(tradeId, payload, await signer.sign("HOLD_SET", payload));
  }

  /** Run every versioned rule over the evidence state; SET one hold per firing rule and manifest. */
  async applyDeterministicPolicy(
    tradeId: string,
    signer: AttestorSigner,
    ttlMs = 7 * 24 * 3600_000,
  ): Promise<HoldView[]> {
    const state = ruleState(this.evidence, tradeId);
    const out: HoldView[] = [];
    for (const rule of this.rules) {
      if (!rule.applies(state)) continue;
      const already = this.list(tradeId).some(
        (h) =>
          h.ruleId === rule.ruleId &&
          h.status !== "RESOLVED" &&
          h.manifestDigest === state.acceptedManifestDigest,
      );
      if (already) continue;
      out.push(
        await this.setByPolicy(tradeId, { ruleId: rule.ruleId, reasonCode: rule.reasonCode, ttlMs }, signer),
      );
    }
    return out;
  }

  /** Verify a signed hold SET exactly as the contract does and record it. */
  recordSet(tradeId: string, payload: CanonicalValue, signature: string): HoldView {
    const terms = this.evidence.terms(tradeId);
    const o = exact(payload, SET_FIELDS, "hold set");
    checkHeader(o, terms);
    expectStr(o, "schema", "dockside/hold-set@1", "UNSUPPORTED_VERSION");
    const now = this.clock.now();
    const { issuedAt, expiresAt } = checkWindow(o, now, MAX_HOLD_LIFETIME_MS);
    const id = str(o, "holdId");
    if (!/^hld_[0-9a-f]{32}$/.test(id)) fail("VALIDATION_FAILED", "holdId malformed");
    if (this.db.get("SELECT 1 AS x FROM hold_records WHERE id = ?", id))
      fail("INVALID_STATE", "holdId already recorded");
    const reason = str(o, "reasonCode");
    if (!isCode(reason)) fail("VALIDATION_FAILED", "reasonCode malformed");
    const manifest = optStr(o, "manifestDigest");
    if (manifest !== null) {
      if (!isHex64(manifest)) fail("VALIDATION_FAILED", "manifestDigest malformed");
      if (manifest !== this.evidence.currentAcceptedManifestDigest(tradeId))
        fail("STALE_MANIFEST", "hold binds a manifest that is not current");
    }
    const rule = optStr(o, "ruleId");
    const role = str(o, "issuerRole");
    if (role === "POLICY_SETTER") {
      if (rule === null || rule.length === 0 || rule.length > 96)
        fail("VALIDATION_FAILED", "deterministic-policy holds must name a versioned rule");
      this.authority.verifyTradeServiceSignature(terms, "policySetter", "HOLD_SET", payload, signature);
      this.requireBinding(terms, "policySetter");
    } else if (role === "RISK_RESOLVER") {
      this.authority.verifyPrincipalSignature({
        binding: terms.riskResolver,
        capability: "RISK_RESOLVER",
        purpose: "HOLD_SET",
        payload,
        signature,
      });
      this.requireBinding(terms, "riskResolver");
    } else {
      fail("FORBIDDEN", "only the deterministic-policy service or risk/policy principal may SET a hold");
    }
    const digest = digestHexFor("HOLD_SET", payload);
    try {
      this.db.transaction(() => {
        this.nonces.consume(`HOLD_SET:${tradeId}`, nonceOf(o), expiresAt);
        this.db.run(
          `INSERT INTO hold_records (id, trade_id, reason_code, issuer_role, rule_id, manifest_digest, issued_at, expires_at, set_digest, payload_json, signature, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          tradeId,
          reason,
          role,
          rule,
          manifest,
          issuedAt,
          expiresAt,
          digest,
          JSON.stringify(toTypedJson(payload)),
          signature,
          now,
        );
        this.log("HOLD_SET", id, {
          tradeId,
          reasonCode: reason,
          issuerRole: role,
          ruleId: rule,
          manifestDigest: manifest,
        });
      });
    } catch (e) {
      if (isUniqueViolation(e)) fail("INVALID_STATE", "holdId already recorded");
      throw e;
    }
    return this.get(id);
  }

  /** Verify a signed hold RESOLVE; only the bound risk/policy principal's key can pass. */
  recordResolve(tradeId: string, payload: CanonicalValue, signature: string): HoldView {
    const terms = this.evidence.terms(tradeId);
    const o = exact(payload, RESOLVE_FIELDS, "hold resolve");
    checkHeader(o, terms);
    expectStr(o, "schema", "dockside/hold-resolve@1", "UNSUPPORTED_VERSION");
    expectStr(o, "resolverRole", "RISK_RESOLVER", "FORBIDDEN");
    const now = this.clock.now();
    const { expiresAt } = checkWindow(o, now, MAX_RESOLUTION_LIFETIME_MS);
    const id = str(o, "holdId");
    const hold = this.db.get("SELECT * FROM hold_records WHERE id = ? AND trade_id = ?", id, tradeId);
    if (!hold) fail("NOT_FOUND", "hold not found");
    if (this.db.get("SELECT 1 AS x FROM hold_resolutions WHERE hold_id = ?", id))
      fail("INVALID_STATE", "hold already resolved");
    expectStr(o, "holdReasonCode", String(hold["reason_code"]), "VALIDATION_FAILED");
    if (optStr(o, "manifestDigest") !== this.evidence.currentAcceptedManifestDigest(tradeId))
      fail("STALE_MANIFEST", "resolution must bind the current manifest");
    const code = str(o, "resolutionCode");
    if (!(RESOLUTION_CODES as readonly string[]).includes(code))
      fail("VALIDATION_FAILED", "unknown resolution code");
    const evidenceDigest = str(o, "evidenceDigest");
    if (!isHex64(evidenceDigest)) fail("VALIDATION_FAILED", "evidenceDigest malformed");
    const nonce = nonceOf(o);
    this.authority.verifyPrincipalSignature({
      binding: terms.riskResolver,
      capability: "RISK_RESOLVER",
      purpose: "HOLD_RESOLVE",
      payload,
      signature,
    });
    this.requireBinding(terms, "riskResolver");
    const digest = digestHexFor("HOLD_RESOLVE", payload);
    try {
      this.db.transaction(() => {
        this.nonces.consume(`HOLD_RESOLVE:${tradeId}`, nonce, expiresAt);
        this.db.run(
          `INSERT INTO hold_resolutions (hold_id, resolver_role, resolution_code, evidence_digest, digest, payload_json, signature, resolved_at)
           VALUES (?, 'RISK_RESOLVER', ?, ?, ?, ?, ?, ?)`,
          id,
          code,
          evidenceDigest,
          digest,
          JSON.stringify(toTypedJson(payload)),
          signature,
          now,
        );
        this.log("HOLD_RESOLVED", id, { tradeId, resolutionCode: code, evidenceDigest });
      });
    } catch (e) {
      if (isUniqueViolation(e)) fail("INVALID_STATE", "hold already resolved");
      throw e;
    }
    return this.get(id);
  }

  /** A buyer can ask the risk/policy principal to review a hold; the request carries no authority. */
  requestResolution(
    ctx: AuthContext,
    input: { tradeId: string; holdId: string; note: string },
  ): { requestId: string } {
    if (!capabilityAllows("REQUEST_HOLD_RESOLUTION", ctx.capabilities))
      fail("FORBIDDEN", "only the buyer approver may request a hold review");
    const terms = this.evidence.terms(input.tradeId);
    if (ctx.principal.id !== terms.buyer.principalId) fail("FORBIDDEN", "not the buyer bound by this trade");
    const hold = this.get(input.holdId);
    if (hold.tradeId !== input.tradeId) fail("NOT_FOUND", "hold not found");
    const note = String(input.note ?? "")
      .normalize("NFC")
      .slice(0, 500);
    const id = this.ids.next("hrq");
    this.db.transaction(() => {
      this.db.run(
        "INSERT INTO hold_resolution_requests (id, hold_id, requested_by, note, created_at) VALUES (?, ?, ?, ?, ?)",
        id,
        hold.id,
        ctx.principal.id,
        note,
        this.clock.now(),
      );
      this.log("HOLD_RESOLUTION_REQUESTED", hold.id, { tradeId: input.tradeId, requestId: id }, ctx);
    });
    return { requestId: id };
  }

  get(holdId: string): HoldView {
    const r = this.db.get("SELECT * FROM hold_records WHERE id = ?", holdId);
    if (!r) fail("NOT_FOUND", "hold not found");
    const res = this.db.get("SELECT * FROM hold_resolutions WHERE hold_id = ?", holdId);
    const now = this.clock.now();
    const expiresAt = Number(r["expires_at"]);
    return {
      id: String(r["id"]),
      tradeId: String(r["trade_id"]),
      reasonCode: String(r["reason_code"]),
      issuerRole: String(r["issuer_role"]) as HoldView["issuerRole"],
      ruleId: r["rule_id"] === null ? null : String(r["rule_id"]),
      manifestDigest: r["manifest_digest"] === null ? null : String(r["manifest_digest"]),
      issuedAt: Number(r["issued_at"]),
      expiresAt,
      status: res ? "RESOLVED" : now >= expiresAt ? "EXPIRED_UNRESOLVED" : "ACTIVE",
      setDigest: String(r["set_digest"]),
      setPayload: fromTypedJson(JSON.parse(String(r["payload_json"])) as TypedJson),
      setSignature: String(r["signature"]),
      resolution: res
        ? {
            code: String(res["resolution_code"]),
            evidenceDigest: String(res["evidence_digest"]),
            resolvedAt: Number(res["resolved_at"]),
            digest: String(res["digest"]),
          }
        : null,
    };
  }

  list(tradeId: string): HoldView[] {
    return this.db
      .all("SELECT id FROM hold_records WHERE trade_id = ? ORDER BY recorded_at, rowid", tradeId)
      .map((r) => this.get(String(r["id"])));
  }

  /** ACTIVE and EXPIRED_UNRESOLVED holds both block release, funded authorization and cancellation. */
  blocking(tradeId: string): number {
    return this.list(tradeId).filter((h) => h.status !== "RESOLVED").length;
  }

  private requireBinding(terms: TradeTerms, role: string): void {
    const issue = this.authority.bindingStatus(terms).issues.find((i) => i.role === role);
    if (!issue) return;
    if (issue.code === "KEY_REVOKED")
      fail("KEY_REVOKED", `the ${role} key bound by this revision is revoked`);
    fail("KEY_NOT_BOUND", `the ${role} binding requires a new trade revision (${issue.code})`);
  }

  private log(
    eventType: string,
    holdId: string,
    payload: Record<string, string | number | boolean | null>,
    ctx?: AuthContext,
  ): void {
    this.audit.append({
      eventType,
      organizationId: ctx?.organizationId ?? null,
      actorPrincipalId: ctx?.principal.id ?? null,
      actorKeyVersionId: ctx?.keyVersion.id ?? null,
      sessionId: ctx?.session.id ?? null,
      subjectType: "hold",
      subjectId: holdId,
      correlationId: ctx?.correlationId ?? this.ids.next("cor"),
      source: SOURCE,
      payload,
    });
  }
}
