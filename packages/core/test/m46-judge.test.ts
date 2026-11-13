/**
 * M46: `pnpm judge` (scripts/judge/judge.mjs). The command is run here as a separate node process
 * for its on-chain part, against a local server replaying real recorded testnet answers
 * (scripts/proof/replay-rpc.mjs): unchanged for PASS and with one fact altered for FAIL. The step
 * runner is exercised with real child processes that succeed and fail. The full command, with
 * install, unit tests and contract tests against the public testnet RPC, is recorded in
 * docs/status/M46.md.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type JudgeRow,
  overall,
  parseCargo,
  parseVitest,
  renderTable,
  runCommand,
  runJudge,
} from "../../../scripts/judge/judge.mjs";
import { type Replay, startReplay } from "../../../scripts/proof/replay-rpc.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const JUDGE = join(ROOT, "scripts/judge/judge.mjs");
const manifest = JSON.parse(readFileSync(join(ROOT, "site/proof/proof-manifest.json"), "utf8"));
const dir = mkdtempSync(join(tmpdir(), "dockside-m46-judge-"));
let replay: Replay;
beforeAll(async () => {
  replay = await startReplay();
});
afterAll(async () => {
  await replay.close();
  rmSync(dir, { recursive: true, force: true });
});

function manifestFor(variant: string): string {
  const file = join(dir, `manifest-${variant}.json`);
  const testnet = { ...manifest.networks.testnet, rpc: [replay.url(variant)] };
  writeFileSync(file, JSON.stringify({ ...manifest, networks: { ...manifest.networks, testnet } }));
  return file;
}

const REPORT = join(dir, "report.json");
/** Runs the command as a child process without blocking this process, which hosts the replay server. */
function judge(...args: string[]): Promise<{ status: number | null; out: string; err: string }> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [JUDGE, "--report", REPORT, ...args],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      (error, out, err) => done({ status: error ? Number(error.code ?? 1) : 0, out, err }),
    );
  });
}

describe("M46 pnpm judge, on-chain part against recorded testnet answers", () => {
  it("is wired as the judge script", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.scripts.judge).toBe("node scripts/judge/judge.mjs");
  });

  it("prints a PASS table with expected and actual values and exits 0", async () => {
    const r = await judge("--only", "chain", "--no-code-bytes", "--manifest", manifestFor("recorded"));
    expect(r.err).toBe("");
    expect(r.out).toContain("| Check");
    expect(r.out).toMatch(/\| Expected\s+\| Actual\s+\| Result \|/);
    expect(r.out).toMatch(
      /testnet: Deployed code hash equals the build manifest\s+\| 7GEti5E6NWcjq8kHj5Gweed5HwggY1cxPD7cfbB65h8N\s+\| 7GEti5E6NWcjq8kHj5Gweed5HwggY1cxPD7cfbB65h8N\s+\| PASS/,
    );
    expect(r.out).toMatch(
      /mainnet: deployment\s+\| not deployed yet\s+\| not deployed yet, nothing to read\s+\| SKIP/,
    );
    expect(r.out).toMatch(/JUDGE: PASS {2}62 passed, 0 failed, 0 not readable, 7 skipped/);
    expect(r.status).toBe(0);
    const report = JSON.parse(readFileSync(REPORT, "utf8"));
    expect(report.summary).toMatchObject({ verdict: "PASS", pass: 62, fail: 0, error: 0 });
    // The report keeps every value whole, with the explorer link of each transaction.
    const tx = report.rows.filter((x: JudgeRow) => x.link?.includes("/txns/"));
    expect(tx).toHaveLength(27);
  });

  it("prints FAIL and exits 1 when the chain disagrees with the manifest", async () => {
    const r = await judge("--only", "chain", "--no-code-bytes", "--manifest", manifestFor("code-hash"));
    expect(r.out).toMatch(
      /Deployed code hash equals the build manifest\s+\| 7GEti5E6NWcjq8kHj5Gweed5HwggY1cxPD7cfbB65h8N\s+\| 11111111111111111111111111111111\s+\| FAIL/,
    );
    expect(r.out).toMatch(/JUDGE: FAIL {2}61 passed, 1 failed/);
    expect(r.status).toBe(1);
  });

  it("exits 1 when the chain cannot be read: an unreadable value is not a pass", async () => {
    const r = await judge("--only", "chain", "--manifest", manifestFor("down"));
    expect(r.out).toMatch(/Final block .*\| ERROR/);
    expect(r.out).toMatch(/JUDGE: FAIL {2}0 passed, 0 failed, 1 not readable/);
    expect(r.status).toBe(1);
  });

  it("exits 1 when everything was skipped, and 2 on a usage error", async () => {
    const skipped = await judge("--skip", "install,unit,contract,manifest,chain,usdc");
    expect(skipped.out).toMatch(/JUDGE: FAIL {2}0 passed/);
    expect(skipped.status).toBe(1);
    const usage = await judge("--only", "everything");
    expect(usage.status).toBe(2);
    expect(usage.err).toContain("step names are install, unit, contract, manifest, chain");
    expect((await judge("--manifest", join(dir, "missing.json"))).status).toBe(2);
  });
});

