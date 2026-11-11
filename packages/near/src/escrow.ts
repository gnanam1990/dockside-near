import { fail, parseNearAccountId, parseWith, type TypedJson } from "@dockside/core";
import { z } from "zod";
import type { NearRpc, ViewResult } from "./rpc.js";

/**
 * Typed client for the Dockside escrow contract (contract/crates/dockside-escrow).
 *
 * Views go through `NearRpc` and are schema-validated; they are observations of authoritative
 * contract state, never a substitute for it. Mutations are returned as unsigned function-call
 * descriptions for the acting party's own wallet to sign; this service never holds party keys.
 */
const u128 = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,38})$/)
  .transform((s) => BigInt(s));

const funderSchema = z
  .object({
    funded: u128,
    partial: u128,
    available: u128,
    reserved: u128,
    released: u128,
    refundLocked: u128,
    refunded: u128,
    quarantined: u128,
    fees: u128,
    excessDetectedAt: z.number().int().nullable(),
  })
  .strict();

export const ledgerSchema = z
  .object({
    asset: z.object({ kind: z.literal("NEAR_NATIVE"), network: z.string() }).strict(),
    required: u128,
    committed: u128,
    fullyFunded: z.boolean(),
    totals: funderSchema,
    funders: z.record(z.string(), funderSchema),
    deposits: z.array(
      z
        .object({
          index: z.number().int(),
          funder: z.string(),
          amount: u128,
          accepted: u128,
          quarantined: u128,
          atMs: z.number().int(),
        })
        .strict(),
    ),
    conservation: z.boolean(),
  })
  .strict();

export const tradeViewSchema = z
  .object({
    tradeId: z.string(),
    revision: z.number().int(),
    termsDigest: z.string(),
    network: z.string(),
    buyerAccount: z.string(),
    supplierAccount: z.string(),
    payoutDestination: z.string(),
    amountYocto: u128,
    expiresAt: z.number().int(),
    registeredAt: z.number().int(),
    revokedRoles: z.array(z.string()),
    blockingHolds: z.number().int(),
    currentManifestDigest: z.string().nullable(),
    ledger: ledgerSchema,
  })
  .passthrough();

export const refundViewSchema = z.array(
  z
    .object({
      refundIntentId: z.string(),
      reason: z.string(),
      funder: z.string(),
      amount: u128,
      sourceBucket: z.enum(["PARTIAL", "AVAILABLE", "QUARANTINED"]),
      state: z.string(),
      requestDigest: z.string(),
      initiatorRole: z.string(),
      buyerSigned: z.boolean(),
      supplierSigned: z.boolean(),
      clockOrigin: z.number().int().nullable(),
      deadline: z.number().int().nullable(),
      requestedAt: z.number().int(),
      dispute: z.object({ role: z.string(), at: z.number().int(), digest: z.string() }).strict().nullable(),
      history: z.array(z.tuple([z.string(), z.number().int()])),
      basis: z.string().nullable(),
      riskSigned: z.boolean(),
    })
    .strict(),
);

export const holdViewSchema = z.array(
  z
    .object({
      holdId: z.string(),
      status: z.enum(["ACTIVE", "EXPIRED_UNRESOLVED", "RESOLVED"]),
      reasonCode: z.string(),
      issuerRole: z.enum(["POLICY_SETTER", "RISK_RESOLVER"]),
      ruleId: z.string().nullable(),
      manifestDigest: z.string().nullable(),
      issuedAt: z.number().int(),
      expiresAt: z.number().int(),
      recordedAt: z.number().int(),
      setDigest: z.string(),
      resolution: z
        .object({
          code: z.string(),
          evidenceDigest: z.string(),
          resolvedAt: z.number().int(),
          digest: z.string(),
        })
        .strict()
        .nullable(),
    })
    .strict(),
);

const manifestViewSchema = z
  .object({
    revision: z.number().int(),
    digest: z.string(),
    attestationDigest: z.string(),
    acceptedAt: z.number().int(),
    expiresAt: z.number().int(),
    minFreshUntil: z.number().int(),
    items: z.array(z.string()),
    status: z.enum(["VALID", "SUPERSEDED", "INVALIDATED"]),
    consumed: z.boolean(),
  })
  .strict();

