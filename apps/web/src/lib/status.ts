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
  | "destinationReceipt"
  | "releaseIntentState"
  | "operationState"
  | "attestationStatus"
  | "inspectionDecision"
  | "slotStatus"
  | "refundState"
  | "destinationChange"
  | "recoveryStatus"
  | "enrollmentStatus"
  | "bindingIssue"
  | "attestorCoverage"
  | "assetRecord"
  | "assetRecovery"
  | "assetOperation";

const LOCK = "Value stays reserved. No retry, exit or terminal override is available.";

export const VOCABULARY: Record<
  Exclude<
    Dimension,
    | "releaseIntentState"
    | "operationState"
    | "attestationStatus"
    | "inspectionDecision"
    | "slotStatus"
    | "refundState"
    | "destinationChange"
    | "recoveryStatus"
    | "enrollmentStatus"
    | "bindingIssue"
    | "attestorCoverage"
    | "assetRecord"
    | "assetRecovery"
    | "assetOperation"
  >,
  Record<string, StatusMeaning>
> = {
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
  const extra = EXTRA[dimension]?.[value];
  if (extra) return extra;
  const m = (VOCABULARY as Record<string, Record<string, StatusMeaning>>)[dimension]?.[value];
  if (m) return m;
  return {
    label: `Unrecognized ${dimension} "${value}"`,
    tone: "unknown",
    icon: "unknown",
    sentence:
      "This client does not support the value the server sent (unsupported schema). Nothing is inferred.",
  };
}

/* ------------------------------------------------------------------------- */
/* Backend vocabularies served since M04/M05/M07 (release journal, operation  */
/* journal, attestation, inspection, slot completeness).                      */
/* ------------------------------------------------------------------------- */

const P = VOCABULARY.payoutState;
const req = (k: string): StatusMeaning => {
  const m = P[k];
  if (!m) throw new Error(`missing payout vocabulary ${k}`);
  return m;
};

/** Release-intent journal states (@dockside/release JournalState). */
const RELEASE_INTENT: Record<string, StatusMeaning> = {
  PREPARED: {
    label: "Intent prepared, not signed",
    tone: "neutral",
    icon: "pending",
    sentence:
      "A release intent payload exists but no buyer signature has reached the contract; nothing is reserved.",
  },
  EXPIRED_UNSIGNED: {
    label: "Prepared intent expired unsigned",
    tone: "neutral",
    icon: "expired",
    sentence: "The prepared intent was never signed and no longer holds the slot.",
  },
  ...Object.fromEntries(
    [
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
    ].map((k) => [k, req(k)]),
  ),
};

/** Economic-operation journal states (@dockside/journal OPERATION_STATES). */
const OPERATION: Record<string, StatusMeaning> = {
  QUEUED: {
    label: "Queued, not submitted",
    tone: "neutral",
    icon: "pending",
    sentence: "The journal holds the value lock and an outbox row; no transaction has been broadcast.",
    locked: true,
  },
  WITHDRAWN: {
    label: "Withdrawn before submit",
    tone: "neutral",
    icon: "cancelled",
    sentence: "The operation was withdrawn before any broadcast; nothing was submitted.",
    terminal: true,
  },
  EXECUTING: {
    label: "Executing",
    tone: "warning",
    icon: "processing",
    sentence: `The signed transaction was persisted and broadcast once. ${LOCK}`,
    locked: true,
  },
  ...Object.fromEntries(
    [
      "SUBMITTING",
      "PROCESSING",
      "UNKNOWN",
      "REVIEW",
      "RECONCILING",
      "ADJUDICATION",
      "PAID",
      "REFUNDED",
      "FAILED",
    ].map((k) => [k, req(k)]),
  ),
};

const REFUND_LOCK = "The refund slice stays locked. No second refund, release or override is available.";

