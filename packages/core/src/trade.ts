import { z } from "zod";
import { type CanonicalValue, toHex } from "./canonical.js";
import { NETWORKS, parseAmount, parseId, parseNearAccountId, parsePublicKey } from "./codecs.js";
import { fail } from "./errors.js";
import type { JsonValue } from "./json.js";
import { codec, epochMs, hex64, parseVersioned, parseWith, slug, text } from "./schemas.js";
import { digestFor } from "./signing.js";

/**
 * Canonical trade revision terms, schema version 1 (FR-01, INV-01).
 *
 * Every field here is material: the digest covers all of it, so any change yields a
 * different identity and requires a new revision. Unknown fields fail closed.
 */
export const TRADE_TERMS_SCHEMA_VERSION = 1;
export const TRADE_PROFILE_DIRECT_TESTNET = "dockside-direct-testnet-v1";
export const REFUND_POLICY_ID = "dockside-refund-v1";

export interface TradeParseOptions {
  /** `input` tolerates operator display forms of account ids (trim/lowercase ASCII). Default `strict`. */
  readonly addressMode?: "strict" | "input";
}

function buildSchema(opts: TradeParseOptions) {
  const mode = opts.addressMode ?? "strict";
  const networkSchema = z.enum(NETWORKS);
  const id = (prefix: string) => z.string().transform(codec((s) => parseId(s, prefix)));
  const pk = z.string().transform(codec(parsePublicKey));
  // Grammar/canonical form here; network suffix rules are applied once the trade network is known.
  const account = z.string().transform(codec((s) => parseNearAccountId(s, { mode })));

  const party = z
    .object({
      organizationId: id("org"),
      principalId: id("prn"),
      keyVersionId: id("key"),
      publicKey: pk,
      accountId: account,
    })
    .strict();

  const humanAuthority = z
    .object({
      principalId: id("prn"),
      keyVersionId: id("key"),
      publicKey: pk,
    })
    .strict();

  const serviceBinding = (capability: "MANIFEST_ATTEST" | "DETERMINISTIC_POLICY_SET") =>
    z
      .object({
        enrollmentId: id("svc"),
        serviceId: slug,
        keyVersion: z.number().int().min(1).max(1_000_000),
        publicKey: pk,
        capability: z.literal(capability),
        scope: z
          .object({
            organizationId: id("org"),
            tradeId: id("trd").nullable(),
            evidencePolicyId: slug,
            evidencePolicyRevision: z.number().int().min(1),
          })
          .strict(),
        attestationSchema: z.string().regex(/^dockside\/[a-z-]+@[0-9]+$/),
      })
      .strict();

  return z
    .object({
      schemaVersion: z.literal(TRADE_TERMS_SCHEMA_VERSION),
      profileVersion: z.literal(TRADE_PROFILE_DIRECT_TESTNET),
      tradeId: id("trd"),
      revision: z.number().int().min(1).max(1_000_000),
      predecessorDigest: hex64.nullable(),
      network: networkSchema,
      escrowContractId: account,
      buyer: party,
      supplier: party,
      asset: z.object({ kind: z.literal("NEAR_NATIVE"), network: networkSchema }).strict(),
      amountYocto: z.string().transform(codec(parseAmount)),
      milestone: z.object({ id: slug, description: text(2000) }).strict(),
      evidencePolicy: z.object({ id: slug, revision: z.number().int().min(1), digest: hex64 }).strict(),
      inspector: humanAuthority
        .extend({ attestationSchema: z.literal("dockside/inspection-attestation@1") })
        .strict(),
      manifestAttestor: serviceBinding("MANIFEST_ATTEST"),
      policySetter: serviceBinding("DETERMINISTIC_POLICY_SET"),
      riskResolver: humanAuthority,
      payout: z
        .object({
          network: networkSchema,
          recipientType: z.literal("NEAR_ACCOUNT"),
          destination: account,
        })
        .strict(),
      refundPolicy: z.object({ id: z.literal(REFUND_POLICY_ID), revision: z.literal(1) }).strict(),
      delayPolicy: z
        .object({
          destinationChangeDelayMs: z
            .number()
            .int()
            .min(0)
            .max(30 * 24 * 3600 * 1000),
        })
        .strict(),
      expiresAt: epochMs,
    })
    .strict()
    .superRefine((t, ctx) => {
      const bad = (message: string, path: (string | number)[], docksideCode = "VALIDATION_FAILED") =>
        ctx.addIssue({ code: z.ZodIssueCode.custom, message, path, params: { docksideCode } });
      if (t.asset.network !== t.network) bad("asset network must equal trade network", ["asset", "network"]);
      if (t.payout.network !== t.network)
        bad("payout network must equal trade network", ["payout", "network"]);
      if (t.amountYocto <= 0n) bad("amount must be positive", ["amountYocto"], "INVALID_AMOUNT");
      if ((t.revision === 1) !== (t.predecessorDigest === null)) {
        bad("predecessorDigest must be null exactly for revision 1", ["predecessorDigest"]);
      }
      const accounts: [string, string][] = [
        ["escrowContractId", t.escrowContractId],
        ["buyer.accountId", t.buyer.accountId],
        ["supplier.accountId", t.supplier.accountId],
        ["payout.destination", t.payout.destination],
      ];
      for (const [path, acct] of accounts) {
        try {
          parseNearAccountId(acct, { network: t.network, namedOnly: path === "payout.destination" });
        } catch (e) {
          const code = (e as { code?: string }).code ?? "INVALID_ADDRESS";
          bad(`${path}: ${(e as Error).message}`, path.split("."), code);
        }
      }
      // INV-13 structural independence: distinct principals, distinct keys, distinct counterparty orgs.
      const humans = [
        ["buyer", t.buyer],
        ["supplier", t.supplier],
        ["inspector", t.inspector],
        ["riskResolver", t.riskResolver],
      ] as const;
      const principals = new Set(humans.map(([, h]) => h.principalId));
      if (principals.size !== humans.length) {
        bad(
          "buyer, supplier, inspector and risk resolver must be distinct principals",
          ["buyer"],
          "SEPARATION_OF_DUTIES",
        );
      }
      const keys = [
        ...humans.map(([, h]) => h.publicKey),
        t.manifestAttestor.publicKey,
        t.policySetter.publicKey,
      ];
      if (new Set(keys).size !== keys.length) {
        bad("every authority must use a distinct key", ["buyer"], "SEPARATION_OF_DUTIES");
      }
      if (t.buyer.organizationId === t.supplier.organizationId) {
        bad(
          "buyer and supplier must belong to different organizations",
          ["supplier"],
          "SEPARATION_OF_DUTIES",
        );
      }
      if (t.manifestAttestor.enrollmentId === t.policySetter.enrollmentId) {
        bad(
          "ManifestAttestor and policy setter must be distinct enrollments",
          ["policySetter"],
          "SEPARATION_OF_DUTIES",
        );
      }
      for (const svc of ["manifestAttestor", "policySetter"] as const) {
        const scope = t[svc].scope;
        if (scope.tradeId !== null && scope.tradeId !== t.tradeId) {
          bad(`${svc} scope is bound to a different trade`, [svc, "scope", "tradeId"], "SCOPE_MISMATCH");
        }
        if (
          scope.evidencePolicyId !== t.evidencePolicy.id ||
          scope.evidencePolicyRevision !== t.evidencePolicy.revision
        ) {
          bad(`${svc} scope does not cover the trade EvidencePolicy`, [svc, "scope"], "SCOPE_MISMATCH");
        }
      }
    });
}