/** Contract view of the EvidencePolicy, the accepted manifest, its history and the inspection. */
export const evidenceViewSchema = z
  .object({
    policy: z
      .object({
        policyId: z.string(),
        revision: z.number().int(),
        digest: z.string(),
        attestationLifetimeMs: z.number().int(),
        slots: z.array(
          z
            .object({
              slotId: z.string(),
              digest: z.string(),
              minItems: z.number().int(),
              maxItems: z.number().int(),
            })
            .strict(),
        ),
      })
      .strict()
      .nullable(),
    current: manifestViewSchema.nullable(),
    usable: z.boolean(),
    history: z.array(manifestViewSchema),
    inspection: z
      .object({
        decision: z.enum(["PASS", "FAIL", "REVIEW"]),
        reasonCodes: z.array(z.string()),
        manifestDigest: z.string(),
        manifestRevision: z.number().int(),
        digest: z.string(),
        recordedAt: z.number().int(),
        expiresAt: z.number().int(),
        invalidated: z.boolean(),
      })
      .strict()
      .nullable(),
    currentInspectionDecision: z.enum(["PASS", "FAIL", "REVIEW"]).nullable(),
  })
  .strict();

export const RELEASE_INTENT_STATES = [
  "VALUE_LOCKED",
  "DIRECT_TESTNET_AUTHORIZED",
  "FUNDED_AUTHORIZATION_REQUIRED",
  "FUNDED_AUTHORIZED",
  "SUBMITTING",
  "PROCESSING",
  "UNKNOWN",
  "REVIEW",
  "RECONCILING",
  "ADJUDICATION",
  "PAID",
  "REFUNDED",
  "FAILED",
  "CANCELLED_PRE_SUBMIT",
  "ABANDONED_PRE_SUBMIT",
  "SUPERSEDED_PRE_SUBMIT",
] as const;
export type ReleaseIntentState = (typeof RELEASE_INTENT_STATES)[number];

const releaseIntentViewSchema = z
  .object({
    releaseIntentId: z.string(),
    tradeRevision: z.number().int(),
    termsDigest: z.string(),
    requestDigest: z.string(),
    amount: u128,
    slices: z.array(z.object({ funder: z.string(), amount: u128 }).strict()),
    sourceBucket: z.literal("AVAILABLE"),
    destination: z.string(),
    executionProfile: z.string(),
    state: z.enum(RELEASE_INTENT_STATES),
    stateVersion: z.number().int(),
    createdAt: z.number().int(),
    expiresAt: z.number().int(),
    approval: z
      .object({
        digest: z.string(),
        approvedAt: z.number().int(),
        expiresAt: z.number().int(),
        manifestRevision: z.number().int(),
        manifestDigest: z.string(),
        attestationDigest: z.string(),
        inspectionDigest: z.string(),
        holdsViewDigest: z.string(),
      })
      .strict()
      .nullable(),
    pendingCancel: z
      .object({
        digest: z.string(),
        reasonCode: z.string(),
        expiresAt: z.number().int(),
        consents: z.array(
          z
            .object({
              role: z.enum(["BUYER_APPROVER", "SUPPLIER_SIGNER"]),
              expiresAt: z.number().int(),
              recordedAt: z.number().int(),
              revoked: z.boolean(),
              digest: z.string(),
            })
            .strict(),
        ),
      })
      .strict()
      .nullable(),
    exitDigest: z.string().nullable(),
    predecessor: z.string().nullable(),
    successor: z.string().nullable(),
    attempts: z.array(z.string()),
    consumedManifest: z.string().nullable(),
    history: z.array(z.tuple([z.string(), z.number().int()])),
  })
  .strict();

const destinationChangeViewSchema = z
  .object({
    successorDigest: z.string(),
    successorRevision: z.number().int(),
    fromDestination: z.string(),
    toDestination: z.string(),
    proposedBy: z.enum(["BUYER", "SUPPLIER"]),
    proposedAt: z.number().int(),
    consentDeadline: z.number().int(),
    buyerConsentAt: z.number().int().nullable(),
    supplierConsentAt: z.number().int().nullable(),
    delayUntil: z.number().int().nullable(),
    status: z.enum(["PROPOSED", "CONSENTED", "ACTIVATED", "REVOKED", "EXPIRED"]),
    closedAt: z.number().int().nullable(),
    supersededIntent: z.string().nullable(),
    successorIntent: z.string().nullable(),
  })
  .strict();

/** Contract view of release intents, the live value lock, release blockers and destination changes. */
export const releaseViewSchema = z
  .object({
    tradeId: z.string(),
    revision: z.number().int(),
    termsDigest: z.string(),
    payoutDestination: z.string(),
    liveIntent: z.string().nullable(),
    blockers: z.array(z.string()),
    holdsViewDigest: z.string().nullable(),
    intents: z.array(releaseIntentViewSchema),
    revisions: z.array(
      z.object({ revision: z.number().int(), digest: z.string(), activatedAt: z.number().int() }).strict(),
    ),
    pendingDestinationChange: destinationChangeViewSchema.nullable(),
    destinationHistory: z.array(destinationChangeViewSchema),
    abandonPolicy: z
      .object({ id: z.literal("dockside-abandon-v1"), revision: z.literal(1), graceMs: z.number().int() })
      .strict(),
  })
  .strict();
