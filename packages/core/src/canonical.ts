import { createHash } from "node:crypto";
import { fail } from "./errors.js";
import { isWellFormed } from "./json.js";

/**
 * Dockside Canonical Encoding v1 (DCE-1).
 *
 * Deterministic, typed, length-prefixed bytes shared by the service (this file)
 * and the Rust contract crate (contract/crates/dockside-canonical). The two are
 * cross-checked against fixtures/canonical-vectors.json.
 *
 * Value encoding (all integers big-endian):
 *   0x00 null
 *   0x01 string  : u32 byte length, UTF-8 bytes (must be well-formed and NFC)
 *   0x02 u64     : 8 bytes            (JS: non-negative safe integer `number`)
 *   0x03 u128    : 16 bytes           (JS: `bigint` in [0, 2^128))
 *   0x04 bool    : 1 byte 0x00 | 0x01
 *   0x05 bytes   : u32 length, raw bytes (JS: Uint8Array)
 *   0x06 list    : u32 count, encoded items in order
 *   0x07 struct  : u32 field count, then per field (sorted by UTF-8 bytes of name):
 *                  u32 name length, ASCII name, encoded value
 *
 * Envelope:
 *   "DOCKSIDE" 0x00 | u32 domain length | ASCII domain | u16 schema version | encoded value
 * Digest: SHA-256(envelope). Signatures are Ed25519 over the 32-byte digest.
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

export const TAG = {
  NULL: 0x00,
  STRING: 0x01,
  U64: 0x02,
  U128: 0x03,
  BOOL: 0x04,
  BYTES: 0x05,
  LIST: 0x06,
  STRUCT: 0x07,
} as const;

export const CANONICAL_LIMITS = Object.freeze({
  maxDepth: 24,
  maxStringBytes: 64 * 1024,
  maxBytesLength: 64 * 1024,
  maxListItems: 4096,
  maxStructFields: 128,
  maxFieldNameLength: 64,
  maxDomainLength: 96,
  maxTotalBytes: 1024 * 1024,
});

const MAGIC = new Uint8Array([0x44, 0x4f, 0x43, 0x4b, 0x53, 0x49, 0x44, 0x45, 0x00]); // "DOCKSIDE\0"
const FIELD_NAME = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const DOMAIN = /^dockside\/[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/;
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const utf8 = new TextEncoder();

class Writer {
  private chunks: Uint8Array[] = [];
  size = 0;

  push(b: Uint8Array): void {
    this.size += b.byteLength;
    if (this.size > CANONICAL_LIMITS.maxTotalBytes) {
      fail("LIMIT_EXCEEDED", "canonical encoding exceeds total byte limit");
    }
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

  bigUint(n: bigint, width: 8 | 16): void {
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

function encodeString(w: Writer, s: string): void {
  if (!isWellFormed(s)) fail("NON_CANONICAL", "string contains an unpaired surrogate");
  if (s.normalize("NFC") !== s) fail("NON_CANONICAL", "string is not in Unicode NFC form");
  const b = utf8.encode(s);
  if (b.byteLength > CANONICAL_LIMITS.maxStringBytes) fail("LIMIT_EXCEEDED", "canonical string too long");
  w.u32(b.byteLength);
  w.push(b);
}

function encodeValue(w: Writer, v: CanonicalValue, depth: number): void {
  if (depth > CANONICAL_LIMITS.maxDepth) fail("LIMIT_EXCEEDED", "canonical value nested too deeply");
  if (v === null) {
    w.u8(TAG.NULL);
    return;
  }
  switch (typeof v) {
    case "string":
      w.u8(TAG.STRING);
      encodeString(w, v);
      return;
    case "number":
      if (!Number.isSafeInteger(v) || v < 0 || Object.is(v, -0)) {
        fail("NON_CANONICAL", "numbers must be non-negative safe integers (u64)");
      }
      w.u8(TAG.U64);
      w.bigUint(BigInt(v), 8);
      return;
    case "bigint":
      if (v < 0n || v > U128_MAX) fail("NON_CANONICAL", "bigint outside u128 range");
      w.u8(TAG.U128);
      w.bigUint(v, 16);
      return;
    case "boolean":
      w.u8(TAG.BOOL);
      w.u8(v ? 1 : 0);
      return;
    case "object":
      break;
    default:
      fail("NON_CANONICAL", `unsupported canonical type: ${typeof v}`);
  }
  if (v instanceof Uint8Array) {
    if (v.byteLength > CANONICAL_LIMITS.maxBytesLength) fail("LIMIT_EXCEEDED", "canonical bytes too long");
    w.u8(TAG.BYTES);
    w.u32(v.byteLength);
    w.push(v);
    return;
  }
  if (Array.isArray(v)) {
    const list = v as readonly CanonicalValue[];
    if (list.length > CANONICAL_LIMITS.maxListItems) fail("LIMIT_EXCEEDED", "canonical list too long");
    w.u8(TAG.LIST);
    w.u32(list.length);
    for (const item of list) {
      if (item === undefined) fail("NON_CANONICAL", "list items cannot be undefined");
      encodeValue(w, item, depth + 1);
    }
    return;
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null)
    fail("NON_CANONICAL", "only plain objects encode as structs");
  const obj = v as { readonly [key: string]: CanonicalValue };
  const names = Object.keys(obj);
  if (names.length > CANONICAL_LIMITS.maxStructFields)
    fail("LIMIT_EXCEEDED", "canonical struct has too many fields");
  const entries = names.map((name) => {
    if (name.length > CANONICAL_LIMITS.maxFieldNameLength || !FIELD_NAME.test(name)) {
      fail("NON_CANONICAL", "invalid canonical field name", { name: name.slice(0, 64) });
    }
    const value = obj[name];
    if (value === undefined)
      fail("NON_CANONICAL", "struct fields cannot be undefined; omit or use null", { name });
    return { nameBytes: utf8.encode(name), value };
  });
  entries.sort((a, b) => compareBytes(a.nameBytes, b.nameBytes));
  w.u8(TAG.STRUCT);
  w.u32(entries.length);
  for (const e of entries) {
    w.u32(e.nameBytes.byteLength);
    w.push(e.nameBytes);
    encodeValue(w, e.value, depth + 1);
  }
}

/** Encode a bare canonical value (no envelope). */
export function canonicalEncode(value: CanonicalValue): Uint8Array {
  const w = new Writer();
  encodeValue(w, value, 0);
  return w.bytes();
}

