/** T-011 (complete fresh slots) and T-012 (unauthorized uploader/issuer) through the real upload path. */
import { afterEach, describe, expect, it } from "vitest";
import { closeHarnesses } from "../../authority/test/helpers.js";
import { policyDigest } from "../src/index.js";
import { codeOf, commercialPolicy, DAY, fillAll, HOUR, makeWorld, pdf, png, type World } from "./world.js";

let worlds: World[] = [];
afterEach(() => {
  for (const w of worlds) w.close();
  worlds = [];
  closeHarnesses();
});
const world = async () => {
  const w = await makeWorld();
  worlds.push(w);
  return w;
};

describe("T-011 evidence policy requires complete fresh slots", () => {
  it("rejects an empty, malformed or unknown-field policy", async () => {
    const w = await world();
    expect(await codeOf(() => w.evidence.registerPolicy(commercialPolicy({ slots: [] })))).toBe(
      "VALIDATION_FAILED",
    );
    const p = commercialPolicy();
    const extra = { ...p, slots: [{ ...p.slots[0], complete: true }] } as never;
    expect(await codeOf(() => w.evidence.registerPolicy(extra))).toBe("UNKNOWN_FIELD");
    const zero = { ...p, slots: [{ ...p.slots[0], minItems: 0 }] } as never;
    expect(await codeOf(() => w.evidence.registerPolicy(zero))).toBe("VALIDATION_FAILED");
    const dup = { ...p, slots: [p.slots[0], p.slots[0]] } as never;
    expect(await codeOf(() => w.evidence.registerPolicy(dup))).toBe("VALIDATION_FAILED");
    // Policy digest is stable and changes with any material field.
    expect(policyDigest(p)).toBe(policyDigest(commercialPolicy()));
    expect(policyDigest(commercialPolicy({ attestationLifetimeMs: 2 * DAY }))).not.toBe(policyDigest(p));
  });

  it("an empty manifest is INCOMPLETE and cannot be attested", async () => {
    const w = await world();
    const e = w.evidence.evaluate(w.terms.tradeId);
    expect(e.status).toBe("INCOMPLETE");
    expect(e.slots.map((s) => s.status)).toEqual(["MISSING", "MISSING", "MISSING"]);
    expect(await codeOf(w.evidence.attest(w.terms.tradeId, w.attestor))).toBe("INCOMPLETE");
  });

  it("a missing slot keeps the manifest INCOMPLETE; the full set becomes COMPLETE", async () => {
    const w = await world();
    const inv = pdf("Invoice INV-1");
    await w.evidence.upload(w.supplier.ctx(), {
      tradeId: w.terms.tradeId,
      slotId: "commercial-invoice",
      content: inv,
      issuer: w.issue(w.supplier, "SUPPLIER_SIGNER", "commercial-invoice", inv),
      expectedManifestRevision: 0,
    });
    const partial = w.evidence.evaluate(w.terms.tradeId);
    expect(partial.status).toBe("INCOMPLETE");
    expect(partial.slots.map((s) => s.status)).toEqual(["FILLED", "MISSING", "MISSING"]);
    expect(await codeOf(w.evidence.attest(w.terms.tradeId, w.attestor))).toBe("INCOMPLETE");
    w.close();
    const w2 = await world();
    await fillAll(w2);
    const done = w2.evidence.evaluate(w2.terms.tradeId);
    expect(done.status).toBe("COMPLETE");
    expect(done.manifestRevision).toBe(3);
    const m = w2.evidence.manifest(w2.terms.tradeId);
    expect(m.items.map((i) => [i.slotId, i.detectedMime, i.contentClass])).toEqual([
      ["commercial-invoice", "application/pdf", "DOCUMENT"],
      ["inspection-report", "text/plain", "DOCUMENT"],
      ["cargo-photos", "image/png", "IMAGE"],
    ]);
    const photo = m.items[2];
    expect(photo?.resources.pixels).toBe(32 * 16);
    expect(photo?.derived[0]?.sourceDigest).toBe(photo?.originalDigest);
  });

  it("rejects over-cardinality and wrong content types detected from bytes, not labels", async () => {
    const w = await world();
    let rev = await fillAll(w);
    const img2 = png(8, 8, 1);
    rev = (
      await w.evidence.upload(w.inspector.ctx(), {
        tradeId: w.terms.tradeId,
        slotId: "cargo-photos",
        content: img2,
        issuer: w.issue(w.inspector, "INSPECTOR", "cargo-photos", img2),
        expectedManifestRevision: rev,
      })
    ).manifestRevision;
    const img3 = png(8, 8, 2);
    expect(
      await codeOf(
        w.evidence.upload(w.inspector.ctx(), {
          tradeId: w.terms.tradeId,
          slotId: "cargo-photos",
          content: img3,
          issuer: w.issue(w.inspector, "INSPECTOR", "cargo-photos", img3),
          expectedManifestRevision: rev,
        }),
      ),
    ).toBe("OVER_CARDINALITY");
    // A PNG declared as a PDF invoice is classified by its bytes and refused.
    const w2 = await world();
    const fake = png(4, 4);
    expect(
      await codeOf(
        w2.evidence.upload(w2.supplier.ctx(), {
          tradeId: w2.terms.tradeId,
          slotId: "commercial-invoice",
          content: fake,
          declaredMime: "application/pdf",
          issuer: w2.issue(w2.supplier, "SUPPLIER_SIGNER", "commercial-invoice", fake),
          expectedManifestRevision: 0,
        }),
      ),
    ).toBe("UNSUPPORTED_CONTENT");
    // Executables and unknown bytes are never classified as documents.
    const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]);
    expect(
      await codeOf(
        w2.evidence.upload(w2.supplier.ctx(), {
          tradeId: w2.terms.tradeId,
          slotId: "commercial-invoice",
          content: exe,
          issuer: w2.issue(w2.supplier, "SUPPLIER_SIGNER", "commercial-invoice", exe),
          expectedManifestRevision: 0,
        }),
      ),
    ).toBe("UNSUPPORTED_CONTENT");
  });

  it("malicious files are quarantined: active PDF content, byte and decompression bombs", async () => {
    const w = await world();
    const active = pdf("Invoice", "5 0 obj << /S /JavaScript /JS (app.alert(1)) >> endobj");
    expect(
      await codeOf(
        w.evidence.upload(w.supplier.ctx(), {
          tradeId: w.terms.tradeId,
          slotId: "commercial-invoice",
          content: active,
          issuer: w.issue(w.supplier, "SUPPLIER_SIGNER", "commercial-invoice", active),
          expectedManifestRevision: 0,
        }),
      ),
    ).toBe("MALICIOUS_CONTENT");
    const huge = new Uint8Array(70_000).fill(0x41);
    huge.set(new TextEncoder().encode("%PDF-1.4\n"));
    expect(
      await codeOf(
        w.evidence.upload(w.supplier.ctx(), {
          tradeId: w.terms.tradeId,
          slotId: "commercial-invoice",
          content: (async function* () {
            for (let i = 0; i < huge.length; i += 8192) yield huge.subarray(i, i + 8192);
          })(),
          issuer: { capability: "SUPPLIER_SIGNER", issuedAt: w.h.clock.now(), signature: "ed25519:1" },
          expectedManifestRevision: 0,
        }),
      ),
    ).toBe("LIMIT_EXCEEDED");
    const bomb = png(2000, 2000); // 4M pixels of highly compressible data: ratio far over 100x
    expect(
      await codeOf(
        w.evidence.upload(w.inspector.ctx(), {
          tradeId: w.terms.tradeId,
          slotId: "cargo-photos",
          content: bomb,
          issuer: w.issue(w.inspector, "INSPECTOR", "cargo-photos", bomb),
          expectedManifestRevision: 0,
        }),
      ),
    ).toBe("LIMIT_EXCEEDED");
    expect(w.evidence.evaluate(w.terms.tradeId).slots.every((s) => s.status === "MISSING")).toBe(true);
    expect(w.evidence.quarantine(w.terms.tradeId).map((q) => q.reason)).toEqual(
      expect.arrayContaining(["MALICIOUS_CONTENT", "LIMIT_EXCEEDED"]),
    );
  });

  it("stale items make the manifest INCOMPLETE once their freshness deadline passes", async () => {
    const w = await world();
    await fillAll(w);
    expect(w.evidence.evaluate(w.terms.tradeId).status).toBe("COMPLETE");
    w.h.clock.advance(7 * DAY);
    const e = w.evidence.evaluate(w.terms.tradeId);
    expect(e.status).toBe("INCOMPLETE");
    expect(e.slots.find((s) => s.slotId === "inspection-report")?.status).toBe("STALE");
    expect(await codeOf(w.evidence.attest(w.terms.tradeId, w.attestor))).toBe("INCOMPLETE");
  });

  it("binding requires the accepted revision and the exact policy its terms sign", async () => {
    const w = await world();
    expect(
      await codeOf(() => w.evidence.bindTrade(w.terms, { buyerSignature: "x", supplierSignature: "y" })),
    ).toBe("INVALID_STATE");
    // Registering a later policy revision does not alter an active trade in place.
    w.evidence.registerPolicy(commercialPolicy({ revision: 2 }));
    expect(w.evidence.evaluate(w.terms.tradeId).policy).toEqual({ id: "commercial-docs", revision: 1 });
  });
});

