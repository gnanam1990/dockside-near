// Self-contained helpers for scripts/testnet-deploy/run-all (no workspace build needed): network
// guards, artifact digests, a small NEAR JSON-RPC reader and a near-cli-rs runner.
// Nothing here holds or reads a NEAR account key: transactions are signed by near-cli-rs from the
// user's own keychain (or the relayer's function-call key file near-cli-rs wrote).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const TESTNET_RPC_DEFAULT = "https://rpc.testnet.near.org";
export const SANDBOX_RPC_DEFAULT = "http://127.0.0.1:4521";
/** Contract `new` accepts only this corridor label, on testnet and on the local sandbox alike. */
export const CONTRACT_NETWORK = "near-testnet";

export class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(bytes) {
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
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

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest();
}

/** SHA-256 hex and NEAR code hash (base58 of the SHA-256) of a wasm file. */
export function wasmDigest(path) {
  const bytes = readFileSync(path);
  const d = sha256(bytes);
  return { bytes: bytes.length, sha256: d.toString("hex"), nearCodeHash: base58(d) };
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * The only two networks run-all accepts. `testnet` uses near-cli-rs's built-in `testnet`
 * connection; `sandbox` is a local near-sandbox node behind a loopback RPC URL and a near-cli-rs
 * connection named `sandbox`. Anything else (mainnet included) is refused.
 */
export function networkProfile(network, rpcUrl) {
  if (network === "testnet") {
    const url = new URL(rpcUrl || TESTNET_RPC_DEFAULT);
    if (url.protocol !== "https:") throw new ToolError("NETWORK_REFUSED", "testnet RPC must be https");
    if (/mainnet/i.test(url.hostname)) throw new ToolError("NETWORK_REFUSED", "refusing a mainnet RPC host");
    return { network, cliNetwork: "testnet", rpcUrl: url.toString().replace(/\/$/, "") };
  }
  if (network === "sandbox") {
    const url = new URL(rpcUrl || SANDBOX_RPC_DEFAULT);
    if (!LOOPBACK.has(url.hostname))
      throw new ToolError("NETWORK_REFUSED", "sandbox RPC must be a loopback address");
    return { network, cliNetwork: "sandbox", rpcUrl: url.toString().replace(/\/$/, "") };
  }
  throw new ToolError(
    "NETWORK_REFUSED",
    `--network must be testnet or sandbox (got ${network || "nothing"})`,
  );
}

const ACCOUNT = /^(?=.{2,64}$)([a-z\d]+[-_])*[a-z\d]+(\.([a-z\d]+[-_])*[a-z\d]+)*$/;

/** Accounts named by env vars; every one must be a distinct `.testnet` account (the contract's corridor rule). */
export function accountsFromEnv(env) {
  const names = {
    escrow: "DOCKSIDE_ESCROW_ACCOUNT",
    buyer: "DOCKSIDE_BUYER_ACCOUNT",
    supplier: "DOCKSIDE_SUPPLIER_ACCOUNT",
    relayer: "DOCKSIDE_RELAYER_ACCOUNT",
  };
  const out = {};
  for (const [k, v] of Object.entries(names)) {
    const id = (env[v] || "").trim();
    if (!id) throw new ToolError("MISSING_ACCOUNT", `${v} is not set`);
    if (!ACCOUNT.test(id) || !id.endsWith(".testnet")) {
      throw new ToolError("INVALID_ACCOUNT", `${v}=${id} is not a named .testnet account`);
    }
    out[k] = id;
  }
  if (new Set(Object.values(out)).size !== 4) {
    throw new ToolError(
      "INVALID_ACCOUNT",
      "escrow, buyer, supplier and relayer must be four different accounts",
    );
  }
  return out;
}

/** The wasm must be exactly the one the build manifest recorded (container build, ADR-0015). */
export function verifyArtifact(wasmPath, manifestPath) {
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  const want = m?.contract;
  if (!want?.sha256 || !want?.nearCodeHash)
    throw new ToolError("MANIFEST_INVALID", "manifest has no contract digest");
  const have = wasmDigest(wasmPath);
  if (have.sha256 !== want.sha256) {
    throw new ToolError(
      "WASM_MISMATCH",
      `wasm sha256 ${have.sha256} differs from the manifest's ${want.sha256}`,
    );
  }
  if (have.nearCodeHash !== want.nearCodeHash) {
    throw new ToolError(
      "WASM_MISMATCH",
      `NEAR code hash ${have.nearCodeHash} differs from the manifest's ${want.nearCodeHash}`,
    );
  }
  return { ...have, commit: m.commit ?? null, platform: m.toolchain?.platform ?? null };
}

/* ------------------------------------ JSON-RPC ------------------------------------ */

export class Rpc {
  constructor(url, { timeoutMs = 30_000 } = {}) {
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.id = 0;
  }

  async request(method, params) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
        signal: ctl.signal,
      });
      const body = await res.json();
      if (body.error) {
        const detail = JSON.stringify(body.error.data ?? body.error.cause ?? body.error.message);
        throw new ToolError("RPC_ERROR", `${method}: ${detail}`);
      }
      return body.result;
    } finally {
      clearTimeout(timer);
    }
  }

  async viewAccount(accountId) {
    return this.request("query", {
      request_type: "view_account",
      finality: "optimistic",
      account_id: accountId,
    });
  }

  async accessKey(accountId, publicKey) {
    return this.request("query", {
      request_type: "view_access_key",
      finality: "optimistic",
      account_id: accountId,
      public_key: publicKey,
    });
  }

  async view(contractId, method, args = {}) {
    const r = await this.request("query", {
      request_type: "call_function",
      finality: "optimistic",
      account_id: contractId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    });
    return JSON.parse(Buffer.from(r.result).toString("utf8"));
  }

  async blockTimeMs(blockHash) {
    const b = await this.request("block", blockHash ? { block_id: blockHash } : { finality: "optimistic" });
    return Math.floor(Number(BigInt(b.header.timestamp_nanosec) / 1_000_000n));
  }

  async txStatus(txHash, sender) {
    return this.request("EXPERIMENTAL_tx_status", {
      tx_hash: txHash,
      sender_account_id: sender,
      wait_until: "FINAL",
    });
  }
}

