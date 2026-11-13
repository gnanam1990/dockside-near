/**
 * M42: run-all `--journey hold|refund` and `--resume <run dir>` (scripts/testnet-deploy). The
 * journeys themselves run on a local near-sandbox node in
 * contract/integration/sandbox-tests/tests/run_all_on_sandbox.rs (container only); this file checks
 * the parts that need no chain: the journey plans, the private seed file, the run parameters a
 * resume reads back, and the option guards that refuse before any RPC call or transaction.
 * IDs: T-007 / T-019 (run-all journeys on testnet), T-008 / T-009 (refund rows), T-016 (holds).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TOOL = join(ROOT, "scripts/testnet-deploy/tool.mjs");
const RUN_ALL = join(ROOT, "scripts/testnet-deploy/run-all");
const dir = mkdtempSync(join(tmpdir(), "dockside-m42-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface PlanStep {
  id: string;
  what?: string;
  kind?: string;
}
interface Seed {
  schema: string;
  seed: string;
  journey: string;
}
const j = (await import(pathToFileURL(join(ROOT, "scripts/testnet-deploy/lib/journey.mjs")).href)) as {
  JOURNEYS: string[];
  DEFAULT_EXCESS_YOCTO: bigint;
  planMethods(journey: string): PlanStep[];
  writeSeed(outDir: string, seed: Record<string, unknown>): string;
  readSeed(outDir: string): Seed;
};

const ACCOUNTS = {
  DOCKSIDE_ESCROW_ACCOUNT: "dockside-escrow.testnet",
  DOCKSIDE_BUYER_ACCOUNT: "acme-buyer.testnet",
  DOCKSIDE_SUPPLIER_ACCOUNT: "harbor-supplier.testnet",
  DOCKSIDE_RELAYER_ACCOUNT: "relayer.testnet",
};

function tool(args: string[]) {
  const r = spawnSync(process.execPath, [TOOL, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...ACCOUNTS },
  });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

describe("journey plans", () => {
  it("paid is the unchanged eight-transaction release", () => {
    expect(j.JOURNEYS.slice(0, 3)).toEqual(["paid", "hold", "refund"]);
    expect(j.planMethods("paid").map((s) => s.what)).toEqual([
      "register",
      "policy",
      "fund",
      "attestation",
      "inspection",
      "intent",
      "approval",
      "execute_release",
    ]);
  });

  it("hold sets a deterministic-policy hold before the intent and resolves it before the approval", () => {
    const ids = j.planMethods("hold").map((s) => s.id);
    expect(ids).toEqual([
      "register",
      "policy",
      "fund",
      "attestation",
      "inspection",
      "hold_set",
      "intent",
      "observe:held",
      "hold_resolve",
      "approval",
      "execute_release",
    ]);
  });

  it("refund requests two rows, waits out the cooling period, then settles both", () => {
    const steps = j.planMethods("refund");
    expect(steps.map((s) => s.id)).toEqual([
      "register",
      "fund",
      "refund:cancel",
      "refund:excess",
      "wait:cooling",
      "authorize:cancel",
      "execute:cancel",
      "authorize:excess",
      "execute:excess",
    ]);
    expect(steps.find((s) => s.id === "wait:cooling")?.kind).toBe("wait");
    expect(j.DEFAULT_EXCESS_YOCTO).toBe(10n ** 22n);
    expect(() => j.planMethods("abandon")).toThrow(/--journey must be one of/);
  });
});

describe("journey seed file", () => {
  it("is written once, owner-only, and read back for --resume", () => {
    const out = mkdtempSync(join(dir, "run-"));
    const seed = { schema: "dockside/journey-seed@1", seed: "ab".repeat(32), journey: "refund" };
    const file = j.writeSeed(out, seed);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(j.readSeed(out)).toMatchObject(seed);
    expect(() => j.writeSeed(out, seed)).toThrow(/RUN_EXISTS|--resume/);
    const empty = mkdtempSync(join(dir, "empty-"));
    expect(() => j.readSeed(empty)).toThrow(/no journey was started/);
    writeFileSync(join(empty, "journey-seed.json"), JSON.stringify({ schema: "other", seed: "x" }));
    expect(() => j.readSeed(empty)).toThrow(/not a journey seed file/);
  });
});

describe("run parameters", () => {
  it("returns one recorded field and refuses a run directory without them", () => {
    const out = mkdtempSync(join(dir, "params-"));
    writeFileSync(
      join(out, "run-params.json"),
      JSON.stringify({ network: "testnet", journey: "hold", relayerKeyFile: "/k/ed25519_x.json" }),
    );
    expect(tool(["run-params", "--dir", out, "--field", "journey"]).out).toBe("hold");
    const missing = tool(["run-params", "--dir", out, "--field", "amountYocto"]);
    expect(missing.status).toBe(2);
    expect(missing.err).toContain("NOTHING_TO_RESUME");
    expect(tool(["run-params", "--dir", join(dir, "nope"), "--field", "network"]).err).toContain(
      "NOTHING_TO_RESUME",
    );
  });
});

describe("journey option guards (before any RPC call)", () => {
  const base = ["journey", "--network", "sandbox", "--rpc-url", "http://127.0.0.1:9", "--out", dir];
  it("refuses an unknown journey, a bad excess, --stop-after and --pending-tx values", () => {
    const cases: [string[], RegExp][] = [
      [["--journey", "abandon", "--amount-yocto", "1"], /--journey must be one of/],
      [["--journey", "refund", "--amount-yocto", "1", "--excess-yocto", "0"], /--excess-yocto/],
      [["--journey", "paid", "--amount-yocto", "1", "--stop-after", "0"], /--stop-after/],
      [["--resume", "--pending-tx", "not-a-hash"], /--pending-tx/],
    ];
    for (const [extra, msg] of cases) {
      const r = tool([...base, ...extra]);
      expect(r.status, extra.join(" ")).toBe(2);
      expect(r.err).toMatch(msg);
      expect(r.err).not.toContain("RPC_UNAVAILABLE");
    }
  });

  it("the preflight counts the refund journey's excess in the buyer's balance", () => {
    const src = readFileSync(TOOL, "utf8");
    expect(src).toMatch(/journey === "refund" \? amt \+ excess\(f\) : amt/);
  });
});

describe("run-all wiring", () => {
  const script = readFileSync(RUN_ALL, "utf8");
  it("takes every setting of a resumed run from its run directory", () => {
    for (const field of [
      "network",
      "rpcUrl",
      "journey",
      "amountYocto",
      "wasm",
      "manifest",
      "relayerKeyFile",
    ]) {
      expect(script).toContain(`run-params --dir "$OUT" --field ${field}`);
    }
    expect(script).toMatch(/--resume takes the run's own settings/);
    expect(script).toMatch(/--pending-tx needs --resume/);
    expect(script).toMatch(/RUN_EXISTS/);
  });
  it("reports a paused journey with exit status 3 and the resume command", () => {
    expect(script).toMatch(/if \[ "\$STATUS" -eq 3 \]; then/);
    expect(script).toMatch(/run-all --resume \$OUT/);
  });
});
