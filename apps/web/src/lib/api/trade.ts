import type { TypedJson } from "../canonical";
import type { ApiOutcome, DocksideClient } from "./client";
import { ENDPOINTS, type EndpointId } from "./endpoints";
import type { BindingStatus, ServiceScope } from "./types";

/**
 * Wire types of the M07/M08 trade routes (services/api/src/trades.ts). The UI only renders
 * these values; it never derives trade, evidence, hold, release or payout state from them.
 */

export interface PartyRef {
  readonly organizationId: string;
  readonly principalId: string;
}

export interface TermsSummary {
  readonly tradeId: string;
  readonly revision: number;
  readonly termsDigest: string;
  readonly network: string;
  readonly escrowContractId: string;
  readonly asset: { readonly kind: string; readonly network: string };
  readonly amountYocto: string;
  readonly milestone: { readonly id: string; readonly description: string };
  readonly buyer: PartyRef;
  readonly supplier: PartyRef;
  readonly inspector: { readonly principalId: string };
  readonly riskResolver: { readonly principalId: string };
  readonly payout: { readonly network: string; readonly recipientType: string; readonly destination: string };
  readonly evidencePolicy: { readonly id: string; readonly revision: number; readonly digest: string };
  readonly expiresAt: number;
}

export type Relation = "BUYER" | "SUPPLIER" | "INSPECTOR" | "RISK_RESOLVER" | "BUYER_ORG" | "SUPPLIER_ORG";

export interface TradeListItem extends TermsSummary {
  readonly relations: Relation[];
  readonly holdsBlocking: number;
  readonly liveIntentState: string | null;
  readonly frozen: boolean;
  /** Some authority this revision binds was rotated, revoked or recovered (M12). */
  readonly requiresNewRevision?: boolean;
}

export interface SlotEvaluation {
  readonly slotId: string;
  readonly status: string;
  readonly itemCount: number;
  readonly minItems: number;
  readonly maxItems: number;
  readonly freshUntil: number | null;
}

export interface Evaluation {
  readonly tradeId: string;
  readonly status: string;
  readonly manifestRevision: number;
  readonly manifestDigest: string;
  readonly policy: { readonly id: string; readonly revision: number };
  readonly slots: SlotEvaluation[];
}

export interface HoldSummary {
  readonly holdId: string;
  readonly tradeId: string;
  readonly status: string;
  readonly reasonCode: string;
  readonly issuerRole: "POLICY_SETTER" | "RISK_RESOLVER";
  readonly ruleId: string | null;
  readonly manifestDigest: string | null;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly setDigest: string;
  readonly resolution: {
    readonly code: string;
    readonly evidenceDigest: string;
    readonly resolvedAt: number;
    readonly digest: string;
  } | null;
}

export interface HoldWithRequests extends HoldSummary {
  readonly resolutionRequests: {
    readonly requestId: string;
    readonly requestedBy: string;
    readonly createdAt: number;
    readonly authorizing: false;
  }[];
}

export interface OperationSummary {
  readonly operationId: string;
  readonly kind: string;
  readonly subjectId: string;
  readonly state: string;
  readonly lockHeld: boolean;
  readonly version: number;
  readonly submitCount: number;
  readonly txHash: string | null;
}

export interface TradeProjection {
  readonly trade: TermsSummary;
  readonly viewer: { readonly principalId: string; readonly relations: Relation[] };
  readonly evidence: Evaluation;
  readonly attestation: {
    readonly attestationId: string;
    readonly manifestRevision: number;
    readonly manifestDigest: string;
    readonly digest: string;
    readonly status: string;
    readonly expiresAt: number;
  } | null;
  readonly inspection: {
    readonly inspectionId: string;
    readonly decision: string;
    readonly reasonCodes: string[];
    readonly manifestDigest: string;
    readonly digest: string;
    readonly expiresAt: number;
  } | null;
  readonly holds: { readonly blocking: number; readonly items: HoldSummary[] };
  /** M01 bindingStatus of this revision; absent from builds before M12. */
  readonly authority?: BindingStatus;
  readonly release: {
    readonly liveIntent: {
      readonly releaseIntentId: string;
      readonly state: string;
      readonly version: number;
    } | null;
    readonly blockers: string[];
  };
  readonly operations: OperationSummary[];
  readonly frozen: boolean;
  readonly fundedPayouts: string;
  readonly observedAt: number;
}

