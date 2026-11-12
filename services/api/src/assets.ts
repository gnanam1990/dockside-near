import type { AuthContext } from "@dockside/authority";
import {
  type CanonicalValue,
  type Capability,
  DocksideError,
  digestHexFor,
  fail,
  newNonce,
  type SigningPurpose,
  type TradeTerms,
  toTypedJson,
} from "@dockside/core";
import type { AssetOperation, AssetRecoveryJournal } from "@dockside/journal";
import {
  ASSET_RECOVERY_CHALLENGE_MS,
  type AssetRecoveryView,
  assetRecoveryApprovalPayload,
  assetRecoveryChallengePayload,
  assetRecoveryRequestPayload,
  assetRecoveryRevokePayload,
  type NearTxClient,
  type Nep141Reader,
  tradeBinding,
  type UnexpectedAssetView,
} from "@dockside/near";
import { AuditLog } from "@dockside/store";
import { z } from "zod";
import type { AppDeps } from "./app.js";
import { type RefundRole, refundRole } from "./refunds.js";
import { type Route, route } from "./routing.js";
import { act, canonical, loadTrade, mods, must, type TradeModules } from "./trades.js";

/**
 * M11 unexpected-asset recovery surface (REFUND-POLICY `UNEXPECTED_ASSET_RECOVERY`).
 *
 * The escrow contract is the authority: the claimed sender's own transaction requests recovery to
 * itself, the governing trade's bound risk/policy key approves, a 72-hour challenge runs, and the
 * compiled NEP-141 adapter executes the exact observed amount. This API adds the PoP session, the
 * capability matrix and the bound trade role with its exact key version; prepares exact payloads;
 * runs the read-only adapter validation the approval signs over; verifies signers against current
 * authority; journals what it prepared, observed and verified (0007_asset_recoveries.sql); appends
 * audit events; and queues the one execution transaction in the asset-recovery journal. It never
 * decides that an asset is recoverable or recovered: those are contract observations.
 *
 * The claimed sender is a NEAR account, not a Dockside principal. Its steps (request, its own
 * revocation) and another claimant's challenge are prepared here as unsigned calls for that
 * account's own wallet; no Dockside session can submit them in its place.
 */

export interface AssetRecoveryModule {
  readonly journal: AssetRecoveryJournal;
  /** Read-only NEP-141 views of the asset contract named by the escrow's record. */
  readonly token: (assetContract: string) => Nep141Reader;
  /** Looks up the sender's transfer transaction by hash for request evidence (optional). */
  readonly tx: NearTxClient | null;
}

const SOURCE = "dockside-api";
const HOUR = 3600_000;
const REQUEST_LIFETIME_MS = 24 * HOUR;
/** A validation report older than this cannot back an approval. */
const VALIDATION_MAX_AGE_MS = HOUR;

/** The signed policy row, served so the UI renders the policy rather than its own copy. */
export const ASSET_RECOVERY_POLICY_ROW = {
  reason: "UNEXPECTED_ASSET_RECOVERY",
  initiator: "Claimed sender (its own NEAR account)",
  signers:
    "Claimed sender proof-of-control, the enrolled risk/policy approval and an asset-specific contract recovery capability",
  clock: "Final required authorization time; 72-hour challenge, then only when the asset adapter is safe",
  evidence:
    "Chain, token contract, transaction/log, exact observed balance, sender and recipient proof, transfer capability and read-only validation",
  challenge:
    "Buyer, supplier, another claimant or risk/policy may challenge; unresolved ownership or capability stays ASSET_RECOVERY_REVIEW or UNRECOVERABLE_OR_REVIEW",
  eligible:
    "At most the exact separately observed unexpected-asset balance, only to the independently proven sender, never a native-NEAR original-funder field",
  revocation:
    "Claimed sender or risk/policy may revoke before execution; after submit the exact asset is locked, ambiguity is UNKNOWN and reconciliation uses the original transaction without blind retry",
} as const;

export const RECOVERY_ADAPTERS = [
  { standard: "NEP-141", capability: "NEP141_FT_TRANSFER", safe: true, method: "ft_transfer (1 yoctoNEAR)" },
  { standard: "NEP-171", capability: null, safe: false, method: "none in this build" },
  { standard: "NEP-245", capability: null, safe: false, method: "none in this build" },
] as const;

