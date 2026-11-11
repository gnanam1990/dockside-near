import type { AuthContext, AuthorityService } from "@dockside/authority";
import {
  type AuthorityAction,
  type CanonicalValue,
  type Capability,
  capabilityAllows,
  DocksideError,
  digestHexFor,
  fail,
  fromTypedJson,
  newNonce,
  type TradeTerms,
  type TypedJson,
  toTypedJson,
  tradeRevisionDigest,
  tradeTermsCanonical,
  tradeTermsFromJson,
  tradeTermsToJson,
  verifyFor,
} from "@dockside/core";
import {
  type EvidenceService,
  type HoldService,
  type HoldView,
  inspectionPayload,
  parseEvidencePolicy,
  policyCanonical,
  RESOLUTION_CODES,
} from "@dockside/evidence";
import type { JournalService } from "@dockside/journal";
import {
  type EscrowContract,
  type FunctionCall,
  holdResolvePayload,
  holdSetPayload,
  termsArg,
  tradeBinding,
} from "@dockside/near";
import type { ReleaseService } from "@dockside/release";
import { AuditLog } from "@dockside/store";
import { z } from "zod";
import type { AppDeps } from "./app.js";
import { type Route, route } from "./routing.js";
import { buildAuditExport } from "./export.js";

/**
 * M07 trade surface: every route reads persisted service state and chain observations and
 * delegates authority to the services and the contract. The API adds three layers and never
 * removes one: (1) an authenticated PoP session, (2) the capability matrix in @dockside/core,
 * (3) the trade relation recomputed from the bound terms. A principal with no relation to a trade
 * gets the same NOT_FOUND as for a trade that does not exist (no enumeration). Mutations return
 * the exact relay call for the contract, which re-verifies every signature and predicate.
 */
export interface TradeModules {
  readonly evidence: EvidenceService;
  readonly holds: HoldService;
  readonly release: ReleaseService;
  readonly journal: JournalService;
  readonly escrow: EscrowContract;
}

/** Upload bodies carry base64 content; their limit is set per route (still bounded). */
export const MAX_UPLOAD_BODY_BYTES = 1024 * 1024;

type Relation = "BUYER" | "SUPPLIER" | "INSPECTOR" | "RISK_RESOLVER" | "BUYER_ORG" | "SUPPLIER_ORG";

const SOURCE = "dockside-api";

/* --------------------------------- schemas --------------------------------- */

const sig = z.string().min(1).max(256);
const typed = z.record(z.string(), z.unknown());
const signed = z.object({ payload: typed, signature: sig }).strict();
const empty = z.object({}).strict();
const code = z.string().regex(/^[A-Z0-9_]{1,64}$/);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

function canonical(t: unknown): CanonicalValue {
  try {
    return fromTypedJson(t as TypedJson);
  } catch (e) {
    if (e instanceof DocksideError) throw e;
    return fail("VALIDATION_FAILED", "payload is not typed canonical JSON");
  }
}

function call(c: FunctionCall) {
  return { relay: c };
}

/* --------------------------------- access ---------------------------------- */

function mods(d: AppDeps): TradeModules {
  if (!d.modules) fail("NOT_FOUND", "no such endpoint", { reason: "TRADE_MODULES_NOT_CONFIGURED" });
  return d.modules;
}

function must(ctx: AuthContext | null): AuthContext {
  if (!ctx) fail("UNAUTHENTICATED", "authentication required");
  return ctx;
}

export function relationsOf(ctx: AuthContext, t: TradeTerms): Relation[] {
  const out: Relation[] = [];
  const p = ctx.principal.id;
  if (p === t.buyer.principalId) out.push("BUYER");
  if (p === t.supplier.principalId) out.push("SUPPLIER");
  if (p === t.inspector.principalId) out.push("INSPECTOR");
  if (p === t.riskResolver.principalId) out.push("RISK_RESOLVER");
  if (ctx.organizationId === t.buyer.organizationId) out.push("BUYER_ORG");
  if (ctx.organizationId === t.supplier.organizationId) out.push("SUPPLIER_ORG");
  return out;
}

/** Same answer for "no such trade" and "not yours": the existence of a trade is not disclosed. */
function loadTrade(m: TradeModules, ctx: AuthContext, tradeId: string): TradeTerms {
  let terms: TradeTerms;
  try {
    terms = m.evidence.terms(tradeId);
  } catch (e) {
    if (e instanceof DocksideError && (e.code === "NOT_FOUND" || e.code === "VALIDATION_FAILED"))
      fail("NOT_FOUND", "trade not found");
    throw e;
  }
  if (relationsOf(ctx, terms).length === 0) fail("NOT_FOUND", "trade not found");
  return terms;
}

/** Reconciliation/adjudication requests and freezes need the risk/policy capability (M05 journal rule). */
function riskOperator(ctx: AuthContext): void {
  if (!ctx.capabilities.includes("RISK_RESOLVER"))
    fail("FORBIDDEN", "reconciliation and adjudication requests need the risk/policy capability");
}

function act(ctx: AuthContext, action: AuthorityAction): void {
  if (!capabilityAllows(action, ctx.capabilities)) fail("FORBIDDEN", `capability required for ${action}`);
}

/** The bound human for a trade role: capability, principal and exact key version. */
function requireBound(
  ctx: AuthContext,
  binding: { principalId: string; keyVersionId: string },
  capability: Capability,
  label: string,
): void {
  if (!ctx.capabilities.includes(capability)) fail("FORBIDDEN", `${capability} required`);
  if (ctx.principal.id !== binding.principalId)
    fail("FORBIDDEN", `session principal is not the ${label} this revision binds`);
  if (ctx.keyVersion.id !== binding.keyVersionId)
    fail("KEY_NOT_BOUND", `session key is not the ${label} key version this revision binds`);
}

/** CANCEL/ABANDON: the designated buyer approver or supplier signer, checked before any state. */
function requireExitParty(ctx: AuthContext, t: TradeTerms): void {
  if (ctx.principal.id === t.buyer.principalId)
    requireBound(ctx, t.buyer, "BUYER_APPROVER", "buyer approver");
  else if (ctx.principal.id === t.supplier.principalId)
    requireBound(ctx, t.supplier, "SUPPLIER_SIGNER", "supplier signer");
  else fail("FORBIDDEN", "only the designated buyer approver or supplier signer");
}

function holdTrade(m: TradeModules, ctx: AuthContext, holdId: string): { hold: HoldView; terms: TradeTerms } {
  let hold: HoldView;
  try {
    hold = m.holds.get(holdId);
  } catch (e) {
    if (e instanceof DocksideError && e.code === "NOT_FOUND") fail("NOT_FOUND", "hold not found");
    throw e;
  }
  try {
    return { hold, terms: loadTrade(m, ctx, hold.tradeId) };
  } catch (e) {
    if (e instanceof DocksideError && e.code === "NOT_FOUND") fail("NOT_FOUND", "hold not found");
    throw e;
  }
}

