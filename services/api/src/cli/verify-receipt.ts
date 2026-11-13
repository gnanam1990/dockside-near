#!/usr/bin/env node
/**
 * Offline verifier for signed Dockside payment receipts (M54, ADR-0030).
 *
 *   verify-receipt <receipt.pdf> --trusted-keys <keys.json> [--json]
 *
 * Reads two local files and nothing else: no network, no database. <keys.json> is the operator's
 * published audit-export key list (`GET /v1/audit-export-keys` or `export-key list`), obtained out
 * of band. Every check is printed separately; the last line names the address that checks the
 * payment itself on NEAR. Exit codes: 0 every check holds, 1 a check fails, 2 usage error.
 */
import { readFileSync } from "node:fs";
import { verifyReceiptPdf } from "../receipt.js";
import { parseTrustedKeys } from "../verify-export.js";

const MAX_PDF_BYTES = 4 * 1024 * 1024;

function main(argv: string[]): number {
  const files: string[] = [];
  let keys: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--trusted-keys") keys = argv[++i];
    else if (a === "--json") json = true;
    else if (a.startsWith("--")) return usage(`unknown option ${a}`);
    else files.push(a);
  }
  if (files.length !== 1 || keys === undefined) return usage("expected one PDF file and --trusted-keys");
  let pdf: Buffer;
  let trusted: ReturnType<typeof parseTrustedKeys>;
  try {
    pdf = readFileSync(files[0] as string);
    if (pdf.length > MAX_PDF_BYTES) throw new Error(`file larger than ${MAX_PDF_BYTES} bytes`);
    trusted = parseTrustedKeys(JSON.parse(readFileSync(keys, "utf8")));
  } catch (e) {
    process.stderr.write(`verify-receipt: cannot read input: ${(e as Error).message}\n`);
    return 1;
  }
  const r = verifyReceiptPdf(pdf, trusted);
  if (json) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  else {
    for (const c of r.checks)
      process.stdout.write(`${c.ok ? "PASS" : "FAIL"}  ${c.id.padEnd(20)} ${c.detail}\n`);
    process.stdout.write(
      `${r.ok ? "VERIFIED" : "NOT VERIFIED"}: payment receipt of trade ${r.tradeId ?? "?"}, export key ${r.keyId ?? "?"}\n`,
    );
    if (r.verifyUrl) process.stdout.write(`Check the payment on NEAR: ${r.verifyUrl}\n`);
  }
  return r.ok ? 0 : 1;
}

function usage(msg: string): number {
  process.stderr.write(
    `verify-receipt: ${msg}\nusage: verify-receipt <receipt.pdf> --trusted-keys <keys.json> [--json]\n`,
  );
  return 2;
}

process.exit(main(process.argv.slice(2)));