const sig = z.string().min(1).max(256);
const signed = z.object({ payload: z.record(z.string(), z.unknown()), signature: sig }).strict();
const empty = z.object({}).strict();
const codeSchema = z.string().regex(/^[A-Z0-9_]{1,64}$/);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const account = z.string().min(2).max(64);
const txHash = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,64}$/);

function allow(ok: boolean, message: string): void {
  if (!ok) fail("FORBIDDEN", message);
}

function asset(m: TradeModules): AssetRecoveryModule {
  if (!m.assetRecovery)
    return fail("NOT_FOUND", "no such endpoint", { reason: "ASSET_RECOVERY_NOT_CONFIGURED" });
  return m.assetRecovery;
}

async function allAssets(m: TradeModules): Promise<UnexpectedAssetView[]> {
  const out: UnexpectedAssetView[] = [];
  for (let from = 0; from < 10_000; from += 100) {
    const page = await m.escrow.getUnexpectedAssets(from, 100);
    out.push(...page);
    if (page.length < 100) break;
  }
  return out;
}

/** The recovery `rid` governed by trade `t`, with its asset (NOT_FOUND for any other trade). */
async function governed(
  m: TradeModules,
  t: TradeTerms,
  rid: string,
): Promise<{ a: UnexpectedAssetView; r: AssetRecoveryView }> {
  for (const a of await allAssets(m)) {
    const r = a.recoveries.find((x) => x.recoveryId === rid);
    if (r && r.tradeId === t.tradeId) return { a, r };
  }
  return fail("NOT_FOUND", "asset recovery not found for this trade");
}

function inState(r: AssetRecoveryView, states: readonly string[], message: string): void {
  if (!states.includes(r.state)) fail("INVALID_STATE", `${message} (recovery is ${r.state})`);
}

