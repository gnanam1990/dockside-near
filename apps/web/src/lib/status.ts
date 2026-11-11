/**
 * Status vocabulary (UI-SPEC §3.3, §3.7, §8; TDD state names). Each orthogonal dimension
 * has its own table so `tradeState`, `payoutState`, `evidenceState`, `holdState`,
 * `dryCompatibility`, `providerStatus` and `destinationReceipt` can never collapse into one
 * badge. The tables only translate a backend-supplied value into words and an icon; the
 * browser never derives a state. Unrecognized values render as an unsupported-schema state.
 */
export type Tone = "positive" | "warning" | "negative" | "unknown" | "neutral";

export type IconName =
  | "paid"
  | "processing"
  | "unknown"
  | "review"
  | "reconciling"
  | "adjudication"
  | "locked"
  | "failed"
  | "refunded"
  | "cancelled"
  | "hold"
  | "dry"
  | "not-run"
  | "blocked"
  | "authorized"
  | "expired"
  | "incomplete"
  | "complete"
  | "stale"
  | "hidden"
  | "limit"
  | "connected"
  | "disconnected"
  | "testnet"
  | "pending"
  | "active"
  | "revoked"
  | "receipt"
  | "superseded";

export interface StatusMeaning {
  readonly label: string;
  readonly tone: Tone;
  readonly icon: IconName;
  /** Supporting sentence: what the state means for the user, never a promise. */
  readonly sentence: string;
  /** Value is locked; exits and terminal overrides are prohibited. */
  readonly locked?: boolean;
  readonly terminal?: boolean;
}

export type Dimension =
  | "payoutState"
  | "dryCompatibility"
  | "holdState"
  | "evidenceState"
  | "productGate"
  | "connection"
  | "keyStatus"
  | "principalStatus"
  | "destinationReceipt";

const LOCK = "Value stays reserved. No retry, exit or terminal override is available.";