/** Escrow refund-intent states (dockside-refund-v1; the contract's `get_refunds` view). */
const REFUND_STATE: Record<string, StatusMeaning> = {
  REQUESTED: {
    label: "Refund requested",
    tone: "warning",
    icon: "pending",
    sentence:
      "The contract locked the exact funder slice; a required signature or clock has not started yet.",
    locked: true,
  },
  TIMELOCKED: {
    label: "Refund timelocked",
    tone: "warning",
    icon: "processing",
    sentence: "The policy challenge or cooling period is running; the slice stays locked until the deadline.",
    locked: true,
  },
  AUTHORIZED: {
    label: "Refund authorized, not executed",
    tone: "neutral",
    icon: "authorized",
    sentence: "The contract's predicates held after the deadline; execution returns the slice to its funder.",
    locked: true,
  },
  EXECUTING: {
    label: "Refund executing",
    tone: "warning",
    icon: "processing",
    sentence: `The refund transfer was submitted once. ${REFUND_LOCK}`,
    locked: true,
  },
  PROCESSING: {
    label: "Refund processing",
    tone: "warning",
    icon: "processing",
    sentence: `Awaiting an authoritative refund outcome. ${REFUND_LOCK}`,
    locked: true,
  },
  UNKNOWN: {
    label: "Refund outcome unknown",
    tone: "unknown",
    icon: "unknown",
    sentence: `No authoritative refund outcome is available. ${REFUND_LOCK}`,
    locked: true,
  },
  REVIEW: {
    label: "Refund locked for review",
    tone: "unknown",
    icon: "review",
    sentence: `A dispute, appeal or contradiction paused the refund. ${REFUND_LOCK}`,
    locked: true,
  },
  RECONCILING: {
    label: "Refund reconciling",
    tone: "unknown",
    icon: "reconciling",
    sentence: `Authoritative reads are being compared. ${REFUND_LOCK}`,
    locked: true,
  },
  ADJUDICATION: {
    label: "Refund in adjudication",
    tone: "unknown",
    icon: "adjudication",
    sentence: `A designated adjudicator must decide from evidence. ${REFUND_LOCK}`,
    locked: true,
  },
  REFUNDED: {
    label: "Refunded to the original funder",
    tone: "neutral",
    icon: "refunded",
    sentence:
      "The contract settled the slice to the recorded original funder; the journal holds the receipt.",
    terminal: true,
  },
  FAILED: {
    label: "Refund failed — no transfer (authoritative)",
    tone: "negative",
    icon: "failed",
    sentence:
      "Authoritative no-transfer evidence restored the exact source bucket. Another attempt needs a new refund intent.",
    terminal: true,
  },
  REVOKED: {
    label: "Refund revoked before execution",
    tone: "neutral",
    icon: "cancelled",
    sentence: "An allowed signer revoked the request; the slice returned to its recorded source bucket.",
    terminal: true,
  },
};

/** Destination-change states (contract `pendingDestinationChange` / `destinationHistory`). */
const DESTINATION_CHANGE: Record<string, StatusMeaning> = {
  PROPOSED: {
    label: "Destination revision proposed",
    tone: "warning",
    icon: "pending",
    sentence: "One party signed the successor revision. It can never activate without the other party.",
  },
  CONSENTED: {
    label: "Both parties consented; delay running",
    tone: "warning",
    icon: "processing",
    sentence: "Both bound parties signed the same successor digest. Activation waits for the signed delay.",
  },
  ACTIVATED: {
    label: "Destination revision activated",
    tone: "neutral",
    icon: "superseded",
    sentence:
      "The successor revision is effective. Manifest, inspection, hold view, intent and approval must be renewed.",
    terminal: true,
  },
  REVOKED: {
    label: "Destination revision cancelled",
    tone: "neutral",
    icon: "cancelled",
    sentence: "A party revoked the proposal before activation; the bound destination is unchanged.",
    terminal: true,
  },
  EXPIRED: {
    label: "Destination revision expired",
    tone: "neutral",
    icon: "expired",
    sentence: "The consent window closed before both parties signed; the bound destination is unchanged.",
    terminal: true,
  },
};