function intentTrade(m: TradeModules, ctx: AuthContext, intentId: string): TradeTerms {
  try {
    return loadTrade(m, ctx, m.release.intent(intentId).tradeId);
  } catch (e) {
    if (e instanceof DocksideError && e.code === "NOT_FOUND") fail("NOT_FOUND", "release intent not found");
    throw e;
  }
}

function operationTrade(m: TradeModules, ctx: AuthContext, operationId: string): TradeTerms {
  try {
    return loadTrade(m, ctx, m.journal.journal.op(operationId).tradeId);
  } catch (e) {
    if (e instanceof DocksideError && e.code === "NOT_FOUND") fail("NOT_FOUND", "operation not found");
    throw e;
  }
}

function tradeIds(d: AppDeps): string[] {
  return d.db
    .all("SELECT trade_id FROM evidence_trades ORDER BY bound_at, trade_id")
    .map((r) => String(r["trade_id"]));
}

function accessibleTrades(d: AppDeps, m: TradeModules, ctx: AuthContext): TradeTerms[] {
  const out: TradeTerms[] = [];
  for (const id of tradeIds(d)) {
    const t = m.evidence.terms(id);
    if (relationsOf(ctx, t).length) out.push(t);
  }
  return out;
}

/* ------------------------------- projections ------------------------------- */

function holdSummary(h: HoldView) {
  return {
    holdId: h.id,
    tradeId: h.tradeId,
    status: h.status,
    reasonCode: h.reasonCode,
    issuerRole: h.issuerRole,
    ruleId: h.ruleId,
    manifestDigest: h.manifestDigest,
    issuedAt: h.issuedAt,
    expiresAt: h.expiresAt,
    setDigest: h.setDigest,
    resolution: h.resolution,
  };
}

function termsSummary(t: TradeTerms) {
  return {
    tradeId: t.tradeId,
    revision: t.revision,
    termsDigest: tradeRevisionDigest(t),
    network: t.network,
    escrowContractId: t.escrowContractId,
    asset: t.asset,
    amountYocto: t.amountYocto,
    milestone: t.milestone,
    buyer: { organizationId: t.buyer.organizationId, principalId: t.buyer.principalId },
    supplier: { organizationId: t.supplier.organizationId, principalId: t.supplier.principalId },
    inspector: { principalId: t.inspector.principalId },
    riskResolver: { principalId: t.riskResolver.principalId },
    payout: t.payout,
    evidencePolicy: t.evidencePolicy,
    expiresAt: t.expiresAt,
  };
}

function operationSummary(m: TradeModules, tradeId: string) {
  return m.journal.journal.opsForTrade(tradeId).map((o) => ({
    operationId: o.operationId,
    kind: o.kind,
    subjectId: o.subjectId,
    state: o.state,
    lockHeld: o.lockHeld,
    version: o.version,
    submitCount: o.submitCount,
    txHash: o.txHash,
  }));
}

async function tradeProjection(d: AppDeps, m: TradeModules, ctx: AuthContext, t: TradeTerms) {
  const id = t.tradeId;
  const blockers = await m.release.readiness(id);
  const live = m.release.liveIntent(id);
  const att = m.evidence.currentAttestation(id);
  const ins = m.evidence.currentInspection(id);
  const holds = m.holds.list(id);
  return {
    trade: termsSummary(t),
    viewer: { principalId: ctx.principal.id, relations: relationsOf(ctx, t) },
    evidence: m.evidence.evaluate(id),
    attestation: att
      ? {
          attestationId: att.id,
          manifestRevision: att.manifestRevision,
          manifestDigest: att.manifestDigest,
          digest: att.digest,
          status: m.evidence.attestationStatus(att.id),
          expiresAt: att.expiresAt,
        }
      : null,
    inspection: ins
      ? {
          inspectionId: ins.id,
          decision: ins.decision,
          reasonCodes: ins.reasonCodes,
          manifestDigest: ins.manifestDigest,
          digest: ins.digest,
          expiresAt: ins.expiresAt,
        }
      : null,
    holds: { blocking: holds.filter((h) => h.status !== "RESOLVED").length, items: holds.map(holdSummary) },
    release: {
      liveIntent: live
        ? { releaseIntentId: live.releaseIntentId, state: live.state, version: live.version }
        : null,
      blockers,
    },
    operations: operationSummary(m, id),
    frozen: m.journal.journal.frozen(id).length > 0,
    fundedPayouts: d.config.DOCKSIDE_FUNDED_PAYOUTS,
    observedAt: d.clock.now(),
  };
}

function intentJson(m: TradeModules, intentId: string) {
  const j = m.release.intent(intentId);
  return {
    releaseIntentId: j.releaseIntentId,
    tradeId: j.tradeId,
    tradeRevision: j.tradeRevision,
    state: j.state,
    live: j.live,
    version: j.version,
    contractVersion: j.contractVersion,
    amountYocto: j.amountYocto,
    slices: j.slices,
    destination: j.destination,
    predecessorId: j.predecessorId,
    requestDigest: j.requestDigest,
    intentExpiresAt: j.intentExpiresAt,
    children: j.children,
  };
}

/* --------------------------------- routes ---------------------------------- */

