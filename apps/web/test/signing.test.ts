/**
 * The browser signs only what it recomputed itself: every M04-M08 signing domain the web client
 * uses produces the same digest as @dockside/core, a server digest that disagrees with the payload
 * is refused before any signature, and a WebCrypto signature verifies with the backend verifier.
 */
import {
  type CanonicalValue,
  digestHexFor,
  type SigningPurpose as CorePurpose,
  toTypedJson,
  verifyFor,
} from "@dockside/core";
import { issuancePayload } from "@dockside/evidence";
import { describe, expect, it } from "vitest";
import type { TypedJson } from "../src/lib/canonical";
import { generateDeviceKey } from "../src/lib/keys";
import { issuanceValue, prepareSignature, SIGNING_DOMAINS, signPrepared } from "../src/lib/signing";

const sample: CanonicalValue = {
  contractId: "dockside-escrow.testnet",
  tradeId: `trd_${"a".repeat(32)}`,
  tradeRevision: 2,
  amountYocto: 10n ** 25n,
  digest: Uint8Array.from([1, 2, 3, 250]),
  reasonCodes: ["DOCS_MATCH", "SEALS_OK"],
  manifestDigest: null,
  approved: true,
  issuedAt: 1_800_000_000_000,
};

const typed = (v: CanonicalValue) => toTypedJson(v) as unknown as TypedJson;

describe("browser signing domains match the backend", () => {
  for (const purpose of Object.keys(SIGNING_DOMAINS) as (keyof typeof SIGNING_DOMAINS)[]) {
    it(`${purpose} digest equals @dockside/core`, async () => {
      const p = await prepareSignature(purpose, typed(sample));
      expect(p.ok).toBe(true);
      if (p.ok) expect(p.value.digestHex).toBe(digestHexFor(purpose as CorePurpose, sample));
    });
  }

  it("refuses a server digest that does not match the payload", async () => {
    const p = await prepareSignature("BUYER_APPROVAL", typed(sample), "0".repeat(64));
    expect(p).toEqual({ ok: false, reason: expect.stringContaining("does not match") });
  });

  it("refuses purposes it does not sign and payloads that are not canonical", async () => {
    expect((await prepareSignature("POLICY_SETTER", typed(sample))).ok).toBe(false);
    expect((await prepareSignature("HOLD_SET", { u64: "-1" } as TypedJson)).ok).toBe(false);
  });

  it("a non-extractable device key signature verifies with the backend verifier", async () => {
    const key = await generateDeviceKey("test", Date.now());
    expect(key.extractable).toBe(false);
    const p = await prepareSignature("HOLD_RESOLVE", typed(sample), digestHexFor("HOLD_RESOLVE", sample));
    if (!p.ok) throw new Error(p.reason);
    const sig = await signPrepared(p.value, key.privateKey);
    expect(verifyFor(key.publicKey, "HOLD_RESOLVE", sample, sig)).toBe(true);
    expect(verifyFor(key.publicKey, "HOLD_SET", sample, sig)).toBe(false);
  });

  it("evidence issuance statements equal the evidence service payload", async () => {
    const content = new TextEncoder().encode("Inspection report: 12 pallets.\n");
    const base = {
      tradeId: `trd_${"b".repeat(32)}`,
      slotId: "inspection-report",
      issuedAt: 1_800_000_000_000,
      issuerPrincipalId: `prn_${"c".repeat(32)}`,
      issuerKeyVersionId: `kv_${"d".repeat(32)}`,
      issuerCapability: "INSPECTOR",
    };
    const mine = await issuanceValue({ ...base, content });
    expect(digestHexFor("EVIDENCE_ISSUANCE", mine.value)).toBe(
      digestHexFor("EVIDENCE_ISSUANCE", issuancePayload({ ...base, content })),
    );
  });
});
