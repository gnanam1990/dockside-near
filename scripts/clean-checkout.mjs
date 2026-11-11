// Clean-checkout reproduction (T-043, local part). Clones the committed repository into a fresh
// temporary directory (no node_modules, no dist, no contract/target), installs from the lockfiles,
// builds, runs the whole check suite and the contract host tests, writes the build manifest of the
// fresh build and compares the wasm digest with the source checkout's build when one exists.
//
// Usage: node scripts/clean-checkout.mjs [--ref <commit>] [--e2e] [--keep] [--report <file.json>]
//   --ref     commit or branch to reproduce (default HEAD of this checkout)
//   --e2e     also build the web app and run the Playwright browser suite
//   --keep    keep the temporary clone for inspection
//   --report  write the step log (commands, exit codes, durations, summaries) as JSON
// Nothing here touches the network beyond the package registries used by pnpm and cargo.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = join(dirname(fileURLToPath(import.meta.url)), "..");
const WASM = "contract/target/wasm32-unknown-unknown/release/dockside_escrow.wasm";
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};

const steps = [];
const redact = (s) => s.split(SOURCE).join("<source>");

function step(name, cmd, cwd, { allowFail = false } = {}) {
  const started = Date.now();
  process.stdout.write(`\n=== ${name}: ${cmd}\n`);
  const r = spawnSync(cmd, { cwd, shell: true, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const tail = out.split(/\r?\n/).filter((l) => l.trim() && !/ExperimentalWarning|trace-warnings/.test(l));
  const summary = tail.filter((l) =>
    /Test Files|Tests |test result:|files clean|passed|failed|sha256|build manifest|Checked \d+ files/.test(
      l,
    ),
  );
  const rec = {
    name,
    command: cmd,
    exitCode: r.status,
    ms: Date.now() - started,
    summary: summary.slice(-12).map((l) => redact(l.trim())),
  };
  steps.push(rec);
  process.stdout.write(`${rec.summary.join("\n")}\nexit ${r.status} in ${Math.round(rec.ms / 1000)}s\n`);
  if (r.status !== 0 && !allowFail) {
    process.stdout.write(tail.slice(-40).map(redact).join("\n"));
    finish(1);
  }
  return { status: r.status, out };
}

let dir = "";
function finish(code) {
  const report = {
    schema: "dockside/clean-checkout@1",
    ref,
    commit,
    startedAt,
    finishedAt: new Date().toISOString(),
    result: code === 0 ? "PASS" : "FAIL",
    wasm: wasmComparison,
    steps,
    notRun: [
      "NEAR testnet deployment, funding and the direct native release (BLOCKED: needs testnet accounts and signing)",
      "independent human principals on separate devices (INV-13 acceptance: NOT_RUN)",
    ],
  };
  const reportPath = opt("--report");
  if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (dir && !flag("--keep")) rmSync(dir, { recursive: true, force: true });
  process.stdout.write(
    `\nclean checkout: ${report.result}${dir && flag("--keep") ? ` (kept ${dir})` : ""}\n`,
  );
  process.exit(code);
}

const startedAt = new Date().toISOString();
const ref = opt("--ref") ?? "HEAD";
const commit = spawnSync("git", ["rev-parse", ref], { cwd: SOURCE, encoding: "utf8" }).stdout.trim();
let wasmComparison = null;
if (!/^[0-9a-f]{40}$/.test(commit)) {
  console.error(`cannot resolve ${ref}`);
  process.exit(2);
}
dir = mkdtempSync(join(tmpdir(), "dockside-clean-"));
const repo = join(dir, "dockside");
step("clone", `git clone --quiet --no-local "${SOURCE}" "${repo}"`, dir);
step("checkout", `git -c advice.detachedHead=false checkout --quiet ${commit}`, repo);
step("versions", "node --version && pnpm --version && rustc --version && cargo --version", repo);
step("install", "pnpm install --frozen-lockfile", repo);
step("wasm target", "rustup target list --installed", repo);
step("check", "pnpm run check", repo);
step("contract host tests", "pnpm run contract:test", repo);
step("audit", "pnpm audit --prod", repo, { allowFail: true });
step("build manifest", `node scripts/build-manifest.mjs --out "${join(dir, "build-manifest.json")}"`, repo);
if (flag("--e2e")) step("browser suite", "pnpm run web:e2e", repo);

const fresh = join(repo, WASM);
const local = join(SOURCE, WASM);
if (existsSync(fresh)) {
  const h = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
  wasmComparison = {
    fresh: h(fresh),
    sourceCheckout: existsSync(local) ? h(local) : null,
  };
  wasmComparison.reproducible =
    wasmComparison.sourceCheckout === null
      ? "NOT_COMPARED"
      : wasmComparison.fresh === wasmComparison.sourceCheckout;
  process.stdout.write(
    `\nwasm fresh ${wasmComparison.fresh} source ${wasmComparison.sourceCheckout ?? "absent"}\n`,
  );
}
finish(0);
