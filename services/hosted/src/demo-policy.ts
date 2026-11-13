/**
 * The commercial-documents EvidencePolicy the demo seed registers: the same document the web app
 * offers as its template (apps/web/src/lib/policy-template.ts; services/hosted/test/m55-seed.test.ts
 * keeps the two equal). The API validates every field when it is registered.
 */
const DAY = 24 * 3600_000;

function slot(slotId: string, issuer: string, uploaders: string[], freshnessMs: number) {
  return {
    schema: "dockside/evidence-slot-policy@1",
    slotId,
    purpose: `${slotId} for the milestone`,
    minItems: 1,
    maxItems: 1,
    allowedMime: ["application/pdf", "text/plain"],
    contentClass: "DOCUMENT",
    maxItemBytes: 65_536,
    maxAggregateBytes: 65_536,
    limits: {
      maxPages: 20,
      maxPixels: 4_000_000,
      maxDecompressedBytes: 1_048_576,
      maxDecompressionRatioPermille: 100_000,
      maxParseTimeMs: 2_000,
    },
    parserProfiles: ["dockside-sniff@1"],
    uploaderCapabilities: uploaders,
    issuerCapabilities: [issuer],
    issuedAtRequired: true,
    freshnessMs,
    replacement: "SUPERSEDE_CURRENT",
    requiredDerived: [{ artifactClass: "TEXT_EXTRACT", transformProfile: "dockside-text@1" }],
  };
}

export function commercialDocsPolicy(policyId: string): Record<string, unknown> {
  return {
    schema: "dockside/evidence-policy@1",
    policyId,
    revision: 1,
    attestationLifetimeMs: DAY,
    slots: [
      slot("commercial-invoice", "SUPPLIER_SIGNER", ["SUPPLIER_SIGNER", "EVIDENCE_UPLOADER"], 30 * DAY),
      slot("inspection-report", "INSPECTOR", ["INSPECTOR"], 7 * DAY),
      {
        ...slot("cargo-photos", "INSPECTOR", ["INSPECTOR", "BUYER_APPROVER"], 30 * DAY),
        allowedMime: ["image/png", "image/jpeg"],
        contentClass: "IMAGE",
        maxItems: 2,
        maxAggregateBytes: 100_000,
        requiredDerived: [{ artifactClass: "IMAGE_METADATA", transformProfile: "dockside-image-meta@1" }],
      },
    ],
  };
}
