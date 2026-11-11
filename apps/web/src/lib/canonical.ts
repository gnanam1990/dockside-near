/**
 * Browser implementation of Dockside Canonical Encoding v1 (DCE-1).
 *
 * Mirrors packages/core/src/canonical.ts byte-for-byte (checked against
 * fixtures/canonical-vectors.json in apps/web/test/canonical.test.ts) but uses only
 * TextEncoder and WebCrypto so it runs in the browser. The browser uses it to compute
 * request-proof payloads and to independently recompute challenge digests before
 * signing; it never decides product state.
 */
export type CanonicalValue =
  | null
  | string
  | number
  | bigint
  | boolean
  | Uint8Array
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

export class CanonicalError extends Error {
  override readonly name = "CanonicalError";
}

const LIMITS = {
  maxDepth: 24,
  maxStringBytes: 64 * 1024,
  maxBytesLength: 64 * 1024,
  maxListItems: 4096,
  maxStructFields: 128,
  maxFieldNameLength: 64,
  maxDomainLength: 96,
  maxTotalBytes: 1024 * 1024,
} as const;

const MAGIC = new Uint8Array([0x44, 0x4f, 0x43, 0x4b, 0x53, 0x49, 0x44, 0x45, 0x00]);
const FIELD_NAME = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const DOMAIN = /^dockside\/[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/;
const U128_MAX = (1n << 128n) - 1n;
const utf8 = new TextEncoder();

class Writer {
  private readonly chunks: Uint8Array[] = [];
  size = 0;
  push(b: Uint8Array): void {
    this.size += b.byteLength;
    if (this.size > LIMITS.maxTotalBytes) throw new CanonicalError("canonical encoding exceeds total limit");
    this.chunks.push(b);
  }
  u8(n: number): void {
    this.push(Uint8Array.of(n));
  }
  u16(n: number): void {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, n, false);
    this.push(b);
  }
  u32(n: number): void {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, false);
    this.push(b);
  }
  uint(n: bigint, width: 8 | 16): void {
    const b = new Uint8Array(width);
    let v = n;
    for (let i = width - 1; i >= 0; i--) {
      b[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    this.push(b);
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.size);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.byteLength;
    }
    return out;
  }
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

function wellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

function encodeString(w: Writer, s: string): void {
  if (!wellFormed(s)) throw new CanonicalError("string contains an unpaired surrogate");
  if (s.normalize("NFC") !== s) throw new CanonicalError("string is not NFC");
  const b = utf8.encode(s);
  if (b.byteLength > LIMITS.maxStringBytes) throw new CanonicalError("string too long");
  w.u32(b.byteLength);
  w.push(b);
}

function encodeValue(w: Writer, v: CanonicalValue, depth: number): void {
  if (depth > LIMITS.maxDepth) throw new CanonicalError("value nested too deeply");
  if (v === null) {
    w.u8(0x00);
    return;
  }
  if (typeof v === "string") {
    w.u8(0x01);
    encodeString(w, v);
    return;
  }
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || v < 0 || Object.is(v, -0))
      throw new CanonicalError("numbers must be non-negative safe integers");
    w.u8(0x02);
    w.uint(BigInt(v), 8);
    return;
  }
  if (typeof v === "bigint") {
    if (v < 0n || v > U128_MAX) throw new CanonicalError("bigint outside u128");
    w.u8(0x03);
    w.uint(v, 16);
    return;
  }
  if (typeof v === "boolean") {
    w.u8(0x04);
    w.u8(v ? 1 : 0);
    return;
  }
  if (typeof v !== "object") throw new CanonicalError("unsupported canonical type");
  if (v instanceof Uint8Array) {
    if (v.byteLength > LIMITS.maxBytesLength) throw new CanonicalError("bytes too long");
    w.u8(0x05);
    w.u32(v.byteLength);
    w.push(v);
    return;
  }
  if (Array.isArray(v)) {
    const list = v as readonly CanonicalValue[];
    if (list.length > LIMITS.maxListItems) throw new CanonicalError("list too long");
    w.u8(0x06);
    w.u32(list.length);
    for (const item of list) encodeValue(w, item, depth + 1);
    return;
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) throw new CanonicalError("only plain objects encode");
  const obj = v as { readonly [key: string]: CanonicalValue };
  const names = Object.keys(obj);
  if (names.length > LIMITS.maxStructFields) throw new CanonicalError("too many struct fields");
  const entries = names.map((name) => {
    if (name.length > LIMITS.maxFieldNameLength || !FIELD_NAME.test(name))
      throw new CanonicalError("invalid field name");
    const value = obj[name];
    if (value === undefined) throw new CanonicalError("struct field is undefined");
    return { nameBytes: utf8.encode(name), value };
  });
  entries.sort((a, b) => compareBytes(a.nameBytes, b.nameBytes));
  w.u8(0x07);
  w.u32(entries.length);
  for (const e of entries) {
    w.u32(e.nameBytes.byteLength);
    w.push(e.nameBytes);
    encodeValue(w, e.value, depth + 1);
  }
}

