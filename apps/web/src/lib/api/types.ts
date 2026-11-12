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
/* Shared display types (trade projections are typed in ./trade.ts).   */
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

/* ------------------------------------------------------------------ */
/* M12 key management (services/api GET /v1/me/keys,                  */
/* /v1/organization/directory, /v1/organization/trade-bindings).      */
/* ------------------------------------------------------------------ */

export interface KeyVersionDetail extends KeyVersionView {
  readonly createdAt: number;
  readonly provenAt: number | null;
  readonly supersededAt: number | null;
  readonly suspendedAt: number | null;
  readonly revokeReason: string | null;
}

export type RecoveryStatus = "PENDING_PROOF" | "WAITING" | "COMPLETED" | "CANCELLED";

export interface RecoveryView {
  readonly id: string;
  readonly organizationId: string;
  readonly principalId: string;
  readonly newKeyVersionId: string;
  readonly newKeyVersion: number;
  readonly newPublicKey: string;
  readonly suspendedKeyVersionIds: string[];
  readonly status: RecoveryStatus;
  readonly requestedBy: string;
  readonly requestedAt: number;
  readonly notBefore: number;
  readonly completedBy: string | null;
  readonly completedAt: number | null;
  readonly cancelledAt: number | null;
}

export interface ServiceScope {
  readonly organizationId: string;
  readonly tradeId: string | null;
  readonly evidencePolicyId: string;
  readonly evidencePolicyRevision: number;
}

export interface DirectoryPrincipal extends PrincipalView {
  readonly enrolledVia: "BOOTSTRAP" | "INVITATION" | "SERVICE_ENROLLMENT";
  readonly createdAt: number;
  readonly capabilities: Capability[];
  readonly keys: KeyVersionDetail[];
}

export type ServiceCapability = (typeof SERVICE_CAPABILITIES)[number];

export interface DirectoryService {
  readonly id: string;
  readonly organizationId: string;
  readonly principalId: string;
  readonly serviceId: string;
  readonly capability: ServiceCapability;
  readonly scope: ServiceScope;
  readonly status: "PENDING_PROOF" | "ACTIVE" | "REVOKED";
  readonly createdAt: number;
  readonly createdBy: string;
  readonly versions: KeyVersionDetail[];
}

export interface OrganizationDirectory {
  readonly organization: { readonly id: string; readonly name: string; readonly status: string };
  readonly recoveryDelayMs: number;
  readonly principals: DirectoryPrincipal[];
  readonly services: DirectoryService[];
  readonly recoveries: RecoveryView[];
  readonly observedAt: number;
}

export interface OwnKeys {
  readonly principalId: string;
  readonly currentKeyVersionId: string;
  readonly keys: KeyVersionDetail[];
  readonly recoveries: RecoveryView[];
  readonly observedAt: number;
}

export type BindingIssueCode =
  | "KEY_SUPERSEDED"
  | "KEY_REVOKED"
  | "KEY_NOT_BOUND"
  | "CAPABILITY_MISSING"
  | "SCOPE_MISMATCH";

export interface BindingStatus {
  readonly current: boolean;
  readonly requiresNewRevision: boolean;
  readonly issues: { readonly role: string; readonly code: BindingIssueCode }[];
}

export interface BoundRole {
  readonly role: string;
  readonly capability: string;
  readonly principalId: string | null;
  readonly enrollmentId: string | null;
  readonly serviceId: string | null;
  readonly keyVersion: number | null;
  readonly keyVersionId: string | null;
  readonly publicKey: string;
  readonly issues: BindingIssueCode[];
}

export interface TradeBindingImpact {
  readonly tradeId: string;
  readonly revision: number;
  readonly termsDigest: string;
  readonly liveIntentState: string | null;
  readonly holdsBlocking: number;
  readonly requiresNewRevision: boolean;
  readonly roles: BoundRole[];
}

export interface TradeBindingsResponse {
  readonly organizationId: string;
  readonly trades: TradeBindingImpact[];
  readonly observedAt: number;
}

export type ServiceChallengePurpose = "SERVICE_ENROLL" | "SERVICE_ROTATE" | "SERVICE_RECOVER";

/** A service PoP challenge (domain dockside/service-pop-challenge), answered by the service's custody. */
export interface ServiceChallengePayload {
  readonly challengeId: string;
  readonly purpose: ServiceChallengePurpose;
  readonly origin: string;
  readonly network: Network;
  readonly organizationId: string;
  readonly enrollmentId: string;
  readonly serviceId: string;
  readonly capability: string;
  readonly scope: ServiceScope;
  readonly publicKey: string;
  readonly keyVersion: number;
  readonly custodyKind: string | null;
  readonly nonce: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface ServiceChallengeResponse {
  readonly challengeId: string;
  readonly purpose: ServiceChallengePurpose;
  readonly payload: TypedJson;
  readonly digestHex: string;
  readonly expiresAt: number;
}

export interface ServiceEnrollmentCreated {
  readonly enrollmentId: string;
  readonly principalId: string;
  readonly keyVersion: number;
  readonly keyVersionId: string;
  readonly challenge: ServiceChallengeResponse;
}

export interface ServiceVersionCreated {
  readonly keyVersion: number;
  readonly keyVersionId: string;
  readonly notBefore?: number;
  readonly challenge: ServiceChallengeResponse;
}

export interface RecoveryStarted {
  readonly recoveryId: string;
  readonly notBefore: number;
  readonly keyVersion: number;
  readonly challenge: ChallengeResponse;
}

/** What an administrator hands to the principal being recovered (no secret inside). */
export interface RecoveryPackage {
  readonly schema: "dockside/recovery-package@1";
  readonly recoveryId: string;
  readonly principalId: string;
  readonly notBefore: number;
  readonly challenge: ChallengeResponse;
}