export interface ManifestItem {
  readonly itemId: string;
  readonly slotId: string;
  readonly version: number;
  readonly predecessorItemId: string | null;
  readonly originalDigest: string;
  readonly byteLength: number;
  readonly detectedMime: string;
  readonly contentClass: string;
  readonly issuedAt?: number;
  readonly freshUntil?: number;
  readonly [key: string]: unknown;
}

export interface EvidenceView {
  readonly manifest: {
    readonly tradeId: string;
    readonly revision: number;
    readonly digest: string;
    readonly items: ManifestItem[];
  };
  readonly evaluation: Evaluation;
  readonly history: Array<Record<string, unknown>>;
}

export interface SlotPolicy {
  readonly slotId: string;
  readonly purpose: string;
  readonly minItems: number;
  readonly maxItems: number;
  readonly allowedMime: string[];
  readonly contentClass: string;
  readonly maxItemBytes: number;
  readonly maxAggregateBytes: number;
  readonly limits: Record<string, number>;
  readonly uploaderCapabilities: string[];
  readonly issuerCapabilities: string[];
  readonly freshnessMs: number;
  readonly replacement: string;
  readonly requiredDerived: { readonly artifactClass: string; readonly transformProfile: string }[];
}

export interface PolicyView {
  readonly policy: {
    readonly policyId: string;
    readonly revision: number;
    readonly attestationLifetimeMs: number;
    readonly slots: SlotPolicy[];
  };
  readonly digest: string;
}

export interface AttestorView {
  readonly binding: {
    readonly enrollmentId: string;
    readonly serviceId: string;
    readonly keyVersion: number;
    readonly publicKey: string;
    readonly scope: Record<string, unknown>;
  };
  readonly issues: { readonly role: string; readonly code: string }[];
  readonly enrollment: Record<string, unknown>;
  readonly currentAttestation: string | null;
  /** The viewer organization's ManifestAttestor enrollments (M12); never another organization's. */
  readonly organizationAttestors?: OrganizationAttestor[];
}

export interface OrganizationAttestor {
  readonly enrollmentId: string;
  readonly serviceId: string;
  readonly status: string;
  readonly activeKeyVersion: number | null;
  readonly scope: ServiceScope;
  readonly boundByRevision: boolean;
  readonly coverage: "COVERS" | "SCOPE_MISMATCH";
}

export interface IntentJson {
  readonly releaseIntentId: string;
  readonly tradeId: string;
  readonly tradeRevision: number;
  readonly state: string;
  readonly live: boolean;
  readonly version: number;
  readonly amountYocto: string;
  readonly slices: { readonly funder: string; readonly amount: string }[];
  readonly destination: string;
  readonly predecessorId: string | null;
  readonly intentExpiresAt: number | null;
  readonly children: unknown[];
}

export interface ContractIntent {
  readonly releaseIntentId: string;
  readonly state: string;
  readonly amount: string;
  readonly destination: string;
  readonly expiresAt: number;
  readonly approval: {
    readonly digest: string;
    readonly approvedAt: number;
    readonly expiresAt: number;
  } | null;
  readonly pendingCancel: {
    readonly digest: string;
    readonly reasonCode: string;
    readonly expiresAt: number;
    readonly consents: {
      readonly role: string;
      readonly expiresAt: number;
      readonly recordedAt: number;
      readonly revoked: boolean;
      readonly digest: string;
    }[];
  } | null;
  readonly history: [string, number][];
}

export interface ReleaseView {
  readonly tradeId: string;
  readonly blockers: string[];
  readonly intents: IntentJson[];
  readonly contract: {
    readonly revision: number;
    readonly payoutDestination: string;
    readonly liveIntent: string | null;
    readonly blockers: string[];
    readonly intents: ContractIntent[];
    readonly revisions: {
      readonly revision: number;
      readonly digest: string;
      readonly activatedAt: number;
    }[];
    readonly pendingDestinationChange: Record<string, unknown> | null;
  };
  readonly observedAt: number;
}

