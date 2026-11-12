#!/usr/bin/env node
/**
 * Offline verifier for signed Dockside audit exports (ADR-0016).
 *
 *   verify-export <signed-export.json> --trusted-keys <keys.json> [--json]
 *
 * Reads two local files and nothing else: no network, no database. <keys.json> is the operator's
 * published export key list (`GET /v1/audit-export-keys` or `export-key list`), obtained out of band.
 * Every check is printed separately. Exit codes: 0 every check holds, 1 a check fails, 2 usage error.
 */
import { readFileSync } from "node:fs";
import { parseStrictJson } from "@dockside/core";
import { parseTrustedKeys, verifySignedAuditExport } from "../verify-export.js";

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
  if (files.length !== 1 || keys === undefined) return usage("expected one bundle file and --trusted-keys");
  let bundle: unknown;
  let trusted: ReturnType<typeof parseTrustedKeys>;
  try {
    bundle = parseStrictJson(new Uint8Array(readFileSync(files[0] as string)), {
      maxBytes: 64 * 1024 * 1024,
      maxDepth: 64,
      maxStringLength: 16 * 1024 * 1024,
      maxArrayLength: 1_000_000,
      maxObjectKeys: 4096,
    });
    trusted = parseTrustedKeys(JSON.parse(readFileSync(keys, "utf8")));
  } catch (e) {
    process.stderr.write(`verify-export: cannot read input: ${(e as Error).message}\n`);
    return 1;
  }
  const r = verifySignedAuditExport(bundle, trusted);
  if (json) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  else {
    for (const c of r.checks)
      process.stdout.write(`${c.ok ? "PASS" : "FAIL"}  ${c.id.padEnd(22)} ${c.detail}\n`);
    process.stdout.write(
      `${r.ok ? "VERIFIED" : "NOT VERIFIED"}: trade ${r.tradeId ?? "?"}, export key ${r.keyId ?? "?"}\n`,
    );
  }
  return r.ok ? 0 : 1;
}

function usage(msg: string): number {
  process.stderr.write(
    `verify-export: ${msg}\nusage: verify-export <signed-export.json> --trusted-keys <keys.json> [--json]\n`,
  );
  return 2;
}

process.exit(main(process.argv.slice(2)));
