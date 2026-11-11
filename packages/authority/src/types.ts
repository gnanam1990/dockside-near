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
