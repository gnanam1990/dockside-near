/**
 * NEAR JSON-RPC adapter boundary. The "RPC node" here is a local node:http server standing in
 * for the network (adapter isolation only; no real NEAR endpoint is contacted in this build).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EscrowContract, JsonRpcNearClient, NearTxClient } from "../src/index.js";

type Handler = (
  body: { id: string; method: string; params: Record<string, unknown> },
  res: ServerResponse,
) => void;
let handler: Handler = () => {};
let server: Server;
let endpoint = "";

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => handler(JSON.parse(raw), res));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const reply = (res: ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};
const client = (over: Partial<ConstructorParameters<typeof JsonRpcNearClient>[0]> = {}) =>
  new JsonRpcNearClient({
    endpoint,
    allowedHosts: ["127.0.0.1"],
    timeoutMs: 500,
    maxResponseBytes: 64 * 1024,
    ...over,
  });
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "NO_ERROR";
  } catch (e) {
    return (e as { code?: string }).code ?? "FOREIGN";
  }
};
const bytes = (v: unknown) => [...Buffer.from(JSON.stringify(v))];

describe("JsonRpcNearClient", () => {
  it("refuses endpoints outside the allowlist, plain http off loopback and embedded credentials", () => {
    expect(() => client({ allowedHosts: ["rpc.testnet.near.org"] })).toThrow(
      expect.objectContaining({ code: "WRONG_ORIGIN" }),
    );
    expect(
      () =>
        new JsonRpcNearClient({
          endpoint: "http://rpc.example.org",
          allowedHosts: ["rpc.example.org"],
          timeoutMs: 100,
          maxResponseBytes: 10,
        }),
    ).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
    expect(() => client({ endpoint: `${endpoint.replace("http://", "http://u:p@")}` })).toThrow(
      expect.objectContaining({ code: "CONFIG_INVALID" }),
    );
  });

  it("decodes call_function results and validates the JSON-RPC envelope", async () => {
    handler = (b, res) => {
      expect(b.method).toBe("query");
      expect(b.params["request_type"]).toBe("call_function");
      expect(JSON.parse(Buffer.from(String(b.params["args_base64"]), "base64").toString())).toEqual({
        trade_id: "trd_x",
      });
      reply(res, {
        jsonrpc: "2.0",
        id: b.id,
        result: { result: bytes({ ok: 1 }), logs: ["l"], block_height: 7, block_hash: "h" },
      });
    };
    const r = await client().callView("dockside-escrow.testnet", "get_trade", { trade_id: "trd_x" });
    expect(r).toEqual({ value: { ok: 1 }, logs: ["l"], blockHeight: 7, blockHash: "h" });
    handler = (_b, res) => reply(res, { jsonrpc: "2.0", id: "other", result: {} });
    expect(await code(client().callView("c.testnet", "m", {}))).toBe("UPSTREAM_INVALID");
    handler = (b, res) => reply(res, `{"jsonrpc":"2.0","id":"${b.id}","id":"${b.id}","result":{}}`);
    expect(await code(client().callView("c.testnet", "m", {}))).toBe("UPSTREAM_INVALID");
    handler = (b, res) =>
      reply(res, {
        jsonrpc: "2.0",
        id: b.id,
        result: { result: [256], logs: [], block_height: 1, block_hash: "h" },
      });
    expect(await code(client().callView("c.testnet", "m", {}))).toBe("UPSTREAM_INVALID");
  });

  it("maps contract panics, unknown accounts, server errors, timeouts and oversize bodies", async () => {
    handler = (b, res) =>
      reply(res, {
        jsonrpc: "2.0",
        id: b.id,
        result: { error: "wasm execution failed with error: DOCKSIDE:NOT_FOUND: trade not found", logs: [] },
      });
    await expect(client().callView("c.testnet", "get_trade", {})).rejects.toMatchObject({
      code: "CONTRACT_REJECTED",
      details: { contractCode: "NOT_FOUND" },
    });
    handler = (b, res) =>
      reply(res, { jsonrpc: "2.0", id: b.id, error: { code: -32000, cause: { name: "UNKNOWN_ACCOUNT" } } });
    expect(await code(client().viewAccount("nobody.testnet"))).toBe("NOT_FOUND");
    handler = (_b, res) => reply(res, { oops: true }, 503);
    expect(await code(client().viewAccount("a.testnet"))).toBe("UPSTREAM_ERROR");
    handler = () => {
      /* never answers */
    };
    expect(await code(client({ timeoutMs: 100 }).viewAccount("a.testnet"))).toBe("UPSTREAM_TIMEOUT");
    handler = (b, res) => reply(res, { jsonrpc: "2.0", id: b.id, result: { pad: "x".repeat(70 * 1024) } });
    expect(await code(client().viewAccount("a.testnet"))).toBe("LIMIT_EXCEEDED");
  });

  it("parses account, access key and transaction status facts", async () => {
    handler = (b, res) =>
      reply(res, {
        jsonrpc: "2.0",
        id: b.id,
        result: {
          amount: "12000000000000000000000000",
          locked: "0",
          code_hash: "11111111111111111111111111111111",
          storage_usage: 451234,
          block_height: 9,
        },
      });
    expect(await client().viewAccount("dockside-escrow.testnet")).toEqual({
      amountYocto: 12n * 10n ** 24n,
      lockedYocto: 0n,
      codeHash: "11111111111111111111111111111111",
      storageUsage: 451234,
      blockHeight: 9,
    });
    handler = (b, res) =>
      reply(res, {
        jsonrpc: "2.0",
        id: b.id,
        result: { nonce: 5, permission: "FullAccess", block_height: 3 },
      });
    expect(await client().viewAccessKey("a.testnet", "ed25519:x")).toEqual({
      permission: "FullAccess",
      nonce: 5n,
      blockHeight: 3,
    });
    const tx = "9".repeat(44);
    handler = (b, res) =>
      reply(res, {
        jsonrpc: "2.0",
        id: b.id,
        result: { status: { SuccessValue: Buffer.from('"ok"').toString("base64") } },
      });
    expect(await client().txStatus(tx, "a.testnet")).toEqual({
      kind: "SUCCESS",
      txHash: tx,
      returnValue: '"ok"',
    });
    handler = (b, res) =>
      reply(res, {
        jsonrpc: "2.0",
        id: b.id,
        result: { status: { Failure: { ActionError: { index: 0 } } } },
      });
    expect((await client().txStatus(tx, "a.testnet")).kind).toBe("FAILURE");
    expect(await code(client().txStatus("0OIl", "a.testnet"))).toBe("VALIDATION_FAILED");
  });

  it("M15: reads the final block time from header.timestamp_nanosec and refuses a malformed one", async () => {
    let header: Record<string, unknown> = {
      height: 7,
      hash: "h",
      timestamp: 1_800_000_000_123_456_789,
      timestamp_nanosec: "1800000000123456789",
    };
    // A real node sends `timestamp` as a JSON number past 2^53; the raw text carries it exactly.
    handler = (b, res) => {
      expect(b.method).toBe("block");
      expect(b.params).toEqual({ finality: "final" });
      reply(
        res,
        JSON.stringify({ jsonrpc: "2.0", id: b.id, result: { header } }).replace(
          /"timestamp":[0-9]+/,
          '"timestamp":1800000000123456789',
        ),
      );
    };
    const tx = new NearTxClient(client());
    expect(await tx.blockTimeMs()).toBe(1_800_000_000_123);
    expect(await tx.latestBlock()).toEqual({ height: 7, hash: "h" });
    for (const bad of [undefined, 12, "-1", "1.5e18", "", "9".repeat(31)]) {
      header = { height: 7, hash: "h", timestamp_nanosec: bad };
      expect(await code(tx.blockTimeMs()), String(bad)).toBe("UPSTREAM_INVALID");
    }
  });

  it("EscrowContract rejects views that do not match the contract schema", async () => {
    handler = (b, res) =>
      reply(res, {
        jsonrpc: "2.0",
        id: b.id,
        result: {
          result: bytes({ tradeId: "x", complete: true }),
          logs: [],
          block_height: 1,
          block_hash: "h",
        },
      });
    const escrow = new EscrowContract(client(), "dockside-escrow.testnet");
    expect(await code(escrow.getTrade("trd_x"))).toBe("VALIDATION_FAILED");
    expect(() => escrow.fundCall("trd_x", 0n)).toThrow(expect.objectContaining({ code: "INVALID_AMOUNT" }));
    expect(escrow.fundCall("trd_x", 5n)).toMatchObject({
      methodName: "fund",
      depositYocto: "5",
      receiverId: "dockside-escrow.testnet",
    });
  });
});
