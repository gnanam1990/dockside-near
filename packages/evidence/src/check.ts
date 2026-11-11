import {
  type CanonicalValue,
  type ErrorCode,
  fail,
  type TradeTerms,
  tradeRevisionDigest,
} from "@dockside/core";

/**
 * Exact-shape readers for signed payloads, mirroring the contract's `typed::Obj`: a payload
 * must carry exactly the expected fields (extra fields are UNKNOWN_FIELD, so a caller can never
 * smuggle in a `complete` or `eligible` flag) and every scalar has exactly one type.
 */
export type Struct = { readonly [k: string]: CanonicalValue };

export const MAX_SKEW_MS = 5 * 60_000;

export function exact(v: unknown, fields: readonly string[], what: string): Struct {
  if (v === null || typeof v !== "object" || Array.isArray(v) || v instanceof Uint8Array)
    fail("VALIDATION_FAILED", `${what} must be a struct`);
  const o = v as Struct;
  const extra = Object.keys(o).filter((k) => !fields.includes(k));
  if (extra.length)
    fail("UNKNOWN_FIELD", `${what} has unknown fields`, { fields: extra.slice(0, 8).join(",") });
  for (const f of fields) if (!(f in o)) fail("VALIDATION_FAILED", `${what} is missing ${f}`);
  return o;
}

export function str(o: Struct, k: string): string {
  const v = o[k];
  if (typeof v !== "string") fail("VALIDATION_FAILED", `${k} must be a string`);
  return v;
}

export function optStr(o: Struct, k: string): string | null {
  const v = o[k];
  if (v === null) return null;
  if (typeof v !== "string") fail("VALIDATION_FAILED", `${k} must be a string or null`);
  return v;
}

export function u64(o: Struct, k: string): number {
  const v = o[k];
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)
    fail("VALIDATION_FAILED", `${k} must be a u64`);
  return v;
}

export function list(o: Struct, k: string): readonly CanonicalValue[] {
  const v = o[k];
  if (!Array.isArray(v)) fail("VALIDATION_FAILED", `${k} must be a list`);
  return v as readonly CanonicalValue[];
}

export function expectStr(o: Struct, k: string, expected: string | null, code: ErrorCode): void {
  if (optStr(o, k) !== expected) fail(code, `${k} does not match`, { field: k });
}

export function expectU64(o: Struct, k: string, expected: number, code: ErrorCode): void {
  if (u64(o, k) !== expected) fail(code, `${k} does not match`, { field: k });
}

/** contractId / tradeId / tradeRevision / tradeDigest, with the contract's error codes. */
export function checkHeader(o: Struct, terms: TradeTerms): void {
  expectStr(o, "contractId", terms.escrowContractId, "WRONG_CONTRACT");
  expectStr(o, "tradeId", terms.tradeId, "SCOPE_MISMATCH");
  expectU64(o, "tradeRevision", terms.revision, "STALE_REVISION");
  expectStr(o, "tradeDigest", tradeRevisionDigest(terms), "STALE_REVISION");
}

export function checkWindow(
  o: Struct,
  now: number,
  maxLifetimeMs: number,
): { issuedAt: number; expiresAt: number } {
  const issuedAt = u64(o, "issuedAt");
  const expiresAt = u64(o, "expiresAt");
  if (expiresAt <= issuedAt) fail("VALIDATION_FAILED", "expiresAt must be after issuedAt");
  if (expiresAt - issuedAt > maxLifetimeMs)
    fail("VALIDATION_FAILED", "validity window exceeds policy lifetime");
  if (issuedAt > now + MAX_SKEW_MS) fail("NOT_YET_VALID", "issuedAt is in the future");
  if (now >= expiresAt) fail("EXPIRED", "signature has expired");
  return { issuedAt, expiresAt };
}

export function nonceOf(o: Struct): string {
  const n = str(o, "nonce");
  if (!/^[0-9a-f]{32,64}$/.test(n)) fail("VALIDATION_FAILED", "nonce must be 16..32 bytes of lowercase hex");
  return n;
}

export const isHex64 = (s: string) => /^[0-9a-f]{64}$/.test(s);
export const isCode = (s: string) => /^[A-Z0-9_]{1,64}$/.test(s);
