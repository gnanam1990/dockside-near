// Policy check of the GitHub Actions workflow (ADR-0020). Run by `pnpm run check` through
// packages/core/test/m18-ci-workflow.test.ts and by scripts/ci/local-run.mjs before it replays
// anything.
//
// Usage: node scripts/ci/workflow-policy.mjs [workflow.yml]   (default .github/workflows/ci.yml)
// Prints {"file", "violations": [{"rule", "detail"}]} as JSON. Exit 0 when there is no violation,
// 1 when there is at least one, 2 when the file cannot be read.
//
// Rules: TRIGGERS (push to main and pull_request only), PERMISSIONS (contents: read, nothing
// wider at job level), CONCURRENCY (per-ref group, cancel-in-progress), NO_SECRETS, EXPRESSIONS
// (only matrix.os, github.workflow and github.ref), RUN_EXPRESSIONS (no ${{ }} inside a run
// script), PINNED_ACTIONS (owner/repo@<40-hex SHA> # vX.Y.Z), CHECKOUT_CREDENTIALS
// (persist-credentials: false), TIMEOUTS (1 to 60 minutes per job), RUNNERS (ubuntu-24.04 and
// windows-2022 only, both present), SHELL (bash), REQUIRED_COMMANDS, PACKAGE_SCRIPTS (every
// `pnpm run <name>` exists), TOOLCHAIN (no RUSTUP_TOOLCHAIN in any env: the setup step selects the
// toolchain with `rustup default`, so a local replay keeps the developer's own toolchain).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_WORKFLOW = join(ROOT, ".github/workflows/ci.yml");
export const ALLOWED_RUNNERS = ["ubuntu-24.04", "windows-2022"];
const ALLOWED_EXPRESSIONS = new Set(["matrix.os", "github.workflow", "github.ref"]);
const MAX_TIMEOUT_MINUTES = 60;