export interface PayoutView {
  readonly tradeId: string;
  readonly profile: string;
  readonly destination: string;
  readonly amountYocto: string;
  readonly operations: (OperationSummary & { readonly disposition: Record<string, unknown> | null })[];
  readonly fundedPayout: { readonly status: string; readonly reason: string };
  readonly observedAt: number;
}

/* ------------------------- supplier cash-out through 1Click (M52) ------------------------- */

export interface CashOutAsset {
  readonly assetId: string;
  readonly symbol: string;
  readonly decimals: number;
}

export interface CashOutView {
  readonly tradeId: string;
  readonly status: "READY" | "NOT_CONFIGURED" | "PROVIDER_UNAVAILABLE";
  readonly reason?: string;
  readonly supplierAccountId: string;
  readonly tradeNetwork: string;
  readonly providerUrl?: string;
  readonly providerNetwork?: string;
  readonly depositEnabled?: boolean;
  readonly originAssets?: (CashOutAsset & { readonly contract: string })[];
  readonly destinationAssets?: (CashOutAsset & { readonly blockchain: string })[];
  readonly observedAt: number;
}

export interface CashOutQuoteInput {
  readonly originAsset: string;
  readonly destinationAsset: string;
  readonly amount: string;
  readonly recipient: string;
  readonly slippageBps: number;
}

/** The 1Click quote request, exactly as the supplier's own client sends it. */
export interface OneClickQuoteRequest {
  readonly dry: boolean;
  readonly swapType: string;
  readonly slippageTolerance: number;
  readonly originAsset: string;
  readonly depositType: string;
  readonly destinationAsset: string;
  readonly amount: string;
  readonly refundTo: string;
  readonly refundType: string;
  readonly recipient: string;
  readonly recipientType: string;
  readonly deadline: string;
}

export interface CashOutDryQuote {
  readonly tradeId: string;
  readonly dry: true;
  readonly committed: string;
  readonly source: string;
  readonly observedAt: number;
  readonly origin: CashOutAsset & { readonly contract: string; readonly signerId: string };
  readonly destination: CashOutAsset & { readonly blockchain: string; readonly recipient: string };
  readonly quote: {
    readonly amountIn: string;
    readonly amountInFormatted: string;
    readonly amountInUsd: string;
    readonly amountOut: string;
    readonly amountOutFormatted: string;
    readonly amountOutUsd: string;
    readonly minAmountOut: string;
    readonly minAmountOutFormatted: string;
    readonly cost: { readonly usd: string | null; readonly bps: number | null };
    readonly withdrawFee: string | null;
    readonly refundFee: string | null;
    readonly timeEstimateSeconds: number;
    readonly slippageBps: number;
    readonly deadline: number;
    readonly correlationId: string;
  };
  readonly depositEnabled: boolean;
  readonly realQuote: {
    readonly url: string;
    readonly request: OneClickQuoteRequest;
    readonly powershell: string;
    readonly curl: string;
  } | null;
  readonly depositDisabledReason: string | null;
}

export interface CashOutDepositCall {
  readonly tradeId: string;
  readonly signerId: string;
  readonly depositAddress: string;
  readonly depositBefore: number;
  readonly amountIn: string;
  readonly amountOut: string;
  readonly minAmountOut: string;
  readonly amountOutFormatted: string;
  readonly call: FunctionCall;
  readonly nearCli: string;
  readonly network: string;
  readonly sentByDockside: false;
  readonly observedAt: number;
}

export interface CashOutStatus {
  readonly tradeId: string;
  readonly depositAddress: string;
  readonly txHash: string | null;
  readonly observedAt: number;
  readonly state: string;
  readonly maySendDeposit: boolean;
  readonly terminal: boolean;
  readonly reason: string;
  readonly provider: {
    readonly read: string;
    readonly status: string | null;
    readonly updatedAt?: string;
    readonly recipient?: string;
    readonly destinationAsset?: string;
    readonly amountIn?: string;
    readonly minAmountOut?: string;
    readonly amountOut?: string | null;
    readonly amountOutFormatted?: string | null;
    readonly depositedAmount?: string | null;
    readonly refundedAmount?: string | null;
    readonly refundReason?: string | null;
    readonly originChainTxHashes?: string[];
    readonly destinationChainTxHashes?: string[];
    readonly depositBefore?: number;
  };
  readonly deposit: { readonly read: string; readonly balance: string | null };
  readonly depositCall: {
    readonly signerId: string;
    readonly call: FunctionCall;
    readonly nearCli: string;
  } | null;
}

