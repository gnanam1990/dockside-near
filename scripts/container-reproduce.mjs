// `pnpm run contract:reproduce`: run scripts/container-reproduce.sh in node:22-bookworm-slim
// (ADR-0015; pinned by digest, IMAGES in scripts/lib/docker.mjs). It clones this repository at <ref> inside the container, runs the clean-checkout
// reproduction (frozen install, full check, contract host tests, `pnpm audit --prod`, build
// manifest; with --e2e also the browser suites) and exports the deployable wasm.
//
// Options: --ref <commit> (default HEAD), --out <dir> (default .data/repro), --e2e.
// Writes <out>/clean-checkout-report.json, <out>/build-manifest.json and <out>/dockside_escrow.wasm,
// the inputs of `pnpm run contract:sandbox` and scripts/testnet-deploy/run-all.
// DOCKSIDE_DOCKER overrides the docker command (scripts/lib/docker.mjs).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dockerCommand, gitCommonDir, hostPath, IMAGES } from "./lib/docker.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const ref = opt("ref", execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim());
if (!/^[0-9a-f]{7,40}$/.test(ref)) {
  console.error(`contract:reproduce: --ref must be a commit id, not ${ref}`);
  process.exit(2);
}
const out = resolve(ROOT, opt("out", ".data/repro"));
mkdirSync(out, { recursive: true });
const docker = dockerCommand();

const run = [
  ...docker.slice(1),
  "run",
  "--rm",
  "--name",
  `dockside-repro-${process.pid}`,
  "-v",
  `${hostPath(ROOT, docker)}:/repo:ro`,
  "-v",
  `${hostPath(gitCommonDir(ROOT), docker)}:/gitdir:ro`,
  "-v",
  `${hostPath(out, docker)}:/out`,
  // No cargo/rustup volume: the toolchain is installed fresh in this --rm container (m29).
  "-e",
  "CARGO_HOME=/root/.cargo",
  "-e",
  "RUSTUP_HOME=/root/.rustup",
  IMAGES.bookworm,
  "sh",
  "/repo/scripts/container-reproduce.sh",
  ref,
  ...(args.includes("--e2e") ? ["--e2e"] : []),
];
const r = spawnSync(docker[0], run, { stdio: "inherit", env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
if (r.error) {
  console.error(`contract:reproduce: cannot run ${docker[0]}: ${r.error.message}`);
  process.exit(2);
}
process.exit(r.status ?? 1);