/** Commands each job must run, in this order (one line of a run script each). */
export const REQUIRED = {
  test: [
    /^rustup toolchain install 1\.97\.1 .*--target wasm32-unknown-unknown/,
    "rustup default 1.97.1",
    "pnpm install --frozen-lockfile",
    "pnpm run check",
    "pnpm run contract:test",
    "pnpm --filter @dockside/web exec playwright install --with-deps chromium",
    "pnpm run web:e2e",
  ],
  chain: [
    "pnpm install --frozen-lockfile",
    "pnpm run contract:reproduce",
    "pnpm run contract:sandbox",
    "pnpm run test:sandbox",
  ],
};

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Every run-script line of a job, trimmed, without blanks and comments. */
export function runLines(job) {
  return (job?.steps ?? [])
    .flatMap((s) => (typeof s?.run === "string" ? s.run.split(/\r?\n/) : []))
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

/** The runner images a job resolves to (a `${{ matrix.os }}` runs-on expands to the matrix). */
export function jobRunners(job) {
  const r = job?.["runs-on"];
  if (typeof r !== "string") return [];
  if (/^\$\{\{\s*matrix\.os\s*\}\}$/.test(r.trim())) {
    const os = job?.strategy?.matrix?.os;
    return Array.isArray(os) ? os.map(String) : [];
  }
  return [r];
}

function scripts(pkg) {
  try {
    return JSON.parse(readFileSync(join(ROOT, pkg), "utf8")).scripts ?? {};
  } catch {
    return {};
  }
}

export function checkWorkflow(text) {
  const violations = [];
  const fail = (rule, detail) => violations.push({ rule, detail });
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length > 0) {
    for (const e of doc.errors) fail("YAML", e.message);
    return violations;
  }
  const wf = doc.toJS();
  if (!isObj(wf)) {
    fail("YAML", "the workflow is not a mapping");
    return violations;
  }

  // TRIGGERS
  const on = wf.on;
  const triggers = isObj(on) ? Object.keys(on).sort() : [];
  if (triggers.join(",") !== "pull_request,push") {
    fail("TRIGGERS", `expected exactly push and pull_request, found ${JSON.stringify(on)}`);
  }
  const branches = isObj(on) && isObj(on.push) ? on.push.branches : undefined;
  if (!Array.isArray(branches) || branches.length !== 1 || branches[0] !== "main") {
    fail("TRIGGERS", "push must be limited to branches: [main]");
  }
  if (isObj(on) && on.pull_request !== null && on.pull_request !== undefined) {
    const keys = isObj(on.pull_request) ? Object.keys(on.pull_request) : ["?"];
    if (keys.some((k) => k !== "branches"))
      fail("TRIGGERS", "pull_request takes no options besides branches");
  }

  // PERMISSIONS
  const perms = wf.permissions;
  if (!isObj(perms) || Object.keys(perms).length !== 1 || perms.contents !== "read") {
    fail(
      "PERMISSIONS",
      `workflow permissions must be exactly {contents: read}, found ${JSON.stringify(perms)}`,
    );
  }

  // CONCURRENCY
  const conc = wf.concurrency;
  if (!isObj(conc) || typeof conc.group !== "string" || !conc.group.includes("github.ref")) {
    fail("CONCURRENCY", "concurrency.group must be set per ref");
  }
  if (!isObj(conc) || conc["cancel-in-progress"] !== true)
    fail("CONCURRENCY", "cancel-in-progress must be true");

  // SHELL
  if (wf.defaults?.run?.shell !== "bash") fail("SHELL", "defaults.run.shell must be bash");

  // NO_SECRETS and EXPRESSIONS (anywhere in the file, comments excluded by the parser's view)
  const expressions = [];
  const walk = (v, path) => {
    if (typeof v === "string") {
      for (const m of v.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) expressions.push({ expr: m[1].trim(), path });
    } else if (Array.isArray(v)) {
      for (const [i, x] of v.entries()) walk(x, `${path}[${i}]`);
    } else if (isObj(v)) {
      for (const [k, x] of Object.entries(v)) {
        if (k === "secrets") fail("NO_SECRETS", `${path}.${k} is not allowed`);
        if (k === "RUSTUP_TOOLCHAIN")
          fail("TOOLCHAIN", `${path}.${k}: select the toolchain with rustup default`);
        walk(x, `${path}.${k}`);
      }
    }
  };
  walk(wf, "$");
  for (const { expr, path } of expressions) {
    if (/\bsecrets\b|github\.token|GITHUB_TOKEN/.test(expr)) fail("NO_SECRETS", `${path}: \${{ ${expr} }}`);
    else if (!ALLOWED_EXPRESSIONS.has(expr)) fail("EXPRESSIONS", `${path}: \${{ ${expr} }} is not allowed`);
  }
  if (/GITHUB_TOKEN/.test(text)) fail("NO_SECRETS", "GITHUB_TOKEN is referenced");

  // PINNED_ACTIONS: the raw lines carry the version comments.
  const usesLines = text.split(/\r?\n/).filter((l) => /^\s*(-\s+)?uses:/.test(l));
  for (const line of usesLines) {
    const m = /^\s*(?:-\s+)?uses:\s*([^\s#]+)\s*(#.*)?$/.exec(line);
    const ref = m?.[1] ?? "";
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/.test(ref)) {
      fail("PINNED_ACTIONS", `${ref || line.trim()} is not pinned to a full commit SHA`);
    }
    if (!/^#\s*v\d+(\.\d+){0,2}\s*$/.test(m?.[2] ?? "")) {
      fail("PINNED_ACTIONS", `${ref || line.trim()} has no "# vX.Y.Z" version comment`);
    }
  }

  // Jobs
  const jobs = isObj(wf.jobs) ? wf.jobs : {};
  if (Object.keys(jobs).length === 0) fail("REQUIRED_COMMANDS", "the workflow has no jobs");
  const runners = new Set();
  const rootScripts = scripts("package.json");
  const webScripts = scripts("apps/web/package.json");
  for (const [id, job] of Object.entries(jobs)) {
    if (!isObj(job)) continue;
    if (job.uses) fail("PINNED_ACTIONS", `job ${id} calls a reusable workflow`);
    if (job.permissions !== undefined) {
      const p = job.permissions;
      const readOnly = isObj(p) && Object.entries(p).every(([k, v]) => k === "contents" && v === "read");
      if (!readOnly) fail("PERMISSIONS", `job ${id} widens permissions: ${JSON.stringify(p)}`);
    }
    const t = job["timeout-minutes"];
    if (!Number.isInteger(t) || t < 1 || t > MAX_TIMEOUT_MINUTES) {
      fail("TIMEOUTS", `job ${id} needs timeout-minutes between 1 and ${MAX_TIMEOUT_MINUTES} (found ${t})`);
    }
    const rs = jobRunners(job);
    if (rs.length === 0) fail("RUNNERS", `job ${id} has no resolvable runs-on`);
    for (const r of rs) {
      if (!ALLOWED_RUNNERS.includes(r))
        fail("RUNNERS", `job ${id} runs on ${r}; allowed: ${ALLOWED_RUNNERS}`);
      runners.add(r);
    }
    for (const [i, step] of (job.steps ?? []).entries()) {
      if (typeof step?.run === "string" && step.run.includes("${{")) {
        fail("RUN_EXPRESSIONS", `job ${id} step ${i + 1} interpolates an expression into its script`);
      }
      if (step?.shell !== undefined && step.shell !== "bash")
        fail("SHELL", `job ${id} step ${i + 1} uses ${step.shell}`);
      if (typeof step?.uses === "string" && step.uses.startsWith("actions/checkout@")) {
        if (step.with?.["persist-credentials"] !== false) {
          fail("CHECKOUT_CREDENTIALS", `job ${id} checks out with persisted credentials`);
        }
      }
    }
    const lines = runLines(job);
    for (const line of lines) {
      const m = /^pnpm run ([\w:.-]+)/.exec(line);
      if (m && !(m[1] in rootScripts))
        fail("PACKAGE_SCRIPTS", `job ${id}: package.json has no script ${m[1]}`);
      const w = /^pnpm --filter @dockside\/web run ([\w:.-]+)/.exec(line);
      if (w && !(w[1] in webScripts)) fail("PACKAGE_SCRIPTS", `job ${id}: apps/web has no script ${w[1]}`);
    }
  }
  for (const r of ALLOWED_RUNNERS) {
    if (!runners.has(r)) fail("RUNNERS", `no job runs on ${r}`);
  }
  for (const [id, want] of Object.entries(REQUIRED)) {
    const lines = runLines(jobs[id]);
    let at = 0;
    for (const cmd of want) {
      const found = lines.findIndex((l, i) => i >= at && (typeof cmd === "string" ? l === cmd : cmd.test(l)));
      if (found < 0) {
        fail("REQUIRED_COMMANDS", `job ${id} must run ${String(cmd)} (after the previous required command)`);
      } else {
        at = found + 1;
      }
    }
  }
  if (!jobRunners(jobs.chain).every((r) => r.startsWith("ubuntu-"))) {
    fail("RUNNERS", "the chain job needs a Linux runner (Docker)");
  }
  return violations;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = resolve(process.argv[2] ?? DEFAULT_WORKFLOW);
  if (!existsSync(file)) {
    process.stderr.write(`workflow-policy: ${file} does not exist\n`);
    process.exit(2);
  }
  const violations = checkWorkflow(readFileSync(file, "utf8"));
  process.stdout.write(
    `${JSON.stringify(
      {
        file: file.startsWith(ROOT)
          ? file
              .slice(ROOT.length + 1)
              .split("\\")
              .join("/")
          : "<file>",
        violations,
      },
      null,
      2,
    )}\n`,
  );
  process.exit(violations.length === 0 ? 0 : 1);
}
