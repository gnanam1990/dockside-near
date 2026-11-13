/**
 * M54: the signed payment receipt. A trade runs to PAID through the real API, the real journal and
 * outbox worker, and the compiled escrow wasm on the simulated NEAR host; the receipt is then built
 * from a fresh read of the contract (trade, ledger, evidence, release) and the journal's release
 * transaction, signed by the deployment's audit-export key in its isolated signer process under the
 * PAYMENT_RECEIPT domain, and rendered as a deterministic PDF that carries the signed statement as
 * an attachment. The offline verifier reads only the PDF and the published key list.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { IsolatedSigner } from "@dockside/authority";
import { digestHexFor, randomIds } from "@dockside/core";
import { NearTxClient } from "@dockside/near";
import jsQRModule from "jsqr";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, ORIGIN } from "../../../packages/authority/test/helpers.js";
import { rpcFor } from "../../../packages/journal/test/world.js";
import { enrollExportKey, type ExportKeySigner, revokeExportKey } from "../src/app.js";
import {
  extractReceiptBundle,
  renderReceiptPdf,
  SIGNED_PAYMENT_RECEIPT_SCHEMA,
  verifyReceiptPdf,
} from "../src/receipt.js";
import { parseTrustedKeys } from "../src/verify-export.js";
import { type ApiWorld, apiWorld, lockAndApprove, run } from "./m07-world.js";

// jsqr is CommonJS with an ES default export: under NodeNext its default import types as the module.
const jsQR = ((jsQRModule as unknown as { default?: unknown }).default ??
  jsQRModule) as typeof jsQRModule.default;

const DIST_CLI = fileURLToPath(new URL("../dist/cli/", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "dockside-m54-"));
const seedFile = join(dir, "export-key.seed");
let signerProc: IsolatedSigner;
let signer: ExportKeySigner;
let a: ApiWorld;
let buyer: Actor;
let supplier: Actor;

beforeAll(async () => {
  writeFileSync(seedFile, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
  signerProc = await IsolatedSigner.spawn({
    allowedPurposes: ["AUDIT_EXPORT_KEY_ENROLLMENT", "AUDIT_EXPORT", "PAYMENT_RECEIPT"],
    seedFile,
  });
  signer = {
    publicKey: signerProc.publicKey,
    custodyKind: "ISOLATED_SIGNER_PROCESS",
    sign: (p, v) => signerProc.sign(p, v),
  };
  a = await apiWorld({
    extra: (w) => ({
      exportSigner: signer,
      chain: { rpc: rpcFor(w.url), tx: new NearTxClient(rpcFor(w.url)) },
    }),
  });
  const h = a.w.c.w.h;
  await enrollExportKey(
    { db: h.db, clock: h.clock, ids: randomIds, origin: ORIGIN, network: "near-testnet" },
    signer,
  );
  buyer = a.actors.buyer;
  supplier = a.actors.supplier;
});
afterAll(async () => {
  signerProc?.close();
  await a?.close();
});

const path = () => `/v1/trades/${a.w.c.t}/payment-receipt`;
const pdfOf = (r: { json: { pdf: { base64: string } } }) => Buffer.from(r.json.pdf.base64, "base64");
let receipt: any;
let pdf: Buffer;
let keys: any;

/** Reads the QR code drawn in the PDF's content stream back with an independent decoder. */
function readPdfQr(bytes: Buffer): string | null {
  const text = bytes.toString("latin1");
  const block = /% qr-begin (\d+)\n([\s\S]*?)% qr-end/.exec(text);
  if (!block) return null;
  const size = Number(block[1]);
  const quiet = 4;
  const scale = 4;
  const n = (size + 2 * quiet) * scale;
  const rgba = new Uint8ClampedArray(n * n * 4).fill(255);
  for (const m of (block[2] ?? "").matchAll(/^(\d+) (\d+) (\d+) 1 re$/gm)) {
    const [x0, y, w] = [Number(m[1]), Number(m[2]), Number(m[3])];
    for (let x = x0; x < x0 + w; x++)
      for (let dy = 0; dy < scale; dy++)
        for (let dx = 0; dx < scale; dx++) {
          const p = (((y + quiet) * scale + dy) * n + (x + quiet) * scale + dx) * 4;
          rgba[p] = rgba[p + 1] = rgba[p + 2] = 0;
        }
  }
  return jsQR(rgba, n, n)?.data ?? null;
}

