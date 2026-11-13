/**
 * M50: run-all `--asset usdc --token <id>` and `--network mainnet` behind `--i-understand-real-funds`
 * (scripts/testnet-deploy). These are the guards that run before anything is sent: the network
 * and account rules, the asset and amount flags, the `new` arguments, the exposure check and the
 * value plan. The journeys themselves run against a real near-sandbox node in
 * contract/integration/sandbox-tests/tests/run_all_on_sandbox.rs; nothing here or there talks to
 * NEAR testnet or mainnet.
 *
 * IDs: T-043 (corridor tooling and refusals), T-007 / T-019 (run-all journeys), T-008 / T-009.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TOOL = join(ROOT, "scripts/testnet-deploy/tool.mjs");
const lib = (name: string) => pathToFileURL(join(ROOT, "scripts/testnet-deploy/lib", name)).href;

interface Profile {
  network: string;
  cliNetwork: string;
  rpcUrl: string;
  contractNetwork: string;
  realFunds: boolean;
  chainId: string | null;
}
interface Asset {
  kind: "near" | "nep141";
  token: { accountId: string; decimals: number } | null;
}
interface Caps {
  nearYocto: bigint;
  nep141: bigint;
}
type Flags = Record<string, string | boolean | undefined>;
const tools = (await import(lib("near-tools.mjs"))) as {
  networkProfile(
    network: string | undefined,
    rpcUrl?: string,
    fallbacks?: string[],
    opts?: { contractNetwork?: string; realFunds?: boolean },
  ): Profile;
  accountsFromEnv(env: Record<string, string>, contractNetwork?: string): Record<string, string>;
};
const plan = (await import(lib("plan.mjs"))) as {
  assetFromFlags(f: Flags): Asset;
  amountsFromFlags(f: Flags, asset: Asset, journey: string): { amount: bigint; excess: bigint };
  capsFromFlags(f: Flags, contractNetwork: string): Caps | null;
  capsFromConfig(config: unknown): Caps;
  ceilingFromFlags(f: Flags): Caps;
  initArgs(o: { contractNetwork: string; caps: Caps | null; token: Asset["token"] }): Record<string, unknown>;
  checkExposure(o: {
    asset: Asset;
    amounts: { amount: bigint; excess: bigint };
    caps: Caps | null;
    realFunds: boolean;
    ceiling: Caps;
  }): { heldAtMost: bigint; cap: bigint };
  valuePlan(o: Record<string, unknown>): { what: string; from: string; to: string; amount: string }[];
  human(units: bigint, decimals: number): string;
};
const journey = (await import(lib("journey.mjs"))) as {
  planMethods(journey: string, asset?: Asset): { id: string; what?: string }[];
};

const NEAR = 10n ** 24n;
const USDC = 1_000_000n;
const MAINNET_USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const TESTNET_ACCOUNTS = {
  DOCKSIDE_ESCROW_ACCOUNT: "dockside-escrow.testnet",
  DOCKSIDE_BUYER_ACCOUNT: "acme-buyer.testnet",
  DOCKSIDE_SUPPLIER_ACCOUNT: "harbor-supplier.testnet",
  DOCKSIDE_RELAYER_ACCOUNT: "relayer.testnet",
};
const MAINNET_ACCOUNTS = {
  DOCKSIDE_ESCROW_ACCOUNT: "escrow.dockside.near",
  DOCKSIDE_BUYER_ACCOUNT: "buyer.dockside.near",
  DOCKSIDE_SUPPLIER_ACCOUNT: "supplier.dockside.near",
  DOCKSIDE_RELAYER_ACCOUNT: "relayer.dockside.near",
};

function tool(args: string[], env: Record<string, string> = TESTNET_ACCOUNTS) {
  const clean = { ...process.env };
  for (const k of Object.keys(TESTNET_ACCOUNTS)) delete clean[k];
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8", env: { ...clean, ...env } });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}
const code = (fn: () => unknown): string => {
  try {
    fn();
    return "OK";
  } catch (e) {
    return (e as { code?: string }).code ?? "ERROR";
  }
};

describe("mainnet is behind an explicit real-funds flag", () => {
  it("refuses --network mainnet without the flag and accepts it with the flag", () => {
    expect(code(() => tools.networkProfile("mainnet"))).toBe("NETWORK_REFUSED");
    expect(code(() => tools.networkProfile("mainnet", undefined, [], { realFunds: false }))).toBe(
      "NETWORK_REFUSED",
    );
    const p = tools.networkProfile("mainnet", undefined, [], { realFunds: true });
    expect(p).toMatchObject({
      network: "mainnet",
      cliNetwork: "mainnet",
      rpcUrl: "https://rpc.mainnet.fastnear.com",
      contractNetwork: "near-mainnet",
      realFunds: true,
      chainId: "mainnet",
    });
    // The CLI says the same, and names the flag in the refusal.
    const refused = tool(["profile", "--network", "mainnet", "--field", "rpcUrl"]);
    expect(refused.status).toBe(2);
    expect(refused.err).toContain("NETWORK_REFUSED");
    expect(refused.err).toContain("--i-understand-real-funds");
    const ok = tool(["profile", "--network", "mainnet", "--i-understand-real-funds", "--field", "cliNetwork"]);
    expect([ok.status, ok.out]).toEqual([0, "mainnet"]);
    expect(
      tool(["profile", "--network", "mainnet", "--i-understand-real-funds", "--field", "contractNetwork"]).out,
    ).toBe("near-mainnet");
  });

  it("keeps mainnet and testnet endpoints apart", () => {
    const real = { realFunds: true };
    for (const url of ["http://rpc.mainnet.fastnear.com", "https://test.rpc.fastnear.com", "https://rpc.testnet.near.org", "http://127.0.0.1:3030"]) {
      expect(code(() => tools.networkProfile("mainnet", url, [], real)), url).toBe("NETWORK_REFUSED");
    }
    expect(code(() => tools.networkProfile("mainnet", undefined, ["https://rpc.testnet.fastnear.com"], real))).toBe(
      "NETWORK_REFUSED",
    );
    // Testnet stays testnet: the flag does not turn it into something else, and it cannot carry the mainnet label.
    expect(tools.networkProfile("testnet", undefined, [], real)).toMatchObject({
      contractNetwork: "near-testnet",
      chainId: "testnet",
      realFunds: false,
    });
    expect(code(() => tools.networkProfile("testnet", undefined, [], { contractNetwork: "near-mainnet", realFunds: true }))).toBe(
      "NETWORK_REFUSED",
    );
    expect(code(() => tools.networkProfile("mainnet", undefined, [], { contractNetwork: "near-testnet", realFunds: true }))).toBe(
      "NETWORK_REFUSED",
    );
  });

  it("validates the mainnet label on a loopback sandbox only with the same flag", () => {
    expect(code(() => tools.networkProfile("sandbox", undefined, [], { contractNetwork: "near-mainnet" }))).toBe(
      "NETWORK_REFUSED",
    );
    const p = tools.networkProfile("sandbox", undefined, [], { contractNetwork: "near-mainnet", realFunds: true });
    expect(p).toMatchObject({ cliNetwork: "sandbox", contractNetwork: "near-mainnet", realFunds: true, chainId: null });
    expect(p.rpcUrl).toBe("http://127.0.0.1:4521");
    expect(code(() => tools.networkProfile("sandbox", "https://rpc.mainnet.fastnear.com", [], { contractNetwork: "near-mainnet", realFunds: true }))).toBe(
      "NETWORK_REFUSED",
    );
    expect(code(() => tools.networkProfile("sandbox", undefined, [], { contractNetwork: "near-betanet", realFunds: true }))).toBe(
      "NETWORK_REFUSED",
    );
    expect(tools.networkProfile("sandbox")).toMatchObject({ contractNetwork: "near-testnet", realFunds: false });
  });

  it("names accounts by the contract's network label", () => {
    expect(tools.accountsFromEnv(MAINNET_ACCOUNTS, "near-mainnet")).toEqual({
      escrow: "escrow.dockside.near",
      buyer: "buyer.dockside.near",
      supplier: "supplier.dockside.near",
      relayer: "relayer.dockside.near",
    });
    expect(code(() => tools.accountsFromEnv(TESTNET_ACCOUNTS, "near-mainnet"))).toBe("INVALID_ACCOUNT");
    expect(code(() => tools.accountsFromEnv(MAINNET_ACCOUNTS, "near-testnet"))).toBe("INVALID_ACCOUNT");
    expect(code(() => tools.accountsFromEnv(MAINNET_ACCOUNTS))).toBe("INVALID_ACCOUNT");
    expect(code(() => tools.accountsFromEnv({ ...MAINNET_ACCOUNTS, DOCKSIDE_SUPPLIER_ACCOUNT: "buyer.dockside.near" }, "near-mainnet"))).toBe(
      "INVALID_ACCOUNT",
    );
    const cli = tool(["accounts", "--network", "mainnet", "--i-understand-real-funds"], MAINNET_ACCOUNTS);
    expect(JSON.parse(cli.out).escrow).toBe("escrow.dockside.near");
    expect(tool(["accounts", "--network", "mainnet", "--i-understand-real-funds"]).err).toContain("INVALID_ACCOUNT");
  });
});

describe("asset, amounts and the deployment arguments", () => {
  it("--asset usdc needs a token contract", () => {
    expect(plan.assetFromFlags({})).toEqual({ kind: "near", token: null });
    expect(plan.assetFromFlags({ asset: "usdc", token: MAINNET_USDC })).toEqual({
      kind: "nep141",
      token: { accountId: MAINNET_USDC, decimals: 6 },
    });
    expect(plan.assetFromFlags({ asset: "usdc", token: "usdc.fakes.testnet", "token-decimals": "18" }).token).toEqual({
      accountId: "usdc.fakes.testnet",
      decimals: 18,
    });
    // A token named with the default asset is only pinned at deployment.
    expect(plan.assetFromFlags({ token: MAINNET_USDC })).toEqual({ kind: "near", token: { accountId: MAINNET_USDC, decimals: 6 } });
    for (const f of [
      { asset: "usdc" },
      { asset: "usdt", token: MAINNET_USDC },
      { asset: "usdc", token: "Not An Account" },
      { asset: "usdc", token: "toplevel" },
      { asset: "usdc", token: MAINNET_USDC, "token-decimals": "25" },
      { asset: "usdc", token: true },
      { "token-decimals": "6" },
    ] as Flags[]) {
      expect(code(() => plan.assetFromFlags(f)), JSON.stringify(f)).toBe("USAGE");
    }
  });

  it("amounts are in base units of the asset and cannot be mixed up", () => {
    const usdc = plan.assetFromFlags({ asset: "usdc", token: MAINNET_USDC });
    const near = plan.assetFromFlags({});
    expect(plan.amountsFromFlags({}, usdc, "paid")).toEqual({ amount: 5n * USDC, excess: 0n });
    expect(plan.amountsFromFlags({}, usdc, "refund")).toEqual({ amount: 5n * USDC, excess: USDC });
    expect(plan.amountsFromFlags({ "amount-units": "2500000", "excess-units": "10000" }, usdc, "refund")).toEqual({
      amount: 2_500_000n,
      excess: 10_000n,
    });
    expect(plan.amountsFromFlags({}, near, "refund")).toEqual({ amount: 5n * 10n ** 22n, excess: 10n ** 22n });
    expect(code(() => plan.amountsFromFlags({ "amount-yocto": "5" }, usdc, "paid"))).toBe("USAGE");
    expect(code(() => plan.amountsFromFlags({ "amount-units": "5" }, near, "paid"))).toBe("USAGE");
    expect(code(() => plan.amountsFromFlags({ "amount-units": "0" }, usdc, "paid"))).toBe("USAGE");
    expect(code(() => plan.amountsFromFlags({ "amount-units": "5.5" }, usdc, "paid"))).toBe("USAGE");
  });

  it("a mainnet deployment is always initialised with non-zero caps and the pinned token", () => {
    const token = { accountId: MAINNET_USDC, decimals: 6 };
    const caps = plan.capsFromFlags({}, "near-mainnet");
    expect(caps).toEqual({ nearYocto: 5n * NEAR, nep141: 25n * USDC });
    expect(plan.initArgs({ contractNetwork: "near-mainnet", caps, token })).toEqual({
      network: "near-mainnet",
      min_deposit_yocto: null,
      max_trade_amount: { near_yocto: "5000000000000000000000000", nep141: "25000000" },
      nep141_token: { account_id: MAINNET_USDC, decimals: 6 },
      min_deposit_nep141: null,
    });
    expect(plan.capsFromFlags({ "cap-token-units": "10000000" }, "near-mainnet")).toEqual({
      nearYocto: 5n * NEAR,
      nep141: 10n * USDC,
    });
    expect(code(() => plan.capsFromFlags({ "cap-token-units": "0" }, "near-mainnet"))).toBe("USAGE");
    // Testnet: no caps unless asked for.
    expect(plan.capsFromFlags({}, "near-testnet")).toBeNull();
    expect(plan.initArgs({ contractNetwork: "near-testnet", caps: null, token: null })).toEqual({
      network: "near-testnet",
      min_deposit_yocto: null,
      max_trade_amount: null,
      nep141_token: null,
      min_deposit_nep141: null,
    });
    expect(plan.capsFromFlags({ "cap-token-units": "6000000" }, "near-testnet")).toEqual({ nearYocto: 0n, nep141: 6n * USDC });
    // The CLI prints the same JSON the deploy step sends.
    const cli = tool(
      ["init-args", "--network", "mainnet", "--i-understand-real-funds", "--asset", "usdc", "--token", MAINNET_USDC],
      MAINNET_ACCOUNTS,
    );
    expect(JSON.parse(cli.out)).toEqual(plan.initArgs({ contractNetwork: "near-mainnet", caps, token }));
    expect(JSON.parse(tool(["init-args", "--network", "testnet"]).out).network).toBe("near-testnet");
  });
});

describe("exposure check and value plan", () => {
  const usdc = plan.assetFromFlags({ asset: "usdc", token: MAINNET_USDC });
  const near = plan.assetFromFlags({});
  const mainnetCaps = { nearYocto: 5n * NEAR, nep141: 25n * USDC };
  const ceiling = plan.ceilingFromFlags({});

  it("a real-funds run needs caps, within run-all's own ceiling, and must fit them", () => {
    expect(ceiling).toEqual(mainnetCaps);
    const ok = plan.checkExposure({ asset: usdc, amounts: { amount: 5n * USDC, excess: USDC }, caps: mainnetCaps, realFunds: true, ceiling });
    expect(ok).toMatchObject({ heldAtMost: 6n * USDC, cap: 25n * USDC });
    const cases: [string, Parameters<typeof plan.checkExposure>[0]][] = [
      ["CAP_REQUIRED", { asset: usdc, amounts: { amount: 5n * USDC, excess: 0n }, caps: null, realFunds: true, ceiling }],
      ["CAP_REQUIRED", { asset: usdc, amounts: { amount: 5n * USDC, excess: 0n }, caps: { nearYocto: 0n, nep141: 25n * USDC }, realFunds: true, ceiling }],
      ["EXPOSURE_EXCEEDED", { asset: usdc, amounts: { amount: 25n * USDC, excess: 1n }, caps: mainnetCaps, realFunds: true, ceiling }],
      ["EXPOSURE_EXCEEDED", { asset: near, amounts: { amount: 5n * NEAR, excess: 1n }, caps: mainnetCaps, realFunds: true, ceiling }],
      // A contract whose cap is above run-all's ceiling is not one run-all sends real funds to.
      ["EXPOSURE_EXCEEDED", { asset: usdc, amounts: { amount: 5n * USDC, excess: 0n }, caps: { nearYocto: 5n * NEAR, nep141: 1_000n * USDC }, realFunds: true, ceiling }],
      // Test funds: only the contract's own cap, when it has one.
      ["EXPOSURE_EXCEEDED", { asset: usdc, amounts: { amount: 6n * USDC, excess: 1n }, caps: { nearYocto: 0n, nep141: 6n * USDC }, realFunds: false, ceiling }],
    ];
    for (const [want, o] of cases) expect(code(() => plan.checkExposure(o)), JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(want);
    expect(code(() => plan.checkExposure({ asset: usdc, amounts: { amount: 500n * USDC, excess: 0n }, caps: null, realFunds: false, ceiling }))).toBe("OK");
    // The ceiling can only be widened on purpose.
    const wide = plan.ceilingFromFlags({ "max-exposure-token-units": "1000000000" });
    expect(code(() => plan.checkExposure({ asset: usdc, amounts: { amount: 5n * USDC, excess: 0n }, caps: { nearYocto: 5n * NEAR, nep141: 1_000n * USDC }, realFunds: true, ceiling: wide }))).toBe("OK");
  });

  it("reads caps from the contract's own config", () => {
    expect(plan.capsFromConfig({ maxTradeAmount: { nearYocto: "5000000000000000000000000", nep141: "25000000" } })).toEqual(mainnetCaps);
    expect(code(() => plan.capsFromConfig({ network: "near-testnet" }))).toBe("CONFIG_MISMATCH");
  });

  it("the plan lists every amount, sender and receiver before anything is sent", () => {
    const accounts = { escrow: "escrow.dockside.near", buyer: "buyer.dockside.near", supplier: "supplier.dockside.near", relayer: "relayer.dockside.near" };
    const rows = plan.valuePlan({
      journey: "refund",
      asset: usdc,
      amounts: { amount: 5n * USDC, excess: USDC },
      accounts,
      deploy: true,
      relayerKey: true,
      registrations: [accounts.escrow, accounts.supplier],
      storageDepositYocto: 1_250_000_000_000_000_000_000n,
    });
    const text = rows.map((r) => `${r.what} | ${r.from} -> ${r.to} | ${r.amount}`).join("\n");
    expect(text).toContain("6000000 units of");
    expect(text).toContain("(6 tokens)");
    expect(text).toContain("5000000 units of");
    expect(text).toContain("1000000 units of");
    expect(text).toContain("1250000000000000000000 yoctoNEAR (0.00125 NEAR)");
    expect(text).toContain("1 yoctoNEAR");
    const fund = rows.find((r) => r.what.startsWith("fund"));
    expect([fund?.from, fund?.to]).toEqual([accounts.buyer, accounts.escrow]);
    // Refunds go to the buyer only; nothing in a refund run is addressed to the supplier.
    expect(rows.filter((r) => r.what.startsWith("refund")).map((r) => r.to)).toEqual([accounts.buyer, accounts.buyer]);
    expect(rows.some((r) => r.to === accounts.supplier)).toBe(false);
    const paid = plan.valuePlan({ journey: "paid", asset: near, amounts: { amount: NEAR / 20n, excess: 0n }, accounts, deploy: false, relayerKey: false });
    expect(paid.find((r) => r.what === "release")).toMatchObject({ to: accounts.supplier, amount: "50000000000000000000000 yoctoNEAR (0.05 NEAR)" });
    expect(plan.human(1n, 6)).toBe("0.000001");
    expect(plan.human(25_000_000n, 6)).toBe("25");
  });
});

describe("journey plans for a token trade", () => {
  const usdc: Asset = { kind: "nep141", token: { accountId: MAINNET_USDC, decimals: 6 } };
  it("checks the payee's token registration before the value is locked", () => {
    expect(journey.planMethods("paid", usdc).map((s) => s.id)).toEqual([
      "register",
      "policy",
      "fund",
      "attestation",
      "inspection",
      "payee_storage",
      "intent",
      "approval",
      "execute_release",
    ]);
    const hold = journey.planMethods("hold", usdc).map((s) => s.id);
    expect(hold.indexOf("payee_storage")).toBe(hold.indexOf("intent") - 1);
    expect(hold).toContain("hold_set");
    // A refund pays the funder, which is registered by holding the token: no payee step.
    expect(journey.planMethods("refund", usdc).map((s) => s.id)).not.toContain("payee_storage");
    // Native journeys are unchanged.
    expect(journey.planMethods("paid").map((s) => s.id)).not.toContain("payee_storage");
    expect(journey.planMethods("paid", { kind: "near", token: null }).length).toBe(8);
  });
});

describe("run-all refuses before any step", () => {
  // `check-run` is the first thing run-all does with its flags; it reads no chain and sends nothing.
  it("mainnet without the flag, usdc without a token, and mixed-up amount flags", () => {
    const cases: [string[], Record<string, string>, string][] = [
      [["--network", "mainnet"], MAINNET_ACCOUNTS, "NETWORK_REFUSED"],
      [
        ["--network", "mainnet", "--i-understand-real-funds", "--rpc-url", "https://test.rpc.fastnear.com"],
        MAINNET_ACCOUNTS,
        "NETWORK_REFUSED",
      ],
      [["--network", "mainnet", "--i-understand-real-funds"], TESTNET_ACCOUNTS, "INVALID_ACCOUNT"],
      [["--network", "testnet", "--asset", "usdc"], TESTNET_ACCOUNTS, "--asset usdc needs --token"],
      [
        ["--network", "testnet", "--asset", "usdc", "--token", "usdc.fakes.testnet", "--amount-yocto", "5"],
        TESTNET_ACCOUNTS,
        "--amount-units",
      ],
      [
        ["--network", "testnet", "--contract-network", "near-mainnet", "--i-understand-real-funds"],
        TESTNET_ACCOUNTS,
        "NETWORK_REFUSED",
      ],
      [["--network", "sandbox", "--contract-network", "near-mainnet"], MAINNET_ACCOUNTS, "--i-understand-real-funds"],
      [["--network", "testnet", "--journey", "payout"], TESTNET_ACCOUNTS, "--journey"],
    ];
    for (const [args, env, want] of cases) {
      const r = tool(["check-run", ...args], env);
      expect(r.status, `${args.join(" ")}: ${r.err}`).toBe(2);
      expect(r.err, args.join(" ")).toContain(want);
    }
    const ok = tool(
      ["check-run", "--network", "mainnet", "--i-understand-real-funds", "--asset", "usdc", "--token", MAINNET_USDC, "--journey", "refund"],
      MAINNET_ACCOUNTS,
    );
    expect(JSON.parse(ok.out)).toMatchObject({
      network: "mainnet",
      contractNetwork: "near-mainnet",
      realFunds: true,
      asset: "usdc",
      token: MAINNET_USDC,
      amount: "5000000",
      excess: "1000000",
    });
  });

  it("the script checks its flags first, deploys with the computed arguments and can stop after the plan", () => {
    const script = readFileSync(join(ROOT, "scripts/testnet-deploy/run-all"), "utf8");
    const at = (needle: string) => {
      const i = script.indexOf(needle);
      expect(i, needle).toBeGreaterThan(0);
      return i;
    };
    const check = at('node "$TOOL" check-run $(net_flags) $ASSET_FLAGS --journey "$JOURNEY"');
    const preflight = at('node "$TOOL" preflight $(net_flags)');
    const dry = at('if [ -n "$DRY_RUN" ]; then');
    const deploy = at("contract deploy");
    expect(check).toBeLessThan(preflight);
    expect(preflight).toBeLessThan(dry);
    expect(dry).toBeLessThan(deploy);
    // No fixed `new` arguments are left in the script: the network label, caps and token come from init-args.
    expect(script).toContain('INIT_ARGS=$(node "$TOOL" init-args $(net_flags) $ASSET_FLAGS)');
    expect(script).not.toContain(`json-args '{"network"`);
    // The real-funds flag is never stored: a resumed run must be given it again.
    expect(script).toContain("--i-understand-real-funds) REAL_FUNDS=1; shift ;;");
    const lines = script.split(/\r?\n/);
    expect(lines.some((l) => l.includes("run-params") && /realFunds|REAL_FUNDS/.test(l))).toBe(false);
  });
});
