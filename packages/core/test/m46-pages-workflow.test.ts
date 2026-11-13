/**
 * M46: the GitHub Pages workflow (.github/workflows/pages.yml) is checked by the same
 * scripts/ci/workflow-policy.mjs as the CI workflow, with its "pages" profile (ADR-0027). The
 * checker runs here as a separate node process on the committed file and on copies with one rule
 * broken each. The page it publishes may only talk to the endpoints of the proof manifest.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const POLICY = join(ROOT, "scripts/ci/workflow-policy.mjs");
const WORKFLOW = join(ROOT, ".github/workflows/pages.yml");
const dir = mkdtempSync(join(tmpdir(), "dockside-m46-"));
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
/** A changed copy, still named pages.yml so the pages profile applies. */
function variant(edit: (text: string) => string): string {
  const original = readFileSync(WORKFLOW, "utf8");
  const changed = edit(original);
  expect(changed, "the mutation must change the workflow").not.toBe(original);
  const sub = join(dir, String(++n));
  mkdirSync(sub);
  const file = join(sub, "pages.yml");
  writeFileSync(file, changed);
  return file;
}

function rules(file: string): string[] {
  const r = policy(file);
  expect(r.status, r.stderr).toBe(1);
  return r.verdict.violations.map((v) => v.rule);
}

const DEPLOY_STEP = /^ {6}- name: Deploy the uploaded artifact\n/m;