export type ReleaseView = z.output<typeof releaseViewSchema>;

export const unexpectedAssetSchema = z.array(
  z
    .object({
      index: z.number().int(),
      standard: z.enum(["NEP-141", "NEP-171", "NEP-245"]),
      assetContract: z.string(),
      tokenId: z.string().nullable(),
      observedAmount: z.string(),
      claimedSender: z.string(),
      msgDigest: z.string(),
      observedAt: z.number().int(),
      state: z.literal("ASSET_RECOVERY_REVIEW"),
      originalFunder: z.null(),
      withdrawable: z.literal(false),
    })
    .strict(),
);

/** An unsigned contract call for the acting party's wallet to sign and submit. */
export interface FunctionCall {
  readonly receiverId: string;
  readonly methodName: string;
  readonly args: Record<string, unknown>;
  readonly gas: string;
  readonly depositYocto: string;
}

const TGAS = 1_000_000_000_000n;

export class EscrowContract {
  readonly contractId: string;

  constructor(
    private readonly rpc: NearRpc,
    contractId: string,
  ) {
    this.contractId = parseNearAccountId(contractId, {});
  }

  private async view<T>(method: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    const r: ViewResult = await this.rpc.callView(this.contractId, method, args);
    return parseWith(schema, r.value);
  }

  getTrade(tradeId: string) {
    return this.view("get_trade", { trade_id: tradeId }, tradeViewSchema);
  }
  getLedger(tradeId: string) {
    return this.view("get_ledger", { trade_id: tradeId }, ledgerSchema);
  }
  getRefunds(tradeId: string) {
    return this.view("get_refunds", { trade_id: tradeId }, refundViewSchema);
  }
  getHolds(tradeId: string) {
    return this.view("get_holds", { trade_id: tradeId }, holdViewSchema);
  }
  getEvidence(tradeId: string) {
    return this.view("get_evidence", { trade_id: tradeId }, evidenceViewSchema);
  }
  getRelease(tradeId: string) {
    return this.view("get_release", { trade_id: tradeId }, releaseViewSchema);
  }
  getUnexpectedAssets(fromIndex = 0, limit = 50) {
    return this.view("get_unexpected_assets", { from_index: fromIndex, limit }, unexpectedAssetSchema);
  }

  private call(
    methodName: string,
    args: Record<string, unknown>,
    tgas = 50n,
    depositYocto = 0n,
  ): FunctionCall {
    if (depositYocto < 0n) fail("INVALID_AMOUNT", "deposit cannot be negative");
    return {
      receiverId: this.contractId,
      methodName,
      args,
      gas: String(tgas * TGAS),
      depositYocto: String(depositYocto),
    };
  }

  registerTradeCall(terms: TypedJson, buyerSignature: string, supplierSignature: string): FunctionCall {
    return this.call(
      "register_trade",
      { terms, buyer_signature: buyerSignature, supplier_signature: supplierSignature },
      100n,
    );
  }

  /** Native NEAR deposit from the signing wallet; that account becomes the deposit's original funder. */
  fundCall(tradeId: string, amountYocto: bigint): FunctionCall {
    if (amountYocto <= 0n) fail("INVALID_AMOUNT", "deposit must be positive");
    return this.call("fund", { trade_id: tradeId }, 30n, amountYocto);
  }

  /** Store the EvidencePolicy whose digest the registered revision binds (anyone may relay it). */
  registerEvidencePolicyCall(tradeId: string, policy: TypedJson): FunctionCall {
    return this.call("register_evidence_policy", { trade_id: tradeId, policy }, 100n);
  }

  /** ManifestAttestation signed by the bound attestor; the contract recomputes every predicate. */
  submitManifestAttestationCall(tradeId: string, payload: TypedJson, signature: string): FunctionCall {
    return this.call("submit_manifest_attestation", { trade_id: tradeId, payload, signature }, 200n);
  }

  submitInspectionCall(tradeId: string, payload: TypedJson, signature: string): FunctionCall {
    return this.call("submit_inspection", { trade_id: tradeId, payload, signature });
  }

  setHoldCall(tradeId: string, payload: TypedJson, signature: string): FunctionCall {
    return this.call("set_hold", { trade_id: tradeId, payload, signature });
  }