export function tradeRoutes(d: AppDeps): Route[] {
  const r = route;
  const log = (ctx: AuthContext, eventType: string, subjectType: string, subjectId: string) =>
    new AuditLog(d.db, d.clock, d.ids).append({
      eventType,
      organizationId: ctx.organizationId,
      actorPrincipalId: ctx.principal.id,
      actorKeyVersionId: ctx.keyVersion.id,
      sessionId: ctx.session.id,
      subjectType,
      subjectId,
      correlationId: ctx.correlationId,
      source: SOURCE,
      payload: {},
    });
  const authority = (): AuthorityService => d.authority;

  return [
    /* ------------------------------ trades ------------------------------ */
    r("GET", "/v1/trades", true, undefined, ({ ctx }) => {
      const c = must(ctx);
      const m = mods(d);
      return {
        trades: accessibleTrades(d, m, c).map((t) => ({
          ...termsSummary(t),
          relations: relationsOf(c, t),
          holdsBlocking: m.holds.blocking(t.tradeId),
          liveIntentState: m.release.liveIntent(t.tradeId)?.state ?? null,
          frozen: m.journal.journal.frozen(t.tradeId).length > 0,
        })),
      };
    }),
    r(
      "POST",
      "/v1/evidence-policies",
      true,
      z.object({ policy: z.record(z.string(), z.unknown()) }).strict(),
      ({ ctx, body }) => {
        const c = must(ctx);
        act(c, "ENROLL_SERVICE_KEY");
        const m = mods(d);
        const out = m.evidence.registerPolicy((body as { policy: never }).policy);
        log(c, "EVIDENCE_POLICY_REGISTERED", "evidence_policy", `${out.policyId}@${out.revision}`);
        return {
          ...out,
          relayTyped: toTypedJson(policyCanonical(parseEvidencePolicy((body as { policy: unknown }).policy))),
        };
      },
    ),
    r(
      "POST",
      "/v1/trades",
      true,
      z
        .object({
          terms: z.record(z.string(), z.unknown()),
          buyerSignature: sig,
          supplierSignature: sig,
        })
        .strict(),
      ({ ctx, body }) => {
        const c = must(ctx);
        act(c, "ACCEPT_TRADE_REVISION");
        const m = mods(d);
        const b = body as { terms: unknown; buyerSignature: string; supplierSignature: string };
        const terms = tradeTermsFromJson(b.terms);
        if (c.principal.id !== terms.buyer.principalId && c.principal.id !== terms.supplier.principalId)
          fail("FORBIDDEN", "only the buyer approver or supplier signer the terms bind may submit them");
        const out = m.evidence.bindTrade(terms, {
          buyerSignature: b.buyerSignature,
          supplierSignature: b.supplierSignature,
        });
        log(c, "TRADE_SUBMITTED", "trade", terms.tradeId);
        return {
          tradeId: terms.tradeId,
          tradeDigest: out.tradeDigest,
          canonicalDigest: tradeRevisionDigest(terms),
          relay: m.escrow.registerTradeCall(termsArg(terms), b.buyerSignature, b.supplierSignature),
          // The contract stores the EvidencePolicy the revision binds; relayed after register_trade.
          policyRelay: m.escrow.registerEvidencePolicyCall(
            terms.tradeId,
            toTypedJson(policyCanonical(boundPolicy(d, terms).policy)),
          ),
          signedPayload: toTypedJson(tradeTermsCanonical(terms)),
        };
      },
    ),
    r("GET", "/v1/trades/:id", true, undefined, async ({ ctx, params }) => {
      const c = must(ctx);
      const m = mods(d);
      return tradeProjection(d, m, c, loadTrade(m, c, params["id"] as string));
    }),
    r("POST", "/v1/trades/:id/sync", true, empty, async ({ ctx, params }) => {
      const c = must(ctx);
      const m = mods(d);
      const t = loadTrade(m, c, params["id"] as string);
      const view = await m.release.sync(t.tradeId);
      return {
        tradeId: t.tradeId,
        revision: view.revision,
        liveIntent: view.liveIntent,
        blockers: view.blockers,
      };
    }),
    r("GET", "/v1/trades/:id/attestor", true, undefined, ({ ctx, params }) => {
      const c = must(ctx);
      const m = mods(d);
      const t = loadTrade(m, c, params["id"] as string);
      const status = authority().bindingStatus(t);
      const enrollment = authority().getServiceEnrollment(t.manifestAttestor.enrollmentId);
      return {
        binding: {
          enrollmentId: t.manifestAttestor.enrollmentId,
          serviceId: t.manifestAttestor.serviceId,
          keyVersion: t.manifestAttestor.keyVersion,
          publicKey: t.manifestAttestor.publicKey,
          scope: t.manifestAttestor.scope,
        },
        issues: status.issues.filter((i) => i.role === "manifestAttestor"),
        enrollment:
          enrollment.organizationId === c.organizationId
            ? enrollment
            : { enrollmentId: t.manifestAttestor.enrollmentId, visibility: "OTHER_ORGANIZATION" },
        currentAttestation: m.evidence.currentAttestation(t.tradeId)?.digest ?? null,
      };
    }),

    /* ----------------------------- evidence ----------------------------- */
    r("GET", "/v1/trades/:id/evidence", true, undefined, ({ ctx, params }) => {
      const c = must(ctx);
      const m = mods(d);
      const t = loadTrade(m, c, params["id"] as string);
      return {
        manifest: m.evidence.manifest(t.tradeId),
        evaluation: m.evidence.evaluate(t.tradeId),
        history: m.evidence.history(t.tradeId),
      };
    }),
    r(
      "POST",
      "/v1/trades/:id/evidence",
      true,
      z
        .object({
          slotId: z.string().max(64),
          contentBase64: z.string().max(Math.ceil((MAX_UPLOAD_BODY_BYTES * 3) / 4)),
          declaredMime: z.string().max(128).optional(),
          issuer: z
            .object({ capability: z.string().max(32), issuedAt: z.number().int(), signature: sig })
            .strict(),
          replacesItemId: z.string().max(64).optional(),
          expectedManifestRevision: z.number().int().min(0),
        })
        .strict(),
      async ({ ctx, params, body }) => {
        const c = must(ctx);
        act(c, "FILL_EVIDENCE_SLOT");
        const m = mods(d);
        const t = loadTrade(m, c, params["id"] as string);
        const b = body as {
          slotId: string;
          contentBase64: string;
          declaredMime?: string;
          issuer: { capability: string; issuedAt: number; signature: string };
          replacesItemId?: string;
          expectedManifestRevision: number;
        };
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b.contentBase64))
          fail("VALIDATION_FAILED", "contentBase64 is not base64");
        const content = new Uint8Array(Buffer.from(b.contentBase64, "base64"));
        return m.evidence.upload(c, {
          tradeId: t.tradeId,
          slotId: b.slotId,
          content,
          issuer: b.issuer,
          expectedManifestRevision: b.expectedManifestRevision,
          ...(b.declaredMime === undefined ? {} : { declaredMime: b.declaredMime }),
          ...(b.replacesItemId === undefined ? {} : { replacesItemId: b.replacesItemId }),
        });
      },
      { maxBody: MAX_UPLOAD_BODY_BYTES },
    ),
    r("POST", "/v1/trades/:id/inspections", true, signed, ({ ctx, params, body }) => {
      const c = must(ctx);
      act(c, "ATTEST_INSPECTION");
      const m = mods(d);
      const t = loadTrade(m, c, params["id"] as string);
      requireBound(c, t.inspector, "INSPECTOR", "inspector");
      const b = body as { payload: unknown; signature: string };
      const payload = canonical(b.payload);
      const view = m.evidence.recordInspection(t.tradeId, payload, b.signature);
      return {
        inspection: view,
        ...call(m.escrow.submitInspectionCall(t.tradeId, toTypedJson(payload), b.signature)),
      };
    }),
    r("GET", "/v1/inspections", true, undefined, ({ ctx }) => {
      const c = must(ctx);
      const m = mods(d);
      return {
        inspections: accessibleTrades(d, m, c).map((t) => {
          const i = m.evidence.currentInspection(t.tradeId);
          const att = m.evidence.currentAttestation(t.tradeId);
          return {
            tradeId: t.tradeId,
            assignedToViewer: c.principal.id === t.inspector.principalId,
            currentAttestation: att ? { digest: att.digest, manifestDigest: att.manifestDigest } : null,
            inspection: i
              ? { inspectionId: i.id, decision: i.decision, digest: i.digest, expiresAt: i.expiresAt }
              : null,
          };
        }),
      };
    }),

    /* ------------------------------- holds ------------------------------- */
    r("GET", "/v1/trades/:id/holds", true, undefined, ({ ctx, params }) => {
      const c = must(ctx);
      const m = mods(d);
      const t = loadTrade(m, c, params["id"] as string);
      const holds = m.holds.list(t.tradeId);
      return {
        blocking: holds.filter((h) => h.status !== "RESOLVED").length,
        holds: holds.map((h) => ({
          ...holdSummary(h),
          resolutionRequests: d.db
            .all(
              "SELECT id, requested_by, created_at FROM hold_resolution_requests WHERE hold_id = ? ORDER BY created_at, rowid",
              h.id,
            )
            .map((q) => ({
              requestId: String(q["id"]),
              requestedBy: String(q["requested_by"]),
              createdAt: Number(q["created_at"]),
              authorizing: false,
            })),
        })),
      };
    }),
    r(
      "POST",
      "/v1/trades/:id/hold-challenges",
      true,
      z
        .object({
          reasonCode: code,
          ttlMs: z
            .number()
            .int()
            .min(60_000)
            .max(90 * 24 * 3600_000 - 1),
          bindManifest: z.boolean().optional(),
        })
        .strict(),
      ({ ctx, params, body }) => {
        const c = must(ctx);
        act(c, "SET_HOLD");
        const m = mods(d);
        const t = loadTrade(m, c, params["id"] as string);
        requireBound(c, t.riskResolver, "RISK_RESOLVER", "risk/policy resolver");
        const b = body as { reasonCode: string; ttlMs: number; bindManifest?: boolean };
        const now = d.clock.now();
        const payload = holdSetPayload(tradeBinding(t), {
          holdId: d.ids.next("hld"),
          manifestDigest:
            b.bindManifest === false ? null : m.evidence.currentAcceptedManifestDigest(t.tradeId),
          reasonCode: b.reasonCode,
          issuerRole: "RISK_RESOLVER",
          ruleId: null,
          issuedAt: now,
          expiresAt: now + b.ttlMs,
          nonce: newNonce(),
        });
        return { purpose: "HOLD_SET", payload: toTypedJson(payload) };
      },
    ),
    r("POST", "/v1/trades/:id/holds", true, signed, ({ ctx, params, body }) => {
      const c = must(ctx);
      act(c, "SET_HOLD");
      const m = mods(d);
      const t = loadTrade(m, c, params["id"] as string);
      // Deterministic-policy SETs run in the policy service's isolated signer, never over a session.
      requireBound(c, t.riskResolver, "RISK_RESOLVER", "risk/policy resolver");
      const b = body as { payload: unknown; signature: string };
      const payload = canonical(b.payload);
      if ((payload as Record<string, CanonicalValue>)["issuerRole"] !== "RISK_RESOLVER")
        fail("FORBIDDEN", "a session may only SET a hold as the bound risk/policy resolver");
      const hold = m.holds.recordSet(t.tradeId, payload, b.signature);
      return {
        hold: holdSummary(hold),
        ...call(m.escrow.setHoldCall(t.tradeId, toTypedJson(payload), b.signature)),
      };
    }),
    r(
      "POST",
      "/v1/holds/:id/resolution-requests",
      true,
      z.object({ note: z.string().max(500) }).strict(),
      ({ ctx, params, body }) => {
        const c = must(ctx);
        act(c, "REQUEST_HOLD_RESOLUTION");
        const m = mods(d);
        const { hold } = holdTrade(m, c, params["id"] as string);
        const out = m.holds.requestResolution(c, {
          tradeId: hold.tradeId,
          holdId: hold.id,
          note: (body as { note: string }).note,
        });
        return { ...out, holdId: hold.id, authorizing: false, holdStatus: m.holds.get(hold.id).status };
      },
    ),
    r(
      "POST",
      "/v1/holds/:id/resolution-challenges",
      true,
      z.object({ resolutionCode: z.enum(RESOLUTION_CODES), evidenceDigest: hex64 }).strict(),
      ({ ctx, params, body }) => {
        const c = must(ctx);
        act(c, "RESOLVE_HOLD");
        const m = mods(d);
        const { hold, terms } = holdTrade(m, c, params["id"] as string);
        requireBound(c, terms.riskResolver, "RISK_RESOLVER", "risk/policy resolver");
        if (hold.status === "RESOLVED") fail("INVALID_STATE", "hold already resolved");
        const b = body as { resolutionCode: (typeof RESOLUTION_CODES)[number]; evidenceDigest: string };
        const now = d.clock.now();
        const payload = holdResolvePayload(tradeBinding(terms), {
          holdId: hold.id,
          holdReasonCode: hold.reasonCode,
          manifestDigest: m.evidence.currentAcceptedManifestDigest(hold.tradeId),
          resolutionCode: b.resolutionCode,
          evidenceDigest: b.evidenceDigest,
          issuedAt: now,
          expiresAt: now + 3600_000,
          nonce: newNonce(),
        });
        return { purpose: "HOLD_RESOLVE", payload: toTypedJson(payload) };
      },
    ),
    r("POST", "/v1/holds/:id/resolution", true, signed, ({ ctx, params, body }) => {
      const c = must(ctx);
      act(c, "RESOLVE_HOLD");
      const m = mods(d);
      const { hold, terms } = holdTrade(m, c, params["id"] as string);
      requireBound(c, terms.riskResolver, "RISK_RESOLVER", "risk/policy resolver");
      const b = body as { payload: unknown; signature: string };
      const payload = canonical(b.payload);
      if ((payload as Record<string, CanonicalValue>)["holdId"] !== hold.id)
        fail("VALIDATION_FAILED", "resolution names a different hold");
      const view = m.holds.recordResolve(hold.tradeId, payload, b.signature);
      return {
        hold: holdSummary(view),
        ...call(m.escrow.resolveHoldCall(hold.tradeId, toTypedJson(payload), b.signature)),
      };
    }),

    /* ------------------------------ release ------------------------------ */
    r("GET", "/v1/trades/:id/release", true, undefined, async ({ ctx, params }) => {
      const c = must(ctx);
      const m = mods(d);
      const t = loadTrade(m, c, params["id"] as string);
      const blockers = await m.release.readiness(t.tradeId);
      const contract = await m.escrow.getRelease(t.tradeId);
      const intents = d.db
        .all("SELECT intent_id FROM release_intents WHERE trade_id = ? ORDER BY created_at, rowid", t.tradeId)
        .map((x) => intentJson(m, String(x["intent_id"])));
      return { tradeId: t.tradeId, blockers, intents, contract, observedAt: d.clock.now() };
    }),
    r(
      "POST",
      "/v1/trades/:id/release-intents",
      true,
      z
        .object({
          idempotencyKey: z.string().max(128),
          intentLifetimeMs: z.number().int().optional(),
        })
        .strict(),
      async ({ ctx, params, body }) => {
        const c = must(ctx);
        act(c, "APPROVE_RELEASE");
        const m = mods(d);
        const t = loadTrade(m, c, params["id"] as string);
        const b = body as { idempotencyKey: string; intentLifetimeMs?: number };
        const p = await m.release.prepareIntent(c, {
          tradeId: t.tradeId,
          idempotencyKey: b.idempotencyKey,
          ...(b.intentLifetimeMs === undefined ? {} : { intentLifetimeMs: b.intentLifetimeMs }),
        });
        return {
          releaseIntentId: p.releaseIntentId,
          joined: p.joined,
          purpose: "RELEASE_INTENT",
          payload: p.typed,
          digest: p.digest,
        };
      },
    ),
    r(
      "POST",
      "/v1/release-intents/:id/signature",
      true,
      z.object({ signature: sig }).strict(),
      ({ ctx, params, body }) => {
        const c = must(ctx);
        act(c, "APPROVE_RELEASE");
        const m = mods(d);
        intentTrade(m, c, params["id"] as string);
        return call(
          m.release.recordIntentSignature(c, {
            releaseIntentId: params["id"] as string,
            signature: (body as { signature: string }).signature,
          }),
        );
      },
    ),
    r("POST", "/v1/release-intents/:id/approval-challenges", true, empty, async ({ ctx, params }) => {
      const c = must(ctx);
      act(c, "APPROVE_RELEASE");
      const m = mods(d);
      intentTrade(m, c, params["id"] as string);
      const p = await m.release.prepareApproval(c, { releaseIntentId: params["id"] as string });
      return { purpose: "BUYER_APPROVAL", payload: p.typed, digest: p.digest };
    }),
    r("POST", "/v1/release-intents/:id/approval", true, signed, ({ ctx, params, body }) => {
      const c = must(ctx);
      act(c, "APPROVE_RELEASE");
      const m = mods(d);
      intentTrade(m, c, params["id"] as string);
      const b = body as { payload: unknown; signature: string };
      const payload = canonical(b.payload);
      if ((payload as Record<string, CanonicalValue>)["releaseIntentId"] !== params["id"])
        fail("VALIDATION_FAILED", "approval names a different release intent");
      return call(m.release.recordApproval(c, { payload, signature: b.signature }));
    }),
    /**
     * Queue the direct release. Only the bound buyer approver may ask; the journal re-checks the
     * full release conjunction (current attestation, current PASS, no ACTIVE or
     * EXPIRED_UNRESOLVED hold, buyer approval, value lock) and the contract re-checks it again.
     */
    r("POST", "/v1/release-intents/:id/execute", true, empty, async ({ ctx, params }) => {
      const c = must(ctx);
      act(c, "APPROVE_RELEASE");
      const m = mods(d);
      const t = intentTrade(m, c, params["id"] as string);
      requireBound(c, t.buyer, "BUYER_APPROVER", "buyer approver");
      const out = await m.journal.enqueueRelease(params["id"] as string);
      log(c, "RELEASE_EXECUTION_REQUESTED", "economic_operation", out.operationId);
      const op = m.journal.journal.op(out.operationId);
      return { ...out, state: op.state };
    }),
    r(
      "POST",
      "/v1/release-intents/:id/cancel-challenges",
      true,
      z.object({ reasonCode: code }).strict(),
      async ({ ctx, params, body }) => {
        const c = must(ctx);
        act(c, "SIGN_CANCEL_RELEASE_INTENT");
        const m = mods(d);
        requireExitParty(c, intentTrade(m, c, params["id"] as string));
        const p = await m.release.prepareCancel(c, {
          releaseIntentId: params["id"] as string,
          reasonCode: (body as { reasonCode: string }).reasonCode,
        });
        return { purpose: "CANCEL_RELEASE_INTENT", payload: p.typed, digest: p.digest };
      },
    ),
    r(
      "POST",
      "/v1/release-intents/:id/cancel-consent-challenges",
      true,
      z.object({ cancel: typed }).strict(),
      async ({ ctx, params, body }) => {
        const c = must(ctx);
        act(c, "SIGN_CANCEL_RELEASE_INTENT");
        const m = mods(d);
        requireExitParty(c, intentTrade(m, c, params["id"] as string));
        const cancel = canonical((body as { cancel: unknown }).cancel);
        if ((cancel as Record<string, CanonicalValue>)["releaseIntentId"] !== params["id"])
          fail("VALIDATION_FAILED", "cancel names a different release intent");
        const p = await m.release.prepareCancelConsent(c, cancel);
        return { purpose: "CANCEL_CONSENT", payload: p.typed, digest: p.digest };
      },
    ),
    r(
      "POST",
      "/v1/release-intents/:id/cancel-consents",
      true,
      z.object({ cancel: typed, consent: typed, signature: sig }).strict(),
      async ({ ctx, params, body }) => {
        const c = must(ctx);
        act(c, "SIGN_CANCEL_RELEASE_INTENT");
        const m = mods(d);
        requireExitParty(c, intentTrade(m, c, params["id"] as string));
        const b = body as { cancel: unknown; consent: unknown; signature: string };
        const cancel = canonical(b.cancel);
        if ((cancel as Record<string, CanonicalValue>)["releaseIntentId"] !== params["id"])
          fail("VALIDATION_FAILED", "cancel names a different release intent");
        return call(
          await m.release.recordCancelConsent(c, {
            cancel,
            consent: canonical(b.consent),
            signature: b.signature,
          }),
        );
      },
    ),
    r(
      "POST",
      "/v1/release-intents/:id/cancel-consent-revocation-challenges",
      true,
      z.object({ consent: typed }).strict(),
      async ({ ctx, params, body }) => {
        const c = must(ctx);
        act(c, "SIGN_CANCEL_RELEASE_INTENT");
        const m = mods(d);
        requireExitParty(c, intentTrade(m, c, params["id"] as string));
        const p = await m.release.prepareConsentRevocation(c, {
          releaseIntentId: params["id"] as string,
          consent: canonical((body as { consent: unknown }).consent),
        });
        return { purpose: "REVOKE_CANCEL_CONSENT", payload: p.typed, digest: p.digest };
      },
    ),
    r(
      "POST",
      "/v1/release-intents/:id/cancel-consent-revocations",
      true,
      signed,
      async ({ ctx, params, body }) => {
        const c = must(ctx);
        act(c, "SIGN_CANCEL_RELEASE_INTENT");
        const m = mods(d);
        requireExitParty(c, intentTrade(m, c, params["id"] as string));
        const b = body as { payload: unknown; signature: string };
        const payload = canonical(b.payload);
        if ((payload as Record<string, CanonicalValue>)["releaseIntentId"] !== params["id"])
          fail("VALIDATION_FAILED", "revocation names a different release intent");
        return call(await m.release.recordConsentRevocation(c, { payload, signature: b.signature }));
      },
    ),
    r(
      "POST",
      "/v1/release-intents/:id/abandon-challenges",
      true,
      z
        .object({
          trigger: z.enum(["INTENT_EXPIRED", "BUYER_APPROVAL_EXPIRED", "FUNDED_AUTHORIZATION_EXPIRED"]),
        })
        .strict(),
      async ({ ctx, params, body }) => {
        const c = must(ctx);
        act(c, "SIGN_ABANDON_RELEASE_INTENT");
        const m = mods(d);
        requireExitParty(c, intentTrade(m, c, params["id"] as string));
        const p = await m.release.prepareAbandon(c, {
          releaseIntentId: params["id"] as string,
          trigger: (body as { trigger: never }).trigger,
        });
        return { purpose: "ABANDON_RELEASE_INTENT", payload: p.typed, digest: p.digest };
      },
    ),
    r("POST", "/v1/release-intents/:id/abandon", true, signed, async ({ ctx, params, body }) => {
      const c = must(ctx);
      act(c, "SIGN_ABANDON_RELEASE_INTENT");
      const m = mods(d);
      requireExitParty(c, intentTrade(m, c, params["id"] as string));
      const b = body as { payload: unknown; signature: string };
      const payload = canonical(b.payload);
      if ((payload as Record<string, CanonicalValue>)["releaseIntentId"] !== params["id"])
        fail("VALIDATION_FAILED", "abandon names a different release intent");
      return call(await m.release.recordAbandon(c, { payload, signature: b.signature }));
    }),

    /* ------------------------- payout / refund / timeline ------------------------- */
    r("GET", "/v1/trades/:id/payout", true, undefined, async ({ ctx, params }) => {
      const c = must(ctx);
      const m = mods(d);
      const t = loadTrade(m, c, params["id"] as string);
      const ops = operationSummary(m, t.tradeId).filter((o) => o.kind === "RELEASE");
      return {
        tradeId: t.tradeId,
        profile: "DIRECT_TESTNET",
        destination: t.payout.destination,
        amountYocto: t.amountYocto,
        operations: ops.map((o) => ({ ...o, disposition: m.journal.journal.disposition(o.operationId) })),
        fundedPayout: { status: "BLOCKED", reason: "FUNDED_RAIL_BLOCKED" },
        observedAt: d.clock.now(),
      };
    }),
    r("GET", "/v1/trades/:id/refund", true, undefined, async ({ ctx, params }) => {
      const c = must(ctx);
      const m = mods(d);
      const t = loadTrade(m, c, params["id"] as string);
      const refunds = await m.escrow.getRefunds(t.tradeId);
      const ledger = await m.escrow.getLedger(t.tradeId);
      return {
        tradeId: t.tradeId,
        refunds,
        ledger,
        operations: operationSummary(m, t.tradeId).filter((o) => o.kind === "REFUND"),
        source: "escrow-contract-view",
        observedAt: d.clock.now(),
      };
    }),
    r("GET", "/v1/trades/:id/timeline", true, undefined, ({ ctx, params }) => {
      const c = must(ctx);
      const m = mods(d);
      const t = loadTrade(m, c, params["id"] as string);
      const x = buildAuditExport(d, m, t, c, { observedChain: null });
      return {
        tradeId: t.tradeId,
        events: x.sections.auditEvents.map((e) => ({
          seq: e["seq"],
          eventType: e["eventType"],
          subjectType: e["subjectType"],
          subjectId: e["subjectId"],
          actorPrincipalId: e["actorPrincipalId"],
          source: e["source"],
          recordedAt: e["recordedAt"],
        })),
      };
    }),
    r("GET", "/v1/payouts", true, undefined, ({ ctx }) => {
      const c = must(ctx);
      const m = mods(d);
      return {
        payouts: accessibleTrades(d, m, c).flatMap((t) =>
          operationSummary(m, t.tradeId)
            .filter((o) => o.kind === "RELEASE")
            .map((o) => ({
              tradeId: t.tradeId,
              destination: t.payout.destination,
              amountYocto: t.amountYocto,
              ...o,
            })),
        ),
        fundedPayouts: d.config.DOCKSIDE_FUNDED_PAYOUTS,
      };
    }),

    /* ------------------------------ audit export ------------------------------ */
    r("GET", "/v1/trades/:id/audit-export", true, undefined, async ({ ctx, params, query }) => {
      const c = must(ctx);
      act(c, "EXPORT_AUDIT");
      const m = mods(d);
      const t = loadTrade(m, c, params["id"] as string);
      const want = query.get("destinations") ?? "masked";
      if (want !== "masked" && want !== "full")
        fail("VALIDATION_FAILED", "destinations must be masked or full");
      // Full account ids only for the trade's own parties and their organisations' security admins.
      const rel = relationsOf(c, t);
      const party =
        rel.includes("BUYER") ||
        rel.includes("SUPPLIER") ||
        (c.capabilities.includes("ORG_SECURITY_ADMIN") &&
          (rel.includes("BUYER_ORG") || rel.includes("SUPPLIER_ORG")));
      if (want === "full" && !party)
        fail("FORBIDDEN", "full destinations are limited to the trade's parties");
      const observedChain = {
        source: "escrow-contract-view",
        contractId: t.escrowContractId,
        trade: await m.escrow.getTrade(t.tradeId),
        ledger: await m.escrow.getLedger(t.tradeId),
        refunds: await m.escrow.getRefunds(t.tradeId),
        holds: await m.escrow.getHolds(t.tradeId),
        evidence: await m.escrow.getEvidence(t.tradeId),
        release: await m.escrow.getRelease(t.tradeId),
      };
      const out = buildAuditExport(d, m, t, c, {
        observedChain,
        destinations: want === "full" ? "FULL" : "MASKED",
      });
      log(c, "AUDIT_EXPORTED", "trade", t.tradeId);
      return out;
    }),

    /* ------------------------ operations (journal M05) ------------------------ */
    r("GET", "/v1/operations/:id", true, undefined, ({ ctx, params }) => {
      const c = must(ctx);
      const m = mods(d);
      operationTrade(m, c, params["id"] as string);
      return m.journal.view(params["id"] as string);
    }),
    // Operator requests ask for work; none of them can set an outcome (FORCE_TERMINAL_STATUS: []).
    r("POST", "/v1/operations/:id/reconciliation-requests", true, empty, ({ ctx, params }) => {
      const c = must(ctx);
      act(c, "REQUEST_RECONCILIATION");
      riskOperator(c);
      const m = mods(d);
      requireBound(
        c,
        operationTrade(m, c, params["id"] as string).riskResolver,
        "RISK_RESOLVER",
        "risk/policy resolver",
      );
      const requestId = m.journal.requestReconciliation(c, params["id"] as string);
      return { requestId, state: m.journal.journal.op(params["id"] as string).state };
    }),
    r(
      "POST",
      "/v1/operations/:id/adjudication-requests",
      true,
      z.object({ note: z.string().max(200) }).strict(),
      ({ ctx, params, body }) => {
        const c = must(ctx);
        act(c, "REQUEST_RECONCILIATION");
        riskOperator(c);
        const m = mods(d);
        requireBound(
          c,
          operationTrade(m, c, params["id"] as string).riskResolver,
          "RISK_RESOLVER",
          "risk/policy resolver",
        );
        const requestId = m.journal.openAdjudication(
          c,
          params["id"] as string,
          (body as { note: string }).note,
        );
        return { requestId, state: m.journal.journal.op(params["id"] as string).state };
      },
    ),
    r(
      "POST",
      "/v1/operations/:id/source-hints",
      true,
      z.object({ kind: z.string().max(32), locator: z.string().max(256) }).strict(),
      ({ ctx, params, body }) => {
        const c = must(ctx);
        act(c, "REQUEST_RECONCILIATION");
        riskOperator(c);
        const m = mods(d);
        requireBound(
          c,
          operationTrade(m, c, params["id"] as string).riskResolver,
          "RISK_RESOLVER",
          "risk/policy resolver",
        );
        const requestId = m.journal.identifySource(
          c,
          params["id"] as string,
          body as { kind: string; locator: string },
        );
        return { requestId, state: m.journal.journal.op(params["id"] as string).state };
      },
    ),
    ...proposalRoutes(d),
    r("POST", "/v1/trades/:id/freeze", true, z.object({ reason: code }).strict(), ({ ctx, params, body }) => {
      const c = must(ctx);
      act(c, "REQUEST_RECONCILIATION");
      riskOperator(c);
      const m = mods(d);
      const t = loadTrade(m, c, params["id"] as string);
      requireBound(c, t.riskResolver, "RISK_RESOLVER", "risk/policy resolver");
      const requestId = m.journal.freezeTrade(c, t.tradeId, (body as { reason: string }).reason);
      return { requestId, frozen: true };
    }),
  ];
}

