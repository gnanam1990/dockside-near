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
    initiatorRole: "BUYER" | "SUPPLIER" | "FUNDER" | "RISK_RESOLVER";
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
  r: {
    refundIntentId: string;
    requestDigest: string;
    revokerRole: "BUYER" | "SUPPLIER" | "FUNDER" | "RISK_RESOLVER";
  } & Window,
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

/* ------------------------------------------------------------------ */
/* Release intents, buyer approval, exits and destination change (M04) */
/* ------------------------------------------------------------------ */

export const EXECUTION_PROFILE_DIRECT = "DIRECT_TESTNET" as const;
export const ABANDON_POLICY = { id: "dockside-abandon-v1", revision: 1, graceMs: 24 * 3600_000 } as const;
export type PartySignerRole = "BUYER_APPROVER" | "SUPPLIER_SIGNER";
export type AbandonTrigger = "INTENT_EXPIRED" | "BUYER_APPROVAL_EXPIRED" | "FUNDED_AUTHORIZATION_EXPIRED";

/** Funder slice of a reservation, ordered by funder account as the contract's ledger orders it. */
export interface ReservationSlice {
  readonly funder: string;
  readonly amountYocto: bigint;
}

function sortedSlices(slices: readonly ReservationSlice[]): ReservationSlice[] {
  return [...slices].sort((a, b) => (a.funder < b.funder ? -1 : a.funder > b.funder ? 1 : 0));
}

/** `dockside/destination-snapshot` digest of a NEAR payout destination. */
export function destinationDigest(network: string, destination: string): string {
  return digestHexFor("DESTINATION_SNAPSHOT", { network, recipientType: "NEAR_ACCOUNT", destination });
}

/** `dockside/reservation-source` digest of exact AVAILABLE per-funder slices. */
export function sourceBucketDigest(slices: readonly ReservationSlice[]): string {
  return digestHexFor("RESERVATION_SOURCE", {
    sourceBucket: "AVAILABLE",
    slices: sortedSlices(slices).map((s) => ({ funder: s.funder, amountYocto: s.amountYocto })),
  });
}

export interface HoldViewEntry {
  readonly holdId: string;
  readonly status: string;
  readonly setDigest: string;
  readonly resolutionDigest: string | null;
}

/** `dockside/holds-view` digest over every HoldRecord of the trade (ordered by hold id). */
export function holdsViewDigest(b: TradeBinding, holds: readonly HoldViewEntry[]): string {
  const ordered = [...holds].sort((a, c) => (a.holdId < c.holdId ? -1 : a.holdId > c.holdId ? 1 : 0));
  return digestHexFor("HOLDS_VIEW", {
    tradeId: b.tradeId,
    tradeRevision: b.tradeRevision,
    holds: ordered.map((h) => ({
      holdId: h.holdId,
      status: h.status,
      setDigest: h.setDigest,
      resolutionDigest: h.resolutionDigest,
    })),
  });
}

export function releaseIntentPayload(
  b: TradeBinding,
  r: {
    network: string;
    releaseIntentId: string;
    amountYocto: bigint;
    destination: string;
    slices: readonly ReservationSlice[];
    intentExpiresAt: number;
  } & Window,
): CanonicalValue {
  return {
    ...header(b),
    network: r.network,
    releaseIntentId: r.releaseIntentId,
    amountYocto: r.amountYocto,
    executionProfile: EXECUTION_PROFILE_DIRECT,
    destination: r.destination,
    destinationDigest: destinationDigest(r.network, r.destination),
    sourceBucketDigest: sourceBucketDigest(r.slices),
    intentExpiresAt: r.intentExpiresAt,
    signerRole: "BUYER_APPROVER",
    issuedAt: r.issuedAt,
    expiresAt: r.expiresAt,
    nonce: r.nonce,
  };
}

