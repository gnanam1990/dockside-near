import type { KeyObject } from "node:crypto";
import { randomBytes } from "node:crypto";
import { type CanonicalValue, canonicalDigest, toHex } from "./canonical.js";
import { signCanonical, verifyCanonical } from "./crypto.js";
import { fail } from "./errors.js";

/**
 * Registry of every signing domain. A signature is only ever verified against the
 * domain the verifier expects, so a signature produced for one purpose can never be
 * replayed as another (wrong-domain signatures fail).
 */
export const SIGNING_DOMAINS = {
  TRADE_REVISION: { domain: "dockside/trade-revision", version: 1 },
  POP_CHALLENGE: { domain: "dockside/pop-challenge", version: 1 },
  SERVICE_POP_CHALLENGE: { domain: "dockside/service-pop-challenge", version: 1 },
  REQUEST_PROOF: { domain: "dockside/request-proof", version: 1 },
  KEY_ROTATION: { domain: "dockside/key-rotation", version: 1 },
  MANIFEST_ATTESTATION: { domain: "dockside/manifest-attestation", version: 1 },
  INSPECTION_ATTESTATION: { domain: "dockside/inspection-attestation", version: 1 },
  HOLD_SET: { domain: "dockside/hold-set", version: 1 },
  HOLD_RESOLVE: { domain: "dockside/hold-resolve", version: 1 },
  BUYER_APPROVAL: { domain: "dockside/buyer-approval", version: 1 },
  REFUND_REQUEST: { domain: "dockside/refund-request", version: 1 },
  REFUND_REVOKE: { domain: "dockside/refund-revoke", version: 1 },
  REFUND_DISPUTE: { domain: "dockside/refund-dispute", version: 1 },
  BOUND_KEY_REVOCATION: { domain: "dockside/bound-key-revocation", version: 1 },
  EVIDENCE_POLICY: { domain: "dockside/evidence-policy", version: 1 },
  EVIDENCE_SLOT_POLICY: { domain: "dockside/evidence-slot-policy", version: 1 },
  EVIDENCE_MANIFEST: { domain: "dockside/evidence-manifest", version: 1 },
  EVIDENCE_ISSUANCE: { domain: "dockside/evidence-issuance", version: 1 },
  AUDIT_EVENT: { domain: "dockside/audit-event", version: 1 },
  // Release intents, exits and destination change (M04). Must equal contract domains.rs.
  RELEASE_INTENT: { domain: "dockside/release-intent", version: 1 },
  CANCEL_RELEASE_INTENT: { domain: "dockside/cancel-release-intent", version: 1 },
  CANCEL_CONSENT: { domain: "dockside/cancel-consent", version: 1 },
  REVOKE_CANCEL_CONSENT: { domain: "dockside/revoke-cancel-consent", version: 1 },
  ABANDON_RELEASE_INTENT: { domain: "dockside/abandon-release-intent", version: 1 },
  DESTINATION_CHANGE_REVOKE: { domain: "dockside/destination-change-revoke", version: 1 },
  REFUND_AUTHORIZE: { domain: "dockside/refund-authorize", version: 1 },
  // Separate UNEXPECTED_ASSET_RECOVERY policy (M11). Must equal contract domains.rs.
  ASSET_RECOVERY_REQUEST: { domain: "dockside/asset-recovery-request", version: 1 },
  ASSET_RECOVERY_APPROVAL: { domain: "dockside/asset-recovery-approval", version: 1 },
  ASSET_RECOVERY_CHALLENGE: { domain: "dockside/asset-recovery-challenge", version: 1 },
  ASSET_RECOVERY_REVOKE: { domain: "dockside/asset-recovery-revoke", version: 1 },
  // Digest of the read-only adapter validation report a risk/policy approval signs over.
  ASSET_RECOVERY_VALIDATION: { domain: "dockside/asset-recovery-validation", version: 1 },
  ASSET_RECOVERY_EVIDENCE: { domain: "dockside/asset-recovery-evidence", version: 1 },
  // Signed audit export (M17): the export statement and the export key's enrollment proof. Signed
  // only by the deployment's dedicated audit-export key in its isolated signer process.
  AUDIT_EXPORT: { domain: "dockside/audit-export", version: 1 },
  AUDIT_EXPORT_KEY_ENROLLMENT: { domain: "dockside/audit-export-key-enrollment", version: 1 },
  // Digest-only domains (never signed on their own).
  ORGANIZATION_SETTINGS: { domain: "dockside/organization-settings", version: 1 },
  NEAR_ACCOUNT_LINK: { domain: "dockside/near-account-link", version: 1 },
  DESTINATION_SNAPSHOT: { domain: "dockside/destination-snapshot", version: 1 },
  RESERVATION_SOURCE: { domain: "dockside/reservation-source", version: 1 },
  HOLDS_VIEW: { domain: "dockside/holds-view", version: 1 },
} as const;

