/** The browser DCE-1 encoder reproduces every shared cross-language vector byte-for-byte. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { base58Decode, base58Encode } from "../src/lib/base58";
import {
  CanonicalError,
  canonicalDigest,
  canonicalEnvelope,
  fromTypedJson,
  toHex,
} from "../src/lib/canonical";

interface Vector {
  name: string;
  domain: string;
  version: number;
  value: unknown;
  envelopeHex?: string;
  digestHex?: string;
  error?: string;
}

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../fixtures/canonical-vectors.json", import.meta.url)), "utf8"),
) as { vectors: Vector[] };

describe("browser canonical encoding matches fixtures/canonical-vectors.json", () => {
  const positive = fixture.vectors.filter((v) => v.envelopeHex !== undefined);
  it("has vectors to check", () => {
    expect(positive.length).toBeGreaterThan(10);
  });
  for (const v of positive) {
    it(v.name, async () => {
      const value = fromTypedJson(v.value as never);
      expect(toHex(canonicalEnvelope(v.domain, v.version, value))).toBe(v.envelopeHex);
      expect(toHex(await canonicalDigest(v.domain, v.version, value))).toBe(v.digestHex);
    });
  }

  it("rejects non-NFC strings, unsafe numbers, bad field names and bad domains", () => {
    expect(() => canonicalEnvelope("dockside/x", 1, { s: "é" })).toThrow(CanonicalError);
    expect(() => canonicalEnvelope("dockside/x", 1, { n: 2 ** 53 })).toThrow(CanonicalError);
    expect(() => canonicalEnvelope("dockside/x", 1, { n: -1 })).toThrow(CanonicalError);
    expect(() => canonicalEnvelope("dockside/x", 1, { "bad-name": 1 })).toThrow(CanonicalError);
    expect(() => canonicalEnvelope("other/x", 1, {})).toThrow(CanonicalError);
    expect(() => canonicalEnvelope("dockside/x", 1, { s: "\ud800" })).toThrow(CanonicalError);
  });

  it("round-trips base58 with leading zero bytes", () => {
    const b = new Uint8Array([0, 0, 1, 2, 255]);
    expect(base58Decode(base58Encode(b))).toEqual(b);
  });
});