export function buyerApprovalPayload(
  b: TradeBinding,
  a: {
    network: string;
    releaseIntentId: string;
    intentStateVersion: number;
    amountYocto: bigint;
    destination: string;
    manifestRevision: number;
    manifestDigest: string;
    attestationDigest: string;
    inspectionDigest: string;
    holdsViewDigest: string;
  } & Window,
): CanonicalValue {
  return {
    ...header(b),
    releaseIntentId: a.releaseIntentId,
    intentStateVersion: a.intentStateVersion,
    amountYocto: a.amountYocto,
    executionProfile: EXECUTION_PROFILE_DIRECT,
    destination: a.destination,
    destinationDigest: destinationDigest(a.network, a.destination),
    manifestRevision: a.manifestRevision,
    manifestDigest: a.manifestDigest,
    attestationDigest: a.attestationDigest,
    inspectionDigest: a.inspectionDigest,
    holdsViewDigest: a.holdsViewDigest,
    signerRole: "BUYER_APPROVER",
    issuedAt: a.issuedAt,
    expiresAt: a.expiresAt,
    nonce: a.nonce,
  };
}

/** Exact intent binding shared by CANCEL and ABANDON payloads. */
export interface ExitBinding {
  readonly network: string;
  readonly organizationId: string;
  readonly releaseIntentId: string;
  readonly expectedState: string;
  readonly stateVersion: number;
  readonly amountYocto: bigint;
  readonly destination: string;
  readonly slices: readonly ReservationSlice[];
}

function exitFields(x: ExitBinding) {
  return {
    network: x.network,
    organizationId: x.organizationId,
    releaseIntentId: x.releaseIntentId,
    expectedState: x.expectedState,
    stateVersion: x.stateVersion,
    amountYocto: x.amountYocto,
    destinationDigest: destinationDigest(x.network, x.destination),
    sourceBucketDigest: sourceBucketDigest(x.slices),
  };
}

export function cancelReleaseIntentPayload(
  b: TradeBinding,
  x: ExitBinding & { reasonCode: string } & Window,
): CanonicalValue {
  return {
    ...header(b),
    ...exitFields(x),
    reasonCode: x.reasonCode,
    issuedAt: x.issuedAt,
    expiresAt: x.expiresAt,
    nonce: x.nonce,
  };
}

export function cancelConsentPayload(
  b: TradeBinding,
  k: { cancelDigest: string; signerRole: PartySignerRole; keyVersionId: string } & Window,
): CanonicalValue {
  return {
    ...header(b),
    cancelDigest: k.cancelDigest,
    signerRole: k.signerRole,
    capability: k.signerRole,
    keyVersionId: k.keyVersionId,
    issuedAt: k.issuedAt,
    expiresAt: k.expiresAt,
    nonce: k.nonce,
  };
}

export function revokeCancelConsentPayload(
  b: TradeBinding,
  r: {
    releaseIntentId: string;
    cancelDigest: string;
    signerRole: PartySignerRole;
    consentNonce: string;
  } & Window,
): CanonicalValue {
  return { ...header(b), ...r };
}

export function abandonReleaseIntentPayload(
  b: TradeBinding,
  x: ExitBinding & {
    trigger: AbandonTrigger;
    triggerAt: number;
    signerRole: PartySignerRole;
    keyVersionId: string;
  } & Window,
): CanonicalValue {
  return {
    ...header(b),
    ...exitFields(x),
    trigger: x.trigger,
    triggerAt: x.triggerAt,
    abandonPolicyId: ABANDON_POLICY.id,
    abandonPolicyRevision: ABANDON_POLICY.revision,
    abandonAfter: x.triggerAt + ABANDON_POLICY.graceMs,
    signerRole: x.signerRole,
    capability: x.signerRole,
    keyVersionId: x.keyVersionId,
    issuedAt: x.issuedAt,
    expiresAt: x.expiresAt,
    nonce: x.nonce,
  };
}

export function destinationChangeRevokePayload(
  b: TradeBinding,
  r: { successorDigest: string; signerRole: "BUYER" | "SUPPLIER" } & Window,
): CanonicalValue {
  return { ...header(b), ...r };
}

export function refundAuthorizePayload(
  b: TradeBinding,
  r: { refundIntentId: string; requestDigest: string } & Window,
): CanonicalValue {
  return { ...header(b), ...r, authorizerRole: "RISK_RESOLVER" };
}