/* ------------------------------------------------------------------------- */
/* Unexpected-asset recovery (M11): asset record, recovery and its journal.  */
/* None of these is native-NEAR value; none can look paid.                    */
/* ------------------------------------------------------------------------- */

const ASSET_LOCK = "The exact asset stays locked on the contract. No retry or override is available.";

/** Contract asset-record states (`get_unexpected_assets`). */
const ASSET_RECORD: Record<string, StatusMeaning> = {
  ASSET_RECOVERY_REVIEW: {
    label: "In asset recovery review",
    tone: "warning",
    icon: "review",
    sentence: "Recorded, never credited as native NEAR. Leaves only through the separate recovery policy.",
  },
  UNRECOVERABLE_OR_REVIEW: {
    label: "No safe adapter: unrecoverable or review",
    tone: "warning",
    icon: "blocked",
    sentence:
      "This contract has no safe recovery adapter for the asset standard. It stays recorded in review.",
  },
  RECOVERY_REQUESTED: {
    label: "Sender requested recovery",
    tone: "warning",
    icon: "pending",
    sentence:
      "The claimed sender's own account requested recovery to itself; risk/policy approval is pending.",
  },
  RECOVERY_CHALLENGE_PERIOD: {
    label: "Approved; 72-hour challenge running",
    tone: "warning",
    icon: "processing",
    sentence: "Risk/policy approved. Buyer, supplier, risk/policy or another claimant may still challenge.",
  },
  RECOVERY_SUBMITTED: {
    label: "Recovery submitted; asset locked",
    tone: "warning",
    icon: "locked",
    sentence: `The adapter transfer was submitted once. ${ASSET_LOCK}`,
    locked: true,
  },
  RECOVERED: {
    label: "Returned to the proven sender",
    tone: "neutral",
    icon: "complete",
    sentence: "The contract recorded the adapter transfer of the exact observed amount to the proven sender.",
    terminal: true,
  },
};

/** One recovery attempt: contract state, or the journal's UNKNOWN/SUBMITTING while unproven. */
const ASSET_RECOVERY: Record<string, StatusMeaning> = {
  REQUESTED: {
    label: "Requested by the sender",
    tone: "warning",
    icon: "pending",
    sentence: "Awaiting the governing trade's risk/policy approval over a read-only validation.",
  },
  CHALLENGE_PERIOD: {
    label: "Challenge window open",
    tone: "warning",
    icon: "processing",
    sentence: "Execution is possible only after the contract's 72-hour deadline and without a challenge.",
  },
  SUBMITTING: {
    label: "Execution being submitted",
    tone: "warning",
    icon: "processing",
    sentence: `The execution transaction is persisted and being broadcast. ${ASSET_LOCK}`,
    locked: true,
  },
  UNKNOWN: {
    label: "Execution outcome unknown",
    tone: "unknown",
    icon: "unknown",
    sentence: `The outcome is not yet proven; reconciliation uses the original transaction. ${ASSET_LOCK}`,
    locked: true,
  },
  SUBMITTED: {
    label: "Adapter transfer pending",
    tone: "warning",
    icon: "locked",
    sentence: `The contract submitted the token transfer and awaits its outcome. ${ASSET_LOCK}`,
    locked: true,
  },
  REVIEW: {
    label: "Contradictory evidence: review",
    tone: "negative",
    icon: "review",
    sentence: "Token balances contradict the contract record. Nothing here can force an outcome.",
    locked: true,
  },
  RECOVERED: {
    label: "Recovered to the proven sender",
    tone: "neutral",
    icon: "complete",
    sentence: "The token contract accepted the transfer of the exact observed amount to the proven sender.",
    terminal: true,
  },
  FAILED: {
    label: "Adapter transfer refused",
    tone: "negative",
    icon: "failed",
    sentence:
      "The token contract reverted the transfer (no transfer). The asset is back in review; a new request is required.",
    terminal: true,
  },
  CHALLENGED: {
    label: "Challenged; back in review",
    tone: "neutral",
    icon: "review",
    sentence: "A challenge ended this recovery before execution. Ownership stays unresolved in review.",
    terminal: true,
  },
  REVOKED: {
    label: "Revoked before execution",
    tone: "neutral",
    icon: "cancelled",
    sentence: "The claimed sender or risk/policy revoked this recovery; the asset is back in review.",
    terminal: true,
  },
};