const strictSchema = buildSchema({});
const inputSchema = buildSchema({ addressMode: "input" });

export type TradeTerms = z.output<typeof strictSchema>;

/** Parse already-decoded JSON (object) into validated, normalised trade terms. */
export function tradeTermsFromJson(value: unknown, opts: TradeParseOptions = {}): TradeTerms {
  return parseWith(opts.addressMode === "input" ? inputSchema : strictSchema, value);
}

/** Parse raw bytes at the trust boundary (duplicate keys, limits, version dispatch, strict schema). */
export function parseTradeTerms(raw: string | Uint8Array, opts: TradeParseOptions = {}): TradeTerms {
  return parseVersioned<TradeTerms>(raw, {
    [TRADE_TERMS_SCHEMA_VERSION]: (v: JsonValue) => tradeTermsFromJson(v, opts),
  });
}

/** Typed canonical form of the terms. Amount is u128; integers are u64; strings are NFC. */
export function tradeTermsCanonical(t: TradeTerms): CanonicalValue {
  const party = (p: TradeTerms["buyer"]) => ({
    organizationId: p.organizationId,
    principalId: p.principalId,
    keyVersionId: p.keyVersionId,
    publicKey: p.publicKey,
    accountId: p.accountId,
  });
  const svc = (s: TradeTerms["manifestAttestor"] | TradeTerms["policySetter"]) => ({
    enrollmentId: s.enrollmentId,
    serviceId: s.serviceId,
    keyVersion: s.keyVersion,
    publicKey: s.publicKey,
    capability: s.capability,
    scope: {
      organizationId: s.scope.organizationId,
      tradeId: s.scope.tradeId,
      evidencePolicyId: s.scope.evidencePolicyId,
      evidencePolicyRevision: s.scope.evidencePolicyRevision,
    },
    attestationSchema: s.attestationSchema,
  });
  return {
    schemaVersion: t.schemaVersion,
    profileVersion: t.profileVersion,
    tradeId: t.tradeId,
    revision: t.revision,
    predecessorDigest: t.predecessorDigest,
    network: t.network,
    escrowContractId: t.escrowContractId,
    buyer: party(t.buyer),
    supplier: party(t.supplier),
    asset: { kind: t.asset.kind, network: t.asset.network },
    amountYocto: t.amountYocto,
    milestone: { id: t.milestone.id, description: t.milestone.description },
    evidencePolicy: {
      id: t.evidencePolicy.id,
      revision: t.evidencePolicy.revision,
      digest: t.evidencePolicy.digest,
    },
    inspector: {
      principalId: t.inspector.principalId,
      keyVersionId: t.inspector.keyVersionId,
      publicKey: t.inspector.publicKey,
      attestationSchema: t.inspector.attestationSchema,
    },
    manifestAttestor: svc(t.manifestAttestor),
    policySetter: svc(t.policySetter),
    riskResolver: {
      principalId: t.riskResolver.principalId,
      keyVersionId: t.riskResolver.keyVersionId,
      publicKey: t.riskResolver.publicKey,
    },
    payout: {
      network: t.payout.network,
      recipientType: t.payout.recipientType,
      destination: t.payout.destination,
    },
    refundPolicy: { id: t.refundPolicy.id, revision: t.refundPolicy.revision },
    delayPolicy: { destinationChangeDelayMs: t.delayPolicy.destinationChangeDelayMs },
    expiresAt: t.expiresAt,
  };
}

