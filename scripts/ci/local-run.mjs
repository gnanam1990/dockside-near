// Replays a job of the GitHub Actions workflow on this machine (ADR-0020).
//
// Usage:
//   node scripts/ci/local-run.mjs --list                       every job, step and command; runs nothing
//   node scripts/ci/local-run.mjs --job <id> [--dry-run]       run (or only print) that job's run steps
//        [--with-setup] [--from <step number>] [--report <file.json>] [--workflow <file.yml>]
//
// The workflow is checked with scripts/ci/workflow-policy.mjs first; any violation stops the run
// (exit 2). `uses:` steps (checkout, setup-node, upload-artifact) are provided by the runner and
// are skipped here: the local checkout, Node and the reports in .data/ stand in for them. Steps
// whose id starts with `setup-` provision a fresh runner (corepack, the Rust toolchain); they are
// skipped unless --with-setup is given, because on a developer machine they would change the
// installed tools. Every other step runs in order with `bash -eo pipefail` and the workflow's,
// job's and step's env, from the repository root, and the run stops at the first failure, as on
// GitHub. Port variables (DOCKSIDE_E2E_*_PORT, DOCKSIDE_NEAR_SANDBOX_PORT) and DOCKSIDE_DOCKER pass
// through from the calling environment.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { checkWorkflow, DEFAULT_WORKFLOW, jobRunners, ROOT } from "./workflow-policy.mjs";

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const die = (msg) => {
  process.stderr.write(`local-run: ${msg}\n`);
  process.exit(2);
};

const file = resolve(opt("workflow") ?? DEFAULT_WORKFLOW);
if (!existsSync(file)) die(`${file} does not exist`);
const text = readFileSync(file, "utf8");
const violations = checkWorkflow(text);
if (violations.length > 0) {
  die(`the workflow breaks the policy:\n${violations.map((v) => `  ${v.rule}: ${v.detail}`).join("\n")}`);
}
const wf = parse(text);
const jobs = wf.jobs ?? {};

function describeStep(step, i) {
  const label = `  [${i + 1}] ${step.name ?? step.id ?? "(unnamed)"}`;
  if (step.uses) return [`${label}: uses ${step.uses} (provided by the runner; skipped locally)`];
  const setup = String(step.id ?? "").startsWith("setup-")
    ? " (runner setup; local only with --with-setup)"
    : "";
  return [
    `${label}${setup}`,
    ...String(step.run ?? "")
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => `      $ ${l}`),
  ];
}

if (flag("list")) {
  for (const [id, job] of Object.entries(jobs)) {
    process.stdout.write(
      `job ${id} (${job.name ?? id}) on ${jobRunners(job).join(", ")}, timeout ${job["timeout-minutes"]} min\n`,
    );
    for (const [i, step] of (job.steps ?? []).entries())
      process.stdout.write(`${describeStep(step, i).join("\n")}\n`);
  }
  process.exit(0);
}

const jobId = opt("job");
if (!jobId) die("give --list or --job <id>");
const job = jobs[jobId];
if (!job) die(`unknown job ${jobId}; the workflow has ${Object.keys(jobs).join(", ")}`);

/** Git for Windows' bash on Windows (never the WSL launcher in System32); bash elsewhere. */
function bash() {
  if (process.env.DOCKSIDE_CI_BASH) return process.env.DOCKSIDE_CI_BASH;
  if (process.platform !== "win32") return "bash";
  const exec = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
  for (const rel of ["../../../bin/bash.exe", "../../../usr/bin/bash.exe", "../../bin/bash.exe"]) {
    const p = resolve(exec, rel);
    if (existsSync(p)) return p;
  }
  die("Git for Windows bash not found; set DOCKSIDE_CI_BASH");
}

const redact = (s) =>
  s.split(ROOT).join("<worktree>").split(tmpdir()).join("<tmp>").split(homedir()).join("<home>");

const from = Number(opt("from") ?? 1);
const records = [];
let exit = 0;
for (const [i, step] of (job.steps ?? []).entries()) {
  const n = i + 1;
  const name = step.name ?? step.id ?? `step ${n}`;
  const base = { step: n, name };
  if (n < from) {
    records.push({ ...base, result: "SKIPPED", reason: "before --from" });
    continue;
  }
  if (step.uses) {
    process.stdout.write(`\n=== [${n}] ${name}: uses ${step.uses} (skipped locally)\n`);
    records.push({ ...base, uses: step.uses, result: "SKIPPED", reason: "provided by the runner" });
    continue;
  }
  if (String(step.id ?? "").startsWith("setup-") && !flag("with-setup")) {
    process.stdout.write(`\n=== [${n}] ${name}: runner setup (skipped; --with-setup runs it)\n${step.run}`);
    records.push({ ...base, command: step.run.trim(), result: "SKIPPED", reason: "runner setup" });
    continue;
  }
  if (step.if !== undefined) {
    records.push({ ...base, result: "SKIPPED", reason: `condition ${step.if}` });
    continue;
  }
  process.stdout.write(`\n=== [${n}] ${name}\n${step.run}\n`);
  if (flag("dry-run")) {
    records.push({ ...base, command: step.run.trim(), result: "DRY_RUN" });
    continue;
  }
  const started = Date.now();
  const env = { ...process.env, ...(wf.env ?? {}), ...(job.env ?? {}), ...(step.env ?? {}) };
  for (const [k, v] of Object.entries(env)) env[k] = String(v);
  const r = spawnSync(bash(), ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run], {
    cwd: step["working-directory"] ? join(ROOT, step["working-directory"]) : ROOT,
    env,
    stdio: "inherit",
  });
  const code = r.status ?? 1;
  records.push({ ...base, command: step.run.trim(), exitCode: code, ms: Date.now() - started });
  process.stdout.write(`=== [${n}] exit ${code} in ${Math.round((Date.now() - started) / 1000)} s\n`);
  if (code !== 0) {
    exit = code;
    break;
  }
}

const report = opt("report");
if (report) {
  const out = {
    schema: "dockside/local-ci-run@1",
    workflow: redact(file).split("\\").join("/"),
    job: jobId,
    host: `${process.platform}-${process.arch}`,
    node: process.version,
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
    steps: records.map((r) => (r.command ? { ...r, command: redact(r.command) } : r)),
    result: flag("dry-run") ? "DRY_RUN" : exit === 0 ? "PASS" : "FAIL",
  };
  writeFileSync(resolve(report), `${JSON.stringify(out, null, 2)}\n`);
  process.stdout.write(`local-run: report written to ${redact(resolve(report))}\n`);
}
process.stdout.write(
  `local-run: job ${jobId} ${flag("dry-run") ? "DRY_RUN" : exit === 0 ? "PASS" : `FAIL (exit ${exit})`}\n`,
);
process.exit(exit);