/** Asset-recovery journal operation states (0007_asset_recoveries.sql). */
const ASSET_OPERATION: Record<string, StatusMeaning> = {
  QUEUED: {
    label: "Queued for the worker",
    tone: "neutral",
    icon: "pending",
    sentence: "Persisted; not yet signed or sent.",
  },
  SUBMITTING: {
    label: "Signed and persisted; broadcasting",
    tone: "warning",
    icon: "processing",
    sentence: "The signed transaction and its hash were stored before broadcast.",
    locked: true,
  },
  UNKNOWN: {
    label: "Broadcast outcome unknown",
    tone: "unknown",
    icon: "unknown",
    sentence: "Reconciling the original transaction by its hash; no new transaction is sent.",
    locked: true,
  },
  PROCESSING: {
    label: "Awaiting adapter outcome",
    tone: "warning",
    icon: "processing",
    sentence: "The contract submitted the transfer; its callback has not settled yet.",
    locked: true,
  },
  RECOVERED: {
    label: "Settled: recovered",
    tone: "neutral",
    icon: "complete",
    sentence: "Contract RECOVERED and the escrow token balance dropped by at least the exact amount.",
    terminal: true,
  },
  FAILED: {
    label: "Settled: adapter reverted",
    tone: "negative",
    icon: "failed",
    sentence: "Authoritative no-transfer. This recovery cannot be retried.",
    terminal: true,
  },
  NOT_SUBMITTED: {
    label: "Execution did not take effect",
    tone: "neutral",
    icon: "cancelled",
    sentence:
      "The contract refused the call or the transaction expired un-included. A new execution may be requested.",
    terminal: true,
  },
  REVIEW: {
    label: "Journal review",
    tone: "negative",
    icon: "review",
    sentence: "Evidence contradicts the contract record. No transition out of review exists here.",
    locked: true,
  },
};