export interface FunderBuckets {
  readonly funded: string;
  readonly partial: string;
  readonly available: string;
  readonly reserved: string;
  readonly released: string;
  readonly refundLocked: string;
  readonly refunded: string;
  readonly quarantined: string;
  readonly fees: string;
  readonly excessDetectedAt: number | null;
}

export interface LedgerView {
  readonly required: string;
  readonly committed: string;
  readonly fullyFunded: boolean;
  readonly totals: FunderBuckets;
  readonly funders: Record<string, FunderBuckets>;
  readonly deposits: {
    readonly index: number;
    readonly funder: string;
    readonly amount: string;
    readonly accepted: string;
    readonly quarantined: string;
    readonly atMs: number;
  }[];
  readonly conservation: boolean;
  readonly [key: string]: unknown;
}

export type RefundRole = "BUYER" | "SUPPLIER" | "RISK_RESOLVER";

/** Contract refund intent (escrow `get_refunds`), plus whether this API journaled its payload. */
export interface RefundIntentView {
  readonly refundIntentId: string;
  readonly reason: string;
  readonly funder: string;
  readonly amount: string;
  readonly sourceBucket: "PARTIAL" | "AVAILABLE" | "QUARANTINED";
  readonly state: string;
  readonly requestDigest: string;
  readonly initiatorRole: string;
  readonly buyerSigned: boolean;
  readonly supplierSigned: boolean;
  readonly clockOrigin: number | null;
  readonly deadline: number | null;
  readonly requestedAt: number;
  readonly dispute: { readonly role: string; readonly at: number; readonly digest: string } | null;
  readonly history: [string, number][];
  readonly basis: string | null;
  readonly riskSigned: boolean;
  readonly payloadJournaled: boolean;
  readonly funderWalletRequired: boolean;
}

export interface RefundPolicyRow {
  readonly reason: string;
  readonly submit: boolean;
  readonly initiator: string;
  readonly signers: string;
  readonly clock: string;
  readonly evidence: string;
  readonly challenge: string;
  readonly eligible: string;
  readonly sourceBucket: string;
  readonly revocation: string;
}

export interface RefundCandidate {
  readonly funder: string;
  readonly reason: string;
  readonly sourceBucket: string | null;
  readonly amountYocto: string | null;
  readonly blockedBy: string | null;
  readonly blockedReason: string | null;
}

export interface RefundView {
  readonly tradeId: string;
  readonly policy: { readonly id: string; readonly revision: number; readonly rows: RefundPolicyRow[] };
  readonly refunds: RefundIntentView[];
  readonly ledger: LedgerView;
  readonly candidates: RefundCandidate[];
  readonly candidateSource: string;
  readonly viewerRole: RefundRole | null;
  /** The `fund` deposit only the buyer's own funding account can send, while the trade is not fully funded (M43). */
  readonly fundingWallet?: (FunderWalletCall & { readonly nearCli: string }) | null;
  readonly operations: OperationSummary[];
  readonly source: string;
  readonly observedAt: number;
  /** The contract's clock (latest final block time) when the view was read; deadlines run on it. */
  readonly chainTimeMs: number;
}

/** A contract call only the named NEAR account can submit (the contract checks the caller). */
export interface FunderWalletCall {
  readonly signerId: string;
  readonly call: FunctionCall;
}

export interface PreparedRefund extends Prepared {
  readonly refundIntentId: string;
  readonly reason: string;
  readonly funder: string;
  readonly amountYocto: string;
  readonly sourceBucket: string;
  readonly initiatorRole: string;
  readonly digest: string;
  readonly funderWallet?: FunderWalletCall;
}

/* ----------------------- unexpected-asset recovery (M11) ----------------------- */