/* ------------------------- proposals and challenges (M08) ------------------------- */

const DAY_MS = 24 * 3600_000;

/** The EvidencePolicy a revision binds, as registered (digest checked against the terms). */
function boundPolicy(d: AppDeps, t: TradeTerms) {
  const row = d.db.get(
    "SELECT digest, policy_json FROM evidence_policies WHERE policy_id = ? AND revision = ?",
    t.evidencePolicy.id,
    t.evidencePolicy.revision,
  );
  if (!row) fail("NOT_FOUND", "evidence policy not registered");
  if (String(row["digest"]) !== t.evidencePolicy.digest)
    fail("VALIDATION_FAILED", "registered evidence policy digest differs from the revision");
  const json = JSON.parse(String(row["policy_json"])) as Record<string, unknown>;
  return { policy: parseEvidencePolicy(json), json, digest: String(row["digest"]) };
}

/**
 * Current authority of a human principal for a trade role. Every failure answers the same way, so
 * the route does not reveal whether an id exists or which check failed.
 */
function humanBinding(d: AppDeps, principalId: string, capability: Capability, label: string) {
  const deny = (): never => fail("VALIDATION_FAILED", `${label} is not an active ${capability} principal`);
  const p = d.db.get("SELECT organization_id, kind, status FROM principals WHERE id = ?", principalId);
  if (p?.["kind"] !== "HUMAN" || p["status"] !== "ACTIVE") return deny();
  const g = d.db.get(
    "SELECT 1 AS x FROM role_grants WHERE principal_id = ? AND capability = ? AND status = 'ACTIVE'",
    principalId,
    capability,
  );
  if (!g) return deny();
  const k = d.db.get(
    "SELECT id, public_key FROM key_versions WHERE principal_id = ? AND status = 'ACTIVE' ORDER BY version DESC LIMIT 1",
    principalId,
  );
  if (!k) return deny();
  return {
    organizationId: String(p["organization_id"]),
    principalId,
    keyVersionId: String(k["id"]),
    publicKey: String(k["public_key"]),
  };
}

