/**
 * M17 NEAR account ownership against a REAL nearcore node: the local NEAR sandbox (nearcore's sandbox
 * build) in a Linux container on this machine, not testnet. Opt-in: runs only with
 * DOCKSIDE_NEAR_SANDBOX=1 (`pnpm run test:sandbox`), because it needs Docker inside WSL and downloads
 * the sandbox binary into the container. Port 4531 on the loopback interface carries its RPC.
 *
 * The test generates a wallet key here; the container's genesis gives the account `dockside-wallet.testnet`
 * that public key as its only full-access key (the private key never leaves this process). Then:
 * the production JsonRpcNearClient reads `view_access_key` and the final block from nearcore, and the
 * real API links the account from a NEP-413 signature only when nearcore confirms the key.
 */
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { exportPublicKey, generateEd25519KeyPair, loadConfig, randomIds } from "@dockside/core";
import { JsonRpcNearClient, NearTxClient } from "@dockside/near";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Actor,
  bootstrap,
  enrollHuman,
  type Harness,
  makeHarness,
  ORIGIN,
} from "../../../packages/authority/test/helpers.js";
import { createApp } from "../src/app.js";

const ENABLED = process.env["DOCKSIDE_NEAR_SANDBOX"] === "1";
const PORT = Number(process.env["DOCKSIDE_NEAR_SANDBOX_PORT"] ?? 4531);
const RPC = `http://127.0.0.1:${PORT}`;
const CONTAINER = "dockside-m17-near-sandbox";
// The sandbox 2.13.4 binary needs glibc 2.38+, so Debian 13 (trixie), not bookworm.
const IMAGE = "node:22-trixie-slim";
const SANDBOX_PACKAGE = "near-sandbox@0.3.4";
// Named like a testnet account because this API is configured for near-testnet account ids.
const ACCOUNT = "dockside-wallet.testnet";

const keys = generateKeyPairSync("ed25519");
const walletPublicKey = exportPublicKey(keys.publicKey);

function docker(args: string[], timeout = 120_000) {
  return spawnSync("wsl.exe", ["-d", "Ubuntu-24.04", "-u", "root", "--", "docker", ...args], {
    encoding: "utf8",
    timeout,
    env: { ...process.env, MSYS_NO_PATHCONV: "1" },
  });
}

/** C:\a\b -> /mnt/c/a/b */
function wslPath(p: string): string {
  return p.replace(/^([A-Za-z]):\\/, (_m, d: string) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, "/");
}

function nep413Sign(message: string, nonce: Buffer, recipient: string): string {
  const u32 = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v >>> 0, 0);
    return b;
  };
  const str = (s: string) => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s)]);
  const payload = Buffer.concat([u32(2 ** 31 + 413), str(message), nonce, str(recipient), Buffer.from([0])]);
  return sign(null, createHash("sha256").update(payload).digest(), keys.privateKey).toString("base64");
}

async function rpcReady(deadline: number): Promise<number> {
  const client = new NearTxClient(rpc());
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      // Wait until the node produces blocks past genesis, so every observation has a real height.
      const h = (await client.latestBlock()).height;
      if (h >= 3) return h;
      last = new Error(`final block height ${h}`);
      await new Promise((r) => setTimeout(r, 1000));
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error(`sandbox RPC not ready: ${String((last as Error)?.message ?? last)}`);
}

function rpc() {
  return new JsonRpcNearClient({
    endpoint: RPC,
    allowedHosts: ["127.0.0.1"],
    timeoutMs: 10_000,
    maxResponseBytes: 1 << 20,
  });
}

