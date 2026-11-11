/**
 * T-001 — Canonical identity is stable (FR-01, INV-01, NFR-05).
 * Property tests over field order, Unicode, address display forms, restart and
 * platforms (cross-checked against the Rust crate through shared vectors).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  assertRevisionTransition,
  canonicalDigestHex,
  canonicalEncode,
  canonicalEnvelope,
  changedMaterialFields,
  fromTypedJson,
  hasForbiddenControl,
  isDocksideError,
  isWellFormed,
  parseTradeTerms,
  requireSignature,
  sha256,
  type TypedJson,
  toHex,
  tradeRevisionDigest,
  tradeTermsFromJson,
  tradeTermsToJson,
  verifyFor,
} from "../src/index.js";
import { clone, makeTermsJson, reorderKeys } from "./fixtures.js";

const vectorsUrl = new URL("../../../fixtures/canonical-vectors.json", import.meta.url);
const vectors = JSON.parse(readFileSync(vectorsUrl, "utf8")) as {
  vectors: {
    name: string;
    domain: string;
    version: number;
    value: TypedJson;
    envelopeHex: string;
    digestHex: string;
  }[];
  tradeTerms: { json: Record<string, unknown>; digestHex: string };
  signatures: { purpose: "TRADE_REVISION"; publicKey: string; signature: string; digestHex: string }[];
};

function shuffleWith(seed: number) {
  return (keys: string[]) => {
    const a = [...keys];
    let s = seed >>> 0 || 1;
    for (let i = a.length - 1; i > 0; i--) {
      s = (s * 1103515245 + 12345) >>> 0;
      const j = s % (i + 1);
      [a[i], a[j]] = [a[j] as string, a[i] as string];
    }
    return a;
  };
}

describe("T-001 canonical identity is stable", () => {
  it("is independent of JSON field order at every depth (property)", () => {
    const base = makeTermsJson();
    const expected = tradeRevisionDigest(tradeTermsFromJson(base));
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const shuffled = reorderKeys(base, shuffleWith(seed));
        const raw = JSON.stringify(shuffled);
        expect(tradeRevisionDigest(parseTradeTerms(raw))).toBe(expected);
      }),
      { numRuns: 200 },
    );
  });

  it("treats canonically-equivalent Unicode (NFC/NFD) as the same identity (property)", () => {
    const base = makeTermsJson();
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", minLength: 1, maxLength: 40 }), (s) => {
        const desc = `Lot ${s}`.normalize("NFC");
        fc.pre(!hasForbiddenControl(desc) && desc.length <= 2000);
        const a = clone(base);
        const b = clone(base);
        (a.milestone as { description: string }).description = desc.normalize("NFC");
        (b.milestone as { description: string }).description = desc.normalize("NFD");
        expect(tradeRevisionDigest(tradeTermsFromJson(a))).toBe(tradeRevisionDigest(tradeTermsFromJson(b)));
      }),
      { numRuns: 200 },
    );
    const nfd = clone(base);
    (nfd.milestone as { description: string }).description = "café";
    const nfc = clone(base);
    (nfc.milestone as { description: string }).description = "café";
    expect(tradeTermsFromJson(nfd).milestone.description).toBe("café");
    expect(tradeRevisionDigest(tradeTermsFromJson(nfd))).toBe(tradeRevisionDigest(tradeTermsFromJson(nfc)));
  });

  it("normalises operator address display forms to the same signed bytes", () => {
    const base = makeTermsJson();
    const canonical = tradeRevisionDigest(tradeTermsFromJson(base));
    const display = clone(base);
    (display.payout as { destination: string }).destination = "  Harbor-Supplier.TESTNET\t";
    (display.supplier as { accountId: string }).accountId = "HARBOR-SUPPLIER.testnet ";
    expect(tradeRevisionDigest(tradeTermsFromJson(display, { addressMode: "input" }))).toBe(canonical);
    // The same display form is rejected in strict (signed-payload) mode.
    expect(() => tradeTermsFromJson(display)).toThrow();
  });

  it("changes identity when any material field changes", () => {
    const base = makeTermsJson();
    const baseTerms = tradeTermsFromJson(base);
    const d0 = tradeRevisionDigest(baseTerms);
    const mutations: [string, (t: Record<string, any>) => void][] = [
      ["buyer", (t) => (t.buyer.accountId = "other-buyer.testnet")],
      ["supplier", (t) => (t.supplier.accountId = "other-supplier.testnet")],
      ["amountYocto", (t) => (t.amountYocto = "2500000000000000000000001")],
      ["milestone", (t) => (t.milestone.description = "Container loaded")],
      ["evidencePolicy", (t) => (t.evidencePolicy.digest = "cd".repeat(32))],
      ["inspector", (t) => (t.inspector.keyVersionId = "key_00000000000000000000000000000001")],
      ["manifestAttestor", (t) => (t.manifestAttestor.keyVersion = 2)],
      ["policySetter", (t) => (t.policySetter.serviceId = "deterministic-policy-b")],
      ["riskResolver", (t) => (t.riskResolver.keyVersionId = "key_00000000000000000000000000000002")],
      ["payout", (t) => (t.payout.destination = "attacker.testnet")],
      ["escrowContractId", (t) => (t.escrowContractId = "other-escrow.testnet")],
      ["delayPolicy", (t) => (t.delayPolicy.destinationChangeDelayMs = 0)],
      ["expiresAt", (t) => (t.expiresAt = 1_900_000_000_001)],
      [
        "tradeId",
        (t) => {
          t.tradeId = "trd_00000000000000000000000000000003";
          t.policySetter.scope.tradeId = t.tradeId;
        },
      ],
    ];
    for (const [field, mutate] of mutations) {
      const m = clone(base) as Record<string, any>;
      mutate(m);
      const terms = tradeTermsFromJson(m);
      expect(tradeRevisionDigest(terms), field).not.toBe(d0);
      expect(changedMaterialFields(baseTerms, terms)).toContain(field);
    }
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: (1n << 128n) - 1n }), (amt) => {
        const m = clone(base);
        m.amountYocto = amt.toString();
        const same = amt.toString() === base.amountYocto;
        expect(tradeRevisionDigest(tradeTermsFromJson(m)) === d0).toBe(same);
      }),
    );
  });

  it("round-trips terms through boundary JSON without changing identity", () => {
    const terms = tradeTermsFromJson(makeTermsJson());
    const again = parseTradeTerms(JSON.stringify(tradeTermsToJson(terms)));
    expect(tradeRevisionDigest(again)).toBe(tradeRevisionDigest(terms));
  });

  it("reproduces committed golden vectors byte-for-byte (restart/platform stability)", () => {
    expect(vectors.vectors.length).toBeGreaterThanOrEqual(18);
    for (const v of vectors.vectors) {
      const env = canonicalEnvelope(v.domain, v.version, fromTypedJson(v.value));
      expect(toHex(env), v.name).toBe(v.envelopeHex);
      expect(toHex(sha256(env)), v.name).toBe(v.digestHex);
    }
    expect(tradeRevisionDigest(tradeTermsFromJson(vectors.tradeTerms.json))).toBe(
      vectors.tradeTerms.digestHex,
    );
    for (const s of vectors.signatures) {
      const payload = fromTypedJson(
        vectors.vectors.find((v) => v.name === "trade-revision-v1")?.value as TypedJson,
      );
      expect(verifyFor(s.publicKey, s.purpose, payload, s.signature)).toBe(true);
    }
  });

  it("computes the same digest in a freshly started process", () => {
    const script = `
      import { readFileSync } from "node:fs";
      const { tradeRevisionDigest, tradeTermsFromJson } = await import(${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)});
      const v = JSON.parse(readFileSync(new URL(${JSON.stringify(vectorsUrl.href)}), "utf8"));
      process.stdout.write(tradeRevisionDigest(tradeTermsFromJson(v.tradeTerms.json)));
    `;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    expect(out).toBe(vectors.tradeTerms.digestHex);
  });

  it("type-tags values so that u64, u128 and string forms of a number never collide", () => {
    const a = toHex(canonicalEncode(5));
    const b = toHex(canonicalEncode(5n));
    const c = toHex(canonicalEncode("5"));
    expect(new Set([a, b, c]).size).toBe(3);
    expect(canonicalDigestHex("dockside/a", 1, { x: 1 })).not.toBe(
      canonicalDigestHex("dockside/b", 1, { x: 1 }),
    );
    expect(canonicalDigestHex("dockside/a", 1, { x: 1 })).not.toBe(
      canonicalDigestHex("dockside/a", 2, { x: 1 }),
    );
  });

  it("is injective over generated structured values (property)", () => {
    const leaf = fc.oneof(
      fc.constant(null),
      fc
        .string()
        .map((s) => s.normalize("NFC"))
        .filter((s) => isWellFormed(s)),
      fc.nat({ max: Number.MAX_SAFE_INTEGER }),
      fc.bigInt({ min: 0n, max: (1n << 128n) - 1n }),
      fc.boolean(),
      fc.uint8Array({ maxLength: 8 }),
    );
    const value = fc.letrec((tie) => ({
      node: fc.oneof(
        { depthSize: "small" },
        leaf,
        fc.array(tie("node"), { maxLength: 4 }),
        fc.dictionary(fc.stringMatching(/^[a-z][a-z0-9]{0,6}$/), tie("node"), { maxKeys: 4 }),
      ),
    })).node;
    const ser = (v: unknown) =>
      JSON.stringify(v, (_k, x) =>
        typeof x === "bigint" ? `n:${x}` : x instanceof Uint8Array ? `b:${toHex(x)}` : x,
      );
    fc.assert(
      fc.property(value, value, (x, y) => {
        const ex = toHex(canonicalEncode(x as never));
        const ey = toHex(canonicalEncode(y as never));
        if (ser(x) === ser(y)) expect(ex).toBe(ey);
        else {
          // Only struct key order may differ for equal values; otherwise encodings must differ.
          const sortedSer = (v: unknown): string =>
            JSON.stringify(sortDeep(v), (_k, z) =>
              typeof z === "bigint" ? `n:${z}` : z instanceof Uint8Array ? `b:${toHex(z)}` : z,
            );
          expect(ex === ey).toBe(sortedSer(x) === sortedSer(y));
        }
      }),
      { numRuns: 300 },
    );
  });

  it("binds signatures to their domain: a trade signature is not a buyer approval", () => {
    const sig = vectors.signatures[0];
    expect(sig).toBeDefined();
    if (!sig) return;
    const payload = fromTypedJson(
      vectors.vectors.find((v) => v.name === "trade-revision-v1")?.value as TypedJson,
    );
    expect(verifyFor(sig.publicKey, "BUYER_APPROVAL", payload, sig.signature)).toBe(false);
    try {
      requireSignature(sig.publicKey, "BUYER_APPROVAL", payload, sig.signature);
      expect.unreachable();
    } catch (e) {
      expect(isDocksideError(e, "WRONG_DOMAIN")).toBe(true);
    }
  });

  it("enforces INV-01: an accepted revision cannot change in place; successors chain digests", () => {
    const base = makeTermsJson();
    const accepted = tradeTermsFromJson(base);
    expect(assertRevisionTransition(accepted, tradeTermsFromJson(clone(base)))).toBe("SAME");
    const changed = clone(base) as Record<string, any>;
    changed.payout.destination = "attacker.testnet";
    expect(() => assertRevisionTransition(accepted, tradeTermsFromJson(changed))).toThrowError(
      /cannot change in place/,
    );
    const successor = clone(changed);
    successor.revision = 2;
    successor.predecessorDigest = tradeRevisionDigest(accepted);
    expect(assertRevisionTransition(accepted, tradeTermsFromJson(successor))).toBe("SUCCESSOR");
    const skipped = clone(successor);
    skipped.revision = 3;
    expect(() => assertRevisionTransition(accepted, tradeTermsFromJson(skipped))).toThrow();
    const unbound = clone(successor);
    unbound.predecessorDigest = "00".repeat(32);
    expect(() => assertRevisionTransition(accepted, tradeTermsFromJson(unbound))).toThrow();
  });
});

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v !== null && typeof v === "object" && !(v instanceof Uint8Array)) {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
        .map((k) => [k, sortDeep(o[k])]),
    );
  }
  return v;
}
