import type { AuthContext } from "@dockside/authority";
import {
  type CanonicalValue,
  type Capability,
  DocksideError,
  digestHexFor,
  fail,
  fromTypedJson,
  newNonce,
  REFUND_POLICY_ID,
  type SigningPurpose,
  type TradeTerms,
  type TypedJson,
  toTypedJson,
} from "@dockside/core";
import {
  type EscrowContract,
  type RefundReason,
  refundAuthorizePayload,
  refundDisputePayload,
  refundRequestPayload,
  refundRevokePayload,
  type SourceBucket,
  tradeBinding,
} from "@dockside/near";
import { AuditLog } from "@dockside/store";
import { z } from "zod";
import type { AppDeps } from "./app.js";
import { type Route, route } from "./routing.js";
import {
  act,
  canonical,
  loadTrade,
  mods,
  must,
  operationSummary,
  requireBound,
  type TradeModules,
} from "./trades.js";

/**
 * M10 refund surface over `dockside-refund-v1` revision 1 (REFUND-POLICY.md).
 *
 * The escrow contract is the authority: it recomputes the eligible amount and source bucket from
 * its own ledger, checks the reason row, clocks, caller and every signature, and holds the value
 * lock. The API adds the same three layers as the trade routes (PoP session, capability matrix,
 * the bound trade role with its exact key version), refuses early what the contract would refuse,
 * prepares the exact canonical payload, verifies the signer against current authority, journals
 * what it relayed (0006_refund_requests.sql) and appends an audit event. It never decides that a
 * refund is eligible: every projection here is labelled as a projection of the contract view.
 *
 * Funder returns (PARTIAL_FUNDING_RETURN, EXCESS_FUNDING_RETURN) are initiated by the original
 * funder's NEAR account itself (the contract checks the transaction signer). A trade party may ask
 * the API to prepare that call, but no Dockside session can submit it in the funder's place.
 */

export type RefundRole = "BUYER" | "SUPPLIER" | "RISK_RESOLVER";
type Ledger = Awaited<ReturnType<EscrowContract["getLedger"]>>;
type RefundRow = Awaited<ReturnType<EscrowContract["getRefunds"]>>[number];

const HOUR = 3600_000;
/** Request window; the contract allows at most seven days. Cosigning must happen inside it. */
const REQUEST_LIFETIME_MS = 24 * HOUR;
/** INSPECTION_FAIL appeal window (REFUND-POLICY.md; the contract's `CHALLENGE_48H_MS`). */
const APPEAL_WINDOW_MS = 48 * HOUR;
const SOURCE = "dockside-api";

const FUNDER_RETURNS: readonly RefundReason[] = ["PARTIAL_FUNDING_RETURN", "EXCESS_FUNDING_RETURN"];
const RECOVERY_FIRST: readonly RefundReason[] = ["BUYER_KEY_LOSS", "SUPPLIER_KEY_LOSS", "INSPECTOR_KEY_LOSS"];
/** Rows a refund request can be submitted for, in the order the UI lists them. */
const SUBMITTABLE: readonly RefundReason[] = [
  "PARTIAL_FUNDING_RETURN",
  "EXCESS_FUNDING_RETURN",
  "MUTUAL_CANCEL",
  "TRADE_EXPIRY",
  "INSPECTION_FAIL",
  "PERMANENT_HOLD",
];
const LIVE = [
  "REQUESTED",
  "TIMELOCKED",
  "AUTHORIZED",
  "EXECUTING",
  "PROCESSING",
  "UNKNOWN",
  "REVIEW",
  "RECONCILING",
  "ADJUDICATION",
];

/**
 * The signed reason matrix, served so the UI renders the policy the trade binds rather than its
 * own copy. Text follows REFUND-POLICY.md; the contract enforces it.
 */
