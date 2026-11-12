/**
 * T-002 — Schema and unknown fields fail closed (FR-01, INV-08, NFR-02).
 * Unsupported versions, duplicate keys, ambiguous addresses, unknown material fields,
 * malformed lengths and resource-limit violations are rejected with a stable code.
 */
import { describe, expect, it } from "vitest";
import {
  base58Encode,
  canonicalEncode,
  checkValidityWindow,
  DEFAULT_JSON_LIMITS,
  decideIdempotency,
  type ErrorCode,
  idempotencyRequestDigest,
  isDocksideError,
  loadConfig,
  nearToYocto,
  parseAmount,
  parseNearAccountId,
  parsePublicKey,
  parseSignature,
  parseStrictJson,
  parseTradeTerms,
  tradeTermsFromJson,
  yoctoToNear,
} from "../src/index.js";
import { clone, makeTermsJson } from "./fixtures.js";

function code(fn: () => unknown): ErrorCode | "NO_ERROR" | "FOREIGN_ERROR" {
  try {
    fn();
    return "NO_ERROR";
  } catch (e) {
    return isDocksideError(e) ? e.code : "FOREIGN_ERROR";
  }
}

const raw = (o: unknown) => JSON.stringify(o);

describe("T-002 schema and unknown fields fail closed", () => {
  it("accepts the valid baseline (control)", () => {
    expect(code(() => parseTradeTerms(raw(makeTermsJson())))).toBe("NO_ERROR");
  });

  it("rejects unsupported or missing schema versions", () => {
    const t = makeTermsJson();
    expect(code(() => parseTradeTerms(raw({ ...t, schemaVersion: 2 })))).toBe("UNSUPPORTED_VERSION");
    expect(code(() => parseTradeTerms(raw({ ...t, schemaVersion: "1" })))).toBe("UNSUPPORTED_VERSION");
    const { schemaVersion: _drop, ...missing } = t;
    expect(code(() => parseTradeTerms(raw(missing)))).toBe("UNSUPPORTED_VERSION");
    expect(code(() => parseTradeTerms(raw({ ...t, profileVersion: "dockside-direct-testnet-v2" })))).toBe(
      "VALIDATION_FAILED",
    );
  });

  it("rejects duplicate keys at the raw boundary, including escaped-equivalent keys", () => {
    const body = raw(makeTermsJson());
    const dupTop = body.replace('"revision":1', '"revision":1,"revision":2');
    expect(code(() => parseTradeTerms(dupTop))).toBe("DUPLICATE_KEY");
    const dupNested = body.replace(
      '"accountId":"acme-buyer.testnet"',
      '"accountId":"acme-buyer.testnet","accountId":"x.testnet"',
    );
    expect(code(() => parseTradeTerms(dupNested))).toBe("DUPLICATE_KEY");
    const dupEscaped = body.replace('"amountYocto":', '"amount\\u0059octo":"1","amountYocto":');
    expect(code(() => parseTradeTerms(dupEscaped))).toBe("DUPLICATE_KEY");
    // JSON.parse would silently keep the last value; the strict parser never does.
    expect(JSON.parse('{"a":1,"a":2}')).toEqual({ a: 2 });
    expect(code(() => parseStrictJson('{"a":1,"a":2}'))).toBe("DUPLICATE_KEY");
  });

  it("rejects unknown fields at every depth", () => {
    const t = makeTermsJson();
    expect(code(() => parseTradeTerms(raw({ ...t, complete: true })))).toBe("UNKNOWN_FIELD");
    const nested = clone(t) as Record<string, any>;
    nested.payout.memo = "redirect";
    expect(code(() => parseTradeTerms(raw(nested)))).toBe("UNKNOWN_FIELD");
    const scope = clone(t) as Record<string, any>;
    scope.manifestAttestor.scope.anyPolicy = true;
    expect(code(() => parseTradeTerms(raw(scope)))).toBe("UNKNOWN_FIELD");
  });

  it("does not let __proto__ keys pollute prototypes", () => {
    const parsed = parseStrictJson('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(Object.keys(parsed)).toEqual(["__proto__"]);
    expect(code(() => parseTradeTerms(raw(makeTermsJson()).replace("{", '{"__proto__":{},')))).toBe(
      "UNKNOWN_FIELD",
    );
  });

  it("rejects ambiguous, non-canonical and wrong-network addresses", () => {
    const strict = { network: "near-testnet" } as const;
    expect(code(() => parseNearAccountId("harbor-supplier.testnet", strict))).toBe("NO_ERROR");
    // Cyrillic "а" homoglyph and zero-width space.
    expect(code(() => parseNearAccountId("hаrbor-supplier.testnet", strict))).toBe("AMBIGUOUS_ADDRESS");
    expect(code(() => parseNearAccountId("harbor​-supplier.testnet", { ...strict, mode: "input" }))).toBe(
      "AMBIGUOUS_ADDRESS",
    );
    expect(code(() => parseNearAccountId(" harbor-supplier.testnet", strict))).toBe("AMBIGUOUS_ADDRESS");
    expect(code(() => parseNearAccountId("Harbor-Supplier.testnet", strict))).toBe("NON_CANONICAL");
    expect(code(() => parseNearAccountId("harbor--supplier.testnet", strict))).toBe("INVALID_ADDRESS");
    expect(code(() => parseNearAccountId("harbor.supplier.near", strict))).toBe("INVALID_ADDRESS");
    expect(code(() => parseNearAccountId("testnet", strict))).toBe("INVALID_ADDRESS");
    expect(code(() => parseNearAccountId(`${"a".repeat(57)}.testnet`, strict))).toBe("INVALID_ADDRESS");
    expect(code(() => parseNearAccountId("ab".repeat(32), { ...strict, namedOnly: true }))).toBe(
      "INVALID_ADDRESS",
    );
    expect(code(() => parseNearAccountId("x.testnet", { network: "near-mainnet" }))).toBe("INVALID_ADDRESS");

    const t = clone(makeTermsJson()) as Record<string, any>;
    t.payout.destination = "ab".repeat(32); // implicit account: corridor requires a named testnet account
    expect(code(() => tradeTermsFromJson(t))).toBe("INVALID_ADDRESS");
    const wrongNet = clone(makeTermsJson()) as Record<string, any>;
    wrongNet.payout.destination = "harbor-supplier.near";
    expect(code(() => tradeTermsFromJson(wrongNet))).toBe("INVALID_ADDRESS");
  });

  it("rejects malformed lengths for keys, signatures, identifiers and amounts", () => {
    expect(code(() => parsePublicKey(`ed25519:${base58Encode(new Uint8Array(31).fill(7))}`))).toBe(
      "INVALID_KEY",
    );
    expect(code(() => parsePublicKey(`ed25519:1${base58Encode(new Uint8Array(32).fill(7))}`))).toBe(
      "INVALID_KEY",
    );
    expect(code(() => parsePublicKey(`secp256k1:${base58Encode(new Uint8Array(32).fill(7))}`))).toBe(
      "INVALID_KEY",
    );
    expect(code(() => parseSignature(`ed25519:${base58Encode(new Uint8Array(63).fill(1))}`))).toBe(
      "SIGNATURE_INVALID",
    );
    expect(code(() => parseAmount("0100"))).toBe("INVALID_AMOUNT");
    expect(code(() => parseAmount("1.5"))).toBe("INVALID_AMOUNT");
    expect(code(() => parseAmount("-1"))).toBe("INVALID_AMOUNT");
    expect(code(() => parseAmount((1n << 128n).toString()))).toBe("INVALID_AMOUNT");
    expect(parseAmount(((1n << 128n) - 1n).toString())).toBe((1n << 128n) - 1n);
    expect(nearToYocto("1.25")).toBe(1_250_000_000_000_000_000_000_000n);
    expect(yoctoToNear(1_250_000_000_000_000_000_000_000n)).toBe("1.25");
    expect(code(() => nearToYocto("1.0000000000000000000000001"))).toBe("INVALID_AMOUNT");

    const t = makeTermsJson();
    expect(code(() => tradeTermsFromJson({ ...t, tradeId: "trd_123" }))).toBe("VALIDATION_FAILED");
    expect(code(() => tradeTermsFromJson({ ...t, tradeId: `prn_${"0".repeat(32)}` }))).toBe(
      "VALIDATION_FAILED",
    );
    expect(code(() => tradeTermsFromJson({ ...t, amountYocto: 25 }))).toBe("VALIDATION_FAILED");
    expect(code(() => tradeTermsFromJson({ ...t, amountYocto: "0" }))).toBe("INVALID_AMOUNT");
    const pk = clone(t) as Record<string, any>;
    pk.inspector.publicKey = "ed25519:abc";
    expect(code(() => tradeTermsFromJson(pk))).toBe("INVALID_KEY");
  });

  it("enforces resource limits at the raw boundary", () => {
    const limits = { maxBytes: 1024, maxDepth: 4, maxStringLength: 32, maxArrayLength: 3, maxObjectKeys: 4 };
    expect(code(() => parseStrictJson(`"${"a".repeat(2000)}"`, limits))).toBe("LIMIT_EXCEEDED");
    expect(code(() => parseStrictJson(new TextEncoder().encode(`"${"a".repeat(2000)}"`), limits))).toBe(
      "LIMIT_EXCEEDED",
    );
    expect(code(() => parseStrictJson("[[[[[[1]]]]]]", limits))).toBe("LIMIT_EXCEEDED");
    expect(code(() => parseStrictJson(`"${"a".repeat(33)}"`, limits))).toBe("LIMIT_EXCEEDED");
    expect(code(() => parseStrictJson("[1,2,3,4]", limits))).toBe("LIMIT_EXCEEDED");
    expect(code(() => parseStrictJson('{"a":1,"b":2,"c":3,"d":4,"e":5}', limits))).toBe("LIMIT_EXCEEDED");
    expect(code(() => parseTradeTerms(" ".repeat(300 * 1024) + raw(makeTermsJson())))).toBe("LIMIT_EXCEEDED");
    const long = clone(makeTermsJson()) as Record<string, any>;
    long.milestone.description = "x".repeat(2001);
    expect(code(() => tradeTermsFromJson(long))).toBe("VALIDATION_FAILED");
    expect(code(() => canonicalEncode("x".repeat(70_000)))).toBe("LIMIT_EXCEEDED");
    let deep: unknown = 1;
    for (let i = 0; i < 30; i++) deep = [deep];
    expect(code(() => canonicalEncode(deep as never))).toBe("LIMIT_EXCEEDED");
  });

  it("rejects lossy numbers, unpaired surrogates, control characters, BOM and trailing content", () => {
    expect(code(() => parseStrictJson("1.5"))).toBe("VALIDATION_FAILED");
    expect(code(() => parseStrictJson("1e3"))).toBe("VALIDATION_FAILED");
    expect(code(() => parseStrictJson("9007199254740993"))).toBe("VALIDATION_FAILED");
    // M15: a boundary that reads a peer's u64 numbers may keep them as exact decimal strings.
    const u64 = { ...DEFAULT_JSON_LIMITS, unsafeIntegers: "decimal-string" as const };
    expect(parseStrictJson('{"timestamp":1800000000123456789,"height":7}', u64)).toEqual({
      timestamp: "1800000000123456789",
      height: 7,
    });
    expect(code(() => parseStrictJson("-9007199254740993", u64))).toBe("VALIDATION_FAILED");
    expect(code(() => parseStrictJson("1.5", u64))).toBe("VALIDATION_FAILED");
    expect(code(() => parseStrictJson("-0"))).toBe("VALIDATION_FAILED");
    expect(code(() => parseStrictJson('"\\ud800"'))).toBe("MALFORMED_JSON");
    expect(code(() => parseStrictJson('"a\u0001"'))).toBe("MALFORMED_JSON");
    expect(code(() => parseStrictJson("﻿{}"))).toBe("MALFORMED_JSON");
    expect(code(() => parseStrictJson("{} {}"))).toBe("MALFORMED_JSON");
    expect(code(() => parseStrictJson(new Uint8Array([0x22, 0xff, 0x22])))).toBe("MALFORMED_JSON");
    const bidi = clone(makeTermsJson()) as Record<string, any>;
    bidi.milestone.description = "pay ‮tset";
    expect(code(() => tradeTermsFromJson(bidi))).toBe("VALIDATION_FAILED");
    expect(code(() => canonicalEncode("café"))).toBe("NON_CANONICAL");
    expect(code(() => canonicalEncode(1.5))).toBe("NON_CANONICAL");
    expect(code(() => canonicalEncode(-1))).toBe("NON_CANONICAL");
    expect(code(() => canonicalEncode({ a: undefined } as never))).toBe("NON_CANONICAL");
    expect(code(() => canonicalEncode({ "bad-name": 1 }))).toBe("NON_CANONICAL");
    expect(code(() => canonicalEncode(new Date() as never))).toBe("NON_CANONICAL");
  });

  it("rejects structurally dependent authority (INV-13 at the terms boundary)", () => {
    const t = clone(makeTermsJson()) as Record<string, any>;
    t.inspector.principalId = t.buyer.principalId;
    expect(code(() => tradeTermsFromJson(t))).toBe("SEPARATION_OF_DUTIES");
    const k = clone(makeTermsJson()) as Record<string, any>;
    k.riskResolver.publicKey = k.supplier.publicKey;
    expect(code(() => tradeTermsFromJson(k))).toBe("SEPARATION_OF_DUTIES");
    const o = clone(makeTermsJson()) as Record<string, any>;
    o.supplier.organizationId = o.buyer.organizationId;
    expect(code(() => tradeTermsFromJson(o))).toBe("SEPARATION_OF_DUTIES");
    const s = clone(makeTermsJson()) as Record<string, any>;
    s.manifestAttestor.scope.evidencePolicyRevision = 2;
    expect(code(() => tradeTermsFromJson(s))).toBe("SCOPE_MISMATCH");
    const tr = clone(makeTermsJson()) as Record<string, any>;
    tr.policySetter.scope.tradeId = `trd_${"1".repeat(32)}`;
    expect(code(() => tradeTermsFromJson(tr))).toBe("SCOPE_MISMATCH");
    const pd = clone(makeTermsJson()) as Record<string, any>;
    pd.revision = 2;
    expect(code(() => tradeTermsFromJson(pd))).toBe("VALIDATION_FAILED");
  });

  it("fails closed on configuration typos, invalid values and blocked networks", () => {
    expect(code(() => loadConfig({}))).toBe("NO_ERROR");
    expect(code(() => loadConfig({ DOCKSIDE_ORIGN: "http://localhost:1" }))).toBe("CONFIG_INVALID");
    expect(code(() => loadConfig({ DOCKSIDE_ORIGIN: "http://example.com" }))).toBe("CONFIG_INVALID");
    expect(code(() => loadConfig({ DOCKSIDE_ORIGIN: "https://example.com/app" }))).toBe("CONFIG_INVALID");
    expect(code(() => loadConfig({ DOCKSIDE_NETWORK: "near-mainnet" }))).toBe("CONFIG_INVALID");
    expect(code(() => loadConfig({ DOCKSIDE_FUNDED_PAYOUTS: "ENABLED" }))).toBe("CONFIG_INVALID");
    expect(code(() => loadConfig({ DOCKSIDE_SESSION_TTL_MS: "abc" }))).toBe("CONFIG_INVALID");
    try {
      loadConfig({ DOCKSIDE_SESSION_TTL_MS: "super-secret-value" });
    } catch (e) {
      expect(JSON.stringify(e)).not.toContain("super-secret-value");
      expect(String(e)).not.toContain("super-secret-value");
    }
  });

  it("fails closed on validity windows and idempotency reuse", () => {
    const p = { maxLifetimeMs: 60_000, maxSkewMs: 1_000 };
    expect(code(() => checkValidityWindow({ issuedAt: 1000, expiresAt: 2000 }, 1500, p))).toBe("NO_ERROR");
    expect(code(() => checkValidityWindow({ issuedAt: 1000, expiresAt: 2000 }, 2000, p))).toBe("EXPIRED");
    expect(code(() => checkValidityWindow({ issuedAt: 5000, expiresAt: 6000 }, 1000, p))).toBe(
      "NOT_YET_VALID",
    );
    expect(code(() => checkValidityWindow({ issuedAt: 0, expiresAt: 100_000 }, 10, p))).toBe(
      "VALIDATION_FAILED",
    );
    expect(code(() => checkValidityWindow({ issuedAt: 10, expiresAt: 10 }, 10, p))).toBe("VALIDATION_FAILED");
    const d1 = idempotencyRequestDigest("op", { amount: 1n });
    const d2 = idempotencyRequestDigest("op", { amount: 2n });
    expect(decideIdempotency(undefined, d1)).toEqual({ kind: "NEW" });
    expect(decideIdempotency({ requestDigest: d1, response: "r" }, d1)).toEqual({
      kind: "REPLAY",
      response: "r",
    });
    expect(code(() => decideIdempotency({ requestDigest: d1, response: "r" }, d2))).toBe(
      "IDEMPOTENCY_CONFLICT",
    );
  });
});
