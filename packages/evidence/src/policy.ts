import { type CanonicalValue, digestHexFor, parseWith, slug, text } from "@dockside/core";
import { z } from "zod";

/**
 * Versioned EvidencePolicy (FR-03). The canonical form of the parsed policy is exactly the
 * value the escrow contract decodes and digests (`dockside/evidence-policy`), so the digest
 * signed into a trade revision is the same on both sides.
 */
export const POLICY_SCHEMA = "dockside/evidence-policy@1";
export const SLOT_SCHEMA = "dockside/evidence-slot-policy@1";
export const PARSER_PROFILE = "dockside-sniff@1";

/** Content the sniffing parser can classify from bytes, and the class each belongs to. */
export const SUPPORTED_MIME = {
  "application/pdf": "DOCUMENT",
  "text/plain": "DOCUMENT",
  "image/png": "IMAGE",
  "image/jpeg": "IMAGE",
} as const;
export type SupportedMime = keyof typeof SUPPORTED_MIME;
export type ContentClass = (typeof SUPPORTED_MIME)[SupportedMime];

/** Derived artifacts the service can produce, with the only transform profile for each. */
export const DERIVED_PROFILES = {
  TEXT_EXTRACT: { transformProfile: "dockside-text@1", contentClass: "DOCUMENT" },
  IMAGE_METADATA: { transformProfile: "dockside-image-meta@1", contentClass: "IMAGE" },
} as const;
export type DerivedClass = keyof typeof DERIVED_PROFILES;

export const UPLOADER_CAPABILITIES = [
  "BUYER_APPROVER",
  "SUPPLIER_SIGNER",
  "INSPECTOR",
  "EVIDENCE_UPLOADER",
] as const;
export const ISSUER_CAPABILITIES = ["BUYER_APPROVER", "SUPPLIER_SIGNER", "INSPECTOR"] as const;
export type UploaderCapability = (typeof UPLOADER_CAPABILITIES)[number];
export type IssuerCapability = (typeof ISSUER_CAPABILITIES)[number];

const MAX_ITEM_BYTES = 64 * 1024 * 1024;
const MAX_LIFETIME_MS = 30 * 24 * 3600_000;
const MAX_FRESHNESS_MS = 400 * 24 * 3600_000;
const posInt = (max: number) => z.number().int().min(1).max(max);

const slotSchema = z
  .object({
    schema: z.literal(SLOT_SCHEMA),
    slotId: slug,
    purpose: text(200),
    minItems: posInt(32),
    maxItems: posInt(32),
    allowedMime: z
      .array(z.enum(Object.keys(SUPPORTED_MIME) as [SupportedMime, ...SupportedMime[]]))
      .min(1)
      .max(4),
    contentClass: z.enum(["DOCUMENT", "IMAGE"]),
    maxItemBytes: posInt(MAX_ITEM_BYTES),
    maxAggregateBytes: posInt(32 * MAX_ITEM_BYTES),
    limits: z
      .object({
        maxPages: z.number().int().min(0).max(10_000),
        maxPixels: z.number().int().min(0).max(200_000_000),
        maxDecompressedBytes: posInt(512 * 1024 * 1024),
        maxDecompressionRatioPermille: posInt(10_000_000),
        maxParseTimeMs: posInt(60_000),
      })
      .strict(),
    parserProfiles: z.array(z.literal(PARSER_PROFILE)).min(1).max(1),
    uploaderCapabilities: z.array(z.enum(UPLOADER_CAPABILITIES)).min(1).max(4),
    issuerCapabilities: z.array(z.enum(ISSUER_CAPABILITIES)).min(1).max(3),
    issuedAtRequired: z.boolean(),
    freshnessMs: posInt(MAX_FRESHNESS_MS),
    replacement: z.literal("SUPERSEDE_CURRENT"),
    requiredDerived: z
      .array(
        z
          .object({
            artifactClass: z.enum(["TEXT_EXTRACT", "IMAGE_METADATA"]),
            transformProfile: z.string(),
          })
          .strict(),
      )
      .max(2),
  })
  .strict()
  .superRefine((s, ctx) => {
    const bad = (message: string, path: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: [path] });
    if (s.maxItems < s.minItems) bad("maxItems must be >= minItems", "maxItems");
    if (s.maxAggregateBytes < s.maxItemBytes)
      bad("maxAggregateBytes must be >= maxItemBytes", "maxAggregateBytes");
    for (const m of s.allowedMime) {
      if (SUPPORTED_MIME[m] !== s.contentClass) bad(`${m} is not ${s.contentClass} content`, "allowedMime");
    }
    if (new Set(s.allowedMime).size !== s.allowedMime.length) bad("duplicate MIME type", "allowedMime");
    if (new Set(s.uploaderCapabilities).size !== s.uploaderCapabilities.length)
      bad("duplicate uploader capability", "uploaderCapabilities");
    if (new Set(s.issuerCapabilities).size !== s.issuerCapabilities.length)
      bad("duplicate issuer capability", "issuerCapabilities");
    const seen = new Set<string>();
    for (const d of s.requiredDerived) {
      const p = DERIVED_PROFILES[d.artifactClass];
      if (d.transformProfile !== p.transformProfile) bad("unknown transform profile", "requiredDerived");
      if (p.contentClass !== s.contentClass)
        bad(`${d.artifactClass} cannot derive from ${s.contentClass}`, "requiredDerived");
      if (seen.has(d.artifactClass)) bad("duplicate derived artifact class", "requiredDerived");
      seen.add(d.artifactClass);
    }
  });