const EXTRA: Partial<Record<Dimension, Record<string, StatusMeaning>>> = {
  assetRecord: ASSET_RECORD,
  assetRecovery: ASSET_RECOVERY,
  assetOperation: ASSET_OPERATION,
  releaseIntentState: RELEASE_INTENT,
  operationState: OPERATION,
  refundState: REFUND_STATE,
  destinationChange: DESTINATION_CHANGE,
  attestationStatus: {
    CURRENT: {
      label: "Attestation current",
      tone: "neutral",
      icon: "complete",
      sentence: "The bound ManifestAttestor signed the current complete manifest revision.",
    },
    SUPERSEDED: {
      label: "Attestation superseded",
      tone: "warning",
      icon: "superseded",
      sentence: "The manifest or trade revision changed after signing; a new attestation is required.",
    },
    EXPIRED: {
      label: "Attestation expired",
      tone: "warning",
      icon: "expired",
      sentence: "The attestation window ended; the attestor must sign the manifest again.",
    },
    STALE: {
      label: "Attestation stale",
      tone: "warning",
      icon: "stale",
      sentence: "The manifest no longer satisfies the EvidencePolicy (for example a slot went stale).",
    },
    INVALIDATED: {
      label: "Attestation invalidated",
      tone: "negative",
      icon: "revoked",
      sentence: "The bound attestor key was rotated, revoked or recovered; a new trade revision is required.",
    },
  },
  inspectionDecision: {
    PASS: {
      label: "Inspector decision: PASS",
      tone: "neutral",
      icon: "complete",
      sentence: "The bound inspector signed PASS over the current attested manifest.",
    },
    FAIL: {
      label: "Inspector decision: FAIL",
      tone: "negative",
      icon: "failed",
      sentence: "The bound inspector signed FAIL; release is blocked and the refund path may open.",
    },
    REVIEW: {
      label: "Inspector decision: REVIEW",
      tone: "warning",
      icon: "review",
      sentence: "The inspector asked for review; release is blocked until a later PASS.",
    },
  },
  /* M12 key management: recovery, service enrollment, revision binding and attestor coverage. */
  recoveryStatus: {
    PENDING_PROOF: {
      label: "Recovery: awaiting key proof",
      tone: "warning",
      icon: "pending",
      sentence:
        "The principal's keys are suspended; the new key must prove possession from the principal's own device.",
    },
    WAITING: {
      label: "Recovery: delay running",
      tone: "warning",
      icon: "pending",
      sentence:
        "The new key is proven. A security administrator other than the recovered principal may complete it only after the delay; the principal can veto with its existing key until then.",
    },
    COMPLETED: {
      label: "Recovery completed",
      tone: "neutral",
      icon: "active",
      sentence: "The new key is active and the suspended keys are revoked.",
    },
    CANCELLED: {
      label: "Recovery vetoed",
      tone: "neutral",
      icon: "cancelled",
      sentence:
        "The principal vetoed with its existing key; the prior keys were restored and the new key revoked.",
    },
  },
  enrollmentStatus: {
    PENDING_PROOF: {
      label: "Enrollment pending",
      tone: "warning",
      icon: "pending",
      sentence: "The service key must prove possession, then a security administrator activates it.",
    },
    ACTIVE: {
      label: "Enrollment active",
      tone: "neutral",
      icon: "active",
      sentence: "The service holds its capability within its enrolled scope only.",
    },
    REVOKED: { label: "Enrollment revoked", tone: "negative", icon: "revoked", sentence: "No key may sign." },
  },
  bindingIssue: {
    KEY_SUPERSEDED: {
      label: "Bound key rotated",
      tone: "negative",
      icon: "superseded",
      sentence:
        "The key version this revision binds was replaced. Its new version is refused for this revision (wrong key version); a new trade revision is required.",
    },
    KEY_REVOKED: {
      label: "Bound key revoked or suspended",
      tone: "negative",
      icon: "revoked",
      sentence:
        "The key this revision binds was revoked, or suspended by a recovery. A new trade revision is required, binding a usable key.",
    },
    KEY_NOT_BOUND: {
      label: "Bound key not enrolled",
      tone: "negative",
      icon: "blocked",
      sentence:
        "The revision names a key that is not the enrolled active version. A new trade revision is required.",
    },
    CAPABILITY_MISSING: {
      label: "Capability no longer held",
      tone: "negative",
      icon: "blocked",
      sentence:
        "The bound principal no longer holds the capability this role needs. A new trade revision is required.",
    },
    SCOPE_MISMATCH: {
      label: "Scope does not cover this trade",
      tone: "negative",
      icon: "blocked",
      sentence:
        "The enrolled service scope does not cover this organization, trade and EvidencePolicy. A new trade revision is required.",
    },
  },
  attestorCoverage: {
    COVERS: {
      label: "Scope covers this trade",
      tone: "neutral",
      icon: "complete",
      sentence: "Enrolled organization, trade and EvidencePolicy scope cover this trade.",
    },
    SCOPE_MISMATCH: {
      label: "Wrong scope",
      tone: "negative",
      icon: "blocked",
      sentence:
        "Enrolled for a different organization, trade or EvidencePolicy revision; its attestations are refused for this trade.",
    },
  },
  slotStatus: {
    MISSING: {
      label: "Missing",
      tone: "warning",
      icon: "incomplete",
      sentence: "No current item fills this slot.",
    },
    UNDERFILLED: {
      label: "Underfilled",
      tone: "warning",
      icon: "incomplete",
      sentence: "Fewer current items than the slot's minimum.",
    },
    STALE: {
      label: "Stale",
      tone: "warning",
      icon: "stale",
      sentence: "The current item passed its freshness rule; upload a replacement.",
    },
    FILLED: {
      label: "Filled",
      tone: "neutral",
      icon: "complete",
      sentence: "Current items satisfy the slot's cardinality and freshness rules.",
    },
  },
};