export function canonicalEnvelope(domain: string, version: number, value: CanonicalValue): Uint8Array {
  if (domain.length > LIMITS.maxDomainLength || !DOMAIN.test(domain))
    throw new CanonicalError("invalid signing domain");
  if (!Number.isInteger(version) || version < 1 || version > 0xffff)
    throw new CanonicalError("invalid schema version");
  const w = new Writer();
  w.push(MAGIC);
  const d = utf8.encode(domain);
  w.u32(d.byteLength);
  w.push(d);
  w.u16(version);
  encodeValue(w, value, 0);
  return w.bytes();
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", copy));
}

export async function canonicalDigest(
  domain: string,
  version: number,
  value: CanonicalValue,
): Promise<Uint8Array> {
  return sha256(canonicalEnvelope(domain, version, value));
}

export function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function fromHex(s: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(s)) throw new CanonicalError("hex must be lowercase and even-length");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Typed JSON (as returned by the API in `typedPayload`) back to a canonical value. */
export type TypedJson =
  | { readonly null: null }
  | { readonly str: string }
  | { readonly u64: string }
  | { readonly u128: string }
  | { readonly bool: boolean }
  | { readonly bytes: string }
  | { readonly list: readonly TypedJson[] }
  | { readonly struct: { readonly [k: string]: TypedJson } };

export function fromTypedJson(t: TypedJson): CanonicalValue {
  if (t === null || typeof t !== "object") throw new CanonicalError("typed json node must be an object");
  const keys = Object.keys(t);
  if (keys.length !== 1) throw new CanonicalError("typed json node must have exactly one tag");
  const o = t as Record<string, unknown>;
  if ("null" in o) return null;
  if ("str" in o && typeof o["str"] === "string") return o["str"];
  if ("u64" in o && typeof o["u64"] === "string") {
    const n = Number(o["u64"]);
    if (!Number.isSafeInteger(n) || String(n) !== o["u64"])
      throw new CanonicalError("u64 outside safe range");
    return n;
  }
  if ("u128" in o && typeof o["u128"] === "string") return BigInt(o["u128"]);
  if ("bool" in o && typeof o["bool"] === "boolean") return o["bool"];
  if ("bytes" in o && typeof o["bytes"] === "string") return fromHex(o["bytes"]);
  if ("list" in o && Array.isArray(o["list"])) return (o["list"] as TypedJson[]).map(fromTypedJson);
  if ("struct" in o && o["struct"] !== null && typeof o["struct"] === "object") {
    const out: Record<string, CanonicalValue> = {};
    for (const [k, x] of Object.entries(o["struct"] as Record<string, TypedJson>)) out[k] = fromTypedJson(x);
    return out;
  }
  throw new CanonicalError("unknown typed json tag");
}