export const REFUND_POLICY_ROWS = [
  {
    reason: "TRADE_EXPIRY",
    submit: true,
    initiator: "Designated buyer approver or supplier signer",
    signers: "The initiator only; both parties already signed the trade and policy",
    clock: "Signed tradeExpiresAt; 24-hour challenge",
    evidence: "Contract time past expiry, no submitted or unresolved release intent, funder ledger",
    challenge: "Buyer or supplier may dispute before the deadline; the refund pauses in REVIEW",
    eligible: "Unreleased, unlocked accepted deposits, each to its original funder",
    sourceBucket: "AVAILABLE, or PARTIAL when the trade is under-funded",
    revocation: "Initiator may revoke before authorization; submit ambiguity stays UNKNOWN",
  },
  {
    reason: "INSPECTION_FAIL",
    submit: true,
    initiator: "Designated buyer approver or supplier signer",
    signers: "Current inspector FAIL attestation; separate risk/policy authorization after the window",
    clock: "Attestation recorded time; 48-hour appeal window",
    evidence: "Current complete manifest, valid FAIL signature, no superseding inspection",
    challenge: "Supplier may appeal before the deadline; risk/policy may resolve to retry or refund",
    eligible: "Current milestone's unreleased, unlocked funder slices to original funders",
    sourceBucket: "AVAILABLE, or PARTIAL when the trade is under-funded",
    revocation: "Risk/policy may revoke before execution; submit ambiguity stays UNKNOWN",
  },
  {
    reason: "PERMANENT_HOLD",
    submit: true,
    initiator: "Enrolled separate risk/policy principal",
    signers: "Risk/policy resolver (RESOLVE_TO_REFUND) and the supplier signer",
    clock: "Second required signature; 48-hour cooling period",
    evidence: "Current HoldRecord, signed resolution, no later hold resolution",
    challenge: "Either required party may revoke during cooling; disagreement remains disputed",
    eligible: "Unreleased, unlocked funder slices to original funders",
    sourceBucket: "AVAILABLE, or PARTIAL when the trade is under-funded",
    revocation: "Either signer may revoke before authorization; submit ambiguity stays UNKNOWN",
  },
  {
    reason: "MUTUAL_CANCEL",
    submit: true,
    initiator: "Buyer approver or supplier signer",
    signers: "Buyer approver and supplier signer over one identical request digest",
    clock: "Second signature; 1-hour revocation period",
    evidence: "Current revision, exact eligible ledger, no submitted or unresolved release intent",
    challenge: "Either signer may revoke before the deadline; the cancellation is then void",
    eligible: "All unreleased, unlocked accepted deposits to their original funders",
    sourceBucket: "AVAILABLE, or PARTIAL when the trade is under-funded",
    revocation: "Either signer revokes before authorization; submit ambiguity stays UNKNOWN",
  },
  {
    reason: "BUYER_KEY_LOSS",
    submit: false,
    initiator: "Buyer organization recovery administrator",
    signers: "Two-of-N buyer recovery principals",
    clock: "Second recovery signature; 72-hour recovery delay",
    evidence: "Proof-of-possession failure record, affected key version, notifications",
    challenge: "Supplier may flag a dispute; risk/policy may extend or pause",
    eligible: "No automatic refund: value stays locked until key recovery, then another reason applies",
    sourceBucket: "None (no refund submit exists)",
    revocation: "Recovery can be cancelled before activation",
  },
  {
    reason: "SUPPLIER_KEY_LOSS",
    submit: false,
    initiator: "Supplier recovery principal",
    signers: "Supplier recovery policy plus buyer consent for the active revision",
    clock: "Final required signature; 72-hour recovery delay",
    evidence: "Affected key, new proof of possession, destination unchanged or a new destination revision",
    challenge: "Buyer can reject; an unresolved case remains REVIEW",
    eligible: "No automatic refund; use mutual cancel or another eligible reason",
    sourceBucket: "None (no refund submit exists)",
    revocation: "Recovery cancellation preserves the current trade",
  },
  {
    reason: "INSPECTOR_KEY_LOSS",
    submit: false,
    initiator: "Buyer or supplier",
    signers: "Buyer and supplier appoint a new independent inspector",
    clock: "Second appointment signature; 24-hour delay",
    evidence: "Affected inspector key, new inspector proof of possession",
    challenge: "Either party may reject; an unresolved case remains REVIEW",
    eligible: "No automatic refund; the prior attestation is invalid and a new inspection is required",
    sourceBucket: "None (no refund submit exists)",
    revocation: "The appointment may be revoked before activation",
  },
  {
    reason: "PARTIAL_FUNDING_RETURN",
    submit: true,
    initiator: "Original funder (its own NEAR account)",
    signers: "The original funder's transaction; no party signature",
    clock: "Request time; 1-hour cooling period",
    evidence: "Trade still below the required amount, no release intent, exact funder slice",
    challenge: "Buyer or supplier may dispute the accounting only; the recipient cannot change",
    eligible: "That funder's accepted partial amount to the same original funder",
    sourceBucket: "PARTIAL",
    revocation: "Funder may revoke before execution; the slice returns to PARTIAL",
  },
  {
    reason: "EXCESS_FUNDING_RETURN",
    submit: true,
    initiator: "Original funder (its own NEAR account)",
    signers: "The original funder's transaction; no party signature",
    clock: "Excess detection time; 1-hour cooling period",
    evidence: "Exact accepted excess beyond the trade requirement, no economic lock",
    challenge: "Buyer or risk/policy may dispute the amount; the recipient cannot change",
    eligible: "Only that funder's quarantined excess to the same original funder",
    sourceBucket: "QUARANTINED",
    revocation: "Funder may revoke before execution and the slice returns to QUARANTINED",
  },
] as const;

/* --------------------------------- schemas --------------------------------- */

const sig = z.string().min(1).max(256);
const typed = z.record(z.string(), z.unknown());
const signed = z.object({ payload: typed, signature: sig }).strict();
const empty = z.object({}).strict();
const code = z.string().regex(/^[A-Z0-9_]{1,64}$/);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const account = z.string().min(2).max(64);

/* --------------------------------- authority --------------------------------- */

/** The caller's bound refund role on this trade (capability, principal and exact key version). */
export function refundRole(ctx: AuthContext, t: TradeTerms): RefundRole {
  const p = ctx.principal.id;
  if (p === t.buyer.principalId) {
    requireBound(ctx, t.buyer, "BUYER_APPROVER", "buyer approver");
    return "BUYER";
  }
  if (p === t.supplier.principalId) {
    requireBound(ctx, t.supplier, "SUPPLIER_SIGNER", "supplier signer");
    return "SUPPLIER";
  }
  if (p === t.riskResolver.principalId) {
    requireBound(ctx, t.riskResolver, "RISK_RESOLVER", "risk/policy resolver");
    return "RISK_RESOLVER";
  }
  return fail(
    "FORBIDDEN",
    "only the trade's bound buyer approver, supplier signer or risk/policy resolver acts on refunds",
  );
}

