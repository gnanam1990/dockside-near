import { createHash } from "node:crypto";
import {
  type CanonicalValue,
  type Clock,
  digestHexFor,
  fail,
  type IdGenerator,
  requireSignature,
  type TradeTerms,
  verifyFor,
} from "@dockside/core";
import type { Database } from "@dockside/store";
import { encodeQr } from "../../../site/proof/lib/qr.mjs";
import type { ExportKeySigner } from "./export-signing.js";
import type { TradeModules } from "./trades.js";
import { addKeyChecks, type ExportCheck, type TrustedExportKey } from "./verify-export.js";

/**
 * Signed payment receipt (M54, ADR-0029). A receipt states what the escrow contract and the
 * journal record for one paid release: parties, asset and amount, the inspection the release was
 * approved on, the release intent and the transaction that paid it, and the address of the page
 * that re-checks all of it on NEAR in the reader's browser. The statement is signed by the
 * deployment's dedicated audit-export key (ADR-0018) under its own domain, PAYMENT_RECEIPT.
 *
 * The PDF is rendered deterministically from the signed bundle and carries the bundle as an
 * attachment, so the offline verifier can check the signature and then render the PDF again and
 * compare it byte for byte: any edit to the visible text, however small, is detected.
 */
export const SIGNED_PAYMENT_RECEIPT_SCHEMA = "dockside/signed-payment-receipt@1";
export const PAYMENT_RECEIPT_STATEMENT_SCHEMA = "dockside/payment-receipt-statement@1";
const ATTACHMENT = "dockside-receipt.json";

/** What the contract and the journal record for one paid release. */
export interface ReceiptFacts {
  readonly tradeId: string;
  readonly tradeRevision: number;
  readonly termsDigest: string;
  readonly network: string;
  readonly escrowContractId: string;
  readonly buyer: { organizationId: string; account: string };
  readonly supplier: { organizationId: string; account: string };
  readonly asset: { kind: string; network: string };
  readonly amountYocto: string;
  readonly inspection: { decision: string; reasonCodes: string[]; digest: string; recordedAt: number };
  readonly release: {
    releaseIntentId: string;
    state: "PAID";
    destination: string;
    paidAt: number | null;
    txHash: string;
    txSigner: string;
  };
  readonly verifyUrl: string;
}

export interface PaymentReceiptStatement extends ReceiptFacts {
  readonly [key: string]: CanonicalValue;
  readonly schema: typeof PAYMENT_RECEIPT_STATEMENT_SCHEMA;
  readonly issuedTo: { principalId: string; organizationId: string };
  readonly origin: string;
  readonly keyId: string;
  readonly publicKey: string;
  readonly signedAt: number;
}

export interface SignedPaymentReceipt {
  readonly schema: typeof SIGNED_PAYMENT_RECEIPT_SCHEMA;
  readonly statement: PaymentReceiptStatement;
  readonly statementDigest: string;
  readonly signature: string;
}

export interface ReceiptPdf {
  readonly fileName: string;
  readonly contentType: "application/pdf";
  readonly sha256: string;
  readonly base64: string;
}

export interface ReceiptDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly origin: string;
  readonly network: string;
}

const STATEMENT_FIELDS = [
  "amountYocto",
  "asset",
  "buyer",
  "escrowContractId",
  "inspection",
  "issuedTo",
  "keyId",
  "network",
  "origin",
  "publicKey",
  "release",
  "schema",
  "signedAt",
  "supplier",
  "termsDigest",
  "tradeId",
  "tradeRevision",
  "verifyUrl",
];

const YOCTO = 10n ** 24n;
/** "50000000000000000000000" -> "0.05 NEAR", exactly. */
export function formatNear(yocto: string | bigint): string {
  const n = BigInt(yocto);
  const frac = (n % YOCTO).toString().padStart(24, "0").replace(/0+$/, "");
  return `${n / YOCTO}${frac ? `.${frac}` : ""} NEAR`;
}

