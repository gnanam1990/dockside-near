import type { CanonicalValue, Capability, Network, PrincipalKind, TypedJson } from "@dockside/core";

export interface AuthorityConfig {
  readonly origin: string;
  readonly network: Network;
  readonly challengeTtlMs: number;
  readonly sessionTtlMs: number;
  readonly invitationTtlMs: number;
  readonly recoveryDelayMs: number;
  readonly requestProofSkewMs: number;
}

export type HumanChallengePurpose =
  | "ORG_BOOTSTRAP"
  | "LOGIN"
  | "INVITATION_ACCEPT"
  | "RECOVERY_KEY"
  | "RECOVERY_CANCEL"
  | "KEY_ROTATION";

export type ServiceChallengePurpose = "SERVICE_ENROLL" | "SERVICE_ROTATE" | "SERVICE_RECOVER";

/** Canonical payload of a human proof-of-possession challenge (domain dockside/pop-challenge v1). */
export interface HumanChallengePayload {
  readonly [key: string]: string | number | null;
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

export interface ChallengeView {
  readonly challengeId: string;
  readonly purpose: HumanChallengePurpose;
  readonly payload: HumanChallengePayload;
  /** Exactly what is signed: Ed25519(SHA-256(DCE-1 envelope("dockside/pop-challenge", 1, payload))). */
  readonly canonicalPayload: CanonicalValue;
  readonly typedPayload: TypedJson;
  readonly digestHex: string;
  /** NEAR wallet signMessage (NEP-413) parameters binding the same digest, nonce and origin. */
  readonly nep413: { readonly message: string; readonly nonceHex: string; readonly recipient: string };
  readonly expiresAt: number;
}

export interface ServiceScope {
  readonly organizationId: string;
  readonly tradeId: string | null;
  readonly evidencePolicyId: string;
  readonly evidencePolicyRevision: number;
}

export interface ServiceChallengeView {
  readonly challengeId: string;
  readonly purpose: ServiceChallengePurpose;
  readonly payload: Readonly<Record<string, CanonicalValue>>;
  readonly canonicalPayload: CanonicalValue;
  readonly typedPayload: TypedJson;
  readonly digestHex: string;
  readonly expiresAt: number;
}

export interface PopProof {
  readonly scheme: "dockside-ed25519" | "nep413";
  readonly signature: string;
}

export interface SessionGrant {
  readonly sessionId: string;
  /** Bearer half of the session; useless without per-request proofs from the session key. Returned once. */
  readonly sessionToken: string;
  readonly expiresAt: number;
  readonly organizationId: string;
  readonly principalId: string;
  readonly keyVersionId: string;
  readonly keyVersion: number;
  readonly capabilities: Capability[];
}

export interface RequestProof {
  readonly sessionId: string;
  readonly issuedAt: number;
  readonly nonce: string;
  readonly signature: string;
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
  readonly kind: PrincipalKind;
  readonly displayName: string;
  readonly status: "PENDING_GRANT" | "ACTIVE" | "SUSPENDED";
}

export interface AuthContext {
  readonly session: { readonly id: string; readonly expiresAt: number };
  readonly principal: PrincipalView;
  readonly keyVersion: KeyVersionView;
  readonly organizationId: string;
  readonly capabilities: Capability[];
  readonly correlationId: string;
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

export interface ServiceBinding {
  readonly enrollmentId: string;
  readonly serviceId: string;
  readonly keyVersion: number;
  readonly publicKey: string;
  readonly capability: string;
  readonly scope: {
    readonly organizationId: string;
    readonly tradeId: string | null;
    readonly evidencePolicyId: string;
    readonly evidencePolicyRevision: number;
  };
}

export interface PrincipalBinding {
  readonly principalId: string;
  readonly keyVersionId: string;
  readonly publicKey: string;
}

export interface VerifiedServiceAuthority {
  readonly enrollmentId: string;
  readonly serviceId: string;
  readonly capability: Capability;
  readonly keyVersion: number;
  readonly keyVersionId: string;
  readonly publicKey: string;
  readonly verifiedAt: number;
}

export interface VerifiedPrincipalAuthority {
  readonly principalId: string;
  readonly organizationId: string;
  readonly capability: Capability;
  readonly keyVersionId: string;
  readonly keyVersion: number;
  readonly verifiedAt: number;
}

export interface ServiceEnrollmentView {
  readonly id: string;
  readonly organizationId: string;
  readonly principalId: string;
  readonly serviceId: string;
  readonly capability: Capability;
  readonly scope: ServiceScope;
  readonly status: "PENDING_PROOF" | "ACTIVE" | "REVOKED";
  readonly versions: KeyVersionView[];
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

/** One role of a key-rebinding plan (M14): the bound key, the key it would be rebound to. */
export interface RebindingPlanRole {
  readonly role: string;
  readonly issues: BindingIssueCode[];
  readonly from: { keyVersionId: string | null; keyVersion: number | null; publicKey: string };
  readonly to: { keyVersionId: string; keyVersion: number; publicKey: string } | null;
  /** Why no rebinding is possible for this role, or null. */
  readonly blockedBy: "NO_ACTIVE_KEY" | "CAPABILITY_MISSING" | "SCOPE_MISMATCH" | "ENROLLMENT_REVOKED" | null;
}

export interface RebindingPlan {
  readonly requiresNewRevision: boolean;
  readonly roles: RebindingPlanRole[];
  /** Roles the next rebinding revision changes. */
  readonly rebind: string[];
  /** Roles that need a later rebinding (the second party key when both changed). */
  readonly deferred: string[];
  /** Roles a rebinding cannot repair. */
  readonly blocked: string[];
  readonly rebindsParty: boolean;
}

/** A key version with its full lifecycle timestamps (read models only; never key material). */
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

export interface DirectoryPrincipal extends PrincipalView {
  readonly enrolledVia: "BOOTSTRAP" | "INVITATION" | "SERVICE_ENROLLMENT";
  readonly createdAt: number;
  readonly capabilities: Capability[];
  readonly keys: KeyVersionDetail[];
}

export interface DirectoryService extends Omit<ServiceEnrollmentView, "versions"> {
  readonly createdAt: number;
  readonly createdBy: string;
  readonly versions: KeyVersionDetail[];
}

/** Security-admin read model of one organization's people, keys, recoveries and services. */
export interface OrganizationDirectory {
  readonly organization: { readonly id: string; readonly name: string; readonly status: string };
  readonly recoveryDelayMs: number;
  readonly principals: DirectoryPrincipal[];
  readonly services: DirectoryService[];
  readonly recoveries: RecoveryView[];
  readonly observedAt: number;
}

/** A principal's own key history and any recovery that targets it. */
export interface OwnKeys {
  readonly principalId: string;
  readonly currentKeyVersionId: string;
  readonly keys: KeyVersionDetail[];
  readonly recoveries: RecoveryView[];
  readonly observedAt: number;
}