function binding(t: TradeTerms, role: RefundRole) {
  if (role === "BUYER")
    return {
      binding: t.buyer,
      capability: "BUYER_APPROVER" as Capability,
      organizationId: t.buyer.organizationId,
    };
  if (role === "SUPPLIER")
    return {
      binding: t.supplier,
      capability: "SUPPLIER_SIGNER" as Capability,
      organizationId: t.supplier.organizationId,
    };
  return { binding: t.riskResolver, capability: "RISK_RESOLVER" as Capability, organizationId: undefined };
}

function allow(ok: boolean, message: string): void {
  if (!ok) fail("FORBIDDEN", message);
}

function inState(r: RefundRow, states: readonly string[], message: string): void {
  if (!states.includes(r.state)) fail("INVALID_STATE", `${message} (refund intent is ${r.state})`);
}

/* --------------------------------- eligibility --------------------------------- */

interface Slice {
  readonly sourceBucket: SourceBucket;
  readonly amountYocto: bigint;
}

/**
 * INSPECTION_FAIL rests on the current inspector FAIL attestation, which the contract re-checks
 * when the separate risk/policy principal authorizes after the 48-hour appeal window. An
 * inspection that expires before that window closes can never be authorized, so no slice is
 * locked for it (the policy's attestation lifetime bounds every inspection).
 */
async function inspectionFailBasis(m: TradeModules, t: TradeTerms, chainNow: number): Promise<void> {
  if (m.evidence.currentInspection(t.tradeId)?.decision !== "FAIL")
    fail("NOT_ELIGIBLE", "the current inspection is not FAIL");
  const i = (await m.escrow.getEvidence(t.tradeId)).inspection;
  if (!i || i.invalidated || i.decision !== "FAIL" || chainNow >= i.expiresAt)
    fail("NOT_ELIGIBLE", "the contract holds no current FAIL inspection");
  const closes = i.recordedAt + APPEAL_WINDOW_MS;
  if (i.expiresAt <= closes)
    fail(
      "NOT_ELIGIBLE",
      `the FAIL inspection expires at ${new Date(i.expiresAt).toISOString()}, before its 48-hour appeal window closes at ${new Date(closes).toISOString()}; the contract could never authorize this refund`,
    );
}

/**
 * The slice the contract would compute for `reason` and `funder`, refused early with the code the
 * contract uses. Never authoritative: the contract recomputes it and refuses a stale view.
 */
async function eligibleSlice(
  m: TradeModules,
  t: TradeTerms,
  reason: RefundReason,
  funder: string,
  ledger: Ledger,
  refunds: readonly RefundRow[],
  chainNow: number,
): Promise<Slice> {
  if (RECOVERY_FIRST.includes(reason))
    fail("NO_REFUND_SUBMIT", "key-loss rows are recovery-first and authorize no refund");
  if (m.journal.journal.frozen(t.tradeId).length > 0)
    fail("TRADE_FROZEN", "trade is frozen by a reconciliation incident");
  m.release.assertNoUnresolvedRelease(t.tradeId);
  const f = ledger.funders[funder];
  if (!f) return fail("NOTHING_ELIGIBLE", "no native deposit from this funder");
  const reserved = Object.values(ledger.funders).some((x) => x.reserved > 0n);
  let slice: Slice;
  switch (reason) {
    case "PARTIAL_FUNDING_RETURN":
      if (ledger.fullyFunded) fail("NOT_ELIGIBLE", "trade is fully funded; partial return no longer applies");
      if (f.partial === 0n) fail("NOTHING_ELIGIBLE", "funder has no partial funding");
      slice = { sourceBucket: "PARTIAL", amountYocto: f.partial };
      break;
    case "EXCESS_FUNDING_RETURN":
      if (f.quarantined === 0n) fail("NOTHING_ELIGIBLE", "funder has no quarantined excess");
      slice = { sourceBucket: "QUARANTINED", amountYocto: f.quarantined };
      break;
    default: {
      // The contract compares the signed tradeExpiresAt with its own clock, not this process's.
      if (reason === "TRADE_EXPIRY" && chainNow < t.expiresAt)
        fail("NOT_ELIGIBLE", "trade has not expired on the contract clock");
      if (reason === "INSPECTION_FAIL") await inspectionFailBasis(m, t, chainNow);
      if (reason === "PERMANENT_HOLD") {
        const resolved = m.holds
          .list(t.tradeId)
          .filter((h) => h.resolution !== null)
          .sort(
            (a, b) =>
              (a.resolution?.resolvedAt ?? 0) - (b.resolution?.resolvedAt ?? 0) || a.id.localeCompare(b.id),
          );
        if (resolved.at(-1)?.resolution?.code !== "RESOLVE_TO_REFUND")
          fail("NOT_ELIGIBLE", "the latest hold resolution is not RESOLVE_TO_REFUND");
        if (m.holds.blocking(t.tradeId) > 0)
          fail("HOLD_ACTIVE", "another hold is ACTIVE or EXPIRED_UNRESOLVED");
      }
      if (reserved) fail("VALUE_LOCKED", "a release intent holds value");
      if (f.available > 0n) slice = { sourceBucket: "AVAILABLE", amountYocto: f.available };
      else if (f.partial > 0n) slice = { sourceBucket: "PARTIAL", amountYocto: f.partial };
      else return fail("NOTHING_ELIGIBLE", "funder has no unreleased, unlocked accepted value");
    }
  }
  if (
    refunds.some(
      (r) => LIVE.includes(r.state) && r.funder === funder && r.sourceBucket === slice.sourceBucket,
    )
  )
    fail("VALUE_LOCKED", "a live refund intent already locks this funder slice");
  return slice;
}

