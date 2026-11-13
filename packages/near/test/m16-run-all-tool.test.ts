/**
 * M16: the read-only guards of scripts/testnet-deploy/run-all (tool.mjs), run as the script runs
 * them, as separate node processes. The full run-all flow is validated on a local near-sandbox
 * node by contract/integration/sandbox-tests/tests/run_all_on_sandbox.rs (container only).
 * IDs: T-045 (artifact digest and code hash checks), T-043 (testnet corridor half, refusals).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { base58Encode } from "@dockside/core";
import { afterAll, describe, expect, it } from "vitest";

const TOOL = fileURLToPath(new URL("../../../scripts/testnet-deploy/tool.mjs", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "dockside-m16-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ACCOUNTS = {
  DOCKSIDE_ESCROW_ACCOUNT: "dockside-escrow.testnet",
  DOCKSIDE_BUYER_ACCOUNT: "acme-buyer.testnet",
  DOCKSIDE_SUPPLIER_ACCOUNT: "harbor-supplier.testnet",
  DOCKSIDE_RELAYER_ACCOUNT: "relayer.testnet",
};

function tool(args: string[], env: Record<string, string | undefined> = {}) {
  const clean = { ...process.env };
  for (const k of Object.keys(ACCOUNTS)) delete clean[k];
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8", env: { ...clean, ...env } });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

describe("run-all network guard", () => {
  it("accepts only testnet (https, non-mainnet host) and a loopback sandbox", () => {
    expect(tool(["profile", "--network", "testnet", "--field", "rpcUrl"]).out).toBe(
      "https://test.rpc.fastnear.com",
    );
    expect(tool(["profile", "--network", "testnet", "--field", "cliNetwork"]).out).toBe("testnet");
    expect(tool(["profile", "--network", "sandbox", "--field", "rpcUrl"]).out).toBe("http://127.0.0.1:4521");
    expect(tool(["profile", "--network", "sandbox", "--field", "cliNetwork"]).out).toBe("sandbox");
    const refused = [
      ["--network", "mainnet"],
      ["--network", "near-mainnet"],
      [],
      ["--network", "testnet", "--rpc-url", "http://test.rpc.fastnear.com"],
      ["--network", "testnet", "--rpc-url", "https://rpc.mainnet.near.org"],
      ["--network", "sandbox", "--rpc-url", "http://10.0.0.5:3030"],
      ["--network", "sandbox", "--rpc-url", "http://test.rpc.fastnear.com"],
    ];
    for (const a of refused) {
      const r = tool(["profile", ...a, "--field", "rpcUrl"]);
      expect(r.status, a.join(" ")).toBe(2);
      expect(r.err).toContain("NETWORK_REFUSED");
    }
  });
});

describe("run-all account names", () => {
  it("requires four distinct named .testnet accounts", () => {
    expect(JSON.parse(tool(["accounts"], ACCOUNTS).out)).toEqual({
      escrow: "dockside-escrow.testnet",
      buyer: "acme-buyer.testnet",
      supplier: "harbor-supplier.testnet",
      relayer: "relayer.testnet",
    });
    const cases: [Record<string, string>, string][] = [
      [{ ...ACCOUNTS, DOCKSIDE_RELAYER_ACCOUNT: "" }, "MISSING_ACCOUNT"],
      [{ ...ACCOUNTS, DOCKSIDE_BUYER_ACCOUNT: "acme-buyer.near" }, "INVALID_ACCOUNT"],
      [{ ...ACCOUNTS, DOCKSIDE_ESCROW_ACCOUNT: "Escrow.testnet" }, "INVALID_ACCOUNT"],
      [{ ...ACCOUNTS, DOCKSIDE_SUPPLIER_ACCOUNT: "acme-buyer.testnet" }, "INVALID_ACCOUNT"],
    ];
    for (const [env, code] of cases) {
      const r = tool(["accounts"], env);
      expect(r.status).toBe(2);
      expect(r.err).toContain(code);
    }
  });
});

describe("run-all artifact check", () => {
  const wasm = Buffer.from("0061736d01000000", "hex");
  const wasmFile = join(dir, "escrow.wasm");
  writeFileSync(wasmFile, wasm);
  const digest = createHash("sha256").update(wasm).digest();
  const manifest = (contract: Record<string, string>) => {
    const f = join(dir, `manifest-${Object.values(contract).join("-").slice(0, 16)}.json`);
    writeFileSync(f, JSON.stringify({ commit: "abc", toolchain: { platform: "linux-x64" }, contract }));
    return f;
  };

  it("passes only when the SHA-256 and the NEAR code hash both equal the manifest's", () => {
    const good = manifest({
      sha256: digest.toString("hex"),
      nearCodeHash: base58Encode(new Uint8Array(digest)),
    });
    const r = tool(["verify-artifact", "--wasm", wasmFile, "--manifest", good]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({
      bytes: 8,
      sha256: digest.toString("hex"),
      nearCodeHash: base58Encode(new Uint8Array(digest)),
      commit: "abc",
    });
    for (const bad of [
      manifest({ sha256: "00".repeat(32), nearCodeHash: base58Encode(new Uint8Array(digest)) }),
      manifest({ sha256: digest.toString("hex"), nearCodeHash: "11111111111111111111111111111111" }),
    ]) {
      const x = tool(["verify-artifact", "--wasm", wasmFile, "--manifest", bad]);
      expect(x.status).toBe(2);
      expect(x.err).toContain("WASM_MISMATCH");
    }
    const none = manifest({});
    expect(tool(["verify-artifact", "--wasm", wasmFile, "--manifest", none]).err).toContain(
      "MANIFEST_INVALID",
    );
  });
});

describe("run-all near-cli-rs output parsing", () => {
  const esc = "\u001b[";
  it("reads the transaction id and the saved function-call key file, never key material", () => {
    const deploy = join(dir, "deploy.txt");
    writeFileSync(
      deploy,
      `├  Transaction Execution Info:\n│    Transaction ID: ${esc}33m4r6P8FKrUinVTJmr1RhMrYewhzN1o9gBRHEY16DqUFki${esc}39m\n`,
    );
    expect(tool(["tx-hash", "--file", deploy]).out).toBe("4r6P8FKrUinVTJmr1RhMrYewhzN1o9gBRHEY16DqUFki");
    const empty = join(dir, "empty.txt");
    writeFileSync(empty, "Error: The input device is not a TTY\n");
    expect(tool(["tx-hash", "--file", empty]).err).toContain("NO_TX");

    const added = join(dir, "add-key.txt");
    writeFileSync(
      added,
      [
        "Added access key = ed25519:86UwXUk4jXk9PqECP5MTH2vvHVmuamqXkn4GTRgBGAgj to relayer.testnet.",
        "The data for the access key is saved in a file /home/u/.near-credentials/testnet/relayer.testnet/ed25519_86UwXUk4jXk9PqECP5MTH2vvHVmuamqXkn4GTRgBGAgj.json",
        "The data for the access key is saved in a file /home/u/.near-credentials/testnet/relayer.testnet.json",
      ].join("\n"),
    );
    expect(tool(["relayer-key-file", "--file", added]).out).toBe(
      "/home/u/.near-credentials/testnet/relayer.testnet/ed25519_86UwXUk4jXk9PqECP5MTH2vvHVmuamqXkn4GTRgBGAgj.json",
    );
    expect(tool(["relayer-key-file", "--file", empty]).err).toContain("NO_KEY");
  });

  it("rejects unknown subcommands and malformed amounts", () => {
    expect(tool(["deploy-to-mainnet"]).err).toContain("USAGE");
    const r = tool(["preflight", "--network", "sandbox", "--wasm", "x", "--amount-yocto", "-1"], ACCOUNTS);
    expect(r.status).toBe(2);
    expect(r.err).toContain("USAGE");
  });
});