const policySchema = z
  .object({
    schema: z.literal(POLICY_SCHEMA),
    policyId: slug,
    revision: posInt(1_000_000),
    attestationLifetimeMs: posInt(MAX_LIFETIME_MS),
    slots: z.array(slotSchema).min(1).max(32),
  })
  .strict()
  .superRefine((p, ctx) => {
    const ids = p.slots.map((s) => s.slotId);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "slot ids must be unique", path: ["slots"] });
    }
  });

export type EvidencePolicy = z.output<typeof policySchema>;
export type SlotPolicy = EvidencePolicy["slots"][number];
/** Boundary input: untrusted until parsed, so enumerations are plain strings here. */
export interface SlotPolicyInput {
  readonly schema: string;
  readonly slotId: string;
  readonly purpose: string;
  readonly minItems: number;
  readonly maxItems: number;
  readonly allowedMime: readonly string[];
  readonly contentClass: string;
  readonly maxItemBytes: number;
  readonly maxAggregateBytes: number;
  readonly limits: {
    readonly maxPages: number;
    readonly maxPixels: number;
    readonly maxDecompressedBytes: number;
    readonly maxDecompressionRatioPermille: number;
    readonly maxParseTimeMs: number;
  };
  readonly parserProfiles: readonly string[];
  readonly uploaderCapabilities: readonly string[];
  readonly issuerCapabilities: readonly string[];
  readonly issuedAtRequired: boolean;
  readonly freshnessMs: number;
  readonly replacement: string;
  readonly requiredDerived: readonly { readonly artifactClass: string; readonly transformProfile: string }[];
}

export interface EvidencePolicyInput {
  readonly schema: string;
  readonly policyId: string;
  readonly revision: number;
  readonly attestationLifetimeMs: number;
  readonly slots: readonly SlotPolicyInput[];
}

export function parseEvidencePolicy(raw: unknown): EvidencePolicy {
  return parseWith(policySchema, raw);
}

/** Canonical value of a validated policy; identical to what the contract decodes. */
export function policyCanonical(p: EvidencePolicy): CanonicalValue {
  return p as unknown as CanonicalValue;
}

export function policyDigest(raw: EvidencePolicyInput | EvidencePolicy): string {
  return digestHexFor("EVIDENCE_POLICY", policyCanonical(parseEvidencePolicy(raw)));
}

export function slotPolicyDigest(s: SlotPolicy): string {
  return digestHexFor("EVIDENCE_SLOT_POLICY", s as unknown as CanonicalValue);
}
