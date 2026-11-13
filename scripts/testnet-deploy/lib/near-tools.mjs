// Self-contained helpers for scripts/testnet-deploy/run-all (no workspace build needed): network
// guards, artifact digests, a small NEAR JSON-RPC reader and a near-cli-rs runner.
// Nothing here holds or reads a NEAR account key: transactions are signed by near-cli-rs from the
// user's own keychain (or the relayer's function-call key file near-cli-rs wrote).
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { win32 } from "node:path";

export const TESTNET_RPC_DEFAULT = "https://test.rpc.fastnear.com";
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
 * connection named `sandbox`. Anything else (mainnet included) is refused. Fallback RPC URLs (for
 * the read-only calls of the Node helpers) must pass the same rules as the primary.
 */
export function networkProfile(network, rpcUrl, fallbackRpcUrls = []) {
  let cliNetwork;
  let primary;
  if (network === "testnet") {
    cliNetwork = "testnet";
    primary = rpcUrl || TESTNET_RPC_DEFAULT;
  } else if (network === "sandbox") {
    cliNetwork = "sandbox";
    primary = rpcUrl || SANDBOX_RPC_DEFAULT;
  } else {
    throw new ToolError(
      "NETWORK_REFUSED",
      `--network must be testnet or sandbox (got ${network || "nothing"})`,
    );
  }
  const check = (u) => {
    const url = new URL(u);
    if (network === "testnet") {
      if (url.protocol !== "https:") throw new ToolError("NETWORK_REFUSED", "testnet RPC must be https");
      if (/mainnet/i.test(url.hostname))
        throw new ToolError("NETWORK_REFUSED", "refusing a mainnet RPC host");
    } else if (!LOOPBACK.has(url.hostname)) {
      throw new ToolError("NETWORK_REFUSED", "sandbox RPC must be a loopback address");
    }
    return url.toString().replace(/\/$/, "");
  };
  const rpcUrls = [primary, ...fallbackRpcUrls].map(check);
  return { network, cliNetwork, rpcUrl: rpcUrls[0], rpcUrls };
}

