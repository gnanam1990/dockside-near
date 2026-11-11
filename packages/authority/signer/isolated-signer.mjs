// Isolated service signer process (ManifestAttestor / deterministic-policy custody).
//
// The Ed25519 private key is generated inside this process (or derived from a seed file
// that only this process reads) and never crosses the process boundary: the parent only
// ever receives the public key and signatures. Each request names a signing purpose; the
// signer computes the DCE-1 digest itself and refuses purposes outside its allowlist.
//
// Usage: node isolated-signer.mjs --allow=SERVICE_POP_CHALLENGE,MANIFEST_ATTESTATION [--seed-file=path]
// Protocol: newline-delimited JSON on stdin/stdout.
//   -> {"id":1,"purpose":"MANIFEST_ATTESTATION","payload":<typed json>}
//   <- {"id":1,"signature":"ed25519:..."} | {"id":1,"error":"..."}
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import {
  fromTypedJson,
  generateEd25519KeyPair,
  privateKeyFromSeed,
  publicKeyOf,
  SIGNING_DOMAINS,
  signFor,
} from "@dockside/core";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=")];
  }),
);
const allowed = new Set((args.allow ?? "").split(",").filter(Boolean));
for (const p of allowed) if (!(p in SIGNING_DOMAINS)) throw new Error(`unknown purpose ${p}`);

let privateKey;
let publicKey;
if (args["seed-file"]) {
  const seed = Buffer.from(readFileSync(args["seed-file"], "utf8").trim(), "hex");
  privateKey = privateKeyFromSeed(new Uint8Array(seed));
  publicKey = publicKeyOf(privateKey);
} else {
  ({ privateKey, publicKey } = generateEd25519KeyPair());
}

process.stdout.write(`${JSON.stringify({ ready: true, publicKey, allowed: [...allowed] })}\n`);

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let id = null;
  try {
    const req = JSON.parse(line);
    id = req.id;
    if (!allowed.has(req.purpose)) throw new Error(`purpose ${req.purpose} not allowed for this signer`);
    const signature = signFor(privateKey, req.purpose, fromTypedJson(req.payload));
    process.stdout.write(`${JSON.stringify({ id, signature })}\n`);
  } catch (e) {
    process.stdout.write(`${JSON.stringify({ id, error: String(e?.message ?? e) })}\n`);
  }
});
rl.on("close", () => process.exit(0));
