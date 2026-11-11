/** T-013 (revisioned, concurrent-safe replacement) and T-018 (changed evidence invalidates attestation). */

import { randomIds } from "@dockside/core";
import { Database } from "@dockside/store";
import { afterEach, describe, expect, it } from "vitest";
import { closeHarnesses } from "../../authority/test/helpers.js";
import { EvidenceService } from "../src/index.js";
import { codeOf, DAY, fillAll, makeWorld, pdf, png, type World } from "./world.js";

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

async function replaceInvoice(w: World, expected: number, text: string) {
  const current = w.evidence.manifest(w.terms.tradeId).items.find((i) => i.slotId === "commercial-invoice");
  const inv = pdf(text);
  return w.evidence.upload(w.supplier.ctx(), {
    tradeId: w.terms.tradeId,
    slotId: "commercial-invoice",
    content: inv,
    issuer: w.issue(w.supplier, "SUPPLIER_SIGNER", "commercial-invoice", inv),
    replacesItemId: current?.itemId ?? "evi_missing",
    expectedManifestRevision: expected,
  });
}

describe("T-013 evidence replacement is revisioned and concurrent-safe", () => {
  it("replacement creates a new manifest revision and preserves the full history", async () => {
    const w = await world();
    const rev = await fillAll(w);
    const before = w.evidence.manifest(w.terms.tradeId);
    const r = await replaceInvoice(w, rev, "Corrected invoice INV-1b");
    expect(r.manifestRevision).toBe(rev + 1);
    const after = w.evidence.manifest(w.terms.tradeId);
    const oldInv = before.items.find((i) => i.slotId === "commercial-invoice");
    const newInv = after.items.find((i) => i.slotId === "commercial-invoice");
    expect(newInv).toMatchObject({ version: 2, predecessorItemId: oldInv?.itemId });
    expect(after.digest).not.toBe(before.digest);
    // History: the predecessor manifest and item are still retrievable and unchanged.
    expect(w.evidence.manifest(w.terms.tradeId, rev).digest).toBe(before.digest);
    expect(w.evidence.history(w.terms.tradeId).map((h) => h.revision)).toEqual([1, 2, 3, 4]);
    expect(w.evidence.item(oldInv?.itemId ?? "").originalDigest).toBe(oldInv?.originalDigest);
    // The immutable item rows reject in-place edits at the database layer.
    expect(await codeOf(() => w.h.db.run("UPDATE evidence_items SET byte_length = 1"))).not.toBe("NO_ERROR");
    expect(await codeOf(() => w.h.db.run("DELETE FROM evidence_manifests"))).not.toBe("NO_ERROR");
  });

  it("a stale compare-and-swap surfaces VERSION_CONFLICT and changes nothing", async () => {
    const w = await world();
    const rev = await fillAll(w);
    await replaceInvoice(w, rev, "first replacement");
    expect(await codeOf(replaceInvoice(w, rev, "racing replacement"))).toBe("VERSION_CONFLICT");
    expect(w.evidence.currentRevision(w.terms.tradeId)).toBe(rev + 1);
    // Replacing an item that is no longer current is refused.
    const stale = w.evidence.manifest(w.terms.tradeId, rev).items[0]?.itemId ?? "";
    const inv = pdf("x");
    expect(
      await codeOf(
        w.evidence.upload(w.supplier.ctx(), {
          tradeId: w.terms.tradeId,
          slotId: "commercial-invoice",
          content: inv,
          issuer: w.issue(w.supplier, "SUPPLIER_SIGNER", "commercial-invoice", inv),
          replacesItemId: stale,
          expectedManifestRevision: rev + 1,
        }),
      ),
    ).toBe("INVALID_STATE");
  });

  it("two service instances on separate database connections race: exactly one replacement wins", async () => {
    const w = await world();
    const rev = await fillAll(w);
    const db2 = Database.open(w.h.dbPath);
    try {
      const other = new EvidenceService({
        db: db2,
        clock: w.h.clock,
        ids: randomIds,
        authority: w.h.svc,
        objects: w.evidence.objectStore,
      });
      const current = w.evidence.manifest(w.terms.tradeId).items[0]?.itemId ?? "";
      const mk = (svc: EvidenceService, text: string) => {
        const inv = pdf(text);
        return svc.upload(w.supplier.ctx(), {
          tradeId: w.terms.tradeId,
          slotId: "commercial-invoice",
          content: inv,
          issuer: w.issue(w.supplier, "SUPPLIER_SIGNER", "commercial-invoice", inv),
          replacesItemId: current,
          expectedManifestRevision: rev,
        });
      };
      const results = await Promise.allSettled([mk(w.evidence, "left"), mk(other, "right")]);
      const ok = results.filter((r) => r.status === "fulfilled");
      const bad = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      expect(ok).toHaveLength(1);
      expect((bad[0]?.reason as { code?: string } | undefined)?.code).toBe("VERSION_CONFLICT");
      expect(w.evidence.currentRevision(w.terms.tradeId)).toBe(rev + 1);
    } finally {
      db2.close();
    }
  });
});

