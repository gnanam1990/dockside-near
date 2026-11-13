// `pnpm judge`: one command that checks this checkout and the deployed contract, and prints one
// PASS or FAIL table with the expected value beside every actual value.
//
//   1. install          pnpm install --frozen-lockfile
//   2. unit tests       pnpm run test            (builds TypeScript and the contract wasm first)
//   3. contract tests   pnpm run contract:test   (Rust host tests of the escrow core)
//   4. proof manifest   site/proof/proof-manifest.json equals what docs/evidence produces
//   5. on-chain checks  the proof page's verifier (site/proof/lib/verify.mjs) against NEAR
//   6. USDC escrow3     the NEP-141 escrow of M56 against docs/evidence/M56/onchain-reverify.json
//                       (scripts/judge/usdc.mjs)
//
// The on-chain part only reads (block, query, tx status): it holds no key and cannot send a
// transaction. Exit status 0 when every row passed, 1 otherwise, 2 on a usage error.
//
// Usage: pnpm judge [--only a,b] [--skip a,b] [--no-code-bytes] [--manifest <file>] [--usdc-rpc <url>]
//                   [--report <file>]
//        step names: install, unit, contract, manifest, chain, usdc
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyNetwork } from "../../site/proof/lib/verify.mjs";
import { buildManifest, MANIFEST, ROOT, render, SOURCES } from "../proof/build-manifest.mjs";
import { loadUsdcEvidence, USDC_RPC, verifyUsdc } from "./usdc.mjs";

export const STEP_NAMES = ["install", "unit", "contract", "manifest", "chain", "usdc"];
const OUT_DIR = join(ROOT, ".data/judge");
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips terminal colour codes
const ANSI = /\u001b\[[0-9;]*m/g;

/** "Tests  812 passed (812)" and "Test Files  96 passed (96)" from a vitest run. */
export function parseVitest(text) {
  const clean = text.replace(ANSI, "");
  const line = (label) => new RegExp(`^\\s*${label}\\s+(.*)$`, "m").exec(clean)?.[1] ?? "";
  const count = (s, word) => Number(new RegExp(`(\\d+) ${word}`).exec(s)?.[1] ?? 0);
  const tests = line("Tests");
  const files = line("Test Files");
  if (!tests || !files) return null;
  return {
    files: count(files, "passed"),
    filesFailed: count(files, "failed"),
    passed: count(tests, "passed"),
    failed: count(tests, "failed"),
    skipped: count(tests, "skipped"),
  };
}

/** Sum of every "test result: ok. 12 passed; 0 failed; ..." line of a cargo test run. */
export function parseCargo(text) {
  const out = { suites: 0, passed: 0, failed: 0, ignored: 0 };
  for (const m of text.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/g)) {
    out.suites++;
    out.passed += Number(m[1]);
    out.failed += Number(m[2]);
    out.ignored += Number(m[3]);
  }
  return out.suites === 0 ? null : out;
}

/** Runs a command, keeps its output in a log file, never throws. */
export function runCommand(command, args, { cwd = ROOT, log } = {}) {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd,
      shell: process.platform === "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];
    child.stdout.on("data", (c) => chunks.push(c));
    child.stderr.on("data", (c) => chunks.push(c));
    const finish = (status, error) => {
      const output = Buffer.concat(chunks).toString() + (error ? `\n${error}\n` : "");
      if (log) {
        mkdirSync(dirname(log), { recursive: true });
        writeFileSync(log, output);
      }
      done({ status, output, ms: Date.now() - started });
    };
    child.on("error", (e) => finish(127, e.message));
    child.on("close", (code) => finish(code ?? 1));
  });
}

const shorten = (s, max) =>
  s.length <= max ? s : `${s.slice(0, Math.ceil(max / 2) - 1)}…${s.slice(-Math.floor(max / 2))}`;

/** Plain-text table. Long values are shortened in the middle; the JSON report keeps them whole. */
export function renderTable(rows, { width = 46 } = {}) {
  const head = ["#", "Check", "Expected", "Actual", "Result"];
  const body = rows.map((r, i) => [
    String(i + 1),
    shorten(r.check, 58),
    shorten(r.expected, width),
    shorten(r.actual, width),
    r.status,
  ]);
  const widths = head.map((h, c) => Math.max(h.length, ...body.map((b) => b[c].length)));
  const fmt = (cells) => `| ${cells.map((v, c) => v.padEnd(widths[c])).join(" | ")} |`;
  const rule = `|${widths.map((w) => "-".repeat(w + 2)).join("|")}|`;
  return [fmt(head), rule, ...body.map(fmt)].join("\n");
}