export type SigningPurpose = keyof typeof SIGNING_DOMAINS;

export function digestFor(purpose: SigningPurpose, payload: CanonicalValue): Uint8Array {
  const d = SIGNING_DOMAINS[purpose];
  return canonicalDigest(d.domain, d.version, payload);
}

export function digestHexFor(purpose: SigningPurpose, payload: CanonicalValue): string {
  return toHex(digestFor(purpose, payload));
}

export function signFor(privateKey: KeyObject, purpose: SigningPurpose, payload: CanonicalValue): string {
  const d = SIGNING_DOMAINS[purpose];
  return signCanonical(privateKey, d.domain, d.version, payload);
}

export function verifyFor(
  publicKey: string,
  purpose: SigningPurpose,
  payload: CanonicalValue,
  signature: string,
): boolean {
  const d = SIGNING_DOMAINS[purpose];
  return verifyCanonical(publicKey, d.domain, d.version, payload, signature);
}

/** Throwing form: SIGNATURE_INVALID when the signature does not verify for exactly this domain. */
export function requireSignature(
  publicKey: string,
  purpose: SigningPurpose,
  payload: CanonicalValue,
  signature: string,
): void {
  if (!verifyFor(publicKey, purpose, payload, signature)) {
    // Distinguish wrong-domain for diagnostics without weakening the check.
    for (const other of Object.keys(SIGNING_DOMAINS) as SigningPurpose[]) {
      if (other !== purpose && verifyFor(publicKey, other, payload, signature)) {
        fail("WRONG_DOMAIN", "signature was produced for a different signing domain", { expected: purpose });
      }
    }
    fail("SIGNATURE_INVALID", "signature does not verify", { purpose });
  }
}

/* ------------------------------------------------------------------ */
/* Nonce and expiry                                                    */
/* ------------------------------------------------------------------ */

/** 32 random bytes as lowercase hex. */
export function newNonce(): string {
  return randomBytes(32).toString("hex");
}

export function parseNonce(raw: unknown): string {
  if (typeof raw !== "string" || !/^[0-9a-f]{32,64}$/.test(raw))
    fail("VALIDATION_FAILED", "nonce must be 16..32 bytes of lowercase hex");
  return raw;
}

export interface FreshnessPolicy {
  /** Maximum allowed expiresAt - issuedAt. */
  readonly maxLifetimeMs: number;
  /** Tolerated clock skew for issuedAt in the future. */
  readonly maxSkewMs: number;
}

/**
 * Validate an issued/expiry window against the verifier's clock. Fails closed:
 * expiry is exclusive, a lifetime longer than policy is rejected rather than clamped.
 */
export function checkValidityWindow(
  window: { readonly issuedAt: number; readonly expiresAt: number },
  nowMs: number,
  policy: FreshnessPolicy,
): void {
  const { issuedAt, expiresAt } = window;
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || issuedAt < 0) {
    fail("VALIDATION_FAILED", "issuedAt/expiresAt must be integer milliseconds");
  }
  if (expiresAt <= issuedAt) fail("VALIDATION_FAILED", "expiresAt must be after issuedAt");
  if (expiresAt - issuedAt > policy.maxLifetimeMs) {
    fail("VALIDATION_FAILED", "validity window exceeds policy lifetime", {
      maxLifetimeMs: policy.maxLifetimeMs,
    });
  }
  if (issuedAt > nowMs + policy.maxSkewMs) fail("NOT_YET_VALID", "issuedAt is in the future");
  if (nowMs >= expiresAt) fail("EXPIRED", "signature or challenge has expired");
}

/** Persistence boundary for one-time nonces. Implemented durably in @dockside/store. */
export interface NonceRegistry {
  /** Atomically record (scope, nonce). Throws NONCE_REPLAYED when already present. */
  consume(scope: string, nonce: string, expiresAt: number): void;
}
