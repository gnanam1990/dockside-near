/**
 * SIMULATED NEAR HOST — test infrastructure only, NOT nearcore and NOT a sandbox node.
 *
 * Executes the real compiled contract (contract/target/wasm32-unknown-unknown/release/
 * dockside_escrow.wasm) under Node's WebAssembly engine with an implementation of the NEAR host
 * functions that near-sdk 5.30.1 imports: registers, input/return, storage, logs, block time,
 * predecessor/current account, attached deposit, ed25519_verify (node:crypto) and promise batches.
 *
 * What it does model: per-call atomicity (a trap reverts storage and refunds the attached
 * deposit), native balances, transfer receipts (including failure to a nonexistent account with
 * the value returned to the sender) and callback promise results.
 * What it does NOT model: gas metering, storage staking, receipt scheduling across blocks,
 * access keys/nonces, protocol-level wasm feature validation. Those need near-sandbox or testnet,
 * which are BLOCKED on this Windows host (see docs/evidence/M02/sandbox-blocked.txt).
 */
import { createPublicKey, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SimExternalContract } from "./sim-token.js";

export const WASM_PATH = fileURLToPath(
  new URL("../../../../contract/target/wasm32-unknown-unknown/release/dockside_escrow.wasm", import.meta.url),
);

const U64_MAX = (1n << 64n) - 1n;
const enc = new TextEncoder();
const dec = new TextDecoder();

export interface CallOptions {
  readonly predecessor: string;
  readonly depositYocto?: bigint;
  readonly promiseResults?: readonly ("success" | "failure")[];
}

export interface PromiseAction {
  readonly kind: "transfer" | "function_call";
  readonly amountYocto: bigint;
  readonly method?: string;
  readonly args?: string;
}

export interface PromiseBatch {
  readonly index: number;
  readonly receiver: string;
  readonly after: number | null;
  readonly actions: PromiseAction[];
}

export interface CallResult {
  readonly ok: boolean;
  readonly value: unknown;
  readonly raw: string | null;
  readonly logs: string[];
  readonly error: string | null;
  readonly promises: PromiseBatch[];
  readonly returnedPromise: number | null;
}

class Trap extends Error {}

export class NearSim {
  readonly module: WebAssembly.Module;
  storage = new Map<string, Uint8Array>();
  balances = new Map<string, bigint>();
  /** Accounts that do not exist: transfers to them fail and the value returns to the sender. */
  readonly missing = new Set<string>();
  /** Other simulated contracts (for example a NEP-141 token) that calls and views route to. */
  readonly externals = new Map<string, SimExternalContract>();
  nowMs: number;

  constructor(
    readonly contractId: string,
    nowMs: number,
    wasm: Uint8Array<ArrayBuffer> = NearSim.loadWasm(),
  ) {
    this.module = new WebAssembly.Module(new Uint8Array(wasm));
    this.nowMs = nowMs;
    this.balances.set(contractId, 0n);
  }

  static loadWasm(): Uint8Array<ArrayBuffer> {
    if (!existsSync(WASM_PATH)) {
      throw new Error(`contract wasm missing at ${WASM_PATH}; run \`pnpm run contract:build\``);
    }
    return new Uint8Array(readFileSync(WASM_PATH));
  }

  balance(a: string): bigint {
    return this.balances.get(a) ?? 0n;
  }

  credit(a: string, v: bigint): void {
    this.balances.set(a, this.balance(a) + v);
  }