/** PASS only when there is at least one PASS row and no FAIL or ERROR row. SKIP rows never pass. */
export function overall(rows) {
  const bad = rows.filter((r) => r.status === "FAIL" || r.status === "ERROR").length;
  return bad === 0 && rows.some((r) => r.status === "PASS") ? "PASS" : "FAIL";
}

function commandStep(name, check, command, args, describe) {
  return {
    name,
    run: async ({ say }) => {
      say(`${[command, ...args].join(" ")}`);
      const log = join(OUT_DIR, `${name}.log`);
      const r = await runCommand(command, args, { log });
      const d = describe(r);
      const ok = r.status === 0 && d.ok;
      if (!ok) say(`${name} failed; last lines of .data/judge/${name}.log:\n${tail(r.output, 25)}`);
      return [
        {
          check,
          expected: d.expected,
          actual: `exit ${r.status}${d.actual ? `, ${d.actual}` : ""}`,
          status: ok ? "PASS" : "FAIL",
          seconds: Math.round(r.ms / 1000),
        },
      ];
    },
  };
}

const tail = (text, n) => text.replace(ANSI, "").trimEnd().split(/\r?\n/).slice(-n).join("\n");

export function defaultSteps({ manifestPath = MANIFEST, codeBytes = true, usdcRpc = USDC_RPC } = {}) {
  return [
    commandStep(
      "install",
      "Install from the frozen lockfile",
      "pnpm",
      ["install", "--frozen-lockfile"],
      () => ({
        ok: true,
        expected: "exit 0",
        actual: "",
      }),
    ),
    commandStep("unit", "Unit and integration tests (vitest)", "pnpm", ["run", "test"], (r) => {
      const v = parseVitest(r.output);
      return {
        ok: v !== null && v.failed === 0 && v.filesFailed === 0 && v.passed > 0,
        expected: "exit 0, 0 failed",
        actual: v
          ? `${v.passed} passed, ${v.failed} failed in ${v.files + v.filesFailed} files`
          : "no test summary",
      };
    }),
    commandStep("contract", "Contract tests (cargo, escrow core)", "pnpm", ["run", "contract:test"], (r) => {
      const c = parseCargo(r.output);
      return {
        ok: c !== null && c.failed === 0 && c.passed > 0,
        expected: "exit 0, 0 failed",
        actual: c ? `${c.passed} passed, ${c.failed} failed in ${c.suites} suites` : "no test summary",
      };
    }),
    {
      name: "manifest",
      run: async () => {
        const custom = resolve(manifestPath) !== MANIFEST;
        if (custom) {
          return [
            {
              check: "Proof manifest is derived from docs/evidence",
              expected: "the committed site/proof/proof-manifest.json",
              actual: "another manifest was given with --manifest",
              status: "SKIP",
            },
          ];
        }
        const built = render(buildManifest(JSON.parse(readFileSync(SOURCES, "utf8"))));
        const current = readFileSync(MANIFEST, "utf8").replace(/\r\n/g, "\n");
        return [
          {
            check: "Proof manifest is derived from docs/evidence",
            expected: "identical to the generator's output",
            actual: built === current ? "identical to the generator's output" : "the committed file differs",
            status: built === current ? "PASS" : "FAIL",
          },
        ];
      },
    },
    {
      name: "chain",
      run: async ({ say }) => {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        const rows = [];
        for (const [name, network] of Object.entries(manifest.networks)) {
          if (!network.deployment) {
            rows.push({
              check: `${name}: deployment`,
              expected: "not deployed yet",
              actual: "not deployed yet, nothing to read",
              status: "SKIP",
            });
            continue;
          }
          say(`reading ${network.deployment.contractId} through ${new URL(network.rpc[0]).host} (read-only)`);
          const result = await verifyNetwork(network, { downloadCode: codeBytes });
          if (result.block) say(`${name}: final block ${result.block.height}, ${result.rpcCalls} requests`);
          if (!codeBytes) {
            rows.push({
              check: `${name}: contract bytes hash to the manifest SHA-256`,
              expected: `${network.deployment.artifact.bytes} bytes, sha256 ${network.deployment.artifact.sha256}`,
              actual: "skipped by --no-code-bytes",
              status: "SKIP",
            });
          }
          for (const r of result.rows) {
            const scope = r.group.startsWith("trade:")
              ? ` ${shortId(r.group.slice(6))}`
              : r.group.startsWith("tx:")
                ? ` ${shortId(r.group.slice(3))} tx`
                : "";
            rows.push({
              check: `${name}${scope}: ${r.title}`,
              expected: r.expected,
              actual: r.actual,
              status: r.status,
              ...(r.link ? { link: r.link } : {}),
            });
          }
        }
        return rows;
      },
    },
    {
      name: "usdc",
      run: async ({ say }) => {
        const evidence = loadUsdcEvidence(ROOT);
        say(
          `reading ${evidence.escrowAccount.account} through ${new URL(usdcRpc[0]).host} (read-only), expected values from docs/evidence/M56/onchain-reverify.json`,
        );
        const { rows, rpcCalls } = await verifyUsdc(evidence, { rpc: usdcRpc });
        say(`usdc: ${rpcCalls} requests`);
        return rows;
      },
    },
  ];
}