describe.skipIf(!ENABLED)("M17 NEAR account ownership on a local nearcore sandbox (T-004)", () => {
  let server: Server;
  let base = "";
  let buyer: Actor;
  let admin: Actor;
  let h: Harness;

  beforeAll(async () => {
    h = makeHarness();
    docker(["rm", "-f", CONTAINER]);
    const launcher = wslPath(fileURLToPath(new URL("../../../scripts/near-sandbox/", import.meta.url)));
    const run = docker([
      "run",
      "-d",
      "--rm",
      "--name",
      CONTAINER,
      "-p",
      `127.0.0.1:${PORT}:3031`,
      "-v",
      `${launcher}:/launcher:ro`,
      IMAGE,
      "sh",
      "-c",
      `mkdir -p /work && cd /work && npm init -y >/dev/null && npm install --no-audit --no-fund ${SANDBOX_PACKAGE} >/dev/null && cp /launcher/launch.mjs . && exec node launch.mjs ${ACCOUNT} ${walletPublicKey}`,
    ]);
    expect(run.status, run.stderr).toBe(0);
    await rpcReady(Date.now() + 400_000);
    admin = bootstrap(h, "Sandbox Imports");
    buyer = enrollHuman(h, admin, "BUYER_APPROVER", "Sandbox buyer");
    server = createServer(
      createApp({
        config: loadConfig({
          DOCKSIDE_DB_PATH: h.dbPath,
          DOCKSIDE_ORIGIN: ORIGIN,
          DOCKSIDE_NEAR_RPC_URL: RPC,
        }),
        db: h.db,
        authority: h.svc,
        clock: h.clock,
        ids: randomIds,
        chain: { rpc: rpc(), tx: new NearTxClient(rpc()) },
      }),
    );
    base = await new Promise<string>((r) =>
      server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)),
    );
  }, 600_000);

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    const logs = docker(["logs", CONTAINER]);
    if (process.env["DOCKSIDE_NEAR_SANDBOX_LOGS"] === "1") process.stdout.write(logs.stdout + logs.stderr);
    docker(["rm", "-f", CONTAINER]);
    h?.close();
  });

  const http = async (a: Actor, method: "GET" | "POST", path: string, body?: unknown) => {
    const raw = body === undefined ? (method === "POST" ? "{}" : "") : JSON.stringify(body);
    const headers: Record<string, string> = {
      authorization: `Dockside-Session ${a.grant?.sessionToken}`,
      "dockside-proof": Buffer.from(JSON.stringify(a.proof(method, path, raw))).toString("base64url"),
    };
    if (method === "POST") headers["content-type"] = "application/json";
    const res = await fetch(
      base + path,
      method === "POST" ? { method, headers, body: raw } : { method, headers },
    );
    return { status: res.status, json: (await res.json()) as any };
  };

  it("nearcore answers view_access_key: the genesis key is FullAccess, another key and another account are unknown", async () => {
    const view = await rpc().viewAccessKey(ACCOUNT, walletPublicKey);
    expect(view.permission).toBe("FullAccess");
    expect(view.blockHeight).toBeGreaterThan(0);
    await expect(rpc().viewAccessKey(ACCOUNT, generateEd25519KeyPair().publicKey)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(rpc().viewAccessKey("no-such-account-m17.testnet", walletPublicKey)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("links the account from a NEP-413 signature only when nearcore confirms the full-access key", async () => {
    const ch = await http(buyer, "POST", "/v1/me/near-accounts/challenges", { accountId: ACCOUNT });
    expect(ch.status).toBe(201);
    const nonce = Buffer.from(ch.json.nep413.nonceHex, "hex");
    // Another key signs: valid NEP-413 signature, but nearcore does not know the key on this account.
    const other = generateKeyPairSync("ed25519");
    const u32 = (v: number) => {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(v >>> 0, 0);
      return b;
    };
    const str = (s: string) => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s)]);
    const payload = Buffer.concat([
      u32(2 ** 31 + 413),
      str(ch.json.nep413.message),
      nonce,
      str(ORIGIN),
      Buffer.from([0]),
    ]);
    const otherSig = sign(null, createHash("sha256").update(payload).digest(), other.privateKey).toString(
      "base64",
    );
    const refused = await http(buyer, "POST", "/v1/me/near-accounts", {
      challengeId: ch.json.challengeId,
      accountId: ACCOUNT,
      publicKey: exportPublicKey(other.publicKey),
      signature: otherSig,
    });
    expect(refused.json.error.code).toBe("ACCESS_KEY_NOT_FOUND");
    const ok = await http(buyer, "POST", "/v1/me/near-accounts", {
      challengeId: ch.json.challengeId,
      accountId: ACCOUNT,
      publicKey: walletPublicKey,
      signature: nep413Sign(ch.json.nep413.message, nonce, ORIGIN),
    });
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    expect(ok.json.status).toBe("VERIFIED");
    expect(ok.json.permission).toBe("FullAccess");
    expect(ok.json.blockHeight).toBeGreaterThan(0);
    const again = await http(buyer, "POST", `/v1/near-accounts/${ok.json.linkId}/recheck`, {});
    expect(again.json.status).toBe("VERIFIED");
    expect(again.json.blockHeight).toBeGreaterThanOrEqual(ok.json.blockHeight);
  });

  it("the RPC connection test reads a final block from nearcore", async () => {
    const t = await http(admin, "POST", "/v1/organization/integrations/rpc-test", {});
    expect(t.json.reachable).toBe(true);
    expect(t.json.blockHeight).toBeGreaterThan(0);
  });
});