/** The buyer organisation's active service enrollment for a capability whose scope covers the policy. */
function serviceBinding(
  d: AppDeps,
  organizationId: string,
  capability: "MANIFEST_ATTEST" | "DETERMINISTIC_POLICY_SET",
  policy: { id: string; revision: number },
  explicitId: string | undefined,
  schema: string,
) {
  const rows = d.db
    .all(
      "SELECT id, principal_id, service_id, scope_json FROM service_enrollments WHERE organization_id = ? AND capability = ? AND status = 'ACTIVE' ORDER BY created_at, id",
      organizationId,
      capability,
    )
    .filter((r) => {
      const s = JSON.parse(String(r["scope_json"])) as Record<string, unknown>;
      return (
        s["organizationId"] === organizationId &&
        s["tradeId"] === null &&
        s["evidencePolicyId"] === policy.id &&
        s["evidencePolicyRevision"] === policy.revision &&
        (explicitId === undefined || r["id"] === explicitId)
      );
    });
  const e = rows[0];
  if (rows.length !== 1 || !e)
    return fail(
      "VALIDATION_FAILED",
      `expected exactly one active ${capability} enrollment covering ${policy.id}@${policy.revision}`,
      { candidates: rows.length },
    );
  const k = d.db.get(
    "SELECT version, public_key FROM key_versions WHERE principal_id = ? AND status = 'ACTIVE' ORDER BY version DESC LIMIT 1",
    String(e["principal_id"]),
  );
  if (!k) return fail("KEY_NOT_BOUND", `${capability} enrollment has no active key`);
  return {
    enrollmentId: String(e["id"]),
    serviceId: String(e["service_id"]),
    keyVersion: Number(k["version"]),
    publicKey: String(k["public_key"]),
    capability,
    scope: {
      organizationId,
      tradeId: null,
      evidencePolicyId: policy.id,
      evidencePolicyRevision: policy.revision,
    },
    attestationSchema: schema,
  };
}

