/**
 * M44: the testnet RPC default moved to https://test.rpc.fastnear.com (rpc.testnet.near.org is
 * deprecated and answers HTTP 429), and `run-all --resume <run dir>` accepts an explicit `--rpc-url`
 * override: only the endpoint, checked against the run's recorded network; every other setting still
 * comes from the run directory. Nothing here contacts a network.
 * IDs: T-007 / T-019 (run-all on testnet).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { NEAR_TESTNET_RPC_DEFAULT } from "../src/index.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TOOL = join(ROOT, "scripts/testnet-deploy/tool.mjs");
const RUN_ALL = join(ROOT, "scripts/testnet-deploy/run-all");
const dir = mkdtempSync(join(tmpdir(), "dockside-m44-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const tools = (await import(pathToFileURL(join(ROOT, "scripts/testnet-deploy/lib/near-tools.mjs")).href)) as {
  TESTNET_RPC_DEFAULT: string;
  networkProfile(network: string, rpcUrl?: string, fallbacks?: string[]): { rpcUrl: string };
};

function tool(args: string[]) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8" });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

function runDir(network: string, rpcUrl: string) {
  const out = mkdtempSync(join(dir, "run-"));
  writeFileSync(
    join(out, "run-params.json"),
    JSON.stringify({ schema: "dockside/run-params@1", network, rpcUrl, journey: "refund" }),
  );
  return out;
}

describe("testnet RPC default", () => {
  it("is https://test.rpc.fastnear.com everywhere, and an explicit --rpc-url still wins", () => {
    expect(tools.TESTNET_RPC_DEFAULT).toBe("https://test.rpc.fastnear.com");
    expect(NEAR_TESTNET_RPC_DEFAULT).toBe("https://test.rpc.fastnear.com");
    expect(tools.networkProfile("testnet").rpcUrl).toBe("https://test.rpc.fastnear.com");
    expect(tools.networkProfile("testnet", "https://rpc.testnet.example/").rpcUrl).toBe(
      "https://rpc.testnet.example",
    );
    const script = readFileSync(RUN_ALL, "utf8");
    expect(script).toContain("default https://test.rpc.fastnear.com");
    expect(script).not.toContain("rpc.testnet.near.org");
  });
});

describe("resume RPC URL (tool.mjs resume-rpc-url)", () => {
  it("keeps the recorded URL without an override and uses the override when given", () => {
    const out = runDir("testnet", "https://rpc.testnet.near.org");
    expect(tool(["resume-rpc-url", "--dir", out]).out).toBe("https://rpc.testnet.near.org");
    expect(tool(["resume-rpc-url", "--dir", out, "--rpc-url", "https://test.rpc.fastnear.com/"]).out).toBe(
      "https://test.rpc.fastnear.com",
    );
  });

  it("checks the override against the run's recorded network", () => {
    const testnet = runDir("testnet", "https://test.rpc.fastnear.com");
    for (const url of ["https://rpc.mainnet.near.org", "http://test.rpc.fastnear.com"]) {
      const r = tool(["resume-rpc-url", "--dir", testnet, "--rpc-url", url]);
      expect(r.status, url).toBe(2);
      expect(r.err).toContain("NETWORK_REFUSED");
    }
    // A sandbox run cannot be moved to a public endpoint.
    const sandbox = runDir("sandbox", "http://127.0.0.1:4521");
    const pub = tool(["resume-rpc-url", "--dir", sandbox, "--rpc-url", "https://test.rpc.fastnear.com"]);
    expect(pub.status).toBe(2);
    expect(pub.err).toContain("NETWORK_REFUSED");
    for (const empty of [[""], []]) {
      const r = tool(["resume-rpc-url", "--dir", testnet, "--rpc-url", ...empty]);
      expect(r.status).toBe(2);
      expect(r.err).toContain("--rpc-url needs a URL");
    }
    expect(tool(["resume-rpc-url", "--dir", join(dir, "nope")]).err).toContain("NOTHING_TO_RESUME");
  });
});

describe("run-all --resume wiring", () => {
  const script = readFileSync(RUN_ALL, "utf8");
  it("accepts --rpc-url on a resumed run and still refuses every other run setting", () => {
    expect(script).toMatch(/--rpc-url\) RPC_URL="\$\{2:-\}"; RPC_OVERRIDE=1; shift 2 ;;/);
    expect(script).toContain('resume-rpc-url --dir "$OUT" --rpc-url "$RPC_URL"');
    for (const opt of [
      "--network",
      "--wasm",
      "--manifest",
      "--amount-yocto",
      "--out",
      "--relayer-key-file",
      "--allowance",
      "--journey",
      "--excess-yocto",
    ]) {
      expect(script, opt).toMatch(new RegExp(`\\n\\s+${opt}\\)[^\\n]*FIXED="\\$FIXED \\$1"`));
    }
    expect(script).toMatch(/--skip-deploy\) SKIP_DEPLOY=1; FIXED="\$FIXED \$1"/);
    expect(script).toMatch(/--resume takes the run's own settings/);
  });
});
