import { type CanonicalValue, fromHex, toHex } from "./canonical.js";
import { fail } from "./errors.js";

/**
 * Typed JSON representation of canonical values, used for cross-language test
 * vectors (fixtures/canonical-vectors.json) so Rust and TypeScript agree on types.
 */
export type TypedJson =
  | { readonly null: null }
  | { readonly str: string }
  | { readonly u64: string }
  | { readonly u128: string }
  | { readonly bool: boolean }
  | { readonly bytes: string }
  | { readonly list: readonly TypedJson[] }
  | { readonly struct: { readonly [k: string]: TypedJson } };

export function toTypedJson(v: CanonicalValue): TypedJson {
  if (v === null) return { null: null };
  if (typeof v === "string") return { str: v };
  if (typeof v === "number") return { u64: String(v) };
  if (typeof v === "bigint") return { u128: v.toString(10) };
  if (typeof v === "boolean") return { bool: v };
  if (v instanceof Uint8Array) return { bytes: toHex(v) };
  if (Array.isArray(v)) return { list: (v as readonly CanonicalValue[]).map(toTypedJson) };
  const out: Record<string, TypedJson> = {};
  for (const [k, x] of Object.entries(v as Record<string, CanonicalValue>)) out[k] = toTypedJson(x);
  return { struct: out };
}

export function fromTypedJson(t: TypedJson): CanonicalValue {
  const keys = Object.keys(t);
  if (keys.length !== 1) fail("VALIDATION_FAILED", "typed json node must have exactly one tag");
  const o = t as Record<string, unknown>;
  if ("null" in o) return null;
  if ("str" in o) return o["str"] as string;
  if ("u64" in o) {
    const n = Number(o["u64"]);
    if (!Number.isSafeInteger(n)) fail("VALIDATION_FAILED", "u64 vector outside JS safe range");
    return n;
  }
  if ("u128" in o) return BigInt(o["u128"] as string);
  if ("bool" in o) return o["bool"] as boolean;
  if ("bytes" in o) return fromHex(o["bytes"] as string);
  if ("list" in o) return (o["list"] as TypedJson[]).map(fromTypedJson);
  if ("struct" in o) {
    const out: Record<string, CanonicalValue> = {};
    for (const [k, x] of Object.entries(o["struct"] as Record<string, TypedJson>)) out[k] = fromTypedJson(x);
    return out;
  }
  return fail("VALIDATION_FAILED", "unknown typed json tag");
}
