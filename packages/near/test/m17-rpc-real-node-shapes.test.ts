/**
 * Response shapes found by the M17 nearcore sandbox run (nearcore 2.13.4), which the simulated chain
 * did not produce:
 * 1. a `block` response carries the header timestamp in nanoseconds as a JSON number above 2^53; the
 *    strict parser rejected the whole response, so `latestBlock()` failed against every real node.
 *    RPC responses now keep such integers as exact decimal strings; request bodies and every other
 *    boundary still reject them.
 * 2. `view_access_key` for a key the account does not have answers a *result* carrying an `error`
 *    string ("... does not exist while viewing"), not a JSON-RPC error; it was reported as a malformed
 *    permission instead of NOT_FOUND.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { parseStrictJson } from "@dockside/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JsonRpcNearClient, NearTxClient } from "../src/index.js";

const KNOWN = "ed25519:5BGSaf6YjVm7565VzWQHNxoyEjwr3jUpRJSGjREvU9dB";
const BROKEN = "ed25519:AVxNnCLGxSg7p9kWndNAW5gdxe8c829QRa6CJxBzqUFy";
let server: Server;
let endpoint = "";
// Shape of a nearcore 2.x `block` header (trimmed): the timestamp is a u64 in nanoseconds.
const RAW_BLOCK = (id: string) =>
  `{"jsonrpc":"2.0","id":"${id}","result":{"author":"test.near","header":{"height":42,"hash":"ENKCAA8o2V3j22aNyo5R4meXjq6A6MMkNSzegru5RPDu","timestamp":1794470400123456789,"timestamp_nanosec":"1794470400123456789","gas_price":"100000000"},"chunks":[]}}`;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      const b = JSON.parse(raw) as { id: string; method: string; params: Record<string, string> };
      const body =
        b.method === "block"
          ? RAW_BLOCK(b.id)
          : b.params["public_key"] === KNOWN
            ? `{"jsonrpc":"2.0","result":{"block_hash":"AgTE2HrJsaZ6WJAiDrDsUgo34zc1mxr9vJ5tqPUVGKFk","block_height":27,"nonce":0,"permission":"FullAccess"},"id":"${b.id}"}`
            : b.params["public_key"] === BROKEN
              ? `{"jsonrpc":"2.0","result":{"block_hash":"x","block_height":28,"error":"wasm execution failed","logs":[]},"id":"${b.id}"}`
              : `{"jsonrpc":"2.0","result":{"block_hash":"xMv2mwZZAQZKn6BYkkaqMGTFv9mdJyWT8QUDrv2Rt3A","block_height":28,"error":"access key ${b.params["public_key"]} does not exist while viewing","logs":[]},"id":"${b.id}"}`;
      res.writeHead(200, { "content-type": "application/json" }).end(body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("NEAR RPC responses with u64 numbers beyond 2^53", () => {
  it("latestBlock reads height and hash from a real-node-shaped block response", async () => {
    const rpc = new JsonRpcNearClient({
      endpoint,
      allowedHosts: ["127.0.0.1"],
      timeoutMs: 2000,
      maxResponseBytes: 65536,
    });
    expect(await new NearTxClient(rpc).latestBlock()).toEqual({
      height: 42,
      hash: "ENKCAA8o2V3j22aNyo5R4meXjq6A6MMkNSzegru5RPDu",
    });
    const raw = (await rpc.request("block", { finality: "final" })) as { header: { timestamp: unknown } };
    expect(raw.header.timestamp).toBe("1794470400123456789");
  });

  it("view_access_key: a result-level 'does not exist' error is NOT_FOUND; another result error is UPSTREAM_ERROR", async () => {
    const rpc = new JsonRpcNearClient({
      endpoint,
      allowedHosts: ["127.0.0.1"],
      timeoutMs: 2000,
      maxResponseBytes: 65536,
    });
    expect(await rpc.viewAccessKey("dockside-wallet.testnet", KNOWN)).toEqual({
      permission: "FullAccess",
      nonce: 0n,
      blockHeight: 27,
    });
    await expect(
      rpc.viewAccessKey("dockside-wallet.testnet", "ed25519:8uQhQCHaVBs5Gx1fwSbLrRSd3m8RKpxAJ2Ev2wVUvBbg"),
    ).rejects.toMatchObject({ code: "NOT_FOUND", details: { cause: "UNKNOWN_ACCESS_KEY" } });
    await expect(rpc.viewAccessKey("dockside-wallet.testnet", BROKEN)).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
  });

  it("the default strict parser still rejects unsafe integers, fractions and negative big integers", () => {
    const limits = {
      maxBytes: 1024,
      maxDepth: 8,
      maxStringLength: 256,
      maxArrayLength: 16,
      maxObjectKeys: 16,
    };
    expect(() => parseStrictJson('{"t":1794470400123456789}', limits)).toThrow(/safe range/);
    expect(
      parseStrictJson('{"t":1794470400123456789}', { ...limits, unsafeIntegers: "decimal-string" }),
    ).toEqual({
      t: "1794470400123456789",
    });
    expect(() =>
      parseStrictJson('{"t":-1794470400123456789}', { ...limits, unsafeIntegers: "decimal-string" }),
    ).toThrow(/safe range/);
    expect(() => parseStrictJson('{"t":1.5}', { ...limits, unsafeIntegers: "decimal-string" })).toThrow(
      /fractional/,
    );
  });
});