const shortId = (tradeId) => `${tradeId.slice(0, 10)}…`;

/**
 * @param {{steps: {name: string, run: Function}[], only?: string[], skip?: string[], out?: (line: string) => void, reportFile?: string | null}} options
 */
export async function runJudge({
  steps,
  only,
  skip = [],
  out = (l) => process.stdout.write(`${l}\n`),
  reportFile,
}) {
  const started = Date.now();
  const rows = [];
  for (const step of steps) {
    if ((only && !only.includes(step.name)) || skip.includes(step.name)) {
      rows.push({
        check: `Step ${step.name}`,
        expected: "run",
        actual: "skipped on the command line",
        status: "SKIP",
      });
      continue;
    }
    const t0 = Date.now();
    out(`[judge] ${step.name} …`);
    try {
      rows.push(...(await step.run({ say: (l) => out(`[judge]   ${l}`) })));
    } catch (e) {
      rows.push({
        check: `Step ${step.name}`,
        expected: "completes",
        actual: `error: ${e.message}`,
        status: "ERROR",
      });
    }
    out(`[judge] ${step.name} done in ${Math.round((Date.now() - t0) / 1000)}s`);
  }
  const verdict = overall(rows);
  const count = (s) => rows.filter((r) => r.status === s).length;
  const seconds = Math.round((Date.now() - started) / 1000);
  const summary = {
    verdict,
    pass: count("PASS"),
    fail: count("FAIL"),
    error: count("ERROR"),
    skip: count("SKIP"),
    seconds,
  };
  out("");
  out(renderTable(rows));
  out("");
  if (reportFile) {
    mkdirSync(dirname(reportFile), { recursive: true });
    writeFileSync(
      reportFile,
      `${JSON.stringify({ schema: "dockside/judge-report@1", summary, rows }, null, 2)}\n`,
    );
    out(
      `Full values: ${
        reportFile.startsWith(ROOT)
          ? reportFile
              .slice(ROOT.length + 1)
              .split("\\")
              .join("/")
          : reportFile
      }`,
    );
  }
  out(
    `JUDGE: ${verdict}  ${summary.pass} passed, ${summary.fail} failed, ${summary.error} not readable, ${summary.skip} skipped, ${Math.floor(seconds / 60)}m ${seconds % 60}s`,
  );
  return { rows, summary };
}

function parseArgs(argv) {
  const opts = {
    skip: [],
    codeBytes: true,
    manifestPath: MANIFEST,
    reportFile: join(OUT_DIR, "judge-report.json"),
    usdcRpc: USDC_RPC,
  };
  const list = (v) => {
    const names = String(v ?? "")
      .split(",")
      .filter(Boolean);
    const unknown = names.filter((n) => !STEP_NAMES.includes(n));
    if (names.length === 0 || unknown.length > 0) throw new Error(`step names are ${STEP_NAMES.join(", ")}`);
    return names;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--only") opts.only = list(argv[++i]);
    else if (a === "--skip") opts.skip = list(argv[++i]);
    else if (a === "--no-code-bytes") opts.codeBytes = false;
    else if (a === "--report") {
      if (!argv[i + 1]) throw new Error("--report needs a file");
      opts.reportFile = resolve(argv[++i]);
    } else if (a === "--usdc-rpc") {
      if (!argv[i + 1]) throw new Error("--usdc-rpc needs a URL");
      opts.usdcRpc = [argv[++i]];
    } else if (a === "--manifest") {
      opts.manifestPath = resolve(argv[++i] ?? "");
      if (!existsSync(opts.manifestPath)) throw new Error(`no such manifest: ${argv[i]}`);
    } else throw new Error(`unknown option ${a}`);
  }
  return opts;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(
      `judge: ${e.message}\nusage: pnpm judge [--only a,b] [--skip a,b] [--no-code-bytes] [--manifest <file>] [--usdc-rpc <url>] [--report <file>]\n`,
    );
    process.exit(2);
  }
  const { summary } = await runJudge({
    steps: defaultSteps(opts),
    only: opts.only,
    skip: opts.skip,
    reportFile: opts.reportFile,
  });
  process.exit(summary.verdict === "PASS" ? 0 : 1);
}
