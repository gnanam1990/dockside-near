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
    sigs: { buyer?: string; supplier?: string } = {},
  ): FunctionCall {
    return this.call("request_refund", {
      trade_id: tradeId,
      payload,
      buyer_signature: sigs.buyer ?? null,
      supplier_signature: sigs.supplier ?? null,
    });
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