export const VOCABULARY: Record<Dimension, Record<string, StatusMeaning>> = {
  payoutState: {
    VALUE_LOCKED: {
      label: "Value locked",
      tone: "neutral",
      icon: "locked",
      sentence: "Release intent holds an exact reservation; no payment has been submitted.",
    },
    DIRECT_TESTNET_AUTHORIZED: {
      label: "Direct testnet release authorized",
      tone: "neutral",
      icon: "authorized",
      sentence: "Buyer approval is recorded for a direct native testnet NEAR release; not yet submitted.",
    },
    FUNDED_AUTHORIZATION_REQUIRED: {
      label: "Funded authorization required",
      tone: "warning",
      icon: "pending",
      sentence: "A funded payout needs its own signed authorization before execution.",
    },
    FUNDED_AUTHORIZED: {
      label: "Funded authorization recorded",
      tone: "neutral",
      icon: "authorized",
      sentence: "Funded authorization is signed and unconsumed; no transfer has happened.",
    },
    FUNDED_AUTHORIZATION_EXPIRED: {
      label: "Funded authorization expired",
      tone: "warning",
      icon: "expired",
      sentence: "The authorization can no longer be consumed; a fresh one is required.",
    },
    SUBMITTING: {
      label: "Submitting",
      tone: "warning",
      icon: "processing",
      sentence: "The operation is being submitted. Outcome is not known yet.",
      locked: true,
    },
    PROCESSING: {
      label: "Processing",
      tone: "warning",
      icon: "processing",
      sentence: `Submitted and awaiting an authoritative outcome. ${LOCK}`,
      locked: true,
    },
    UNKNOWN: {
      label: "Outcome unknown",
      tone: "unknown",
      icon: "unknown",
      sentence: `No authoritative outcome is available. ${LOCK}`,
      locked: true,
    },
    REVIEW: {
      label: "Locked for review",
      tone: "unknown",
      icon: "review",
      sentence: `Facts are missing or contradictory. ${LOCK}`,
      locked: true,
    },
    RECONCILING: {
      label: "Reconciling",
      tone: "unknown",
      icon: "reconciling",
      sentence: `Authoritative reads are being compared. ${LOCK}`,
      locked: true,
    },
    ADJUDICATION: {
      label: "In adjudication",
      tone: "unknown",
      icon: "adjudication",
      sentence: `A designated adjudicator must decide from evidence. ${LOCK}`,
      locked: true,
    },
    PAID: {
      label: "Paid (terminal evidence recorded)",
      tone: "positive",
      icon: "paid",
      sentence: "The backend recorded the terminal evidence predicate for this payment.",
      terminal: true,
    },
    FAILED: {
      label: "Failed — no transfer (authoritative)",
      tone: "negative",
      icon: "failed",
      sentence:
        "Authoritative no-transfer evidence; reservation returned. A new intent and approval are required.",
      terminal: true,
    },
    REFUNDED: {
      label: "Refunded",
      tone: "neutral",
      icon: "refunded",
      sentence: "Funds returned to the recorded original funder.",
      terminal: true,
    },
    CANCELLED_PRE_SUBMIT: {
      label: "Cancelled before submit",
      tone: "neutral",
      icon: "cancelled",
      sentence: "Buyer and supplier both signed cancellation; reservation restored to its source bucket.",
      terminal: true,
    },
    ABANDONED_PRE_SUBMIT: {
      label: "Abandoned before submit",
      tone: "neutral",
      icon: "cancelled",
      sentence:
        "Abandoned after the signed policy trigger; the trade is not cancelled and no refund is made.",
      terminal: true,
    },
    SUPERSEDED_PRE_SUBMIT: {
      label: "Superseded before submit",
      tone: "neutral",
      icon: "superseded",
      sentence: "Destination activation transferred the exact reservation to one successor intent.",
      terminal: true,
    },
    INTENT_EXPIRED: {
      label: "Intent expired",
      tone: "warning",
      icon: "expired",
      sentence: "The release intent passed its expiry before submission.",
    },
  },
  dryCompatibility: {
    NOT_RUN: {
      label: "Dry compatibility: not run",
      tone: "neutral",
      icon: "not-run",
      sentence: "No dry quote was requested. No funds moved; not used for testnet release.",
    },
    UNKNOWN: {
      label: "Dry compatibility: unknown",
      tone: "unknown",
      icon: "unknown",
      sentence: "The dry request had no usable answer. No funds moved; not used for testnet release.",
    },
    INCOMPATIBLE: {
      label: "Dry compatibility: incompatible",
      tone: "warning",
      icon: "dry",
      sentence:
        "The provider route does not match the bound terms. No funds moved; not used for testnet release.",
    },
    PASS: {
      label: "Dry compatibility: pass",
      tone: "neutral",
      icon: "dry",
      sentence: "A dry quote matched the bound terms. No funds moved; not used for testnet release.",
    },
  },
  holdState: {
    ACTIVE: {
      label: "Hold active",
      tone: "negative",
      icon: "hold",
      sentence: "An onchain HoldRecord blocks release until a risk/policy principal signs a resolution.",
      locked: true,
    },
    EXPIRED_UNRESOLVED: {
      label: "Hold expired, unresolved",
      tone: "negative",
      icon: "hold",
      sentence: "Expiry does not clear a hold. Release stays blocked until a signed resolution.",
      locked: true,
    },
    RESOLVED: {
      label: "Hold resolved",
      tone: "neutral",
      icon: "complete",
      sentence: "A signed risk/policy resolution is recorded onchain.",
    },
  },
  evidenceState: {
    INCOMPLETE: {
      label: "Evidence incomplete",
      tone: "warning",
      icon: "incomplete",
      sentence: "One or more EvidencePolicy slots are not satisfied.",
    },
    COMPLETE: {
      label: "Evidence complete (attested)",
      tone: "positive",
      icon: "complete",
      sentence: "The enrolled ManifestAttestor attested every predicate for the current revision.",
    },
    STALE: {
      label: "Evidence stale",
      tone: "warning",
      icon: "stale",
      sentence: "A freshness rule is no longer met; replacement evidence is required.",
    },
    REVIEW: {
      label: "Evidence under review",
      tone: "unknown",
      icon: "review",
      sentence: "Evidence facts are contradictory or unverifiable and cannot count as complete.",
    },
    UNKNOWN: {
      label: "Evidence unknown",
      tone: "unknown",
      icon: "unknown",
      sentence: "Evidence state could not be read.",
    },
    PRIVACY_HIDDEN: {
      label: "Hidden for privacy",
      tone: "unknown",
      icon: "hidden",
      sentence: "This item exists but your role may not view its content.",
    },
    LIMIT_EXCEEDED: {
      label: "Resource limit exceeded",
      tone: "negative",
      icon: "limit",
      sentence: "The item exceeds the policy byte or parser-resource ceiling and cannot count.",
    },
  },
  productGate: {
    NOT_RUN: {
      label: "Not run",
      tone: "neutral",
      icon: "not-run",
      sentence: "No runtime evidence exists for this capability in this build.",
    },
    BLOCKED: {
      label: "Blocked",
      tone: "warning",
      icon: "blocked",
      sentence: "A recorded prerequisite is missing; the control is not rendered.",
    },
    WORKING_TESTNET: {
      label: "Working on testnet (evidence recorded)",
      tone: "positive",
      icon: "testnet",
      sentence: "Runtime evidence for the direct testnet release corridor is recorded.",
    },
  },
  connection: {
    CONNECTED: {
      label: "Connected",
      tone: "neutral",
      icon: "connected",
      sentence: "The API answered recently.",
    },
    STALE: {
      label: "Stale",
      tone: "warning",
      icon: "stale",
      sentence: "No authoritative answer recently; data may be out of date.",
    },
    DISCONNECTED: {
      label: "Disconnected",
      tone: "negative",
      icon: "disconnected",
      sentence: "The API is unreachable. Data is frozen and actions are disabled.",
    },
    CONNECTING: {
      label: "Connecting",
      tone: "neutral",
      icon: "processing",
      sentence: "Waiting for the first API answer.",
    },
  },
  keyStatus: {
    PENDING_PROOF: {
      label: "Pending proof",
      tone: "warning",
      icon: "pending",
      sentence: "Key not yet proven.",
    },
    PENDING_ACTIVATION: {
      label: "Pending activation",
      tone: "warning",
      icon: "pending",
      sentence: "Proven; waiting for activation or the recovery delay.",
    },
    ACTIVE: { label: "Active", tone: "neutral", icon: "active", sentence: "Key may sign new authority." },
    SUPERSEDED: {
      label: "Superseded",
      tone: "neutral",
      icon: "superseded",
      sentence: "Replaced by rotation; still verifies revisions that bound it.",
    },
    SUSPENDED: {
      label: "Suspended",
      tone: "negative",
      icon: "blocked",
      sentence: "Frozen during recovery; cannot sign new authority.",
    },
    REVOKED: { label: "Revoked", tone: "negative", icon: "revoked", sentence: "Cannot sign new authority." },
  },
  principalStatus: {
    PENDING_GRANT: {
      label: "Pending grant",
      tone: "warning",
      icon: "pending",
      sentence: "Invitation accepted; an administrator must grant the capability in a separate session.",
    },
    ACTIVE: { label: "Active", tone: "neutral", icon: "active", sentence: "Principal is active." },
    SUSPENDED: { label: "Suspended", tone: "negative", icon: "blocked", sentence: "Principal is suspended." },
  },
  destinationReceipt: {
    RECEIVED: {
      label: "Destination receipt recorded",
      tone: "positive",
      icon: "receipt",
      sentence: "The destination chain confirms receipt at the bound account.",
    },
    PROVIDER_REFUND: {
      label: "Provider refund to escrow",
      tone: "warning",
      icon: "refunded",
      sentence: "The provider returned value to the escrow/refund authority, not to the supplier.",
    },
    UNAVAILABLE: {
      label: "Receipt unavailable",
      tone: "unknown",
      icon: "unknown",
      sentence: "No destination receipt has been observed.",
    },
  },
};

export function describeStatus(dimension: Dimension, value: string): StatusMeaning {
  const m = VOCABULARY[dimension][value];
  if (m) return m;
  return {
    label: `Unrecognized ${dimension} "${value}"`,
    tone: "unknown",
    icon: "unknown",
    sentence:
      "This client does not support the value the server sent (unsupported schema). Nothing is inferred.",
  };
}
