import { randomBytes } from "node:crypto";
import { DocksideError, fail, type JsonValue, parseStrictJson } from "@dockside/core";

/**
 * NEAR JSON-RPC boundary (read side). Every call has an endpoint allowlist, timeout, response
 * byte limit, JSON-RPC envelope validation and typed error mapping. Responses are facts
 * attributed to the RPC provider, not independent truth; callers record them as observations.
 *
 * Transaction signing/broadcast is intentionally NOT part of this interface: escrow mutations
 * are signed by the acting party's own wallet (see `EscrowContract.*Call` builders). The
 * submission step is BLOCKED in this build (no wallets or accounts may be used).
 */
export interface NearRpc {
  /** `query` / `call_function` at `finality: final`; returns the parsed JSON return value. */
  callView(contractId: string, method: string, args: Record<string, unknown>): Promise<ViewResult>;
  viewAccount(accountId: string): Promise<AccountView>;
  /** NEAR account <-> key binding (closes the M01 gap once a network is authorized). */
  viewAccessKey(accountId: string, publicKey: string): Promise<AccessKeyView>;
  /** Final outcome of a submitted transaction, looked up by its original identity. */
  txStatus(txHash: string, senderAccountId: string): Promise<TxStatus>;
}

export interface ViewResult {
  readonly value: JsonValue;
  readonly logs: readonly string[];
  readonly blockHeight: number;
  readonly blockHash: string;
}

export interface AccountView {
  readonly amountYocto: bigint;
  readonly lockedYocto: bigint;
  readonly codeHash: string;
  readonly storageUsage: number;
  readonly blockHeight: number;
}

export interface AccessKeyView {
  readonly permission: "FullAccess" | "FunctionCall";
  readonly nonce: bigint;
  readonly blockHeight: number;
}

export type TxStatus =
  | { readonly kind: "SUCCESS"; readonly txHash: string; readonly returnValue: string | null }
  | { readonly kind: "FAILURE"; readonly txHash: string; readonly error: string }
  | { readonly kind: "PENDING"; readonly txHash: string };

export interface JsonRpcConfig {
  readonly endpoint: string;
  /** Exact hostnames the client may contact. The endpoint must be one of them. */
  readonly allowedHosts: readonly string[];
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  /** Injected transport (defaults to global fetch). */
  readonly fetchImpl?: typeof fetch;
}

/** Public endpoints for an operator to configure. Never contacted by tests. */
export const NEAR_TESTNET_RPC_DEFAULT = "https://rpc.testnet.near.org";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isObj(v: unknown): v is Record<string, JsonValue> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Extract the `DOCKSIDE:<CODE>` the contract panics with, if present. */
export function contractErrorCode(message: string): string | null {
  const m = /DOCKSIDE:([A-Z_]+):/.exec(message);
  return m ? (m[1] ?? null) : null;
}