/** The receipt page address: the hosted front serves it at /receipt/<trade id> (M54). */
export function receiptVerifyUrl(
  origin: string,
  network: string,
  tradeId: string,
  txHash: string,
  signer: string,
) {
  const url = new URL(`/receipt/${encodeURIComponent(tradeId)}`, origin);
  url.searchParams.set("network", network === "near-mainnet" ? "mainnet" : "testnet");
  url.searchParams.set("tx", txHash);
  url.searchParams.set("signer", signer);
  return url.toString();
}

/**
 * The facts of a receipt, from one fresh read of the contract and the journal's release record.
 * Refused unless the contract shows a PAID release intent whose transaction the journal recorded.
 */
export async function receiptFacts(m: TradeModules, t: TradeTerms, origin: string): Promise<ReceiptFacts> {
  const id = t.tradeId;
  const [trade, ledger, evidence, release] = await Promise.all([
    m.escrow.getTrade(id),
    m.escrow.getLedger(id),
    m.escrow.getEvidence(id),
    m.escrow.getRelease(id),
  ]);
  const intent = release.intents.filter((x) => x.state === "PAID").at(-1);
  if (!intent)
    fail("INVALID_STATE", "the contract shows no paid release for this trade", {
      reason: "RELEASE_NOT_PAID",
    });
  const op = m.journal.journal.opForSubject("RELEASE", intent.releaseIntentId);
  if (op?.state !== "PAID" || !op.txHash || !op.txSigner)
    fail("INVALID_STATE", "the release transaction of this trade is not recorded", {
      reason: "RELEASE_TX_NOT_RECORDED",
    });
  const ins = evidence.inspection;
  if (!ins)
    fail("INVALID_STATE", "the contract records no inspection for this trade", { reason: "NO_INSPECTION" });
  const paidAt = intent.history.find((h) => h[0] === "PAID")?.[1] ?? null;
  return {
    tradeId: id,
    tradeRevision: trade.revision,
    termsDigest: trade.termsDigest,
    network: t.network,
    escrowContractId: t.escrowContractId,
    buyer: { organizationId: t.buyer.organizationId, account: trade.buyerAccount },
    supplier: { organizationId: t.supplier.organizationId, account: trade.supplierAccount },
    asset: { kind: ledger.asset.kind, network: ledger.asset.network },
    amountYocto: intent.amount.toString(),
    inspection: {
      decision: ins.decision,
      reasonCodes: [...ins.reasonCodes],
      digest: ins.digest,
      recordedAt: ins.recordedAt,
    },
    release: {
      releaseIntentId: intent.releaseIntentId,
      state: "PAID",
      destination: intent.destination,
      paidAt,
      txHash: op.txHash,
      txSigner: op.txSigner,
    },
    verifyUrl: receiptVerifyUrl(origin, t.network, id, op.txHash, op.txSigner),
  };
}

/** Sign the facts with the active, enrolled audit-export key of this origin. */
export async function signPaymentReceipt(
  d: ReceiptDeps,
  signer: ExportKeySigner,
  facts: ReceiptFacts,
  issuedTo: { principalId: string; organizationId: string },
): Promise<SignedPaymentReceipt> {
  const row = d.db.get(
    "SELECT * FROM audit_export_keys WHERE public_key = ? AND origin = ? AND status = 'ACTIVE'",
    signer.publicKey,
    d.origin,
  );
  if (!row)
    fail("INVALID_STATE", "the audit export key is not the active enrolled key", {
      reason: "EXPORT_KEY_NOT_ACTIVE",
    });
  const statement: PaymentReceiptStatement = {
    schema: PAYMENT_RECEIPT_STATEMENT_SCHEMA,
    ...facts,
    issuedTo: { ...issuedTo },
    origin: d.origin,
    keyId: String(row["key_id"]),
    publicKey: signer.publicKey,
    signedAt: d.clock.now(),
  };
  const signature = await signer.sign("PAYMENT_RECEIPT", statement);
  requireSignature(signer.publicKey, "PAYMENT_RECEIPT", statement, signature);
  return {
    schema: SIGNED_PAYMENT_RECEIPT_SCHEMA,
    statement,
    statementDigest: digestHexFor("PAYMENT_RECEIPT", statement),
    signature,
  };
}

/* ------------------------------------ PDF ------------------------------------ */

