import { fail } from "./errors.js";

/**
 * Capability model (FR-10, INV-13). Every authority is a distinct capability held by
 * a distinct principal. Humans hold human capabilities through proof-of-possession
 * sessions; services hold service capabilities through isolated key custody.
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

export const CAPABILITIES = [...HUMAN_CAPABILITIES, ...SERVICE_CAPABILITIES] as const;

export type HumanCapability = (typeof HUMAN_CAPABILITIES)[number];
export type ServiceCapability = (typeof SERVICE_CAPABILITIES)[number];
export type Capability = (typeof CAPABILITIES)[number];
export type PrincipalKind = "HUMAN" | "SERVICE";

/**
 * Party capabilities that establish independent trade authority. A single principal
 * may hold at most one of them (and never together with ORG_SECURITY_ADMIN), so one
 * operator holding one key cannot act as two parties.
 */
export const PARTY_CAPABILITIES: readonly Capability[] = [
  "BUYER_APPROVER",
  "SUPPLIER_SIGNER",
  "INSPECTOR",
  "RISK_RESOLVER",
];

export function isHumanCapability(c: string): c is HumanCapability {
  return (HUMAN_CAPABILITIES as readonly string[]).includes(c);
}

export function isServiceCapability(c: string): c is ServiceCapability {
  return (SERVICE_CAPABILITIES as readonly string[]).includes(c);
}

export function parseCapability(raw: unknown): Capability {
  if (typeof raw !== "string" || !(CAPABILITIES as readonly string[]).includes(raw)) {
    fail("VALIDATION_FAILED", "unknown capability");
  }
  return raw as Capability;
}

export function capabilityKind(c: Capability): PrincipalKind {
  return isServiceCapability(c) ? "SERVICE" : "HUMAN";
}

/**
 * Throws SEPARATION_OF_DUTIES when adding `next` to `held` would merge authorities
 * that must remain with separate principals.
 */
export function assertCapabilityCompatible(held: readonly Capability[], next: Capability): void {
  if (held.includes(next)) fail("INVALID_STATE", "capability already granted", { capability: next });
  const party = (c: Capability) => PARTY_CAPABILITIES.includes(c);
  const all = [...held, next];
  const parties = all.filter(party);
  if (parties.length > 1) {
    fail("SEPARATION_OF_DUTIES", "a principal may hold only one party capability", { capability: next });
  }
  if (parties.length > 0 && all.includes("ORG_SECURITY_ADMIN")) {
    fail("SEPARATION_OF_DUTIES", "security administrators cannot hold party capabilities", {
      capability: next,
    });
  }
  if (all.includes("AUDITOR") && all.some((c) => c !== "AUDITOR")) {
    fail("SEPARATION_OF_DUTIES", "auditor capability must be held alone", { capability: next });
  }
}

/**
 * Authorization matrix (SECURITY.md) as data. Later modules look actions up here so
 * API, worker and UI layers share one definition. `[]` means nobody: those actions
 * (force terminal status, release a lock) have no authority by construction.
 */
export const AUTHORIZATION_MATRIX = {
  ENROLL_SERVICE_KEY: ["ORG_SECURITY_ADMIN"],
  INVITE_PRINCIPAL: ["ORG_SECURITY_ADMIN"],
  GRANT_ROLE: ["ORG_SECURITY_ADMIN"],
  REVOKE_KEY: ["ORG_SECURITY_ADMIN"],
  START_RECOVERY: ["ORG_SECURITY_ADMIN"],
  ACCEPT_TRADE_REVISION: ["BUYER_APPROVER", "SUPPLIER_SIGNER"],
  CONSENT_DESTINATION_REVISION: ["BUYER_APPROVER", "SUPPLIER_SIGNER"],
  FILL_EVIDENCE_SLOT: ["BUYER_APPROVER", "SUPPLIER_SIGNER", "INSPECTOR", "EVIDENCE_UPLOADER"],
  SIGN_MANIFEST_ATTESTATION: ["MANIFEST_ATTEST"],
  ATTEST_INSPECTION: ["INSPECTOR"],
  REQUEST_HOLD_RESOLUTION: ["BUYER_APPROVER"],
  SET_HOLD: ["DETERMINISTIC_POLICY_SET", "RISK_RESOLVER"],
  RESOLVE_HOLD: ["RISK_RESOLVER"],
  SIGN_CANCEL_RELEASE_INTENT: ["BUYER_APPROVER", "SUPPLIER_SIGNER"],
  SIGN_ABANDON_RELEASE_INTENT: ["BUYER_APPROVER", "SUPPLIER_SIGNER"],
  APPROVE_RELEASE: ["BUYER_APPROVER"],
  // dockside-refund-v1 signers; the contract checks the exact row (initiator, cosigner, revoker).
  SIGN_REFUND_REQUEST: ["BUYER_APPROVER", "SUPPLIER_SIGNER", "RISK_RESOLVER"],
  EXECUTE_AUTHORIZED_OPERATION: ["EXECUTOR"],
  REQUEST_RECONCILIATION: [
    "ORG_SECURITY_ADMIN",
    "BUYER_APPROVER",
    "SUPPLIER_SIGNER",
    "INSPECTOR",
    "DETERMINISTIC_POLICY_SET",
    "RISK_RESOLVER",
    "AUDITOR",
    "EXECUTOR",
  ],
  FORCE_TERMINAL_STATUS: [],
  RELEASE_VALUE_LOCK: [],
  EXPORT_AUDIT: [
    "ORG_SECURITY_ADMIN",
    "BUYER_APPROVER",
    "SUPPLIER_SIGNER",
    "INSPECTOR",
    "RISK_RESOLVER",
    "AUDITOR",
  ],
} as const satisfies Record<string, readonly Capability[]>;

export type AuthorityAction = keyof typeof AUTHORIZATION_MATRIX;

export function capabilityAllows(action: AuthorityAction, held: readonly Capability[]): boolean {
  const allowed: readonly Capability[] = AUTHORIZATION_MATRIX[action];
  return held.some((c) => allowed.includes(c));
}