export class JsonRpcNearClient implements NearRpc {
  private readonly url: URL;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: JsonRpcConfig) {
    let url: URL;
    try {
      url = new URL(cfg.endpoint);
    } catch {
      fail("CONFIG_INVALID", "RPC endpoint is not a URL");
    }
    if (!cfg.allowedHosts.includes(url.hostname)) {
      fail("WRONG_ORIGIN", "RPC endpoint host is not on the allowlist", { host: url.hostname });
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
      fail("CONFIG_INVALID", "RPC endpoint must be https (http only on loopback)");
    }
    if (url.username || url.password || url.search || url.hash) {
      fail("CONFIG_INVALID", "RPC endpoint must not carry credentials, query or fragment");
    }
    if (!(cfg.timeoutMs > 0 && cfg.timeoutMs <= 60_000)) fail("CONFIG_INVALID", "timeout out of range");
    if (!(cfg.maxResponseBytes > 0 && cfg.maxResponseBytes <= 8 * 1024 * 1024))
      fail("CONFIG_INVALID", "response limit out of range");
    this.url = url;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  /** Raw JSON-RPC call with envelope validation. */
  async request(method: string, params: JsonValue): Promise<JsonValue> {
    const id = randomBytes(8).toString("hex");
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.cfg.timeoutMs);
    let res: Response;
    let bytes: Uint8Array;
    try {
      res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: ctl.signal,
        redirect: "error",
      });
      bytes = await this.readLimited(res);
    } catch (e) {
      if (e instanceof DocksideError) throw e;
      if (ctl.signal.aborted) fail("UPSTREAM_TIMEOUT", "NEAR RPC timed out", { method });
      fail("UPSTREAM_ERROR", "NEAR RPC transport failed", { method });
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 500) fail("UPSTREAM_ERROR", "NEAR RPC returned a server error", { status: res.status });
    let body: JsonValue;
    try {
      body = parseStrictJson(bytes, {
        maxBytes: this.cfg.maxResponseBytes,
        maxDepth: 64,
        maxStringLength: this.cfg.maxResponseBytes,
        maxArrayLength: 1_000_000,
        maxObjectKeys: 1024,
      });
    } catch {
      fail("UPSTREAM_INVALID", "NEAR RPC response is not valid JSON");
    }
    if (!isObj(body) || body["jsonrpc"] !== "2.0" || body["id"] !== id) {
      fail("UPSTREAM_INVALID", "NEAR RPC response envelope mismatch");
    }
    if (isObj(body["error"])) {
      const err = body["error"];
      const cause = isObj(err["cause"]) ? String(err["cause"]["name"] ?? "") : "";
      const text = JSON.stringify(err).slice(0, 2000);
      if (cause === "UNKNOWN_ACCOUNT" || cause === "UNKNOWN_ACCESS_KEY" || cause === "UNKNOWN_TRANSACTION") {
        fail("NOT_FOUND", "NEAR RPC: not found", { cause });
      }
      if (cause === "TIMEOUT_ERROR") fail("UPSTREAM_TIMEOUT", "NEAR RPC: transaction status timeout");
      const dockside = contractErrorCode(text);
      if (dockside)
        fail("CONTRACT_REJECTED", "escrow contract rejected the call", { contractCode: dockside });
      fail("UPSTREAM_ERROR", "NEAR RPC error", { cause: cause || "UNSPECIFIED" });
    }
    if (!("result" in body)) fail("UPSTREAM_INVALID", "NEAR RPC response has neither result nor error");
    return body["result"] as JsonValue;
  }

  private async readLimited(res: Response): Promise<Uint8Array> {
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > this.cfg.maxResponseBytes) fail("LIMIT_EXCEEDED", "NEAR RPC response too large");
    if (!res.body) return new Uint8Array();
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > this.cfg.maxResponseBytes) {
        await reader.cancel();
        fail("LIMIT_EXCEEDED", "NEAR RPC response too large");
      }
      chunks.push(value);
    }
    return new Uint8Array(Buffer.concat(chunks));
  }

  async callView(contractId: string, method: string, args: Record<string, unknown>): Promise<ViewResult> {
    const r = await this.request("query", {
      request_type: "call_function",
      finality: "final",
      account_id: contractId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    });
    if (!isObj(r)) fail("UPSTREAM_INVALID", "call_function result malformed");
    if (typeof r["error"] === "string") {
      const dockside = contractErrorCode(r["error"]);
      fail(dockside ? "CONTRACT_REJECTED" : "UPSTREAM_ERROR", "view call failed", {
        contractCode: dockside,
      });
    }
    const raw = r["result"];
    if (
      !Array.isArray(raw) ||
      !raw.every((b) => typeof b === "number" && b >= 0 && b <= 255 && Number.isInteger(b))
    ) {
      fail("UPSTREAM_INVALID", "call_function result bytes malformed");
    }
    let value: JsonValue;
    try {
      value = parseStrictJson(new Uint8Array(raw as number[]), {
        maxBytes: this.cfg.maxResponseBytes,
        maxDepth: 64,
        maxStringLength: 64 * 1024,
        maxArrayLength: 100_000,
        maxObjectKeys: 1024,
      });
    } catch {
      fail("UPSTREAM_INVALID", "contract returned non-JSON");
    }
    const logs = Array.isArray(r["logs"]) ? r["logs"].filter((l): l is string => typeof l === "string") : [];
    return { value, logs, blockHeight: num(r["block_height"]), blockHash: str(r["block_hash"]) };
  }

  async viewAccount(accountId: string): Promise<AccountView> {
    const r = await this.request("query", {
      request_type: "view_account",
      finality: "final",
      account_id: accountId,
    });
    if (!isObj(r)) fail("UPSTREAM_INVALID", "view_account result malformed");
    return {
      amountYocto: big(r["amount"]),
      lockedYocto: big(r["locked"]),
      codeHash: str(r["code_hash"]),
      storageUsage: num(r["storage_usage"]),
      blockHeight: num(r["block_height"]),
    };
  }

  async viewAccessKey(accountId: string, publicKey: string): Promise<AccessKeyView> {
    const r = await this.request("query", {
      request_type: "view_access_key",
      finality: "final",
      account_id: accountId,
      public_key: publicKey,
    });
    if (!isObj(r)) fail("UPSTREAM_INVALID", "view_access_key result malformed");
    const p = r["permission"];
    const permission =
      p === "FullAccess" ? "FullAccess" : isObj(p) && "FunctionCall" in p ? "FunctionCall" : null;
    if (!permission) fail("UPSTREAM_INVALID", "access key permission malformed");
    return { permission, nonce: big(r["nonce"]), blockHeight: num(r["block_height"]) };
  }

  async txStatus(txHash: string, senderAccountId: string): Promise<TxStatus> {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(txHash)) fail("VALIDATION_FAILED", "tx hash must be base58");
    const r = await this.request("tx", {
      tx_hash: txHash,
      sender_account_id: senderAccountId,
      wait_until: "FINAL",
    });
    if (!isObj(r) || !isObj(r["status"])) return { kind: "PENDING", txHash };
    const st = r["status"];
    if ("SuccessValue" in st) {
      const v = st["SuccessValue"];
      return {
        kind: "SUCCESS",
        txHash,
        returnValue: typeof v === "string" && v.length > 0 ? Buffer.from(v, "base64").toString("utf8") : null,
      };
    }
    if ("Failure" in st)
      return { kind: "FAILURE", txHash, error: JSON.stringify(st["Failure"]).slice(0, 2000) };
    return { kind: "PENDING", txHash };
  }
}

function num(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)
    fail("UPSTREAM_INVALID", "expected integer");
  return v;
}

function str(v: unknown): string {
  if (typeof v !== "string" || v.length > 256) fail("UPSTREAM_INVALID", "expected string");
  return v;
}

function big(v: unknown): bigint {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v !== "string" || !/^(0|[1-9][0-9]{0,38})$/.test(v))
    fail("UPSTREAM_INVALID", "expected u128 string");
  return BigInt(v);
}
