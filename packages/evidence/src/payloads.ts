import { type CanonicalValue, digestHexFor, type TradeTerms } from "@dockside/core";
import { tradeBinding } from "@dockside/near";
import { sha256Hex } from "./objects.js";

/**
 * Canonical signed shapes for evidence. Each mirrors a struct the escrow contract decodes with
 * an exact field set (contract/crates/dockside-escrow-core/src/evidence.rs), so the service and
 * the contract compute the same digests. Adding or renaming a field here makes the contract
 * reject the payload, which is the intended fail-closed behaviour.
 */
export const ATTESTATION_SCHEMA = "dockside/manifest-attestation@1";
export const INSPECTION_SCHEMA = "dockside/inspection-attestation@1";

/** What an issuer (supplier, inspector, buyer) signs to vouch for one original document. */
export function issuancePayload(i: {
  tradeId: string;
  slotId: string;
  content?: Uint8Array;
  originalDigest?: string;
  issuedAt: number;
  issuerPrincipalId: string;
  issuerKeyVersionId: string;
  issuerCapability: string;
}): CanonicalValue {
  const originalDigest = i.originalDigest ?? (i.content ? sha256Hex(i.content) : "");
  return {
    tradeId: i.tradeId,
    slotId: i.slotId,
    originalDigest,
    issuedAt: i.issuedAt,
    issuerPrincipalId: i.issuerPrincipalId,
    issuerKeyVersionId: i.issuerKeyVersionId,
    issuerCapability: i.issuerCapability,
  };
}

export interface ItemFacts {
  readonly itemId: string;
  readonly version: number;
  readonly predecessorItemId: string | null;
  readonly originalDigest: string;
  readonly byteLength: number;
  readonly detectedMime: string;
  readonly contentClass: string;
  readonly resources: {
    readonly pages: number;
    readonly pixels: number;
    readonly decompressedBytes: number;
    readonly decompressionRatioPermille: number;
    readonly parseTimeMs: number;
    readonly parserProfile: string;
  };
  readonly uploader: {
    readonly principalId: string;
    readonly organizationId: string;
    readonly capability: string;
    readonly keyVersionId: string;
  };
  readonly issuer: {
    readonly principalId: string;
    readonly capability: string;
    readonly keyVersionId: string;
    readonly issuedAt: number;
    readonly signature: string;
  };
  readonly freshUntil: number;
  readonly derived: readonly {
    readonly artifactClass: string;
    readonly digest: string;
    readonly transformProfile: string;
    readonly sourceDigest: string;
  }[];
}

export interface SlotFacts {
  readonly slotId: string;
  readonly slotPolicyDigest: string;
  readonly itemCount: number;
  readonly currentnessVersion: number;
  readonly items: readonly ItemFacts[];
}

export function manifestCanonical(
  terms: TradeTerms,
  manifestRevision: number,
  slots: readonly SlotFacts[],
): CanonicalValue {
  return {
    tradeId: terms.tradeId,
    tradeRevision: terms.revision,
    evidencePolicyId: terms.evidencePolicy.id,
    evidencePolicyRevision: terms.evidencePolicy.revision,
    manifestRevision,
    slots: slots as unknown as CanonicalValue,
  };
}

export function manifestDigest(
  terms: TradeTerms,
  manifestRevision: number,
  slots: readonly SlotFacts[],
): string {
  return digestHexFor("EVIDENCE_MANIFEST", manifestCanonical(terms, manifestRevision, slots));
}

/** ManifestAttestation: binds the exact attestor enrollment/key/capability/scope the revision names. */
export function manifestAttestationPayload(
  terms: TradeTerms,
  m: {
    policyDigest: string;
    manifestRevision: number;
    manifestDigest: string;
    slots: readonly SlotFacts[];
    issuedAt: number;
    expiresAt: number;
    nonce: string;
  },
): CanonicalValue {
  const b = terms.manifestAttestor;
  return {
    ...tradeBinding(terms),
    network: terms.network,
    organizationId: b.scope.organizationId,
    evidencePolicyId: terms.evidencePolicy.id,
    evidencePolicyRevision: terms.evidencePolicy.revision,
    evidencePolicyDigest: m.policyDigest,
    schema: ATTESTATION_SCHEMA,
    manifestRevision: m.manifestRevision,
    manifestDigest: m.manifestDigest,
    attestor: {
      enrollmentId: b.enrollmentId,
      serviceId: b.serviceId,
      keyVersion: b.keyVersion,
      capability: b.capability,
      scope: {
        organizationId: b.scope.organizationId,
        tradeId: b.scope.tradeId,
        evidencePolicyId: b.scope.evidencePolicyId,
        evidencePolicyRevision: b.scope.evidencePolicyRevision,
      },
    },
    issuedAt: m.issuedAt,
    expiresAt: m.expiresAt,
    nonce: m.nonce,
    slots: m.slots as unknown as CanonicalValue,
  };
}

export type InspectionDecision = "PASS" | "FAIL" | "REVIEW";

/** Independent inspector decision over one contract-accepted manifest revision. */
export function inspectionPayload(
  terms: TradeTerms,
  i: {
    manifestRevision: number;
    manifestDigest: string;
    decision: InspectionDecision;
    reasonCodes: readonly string[];
    issuedAt: number;
    expiresAt: number;
    nonce: string;
    inspectorPrincipalId?: string;
    inspectorKeyVersionId?: string;
  },
): CanonicalValue {
  return {
    ...tradeBinding(terms),
    milestoneId: terms.milestone.id,
    evidencePolicyId: terms.evidencePolicy.id,
    evidencePolicyRevision: terms.evidencePolicy.revision,
    manifestRevision: i.manifestRevision,
    manifestDigest: i.manifestDigest,
    decision: i.decision,
    reasonCodes: [...i.reasonCodes],
    inspectorPrincipalId: i.inspectorPrincipalId ?? terms.inspector.principalId,
    inspectorKeyVersionId: i.inspectorKeyVersionId ?? terms.inspector.keyVersionId,
    schema: INSPECTION_SCHEMA,
    issuedAt: i.issuedAt,
    expiresAt: i.expiresAt,
    nonce: i.nonce,
  };
}
