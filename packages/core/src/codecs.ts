import { fail } from "./errors.js";

/* ------------------------------------------------------------------ */
/* Base58 (Bitcoin alphabet, as used by NEAR keys and signatures)      */
/* ------------------------------------------------------------------ */

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP = new Map<string, number>([...B58].map((c, i) => [c, i]));

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  return "1".repeat(zeros) + out;
}

export function base58Decode(s: string): Uint8Array {
  if (s.length === 0 || s.length > 128) fail("NON_CANONICAL", "base58 length out of range");
  let n = 0n;
  let zeros = 0;
  let leading = true;
  for (const c of s) {
    const v = B58_MAP.get(c);
    if (v === undefined) fail("NON_CANONICAL", "invalid base58 character");
    if (leading && v === 0) zeros++;
    else leading = false;
    n = n * 58n + BigInt(v);
  }
  const body: number[] = [];
  while (n > 0n) {
    body.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return new Uint8Array([...new Array<number>(zeros).fill(0), ...body]);
}

/* ------------------------------------------------------------------ */
/* Networks and assets                                                 */
/* ------------------------------------------------------------------ */

export const NETWORKS = ["near-testnet", "near-mainnet"] as const;
export type Network = (typeof NETWORKS)[number];

/** The only asset in the WORKING_TESTNET corridor: native NEAR, 24 decimals, smallest unit yoctoNEAR. */
export const NATIVE_NEAR_DECIMALS = 24;
export type AssetId = { readonly kind: "NEAR_NATIVE"; readonly network: Network };

export function nativeNear(network: Network): AssetId {
  return Object.freeze({ kind: "NEAR_NATIVE", network });
}

/* ------------------------------------------------------------------ */
/* NEAR account IDs                                                    */
/* ------------------------------------------------------------------ */

export type NearAccountId = string & { readonly __brand: "NearAccountId" };

// NEAR protocol account-id grammar (nearcore AccountId validation).
const NEAR_ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const IMPLICIT_ED25519 = /^[0-9a-f]{64}$/;
const IMPLICIT_ETH = /^0x[0-9a-f]{40}$/;

export interface AccountParseOptions {
  /** When given, named accounts must carry that network's suffix rules. */
  readonly network?: Network;
  /**
   * `strict` (signed payloads): the value must already be canonical.
   * `input` (operator typed): surrounding ASCII whitespace is trimmed and ASCII
   * letters lowercased; anything else non-canonical is rejected as ambiguous.
   */
  readonly mode?: "strict" | "input";
  /** Require a named account (no implicit hex/eth). The supplier corridor requires named testnet accounts. */
  readonly namedOnly?: boolean;
}

export function parseNearAccountId(raw: string, opts: AccountParseOptions): NearAccountId {
  if (typeof raw !== "string") fail("INVALID_ADDRESS", "account id must be a string");
  let s = raw;
  if (opts.mode === "input") {
    // Only ASCII is tolerated for display-form normalization; any non-ASCII
    // character (homoglyphs, zero-width, full-width) is ambiguous.
    if (/[^\x20-\x7e\t]/.test(s)) fail("AMBIGUOUS_ADDRESS", "account id contains non-ASCII characters");
    s = s.trim().toLowerCase();
  } else if (/[^\x21-\x7e]/.test(s)) {
    fail("AMBIGUOUS_ADDRESS", "account id contains whitespace or non-ASCII characters");
  }
  if (s.length < 2 || s.length > 64) fail("INVALID_ADDRESS", "account id length must be 2..64");
  if (s !== s.toLowerCase()) fail("NON_CANONICAL", "account id must be lowercase");
  if (!NEAR_ACCOUNT.test(s)) fail("INVALID_ADDRESS", "account id violates NEAR account grammar");
  const implicit = IMPLICIT_ED25519.test(s) || IMPLICIT_ETH.test(s);
  if (implicit) {
    if (opts.namedOnly) fail("INVALID_ADDRESS", "a named account is required");
  } else {
    const tla = s.slice(s.lastIndexOf(".") + 1);
    if (!s.includes(".")) {
      // Top-level accounts other than the network registrar roots are not accepted as counterparties.
      fail("INVALID_ADDRESS", "top-level account ids are not accepted as counterparties");
    }
    if (opts.network === "near-testnet" && tla !== "testnet") {
      fail("INVALID_ADDRESS", "testnet named accounts must end with .testnet");
    }
    if (opts.network === "near-mainnet" && tla === "testnet") {
      fail("INVALID_ADDRESS", "mainnet account cannot be a .testnet account");
    }
  }
  return s as NearAccountId;
}

/* ------------------------------------------------------------------ */
/* Ed25519 public keys ("ed25519:<base58>") and signatures             */
/* ------------------------------------------------------------------ */

export type PublicKeyString = string & { readonly __brand: "PublicKey" };
export type SignatureString = string & { readonly __brand: "Signature" };

export function parsePublicKey(raw: string): PublicKeyString {
  if (typeof raw !== "string" || !raw.startsWith("ed25519:"))
    fail("INVALID_KEY", "public key must be ed25519:<base58>");
  const body = raw.slice("ed25519:".length);
  const bytes = base58Decode(body);
  if (bytes.length !== 32) fail("INVALID_KEY", "ed25519 public key must be 32 bytes");
  if (base58Encode(bytes) !== body) fail("NON_CANONICAL", "public key base58 is not canonical");
  return raw as PublicKeyString;
}

export function publicKeyBytes(pk: PublicKeyString | string): Uint8Array {
  return base58Decode(parsePublicKey(pk).slice("ed25519:".length));
}

export function encodePublicKey(bytes: Uint8Array): PublicKeyString {
  if (bytes.length !== 32) fail("INVALID_KEY", "ed25519 public key must be 32 bytes");
  return `ed25519:${base58Encode(bytes)}` as PublicKeyString;
}

export function parseSignature(raw: string): SignatureString {
  if (typeof raw !== "string" || !raw.startsWith("ed25519:"))
    fail("SIGNATURE_INVALID", "signature must be ed25519:<base58>");
  const body = raw.slice("ed25519:".length);
  let bytes: Uint8Array;
  try {
    bytes = base58Decode(body);
  } catch {
    fail("SIGNATURE_INVALID", "signature is not base58");
  }
  if (bytes.length !== 64) fail("SIGNATURE_INVALID", "ed25519 signature must be 64 bytes");
  if (base58Encode(bytes) !== body) fail("SIGNATURE_INVALID", "signature base58 is not canonical");
  return raw as SignatureString;
}

export function signatureBytes(sig: string): Uint8Array {
  return base58Decode(parseSignature(sig).slice("ed25519:".length));
}

export function encodeSignature(bytes: Uint8Array): SignatureString {
  if (bytes.length !== 64) fail("SIGNATURE_INVALID", "ed25519 signature must be 64 bytes");
  return `ed25519:${base58Encode(bytes)}` as SignatureString;
}

/* ------------------------------------------------------------------ */
/* Amounts (integer smallest units)                                    */
/* ------------------------------------------------------------------ */

const U128_MAX = (1n << 128n) - 1n;

/** Parse a canonical decimal string of smallest units (yoctoNEAR). No signs, no leading zeros, no decimals. */
export function parseAmount(raw: string): bigint {
  if (typeof raw !== "string") fail("INVALID_AMOUNT", "amount must be a decimal string of smallest units");
  if (!/^(0|[1-9][0-9]{0,38})$/.test(raw))
    fail("INVALID_AMOUNT", "amount must be a canonical non-negative integer string");
  const v = BigInt(raw);
  if (v > U128_MAX) fail("INVALID_AMOUNT", "amount exceeds u128");
  return v;
}

export function formatAmount(v: bigint): string {
  if (v < 0n || v > U128_MAX) fail("INVALID_AMOUNT", "amount outside u128");
  return v.toString(10);
}

/** Convert an operator-typed decimal NEAR amount ("1.25") into yoctoNEAR without floating point. */
export function nearToYocto(display: string): bigint {
  const m = /^(0|[1-9][0-9]{0,14})(?:\.([0-9]{1,24}))?$/.exec(display);
  if (!m) fail("INVALID_AMOUNT", "NEAR amount must be a decimal with at most 24 fractional digits");
  const whole = BigInt(m[1] as string);
  const frac = BigInt((m[2] ?? "").padEnd(NATIVE_NEAR_DECIMALS, "0"));
  return whole * 10n ** BigInt(NATIVE_NEAR_DECIMALS) + frac;
}

/** Display yoctoNEAR as a NEAR decimal string. Display only: never feed back into signed bytes. */
export function yoctoToNear(v: bigint): string {
  const base = 10n ** BigInt(NATIVE_NEAR_DECIMALS);
  const whole = v / base;
  const frac = (v % base).toString().padStart(NATIVE_NEAR_DECIMALS, "0").replace(/0+$/, "");
  return frac.length ? `${whole}.${frac}` : whole.toString();
}

/* ------------------------------------------------------------------ */
/* Identifiers                                                         */
/* ------------------------------------------------------------------ */

const ID = /^[a-z]{2,8}_[0-9a-f]{32}$/;

export function parseId(raw: string, prefix?: string): string {
  if (typeof raw !== "string" || !ID.test(raw)) fail("VALIDATION_FAILED", "identifier is malformed");
  if (prefix !== undefined && !raw.startsWith(`${prefix}_`)) {
    fail("VALIDATION_FAILED", "identifier has wrong type prefix", { expected: prefix });
  }
  return raw;
}

export const ID_PATTERN = ID;