describe("M54 signed payment receipt", () => {
  it("is refused until the contract shows the release PAID", async () => {
    const r = await a.http(buyer, "GET", path());
    expect(r.status).toBe(409);
    expect(r.json.error).toMatchObject({ code: "INVALID_STATE", details: { reason: "RELEASE_NOT_PAID" } });
  });

  it("after the release is paid, signs a receipt of what the contract and the journal record", async () => {
    const intentId = await lockAndApprove(a, "m54-receipt-01");
    const ex = await a.http(buyer, "POST", `/v1/release-intents/${intentId}/execute`);
    expect(ex.status, ex.text).toBe(201);
    await run(a.w);
    const r = await a.http(buyer, "GET", path());
    expect(r.status, r.text).toBe(200);
    receipt = r.json;
    expect(receipt.schema).toBe(SIGNED_PAYMENT_RECEIPT_SCHEMA);
    const st = receipt.statement;
    const op = a.w.c.w.h.db.get(
      "SELECT * FROM economic_operations WHERE trade_id = ? AND kind = 'RELEASE'",
      a.w.c.t,
    );
    expect(op?.["state"]).toBe("PAID");
    const terms = (await a.http(buyer, "GET", `/v1/trades/${a.w.c.t}`)).json.trade;
    expect(st).toMatchObject({
      schema: "dockside/payment-receipt-statement@1",
      tradeId: a.w.c.t,
      tradeRevision: terms.revision,
      termsDigest: terms.termsDigest,
      network: "near-testnet",
      escrowContractId: terms.escrowContractId,
      buyer: { organizationId: terms.buyer.organizationId },
      supplier: { organizationId: terms.supplier.organizationId },
      asset: { kind: "NEAR_NATIVE", network: "near-testnet" },
      amountYocto: String(terms.amountYocto),
      inspection: { decision: "PASS" },
      release: {
        releaseIntentId: intentId,
        state: "PAID",
        txHash: String(op?.["tx_hash"]),
        txSigner: String(op?.["tx_signer"]),
      },
      issuedTo: { principalId: buyer.principalId },
      origin: ORIGIN,
      publicKey: signer.publicKey,
    });
    expect(typeof st.release.paidAt).toBe("number");
    expect(st.verifyUrl).toBe(
      `${ORIGIN}/receipt/${a.w.c.t}?network=testnet&tx=${op?.["tx_hash"]}&signer=${op?.["tx_signer"]}`,
    );
    expect(receipt.statementDigest).toBe(digestHexFor("PAYMENT_RECEIPT", st));
    // A receipt signature is not an audit export signature: the domains differ.
    expect(receipt.statementDigest).not.toBe(digestHexFor("AUDIT_EXPORT", st));
    pdf = pdfOf(r);
    expect(receipt.pdf.sha256).toBe(createHash("sha256").update(pdf).digest("hex"));
    expect(receipt.pdf.fileName).toBe(`dockside-receipt-${a.w.c.t}.pdf`);
    const types = a.w.c.w.h.db.all("SELECT event_type FROM audit_events").map((x) => String(x["event_type"]));
    expect(types).toContain("PAYMENT_RECEIPT_SIGNED");
  });

  it("the PDF is a well-formed single-page document with the receipt in plain text and an attachment", () => {
    const text = pdf.toString("latin1");
    expect(text.startsWith("%PDF-1.4\n")).toBe(true);
    expect(text.endsWith("%%EOF\n")).toBe(true);
    // Every cross-reference entry points at its object.
    const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)?.[1]);
    expect(text.slice(startxref, startxref + 4)).toBe("xref");
    const xref = /xref\n0 (\d+)\n([\s\S]*?)trailer/.exec(text.slice(startxref));
    const entries = (xref?.[2] ?? "").trim().split("\n").slice(1);
    expect(entries).toHaveLength(Number(xref?.[1]) - 1);
    entries.forEach((e, i) => {
      const off = Number(e.slice(0, 10));
      expect(text.slice(off, off + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
    });
    expect(text).toContain("/Type /Pages /Kids [3 0 R] /Count 1");
    expect(text).toContain("/EmbeddedFiles");
    for (const shown of [
      a.w.c.t,
      receipt.statement.release.txHash,
      receipt.statement.buyer.account,
      receipt.statement.supplier.account,
      receipt.statement.release.destination,
      "PAID",
      receipt.statement.keyId,
    ])
      expect(text).toContain(`(${shown})`);
    // Parentheses inside a PDF string are escaped.
    expect(text).toContain(String.raw`dockside-receipt.json \(domain dockside/payment-receipt\)`);
    expect(extractReceiptBundle(pdf)).toEqual({
      schema: receipt.schema,
      statement: receipt.statement,
      statementDigest: receipt.statementDigest,
      signature: receipt.signature,
    });
  });

  it("the QR code printed in the PDF reads back as the receipt's verification address", () => {
    expect(readPdfQr(pdf)).toBe(receipt.statement.verifyUrl);
  });

  it("verifies offline against the published key list, and renders byte for byte again", async () => {
    keys = (await a.http(a.actors.auditor, "GET", "/v1/audit-export-keys")).json;
    const v = verifyReceiptPdf(pdf, parseTrustedKeys(keys));
    expect(v.checks.filter((c) => !c.ok)).toEqual([]);
    expect(v.checks.map((c) => c.id)).toEqual([
      "pdf.header",
      "pdf.attachment",
      "bundle.schema",
      "bundle.fields",
      "statement.fields",
      "statement.digest",
      "signature",
      "key.trusted",
      "key.origin",
      "key.not-revoked",
      "key.validity-window",
      "pdf.rendering",
    ]);
    expect(v.ok).toBe(true);
    expect(renderReceiptPdf(extractReceiptBundle(pdf) as never).equals(pdf)).toBe(true);
  });

  it("fails each kind of tampering and names the failing check", () => {
    const trusted = parseTrustedKeys(keys);
    const failed = (b: Buffer) =>
      verifyReceiptPdf(b, trusted)
        .checks.filter((c) => !c.ok)
        .map((c) => c.id);
    // 1. Visible text edited (the amount line), the attachment left alone.
    const amountText = /\(([0-9.]+ NEAR)\)/.exec(pdf.toString("latin1"))?.[1] ?? "";
    expect(amountText).not.toBe("");
    const visible = Buffer.from(
      pdf.toString("latin1").replace(`(${amountText})`, `(${amountText.replace(/^\d/, "9")})`),
      "latin1",
    );
    expect(failed(visible)).toEqual(["pdf.rendering"]);
    // 2. A fact in the signed statement edited: the digest and the signature no longer hold.
    const forged = renderReceiptPdf({
      ...receipt,
      statement: { ...receipt.statement, amountYocto: `${receipt.statement.amountYocto}0` },
    });
    expect(failed(forged)).toEqual(["statement.digest", "signature"]);
    // 3. Re-signed by another key: not in the trusted list.
    expect(
      verifyReceiptPdf(pdf, [{ ...trusted[0]!, publicKey: "ed25519:11111111111111111111111111111111" }])
        .checks.filter((c) => !c.ok)
        .map((c) => c.id),
    ).toEqual(["key.trusted"]);
    // 4. Not a receipt at all.
    expect(failed(Buffer.from("%PDF-1.4\n%%EOF\n"))).toEqual(["pdf.attachment"]);
    expect(failed(Buffer.from("hello"))).toEqual(["pdf.header", "pdf.attachment"]);
  });

  it("is given to the trade's parties only, and denied to others exactly like a missing trade", async () => {
    const s = await a.http(supplier, "GET", path());
    expect(s.status, s.text).toBe(200);
    expect(s.json.statement.issuedTo.principalId).toBe(supplier.principalId);
    const out = await a.http(a.actors.outsiderAdmin, "GET", path());
    const missing = await a.http(buyer, "GET", `/v1/trades/trd_${"0".repeat(32)}/payment-receipt`);
    expect(out.status).toBe(404);
    expect(out.json.error).toEqual(missing.json.error);
    expect((await a.http(null, "GET", path())).status).toBe(401);
  });

  it("the verify-receipt CLI exits 0 on the PDF, 1 on a tampered file or revoked key, 2 on usage", () => {
    const cli = join(DIST_CLI, "verify-receipt.js");
    const good = join(dir, "receipt.pdf");
    const bad = join(dir, "tampered.pdf");
    const keyFile = join(dir, "keys.json");
    writeFileSync(good, pdf);
    writeFileSync(bad, Buffer.from(pdf.toString("latin1").replace("PAID", "PA1D"), "latin1"));
    writeFileSync(keyFile, JSON.stringify(keys));
    const ok = spawnSync(process.execPath, [cli, good, "--trusted-keys", keyFile], { encoding: "utf8" });
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);
    expect(ok.stdout).toContain(`VERIFIED: payment receipt of trade ${a.w.c.t}`);
    expect(ok.stdout).toContain(`Check the payment on NEAR: ${receipt.statement.verifyUrl}`);
    const no = spawnSync(process.execPath, [cli, bad, "--trusted-keys", keyFile], { encoding: "utf8" });
    expect(no.status).toBe(1);
    expect(no.stdout).toContain("FAIL  pdf.rendering");
    expect(spawnSync(process.execPath, [cli, good], { encoding: "utf8" }).status).toBe(2);
  });

  it("a revoked export key makes the receipt untrusted and signs no new receipt", async () => {
    const h = a.w.c.w.h;
    revokeExportKey(
      { db: h.db, clock: h.clock, ids: randomIds, origin: ORIGIN, network: "near-testnet" },
      receipt.statement.keyId,
      "KEY_COMPROMISED",
    );
    const after = parseTrustedKeys((await a.http(a.actors.auditor, "GET", "/v1/audit-export-keys")).json);
    const v = verifyReceiptPdf(pdf, after);
    expect(v.checks.filter((c) => !c.ok).map((c) => c.id)).toEqual(["key.not-revoked"]);
    const refused = await a.http(buyer, "GET", path());
    expect(refused.json.error).toMatchObject({
      code: "INVALID_STATE",
      details: { reason: "EXPORT_KEY_NOT_ACTIVE" },
    });
  });
});