describe("M46 Pages workflow policy", () => {
  it("the committed workflow satisfies every rule", () => {
    const r = policy(WORKFLOW);
    expect(r.stderr).toBe("");
    expect(r.verdict.violations).toEqual([]);
    expect(r.status).toBe(0);
  });

  it("uses only official actions pinned to full commit SHAs", () => {
    const uses = [...readFileSync(WORKFLOW, "utf8").matchAll(/^\s*uses:\s*(\S+)\s+# v[\d.]+$/gm)].map(
      (m) => m[1] ?? "",
    );
    expect(uses.map((u) => u.split("@")[0])).toEqual([
      "actions/checkout",
      "actions/setup-node",
      "actions/configure-pages",
      "actions/upload-pages-artifact",
      "actions/deploy-pages",
    ]);
    for (const u of uses) expect(u).toMatch(/^actions\/[\w-]+@[0-9a-f]{40}$/);
    expect(
      rules(variant((t) => t.replace(/actions\/deploy-pages@[0-9a-f]{40}/, "actions/deploy-pages@v4"))),
    ).toContain("PINNED_ACTIONS");
    expect(
      rules(variant((t) => t.replace("actions/configure-pages@", "someone/configure-pages@"))),
    ).toContain("OFFICIAL_ACTIONS");
    // An official action outside the list is refused too.
    expect(rules(variant((t) => t.replace("actions/setup-node@", "actions/github-script@")))).toContain(
      "OFFICIAL_ACTIONS",
    );
  });

  it("keeps the CI workflow's triggers, workflow permissions, secrets and expression rules", () => {
    expect(rules(variant((t) => t.replace(/^ {2}pull_request:\n/m, "  pull_request_target:\n")))).toContain(
      "TRIGGERS",
    );
    expect(rules(variant((t) => t.replace(/^on:\n/m, "on:\n  workflow_dispatch:\n")))).toContain("TRIGGERS");
    expect(rules(variant((t) => t.replace(/^ {2}contents: read$/m, "  contents: write")))).toContain(
      "PERMISSIONS",
    );
    expect(
      rules(variant((t) => t.replace(/^ {2}contents: read$/m, "  contents: read\n  pages: write"))),
    ).toContain("PERMISSIONS");
    expect(
      rules(
        variant((t) =>
          t.replace(
            "          path: site/proof",
            `          path: site/proof\n          token: ${expr("secrets.X")}`,
          ),
        ),
      ),
    ).toContain("NO_SECRETS");
    expect(
      rules(
        variant((t) =>
          t.replace(
            "run: node scripts/proof/build-manifest.mjs --check",
            `run: node scripts/proof/build-manifest.mjs --check ${expr("github.head_ref")}`,
          ),
        ),
      ),
    ).toEqual(expect.arrayContaining(["EXPRESSIONS", "RUN_EXPRESSIONS"]));
    expect(rules(variant((t) => t.replace("          persist-credentials: false\n", "")))).toContain(
      "CHECKOUT_CREDENTIALS",
    );
    expect(rules(variant((t) => t.replace("runs-on: ubuntu-24.04", "runs-on: ubuntu-latest")))).toContain(
      "RUNNERS",
    );
    expect(rules(variant((t) => t.replace("timeout-minutes: 10", "timeout-minutes: 600")))).toContain(
      "TIMEOUTS",
    );
  });

  it("lets only the deploy job write, and only as the single deploy-pages step on pushes", () => {
    // The build job may not hold the Pages permissions.
    expect(
      rules(
        variant((t) =>
          t.replace(
            "    runs-on: ubuntu-24.04\n    timeout-minutes: 10\n    steps:\n      - name: Check out",
            "    runs-on: ubuntu-24.04\n    timeout-minutes: 10\n    permissions:\n      pages: write\n    steps:\n      - name: Check out",
          ),
        ),
      ),
    ).toContain("PERMISSIONS");
    // The deploy job may not hold more than the two Pages permissions.
    expect(
      rules(
        variant((t) =>
          t.replace("      id-token: write\n", "      id-token: write\n      contents: write\n"),
        ),
      ),
    ).toContain("PERMISSIONS");
    // It must run on pushes only.
    expect(rules(variant((t) => t.replace("    if: github.event_name == 'push'\n", "")))).toContain(
      "TRIGGERS",
    );
    expect(
      rules(variant((t) => t.replace("if: github.event_name == 'push'", "if: github.event_name != 'x'"))),
    ).toContain("TRIGGERS");
    // It must deploy what the build job validated.
    expect(rules(variant((t) => t.replace("    needs: build\n", "")))).toContain("REQUIRED_COMMANDS");
    expect(rules(variant((t) => t.replace("      name: github-pages", "      name: production")))).toContain(
      "PERMISSIONS",
    );
    // It may not run a script or check out code beside the deploy action.
    expect(
      rules(
        variant((t) =>
          t.replace(DEPLOY_STEP, "      - run: echo extra\n      - name: Deploy the uploaded artifact\n"),
        ),
      ),
    ).toContain("PERMISSIONS");
  });

  it("requires the manifest check and the site/proof artifact", () => {
    expect(
      rules(
        variant((t) => t.replace("run: node scripts/proof/build-manifest.mjs --check", "run: echo skipped")),
      ),
    ).toContain("REQUIRED_COMMANDS");
    expect(rules(variant((t) => t.replace("          path: site/proof", "          path: .")))).toContain(
      "PAGES_ARTIFACT",
    );
  });

  it("the CI profile still refuses this file's deploy permissions under another name", () => {
    const file = join(dir, "other.yml");
    writeFileSync(file, readFileSync(WORKFLOW, "utf8"));
    expect(rules(file)).toEqual(expect.arrayContaining(["PERMISSIONS", "REQUIRED_COMMANDS", "RUNNERS"]));
  });
});

describe("M46 proof page", () => {
  const html = readFileSync(join(ROOT, "site/proof/index.html"), "utf8");
  const manifest = JSON.parse(readFileSync(join(ROOT, "site/proof/proof-manifest.json"), "utf8"));
  const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? "";
  const directive = (name: string) =>
    csp
      .split(";")
      .map((d) => d.trim().split(/\s+/))
      .find((d) => d[0] === name)
      ?.slice(1) ?? [];

  it("may connect only to itself and to the RPC endpoints of the manifest", () => {
    const origins = Object.values(manifest.networks as Record<string, { rpc: string[] }>).flatMap((n) =>
      n.rpc.map((u) => new URL(u).origin),
    );
    expect(origins.length).toBeGreaterThan(0);
    expect(directive("connect-src").sort()).toEqual(["'self'", ...origins].sort());
    expect(directive("default-src")).toEqual(["'none'"]);
    expect(directive("script-src")).toEqual(["'self'"]);
  });

  it("loads nothing from a third party and has no inline script", () => {
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1] ?? "");
    expect(refs).toEqual(["./proof.css", "#panel", "./app.mjs"]);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
    expect(html).not.toMatch(/\son\w+=/);
  });

  it("writes chain data to the page as text only", () => {
    const app = readFileSync(join(ROOT, "site/proof/app.mjs"), "utf8");
    expect(app).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(/);
  });
});