describe("T-012 unauthorized uploader or issuer is rejected", () => {
  it("rejects uploaders whose capability or organization the slot does not allow", async () => {
    const w = await world();
    const inv = pdf("Invoice");
    const up = (actor: typeof w.buyer) =>
      w.evidence.upload(actor.ctx(), {
        tradeId: w.terms.tradeId,
        slotId: "commercial-invoice",
        content: inv,
        issuer: w.issue(w.supplier, "SUPPLIER_SIGNER", "commercial-invoice", inv),
        expectedManifestRevision: 0,
      });
    expect(await codeOf(up(w.buyer))).toBe("FORBIDDEN");
    expect(await codeOf(up(w.inspector))).toBe("FORBIDDEN");
    expect(await codeOf(up(w.risk))).toBe("FORBIDDEN");
    // An evidence clerk from an unrelated organization cannot fill a slot of this trade.
    expect(await codeOf(up(w.outsiderClerk))).toBe("SCOPE_MISMATCH");
    expect(await codeOf(up(w.supplierClerk))).toBe("NO_ERROR");
  });

  it("rejects wrong, forged, future, stale, cross-trade and revoked issuers", async () => {
    const w = await world();
    const inv = pdf("Invoice INV-9");
    const up = (issuer: { capability: string; issuedAt: number; signature: string }) =>
      w.evidence.upload(w.supplier.ctx(), {
        tradeId: w.terms.tradeId,
        slotId: "commercial-invoice",
        content: inv,
        issuer,
        expectedManifestRevision: 0,
      });
    // Buyer key signing an issuance that claims the supplier capability.
    expect(await codeOf(up(w.issue(w.buyer, "SUPPLIER_SIGNER", "commercial-invoice", inv)))).toBe(
      "SIGNATURE_INVALID",
    );
    // Inspector is not an allowed issuer for the invoice slot.
    expect(await codeOf(up(w.issue(w.inspector, "INSPECTOR", "commercial-invoice", inv)))).toBe("FORBIDDEN");
    // Forged issuedAt: signature covers one time, the upload claims another.
    const real = w.issue(w.supplier, "SUPPLIER_SIGNER", "commercial-invoice", inv);
    expect(await codeOf(up({ ...real, issuedAt: real.issuedAt + 1 }))).toBe("SIGNATURE_INVALID");
    expect(
      await codeOf(
        up(w.issue(w.supplier, "SUPPLIER_SIGNER", "commercial-invoice", inv, w.h.clock.now() + HOUR)),
      ),
    ).toBe("NOT_YET_VALID");
    expect(
      await codeOf(
        up(w.issue(w.supplier, "SUPPLIER_SIGNER", "commercial-invoice", inv, w.h.clock.now() - 31 * DAY)),
      ),
    ).toBe("STALE_ITEM");
    // Signed for another slot (cross-slot) or a different document.
    expect(await codeOf(up(w.issue(w.supplier, "SUPPLIER_SIGNER", "inspection-report", inv)))).toBe(
      "SIGNATURE_INVALID",
    );
    expect(await codeOf(up(w.issue(w.supplier, "SUPPLIER_SIGNER", "commercial-invoice", pdf("other"))))).toBe(
      "SIGNATURE_INVALID",
    );
    // Revoked supplier key.
    w.h.svc.revokeKey(w.supplierAdmin.ctx(), {
      keyVersionId: w.supplier.keyVersionId,
      reason: "KEY_COMPROMISE",
    });
    const clerkUp = w.evidence.upload(w.supplierClerk.ctx(), {
      tradeId: w.terms.tradeId,
      slotId: "commercial-invoice",
      content: inv,
      issuer: w.issue(w.supplier, "SUPPLIER_SIGNER", "commercial-invoice", inv),
      expectedManifestRevision: 0,
    });
    expect(await codeOf(clerkUp)).toBe("KEY_REVOKED");
    expect(w.evidence.evaluate(w.terms.tradeId).slots[0]?.status).toBe("MISSING");
    expect(w.evidence.currentRevision(w.terms.tradeId)).toBe(0);
  });

  it("items uploaded for another trade never fill this trade's slots", async () => {
    const a = await world();
    const b = await world();
    const inv = pdf("Invoice for A");
    // Issuance signed for trade A presented on trade B.
    const issuerForA = a.issue(a.supplier, "SUPPLIER_SIGNER", "commercial-invoice", inv);
    expect(
      await codeOf(
        b.evidence.upload(b.supplier.ctx(), {
          tradeId: b.terms.tradeId,
          slotId: "commercial-invoice",
          content: inv,
          issuer: issuerForA,
          expectedManifestRevision: 0,
        }),
      ),
    ).toBe("SIGNATURE_INVALID");
    // A's supplier session is unknown to B's deployment, and B's slot stays empty.
    expect(
      await codeOf(() =>
        b.evidence.upload(a.supplier.ctx("POST", "/v1/test", "{}", b.h.svc), {
          tradeId: b.terms.tradeId,
          slotId: "commercial-invoice",
          content: inv,
          issuer: issuerForA,
          expectedManifestRevision: 0,
        }),
      ),
    ).toBe("UNAUTHENTICATED");
    // Within one deployment, A's bound supplier is not the supplier B binds.
    expect(
      await codeOf(
        a.evidence.upload(a.supplier.ctx(), {
          tradeId: b.terms.tradeId,
          slotId: "commercial-invoice",
          content: inv,
          issuer: issuerForA,
          expectedManifestRevision: 0,
        }),
      ),
    ).toBe("NOT_FOUND");
    expect(b.evidence.evaluate(b.terms.tradeId).slots[0]?.status).toBe("MISSING");
  });
});