  /** Execute one function call receipt atomically. */
  call(method: string, args: unknown, opts: CallOptions): CallResult {
    const snapshot = new Map(this.storage);
    const deposit = opts.depositYocto ?? 0n;
    const input = enc.encode(JSON.stringify(args ?? {}));
    const registers = new Map<bigint, Uint8Array>();
    const logs: string[] = [];
    const promises: PromiseBatch[] = [];
    let returned: Uint8Array | null = null;
    let returnedPromise: number | null = null;
    let mem: WebAssembly.Memory | undefined;
    const bytes = (ptr: bigint, len: bigint) => {
      if (!mem) throw new Trap("memory not ready");
      return new Uint8Array(mem.buffer, Number(ptr), Number(len)).slice();
    };
    const write = (ptr: bigint, b: Uint8Array) => {
      if (!mem) throw new Trap("memory not ready");
      new Uint8Array(mem.buffer, Number(ptr), b.length).set(b);
    };
    const u128le = (v: bigint) => {
      const b = new Uint8Array(16);
      let x = v;
      for (let i = 0; i < 16; i++) {
        b[i] = Number(x & 0xffn);
        x >>= 8n;
      }
      return b;
    };
    const readU128 = (ptr: bigint) => bytes(ptr, 16n).reduceRight((a, b) => (a << 8n) | BigInt(b), 0n);
    const key = (len: bigint, ptr: bigint) => Buffer.from(bytes(ptr, len)).toString("hex");
    const results = opts.promiseResults ?? [];
    const unsupported = (name: string) => () => {
      throw new Trap(`host function ${name} not supported by the simulator`);
    };
    const env: Record<string, (...a: bigint[]) => bigint | number | undefined> = {
      read_register: (id, ptr) => {
        const r = registers.get(id);
        if (!r) throw new Trap("register missing");
        write(ptr, r);
        return undefined;
      },
      register_len: (id) => {
        const r = registers.get(id);
        return r ? BigInt(r.length) : U64_MAX;
      },
      input: (id) => {
        registers.set(id, input);
        return undefined;
      },
      value_return: (len, ptr) => {
        returned = bytes(ptr, len);
        return undefined;
      },
      panic_utf8: (len, ptr) => {
        throw new Trap(dec.decode(bytes(ptr, len)));
      },
      log_utf8: (len, ptr) => {
        logs.push(dec.decode(bytes(ptr, len)));
        return undefined;
      },
      current_account_id: (id) => {
        registers.set(id, enc.encode(this.contractId));
        return undefined;
      },
      predecessor_account_id: (id) => {
        registers.set(id, enc.encode(opts.predecessor));
        return undefined;
      },
      block_timestamp: () => BigInt(this.nowMs) * 1_000_000n,
      attached_deposit: (ptr) => {
        write(ptr, u128le(deposit));
        return undefined;
      },
      storage_write: (kl, kp, vl, vp, id) => {
        const k = key(kl, kp);
        const old = this.storage.get(k);
        this.storage.set(k, bytes(vp, vl));
        if (old) registers.set(id, old);
        return old ? 1n : 0n;
      },
      storage_read: (kl, kp, id) => {
        const v = this.storage.get(key(kl, kp));
        if (v) registers.set(id, v);
        return v ? 1n : 0n;
      },
      storage_remove: (kl, kp, id) => {
        const k = key(kl, kp);
        const v = this.storage.get(k);
        if (v) {
          registers.set(id, v);
          this.storage.delete(k);
        }
        return v ? 1n : 0n;
      },
      storage_has_key: (kl, kp) => (this.storage.has(key(kl, kp)) ? 1n : 0n),
      ed25519_verify: (sl, sp, ml, mp, pl, pp) => {
        const sig = bytes(sp, sl);
        const msg = bytes(mp, ml);
        const pk = bytes(pp, pl);
        if (sig.length !== 64 || pk.length !== 32) throw new Trap("ed25519_verify: bad lengths");
        const k = createPublicKey({
          key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(pk).toString("base64url") },
          format: "jwk",
        });
        try {
          return verify(null, msg, k, sig) ? 1n : 0n;
        } catch {
          return 0n;
        }
      },
      promise_batch_create: (al, ap) => {
        promises.push({
          index: promises.length,
          receiver: dec.decode(bytes(ap, al)),
          after: null,
          actions: [],
        });
        return BigInt(promises.length - 1);
      },
      promise_batch_then: (idx, al, ap) => {
        promises.push({
          index: promises.length,
          receiver: dec.decode(bytes(ap, al)),
          after: Number(idx),
          actions: [],
        });
        return BigInt(promises.length - 1);
      },
      promise_batch_action_transfer: (idx, ptr) => {
        promises[Number(idx)]?.actions.push({ kind: "transfer", amountYocto: readU128(ptr) });
        return undefined;
      },
      promise_batch_action_function_call: (idx, ml, mp, al, ap, amt) => {
        promises[Number(idx)]?.actions.push({
          kind: "function_call",
          method: dec.decode(bytes(mp, ml)),
          args: dec.decode(bytes(ap, al)),
          amountYocto: readU128(amt),
        });
        return undefined;
      },
      promise_batch_action_function_call_weight: (idx, ml, mp, al, ap, amt) => {
        promises[Number(idx)]?.actions.push({
          kind: "function_call",
          method: dec.decode(bytes(mp, ml)),
          args: dec.decode(bytes(ap, al)),
          amountYocto: readU128(amt),
        });
        return undefined;
      },
      promise_return: (idx) => {
        returnedPromise = Number(idx);
        return undefined;
      },
      promise_results_count: () => BigInt(results.length),
      promise_result: (i, id) => {
        const r = results[Number(i)];
        if (r === undefined) throw new Trap("promise result index out of range");
        if (r === "success") {
          registers.set(id, new Uint8Array());
          return 1n;
        }
        return 2n;
      },
    };
    const imports: Record<string, unknown> = {};
    for (const imp of WebAssembly.Module.imports(this.module)) {
      if (imp.module !== "env") continue;
      imports[imp.name] = env[imp.name] ?? unsupported(imp.name);
    }
    try {
      const inst = new WebAssembly.Instance(this.module, { env: imports as WebAssembly.ModuleImports });
      mem = inst.exports["memory"] as WebAssembly.Memory;
      const fn = inst.exports[method];
      if (typeof fn !== "function") throw new Trap(`method ${method} not exported`);
      (fn as () => void)();
    } catch (e) {
      this.storage = snapshot;
      return {
        ok: false,
        value: null,
        raw: null,
        logs,
        error: e instanceof Error ? e.message : String(e),
        promises: [],
        returnedPromise: null,
      };
    }
    this.credit(this.contractId, deposit);
    const out = returned as Uint8Array | null;
    const raw = out ? dec.decode(out) : null;
    return {
      ok: true,
      value: raw && raw.length > 0 ? JSON.parse(raw) : null,
      raw,
      logs,
      error: null,
      promises,
      returnedPromise,
    };
  }

  view(method: string, args: unknown = {}): unknown {
    const before = new Map(this.storage);
    const r = this.call(method, args, { predecessor: this.contractId });
    this.storage = before;
    if (!r.ok) throw new Error(r.error ?? "view failed");
    return r.value;
  }

  /**
   * Execute the promise batches a call produced: transfers move balance from the contract (a
   * transfer to a missing account fails and the value stays with the contract), then dependent
   * callbacks run as function calls from the contract with the dependency's outcome.
   */
  runPromises(r: CallResult): CallResult[] {
    const outcome = new Map<number, "success" | "failure">();
    const callbacks: CallResult[] = [];
    for (const p of r.promises) {
      const deps = p.after === null ? [] : [outcome.get(p.after) ?? "failure"];
      let status: "success" | "failure" = "success";
      for (const a of p.actions) {
        if (a.kind === "transfer") {
          if (this.missing.has(p.receiver) || this.balance(this.contractId) < a.amountYocto) {
            status = "failure";
            continue;
          }
          this.credit(this.contractId, -a.amountYocto);
          this.credit(p.receiver, a.amountYocto);
        } else {
          const ext = this.externals.get(p.receiver);
          if (ext) {
            // A cross-contract call from the escrow (the recovery adapter): the attached deposit
            // leaves the contract only if the external call succeeds (a failed receipt refunds it).
            const res = ext.call(a.method ?? "", JSON.parse(a.args ?? "{}"), {
              predecessor: this.contractId,
              depositYocto: a.amountYocto,
              sim: this,
            });
            if (res.ok) {
              this.credit(this.contractId, -a.amountYocto);
              this.credit(p.receiver, a.amountYocto);
            }
            status = res.ok ? "success" : "failure";
            continue;
          }
          if (p.receiver !== this.contractId)
            throw new Error("simulator only runs callbacks on the contract itself");
          const res = this.call(a.method ?? "", JSON.parse(a.args ?? "{}"), {
            predecessor: this.contractId,
            depositYocto: a.amountYocto,
            promiseResults: deps,
          });
          callbacks.push(res);
          status = res.ok ? "success" : "failure";
        }
      }
      outcome.set(p.index, status);
    }
    return callbacks;
  }
}

/** Contract panic code (`DOCKSIDE:<CODE>:`) from a failed call. */
export function panicCode(r: CallResult): string | null {
  const m = /DOCKSIDE:([A-Z_]+):/.exec(r.error ?? "");
  return m ? (m[1] ?? null) : r.ok ? null : `TRAP:${r.error}`;
}
