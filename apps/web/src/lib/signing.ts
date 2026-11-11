import { type CanonicalValue, canonicalDigest, fromTypedJson, sha256, type TypedJson, toHex } from "./canonical";
import { signBytes } from "./keys";

/**
 * Signing domains the browser may sign for (packages/core/src/signing.ts SIGNING_DOMAINS). A
 * signature is only ever produced for the domain the server-prepared payload names, after the
 * browser has recomputed the digest itself.
 */
export const SIGNING_DOMAINS = {
  TRADE_REVISION: "dockside/trade-revision",
  INSPECTION_ATTESTATION: "dockside/inspection-attestation",
  HOLD_SET: "dockside/hold-set",
  HOLD_RESOLVE: "dockside/hold-resolve",
  BUYER_APPROVAL: "dockside/buyer-approval",
  EVIDENCE_ISSUANCE: "dockside/evidence-issuance",
  RELEASE_INTENT: "dockside/release-intent",
  CANCEL_RELEASE_INTENT: "dockside/cancel-release-intent",
  CANCEL_CONSENT: "dockside/cancel-consent",
  REVOKE_CANCEL_CONSENT: "dockside/revoke-cancel-consent",
  ABANDON_RELEASE_INTENT: "dockside/abandon-release-intent",
} as const;

export type SigningPurpose = keyof typeof SIGNING_DOMAINS;

export function isSigningPurpose(p: string): p is SigningPurpose {
  return Object.hasOwn(SIGNING_DOMAINS, p);
}

export interface PreparedSignature {
  readonly purpose: SigningPurpose;
  readonly value: CanonicalValue;
  /** Digest the browser computed from the payload. */
  readonly digestHex: string;
  /** Digest the server reported, when it reported one. */
  readonly serverDigestHex: string | null;
}

/**
 * Recompute the digest of a server-prepared payload. Refuses (returns a reason) when the payload is
 * not canonical, names an unknown purpose, or the server's digest differs from the browser's.
 */
export async function prepareSignature(
  purpose: string,
  payload: TypedJson,
  serverDigestHex: string | null = null,
): Promise<{ ok: true; value: PreparedSignature } | { ok: false; reason: string }> {
  if (!isSigningPurpose(purpose)) return { ok: false, reason: `this client does not sign ${purpose}` };
  let value: CanonicalValue;
  try {
    value = fromTypedJson(payload);
  } catch (e) {
    return { ok: false, reason: `payload is not canonical: ${(e as Error).message}` };
  }
  const digestHex = toHex(await canonicalDigest(SIGNING_DOMAINS[purpose], 1, value));
  if (serverDigestHex !== null && serverDigestHex !== digestHex)
    return { ok: false, reason: "the server's digest does not match the payload; nothing was signed" };
  return { ok: true, value: { purpose, value, digestHex, serverDigestHex } };
}

/** Sign a prepared payload with the device key (explicit user action only). */
export async function signPrepared(p: PreparedSignature, privateKey: CryptoKey): Promise<string> {
  const digest = await canonicalDigest(SIGNING_DOMAINS[p.purpose], 1, p.value);
  return signBytes(privateKey, digest);
}

/** Evidence issuance statement (packages/evidence/src/payloads.ts issuancePayload). */
export async function issuanceValue(i: {
  tradeId: string;
  slotId: string;
  content: Uint8Array;
  issuedAt: number;
  issuerPrincipalId: string;
  issuerKeyVersionId: string;
  issuerCapability: string;
}): Promise<{ value: CanonicalValue; originalDigest: string }> {
  const originalDigest = toHex(await sha256(i.content));
  return {
    originalDigest,
    value: {
      tradeId: i.tradeId,
      slotId: i.slotId,
      originalDigest,
      issuedAt: i.issuedAt,
      issuerPrincipalId: i.issuerPrincipalId,
      issuerKeyVersionId: i.issuerKeyVersionId,
      issuerCapability: i.issuerCapability,
    },
  };
}

/** Digest of a canonical payload under a signing domain (to compare with a contract's view). */
export async function digestOf(purpose: SigningPurpose, payload: TypedJson): Promise<string> {
  return toHex(await canonicalDigest(SIGNING_DOMAINS[purpose], 1, fromTypedJson(payload)));
}

/** Show a typed payload as flat "field: value" pairs (never re-encoded, display only). */
export function flattenTyped(payload: TypedJson, prefix = ""): Array<readonly [string, string]> {
  const o = payload as Record<string, unknown>;
  if ("struct" in o && o["struct"] && typeof o["struct"] === "object") {
    return Object.entries(o["struct"] as Record<string, TypedJson>).flatMap(([k, v]) =>
      flattenTyped(v, prefix ? `${prefix}.${k}` : k),
    );
  }
  if ("list" in o && Array.isArray(o["list"])) {
    const items = o["list"] as TypedJson[];
    if (items.length === 0) return [[prefix, "(empty list)"]];
    return items.flatMap((v, i) => flattenTyped(v, `${prefix}[${i}]`));
  }
  const tag = Object.keys(o)[0] ?? "?";
  const raw = o[tag];
  return [[prefix, raw === null ? "null" : String(raw)]];
}