/** Comma-separated fallback RPC URLs (`--fallback-rpc-urls`, DOCKSIDE_FALLBACK_RPC_URLS). */
export function parseFallbackRpcUrls(value) {
  return (value || "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
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

/**
 * JSON-RPC reader over one URL or an ordered list (primary first, then fallbacks). A transport
 * failure (connection error, timeout, HTTP 429/5xx, a body that is not JSON-RPC) moves on to the
 * next URL; an RPC answer, error or not, is final. Only read-only methods are used here.
 */
export class Rpc {
  constructor(urls, { timeoutMs = 30_000 } = {}) {
    this.urls = Array.isArray(urls) ? urls : [urls];
    if (this.urls.length === 0) throw new ToolError("USAGE", "no RPC URL");
    this.url = this.urls[0];
    this.timeoutMs = timeoutMs;
    this.id = 0;
  }

  async once(url, method, params) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
        signal: ctl.signal,
      });
      if (res.status === 429 || res.status >= 500) return { transport: `HTTP ${res.status}` };
      let body;
      try {
        body = await res.json();
      } catch {
        return { transport: `HTTP ${res.status}, not JSON` };
      }
      if (!body || typeof body !== "object" || !("result" in body || "error" in body)) {
        return { transport: `HTTP ${res.status}, not a JSON-RPC response` };
      }
      return { body };
    } catch (e) {
      return { transport: e?.cause?.code ?? e?.name ?? String(e) };
    } finally {
      clearTimeout(timer);
    }
  }

  async request(method, params) {
    const failures = [];
    for (const url of this.urls) {
      const r = await this.once(url, method, params);
      if (r.transport) {
        failures.push(`${url}: ${r.transport}`);
        continue;
      }
      if (r.body.error) {
        const e = r.body.error;
        const detail = JSON.stringify(e.data ?? e.cause ?? e.message);
        throw new ToolError("RPC_ERROR", `${method}: ${detail}`);
      }
      return r.body.result;
    }
    throw new ToolError("RPC_UNAVAILABLE", `${method}: no RPC answered (${failures.join("; ")})`);
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

/** Last match of a global regex's first group in the ANSI-free text (the successful attempt). */
function lastMatch(re, text) {
  let found = null;
  for (const m of text.replace(ANSI, "").matchAll(re)) found = m[1];
  return found;
}

/** Transaction hash near-cli-rs printed ("Transaction ID: <hash>"), or null. */
export function parseTxHash(text) {
  return lastMatch(/Transaction ID:\s*([1-9A-HJ-NP-Za-km-z]{43,44})/g, text);
}

/** Key file near-cli-rs saved a new access key to ("saved in a file <path>" for `<account>/<key>.json`). */
export function parseSavedKeyFile(text) {
  return lastMatch(/saved in a file (.+[\\/]ed25519_[1-9A-HJ-NP-Za-km-z]+\.json)[ \t\r]*$/gm, text);
}

export function parseAddedKey(text) {
  return lastMatch(/Added access key = (ed25519:[1-9A-HJ-NP-Za-km-z]+)/g, text);
}

/* ------------------------- locating near-cli-rs (NEAR_CLI) ------------------------- */

// npm's near-cli-rs package installs shims (`near`, `near.cmd`, `near.ps1`) next to a node_modules
// tree holding the real binary; Node cannot spawn the shims on Windows without a shell.
const REAL_EXE = ["node_modules", "near-cli-rs", "node_modules", ".bin_real", "near.exe"];

function whereOnPath(name) {
  const r = spawnSync("where", [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (r.error || r.status !== 0) return [];
  return r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * The near-cli-rs binary run-all and the Node helpers spawn (without a shell). NEAR_CLI wins when it
 * names a binary; off Windows the default is `near` on PATH. On Windows an npm shim (NEAR_CLI or
 * `where near`) is mapped to the real near.exe beside it, and with no NEAR_CLI the npm global
 * prefixes (npm_config_prefix, Node's own directory) are searched first; npm's per-user prefix is
 * found through `where near`, since npm puts it on PATH.
 */
export function resolveNearCli({
  env = process.env,
  platform = process.platform,
  exists = existsSync,
  where = whereOnPath,
  execPath = process.execPath,
} = {}) {
  const explicit = (env.NEAR_CLI || "").trim();
  if (platform !== "win32") return explicit || "near";
  const besideShim = (p) => {
    if (/\.exe$/i.test(p)) return exists(p) ? p : null;
    const real = win32.join(win32.dirname(p), ...REAL_EXE);
    return exists(real) ? real : null;
  };
  if (explicit && /\.exe$/i.test(explicit)) return explicit;
  if (explicit && /[\\/]/.test(explicit)) {
    const real = besideShim(explicit);
    if (real) return real;
    throw new ToolError(
      "NEAR_CLI_MISSING",
      `NEAR_CLI=${explicit} is not near.exe (an npm shim cannot run without a shell) and no near.exe is beside it; set NEAR_CLI to the real near.exe`,
    );
  }
  const name = explicit || "near";
  if (!explicit) {
    const prefixes = [env.npm_config_prefix, env.NPM_CONFIG_PREFIX, win32.dirname(execPath)];
    for (const prefix of prefixes.filter(Boolean)) {
      const real = win32.join(prefix, ...REAL_EXE);
      if (exists(real)) return real;
    }
  }
  for (const hit of where(name)) {
    const real = besideShim(hit);
    if (real) return real;
  }
  throw new ToolError(
    "NEAR_CLI_MISSING",
    `near-cli-rs (${name}) not found: install it (npm install -g near-cli-rs@0.31.1, or cargo) or set NEAR_CLI to near.exe`,
  );
}

/* ------------------------------ running near-cli-rs ------------------------------ */

/**
 * An interactive question near-cli-rs (inquire) drew: "◆  <question>" plus its key help line.
 * On Windows inquire reads the console itself, so a closed stdin alone does not stop it.
 */
// Every CSI sequence (colours, cursor moves, bracketed paste) inquire writes around a question.
const CONTROL = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");
const PROMPT = /\[↑↓ to move|\[type to filter|^\s*◆\s+.+\?\s*$/m;

export function looksLikePrompt(text) {
  return PROMPT.test(text.replace(CONTROL, ""));
}

/**
 * Run near-cli-rs once with a complete, non-interactive command line: stdin closed (so a prompt
 * fails at once where the terminal library honours it), and the process killed as soon as it
 * draws a question (Windows) or after `timeoutMs`. Resolves to {status, text, txHash, clean}
 * plus `prompted` or `timedOut`.
 */
export function nearCli(
  bin,
  args,
  { cwd, timeoutMs = Number(process.env.DOCKSIDE_NEAR_CLI_TIMEOUT_MS) || 300_000 } = {},
) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
        windowsHide: true,
      });
    } catch (e) {
      reject(new ToolError("NEAR_CLI_MISSING", `cannot run ${bin}: ${e.message}`));
      return;
    }
    let out = "";
    let err = "";
    let prompted = false;
    let timedOut = false;
    const stop = () => {
      if (child.exitCode === null) child.kill();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const watch = () => {
      if (!prompted && looksLikePrompt(out + err)) {
        prompted = true;
        stop();
      }
    };
    child.stdout.setEncoding("utf8").on("data", (d) => {
      out += d;
      watch();
    });
    child.stderr.setEncoding("utf8").on("data", (d) => {
      err += d;
      watch();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new ToolError("NEAR_CLI_MISSING", `cannot run ${bin}: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let text = `${out}\n${err}`;
      if (prompted) {
        const q = /◆\s+([^\n]+?\?)/.exec(text.replace(CONTROL, ""))?.[1] ?? "a question";
        text += `\nError: stopped at "${q}" (input device is not a TTY)\n`;
      }
      if (timedOut) text += `\nError: near-cli-rs timeout: no result within ${timeoutMs} ms\n`;
      const status = code ?? 1;
      resolve({ status, text, txHash: parseTxHash(text), clean: text.replace(ANSI, ""), prompted, timedOut });
    });
  });
}

/** The error lines near-cli-rs (color-eyre) printed: "Error: ...", "   0: ...", "Caused by: ...". */
export function nearErrorLines(text) {
  const out = [];
  for (const raw of text.replace(ANSI, "").split(/\r?\n/)) {
    const l = raw.replace(/^[\s─-╿◆◇|]+/u, "").trim();
    const m = /^(?:\d+:\s*)?((?:Error|error|Caused by)\b.*)$/.exec(l) ?? /^\d+:\s*(.+)$/.exec(l);
    if (!m) continue;
    const v = m[1].replace(/^Error:\s*$/, "").trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * What a failed near-cli-rs run proves. Only EXPIRED is retried: the RPC rejected the transaction
 * (InvalidTxError::Expired) before inclusion, so signing again with a fresh block hash and nonce
 * cannot pay twice. A printed transaction id (SENT), a timeout or an unavailable RPC (UNCERTAIN: the
 * transaction may still land), a prompt that met the closed stdin (PROMPT) and everything else
 * (FAILED) are never retried.
 */
export function classifyNearFailure(text) {
  const clean = text.replace(ANSI, "");
  const errors = nearErrorLines(clean);
  if (parseTxHash(clean)) return { retry: false, kind: "SENT", errors };
  if (/timeout|currently unavailable|unexpected status code/i.test(clean)) {
    return { retry: false, kind: "UNCERTAIN", errors };
  }
  if (/not a terminal|not a tty|input device|OperationCanceled|OperationInterrupted/i.test(clean)) {
    return { retry: false, kind: "PROMPT", errors };
  }
  if (/Transaction has expired|InvalidTxError::Expired/.test(clean)) {
    return { retry: true, kind: "EXPIRED", errors };
  }
  return { retry: false, kind: "FAILED", errors };
}

/** One line for a failed run, carrying near-cli-rs's own error. */
export function describeNearFailure(r) {
  const c = classifyNearFailure(r.text ?? r.clean ?? "");
  const n = r.attempts && r.attempts > 1 ? ` after ${r.attempts} attempts` : "";
  let detail = c.errors.join(" | ");
  if (!detail) {
    detail = (r.clean ?? "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-3)
      .join(" | ");
  }
  const hint =
    c.kind === "PROMPT"
      ? " (near-cli-rs asked an interactive question; the command line must be complete)"
      : c.kind === "UNCERTAIN"
        ? " (not retried: the transaction may still be included; check it before running again)"
        : "";
  return `near-cli-rs exited ${r.status}${n}: ${detail || "no output"}${hint}`;
}

/**
 * Run near-cli-rs, signing again (a new near-cli-rs process fetches a fresh nonce and block hash)
 * up to `attempts` times only while the failure is EXPIRED. Returns the last run plus `attempts`
 * and `log`, the output of every attempt.
 */
export async function runNear(
  bin,
  args,
  { attempts = 3, run = nearCli, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} } = {},
) {
  let logText = "";
  for (let i = 1; ; i++) {
    const last = await run(bin, args);
    logText += `===== near-cli-rs attempt ${i} (exit ${last.status}) =====\n${last.text}\n`;
    if (last.status === 0 || last.txHash) return { ...last, attempts: i, log: logText };
    const c = classifyNearFailure(last.text);
    if (!c.retry || i >= attempts) return { ...last, attempts: i, log: logText };
    log(`${c.errors.at(-1) ?? c.kind}: not included, signing again (attempt ${i + 1} of ${attempts})`);
    await sleep(2000 * i);
  }
}