function proposalJson(d: AppDeps, terms: TradeTerms) {
  const canonicalTerms = tradeTermsCanonical(terms);
  return {
    tradeId: terms.tradeId,
    terms: tradeTermsToJson(terms),
    purpose: "TRADE_REVISION",
    payload: toTypedJson(canonicalTerms),
    digest: digestHexFor("TRADE_REVISION", canonicalTerms),
    bindingIssues: d.authority.bindingStatus(terms).issues,
  };
}

const anyId = z.string().regex(/^[a-z]{2,8}_[0-9a-f]{32}$/);

function proposalRoutes(d: AppDeps): Route[] {
  const r = route;
  return [
    /**
     * Prepare (never store) the canonical revision-1 terms for a trade the calling buyer approver
     * proposes. The server resolves each named principal's current key version and the buyer
     * organisation's enrolled services, so every party signs exactly what the contract registers.
     */
    r(
      "POST",
      "/v1/trade-proposals",
      true,
      z
        .object({
          supplierPrincipalId: anyId,
          inspectorPrincipalId: anyId,
          riskResolverPrincipalId: anyId,
          buyerAccountId: z.string().max(64),
          supplierAccountId: z.string().max(64),
          payoutDestination: z.string().max(64),
          amountYocto: z.string().regex(/^[1-9][0-9]{0,38}$/),
          milestone: z.object({ id: z.string().max(64), description: z.string().max(280) }).strict(),
          evidencePolicy: z.object({ id: z.string().max(64), revision: z.number().int().min(1) }).strict(),
          expiresInDays: z.number().int().min(1).max(180),
          manifestAttestorEnrollmentId: anyId.optional(),
          policySetterEnrollmentId: anyId.optional(),
        })
        .strict(),
      ({ ctx, body }) => {
        const c = must(ctx);
        act(c, "ACCEPT_TRADE_REVISION");
        const m = mods(d);
        if (!c.capabilities.includes("BUYER_APPROVER"))
          fail("FORBIDDEN", "only a buyer approver proposes a trade revision");
        const b = body as {
          supplierPrincipalId: string;
          inspectorPrincipalId: string;
          riskResolverPrincipalId: string;
          buyerAccountId: string;
          supplierAccountId: string;
          payoutDestination: string;
          amountYocto: string;
          milestone: { id: string; description: string };
          evidencePolicy: { id: string; revision: number };
          expiresInDays: number;
          manifestAttestorEnrollmentId?: string;
          policySetterEnrollmentId?: string;
        };
        const policyRow = d.db.get(
          "SELECT digest FROM evidence_policies WHERE policy_id = ? AND revision = ?",
          b.evidencePolicy.id,
          b.evidencePolicy.revision,
        );
        if (!policyRow) fail("NOT_FOUND", "evidence policy not registered");
        const buyer = humanBinding(d, c.principal.id, "BUYER_APPROVER", "buyer");
        if (buyer.keyVersionId !== c.keyVersion.id)
          fail("KEY_NOT_BOUND", "propose from the session of your current active key version");
        const supplier = humanBinding(d, b.supplierPrincipalId, "SUPPLIER_SIGNER", "supplier");
        const inspector = humanBinding(d, b.inspectorPrincipalId, "INSPECTOR", "inspector");
        const risk = humanBinding(d, b.riskResolverPrincipalId, "RISK_RESOLVER", "risk/policy resolver");
        const network = d.config.DOCKSIDE_NETWORK;
        const json = {
          schemaVersion: 1,
          profileVersion: "dockside-direct-testnet-v1",
          tradeId: d.ids.next("trd"),
          revision: 1,
          predecessorDigest: null,
          network,
          escrowContractId: m.escrow.contractId,
          buyer: { ...buyer, accountId: b.buyerAccountId },
          supplier: { ...supplier, accountId: b.supplierAccountId },
          asset: { kind: "NEAR_NATIVE", network },
          amountYocto: b.amountYocto,
          milestone: b.milestone,
          evidencePolicy: { ...b.evidencePolicy, digest: String(policyRow["digest"]) },
          inspector: {
            principalId: inspector.principalId,
            keyVersionId: inspector.keyVersionId,
            publicKey: inspector.publicKey,
            attestationSchema: "dockside/inspection-attestation@1",
          },
          manifestAttestor: serviceBinding(
            d,
            buyer.organizationId,
            "MANIFEST_ATTEST",
            b.evidencePolicy,
            b.manifestAttestorEnrollmentId,
            "dockside/manifest-attestation@1",
          ),
          policySetter: serviceBinding(
            d,
            buyer.organizationId,
            "DETERMINISTIC_POLICY_SET",
            b.evidencePolicy,
            b.policySetterEnrollmentId,
            "dockside/hold-set@1",
          ),
          riskResolver: {
            principalId: risk.principalId,
            keyVersionId: risk.keyVersionId,
            publicKey: risk.publicKey,
          },
          payout: { network, recipientType: "NEAR_ACCOUNT", destination: b.payoutDestination },
          refundPolicy: { id: "dockside-refund-v1", revision: 1 },
          delayPolicy: { destinationChangeDelayMs: DAY_MS },
          expiresAt: d.clock.now() + b.expiresInDays * DAY_MS,
        };
        return proposalJson(d, tradeTermsFromJson(json, { addressMode: "input" }));
      },
    ),
    /** The counterparty reviews exact terms (and the proposer's signature) before signing. */
    r(
      "POST",
      "/v1/trade-proposals/review",
      true,
      z.object({ terms: z.record(z.string(), z.unknown()), buyerSignature: sig.optional() }).strict(),
      ({ ctx, body }) => {
        const c = must(ctx);
        act(c, "ACCEPT_TRADE_REVISION");
        mods(d);
        const b = body as { terms: unknown; buyerSignature?: string };
        const terms = tradeTermsFromJson(b.terms);
        if (c.principal.id !== terms.buyer.principalId && c.principal.id !== terms.supplier.principalId)
          fail("FORBIDDEN", "only the buyer approver or supplier signer the terms bind may review them");
        return {
          ...proposalJson(d, terms),
          buyerSignatureValid:
            b.buyerSignature === undefined
              ? null
              : verifyFor(
                  terms.buyer.publicKey,
                  "TRADE_REVISION",
                  tradeTermsCanonical(terms),
                  b.buyerSignature,
                ),
        };
      },
    ),
    r("GET", "/v1/trades/:id/evidence-policy", true, undefined, ({ ctx, params }) => {
      const c = must(ctx);
      const m = mods(d);
      const t = loadTrade(m, c, params["id"] as string);
      const p = boundPolicy(d, t);
      return { policy: p.json, digest: p.digest };
    }),
    /** Exact inspection payload over the current attested manifest, for the bound inspector to sign. */
    r(
      "POST",
      "/v1/trades/:id/inspection-challenges",
      true,
      z
        .object({
          decision: z.enum(["PASS", "FAIL", "REVIEW"]),
          reasonCodes: z.array(code).min(1).max(8),
        })
        .strict(),
      ({ ctx, params, body }) => {
        const c = must(ctx);
        act(c, "ATTEST_INSPECTION");
        const m = mods(d);
        const t = loadTrade(m, c, params["id"] as string);
        requireBound(c, t.inspector, "INSPECTOR", "inspector");
        const att = m.evidence.currentAttestation(t.tradeId);
        if (!att) return fail("INVALID_STATE", "no current manifest attestation to inspect");
        const b = body as { decision: "PASS" | "FAIL" | "REVIEW"; reasonCodes: string[] };
        const now = d.clock.now();
        const payload = inspectionPayload(t, {
          manifestRevision: att.manifestRevision,
          manifestDigest: att.manifestDigest,
          decision: b.decision,
          reasonCodes: b.reasonCodes,
          issuedAt: now,
          expiresAt: Math.min(now + 7 * DAY_MS, att.expiresAt),
          nonce: newNonce(),
        });
        return {
          purpose: "INSPECTION_ATTESTATION",
          payload: toTypedJson(payload),
          digest: digestHexFor("INSPECTION_ATTESTATION", payload),
          attestationDigest: att.digest,
        };
      },
    ),
  ];
}
