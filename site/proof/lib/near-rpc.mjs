// Read-only NEAR JSON-RPC client shared by the proof page (browser) and `pnpm judge` (Node 22).
// It can only read: the method allow-list below has no way to send a transaction, and the client
// holds no key. Endpoints are tried in order (public endpoint first, archival second), so journey
// transactions stay readable after a non-archival node has garbage-collected them.

const READ_METHODS = new Set(["block", "query", "EXPERIMENTAL_tx_status"]);
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export class RpcError extends Error {
  constructor(message, attempts = []) {
    super(message);
    this.name = "RpcError";
    this.attempts = attempts;
  }
}

export function base58Encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

export function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) {
    throw new Error("not a hex string");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function utf8ToBase64(text) {
  let bin = "";
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
}

export async function sha256Hex(bytes) {
  return bytesToHex(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes)));
}

/**
 * @param {{endpoints: string[], fetch?: typeof fetch, timeoutMs?: number}} options
 */
export function createRpc({ endpoints, fetch: fetchImpl = globalThis.fetch, timeoutMs = 20_000 }) {
  if (!Array.isArray(endpoints) || endpoints.length === 0) throw new Error("no RPC endpoint configured");
  let id = 0;
  let calls = 0;

  async function once(endpoint, method, params) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body?.error) {
        const e = body.error;
        throw new Error(String(e.cause?.name ?? e.name ?? e.message ?? "RPC error"));
      }
      if (body?.result === undefined) throw new Error("no result in the RPC answer");
      // A view call that panics comes back as a result with an `error` string.
      if (typeof body.result?.error === "string") throw new Error(body.result.error);
      return body.result;
    } finally {
      clearTimeout(timer);
    }
  }

  async function call(method, params) {
    if (!READ_METHODS.has(method)) throw new Error(`refusing RPC method ${method}: read-only client`);
    const attempts = [];
    for (const endpoint of endpoints) {
      calls++;
      try {
        return await once(endpoint, method, params);
      } catch (e) {
        attempts.push(`${new URL(endpoint).host}: ${e?.name === "AbortError" ? "timeout" : e.message}`);
      }
    }
    throw new RpcError(attempts.join("; "), attempts);
  }

  const at = (blockId) => (blockId === undefined ? { finality: "final" } : { block_id: blockId });

  return {
    endpoints,
    get calls() {
      return calls;
    },
    finalBlock: async () => {
      const b = await call("block", { finality: "final" });
      return {
        height: b.header.height,
        hash: b.header.hash,
        timestampMs: Number(BigInt(b.header.timestamp) / 1000000n),
      };
    },
    viewAccount: (accountId, blockId) =>
      call("query", { request_type: "view_account", account_id: accountId, ...at(blockId) }),
    viewCode: (accountId, blockId) =>
      call("query", { request_type: "view_code", account_id: accountId, ...at(blockId) }),
    viewAccessKey: (accountId, publicKey, blockId) =>
      call("query", {
        request_type: "view_access_key",
        account_id: accountId,
        public_key: publicKey,
        ...at(blockId),
      }),
    callView: async (accountId, method, args, blockId) => {
      const r = await call("query", {
        request_type: "call_function",
        account_id: accountId,
        method_name: method,
        args_base64: utf8ToBase64(JSON.stringify(args ?? {})),
        ...at(blockId),
      });
      return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result)));
    },
    txStatus: (txHash, signerId) =>
      call("EXPERIMENTAL_tx_status", { tx_hash: txHash, sender_account_id: signerId, wait_until: "FINAL" }),
  };
}
