/**
 * M18: the GitHub Actions workflow (.github/workflows/ci.yml) is checked by
 * scripts/ci/workflow-policy.mjs, run here as the CI owner would run it: as a separate node
 * process on the real file and on copies with one rule broken each. The same checker gates
 * scripts/ci/local-run.mjs, which replays the workflow's commands on a developer machine.
 * IDs: T-043 (clean setup on every supported host), T-044 (delivery path), T-045 (exact build).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const POLICY = join(ROOT, "scripts/ci/workflow-policy.mjs");
const RUNNER = join(ROOT, "scripts/ci/local-run.mjs");
const WORKFLOW = join(ROOT, ".github/workflows/ci.yml");
const dir = mkdtempSync(join(tmpdir(), "dockside-m18-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Verdict = { violations: { rule: string; detail: string }[] };

function policy(file: string) {
  const r = spawnSync(process.execPath, [POLICY, file], { encoding: "utf8", cwd: ROOT });
  const out = r.stdout.trim();
  return {
    status: r.status,
    verdict: (out ? JSON.parse(out) : { violations: [] }) as Verdict,
    stderr: r.stderr,
  };
}

/** A GitHub Actions expression around `body`, built so no source string holds one. */
const expr = (body: string) => ["$", "{{ ", body, " }}"].join("");

let n = 0;
function variant(edit: (text: string) => string): string {
  const original = readFileSync(WORKFLOW, "utf8");
  const changed = edit(original);
  expect(changed, "the mutation must change the workflow").not.toBe(original);
  const file = join(dir, `ci-${++n}.yml`);
  writeFileSync(file, changed);
  return file;
}

function rules(file: string): string[] {
  const r = policy(file);
  expect(r.status, r.stderr).toBe(1);
  return r.verdict.violations.map((v) => v.rule);
}

