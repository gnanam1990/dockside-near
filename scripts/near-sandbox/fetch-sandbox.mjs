// Runs INSIDE the M17 sandbox container (node:22-trixie-slim, which has no curl): downloads the
// nearcore sandbox 2.13.4 archive from NEAR's release bucket, the location the near-sandbox npm
// package would fetch it from at run time, and refuses it unless its SHA-256 equals the pin below
// (ADR-0021). launch.mjs then runs with NEAR_SANDBOX_BIN_PATH pointing at the verified binary, so
// the npm package never downloads anything itself.
//
// usage: node fetch-sandbox.mjs <destDir> [--archive <already downloaded .tar.gz>]
// Prints the path of the verified binary (<destDir>/near-sandbox).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The version the near-sandbox 0.3.4 npm package defaults to (ADR-0018).
export const NEAR_SANDBOX_VERSION = "2.13.4";
export const NEAR_SANDBOX_SHA256 = "5690a4635172263cf026683f75965cac09dd916912584f12709974fed620163f";
const URL_ = `https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Linux-x86_64/${NEAR_SANDBOX_VERSION}/near-sandbox.tar.gz`;

const args = process.argv.slice(2);
const dest = args[0];
if (!dest || dest.startsWith("--")) {
  process.stderr.write("usage: node fetch-sandbox.mjs <destDir> [--archive <file>]\n");
  process.exit(2);
}
const ai = args.indexOf("--archive");
const archivePath = ai >= 0 ? args[ai + 1] : undefined;

let archive;
if (archivePath) {
  archive = readFileSync(archivePath);
} else {
  const res = await fetch(URL_);
  if (!res.ok) {
    process.stderr.write(`fetch-sandbox: ${URL_} answered ${res.status}\n`);
    process.exit(1);
  }
  archive = Buffer.from(await res.arrayBuffer());
}
const have = createHash("sha256").update(archive).digest("hex");
if (have !== NEAR_SANDBOX_SHA256) {
  process.stderr.write(
    `fetch-sandbox: near-sandbox ${NEAR_SANDBOX_VERSION} archive ${have} does not match its pinned SHA-256 ${NEAR_SANDBOX_SHA256}; refusing it\n`,
  );
  process.exit(1);
}
const work = mkdtempSync(join(tmpdir(), "near-sandbox-"));
try {
  const file = join(work, "near-sandbox.tar.gz");
  writeFileSync(file, archive);
  execFileSync("tar", ["xzf", file, "-C", work]);
  const out = resolve(dest);
  mkdirSync(out, { recursive: true });
  renameSync(join(work, "Linux-x86_64", "near-sandbox"), join(out, "near-sandbox"));
  chmodSync(join(out, "near-sandbox"), 0o755);
  process.stdout.write(`${join(out, "near-sandbox")}\n`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