export interface AssetOperationView {
  readonly operationId: string;
  readonly state: string;
  readonly reason: string | null;
  readonly txHash: string | null;
  readonly signerId: string | null;
  readonly amount: string;
  readonly recipient: string;
  readonly tokenBalanceBefore: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface AssetValidationView {
  readonly report: Record<string, unknown> & {
    readonly verdict?: string;
    readonly escrowTokenBalance?: string;
    readonly outstandingObservedTotal?: string;
    readonly checks?: Record<string, boolean>;
  };
  readonly digest: string;
  readonly verdict: string;
  readonly observedAt: number;
}

/** A recovery governed by this trade (full record) or by another trade (state only). */
export interface AssetRecoveryRecord {
  readonly recoveryId: string;
  readonly governedHere: boolean;
  readonly state: string;
  readonly displayState: string;
  readonly deadline: number | null;
  readonly tradeId?: string;
  readonly recipient?: string;
  readonly amount?: string;
  readonly recoveryCapability?: string;
  readonly requestDigest?: string;
  readonly evidenceDigest?: string;
  readonly requestedAt?: number;
  readonly requestExpiresAt?: number;
  readonly approvalDigest?: string | null;
  readonly validationDigest?: string | null;
  readonly approvedAt?: number | null;
  readonly challenge?: {
    readonly role: string;
    readonly account: string | null;
    readonly reasonCode: string;
    readonly evidenceDigest: string;
    readonly at: number;
  } | null;
  readonly revokedBy?: string | null;
  readonly executor?: string | null;
  readonly history?: [string, number][];
  readonly payloadJournaled?: boolean;
  readonly evidence?: Record<string, unknown> | null;
  readonly validation?: AssetValidationView | null;
  readonly operations?: AssetOperationView[];
}

export interface UnexpectedAssetRecord {
  readonly index: number;
  readonly standard: string;
  readonly assetContract: string;
  readonly tokenId: string | null;
  readonly observedAmount: string;
  readonly claimedSender: string;
  readonly msgDigest: string;
  readonly observedAt: number;
  readonly state: string;
  readonly originalFunder: null;
  readonly withdrawable: false;
  readonly recoveryCapability: string | null;
  readonly liveRecoveryId: string | null;
  readonly recoveries: AssetRecoveryRecord[];
}

export interface AssetRecoveryListView {
  readonly tradeId: string;
  readonly escrowContractId: string;
  readonly policy: { readonly id: string; readonly revision: number; readonly row: Record<string, string> };
  readonly adapters: { standard: string; capability: string | null; safe: boolean; method: string }[];
  readonly challengeWindowMs: number;
  readonly assets: UnexpectedAssetRecord[];
  readonly viewerRole: RefundRole | null;
  readonly source: string;
  readonly note: string;
  readonly observedAt: number;
}

export interface PreparedAssetRequest extends Prepared {
  readonly recoveryId: string;
  readonly assetIndex: number;
  readonly recipient: string;
  readonly amount: string;
  readonly digest: string;
  readonly evidence: Record<string, unknown>;
  readonly evidenceDigest: string;
  readonly senderWallet: FunderWalletCall;
}

export interface DestinationChangeRecord {
  readonly successorDigest: string;
  readonly successorRevision: number;
  readonly fromDestination: string;
  readonly toDestination: string;
  readonly proposedBy: "BUYER" | "SUPPLIER";
  readonly proposedAt: number;
  readonly consentDeadline: number;
  readonly buyerConsentAt: number | null;
  readonly supplierConsentAt: number | null;
  readonly delayUntil: number | null;
  readonly status: "PROPOSED" | "CONSENTED" | "ACTIVATED" | "REVOKED" | "EXPIRED";
  readonly closedAt: number | null;
  readonly supersededIntent: string | null;
  readonly successorIntent: string | null;
}

export interface DestinationChangeView {
  readonly tradeId: string;
  readonly boundRevision: number;
  readonly contractRevision: number;
  readonly activeDestination: string;
  readonly delayMs: number;
  readonly pending: DestinationChangeRecord | null;
  readonly history: DestinationChangeRecord[];
  readonly bindingRequired: boolean;
}

/** A key-rebinding revision as the escrow contract records it (M14). */
export interface KeyRebindingRecord {
  readonly successorDigest: string;
  readonly successorRevision: number;
  readonly roles: string[];
  readonly rebindsParty: boolean;
  readonly proposedBy: "BUYER" | "SUPPLIER";
  readonly proposedAt: number;
  readonly consentDeadline: number;
  readonly buyerConsentAt: number | null;
  readonly supplierConsentAt: number | null;
  readonly delayUntil: number | null;
  readonly status: "PROPOSED" | "CONSENTED" | "ACTIVATED" | "REVOKED" | "EXPIRED";
  readonly closedAt: number | null;
  readonly supersededIntent: string | null;
  readonly successorIntent: string | null;
}

/** One role of the authority's rebinding plan: the bound key and the key it would be rebound to. */
export interface RebindingPlanRole {
  readonly role: string;
  readonly issues: string[];
  readonly from: { keyVersionId: string | null; keyVersion: number | null; publicKey: string };
  readonly to: { keyVersionId: string; keyVersion: number; publicKey: string } | null;
  readonly blockedBy: "NO_ACTIVE_KEY" | "CAPABILITY_MISSING" | "SCOPE_MISMATCH" | "ENROLLMENT_REVOKED" | null;
}

export interface KeyRebindingView {
  readonly tradeId: string;
  readonly boundRevision: number;
  readonly contractRevision: number;
  readonly delayMs: number;
  readonly plan: {
    readonly requiresNewRevision: boolean;
    readonly roles: RebindingPlanRole[];
    readonly rebind: string[];
    readonly deferred: string[];
    readonly blocked: string[];
    readonly rebindsParty: boolean;
  };
  readonly successor: {
    readonly revision: number;
    readonly digest: string;
    readonly roles: string[];
    readonly rebindsParty: boolean;
  } | null;
  readonly successorError: string | null;
  readonly pending: KeyRebindingRecord | null;
  readonly history: KeyRebindingRecord[];
  readonly destinationChangePending: boolean;
  readonly bindingRequired: boolean;
  readonly observedAt: number;
}

export interface TimelineView {
  readonly tradeId: string;
  readonly events: {
    readonly seq: number;
    readonly eventType: string;
    readonly subjectType: string;
    readonly subjectId: string;
    readonly actorPrincipalId: string | null;
    readonly source: string;
    readonly recordedAt: number;
  }[];
}

export interface OperationView {
  readonly operationId: string;
  readonly kind: string;
  readonly tradeId: string;
  readonly state: string;
  readonly lockHeld: boolean;
  readonly version: number;
  readonly submitCount: number;
  readonly txHash: string | null;
  readonly disposition: Record<string, unknown> | null;
  readonly transitions: Array<Record<string, unknown>>;
  readonly observations: Array<{
    readonly source: string;
    readonly subject: string;
    readonly observedAt: number;
    readonly confidence: string;
    readonly fact: unknown;
  }>;
  readonly incidents: Array<Record<string, unknown>>;
}

/** Prepared payload for an explicit signature. */
export interface Prepared {
  readonly purpose: string;
  readonly payload: TypedJson;
  readonly digest?: string;
}

export interface FunctionCall {
  readonly receiverId: string;
  readonly methodName: string;
  readonly args: Record<string, unknown>;
  readonly gas: string;
  readonly depositYocto: string;
}

export interface Proposal extends Prepared {
  readonly tradeId: string;
  readonly terms: Record<string, unknown>;
  readonly digest: string;
  readonly bindingIssues: { readonly role: string; readonly code: string }[];
  readonly buyerSignatureValid?: boolean | null;
}

export interface RelayResult {
  readonly txHash: string;
  readonly outcome: string;
  readonly error: string | null;
  readonly method: string;
}

export interface RelayerStatus {
  readonly relayer: string;
  readonly contractId: string;
  readonly network: string;
  readonly chain: string;
  readonly note: string;
}

type Opts = {
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
};

/** Thin typed wrappers over the generic client; every call is a real authenticated request. */
export class TradeApi {
  constructor(private readonly client: DocksideClient) {}

