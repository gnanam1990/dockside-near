import type { TypedJson } from "../canonical";

/**
 * Wire types of the Dockside control API as implemented in services/api (M01) plus the
 * read projections the TDD defines for later modules. Implemented types mirror
 * packages/authority/src/types.ts and packages/store/src/primitives.ts exactly; planned
 * types are marked and only describe what the UI will render once the endpoint exists.
 */

export const HUMAN_CAPABILITIES = [
  "ORG_SECURITY_ADMIN",
  "BUYER_APPROVER",
  "SUPPLIER_SIGNER",
  "INSPECTOR",
  "RISK_RESOLVER",
  "AUDITOR",
  "EVIDENCE_UPLOADER",
] as const;
export const SERVICE_CAPABILITIES = ["MANIFEST_ATTEST", "DETERMINISTIC_POLICY_SET", "EXECUTOR"] as const;
export type HumanCapability = (typeof HUMAN_CAPABILITIES)[number];
export type Capability = HumanCapability | (typeof SERVICE_CAPABILITIES)[number];
export type Network = "near-testnet" | "near-mainnet";

export type HumanChallengePurpose =
  | "ORG_BOOTSTRAP"
  | "LOGIN"
  | "INVITATION_ACCEPT"
  | "RECOVERY_KEY"
  | "RECOVERY_CANCEL"
  | "KEY_ROTATION";

export interface HumanChallengePayload {
  readonly challengeId: string;
  readonly purpose: HumanChallengePurpose;
  readonly origin: string;
  readonly network: Network;
  readonly organizationId: string;
  readonly principalId: string;
  readonly subjectName: string | null;
  readonly requestedCapability: Capability | null;
  readonly invitationId: string | null;
  readonly recoveryId: string | null;
  readonly previousKeyVersionId: string | null;
  readonly publicKey: string;
  readonly keyVersion: number;
  readonly nonce: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

/** Response of every `/challenges` endpoint (services/api challengeJson). */
export interface ChallengeResponse {
  readonly challengeId: string;
  readonly purpose: HumanChallengePurpose;
  /** TypedJson form of the exact canonical payload that is signed. */
  readonly payload: TypedJson;
  readonly digestHex: string;
  readonly expiresAt: number;
  readonly nep413?: { readonly message: string; readonly nonceHex: string; readonly recipient: string };
}

export interface SessionGrant {
  readonly sessionId: string;
  readonly sessionToken: string;
  readonly expiresAt: number;
  readonly organizationId: string;
  readonly principalId: string;
  readonly keyVersionId: string;
  readonly keyVersion: number;
  readonly capabilities: Capability[];
}

export type KeyStatus =
  | "PENDING_PROOF"
  | "PENDING_ACTIVATION"
  | "ACTIVE"
  | "SUPERSEDED"
  | "SUSPENDED"
  | "REVOKED";

export interface KeyVersionView {
  readonly id: string;
  readonly principalId: string;
  readonly version: number;
  readonly publicKey: string;
  readonly status: KeyStatus;
  readonly custodyKind: string | null;
  readonly notBefore: number | null;
  readonly activatedAt: number | null;
  readonly revokedAt: number | null;
}

export interface PrincipalView {
  readonly id: string;
  readonly organizationId: string;
  readonly kind: "HUMAN" | "SERVICE";
  readonly displayName: string;
  readonly status: "PENDING_GRANT" | "ACTIVE" | "SUSPENDED";
}

export interface MeResponse {
  readonly principal: PrincipalView;
  readonly keyVersion: KeyVersionView;
  readonly organizationId: string;
  readonly capabilities: Capability[];
  readonly session: { readonly id: string; readonly expiresAt: number };
}

export interface ReadyResponse {
  readonly ready: boolean;
  readonly schemaVersion: number;
  readonly network: Network;
  /** Funded payout gate as configured on the server (DOCKSIDE_FUNDED_PAYOUTS); only "BLOCKED" exists today. */
  readonly fundedPayouts: string;
}

export interface InvitationCreated {
  readonly invitationId: string;
  /** One-time secret; shown once to the issuing administrator, never stored by the UI. */
  readonly secret: string;
  readonly expiresAt: number;
  readonly capability: Capability;
  readonly organizationId: string;
}

export interface RoleGrantView {
  readonly id: string;
  readonly organizationId: string;
  readonly principalId: string;
  readonly capability: Capability;
  readonly grantedByPrincipalId: string | null;
  readonly invitationId: string | null;
  readonly createdAt: number;
}

export interface AuditEvent {
  readonly seq: number;
  readonly id: string;
  readonly schemaVersion: number;
  readonly eventType: string;
  readonly organizationId: string | null;
  readonly actorPrincipalId: string | null;
  readonly actorKeyVersionId: string | null;
  readonly sessionId: string | null;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly correlationId: string;
  readonly source: string;
  readonly observedAt: number;
  readonly recordedAt: number;
  readonly payload: Record<string, string | number | boolean | null>;
  readonly prevHash: string;
  readonly eventHash: string;
}

export interface ServiceEnrollmentView {
  readonly id: string;
  readonly organizationId: string;
  readonly serviceId?: string;
  readonly capability?: Capability;
  readonly [key: string]: unknown;
}

export interface ApiErrorBody {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly retry?: string;
}

/* ------------------------------------------------------------------ */
/* Planned read projections (TDD §3, §15; UI-SPEC §3). Not served yet.  */
/* ------------------------------------------------------------------ */

/** Provenance every rendered status must carry (UI-SPEC §1, §9). */
export interface Provenance {
  readonly source: string;
  readonly observedAt: number;
  readonly recordedAt: number;
}

export interface MoneyAmount {
  /** Integer smallest units as a decimal string (yoctoNEAR for native NEAR). */
  readonly amount: string;
  readonly asset: string;
  readonly decimals: number;
  readonly network: Network;
}

export interface TradeSummary {
  readonly tradeId: string;
  readonly reference: string;
  readonly supplierName: string;
  readonly amount: MoneyAmount;
  readonly revision: number;
  readonly tradeState: string;
  readonly payoutState: string;
  readonly evidenceState: string;
  readonly nextAction: string | null;
  readonly destinationChangePending: boolean;
  readonly evidenceFreshness: string;
  readonly provenance: Provenance;
}

export interface TradeListResponse {
  readonly trades: TradeSummary[];
  readonly totalCount: number;
}

export interface TradeDetail extends TradeSummary {
  readonly contractId: string | null;
  readonly milestone: string;
  readonly holdState: string | null;
  readonly releaseIntentState: string | null;
  readonly dryCompatibility: string;
  readonly providerStatus: string | null;
  readonly destinationReceipt: string | null;
}
