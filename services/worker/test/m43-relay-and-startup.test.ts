/**
 * M43 party relay (what the web server proxies as /relay on a real chain) and the worker's
 * fail-closed startup. The relay only forwards escrow calls whose authority is a signature inside
 * the arguments, with no deposit, from the web origin; the worker refuses to start without a
 * provisioned signer, and refuses (before touching the network) without the escrow manifest.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PartyRelay, RELAYABLE_METHODS, relayableCall } from "../src/relay.js";
import type { RelayResult } from "../src/submit.js";

const ESCROW = "dockside-escrow.testnet";
const ORIGIN = "http://127.0.0.1:4399";
const call = (o: Record<string, unknown> = {}) => ({
  receiverId: ESCROW,
  methodName: "approve_release",
  args: { trade_id: "trd_1", payload: {}, signature: "ed25519:x" },
  gas: "50000000000000",
  depositYocto: "0",
  ...o,
});

describe("M43 relayable calls", () => {
  it("accepts a signature-carrying escrow call and returns exactly that call", () => {
    expect(relayableCall(call(), ESCROW)).toEqual(call());
  });

  it("refuses deposits, other receivers, wallet-only methods, extra fields and absurd gas", () => {
    const refused = (c: unknown) => {
      try {
        relayableCall(c, ESCROW);
        return "accepted";
      } catch (e) {
        return (e as { code: string }).code;
      }
    };
    expect(refused(call({ depositYocto: "1" }))).toBe("INVALID_AMOUNT");
    expect(refused(call({ receiverId: "other.testnet" }))).toBe("WRONG_CONTRACT");
    for (const m of [
      "fund",
      "new",
      "request_asset_recovery",
      "challenge_asset_recovery",
      "revoke_asset_recovery",
    ])
      expect(refused(call({ methodName: m }))).toBe("FORBIDDEN");
    expect(refused({ ...call(), extra: 1 })).toBe("VALIDATION_FAILED");
    expect(refused(call({ gas: "300000000000001" }))).toBe("VALIDATION_FAILED");
    expect(refused(call({ args: [] }))).toBe("VALIDATION_FAILED");
    expect(refused(null)).toBe("VALIDATION_FAILED");
    expect(RELAYABLE_METHODS.has("fund")).toBe(false);
  });
});

describe("M43 party relay over HTTP", () => {
  const submitted: unknown[] = [];
  const relay = new PartyRelay({
    escrowId: ESCROW,
    origin: ORIGIN,
    status: {
      relayer: "relayer.testnet",
      contractId: ESCROW,
      network: "near-testnet",
      chain: "NEAR_TESTNET",
      note: "n",
    },
    submit: async (c): Promise<RelayResult> => {
      submitted.push(c);
      return { txHash: "H", outcome: "FINAL_SUCCESS", error: null, method: c.methodName };
    },
    perMinute: 3,
  });
  let base = "";
  beforeAll(async () => {
    base = `http://127.0.0.1:${await relay.listen(0)}`;
  });
  afterAll(() => relay.close());

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/relay/v1/calls`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("serves its status and relays an allowed call", async () => {
    const st = await fetch(`${base}/relay/v1/status`);
    expect(await st.json()).toMatchObject({ contractId: ESCROW, chain: "NEAR_TESTNET" });
    const r = await post({ call: call() });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      txHash: "H",
      outcome: "FINAL_SUCCESS",
      error: null,
      method: "approve_release",
    });
    expect(submitted).toEqual([call()]);
  });

  it("refuses another origin, a non-JSON body type and a wallet-only call without submitting", async () => {
    const n = submitted.length;
    expect((await post({ call: call() }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(JSON.stringify({ call: call() }), { "content-type": "text/plain" })).status).toBe(415);
    const fund = await post({ call: call({ methodName: "fund", depositYocto: "5" }) });
    expect(fund.status).toBe(403);
    expect(((await fund.json()) as { error: string }).error).toMatch(/^FORBIDDEN|^INVALID_AMOUNT/);
    expect(submitted.length).toBe(n);
  });

  it("rate-limits relayed calls", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await post({ call: call() })).status);
    expect(statuses).toContain(429);
  });
});

describe("M43 worker startup is fail-closed", () => {
  const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
  const WORKER = join(ROOT, "services/worker/dist/main.js");
  const dir = mkdtempSync(join(tmpdir(), "dockside-m43-worker-"));
  const env = (extra: Record<string, string>) => {
    const base: NodeJS.ProcessEnv = {};
    for (const k of ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE"])
      if (process.env[k] !== undefined) base[k] = process.env[k];
    return { ...base, NODE_NO_WARNINGS: "1", DOCKSIDE_DB_PATH: join(dir, "w.sqlite"), ...extra };
  };
  const run = (extra: Record<string, string>) => {
    const r = spawnSync(process.execPath, [WORKER], { env: env(extra), encoding: "utf8", timeout: 30_000 });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };

  it("refuses without a provisioned signer (exit 78), and with one but no escrow manifest", () => {
    const none = run({});
    expect(none.status).toBe(78);
    expect(none.out).toContain("RELAYER_SIGNER_NOT_PROVISIONED");
    const noManifest = run({
      DOCKSIDE_RELAYER_ACCOUNT_ID: "relayer.testnet",
      DOCKSIDE_RELAYER_KEY_FILE: join(dir, "absent-key.json"),
      DOCKSIDE_ESCROW_CONTRACT_ID: ESCROW,
      DOCKSIDE_NEAR_RPC_URL: "https://test.rpc.fastnear.com",
    });
    expect(noManifest.status).toBe(78);
    expect(noManifest.out).toContain('"event":"worker.refused"');
    expect(noManifest.out).toContain("DOCKSIDE_ESCROW_MANIFEST");
  });

  it("refuses mainnet before anything else", () => {
    const r = run({ DOCKSIDE_NETWORK: "near-mainnet" });
    expect(r.status).toBe(78);
    expect(r.out).toContain("CONFIG_INVALID");
    const rpc = run({
      DOCKSIDE_RELAYER_ACCOUNT_ID: "relayer.testnet",
      DOCKSIDE_RELAYER_KEY_FILE: join(dir, "absent-key.json"),
      DOCKSIDE_ESCROW_CONTRACT_ID: ESCROW,
      DOCKSIDE_NEAR_RPC_URL: "https://rpc.mainnet.near.org",
      DOCKSIDE_ESCROW_MANIFEST: join(dir, "absent-manifest.json"),
    });
    expect(rpc.status).toBe(78);
    expect(rpc.out).toContain("MAINNET_REFUSED");
  });
});