describe("M46 pnpm judge, step runner", () => {
  let scripts = 0;
  /** Runs a real node child process on a script file (no shell quoting involved). */
  const node = (code: string) => {
    const file = join(dir, `step-${++scripts}.cjs`);
    writeFileSync(file, code);
    return runCommand("node", [file]);
  };

  it("reports the real exit status and output of a command", async () => {
    const ok = await node("console.log(6*7)");
    expect(ok.status).toBe(0);
    expect(ok.output).toContain("42");
    const bad = await node("console.error(String(1+1));process.exit(3)");
    expect(bad.status).toBe(3);
    expect(bad.output).toContain("2");
    const missing = await runCommand("dockside-no-such-command-m46", []);
    expect(missing.status).not.toBe(0);
  });

  it("fails the run when a step fails or throws, and keeps running the later steps", async () => {
    const lines: string[] = [];
    const step = (name: string, code: string) => ({
      name,
      run: async (): Promise<JudgeRow[]> => {
        const r = await node(code);
        return [
          {
            check: name,
            expected: "exit 0",
            actual: `exit ${r.status}`,
            status: r.status === 0 ? "PASS" : "FAIL",
          },
        ];
      },
    });
    const { summary, rows } = await runJudge({
      steps: [
        step("first", "process.exit(0)"),
        step("second", "process.exit(4)"),
        {
          name: "third",
          run: async () => {
            throw new Error("boom");
          },
        },
        step("fourth", "process.exit(0)"),
      ],
      out: (l) => lines.push(l),
      reportFile: null,
    });
    expect(rows.map((r) => [r.check, r.actual, r.status])).toEqual([
      ["first", "exit 0", "PASS"],
      ["second", "exit 4", "FAIL"],
      ["Step third", "error: boom", "ERROR"],
      ["fourth", "exit 0", "PASS"],
    ]);
    expect(summary).toMatchObject({ verdict: "FAIL", pass: 2, fail: 1, error: 1, skip: 0 });
    expect(lines.at(-1)).toMatch(/^JUDGE: FAIL {2}2 passed, 1 failed, 1 not readable, 0 skipped/);
    const passing = await runJudge({
      steps: [step("first", "process.exit(0)")],
      out: () => {},
      reportFile: null,
    });
    expect(passing.summary.verdict).toBe("PASS");
  });

  it("reads the vitest and cargo summaries", () => {
    const vitest = [
      " \u001b[2mTest Files \u001b[22m \u001b[1m\u001b[32m68 passed\u001b[39m\u001b[22m | 2 skipped (70)",
      "      Tests  669 passed | 8 skipped (677)",
    ].join("\n");
    expect(parseVitest(vitest)).toEqual({ files: 68, filesFailed: 0, passed: 669, failed: 0, skipped: 8 });
    expect(
      parseVitest(" Test Files  1 failed | 3 passed (4)\n      Tests  2 failed | 40 passed (42)"),
    ).toEqual({
      files: 3,
      filesFailed: 1,
      passed: 40,
      failed: 2,
      skipped: 0,
    });
    expect(parseVitest("error: something else")).toBeNull();
    const cargo = [
      "test result: ok. 12 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.10s",
      "test result: FAILED. 3 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.20s",
    ].join("\n");
    expect(parseCargo(cargo)).toEqual({ suites: 2, passed: 15, failed: 2, ignored: 1 });
    expect(parseCargo("error: could not compile")).toBeNull();
  });

  it("renders an aligned table and shortens long values in the middle", () => {
    const table = renderTable([
      { check: "a", expected: "x".repeat(20), actual: `${"a".repeat(40)}${"b".repeat(40)}`, status: "PASS" },
      { check: "bb", expected: "1", actual: "2", status: "FAIL" },
    ]).split("\n");
    expect(table).toHaveLength(4);
    expect(new Set(table.map((l) => l.length)).size).toBe(1);
    expect(table[0]).toMatch(/^\| # \| Check \| Expected\s+\| Actual\s+\| Result \|$/);
    expect(table[2]).toContain(`${"a".repeat(22)}…${"b".repeat(23)}`);
    expect(table[3]).toMatch(/\| 2 \| bb\s+\| 1\s+\| 2\s+\| FAIL {3}\|$/);
  });

  it("never calls a run without a passing row a pass", () => {
    const row = (status: JudgeRow["status"]): JudgeRow => ({
      check: "c",
      expected: "e",
      actual: "a",
      status,
    });
    expect(overall([row("PASS"), row("SKIP")])).toBe("PASS");
    expect(overall([row("SKIP")])).toBe("FAIL");
    expect(overall([])).toBe("FAIL");
    expect(overall([row("PASS"), row("ERROR")])).toBe("FAIL");
    expect(overall([row("PASS"), row("FAIL")])).toBe("FAIL");
  });
});