/** Decoded `SuccessValue` of an outcome status, or null. */
export function successValue(status) {
  if (!status || typeof status !== "object" || !("SuccessValue" in status)) return null;
  const raw = Buffer.from(status.SuccessValue, "base64").toString("utf8");
  return raw ? JSON.parse(raw) : null;
}

export function isFailure(status) {
  return !!status && typeof status === "object" && "Failure" in status;
}

/* ---------------------------------- near-cli-rs ---------------------------------- */

// ANSI colour sequences near-cli-rs writes around values (ESC built from its code point).
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** Transaction hash near-cli-rs printed ("Transaction ID: <hash>"), or null. */
export function parseTxHash(text) {
  const m = /Transaction ID:\s*([1-9A-HJ-NP-Za-km-z]{43,44})/.exec(text.replace(ANSI, ""));
  return m ? m[1] : null;
}

/** Key file near-cli-rs saved a new access key to ("saved in a file <path>" for `<account>/<key>.json`). */
export function parseSavedKeyFile(text) {
  const lines = text.replace(ANSI, "").split("\n");
  for (const l of lines) {
    const m = /saved in a file (.+[\\/]ed25519_[1-9A-HJ-NP-Za-km-z]+\.json)\s*$/.exec(l.trim());
    if (m) return m[1];
  }
  return null;
}

export function parseAddedKey(text) {
  const m = /Added access key = (ed25519:[1-9A-HJ-NP-Za-km-z]+)/.exec(text.replace(ANSI, ""));
  return m ? m[1] : null;
}

/** Run near-cli-rs with a complete, non-interactive command line. */
export function nearCli(bin, args, { cwd } = {}) {
  const r = spawnSync(bin, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  if (r.error) throw new ToolError("NEAR_CLI_MISSING", `cannot run ${bin}: ${r.error.message}`);
  const text = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  return { status: r.status, text, txHash: parseTxHash(text), clean: text.replace(ANSI, "") };
}