describe("M18 CI workflow policy (T-043, T-044, T-045)", () => {
  it("the committed workflow satisfies every rule", () => {
    const r = policy(WORKFLOW);
    expect(r.stderr).toBe("");
    expect(r.verdict.violations).toEqual([]);
    expect(r.status).toBe(0);
  });

  it("refuses privileged or extra triggers", () => {
    expect(rules(variant((t) => t.replace(/^ {2}pull_request:\n/m, "  pull_request_target:\n")))).toContain(
      "TRIGGERS",
    );
    expect(
      rules(variant((t) => t.replace(/^on:\n/m, "on:\n  workflow_run:\n    workflows: [other]\n"))),
    ).toContain("TRIGGERS");
    expect(rules(variant((t) => t.replace("branches: [main]", "branches: ['**']")))).toContain("TRIGGERS");
  });

  it("refuses write permissions at workflow or job level", () => {
    expect(rules(variant((t) => t.replace(/^ {2}contents: read$/m, "  contents: write")))).toContain(
      "PERMISSIONS",
    );
    expect(
      rules(
        variant((t) =>
          t.replace(/^( {4}timeout-minutes: \d+\n)/m, "$1    permissions:\n      pull-requests: write\n"),
        ),
      ),
    ).toContain("PERMISSIONS");
    expect(rules(variant((t) => t.replace(/^permissions:\n {2}contents: read\n/m, "")))).toContain(
      "PERMISSIONS",
    );
  });

  it("refuses an action not pinned to a full commit SHA with its version comment", () => {
    expect(
      rules(variant((t) => t.replace(/actions\/checkout@[0-9a-f]{40} # v[\d.]+/, "actions/checkout@v4"))),
    ).toContain("PINNED_ACTIONS");
    expect(rules(variant((t) => t.replace(/(actions\/setup-node@[0-9a-f]{40}) # v[\d.]+/, "$1")))).toContain(
      "PINNED_ACTIONS",
    );
    expect(
      rules(
        variant((t) =>
          t.replace(
            /actions\/checkout@([0-9a-f]{40})/,
            (_m, s: string) => `actions/checkout@${s.slice(0, 12)}`,
          ),
        ),
      ),
    ).toContain("PINNED_ACTIONS");
  });

  it("refuses secrets, persisted checkout credentials and expressions inside run scripts", () => {
    expect(
      rules(
        variant((t) =>
          t.replace(
            "run: pnpm run check",
            `run: pnpm run check\n        env:\n          T: ${expr("secrets.NPM_TOKEN")}`,
          ),
        ),
      ),
    ).toContain("NO_SECRETS");
    expect(
      rules(variant((t) => t.replace("persist-credentials: false", "persist-credentials: true"))),
    ).toContain("CHECKOUT_CREDENTIALS");
    expect(
      rules(
        variant((t) =>
          t.replace("run: pnpm run check", `run: echo "${expr("github.event.pull_request.title")}"`),
        ),
      ),
    ).toContain("RUN_EXPRESSIONS");
  });

  it("refuses a missing concurrency cancel, a missing or long timeout and a floating runner image", () => {
    expect(
      rules(variant((t) => t.replace("cancel-in-progress: true", "cancel-in-progress: false"))),
    ).toContain("CONCURRENCY");
    expect(rules(variant((t) => t.replace(/^( {4})timeout-minutes: \d+\n/m, "")))).toContain("TIMEOUTS");
    expect(
      rules(variant((t) => t.replace(/^( {4})timeout-minutes: \d+$/m, "$1timeout-minutes: 600"))),
    ).toContain("TIMEOUTS");
    expect(rules(variant((t) => t.replace("windows-2022", "windows-latest")))).toContain("RUNNERS");
  });

  it("refuses a workflow that drops a required command or calls a script the repository does not have", () => {
    expect(rules(variant((t) => t.replace("run: pnpm run web:e2e", "run: echo skipped")))).toContain(
      "REQUIRED_COMMANDS",
    );
    expect(rules(variant((t) => t.replace("pnpm install --frozen-lockfile", "pnpm install")))).toContain(
      "REQUIRED_COMMANDS",
    );
    expect(rules(variant((t) => t.replace("run: pnpm run check", "run: pnpm run check:all")))).toContain(
      "PACKAGE_SCRIPTS",
    );
  });

  it("refuses a toolchain chosen by RUSTUP_TOOLCHAIN instead of rustup default (found by the local replay)", () => {
    const viaEnv = rules(
      variant((t) =>
        t
          .replace(/^env:\n/m, 'env:\n  RUSTUP_TOOLCHAIN: "1.97.1"\n')
          .replace(/^ {10}rustup default 1\.97\.1\n/m, ""),
      ),
    );
    expect(viaEnv).toContain("TOOLCHAIN");
    expect(viaEnv).toContain("REQUIRED_COMMANDS");
  });

  it("the local runner lists every job and step without executing anything", () => {
    const r = spawnSync(process.execPath, [RUNNER, "--list"], { encoding: "utf8", cwd: ROOT });
    expect(r.status, r.stderr).toBe(0);
    for (const cmd of [
      "pnpm install --frozen-lockfile",
      "pnpm run check",
      "pnpm run contract:test",
      "pnpm --filter @dockside/web exec playwright install --with-deps chromium",
      "pnpm run web:e2e",
      "pnpm run contract:reproduce",
      "pnpm run contract:sandbox",
      "pnpm run test:sandbox",
    ]) {
      expect(r.stdout).toContain(cmd);
    }
    expect(r.stdout).toMatch(/job test .*ubuntu-24\.04, windows-2022/);
    expect(r.stdout).toMatch(/job chain .*ubuntu-24\.04/);
  });

  it("the local runner refuses to run a workflow that breaks the policy", () => {
    const bad = variant((t) => t.replace("persist-credentials: false", "persist-credentials: true"));
    const r = spawnSync(process.execPath, [RUNNER, "--workflow", bad, "--job", "test", "--dry-run"], {
      encoding: "utf8",
      cwd: ROOT,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("CHECKOUT_CREDENTIALS");
  });

  it("the local runner refuses an unknown job", () => {
    const r = spawnSync(process.execPath, [RUNNER, "--job", "deploy", "--dry-run"], {
      encoding: "utf8",
      cwd: ROOT,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown job");
  });
});
