#!/usr/bin/env node
/**
 * Custody tool for the ManifestAttestor and deterministic-policy service keys (M43). Each key is an
 * Ed25519 seed file the worker reads only inside an isolated signer child process
 * (`DOCKSIDE_MANIFEST_ATTESTOR_KEY_FILE`, `DOCKSIDE_POLICY_SERVICE_KEY_FILE`). The organisation's
 * security administrator enrols the public key under Organization → Service identities and hands
 * the proof-of-possession challenge the browser shows to this tool, which signs it inside the same
 * kind of isolated signer and prints only the signature.
 *
 *   service-key generate --capability MANIFEST_ATTEST|DETERMINISTIC_POLICY_SET --out <file>
 *       New seed file (created exclusively, owner-only). Prints the public key; never the seed.
 *   service-key show --capability <capability> --key-file <file>
 *       Print the public key of a seed file.
 *   service-key sign-challenge --capability <capability> --key-file <file> --challenge-file <file>
 *       <file> holds the "Challenge for the custody operator" JSON from the web app
 *       ({"challenge":{"payload":...,"digestHex":...}}). The digest is recomputed from the payload,
 *       the payload must name this key, and only then is SERVICE_POP_CHALLENGE signed.
 *
 * Exit codes: 0 success, 1 refused, 2 usage error.
 */
import { randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { IsolatedSigner } from "@dockside/authority";
import {
  type CanonicalValue,
  digestHexFor,
  fail,
  fromTypedJson,
  privateKeyFromSeed,
  publicKeyOf,
  type TypedJson,
} from "@dockside/core";

class UsageError extends Error {}

const PURPOSE = { MANIFEST_ATTEST: "MANIFEST_ATTESTATION", DETERMINISTIC_POLICY_SET: "HOLD_SET" } as const;
type ServiceCapability = keyof typeof PURPOSE;

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

function need(opts: Record<string, string>, name: string): string {
  const v = opts[name];
  if (v === undefined) throw new UsageError(`--${name} is required`);
  return v;
}

function capabilityOf(opts: Record<string, string>): ServiceCapability {
  const c = need(opts, "capability");
  if (c !== "MANIFEST_ATTEST" && c !== "DETERMINISTIC_POLICY_SET")
    throw new UsageError("--capability must be MANIFEST_ATTEST or DETERMINISTIC_POLICY_SET");
  return c;
}

const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);

function signerFor(file: string, capability: ServiceCapability): Promise<IsolatedSigner> {
  return IsolatedSigner.spawn({
    allowedPurposes: ["SERVICE_POP_CHALLENGE", PURPOSE[capability]],
    seedFile: file,
  });
}

async function main(): Promise<number> {
  const { cmd, opts } = args(process.argv.slice(2));
  switch (cmd) {
    case "generate": {
      const capability = capabilityOf(opts);
      const file = need(opts, "out");
      const seed = randomBytes(32);
      const fd = openSync(file, "wx", 0o600);
      try {
        writeSync(fd, `${seed.toString("hex")}\n`);
      } finally {
        closeSync(fd);
      }
      const publicKey = publicKeyOf(privateKeyFromSeed(new Uint8Array(seed)));
      seed.fill(0);
      out({
        publicKey,
        capability,
        custodyKind: "ISOLATED_SIGNER_PROCESS",
        keyFile: file,
        note: "keep this file outside any repository; enrol the public key under Organization -> Service identities",
      });
      return 0;
    }
    case "show": {
      const s = await signerFor(need(opts, "key-file"), capabilityOf(opts));
      out({ publicKey: s.publicKey });
      s.close();
      return 0;
    }
    case "sign-challenge": {
      const capability = capabilityOf(opts);
      let doc: { challenge?: { payload?: TypedJson; digestHex?: string } };
      try {
        doc = JSON.parse(readFileSync(need(opts, "challenge-file"), "utf8"));
      } catch (e) {
        if (e instanceof UsageError) throw e;
        fail("VALIDATION_FAILED", "the challenge file is not the JSON the web app shows");
      }
      const ch = doc.challenge;
      if (!ch || typeof ch.digestHex !== "string" || ch.payload === undefined)
        fail(
          "VALIDATION_FAILED",
          'the challenge file must hold {"challenge":{"payload":...,"digestHex":...}}',
        );
      const payload = fromTypedJson(ch.payload) as Record<string, CanonicalValue>;
      // Never sign a digest handed in: recompute it from the typed payload first.
      if (digestHexFor("SERVICE_POP_CHALLENGE", payload as CanonicalValue) !== ch.digestHex)
        fail("DIGEST_MISMATCH", "the digest does not match the challenge payload");
      if (payload["capability"] !== undefined && payload["capability"] !== capability)
        fail("SCOPE_MISMATCH", "the challenge is for another service capability");
      const s = await signerFor(need(opts, "key-file"), capability);
      try {
        if (payload["publicKey"] !== s.publicKey)
          fail("KEY_NOT_BOUND", "the challenge names another public key than this key file's");
        out({ signature: await s.sign("SERVICE_POP_CHALLENGE", payload as never) });
      } finally {
        s.close();
      }
      return 0;
    }
    default:
      throw new UsageError("usage: service-key generate|show|sign-challenge [options]");
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    const usage = e instanceof UsageError;
    const code = (e as { code?: string }).code;
    process.stderr.write(`service-key: ${usage ? "" : code ? `${code}: ` : ""}${(e as Error).message}\n`);
    process.exit(usage ? 2 : 1);
  },
);