describe("T-018 changed evidence invalidates attestation", () => {
  it("add, remove, replace and stale each change the digest and supersede predecessor authority", async () => {
    const w = await world();
    const rev = await fillAll(w);
    const att = await w.evidence.attest(w.terms.tradeId, w.attestor);
    expect(w.evidence.attestationStatus(att.id)).toBe("CURRENT");
    const ins = w.evidence.recordInspection(
      w.terms.tradeId,
      ...w.inspect(att.manifestRevision, att.manifestDigest, "PASS"),
    );
    expect(w.evidence.currentInspection(w.terms.tradeId)?.id).toBe(ins.id);
    const digests = [att.manifestDigest];

    // Add a second photo.
    const img2 = png(8, 8, 9);
    await w.evidence.upload(w.inspector.ctx(), {
      tradeId: w.terms.tradeId,
      slotId: "cargo-photos",
      content: img2,
      issuer: w.issue(w.inspector, "INSPECTOR", "cargo-photos", img2),
      expectedManifestRevision: rev,
    });
    digests.push(w.evidence.manifest(w.terms.tradeId).digest);
    expect(w.evidence.attestationStatus(att.id)).toBe("SUPERSEDED");
    expect(w.evidence.currentInspection(w.terms.tradeId)).toBeNull();
    // The superseded attestation and inspection cannot be re-recorded as current.
    expect(await codeOf(() => w.evidence.verifyAttestation(w.terms.tradeId, att.typed, att.signature))).toBe(
      "STALE_MANIFEST",
    );
    expect(
      await codeOf(() =>
        w.evidence.recordInspection(
          w.terms.tradeId,
          ...w.inspect(att.manifestRevision, att.manifestDigest, "PASS"),
        ),
      ),
    ).toBe("STALE_MANIFEST");

    // Remove that photo again.
    const photo2 = w.evidence.manifest(w.terms.tradeId).items.filter((i) => i.slotId === "cargo-photos")[1];
    w.evidence.removeItem(w.inspector.ctx(), {
      tradeId: w.terms.tradeId,
      itemId: photo2?.itemId ?? "",
      expectedManifestRevision: rev + 1,
    });
    digests.push(w.evidence.manifest(w.terms.tradeId).digest);
    // Replace the invoice.
    await replaceInvoice(w, rev + 2, "Invoice v2");
    digests.push(w.evidence.manifest(w.terms.tradeId).digest);
    expect(new Set(digests).size).toBe(4);
    // A fresh attestation covers the new state; letting it go stale blocks a new one.
    const att2 = await w.evidence.attest(w.terms.tradeId, w.attestor);
    expect(att2.manifestRevision).toBe(rev + 3);
    w.h.clock.advance(7 * DAY);
    expect(w.evidence.evaluate(w.terms.tradeId).status).toBe("INCOMPLETE");
    expect(w.evidence.attestationStatus(att2.id)).toBe("EXPIRED");
    expect(await codeOf(w.evidence.attest(w.terms.tradeId, w.attestor))).toBe("INCOMPLETE");
  });

  it("removing a required item leaves the slot MISSING and the manifest unattestable", async () => {
    const w = await world();
    const rev = await fillAll(w);
    const photo = w.evidence.manifest(w.terms.tradeId).items.find((i) => i.slotId === "cargo-photos");
    // The uploader capability check applies to removal too.
    expect(
      await codeOf(() =>
        w.evidence.removeItem(w.supplierClerk.ctx(), {
          tradeId: w.terms.tradeId,
          itemId: photo?.itemId ?? "",
          expectedManifestRevision: rev,
        }),
      ),
    ).toBe("FORBIDDEN");
    w.evidence.removeItem(w.inspector.ctx(), {
      tradeId: w.terms.tradeId,
      itemId: photo?.itemId ?? "",
      expectedManifestRevision: rev,
    });
    expect(w.evidence.evaluate(w.terms.tradeId).slots[2]?.status).toBe("MISSING");
    expect(await codeOf(w.evidence.attest(w.terms.tradeId, w.attestor))).toBe("INCOMPLETE");
  });
});