/* --------------------------------- journal --------------------------------- */

interface StoredRequest {
  readonly refundIntentId: string;
  readonly tradeId: string;
  readonly reason: RefundReason;
  readonly funder: string;
  readonly initiatorRole: string;
  readonly typed: TypedJson;
  readonly digest: string;
  readonly expiresAt: number;
}

function stored(d: AppDeps, tradeId: string, refundIntentId: string): StoredRequest | null {
  const r = d.db.get("SELECT * FROM refund_requests WHERE refund_intent_id = ?", refundIntentId);
  if (!r || String(r["trade_id"]) !== tradeId) return null;
  return {
    refundIntentId,
    tradeId,
    reason: String(r["reason"]) as RefundReason,
    funder: String(r["funder"]),
    initiatorRole: String(r["initiator_role"]),
    typed: JSON.parse(String(r["request_json"])) as TypedJson,
    digest: String(r["request_digest"]),
    expiresAt: Number(r["expires_at"]),
  };
}

function recordSignature(
  d: AppDeps,
  t: TradeTerms,
  refundIntentId: string,
  kind: "REQUEST" | "COSIGN" | "REVOKE" | "DISPUTE" | "AUTHORIZE",
  role: RefundRole,
  verified: { principalId: string; keyVersionId: string },
  purpose: SigningPurpose,
  payload: CanonicalValue,
  signature: string,
): void {
  d.db.run(
    `INSERT INTO refund_signatures (id, refund_intent_id, trade_id, kind, signer_role, signer_principal, key_version_id, digest, payload_json, signature, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    d.ids.next("rfs"),
    refundIntentId,
    t.tradeId,
    kind,
    role,
    verified.principalId,
    verified.keyVersionId,
    digestHexFor(purpose, payload),
    JSON.stringify(toTypedJson(payload)),
    signature,
    d.clock.now(),
  );
}

async function contractRefund(m: TradeModules, t: TradeTerms, refundIntentId: string): Promise<RefundRow> {
  const r = (await m.escrow.getRefunds(t.tradeId)).find((x) => x.refundIntentId === refundIntentId);
  if (!r) return fail("NOT_FOUND", "refund intent not found on the contract");
  return r;
}

function field(p: CanonicalValue, k: string): CanonicalValue | undefined {
  return (p as Record<string, CanonicalValue>)[k];
}

/* --------------------------------- per-row rules --------------------------------- */

/** Who may revoke, and in which states (mirrors the contract's `revoke_refund`). */
function revocationRule(r: RefundRow, role: RefundRole): "FUNDER" | RefundRole {
  switch (r.reason) {
    case "PARTIAL_FUNDING_RETURN":
    case "EXCESS_FUNDING_RETURN":
      // The funder's own transaction revokes; a party only prepares the call for the funder.
      allow(role === "BUYER" || role === "SUPPLIER", "a trade party prepares the funder's revocation");
      inState(r, ["REQUESTED", "TIMELOCKED", "AUTHORIZED"], "revocation is allowed only before execution");
      return "FUNDER";
    case "TRADE_EXPIRY":
      allow(role === r.initiatorRole, "only the initiator may revoke a trade-expiry refund");
      inState(r, ["REQUESTED", "TIMELOCKED"], "revocation is allowed only before authorization");
      return role;
    case "MUTUAL_CANCEL":
      allow(role === "BUYER" || role === "SUPPLIER", "only a signer may revoke a cancellation");
      inState(r, ["REQUESTED", "TIMELOCKED"], "revocation is allowed only before authorization");
      return role;
    case "INSPECTION_FAIL":
      allow(role === "RISK_RESOLVER", "only the risk/policy resolver may revoke an inspection-fail refund");
      inState(
        r,
        ["REQUESTED", "TIMELOCKED", "AUTHORIZED", "REVIEW"],
        "revocation is allowed only before execution",
      );
      return role;
    case "PERMANENT_HOLD":
      allow(role === "RISK_RESOLVER" || role === "SUPPLIER", "only a required signer may revoke");
      inState(r, ["REQUESTED", "TIMELOCKED"], "revocation is allowed only during cooling");
      return role;
    default:
      return fail("INVALID_STATE", "this refund intent cannot be revoked");
  }
}

/** Who may dispute (mirrors the contract's `dispute_refund`). */
function disputeRule(r: RefundRow, role: RefundRole): void {
  const allowed: Record<string, readonly RefundRole[]> = {
    TRADE_EXPIRY: ["BUYER", "SUPPLIER"],
    INSPECTION_FAIL: ["SUPPLIER"],
    PARTIAL_FUNDING_RETURN: ["BUYER", "SUPPLIER"],
    EXCESS_FUNDING_RETURN: ["BUYER", "RISK_RESOLVER"],
  };
  const roles = allowed[r.reason];
  if (!roles) fail("DISPUTE_NOT_ALLOWED", "this row has no challenge path; signers revoke instead");
  allow(roles.includes(role), "this role may not dispute this refund");
  inState(r, ["TIMELOCKED", "AUTHORIZED"], "dispute is allowed only before execution");
}

/** The second consent a row takes (MUTUAL_CANCEL: the other party; PERMANENT_HOLD: the supplier). */
function cosignRule(r: RefundRow, role: RefundRole): "BUYER" | "SUPPLIER" {
  inState(r, ["REQUESTED"], "the intent is not awaiting a second consent");
  if (r.reason === "MUTUAL_CANCEL") {
    if (role === "BUYER" && !r.buyerSigned) return "BUYER";
    if (role === "SUPPLIER" && !r.supplierSigned) return "SUPPLIER";
    return fail("INVALID_STATE", "that party has already consented or holds no consent for this row");
  }
  if (r.reason === "PERMANENT_HOLD") {
    allow(role === "SUPPLIER", "only the supplier signer consents to a permanent-hold refund");
    if (r.supplierSigned) fail("INVALID_STATE", "the supplier has already consented");
    return "SUPPLIER";
  }
  return fail("INVALID_STATE", "this row takes no second consent");
}

/* --------------------------------- routes --------------------------------- */

export function refundRoutes(d: AppDeps): Route[] {
  const r = route;
  const log = (
    ctx: AuthContext,
    eventType: string,
    t: TradeTerms,
    refundIntentId: string,
    extra: Record<string, string> = {},
  ) =>
    new AuditLog(d.db, d.clock, d.ids).append({
      eventType,
      organizationId: ctx.organizationId,
      actorPrincipalId: ctx.principal.id,
      actorKeyVersionId: ctx.keyVersion.id,
      sessionId: ctx.session.id,
      subjectType: "refund_intent",
      subjectId: refundIntentId,
      correlationId: ctx.correlationId,
      source: SOURCE,
      payload: { tradeId: t.tradeId, ...extra },
    });
  const verify = (
    t: TradeTerms,
    role: RefundRole,
    purpose: SigningPurpose,
    payload: CanonicalValue,
    s: string,
  ) => {
    const b = binding(t, role);
    return d.authority.verifyPrincipalSignature({
      binding: b.binding,
      capability: b.capability,
      purpose,
      payload,
      signature: s,
      ...(b.organizationId === undefined ? {} : { organizationId: b.organizationId }),
    });
  };
  /** Common entry for routes on one refund intent: session, capability, trade relation, bound role. */
  const entry = (ctx: AuthContext | null, params: Record<string, string>) => {
    const c = must(ctx);
    act(c, "SIGN_REFUND_REQUEST");
    const m = mods(d);
    const t = loadTrade(m, c, params["id"] as string);
    const role = refundRole(c, t);
    return { c, m, t, role, rid: params["rid"] as string };
  };
  const base = "/v1/trades/:id/refunds/:rid";

  return [
    /** Contract view of deposits and refund intents, the signed policy and per-funder projections. */
    r("GET", "/v1/trades/:id/refund", true, undefined, async ({ ctx, params }) => {
      const c = must(ctx);
      const m = mods(d);
      const t = loadTrade(m, c, params["id"] as string);
      const refunds = await m.escrow.getRefunds(t.tradeId);
      const ledger = await m.escrow.getLedger(t.tradeId);
      const chainNow = await m.chain.blockTimeMs();
      const candidates = [];
      for (const funder of Object.keys(ledger.funders))
        for (const reason of SUBMITTABLE) {
          try {
            const s = await eligibleSlice(m, t, reason, funder, ledger, refunds, chainNow);
            candidates.push({ funder, reason, ...s, blockedBy: null, blockedReason: null });
          } catch (e) {
            if (!(e instanceof DocksideError)) throw e;
            candidates.push({
              funder,
              reason,
              sourceBucket: null,
              amountYocto: null,
              blockedBy: e.code,
              blockedReason: e.message,
            });
          }
        }
      let viewerRole: RefundRole | null = null;
      try {
        viewerRole = refundRole(c, t);
      } catch (e) {
        if (!(e instanceof DocksideError)) throw e;
      }
      return {
        tradeId: t.tradeId,
        policy: { id: REFUND_POLICY_ID, revision: 1, rows: REFUND_POLICY_ROWS },
        refunds: refunds.map((x) => {
          const s = stored(d, t.tradeId, x.refundIntentId);
          return {
            ...x,
            payloadJournaled: s !== null && s.digest === x.requestDigest,
            funderWalletRequired: FUNDER_RETURNS.includes(x.reason as RefundReason),
          };
        }),
        ledger,
        candidates,
        candidateSource:
          "projection of the escrow contract ledger; the contract recomputes and refuses a stale view",
        viewerRole,
        operations: operationSummary(m, t.tradeId).filter((o) => o.kind === "REFUND"),
        source: "escrow-contract-view",
        observedAt: d.clock.now(),
        // The clock deadlines and windows are judged by on the contract (latest final block).
        chainTimeMs: chainNow,
      };
    }),

    /** Prepare the exact refund request for one funder slice under one reason. */
    r(
      "POST",
      "/v1/trades/:id/refund-challenges",
      true,
      z.object({ reason: z.string().max(64), funder: account }).strict(),
      async ({ ctx, params, body }) => {
        const c = must(ctx);
        act(c, "SIGN_REFUND_REQUEST");
        const m = mods(d);
        const t = loadTrade(m, c, params["id"] as string);
        const role = refundRole(c, t);
        const b = body as { reason: string; funder: string };
        const reasons = [...SUBMITTABLE, ...RECOVERY_FIRST] as readonly string[];
        if (!reasons.includes(b.reason)) fail("VALIDATION_FAILED", "unknown refund reason");
        const reason = b.reason as RefundReason;
        if (RECOVERY_FIRST.includes(reason))
          fail("NO_REFUND_SUBMIT", "key-loss rows are recovery-first and authorize no refund");
        let initiatorRole: "BUYER" | "SUPPLIER" | "FUNDER" | "RISK_RESOLVER";
        if (FUNDER_RETURNS.includes(reason)) {
          allow(role === "BUYER" || role === "SUPPLIER", "a trade party prepares a funder return");
          initiatorRole = "FUNDER";
        } else if (reason === "PERMANENT_HOLD") {
          allow(role === "RISK_RESOLVER", "only the separate risk/policy principal initiates this refund");
          initiatorRole = "RISK_RESOLVER";
        } else {
          allow(
            role === "BUYER" || role === "SUPPLIER",
            "only the buyer approver or supplier signer initiates",
          );
          initiatorRole = role;
        }
        const ledger = await m.escrow.getLedger(t.tradeId);
        const refunds = await m.escrow.getRefunds(t.tradeId);
        const chainNow = await m.chain.blockTimeMs();
        const slice = await eligibleSlice(m, t, reason, b.funder, ledger, refunds, chainNow);
        const refundIntentId = d.ids.next("rfd");
        // The contract checks this window against its own clock, so it is anchored there.
        const now = chainNow;
        const payload = refundRequestPayload(tradeBinding(t), {
          refundIntentId,
          reason,
          funder: b.funder,
          amountYocto: slice.amountYocto,
          sourceBucket: slice.sourceBucket,
          initiatorRole,
          issuedAt: now,
          expiresAt: now + REQUEST_LIFETIME_MS,
          nonce: newNonce(),
        });
        const digest = digestHexFor("REFUND_REQUEST", payload);
        const tj = toTypedJson(payload);
        d.db.run(
          `INSERT INTO refund_requests (refund_intent_id, trade_id, trade_revision, reason, funder, amount_yocto, source_bucket,
             initiator_role, request_json, request_digest, prepared_by, prepared_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          refundIntentId,
          t.tradeId,
          t.revision,
          reason,
          b.funder,
          slice.amountYocto.toString(10),
          slice.sourceBucket,
          initiatorRole,
          JSON.stringify(tj),
          digest,
          c.principal.id,
          d.clock.now(),
          now + REQUEST_LIFETIME_MS,
        );
        log(c, "REFUND_REQUEST_PREPARED", t, refundIntentId, { reason, sourceBucket: slice.sourceBucket });
        const out = {
          refundIntentId,
          reason,
          funder: b.funder,
          amountYocto: slice.amountYocto,
          sourceBucket: slice.sourceBucket,
          initiatorRole,
          purpose: "REFUND_REQUEST",
          payload: tj,
          digest,
        };
        if (initiatorRole === "FUNDER")
          return {
            ...out,
            // Only the original funder's own account can submit this; the contract checks the caller.
            funderWallet: { signerId: b.funder, call: m.escrow.requestRefundCall(t.tradeId, tj) },
          };
        return out;
      },
    ),

    /** Verify the initiator's signature over the journaled request and return the contract call. */
    r(
      "POST",
      `${base}/request-signature`,
      true,
      z.object({ signature: sig }).strict(),
      async ({ ctx, params, body }) => {
        const { c, m, t, role, rid } = entry(ctx, params);
        const s = stored(d, t.tradeId, rid);
        if (!s) return fail("NOT_FOUND", "no refund request was prepared with this id for this trade");
        if (s.initiatorRole === "FUNDER")
          fail("FORBIDDEN", "a funder return is submitted by the funder's own account, not a session");
        allow(s.initiatorRole === role, `the request names ${s.initiatorRole} as initiator`);
        if ((await m.chain.blockTimeMs()) >= s.expiresAt)
          fail("INVALID_STATE", "the prepared request expired on the contract clock; prepare a new one");
        const payload = fromTypedJson(s.typed);
        const signature = (body as { signature: string }).signature;
        const v = verify(t, role, "REFUND_REQUEST", payload, signature);
        recordSignature(d, t, rid, "REQUEST", role, v, "REFUND_REQUEST", payload, signature);
        log(c, "REFUND_REQUEST_SIGNED", t, rid, { reason: s.reason, role });
        const sigs =
          role === "BUYER"
            ? { buyer: signature }
            : role === "SUPPLIER"
              ? { supplier: signature }
              : { risk: signature };
        return { relay: m.escrow.requestRefundCall(t.tradeId, s.typed, sigs) };
      },
    ),

    /** The exact journaled request for the second consent (MUTUAL_CANCEL, PERMANENT_HOLD). */
    r("POST", `${base}/cosign-challenges`, true, empty, async ({ ctx, params }) => {
      const { m, t, role, rid } = entry(ctx, params);
      const rf = await contractRefund(m, t, rid);
      cosignRule(rf, role);
      const s = stored(d, t.tradeId, rid);
      if (!s || s.digest !== rf.requestDigest)
        return fail("NOT_FOUND", "the request payload for this digest is not journaled by this API");
      return {
        purpose: "REFUND_REQUEST",
        payload: s.typed,
        digest: s.digest,
        requestDigest: rf.requestDigest,
      };
    }),
    r(
      "POST",
      `${base}/cosignature`,
      true,
      z.object({ signature: sig }).strict(),
      async ({ ctx, params, body }) => {
        const { c, m, t, role, rid } = entry(ctx, params);
        const rf = await contractRefund(m, t, rid);
        const as = cosignRule(rf, role);
        m.release.assertNoUnresolvedRelease(t.tradeId);
        const s = stored(d, t.tradeId, rid);
        if (!s || s.digest !== rf.requestDigest)
          return fail("NOT_FOUND", "the request payload for this digest is not journaled by this API");
        const payload = fromTypedJson(s.typed);
        const signature = (body as { signature: string }).signature;
        const v = verify(t, role, "REFUND_REQUEST", payload, signature);
        recordSignature(d, t, rid, "COSIGN", role, v, "REFUND_REQUEST", payload, signature);
        log(c, "REFUND_COSIGNED", t, rid, { reason: rf.reason, role });
        return { relay: m.escrow.cosignRefundCall(t.tradeId, rid, as, signature) };
      },
    ),

    /** Revocation before execution; funder returns get the funder's own unsigned call. */
    r("POST", `${base}/revocation-challenges`, true, empty, async ({ ctx, params }) => {
      const { c, m, t, role, rid } = entry(ctx, params);
      const rf = await contractRefund(m, t, rid);
      const revokerRole = revocationRule(rf, role);
      const now = await m.chain.blockTimeMs();
      const payload = refundRevokePayload(tradeBinding(t), {
        refundIntentId: rid,
        requestDigest: rf.requestDigest,
        revokerRole,
        issuedAt: now,
        expiresAt: now + HOUR,
        nonce: newNonce(),
      });
      const tj = toTypedJson(payload);
      const out = {
        purpose: "REFUND_REVOKE",
        payload: tj,
        digest: digestHexFor("REFUND_REVOKE", payload),
        revokerRole,
        sourceBucket: rf.sourceBucket,
      };
      if (revokerRole === "FUNDER") {
        log(c, "REFUND_REVOCATION_PREPARED", t, rid, { reason: rf.reason });
        return {
          ...out,
          funderWallet: { signerId: rf.funder, call: m.escrow.revokeRefundCall(t.tradeId, tj, null) },
        };
      }
      return out;
    }),
    r("POST", `${base}/revocation`, true, signed, async ({ ctx, params, body }) => {
      const { c, m, t, role, rid } = entry(ctx, params);
      const rf = await contractRefund(m, t, rid);
      const revokerRole = revocationRule(rf, role);
      if (revokerRole === "FUNDER")
        fail("FORBIDDEN", "a funder return is revoked by the funder's own account, not a session");
      const b = body as { payload: unknown; signature: string };
      const payload = canonical(b.payload);
      if (field(payload, "refundIntentId") !== rid || field(payload, "tradeId") !== t.tradeId)
        fail("VALIDATION_FAILED", "revocation names a different refund intent");
      if (field(payload, "revokerRole") !== revokerRole)
        fail("FORBIDDEN", "a signer revokes only in its own role");
      if (field(payload, "requestDigest") !== rf.requestDigest)
        fail("VALIDATION_FAILED", "revocation names a different request digest");
      const v = verify(t, role, "REFUND_REVOKE", payload, b.signature);
      recordSignature(d, t, rid, "REVOKE", role, v, "REFUND_REVOKE", payload, b.signature);
      log(c, "REFUND_REVOCATION_SIGNED", t, rid, { reason: rf.reason, role });
      return { relay: m.escrow.revokeRefundCall(t.tradeId, toTypedJson(payload), b.signature) };
    }),

    /** Challenge or appeal before execution; the refund pauses in REVIEW on the contract. */
    r(
      "POST",
      `${base}/dispute-challenges`,
      true,
      z.object({ reasonCode: code, evidenceDigest: hex64 }).strict(),
      async ({ ctx, params, body }) => {
        const { m, t, role, rid } = entry(ctx, params);
        const rf = await contractRefund(m, t, rid);
        disputeRule(rf, role);
        const b = body as { reasonCode: string; evidenceDigest: string };
        const now = await m.chain.blockTimeMs();
        const payload = refundDisputePayload(tradeBinding(t), {
          refundIntentId: rid,
          requestDigest: rf.requestDigest,
          disputantRole: role,
          reasonCode: b.reasonCode,
          evidenceDigest: b.evidenceDigest,
          issuedAt: now,
          expiresAt: now + HOUR,
          nonce: newNonce(),
        });
        return {
          purpose: "REFUND_DISPUTE",
          payload: toTypedJson(payload),
          digest: digestHexFor("REFUND_DISPUTE", payload),
        };
      },
    ),
    r("POST", `${base}/dispute`, true, signed, async ({ ctx, params, body }) => {
      const { c, m, t, role, rid } = entry(ctx, params);
      const rf = await contractRefund(m, t, rid);
      disputeRule(rf, role);
      const b = body as { payload: unknown; signature: string };
      const payload = canonical(b.payload);
      if (field(payload, "refundIntentId") !== rid || field(payload, "tradeId") !== t.tradeId)
        fail("VALIDATION_FAILED", "dispute names a different refund intent");
      if (field(payload, "disputantRole") !== role)
        fail("FORBIDDEN", "a party disputes only in its own role");
      const v = verify(t, role, "REFUND_DISPUTE", payload, b.signature);
      recordSignature(d, t, rid, "DISPUTE", role, v, "REFUND_DISPUTE", payload, b.signature);
      log(c, "REFUND_DISPUTE_SIGNED", t, rid, { reason: rf.reason, role });
      return { relay: m.escrow.disputeRefundCall(t.tradeId, toTypedJson(payload), b.signature) };
    }),

    /**
     * Permissionless authorization relay once the timelock passed. The contract checks its own
     * clock, the deadline, disputes, holds and the economic lock; the API does not pre-judge time.
     */
    r("POST", `${base}/authorization`, true, empty, async ({ ctx, params }) => {
      const { c, m, t, rid } = entry(ctx, params);
      const rf = await contractRefund(m, t, rid);
      if (rf.reason === "INSPECTION_FAIL")
        fail("FORBIDDEN", "an inspection-fail refund needs the separate risk/policy signed authorization");
      inState(rf, ["TIMELOCKED"], "only a timelocked intent can be authorized");
      if (rf.dispute) fail("INVALID_STATE", "a disputed refund stays in REVIEW");
      m.release.assertNoUnresolvedRelease(t.tradeId);
      log(c, "REFUND_AUTHORIZATION_RELAYED", t, rid, { reason: rf.reason });
      return { relay: m.escrow.authorizeRefundCall(t.tradeId, rid) };
    }),
    r("POST", `${base}/authorization-challenges`, true, empty, async ({ ctx, params }) => {
      const { m, t, role, rid } = entry(ctx, params);
      allow(role === "RISK_RESOLVER", "only the risk/policy resolver authorizes an inspection-fail refund");
      const rf = await contractRefund(m, t, rid);
      if (rf.reason !== "INSPECTION_FAIL")
        fail("INVALID_STATE", "only INSPECTION_FAIL takes a signed authorization");
      inState(rf, ["TIMELOCKED"], "only a timelocked intent can be authorized");
      const now = await m.chain.blockTimeMs();
      const payload = refundAuthorizePayload(tradeBinding(t), {
        refundIntentId: rid,
        requestDigest: rf.requestDigest,
        issuedAt: now,
        expiresAt: now + HOUR,
        nonce: newNonce(),
      });
      return {
        purpose: "REFUND_AUTHORIZE",
        payload: toTypedJson(payload),
        digest: digestHexFor("REFUND_AUTHORIZE", payload),
      };
    }),
    r("POST", `${base}/authorization-signature`, true, signed, async ({ ctx, params, body }) => {
      const { c, m, t, role, rid } = entry(ctx, params);
      allow(role === "RISK_RESOLVER", "only the risk/policy resolver authorizes an inspection-fail refund");
      const rf = await contractRefund(m, t, rid);
      if (rf.reason !== "INSPECTION_FAIL")
        fail("INVALID_STATE", "only INSPECTION_FAIL takes a signed authorization");
      const b = body as { payload: unknown; signature: string };
      const payload = canonical(b.payload);
      if (field(payload, "refundIntentId") !== rid || field(payload, "tradeId") !== t.tradeId)
        fail("VALIDATION_FAILED", "authorization names a different refund intent");
      const v = verify(t, role, "REFUND_AUTHORIZE", payload, b.signature);
      recordSignature(d, t, rid, "AUTHORIZE", role, v, "REFUND_AUTHORIZE", payload, b.signature);
      log(c, "REFUND_AUTHORIZATION_SIGNED", t, rid, { reason: rf.reason });
      return { relay: m.escrow.authorizeRefundSignedCall(t.tradeId, toTypedJson(payload), b.signature) };
    }),

    /** Queue the AUTHORIZED refund in the economic-operation journal (one operation, one submit). */
    r("POST", `${base}/execute`, true, empty, async ({ ctx, params }) => {
      const { c, m, t, rid } = entry(ctx, params);
      const out = await m.journal.enqueueRefund(t.tradeId, rid);
      log(c, "REFUND_EXECUTION_REQUESTED", t, rid, { operationId: out.operationId });
      return { ...out, state: m.journal.journal.op(out.operationId).state };
    }),
  ];
}