function field(p: CanonicalValue, k: string): CanonicalValue | undefined {
  return (p as Record<string, CanonicalValue>)[k];
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

function journaledRequest(d: AppDeps, rid: string) {
  const r = d.db.get("SELECT * FROM asset_recovery_requests WHERE recovery_id = ?", rid);
  if (!r) return null;
  return {
    recoveryId: rid,
    tradeId: String(r["trade_id"]),
    requestDigest: String(r["request_digest"]),
    evidence: JSON.parse(String(r["evidence_json"])) as Record<string, unknown>,
    evidenceDigest: String(r["evidence_digest"]),
    preparedAt: Number(r["prepared_at"]),
  };
}

function latestValidation(d: AppDeps, rid: string) {
  const r = d.db.get(
    "SELECT * FROM asset_recovery_validations WHERE recovery_id = ? ORDER BY observed_at DESC, rowid DESC LIMIT 1",
    rid,
  );
  if (!r) return null;
  return {
    report: JSON.parse(String(r["report_json"])) as Record<string, unknown>,
    digest: String(r["report_digest"]),
    verdict: String(r["verdict"]),
    observedAt: Number(r["observed_at"]),
  };
}

function opSummary(o: AssetOperation) {
  return {
    operationId: o.operationId,
    state: o.state,
    reason: o.lastReason,
    txHash: o.txHash,
    signerId: o.signerId,
    amount: o.amount.toString(10),
    recipient: o.recipient,
    tokenBalanceBefore: o.tokenBalanceBefore === null ? null : o.tokenBalanceBefore.toString(10),
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

/**
 * The state the UI shows: the contract record, except that an execution this API submitted whose
 * outcome is not yet known on the contract reads UNKNOWN (or SUBMITTING) rather than a guess.
 */
function displayState(r: AssetRecoveryView, op: AssetOperation | null): string {
  if (op && r.state === "CHALLENGE_PERIOD" && (op.state === "SUBMITTING" || op.state === "UNKNOWN"))
    return op.state;
  if (op?.state === "REVIEW") return "REVIEW";
  return r.state;
}

export function assetRoutes(d: AppDeps): Route[] {
  const r = route;
  const audit = (
    ctx: AuthContext,
    eventType: string,
    t: TradeTerms,
    rid: string,
    extra: Record<string, string> = {},
  ) =>
    new AuditLog(d.db, d.clock, d.ids).append({
      eventType,
      organizationId: ctx.organizationId,
      actorPrincipalId: ctx.principal.id,
      actorKeyVersionId: ctx.keyVersion.id,
      sessionId: ctx.session.id,
      subjectType: "asset_recovery",
      subjectId: rid,
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
  const recordSignature = (
    t: TradeTerms,
    rid: string,
    kind: "APPROVAL" | "CHALLENGE" | "REVOKE",
    role: RefundRole,
    v: { principalId: string; keyVersionId: string },
    purpose: SigningPurpose,
    payload: CanonicalValue,
    signature: string,
  ) =>
    d.db.run(
      `INSERT INTO asset_recovery_signatures (id, recovery_id, trade_id, kind, signer_role, signer_principal, key_version_id, digest, payload_json, signature, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      d.ids.next("ars"),
      rid,
      t.tradeId,
      kind,
      role,
      v.principalId,
      v.keyVersionId,
      digestHexFor(purpose, payload),
      JSON.stringify(toTypedJson(payload)),
      signature,
      d.clock.now(),
    );
  /** Session, capability, trade relation and bound role for every POST on a recovery. */
  const entry = (ctx: AuthContext | null, params: Record<string, string>) => {
    const c = must(ctx);
    act(c, "SIGN_REFUND_REQUEST");
    const m = mods(d);
    const am = asset(m);
    const t = loadTrade(m, c, params["id"] as string);
    const role = refundRole(c, t);
    return { c, m, am, t, role, rid: params["rid"] as string };
  };
  const base = "/v1/trades/:id/asset-recoveries/:rid";

  return [
    /** Every unexpected-asset record on the contract, with this trade's recoveries and journal. */
    r("GET", "/v1/trades/:id/asset-recoveries", true, undefined, async ({ ctx, params }) => {
      const c = must(ctx);
      const m = mods(d);
      const am = asset(m);
      const t = loadTrade(m, c, params["id"] as string);
      let viewerRole: RefundRole | null = null;
      try {
        viewerRole = refundRole(c, t);
      } catch (e) {
        if (!(e instanceof DocksideError)) throw e;
      }
      const assets = (await allAssets(m)).map((a) => {
        const ops = am.journal.forAsset(a.index);
        return {
          ...a,
          recoveries: a.recoveries.map((x) => {
            if (x.tradeId !== t.tradeId)
              // Another trade governs this one: show only that it exists and its contract state.
              return {
                recoveryId: x.recoveryId,
                governedHere: false,
                state: x.state,
                displayState: x.state,
                deadline: x.deadline,
              };
            const op = am.journal.forRecovery(x.recoveryId);
            const req = journaledRequest(d, x.recoveryId);
            return {
              ...x,
              governedHere: true,
              displayState: displayState(x, op),
              payloadJournaled: req !== null && req.requestDigest === x.requestDigest,
              evidence: req?.evidence ?? null,
              validation: latestValidation(d, x.recoveryId),
              operations: ops.filter((o) => o.recoveryId === x.recoveryId).map(opSummary),
            };
          }),
        };
      });
      return {
        tradeId: t.tradeId,
        escrowContractId: m.escrow.contractId,
        policy: { id: "dockside-refund-v1", revision: 1, row: ASSET_RECOVERY_POLICY_ROW },
        adapters: RECOVERY_ADAPTERS,
        challengeWindowMs: ASSET_RECOVERY_CHALLENGE_MS,
        assets,
        viewerRole,
        source: "escrow-contract-view",
        note: "Unexpected assets are never native-NEAR funding and never appear in the refund ledger.",
        observedAt: d.clock.now(),
      };
    }),

    /**
     * Prepare the claimed sender's request (recipient = that sender). A trade party prepares it;
     * only the sender's own account can submit it, which is the proof of control.
     */
    r(
      "POST",
      "/v1/trades/:id/asset-recovery-requests",
      true,
      z
        .object({ assetIndex: z.number().int().min(0).max(1_000_000), transferTxHash: txHash.optional() })
        .strict(),
      async ({ ctx, params, body }) => {
        const c = must(ctx);
        act(c, "SIGN_REFUND_REQUEST");
        const m = mods(d);
        const am = asset(m);
        const t = loadTrade(m, c, params["id"] as string);
        const role = refundRole(c, t);
        allow(role === "BUYER" || role === "SUPPLIER", "a trade party prepares the claimed sender's request");
        const b = body as { assetIndex: number; transferTxHash?: string };
        const a = (await allAssets(m)).find((x) => x.index === b.assetIndex);
        if (!a) return fail("NOT_FOUND", "no unexpected asset with this index");
        if (a.recoveryCapability === null)
          fail(
            "ADAPTER_UNSAFE",
            `no safe recovery adapter exists for ${a.standard}; the asset stays in review`,
          );
        if (a.state !== "ASSET_RECOVERY_REVIEW")
          fail("INVALID_STATE", `the asset is ${a.state}; a new request needs it back in review`);
        // Transfer evidence: the sender's own transaction delivered exactly this record.
        let transfer: Record<string, unknown> | null = null;
        if (b.transferTxHash) {
          if (!am.tx) fail("NOT_FOUND", "transaction lookup is not configured");
          const o = await am.tx.status(b.transferTxHash, a.claimedSender);
          const hit =
            o.kind === "FINAL_SUCCESS" &&
            (o.receipts ?? []).some((x) =>
              x.calls.some((cl) => {
                if (cl.method !== "ft_on_transfer") return false;
                try {
                  const args = JSON.parse(cl.args) as Record<string, unknown>;
                  return (
                    x.receiverId === m.escrow.contractId &&
                    x.predecessorId === a.assetContract &&
                    args["sender_id"] === a.claimedSender &&
                    args["amount"] === a.observedAmount
                  );
                } catch {
                  return false;
                }
              }),
            );
          if (!hit)
            fail(
              "VALIDATION_FAILED",
              "that transaction does not show this asset arriving from the claimed sender",
            );
          transfer = {
            txHash: b.transferTxHash,
            signerId: a.claimedSender,
            status: "FINAL_SUCCESS",
            verified: true,
          };
        }
        const evidence = {
          schema: "dockside/asset-recovery-evidence@1",
          network: t.network,
          escrowContractId: m.escrow.contractId,
          assetIndex: a.index,
          standard: a.standard,
          assetContract: a.assetContract,
          tokenId: a.tokenId,
          observedAmount: a.observedAmount,
          claimedSender: a.claimedSender,
          msgDigest: a.msgDigest,
          observedAt: a.observedAt,
          transferTxHash: transfer ? String(transfer["txHash"]) : null,
          transferVerified: transfer !== null,
        };
        const evidenceDigest = digestHexFor("ASSET_RECOVERY_EVIDENCE", evidence as CanonicalValue);
        const recoveryId = d.ids.next("arc");
        const now = d.clock.now();
        const payload = assetRecoveryRequestPayload(tradeBinding(t), {
          recoveryId,
          assetIndex: a.index,
          standard: a.standard,
          assetContract: a.assetContract,
          tokenId: a.tokenId,
          amount: a.observedAmount,
          claimedSender: a.claimedSender,
          evidenceDigest,
          issuedAt: now,
          expiresAt: now + REQUEST_LIFETIME_MS,
          nonce: newNonce(),
        });
        const digest = digestHexFor("ASSET_RECOVERY_REQUEST", payload);
        const tj = toTypedJson(payload);
        d.db.run(
          `INSERT INTO asset_recovery_requests (recovery_id, asset_index, trade_id, trade_revision, standard, asset_contract, amount,
             claimed_sender, evidence_json, evidence_digest, request_json, request_digest, prepared_by, prepared_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          recoveryId,
          a.index,
          t.tradeId,
          t.revision,
          a.standard,
          a.assetContract,
          a.observedAmount,
          a.claimedSender,
          JSON.stringify(evidence),
          evidenceDigest,
          JSON.stringify(tj),
          digest,
          c.principal.id,
          now,
          now + REQUEST_LIFETIME_MS,
        );
        audit(c, "ASSET_RECOVERY_REQUEST_PREPARED", t, recoveryId, {
          assetIndex: String(a.index),
          assetContract: a.assetContract,
          transferVerified: String(transfer !== null),
        });
        return {
          recoveryId,
          assetIndex: a.index,
          recipient: a.claimedSender,
          amount: a.observedAmount,
          purpose: "ASSET_RECOVERY_REQUEST",
          payload: tj,
          digest,
          evidence,
          evidenceDigest,
          // Only the claimed sender's own account can submit this; the contract checks the caller.
          senderWallet: {
            signerId: a.claimedSender,
            call: m.escrow.requestAssetRecoveryCall(a.index, t.tradeId, tj),
          },
        };
      },
    ),

    /** Read-only adapter validation, journaled, and the approval payload that signs over it. */
    r("POST", `${base}/approval-challenges`, true, empty, async ({ ctx, params }) => {
      const { c, m, am, t, role, rid } = entry(ctx, params);
      allow(role === "RISK_RESOLVER", "only the bound risk/policy resolver approves an asset recovery");
      const { a, r: rec } = await governed(m, t, rid);
      inState(rec, ["REQUESTED"], "only a requested recovery can be approved");
      const token = am.token(a.assetContract);
      const [balance, registered, metadata] = await Promise.all([
        token.balanceOf(m.escrow.contractId),
        token.isRegistered(rec.recipient),
        token.metadata(),
      ]);
      const outstanding = (await allAssets(m))
        .filter(
          (x) => x.assetContract === a.assetContract && x.standard === a.standard && x.state !== "RECOVERED",
        )
        .reduce((s, x) => s + BigInt(x.observedAmount), 0n);
      const checks = {
        adapterCompiled: rec.recoveryCapability === "NEP141_FT_TRANSFER",
        balanceCoversOutstanding: balance >= outstanding,
        balanceCoversRecovery: balance >= BigInt(rec.amount),
        recipientRegistered: registered,
        recipientIsClaimedSender: rec.recipient === a.claimedSender,
      };
      const verdict = Object.values(checks).every(Boolean) ? "SAFE" : "UNSAFE";
      const now = d.clock.now();
      const report = {
        schema: "dockside/asset-recovery-validation@1",
        recoveryId: rid,
        requestDigest: rec.requestDigest,
        assetIndex: a.index,
        standard: a.standard,
        assetContract: a.assetContract,
        recoveryCapability: rec.recoveryCapability,
        amount: rec.amount,
        recipient: rec.recipient,
        escrowAccount: m.escrow.contractId,
        escrowTokenBalance: balance.toString(10),
        outstandingObservedTotal: outstanding.toString(10),
        tokenSymbol: metadata.symbol,
        tokenDecimals: metadata.decimals,
        checks,
        verdict,
        observedAt: now,
      };
      const reportDigest = digestHexFor("ASSET_RECOVERY_VALIDATION", report as CanonicalValue);
      d.db.run(
        `INSERT INTO asset_recovery_validations (id, recovery_id, report_json, report_digest, verdict, observed_by, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        d.ids.next("arv"),
        rid,
        JSON.stringify(report),
        reportDigest,
        verdict,
        c.principal.id,
        now,
      );
      audit(c, "ASSET_RECOVERY_VALIDATED", t, rid, { verdict });
      if (verdict !== "SAFE")
        fail("ADAPTER_UNSAFE", "read-only validation failed; the asset stays in review", {
          checks: Object.entries(checks)
            .filter(([, v]) => !v)
            .map(([k]) => k)
            .join(","),
        });
      const payload = assetRecoveryApprovalPayload(tradeBinding(t), {
        recoveryId: rid,
        requestDigest: rec.requestDigest,
        assetIndex: a.index,
        amount: rec.amount,
        recipient: rec.recipient,
        recoveryCapability: rec.recoveryCapability,
        validationDigest: reportDigest,
        issuedAt: now,
        expiresAt: now + HOUR,
        nonce: newNonce(),
      });
      return {
        purpose: "ASSET_RECOVERY_APPROVAL",
        payload: toTypedJson(payload),
        digest: digestHexFor("ASSET_RECOVERY_APPROVAL", payload),
        validation: { report, digest: reportDigest },
      };
    }),
    r("POST", `${base}/approval`, true, signed, async ({ ctx, params, body }) => {
      const { c, m, t, role, rid } = entry(ctx, params);
      allow(role === "RISK_RESOLVER", "only the bound risk/policy resolver approves an asset recovery");
      const { a, r: rec } = await governed(m, t, rid);
      inState(rec, ["REQUESTED"], "only a requested recovery can be approved");
      const b = body as { payload: unknown; signature: string };
      const payload = canonical(b.payload);
      if (field(payload, "recoveryId") !== rid || field(payload, "tradeId") !== t.tradeId)
        fail("VALIDATION_FAILED", "approval names a different recovery");
      if (field(payload, "requestDigest") !== rec.requestDigest)
        fail("VALIDATION_FAILED", "approval names a different request digest");
      const v = latestValidation(d, rid);
      if (!v || v.verdict !== "SAFE" || field(payload, "validationDigest") !== v.digest)
        fail("VALIDATION_FAILED", "approval must sign the latest SAFE read-only validation of this recovery");
      if (d.clock.now() - v.observedAt > VALIDATION_MAX_AGE_MS)
        fail("EXPIRED", "the validation is older than one hour; validate again");
      const verified = verify(t, role, "ASSET_RECOVERY_APPROVAL", payload, b.signature);
      recordSignature(t, rid, "APPROVAL", role, verified, "ASSET_RECOVERY_APPROVAL", payload, b.signature);
      audit(c, "ASSET_RECOVERY_APPROVAL_SIGNED", t, rid, { assetIndex: String(a.index) });
      return {
        relay: m.escrow.approveAssetRecoveryCall(a.index, t.tradeId, toTypedJson(payload), b.signature),
      };
    }),

    /**
     * A challenge in the caller's own bound role, or (with `claimantAccount`) the unsigned call for
     * another claimant's own wallet.
     */
    r(
      "POST",
      `${base}/challenge-payloads`,
      true,
      z
        .object({ reasonCode: codeSchema, evidenceDigest: hex64, claimantAccount: account.optional() })
        .strict(),
      async ({ ctx, params, body }) => {
        const { c, m, t, role, rid } = entry(ctx, params);
        const { a, r: rec } = await governed(m, t, rid);
        inState(rec, ["REQUESTED", "CHALLENGE_PERIOD"], "the challenge window is closed");
        const b = body as { reasonCode: string; evidenceDigest: string; claimantAccount?: string };
        if (b.claimantAccount === rec.recipient)
          fail("FORBIDDEN", "the recipient cannot challenge its own recovery");
        const now = d.clock.now();
        const payload = assetRecoveryChallengePayload(tradeBinding(t), {
          recoveryId: rid,
          requestDigest: rec.requestDigest,
          challengerRole: b.claimantAccount ? "CLAIMANT" : role,
          challengerAccount: b.claimantAccount ?? null,
          reasonCode: b.reasonCode,
          evidenceDigest: b.evidenceDigest,
          issuedAt: now,
          expiresAt: now + HOUR,
          nonce: newNonce(),
        });
        const tj = toTypedJson(payload);
        const out = {
          purpose: "ASSET_RECOVERY_CHALLENGE",
          payload: tj,
          digest: digestHexFor("ASSET_RECOVERY_CHALLENGE", payload),
        };
        if (b.claimantAccount) {
          audit(c, "ASSET_RECOVERY_CLAIMANT_CHALLENGE_PREPARED", t, rid, { claimant: b.claimantAccount });
          return {
            ...out,
            claimantWallet: {
              signerId: b.claimantAccount,
              call: m.escrow.challengeAssetRecoveryCall(a.index, t.tradeId, tj, null),
            },
          };
        }
        return out;
      },
    ),
    r("POST", `${base}/challenge`, true, signed, async ({ ctx, params, body }) => {
      const { c, m, t, role, rid } = entry(ctx, params);
      const { a, r: rec } = await governed(m, t, rid);
      inState(rec, ["REQUESTED", "CHALLENGE_PERIOD"], "the challenge window is closed");
      const b = body as { payload: unknown; signature: string };
      const payload = canonical(b.payload);
      if (field(payload, "recoveryId") !== rid || field(payload, "tradeId") !== t.tradeId)
        fail("VALIDATION_FAILED", "challenge names a different recovery");
      if (field(payload, "challengerRole") !== role)
        fail("FORBIDDEN", "a party challenges only in its own role");
      const verified = verify(t, role, "ASSET_RECOVERY_CHALLENGE", payload, b.signature);
      recordSignature(t, rid, "CHALLENGE", role, verified, "ASSET_RECOVERY_CHALLENGE", payload, b.signature);
      audit(c, "ASSET_RECOVERY_CHALLENGE_SIGNED", t, rid, {
        role,
        reasonCode: String(field(payload, "reasonCode")),
      });
      return {
        relay: m.escrow.challengeAssetRecoveryCall(a.index, t.tradeId, toTypedJson(payload), b.signature),
      };
    }),

    /** Risk/policy revokes with its key; a trade party prepares the claimed sender's own revocation. */
    r("POST", `${base}/revocation-challenges`, true, empty, async ({ ctx, params }) => {
      const { c, m, t, role, rid } = entry(ctx, params);
      const { a, r: rec } = await governed(m, t, rid);
      inState(rec, ["REQUESTED", "CHALLENGE_PERIOD"], "revocation is allowed only before execution");
      const revokerRole = role === "RISK_RESOLVER" ? "RISK_RESOLVER" : "CLAIMED_SENDER";
      const now = d.clock.now();
      const payload = assetRecoveryRevokePayload(tradeBinding(t), {
        recoveryId: rid,
        requestDigest: rec.requestDigest,
        revokerRole,
        issuedAt: now,
        expiresAt: now + HOUR,
        nonce: newNonce(),
      });
      const tj = toTypedJson(payload);
      const out = {
        purpose: "ASSET_RECOVERY_REVOKE",
        payload: tj,
        digest: digestHexFor("ASSET_RECOVERY_REVOKE", payload),
        revokerRole,
      };
      if (revokerRole === "CLAIMED_SENDER") {
        audit(c, "ASSET_RECOVERY_SENDER_REVOCATION_PREPARED", t, rid);
        return {
          ...out,
          senderWallet: {
            signerId: rec.recipient,
            call: m.escrow.revokeAssetRecoveryCall(a.index, t.tradeId, tj, null),
          },
        };
      }
      return out;
    }),
    r("POST", `${base}/revocation`, true, signed, async ({ ctx, params, body }) => {
      const { c, m, t, role, rid } = entry(ctx, params);
      allow(
        role === "RISK_RESOLVER",
        "only the risk/policy resolver revokes with a key; the sender revokes from its account",
      );
      const { a, r: rec } = await governed(m, t, rid);
      inState(rec, ["REQUESTED", "CHALLENGE_PERIOD"], "revocation is allowed only before execution");
      const b = body as { payload: unknown; signature: string };
      const payload = canonical(b.payload);
      if (field(payload, "recoveryId") !== rid || field(payload, "tradeId") !== t.tradeId)
        fail("VALIDATION_FAILED", "revocation names a different recovery");
      if (field(payload, "revokerRole") !== "RISK_RESOLVER")
        fail("FORBIDDEN", "the risk/policy resolver revokes in its own role");
      const verified = verify(t, role, "ASSET_RECOVERY_REVOKE", payload, b.signature);
      recordSignature(t, rid, "REVOKE", role, verified, "ASSET_RECOVERY_REVOKE", payload, b.signature);
      audit(c, "ASSET_RECOVERY_REVOCATION_SIGNED", t, rid);
      return {
        relay: m.escrow.revokeAssetRecoveryCall(a.index, t.tradeId, toTypedJson(payload), b.signature),
      };
    }),

    /**
     * Queue the one execution transaction in the asset-recovery journal. The contract checks its own
     * clock against the 72-hour deadline; the API does not pre-judge time.
     */
    r("POST", `${base}/execute`, true, empty, async ({ ctx, params }) => {
      const { c, m, am, t, rid } = entry(ctx, params);
      const { a, r: rec } = await governed(m, t, rid);
      inState(rec, ["CHALLENGE_PERIOD"], "only an approved, unchallenged recovery can be executed");
      if (rec.challenge) fail("INVALID_STATE", "a challenged recovery stays in review");
      const out = am.journal.enqueue({
        recoveryId: rid,
        assetIndex: a.index,
        assetContract: a.assetContract,
        recipient: rec.recipient,
        amount: BigInt(rec.amount),
        call: m.escrow.executeAssetRecoveryCall(a.index, rid),
        requestedBy: c.principal.id,
      });
      audit(c, "ASSET_RECOVERY_EXECUTION_REQUESTED", t, rid, { operationId: out.operationId });
      return { ...out, state: am.journal.op(out.operationId).state };
    }),
  ];
}
