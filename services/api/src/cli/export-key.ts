#!/usr/bin/env node
/**
 * Operator tool for the dedicated audit-export signing key (ADR-0018).
 *
 *   export-key generate --out <file>
 *       Create a new Ed25519 key seed (32 random bytes, hex) in <file>, created exclusively with
 *       owner-only permissions. Prints the public key. The seed is never printed.
 *   export-key show --key-file <file>
 *       Print the public key of a seed file (derived inside an isolated signer process).
 *   export-key enroll --db <sqlite> --origin <origin> --network <network> --key-file <file>
 *       Prove possession and enroll the key for <origin>; an older ACTIVE key becomes RETIRED.
 *       (The API also enrolls DOCKSIDE_AUDIT_EXPORT_KEY_FILE at startup.)
 *   export-key list --db <sqlite> --origin <origin>
 *       Print the published key list: the trust anchor auditors pass to verify-export.
 *   export-key revoke --db <sqlite> --key-id <aek_...> --reason <CODE>
 *       Revoke a key after compromise: no signature made with it verifies against the new list.
 *
 * Exit codes: 0 success, 1 refused, 2 usage error.
 */
import { randomBytes } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";
import { IsolatedSigner } from "@dockside/authority";
import { publicKeyOf, privateKeyFromSeed, randomIds, systemClock } from "@dockside/core";
import { Database } from "@dockside/store";
import { enrollExportKey, exportKeyList, revokeExportKey } from "../export-signing.js";

function args(argv: string[]): { cmd: string | undefined; opts: Record<string, string> } {
  const [cmd, ...rest] = argv;
  const opts: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? "";
    if (!a.startsWith("--")) throw new UsageError(`unexpected argument ${a}`);
    const v = rest[i + 1];
    if (v === undefined || v.startsWith("--")) throw new UsageError(`${a} needs a value`);
    opts[a.slice(2)] = v;
    i++;
  }
  return { cmd, opts };
}

class UsageError extends Error {}

function need(opts: Record<string, string>, name: string): string {
  const v = opts[name];
  if (v === undefined) throw new UsageError(`--${name} is required`);
  return v;
}

const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);

async function signerFor(file: string): Promise<IsolatedSigner> {
  return IsolatedSigner.spawn({
    allowedPurposes: ["AUDIT_EXPORT_KEY_ENROLLMENT", "AUDIT_EXPORT"],
    seedFile: file,
  });
}

async function main(): Promise<number> {
  const { cmd, opts } = args(process.argv.slice(2));
  switch (cmd) {
    case "generate": {
      const file = need(opts, "out");
      const seed = randomBytes(32);
      // Exclusive create: an existing key file is never overwritten.
      const fd = openSync(file, "wx", 0o600);
      try {
        writeSync(fd, `${seed.toString("hex")}\n`);
      } finally {
        closeSync(fd);
      }
      const publicKey = publicKeyOf(privateKeyFromSeed(new Uint8Array(seed)));
      seed.fill(0);
      out({ publicKey, keyFile: file, note: "keep this file outside any repository; it is the signing key" });
      return 0;
    }
    case "show": {
      const s = await signerFor(need(opts, "key-file"));
      out({ publicKey: s.publicKey });
      s.close();
      return 0;
    }
    case "enroll": {
      const db = Database.open(need(opts, "db"));
      db.migrate();
      const s = await signerFor(need(opts, "key-file"));
      try {
        const k = await enrollExportKey(
          {
            db,
            clock: systemClock,
            ids: randomIds,
            origin: need(opts, "origin"),
            network: need(opts, "network"),
          },
          { publicKey: s.publicKey, custodyKind: "ISOLATED_SIGNER_PROCESS", sign: (p, v) => s.sign(p, v) },
        );
        out(k);
      } finally {
        s.close();
        db.close();
      }
      return 0;
    }
    case "list": {
      const db = Database.open(need(opts, "db"));
      try {
        out(exportKeyList(db, need(opts, "origin")));
      } finally {
        db.close();
      }
      return 0;
    }
    case "revoke": {
      const db = Database.open(need(opts, "db"));
      try {
        const k = revokeExportKey(
          { db, clock: systemClock, ids: randomIds, origin: "", network: "" },
          need(opts, "key-id"),
          need(opts, "reason"),
        );
        out(k);
      } finally {
        db.close();
      }
      return 0;
    }
    default:
      throw new UsageError("usage: export-key generate|show|enroll|list|revoke [options]");
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    const usage = e instanceof UsageError;
    const code = (e as { code?: string }).code;
    process.stderr.write(`export-key: ${usage ? "" : code ? `${code}: ` : ""}${(e as Error).message}\n`);
    process.exit(usage ? 2 : 1);
  },
);