  call<T>(id: EndpointId, opts: Opts = {}): Promise<ApiOutcome<T>> {
    return this.client.call<T>(ENDPOINTS[id], opts);
  }

  list() {
    return this.call<{ trades: TradeListItem[] }>("listTrades");
  }
  get(tradeId: string) {
    return this.call<TradeProjection>("getTrade", { params: { id: tradeId } });
  }
  sync(tradeId: string) {
    return this.call<{ blockers: string[] }>("syncTrade", { params: { id: tradeId }, body: {} });
  }
  evidence(tradeId: string) {
    return this.call<EvidenceView>("tradeEvidence", { params: { id: tradeId } });
  }
  policy(tradeId: string) {
    return this.call<PolicyView>("tradeEvidencePolicy", { params: { id: tradeId } });
  }
  attestor(tradeId: string) {
    return this.call<AttestorView>("tradeAttestor", { params: { id: tradeId } });
  }
  holds(tradeId: string) {
    return this.call<{ blocking: number; holds: HoldWithRequests[] }>("tradeHolds", {
      params: { id: tradeId },
    });
  }
  release(tradeId: string) {
    return this.call<ReleaseView>("tradeRelease", { params: { id: tradeId } });
  }
  payout(tradeId: string) {
    return this.call<PayoutView>("tradePayout", { params: { id: tradeId } });
  }
  refund(tradeId: string) {
    return this.call<RefundView>("tradeRefund", { params: { id: tradeId } });
  }
  cashOut(tradeId: string) {
    return this.call<CashOutView>("cashOut", { params: { id: tradeId } });
  }
  cashOutDryQuote(tradeId: string, input: CashOutQuoteInput) {
    return this.call<CashOutDryQuote>("cashOutDryQuote", { params: { id: tradeId }, body: input });
  }
  cashOutDepositCall(
    tradeId: string,
    request: CashOutQuoteInput & { readonly deadline: string },
    quoteResponse: Record<string, unknown>,
  ) {
    return this.call<CashOutDepositCall>("cashOutDepositCall", {
      params: { id: tradeId },
      body: { request, quoteResponse },
    });
  }
  cashOutStatus(tradeId: string, depositAddress: string, txHash: string | null) {
    return this.call<CashOutStatus>("cashOutStatus", {
      params: { id: tradeId },
      query: txHash ? { depositAddress, txHash } : { depositAddress },
    });
  }
  assetRecoveries(tradeId: string) {
    return this.call<AssetRecoveryListView>("assetRecoveries", { params: { id: tradeId } });
  }
  destination(tradeId: string) {
    return this.call<DestinationChangeView>("destinationChange", { params: { id: tradeId } });
  }
  keyRebinding(tradeId: string) {
    return this.call<KeyRebindingView>("keyRebinding", { params: { id: tradeId } });
  }
  timeline(tradeId: string) {
    return this.call<TimelineView>("tradeTimeline", { params: { id: tradeId } });
  }
  operation(operationId: string) {
    return this.call<OperationView>("getOperation", { params: { id: operationId } });
  }
  signedAuditExport(tradeId: string) {
    return this.call<Record<string, unknown>>("signedAuditExport", { params: { id: tradeId } });
  }
  auditExportKeys() {
    return this.call<{ keys: import("../export-verify").ExportKeyEntry[] }>("auditExportKeys");
  }
  auditExport(tradeId: string, destinations: "masked" | "full" = "masked") {
    return this.call<Record<string, unknown>>("auditExport", {
      params: { id: tradeId },
      query: { destinations },
    });
  }
}

/**
 * Relayer for contract calls the API returns. A relayer pays gas and submits a call whose party
 * signatures are inside its arguments; the contract re-verifies them. Only the local stack serves
 * one today (simulated chain); otherwise the UI shows the exact call and a BLOCKED state.
 */
export async function relayerStatus(): Promise<RelayerStatus | null> {
  try {
    const r = await fetch("/relay/v1/status", { cache: "no-store", credentials: "omit" });
    if (!r.ok || !(r.headers.get("content-type") ?? "").includes("application/json")) return null;
    const j = (await r.json()) as RelayerStatus;
    return typeof j.contractId === "string" ? j : null;
  } catch {
    return null;
  }
}

export async function relayCall(call: FunctionCall): Promise<RelayResult> {
  const r = await fetch("/relay/v1/calls", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ call }),
    cache: "no-store",
    credentials: "omit",
  });
  const j = (await r.json()) as RelayResult & { error?: unknown };
  if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : `relayer answered HTTP ${r.status}`);
  return j;
}