/** PDF literal string: printable ASCII only, with the three special characters escaped. */
function pdfString(text: string): string {
  const ascii = [...text].map((ch) => (ch >= " " && ch <= "~" ? ch : "?")).join("");
  return `(${ascii.replace(/[\\()]/g, (c) => `\\${c}`)})`;
}

/** JSON with every non-ASCII character escaped, so the attachment is plain ASCII. */
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** Lines of at most `width` characters, broken after a space where there is one. */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > width) {
    const space = rest.lastIndexOf(" ", width);
    const cut = space > 0 ? space + 1 : width;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut);
  }
  out.push(rest);
  return out;
}

const iso = (ms: number | null) =>
  ms === null ? "not recorded" : new Date(ms).toISOString().replace(".000Z", "Z");
const pdfDate = (ms: number) => `D:${new Date(ms).toISOString().replace(/[-:T]/g, "").slice(0, 14)}Z`;

/** Content stream of the one page: the receipt as text, the QR code, the signature block. */
function pageContent(b: SignedPaymentReceipt): string {
  const s = b.statement;
  const ops: string[] = [];
  let y = 792;
  const text = (font: string, size: number, x: number, at: number, value: string) =>
    ops.push(`BT /${font} ${size} Tf ${x} ${at} Td ${pdfString(value)} Tj ET`);
  const rule = (at: number) => ops.push(`0.8 g 50 ${at} 495 0.5 re f 0 g`);

  text("F2", 20, 50, y, "Dockside payment receipt");
  y -= 18;
  text("F1", 9, 50, y, `Issued by the Dockside deployment at ${s.origin} on ${iso(s.signedAt)}.`);
  y -= 12;
  text(
    "F1",
    9,
    50,
    y,
    "The facts below were read from the NEAR escrow contract and are signed. Check them on NEAR",
  );
  y -= 11;
  text(
    "F1",
    9,
    50,
    y,
    "yourself: scan the code or open the address under it. No trust in this document is needed.",
  );
  y -= 10;
  rule(y);
  y -= 18;

  const ins = s.inspection;
  const rows: [string, string][] = [
    ["Trade", s.tradeId],
    [
      "Amount paid",
      s.asset.kind === "NEAR_NATIVE" ? formatNear(s.amountYocto) : `${s.amountYocto} base units`,
    ],
    ["Amount (base units)", s.amountYocto],
    [
      "Asset",
      s.asset.kind === "NEAR_NATIVE"
        ? `NEAR (native) on ${s.asset.network}`
        : `${s.asset.kind} on ${s.asset.network}`,
    ],
    ["Buyer", s.buyer.account],
    ["Buyer organisation", s.buyer.organizationId],
    ["Supplier", s.supplier.account],
    ["Supplier organisation", s.supplier.organizationId],
    ["Paid to", s.release.destination],
    [
      "Inspection",
      `${ins.decision} (${ins.reasonCodes.join(", ") || "no reason code"}), ${iso(ins.recordedAt)}`,
    ],
    ["Inspection digest", ins.digest],
    ["Release intent", s.release.releaseIntentId],
    ["Release state", s.release.state],
    ["Paid at", iso(s.release.paidAt)],
    ["Release transaction", s.release.txHash],
    ["Transaction signer", s.release.txSigner],
    ["Escrow contract", s.escrowContractId],
    ["Network", s.network],
    ["Terms", `revision ${s.tradeRevision}, digest ${s.termsDigest}`],
  ];
  for (const [label, value] of rows) {
    const lines = wrap(value, 68);
    text("F2", 9, 50, y, label);
    for (const [i, line] of lines.entries()) text("F3", 9, 170, y - i * 11, line);
    y -= 11 * lines.length + 5;
  }
  y -= 4;
  rule(y);
  y -= 18;

  // The QR code, drawn in module units: one rectangle per horizontal run of dark modules.
  text("F2", 11, 50, y, "Verify on NEAR");
  const qr = encodeQr(s.verifyUrl);
  const side = 150;
  const unit = (side / (qr.size + 8)).toFixed(4);
  const top = y - 8;
  const left = 50;
  const runs: string[] = [];
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; ) {
      if (!qr.modules[r]?.[c]) {
        c++;
        continue;
      }
      let e = c;
      while (e < qr.size && qr.modules[r]?.[e]) e++;
      runs.push(`${c} ${r} ${e - c} 1 re`);
      c = e;
    }
  }
  ops.push(
    `1 g ${left} ${top - side} ${side} ${side} re f 0 g`,
    `% qr-begin ${qr.size}`,
    `q ${unit} 0 0 -${unit} ${left} ${top} cm 1 0 0 1 4 4 cm`,
    ...runs,
    "f Q",
    "% qr-end",
  );
  let ty = y - 20;
  text("F1", 9, 215, ty, "Open this address, or scan the code, to have your browser read the");
  ty -= 11;
  text("F1", 9, 215, ty, "contract and check every fact above, the code hash of the escrow");
  ty -= 11;
  text("F1", 9, 215, ty, "and the release transaction:");
  ty -= 14;
  for (const line of wrap(s.verifyUrl, 60)) {
    text("F3", 8, 215, ty, line);
    ty -= 10;
  }
  y = Math.min(top - side, ty) - 16;
  rule(y);
  y -= 18;

  text("F2", 11, 50, y, "Signature");
  y -= 14;
  const sig: [string, string][] = [
    ["Signed by key", s.keyId],
    ["Key of", `the audit-export keys of ${s.origin}`],
    ["Public key", s.publicKey],
    ["Signed at", iso(s.signedAt)],
    ["Issued to", `${s.issuedTo.principalId} of ${s.issuedTo.organizationId}`],
    ["Statement digest", b.statementDigest],
    ["Signature", b.signature],
  ];
  for (const [label, value] of sig) {
    const lines = wrap(value, 74);
    text("F2", 8, 50, y, label);
    for (const [i, line] of lines.entries()) text("F3", 8, 150, y - i * 10, line);
    y -= 10 * lines.length + 3;
  }
  y -= 8;
  for (const line of [
    `The signed statement is attached to this PDF as ${ATTACHMENT} (domain dockside/payment-receipt).`,
    "Verify the file offline: pnpm run verify-receipt <this file> --trusted-keys <published key list>.",
    "The verifier checks the signature and renders this PDF again from the statement: any edit fails.",
  ]) {
    text("F1", 7.5, 50, y, line);
    y -= 9;
  }
  return `${ops.join("\n")}\n`;
}