  resolveHoldCall(tradeId: string, payload: TypedJson, signature: string): FunctionCall {
    return this.call("resolve_hold", { trade_id: tradeId, payload, signature });
  }

  revokeBoundKeyCall(tradeId: string, payload: TypedJson, signature: string): FunctionCall {
    return this.call("revoke_bound_key", { trade_id: tradeId, payload, signature });
  }

  requestRefundCall(
    tradeId: string,
    payload: TypedJson,
    sigs: { buyer?: string; supplier?: string; risk?: string } = {},
  ): FunctionCall {
    return this.call("request_refund", {
      trade_id: tradeId,
      payload,
      buyer_signature: sigs.buyer ?? null,
      supplier_signature: sigs.supplier ?? null,
      risk_signature: sigs.risk ?? null,
    });
  }

  /** INSPECTION_FAIL authorization signed by the bound risk/policy key. */
  authorizeRefundSignedCall(tradeId: string, payload: TypedJson, signature: string): FunctionCall {
    return this.call("authorize_refund_signed", { trade_id: tradeId, payload, signature });
  }

  /* ----------------------- release and destination (M04) ----------------------- */

  createReleaseIntentCall(tradeId: string, payload: TypedJson, buyerSignature: string): FunctionCall {
    return this.call("create_release_intent", {
      trade_id: tradeId,
      payload,
      buyer_signature: buyerSignature,
    });
  }

  approveReleaseCall(tradeId: string, payload: TypedJson, signature: string): FunctionCall {
    return this.call("approve_release", { trade_id: tradeId, payload, signature });
  }

  /** Permissionless relay: the contract rechecks the whole release conjunction itself. */
  executeReleaseCall(tradeId: string, releaseIntentId: string): FunctionCall {
    return this.call("execute_release", { trade_id: tradeId, release_intent_id: releaseIntentId }, 100n);
  }

  submitCancelConsentCall(
    tradeId: string,
    cancel: TypedJson,
    consent: TypedJson,
    signature: string,
  ): FunctionCall {
    return this.call("submit_cancel_consent", { trade_id: tradeId, cancel, consent, signature });
  }

  revokeCancelConsentCall(tradeId: string, payload: TypedJson, signature: string): FunctionCall {
    return this.call("revoke_cancel_consent", { trade_id: tradeId, payload, signature });
  }

  abandonReleaseIntentCall(tradeId: string, payload: TypedJson, signature: string): FunctionCall {
    return this.call("abandon_release_intent", { trade_id: tradeId, payload, signature });
  }

  proposeDestinationChangeCall(
    tradeId: string,
    successorTerms: TypedJson,
    proposerRole: "BUYER" | "SUPPLIER",
    signature: string,
  ): FunctionCall {
    return this.call(
      "propose_destination_change",
      { trade_id: tradeId, successor_terms: successorTerms, proposer_role: proposerRole, signature },
      100n,
    );
  }

  consentDestinationChangeCall(
    tradeId: string,
    successorDigest: string,
    role: "BUYER" | "SUPPLIER",
    signature: string,
  ): FunctionCall {
    return this.call("consent_destination_change", {
      trade_id: tradeId,
      successor_digest: successorDigest,
      role,
      signature,
    });
  }

  revokeDestinationChangeCall(tradeId: string, payload: TypedJson, signature: string): FunctionCall {
    return this.call("revoke_destination_change", { trade_id: tradeId, payload, signature });
  }

  activateDestinationChangeCall(tradeId: string, successorDigest: string): FunctionCall {
    return this.call(
      "activate_destination_change",
      { trade_id: tradeId, successor_digest: successorDigest },
      100n,
    );
  }

  cosignRefundCall(tradeId: string, refundIntentId: string, role: "BUYER" | "SUPPLIER", signature: string) {
    return this.call("cosign_refund", {
      trade_id: tradeId,
      refund_intent_id: refundIntentId,
      role,
      signature,
    });
  }

  revokeRefundCall(tradeId: string, payload: TypedJson, signature: string | null): FunctionCall {
    return this.call("revoke_refund", { trade_id: tradeId, payload, signature });
  }

  disputeRefundCall(tradeId: string, payload: TypedJson, signature: string): FunctionCall {
    return this.call("dispute_refund", { trade_id: tradeId, payload, signature });
  }

  authorizeRefundCall(tradeId: string, refundIntentId: string): FunctionCall {
    return this.call("authorize_refund", { trade_id: tradeId, refund_intent_id: refundIntentId });
  }

  executeRefundCall(tradeId: string, refundIntentId: string): FunctionCall {
    return this.call("execute_refund", { trade_id: tradeId, refund_intent_id: refundIntentId }, 100n);
  }
}