export function assertDomain(domain: string): void {
  if (domain.length > CANONICAL_LIMITS.maxDomainLength || !DOMAIN.test(domain)) {
    fail("NON_CANONICAL", "invalid signing domain", { domain: domain.slice(0, 96) });
  }
}

/** Encode a domain-separated, versioned envelope. */
export function canonicalEnvelope(domain: string, version: number, value: CanonicalValue): Uint8Array {
  assertDomain(domain);
  if (!Number.isInteger(version) || version < 1 || version > 0xffff)
    fail("UNSUPPORTED_VERSION", "invalid schema version");
  const w = new Writer();
  w.push(MAGIC);
  const d = utf8.encode(domain);
  w.u32(d.byteLength);
  w.push(d);
  w.u16(version);
  encodeValue(w, value, 0);
  return w.bytes();
}

export function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

export function canonicalDigest(domain: string, version: number, value: CanonicalValue): Uint8Array {
  return sha256(canonicalEnvelope(domain, version, value));
}

export function toHex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

export function fromHex(s: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(s)) fail("NON_CANONICAL", "hex must be lowercase and even-length");
  return new Uint8Array(Buffer.from(s, "hex"));
}

export function canonicalDigestHex(domain: string, version: number, value: CanonicalValue): string {
  return toHex(canonicalDigest(domain, version, value));
}

export { U64_MAX, U128_MAX };