/** The deterministic PDF of a signed receipt: the same bundle always gives the same bytes. */
export function renderReceiptPdf(bundle: SignedPaymentReceipt): Buffer {
  const b: SignedPaymentReceipt = {
    schema: bundle.schema,
    statement: bundle.statement,
    statementDigest: bundle.statementDigest,
    signature: bundle.signature,
  };
  const json = asciiJson(b);
  const content = pageContent(b);
  const font = (name: string) =>
    `<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`;
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [${pdfString(ATTACHMENT)} 7 0 R] >> >> >>`,
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R /F3 6 0 R >> >> /Contents 9 0 R >>",
    font("Helvetica"),
    font("Helvetica-Bold"),
    font("Courier"),
    `<< /Type /Filespec /F ${pdfString(ATTACHMENT)} /UF ${pdfString(ATTACHMENT)} /EF << /F 8 0 R >> /Desc (Signed Dockside payment receipt statement) >>`,
    `<< /Type /EmbeddedFile /Subtype /application#2Fjson /Length ${json.length} >>\nstream\n${json}\nendstream`,
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    `<< /Title ${pdfString(`Dockside payment receipt ${b.statement.tradeId}`)} /Producer (Dockside) /CreationDate (${pdfDate(b.statement.signedAt)}) >>`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 10 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

export function receiptPdf(bundle: SignedPaymentReceipt): ReceiptPdf {
  const bytes = renderReceiptPdf(bundle);
  return {
    fileName: `dockside-receipt-${bundle.statement.tradeId}.pdf`,
    contentType: "application/pdf",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    base64: bytes.toString("base64"),
  };
}

/** The signed bundle attached to a receipt PDF, or null when there is none. */
export function extractReceiptBundle(pdf: Uint8Array): unknown {
  const text = Buffer.from(pdf).toString("latin1");
  const m = /\/Type \/EmbeddedFile \/Subtype \/application#2Fjson \/Length (\d{1,8}) >>\nstream\n/.exec(text);
  if (!m) return null;
  const start = m.index + m[0].length;
  const body = text.slice(start, start + Number(m[1]));
  if (text.slice(start + body.length, start + body.length + 10) !== "\nendstream") return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

export interface ReceiptVerification {
  readonly ok: boolean;
  readonly checks: readonly ExportCheck[];
  readonly tradeId: string | null;
  readonly keyId: string | null;
  readonly verifyUrl: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Offline verification of a receipt PDF: no network, no database, no clock. Checks the attached
 * statement's digest and Ed25519 signature, that the key is one of the operator's published
 * audit-export keys and was valid when it signed, and that the PDF is exactly the one the renderer
 * produces from that statement.
 */
export function verifyReceiptPdf(pdf: Uint8Array, trusted: readonly TrustedExportKey[]): ReceiptVerification {
  const checks: ExportCheck[] = [];
  const add = (id: string, ok: boolean, detail: string) => {
    checks.push({ id, ok, detail });
    return ok;
  };
  let tradeId: string | null = null;
  let keyId: string | null = null;
  let verifyUrl: string | null = null;
  const done = (): ReceiptVerification => ({
    ok: checks.length > 0 && checks.every((c) => c.ok),
    checks,
    tradeId,
    keyId,
    verifyUrl,
  });
  const bytes = Buffer.from(pdf);
  add("pdf.header", bytes.subarray(0, 9).toString("latin1") === "%PDF-1.4\n", "a PDF 1.4 file");
  const bundle = extractReceiptBundle(bytes);
  if (
    !add(
      "pdf.attachment",
      isObj(bundle),
      isObj(bundle) ? `attachment ${ATTACHMENT}` : "no signed receipt attached",
    )
  )
    return done();
  const b = bundle as Record<string, unknown>;
  if (!add("bundle.schema", b["schema"] === SIGNED_PAYMENT_RECEIPT_SCHEMA, `schema ${String(b["schema"])}`))
    return done();
  const fields = Object.keys(b).sort().join(",");
  if (!add("bundle.fields", fields === "schema,signature,statement,statementDigest", `fields ${fields}`))
    return done();
  const st = b["statement"];
  if (!isObj(st)) {
    add("statement.fields", false, "statement is not an object");
    return done();
  }
  tradeId = typeof st["tradeId"] === "string" ? st["tradeId"] : null;
  keyId = typeof st["keyId"] === "string" ? st["keyId"] : null;
  verifyUrl = typeof st["verifyUrl"] === "string" ? st["verifyUrl"] : null;
  const stFields = Object.keys(st).sort();
  add(
    "statement.fields",
    JSON.stringify(stFields) === JSON.stringify(STATEMENT_FIELDS) &&
      st["schema"] === PAYMENT_RECEIPT_STATEMENT_SCHEMA,
    `fields ${stFields.join(",")}`,
  );
  let digest = "";
  try {
    digest = digestHexFor("PAYMENT_RECEIPT", st as CanonicalValue);
  } catch (e) {
    add("statement.digest", false, `statement is not canonical: ${(e as Error).message}`);
    return done();
  }
  add("statement.digest", digest === b["statementDigest"], `recomputed ${digest}`);
  const pk = typeof st["publicKey"] === "string" ? st["publicKey"] : "";
  const sig = typeof b["signature"] === "string" ? b["signature"] : "";
  let sigOk = false;
  try {
    sigOk = pk !== "" && sig !== "" && verifyFor(pk, "PAYMENT_RECEIPT", st as CanonicalValue, sig);
  } catch {
    sigOk = false;
  }
  add("signature", sigOk, "Ed25519 over the DCE-1 statement digest, domain dockside/payment-receipt");
  addKeyChecks(add, trusted, {
    keyId,
    publicKey: pk,
    origin: st["origin"],
    network: st["network"],
    signedAt: st["signedAt"],
  });
  let same = false;
  try {
    same = renderReceiptPdf(b as unknown as SignedPaymentReceipt).equals(bytes);
  } catch {
    same = false;
  }
  add(
    "pdf.rendering",
    same,
    same
      ? "the PDF is exactly the rendering of the signed statement"
      : "the PDF differs from the rendering of the signed statement",
  );
  return done();
}