export function tradeRevisionDigest(t: TradeTerms): string {
  return toHex(digestFor("TRADE_REVISION", tradeTermsCanonical(t)));
}

/** Serialise terms back to boundary JSON (amount as decimal string). */
export function tradeTermsToJson(t: TradeTerms): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(tradeTermsCanonical(t), (_k, v) => (typeof v === "bigint" ? v.toString(10) : v)),
  ) as Record<string, unknown>;
}

/** Top-level material paths that differ between two revisions (deep compare via canonical form). */
export function changedMaterialFields(a: TradeTerms, b: TradeTerms): string[] {
  const ca = tradeTermsCanonical(a) as Record<string, CanonicalValue>;
  const cb = tradeTermsCanonical(b) as Record<string, CanonicalValue>;
  const ser = (v: CanonicalValue) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `n${x}` : x));
  return Object.keys(ca).filter((k) => ser(ca[k] ?? null) !== ser(cb[k] ?? null));
}

/**
 * INV-01: an accepted revision is immutable. Re-submitting the same (tradeId, revision)
 * with different material is rejected; a successor must increment revision by one and
 * bind the predecessor digest.
 */
export function assertRevisionTransition(accepted: TradeTerms, incoming: TradeTerms): "SAME" | "SUCCESSOR" {
  if (incoming.tradeId !== accepted.tradeId) fail("VALIDATION_FAILED", "trade id cannot change");
  if (incoming.revision === accepted.revision) {
    if (tradeRevisionDigest(incoming) !== tradeRevisionDigest(accepted)) {
      fail("IMMUTABLE_FIELD", "accepted trade revision cannot change in place", {
        fields: changedMaterialFields(accepted, incoming).join(","),
      });
    }
    return "SAME";
  }
  if (incoming.revision !== accepted.revision + 1)
    fail("VERSION_CONFLICT", "revision must increment by exactly one");
  if (incoming.predecessorDigest !== tradeRevisionDigest(accepted)) {
    fail("VERSION_CONFLICT", "successor must bind the accepted predecessor digest");
  }
  return "SUCCESSOR";
}
