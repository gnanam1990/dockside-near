import type { TypedJson } from "../canonical";
import type { ApiOutcome, DocksideClient } from "./client";
import { ENDPOINTS, type EndpointId } from "./endpoints";

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

export interface LedgerFunder {
  readonly funder: string;
  readonly [bucket: string]: unknown;
}

export interface RefundView {
  readonly tradeId: string;
  readonly refunds: Array<Record<string, unknown>>;
  readonly ledger: Record<string, unknown> & { readonly funders?: LedgerFunder[] };
  readonly operations: OperationSummary[];
  readonly source: string;
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
  timeline(tradeId: string) {
    return this.call<TimelineView>("tradeTimeline", { params: { id: tradeId } });
  }
  operation(operationId: string) {
    return this.call<OperationView>("getOperation", { params: { id: operationId } });
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
