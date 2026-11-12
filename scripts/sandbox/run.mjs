// `pnpm run contract:sandbox`: run scripts/sandbox/container-sandbox.sh in node:22-trixie-slim.
//
// Needs Docker and the deployable wasm with its manifest from scripts/container-reproduce.sh in
// .data/repro (USER-NEXT-STEPS §1). Writes .data/sandbox/sandbox-report.json and the test logs.
//
// Options: --ref <commit> (default HEAD), --repro <dir> (default .data/repro), --out <dir>
// (default .data/sandbox). DOCKSIDE_DOCKER overrides the docker command, for example
// "wsl.exe -d Ubuntu-24.04 -u root -- docker" on a Windows host whose Docker Engine runs in WSL;
// host paths are then translated to /mnt/<drive>/... for the Linux side.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8" }).trim();

const docker = (process.env.DOCKSIDE_DOCKER || "docker").split(" ").filter(Boolean);
const viaWsl = /(^|[\\/])wsl(\.exe)?$/i.test(docker[0] ?? "");
const hostPath = (p) => {
  const abs = resolve(p);
  if (!viaWsl) return abs;
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(abs);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].split("\\").join("/")}` : abs.split("\\").join("/");
};

const ref = opt("ref", git("rev-parse", "HEAD"));
const repro = resolve(ROOT, opt("repro", ".data/repro"));
const out = resolve(ROOT, opt("out", ".data/sandbox"));
for (const f of ["dockside_escrow.wasm", "build-manifest.json"]) {
  if (!existsSync(join(repro, f))) {
    console.error(
      `contract:sandbox: ${join(repro, f)} is missing; build it with scripts/container-reproduce.sh first (USER-NEXT-STEPS §1)`,
    );
    process.exit(2);
  }
}
mkdirSync(out, { recursive: true });
// A worktree's .git is a file; clone from the shared git directory instead.
let gitDir = git("rev-parse", "--git-common-dir");
if (!isAbsolute(gitDir)) gitDir = resolve(ROOT, gitDir);

const run = [
  ...docker.slice(1),
  "run",
  "--rm",
  "--name",
  `dockside-sandbox-${process.pid}`,
  "-v",
  `${hostPath(ROOT)}:/repo:ro`,
  "-v",
  `${hostPath(gitDir)}:/gitdir:ro`,
  "-v",
  `${hostPath(repro)}:/repro:ro`,
  "-v",
  `${hostPath(out)}:/out`,
  "-v",
  "dockside-cargo:/root/.cargo",
  "-v",
  "dockside-rustup:/root/.rustup",
  "-e",
  "CARGO_HOME=/root/.cargo",
  "-e",
  "RUSTUP_HOME=/root/.rustup",
  "node:22-trixie-slim",
  "sh",
  "/repo/scripts/sandbox/container-sandbox.sh",
  ref,
];
const r = spawnSync(docker[0], run, { stdio: "inherit" });
if (r.error) {
  console.error(`contract:sandbox: cannot run ${docker[0]}: ${r.error.message}`);
  process.exit(2);
}
process.exit(r.status ?? 1);
