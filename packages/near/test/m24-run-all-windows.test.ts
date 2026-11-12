/**
 * M24: fixes to scripts/testnet-deploy/run-all found on the first NEAR testnet run (Windows host).
 *
 *  1. near-cli-rs 0.31 asks "Which signature scheme should the new key pair use?" in
 *     `autogenerate-new-keypair`; run-all passes `--signature-scheme ed25519` and runs every
 *     near-cli-rs command with stdin closed, so a prompt fails fast instead of hanging.
 *  2. On Windows npm installs `near`, `near.cmd` and `near.ps1` shims that cannot be spawned without
 *     a shell (ENOENT); NEAR_CLI is resolved to the real near.exe.
 *  3. near-cli-rs "Transaction has expired" is retried with fresh signing (bounded), only when the
 *     error proves the transaction was not included, and failures surface near-cli-rs's own error.
 *     Read-only RPC calls can fall back to further RPC URLs.
 * IDs: T-043 (testnet corridor tooling), T-007 / T-019 (the run-all journey on testnet).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TOOL = join(ROOT, "scripts/testnet-deploy/tool.mjs");
const RUN_ALL = join(ROOT, "scripts/testnet-deploy/run-all");
const dir = mkdtempSync(join(tmpdir(), "dockside-m24-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface NearResult {
  status: number | null;
  text: string;
  clean: string;
  txHash: string | null;
}
interface Classified {
  retry: boolean;
  kind: string;
  errors: string[];
}
interface ResolveOptions {
  env: Record<string, string | undefined>;
  platform: string;
  exists: (p: string) => boolean;
  where: (name: string) => string[];
  execPath: string;
}
interface RunOptions {
  attempts?: number;
  run: (bin: string, args: string[]) => NearResult | Promise<NearResult>;
  sleep?: (ms: number) => Promise<void>;
  log?: (m: string) => void;
}
interface NearTools {
  resolveNearCli(o: ResolveOptions): string;
  classifyNearFailure(text: string): Classified;
  describeNearFailure(r: NearResult & { attempts?: number }): string;
  runNear(
    bin: string,
    args: string[],
    o: RunOptions,
  ): Promise<NearResult & { attempts: number; log: string }>;
  networkProfile(
    network: string,
    rpcUrl?: string,
    fallbackRpcUrls?: string[],
  ): { rpcUrl: string; rpcUrls: string[] };
  parseFallbackRpcUrls(v: string | undefined): string[];
  Rpc: new (
    urls: string | string[],
    o?: { timeoutMs?: number },
  ) => { request(method: string, params: unknown): Promise<unknown> };
}

const tools = (await import(
  pathToFileURL(join(ROOT, "scripts/testnet-deploy/lib/near-tools.mjs")).href
)) as NearTools;

const ESC = "\u001b[";
const HASH = "4r6P8FKrUinVTJmr1RhMrYewhzN1o9gBRHEY16DqUFki";
const result = (text: string, status: number | null = 1): NearResult => ({
  status,
  text,
  clean: text.split(`${ESC}33m`).join("").split(`${ESC}39m`).join(""),
  txHash: text.includes("Transaction ID:") ? HASH : null,
});
// The error near-cli-rs 0.31.1 printed for approve_release on the first testnet run.
const EXPIRED = [
  "├  Your transaction was signed successfully.",
  "│    Public key: ed25519:J9RvmdzWNiXQZeyJPmhobxH56MwzzyekCdngQg43aidN",
  "Error: ",
  `   0: ${ESC}31mError: Transaction has expired.${ESC}0m`,
  "",
  "Location:",
  "   src/common.rs:1234",
].join("\n");
const SENT = `├  Transaction Execution Info:\n│    Transaction ID: ${ESC}33m${HASH}${ESC}39m\n`;

describe("NEAR_CLI resolution (shared by run-all and the Node helpers)", () => {
  const prefix = "C:\\Program Files\\nodejs";
  const real = `${prefix}\\node_modules\\near-cli-rs\\node_modules\\.bin_real\\near.exe`;
  const base: ResolveOptions = {
    env: {},
    platform: "win32",
    exists: (p) => p === real,
    where: () => [],
    execPath: `${prefix}\\node.exe`,
  };

  it("honours NEAR_CLI when it names a binary", () => {
    expect(tools.resolveNearCli({ ...base, env: { NEAR_CLI: "D:\\tools\\near.exe" } })).toBe(
      "D:\\tools\\near.exe",
    );
    expect(tools.resolveNearCli({ ...base, platform: "linux", env: { NEAR_CLI: "/opt/near" } })).toBe(
      "/opt/near",
    );
  });

  it("defaults to `near` off Windows", () => {
    expect(tools.resolveNearCli({ ...base, platform: "linux" })).toBe("near");
    expect(tools.resolveNearCli({ ...base, platform: "darwin" })).toBe("near");
  });

  it("finds the real near.exe under the npm global prefix on Windows", () => {
    expect(tools.resolveNearCli(base)).toBe(real);
    const appdata = "C:\\Users\\u\\AppData\\Roaming";
    const fromAppdata = `${appdata}\\npm\\node_modules\\near-cli-rs\\node_modules\\.bin_real\\near.exe`;
    expect(
      tools.resolveNearCli({ ...base, env: { APPDATA: appdata }, exists: (p) => p === fromAppdata }),
    ).toBe(fromAppdata);
    const custom = "E:\\npm-global";
    const fromConfig = `${custom}\\node_modules\\near-cli-rs\\node_modules\\.bin_real\\near.exe`;
    expect(
      tools.resolveNearCli({ ...base, env: { npm_config_prefix: custom }, exists: (p) => p === fromConfig }),
    ).toBe(fromConfig);
  });

  it("maps an npm shim (NEAR_CLI or `where near`) to the real near.exe beside it", () => {
    expect(tools.resolveNearCli({ ...base, env: { NEAR_CLI: `${prefix}\\near.cmd` } })).toBe(real);
    expect(tools.resolveNearCli({ ...base, env: { NEAR_CLI: `${prefix}\\near.ps1` } })).toBe(real);
    expect(tools.resolveNearCli({ ...base, env: { NEAR_CLI: `${prefix}\\near` } })).toBe(real);
    const other = "F:\\n";
    const otherReal = `${other}\\node_modules\\near-cli-rs\\node_modules\\.bin_real\\near.exe`;
    expect(
      tools.resolveNearCli({
        ...base,
        exists: (p) => p === otherReal,
        where: () => [`${other}\\near`, `${other}\\near.cmd`],
      }),
    ).toBe(otherReal);
    const cargo = "C:\\Users\\u\\.cargo\\bin\\near.exe";
    expect(tools.resolveNearCli({ ...base, exists: (p) => p === cargo, where: () => [cargo] })).toBe(cargo);
  });

  it("refuses a shim it cannot map, and a missing near-cli-rs, with NEAR_CLI_MISSING", () => {
    const none = { ...base, exists: () => false };
    expect(() => tools.resolveNearCli({ ...none, env: { NEAR_CLI: "C:\\x\\near.cmd" } })).toThrow(
      /near\.exe/,
    );
    expect(() => tools.resolveNearCli(none)).toThrow(/near-cli-rs/);
    try {
      tools.resolveNearCli(none);
    } catch (e) {
      expect((e as { code?: string }).code).toBe("NEAR_CLI_MISSING");
    }
  });

  it("is what `tool.mjs near-cli` prints", () => {
    const r = spawnSync(process.execPath, [TOOL, "near-cli"], {
      encoding: "utf8",
      env: { ...process.env, NEAR_CLI: "/opt/near-cli-rs/near" },
    });
    if (process.platform === "win32") {
      // An extensionless path on Windows is an npm shim; nothing is beside it here.
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("NEAR_CLI_MISSING");
    } else {
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe("/opt/near-cli-rs/near");
    }
  });
});

describe("near-cli-rs failure classification", () => {
  it("retries only an expired transaction, which was never included", () => {
    const c = tools.classifyNearFailure(EXPIRED);
    expect(c.retry).toBe(true);
    expect(c.kind).toBe("EXPIRED");
    expect(c.errors.join("\n")).toContain("Transaction has expired");
    expect(tools.classifyNearFailure("InvalidTxError::Expired").retry).toBe(true);
  });

  it("never retries a transaction that may have been included", () => {
    const cases = [
      SENT,
      `${EXPIRED}\n${SENT}`,
      "Error: \n   0: Timeout error transaction",
      "Error: \n   0: Transaction has expired.\n   1: TIMEOUT_ERROR",
      "Error: \n   0: JSON RPC server is currently unavailable",
      "Error: \n   0: Error: Transaction nonce (5) must be account[access_key].nonce (5) + 1.",
      "",
    ];
    for (const t of cases) expect(tools.classifyNearFailure(t).retry, t).toBe(false);
    expect(tools.classifyNearFailure(SENT).kind).toBe("SENT");
    expect(tools.classifyNearFailure("Error: \n   0: Timeout error transaction").kind).toBe("UNCERTAIN");
  });

  it("recognises an interactive prompt that met a closed stdin", () => {
    const c = tools.classifyNearFailure(
      "◆  Which signature scheme should the new key pair use?\nError: \n   0: IO error: not a terminal",
    );
    expect(c.retry).toBe(false);
    expect(c.kind).toBe("PROMPT");
  });

  it("describes a failure with near-cli-rs's own error, not 'printed no transaction id'", () => {
    const d = tools.describeNearFailure({ ...result(EXPIRED), attempts: 3 });
    expect(d).toContain("Error: Transaction has expired.");
    expect(d).toContain("3 attempts");
    expect(d).not.toContain("no transaction id");
    expect(d).not.toContain(ESC);
    const quiet = tools.describeNearFailure(result("line one\nlast line\n", 2));
    expect(quiet).toContain("exited 2");
    expect(quiet).toContain("last line");
  });
});

describe("near-cli-rs runner with bounded retries", () => {
  const scripted = (outputs: NearResult[]) => {
    const calls: string[][] = [];
    return {
      calls,
      run: (_bin: string, args: string[]) => {
        calls.push(args);
        const next = outputs[Math.min(calls.length - 1, outputs.length - 1)];
        if (!next) throw new Error("no output scripted");
        return next;
      },
    };
  };
  const sleep = async () => {};

  it("re-runs (re-signs) after an expired transaction and returns the success", async () => {
    const s = scripted([result(EXPIRED), result(SENT, 0)]);
    const r = await tools.runNear("near", ["contract", "call-function"], { run: s.run, sleep });
    expect(r.txHash).toBe(HASH);
    expect(r.attempts).toBe(2);
    expect(s.calls).toHaveLength(2);
    expect(r.log).toContain("attempt 1");
    expect(r.log).toContain("Transaction has expired");
  });

  it("gives up after the bound and keeps the real error", async () => {
    const s = scripted([result(EXPIRED)]);
    const r = await tools.runNear("near", ["x"], { run: s.run, sleep, attempts: 3 });
    expect(s.calls).toHaveLength(3);
    expect(r.txHash).toBeNull();
    expect(r.attempts).toBe(3);
    expect(tools.describeNearFailure(r)).toContain("Transaction has expired");
  });

  it("does not retry a timeout or a sent transaction", async () => {
    const t = scripted([result("Error: \n   0: Timeout error transaction"), result(SENT, 0)]);
    const r = await tools.runNear("near", ["x"], { run: t.run, sleep });
    expect(t.calls).toHaveLength(1);
    expect(r.txHash).toBeNull();
    const failedOnChain = scripted([result(SENT, 1), result(SENT, 0)]);
    const f = await tools.runNear("near", ["x"], { run: failedOnChain.run, sleep });
    expect(failedOnChain.calls).toHaveLength(1);
    expect(f.txHash).toBe(HASH);
  });
});

describe("near-run, the run-all entry point for every near-cli-rs command", () => {
  it("runs the binary with stdin closed, stops it at a prompt, writes the output and surfaces the error", () => {
    // A stand-in for near-cli-rs on Windows, where inquire reads the console itself: it reports
    // whether stdin is closed, draws the question near-cli-rs 0.31 asks, then waits forever. A hang
    // here would time the test out.
    const fake = join(dir, "fake-near.mjs");
    writeFileSync(
      fake,
      [
        "let got = '';",
        "process.stdin.on('data', (d) => (got += d));",
        "process.stdin.on('end', () => {",
        "  console.error('stdin ' + (got ? 'open' : 'closed'));",
        "  console.log('◆  Which signature scheme should the new key pair use?');",
        "  console.log('│  [↑↓ to move, enter to select, type to filter]');",
        "  setInterval(() => {}, 1000);",
        "});",
      ].join("\n"),
    );
    const out = join(dir, "near-run.txt");
    const r = spawnSync(
      process.execPath,
      [TOOL, "near-run", "--near", process.execPath, "--out", out, "--", fake, "account", "add-key"],
      { encoding: "utf8", timeout: 20_000 },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("NEAR_CLI_FAILED");
    expect(r.stderr).toContain("interactive question");
    const log = readFileSync(out, "utf8");
    expect(log).toContain("Which signature scheme");
    expect(log).toContain("stdin closed");
    expect(log).toContain("attempt 1");
    expect(log).not.toContain("attempt 2");
  });

  it("recognises near-cli-rs prompts as drawn on the console", () => {
    const t = tools as NearTools & { looksLikePrompt(t: string): boolean };
    expect(t.looksLikePrompt(`${ESC}?25l◆  What Account ID do you need to view?  \n│   ○ a.testnet`)).toBe(
      true,
    );
    expect(t.looksLikePrompt("│  [↑↓ to move, tab to autocomplete, enter to submit]")).toBe(true);
    expect(t.looksLikePrompt(EXPIRED)).toBe(false);
    expect(t.looksLikePrompt(SENT)).toBe(false);
  });
});

describe("run-all passes the key scheme and closes stdin", () => {
  const script = readFileSync(RUN_ALL, "utf8");
  it("asks near-cli-rs for an ed25519 key non-interactively", () => {
    expect(script).toMatch(/autogenerate-new-keypair --signature-scheme ed25519 save-to-legacy-keychain/);
  });
  it("runs every near-cli-rs command through near-run with stdin from /dev/null", () => {
    // Only the `--version` probe runs near-cli-rs directly, and with stdin closed too.
    const direct = script.split("\n").filter((l) => /^\s*(if\s+!\s+)?"\$NEAR_BIN"\s/.test(l));
    expect(direct).toHaveLength(1);
    expect(direct[0]).toMatch(/"\$NEAR_BIN" --version <\/dev\/null/);
    for (const l of script.split("\n").filter((x) => /\bsend\b.*;\s*then$/.test(x))) {
      expect(l).toContain("</dev/null");
    }
    const runs = script.split("\n").filter((l) => l.includes("near-run"));
    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(script).toMatch(/NEAR_BIN=\$\(node "\$TOOL" near-cli <\/dev\/null\)/);
  });
});

describe("fallback RPC URLs for read-only calls", () => {
  const servers: Server[] = [];
  afterAll(() => {
    for (const s of servers) s.close();
  });
  const serve = (handler: (body: { method: string; id: number }) => [number, unknown]) =>
    new Promise<string>((resolve) => {
      const s = createServer((req, res) => {
        let data = "";
        req.on("data", (c) => (data += c));
        req.on("end", () => {
          const [code, body] = handler(JSON.parse(data));
          res.writeHead(code, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        });
      });
      servers.push(s);
      s.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`));
    });

  it("validates every fallback like the primary", () => {
    expect(tools.parseFallbackRpcUrls(" https://a.example/ , https://b.example ")).toEqual([
      "https://a.example/",
      "https://b.example",
    ]);
    expect(tools.parseFallbackRpcUrls(undefined)).toEqual([]);
    const p = tools.networkProfile("testnet", undefined, ["https://test.rpc.fastnear.com"]);
    expect(p.rpcUrl).toBe("https://rpc.testnet.near.org");
    expect(p.rpcUrls).toEqual(["https://rpc.testnet.near.org", "https://test.rpc.fastnear.com"]);
    expect(() => tools.networkProfile("testnet", undefined, ["http://plain.example"])).toThrow(/https/);
    expect(() => tools.networkProfile("testnet", undefined, ["https://rpc.mainnet.near.org"])).toThrow(
      /mainnet/,
    );
    expect(() => tools.networkProfile("sandbox", undefined, ["http://10.0.0.5:3030"])).toThrow(/loopback/);
  });

  it("moves to the next URL on a transport failure, never on an RPC answer", async () => {
    const down = await serve(() => [503, { error: "unavailable" }]);
    const up = await serve((b) => [200, { jsonrpc: "2.0", id: b.id, result: { from: "up" } }]);
    const refusing = await serve((b) => [
      200,
      { jsonrpc: "2.0", id: b.id, error: { message: "unknown account", data: "UNKNOWN_ACCOUNT" } },
    ]);
    const closed = "http://127.0.0.1:9";
    expect(await new tools.Rpc([closed, down, up]).request("status", [])).toEqual({ from: "up" });
    await expect(new tools.Rpc([refusing, up]).request("query", {})).rejects.toThrow(/UNKNOWN_ACCOUNT/);
    await expect(new tools.Rpc([closed, down]).request("status", [])).rejects.toThrow(/RPC_UNAVAILABLE|503/);
    expect(await new tools.Rpc(up).request("status", [])).toEqual({ from: "up" });
  });
});
