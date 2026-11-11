import type { KeyObject } from "node:crypto";
import {
  type CanonicalValue,
  digestHexFor,
  REFUND_POLICY_ID,
  type SigningPurpose,
  signFor,
  type TradeTerms,
  type TypedJson,
  toTypedJson,
  tradeRevisionDigest,
  tradeTermsCanonical,
} from "@dockside/core";

/**
 * Canonical payloads the escrow contract verifies. The contract receives the typed-JSON form,
 * recomputes the DCE-1 digest itself and checks the exact field set, so these builders are the
 * single definition of each signed shape on the service side (mirrored in
 * contract/crates/dockside-escrow-core). Adding a field here without the contract changing makes
 * the contract reject the payload (UNKNOWN_FIELD), which is the intended fail-closed behaviour.
 */
export interface TradeBinding {
  readonly contractId: string;
  readonly tradeId: string;
  readonly tradeRevision: number;
  readonly tradeDigest: string;
}

export function tradeBinding(terms: TradeTerms): TradeBinding {
  return {
    contractId: terms.escrowContractId,
    tradeId: terms.tradeId,
    tradeRevision: terms.revision,
    tradeDigest: tradeRevisionDigest(terms),
  };
}

function header(b: TradeBinding) {
  return {
    contractId: b.contractId,
    tradeId: b.tradeId,
    tradeRevision: b.tradeRevision,
    tradeDigest: b.tradeDigest,
  };
}

export interface Window {
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly nonce: string;
}

export const REFUND_REASONS = [
  "TRADE_EXPIRY",
  "INSPECTION_FAIL",
  "PERMANENT_HOLD",
  "MUTUAL_CANCEL",
  "BUYER_KEY_LOSS",
  "SUPPLIER_KEY_LOSS",
  "INSPECTOR_KEY_LOSS",
  "PARTIAL_FUNDING_RETURN",
  "EXCESS_FUNDING_RETURN",
] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];
export type SourceBucket = "PARTIAL" | "AVAILABLE" | "QUARANTINED";

export function refundRequestPayload(
  b: TradeBinding,
  r: {
    refundIntentId: string;
    reason: RefundReason;
    funder: string;
    amountYocto: bigint;
    sourceBucket: SourceBucket;
    initiatorRole: "BUYER" | "SUPPLIER" | "FUNDER";
  } & Window,
): CanonicalValue {
  return {
    ...header(b),
    refundIntentId: r.refundIntentId,
    policyId: REFUND_POLICY_ID,
    policyRevision: 1,
    reason: r.reason,
    funder: r.funder,
    amountYocto: r.amountYocto,
    sourceBucket: r.sourceBucket,
    initiatorRole: r.initiatorRole,
    issuedAt: r.issuedAt,
    expiresAt: r.expiresAt,
    nonce: r.nonce,
  };
}

export function refundRevokePayload(
  b: TradeBinding,
  r: { refundIntentId: string; requestDigest: string; revokerRole: "BUYER" | "SUPPLIER" | "FUNDER" } & Window,
): CanonicalValue {
  return { ...header(b), ...r };
}

export function refundDisputePayload(
  b: TradeBinding,
  r: {
    refundIntentId: string;
    requestDigest: string;
    disputantRole: "BUYER" | "SUPPLIER" | "RISK_RESOLVER";
    reasonCode: string;
    evidenceDigest: string;
  } & Window,
): CanonicalValue {
  return { ...header(b), ...r };
}

export function holdSetPayload(
  b: TradeBinding,
  h: {
    holdId: string;
    manifestDigest: string | null;
    reasonCode: string;
    issuerRole: "POLICY_SETTER" | "RISK_RESOLVER";
    ruleId: string | null;
  } & Window,
): CanonicalValue {
  return { ...header(b), ...h, schema: "dockside/hold-set@1" };
}

export function holdResolvePayload(
  b: TradeBinding,
  h: {
    holdId: string;
    holdReasonCode: string;
    manifestDigest: string | null;
    resolutionCode: "RELEASE_HOLD" | "RESOLVE_TO_REFUND" | "RETRY_INSPECTION";
    evidenceDigest: string;
  } & Window,
): CanonicalValue {
  return { ...header(b), ...h, resolverRole: "RISK_RESOLVER", schema: "dockside/hold-resolve@1" };
}

export const BOUND_ROLES = [
  "buyer",
  "supplier",
  "inspector",
  "riskResolver",
  "manifestAttestor",
  "policySetter",
] as const;
export type BoundRole = (typeof BOUND_ROLES)[number];

export function keyRevocationPayload(
  b: TradeBinding,
  k: {
    role: BoundRole;
    publicKey: string;
    signerRole: "SELF" | "BUYER" | "SUPPLIER";
    reasonCode: string;
  } & Window,
): CanonicalValue {
  return { ...header(b), ...k };
}

export interface SignedPayload {
  readonly payload: TypedJson;
  readonly signature: string;
  readonly digestHex: string;
}

/** Sign with a locally held key (tests, isolated signer processes). Wallets sign the same digest. */
export function signPayload(key: KeyObject, purpose: SigningPurpose, payload: CanonicalValue): SignedPayload {
  return {
    payload: toTypedJson(payload),
    signature: signFor(key, purpose, payload),
    digestHex: digestHexFor(purpose, payload),
  };
}

/** Typed-JSON terms argument for `register_trade`. */
export function termsArg(terms: TradeTerms): TypedJson {
  return toTypedJson(tradeTermsCanonical(terms));
}
