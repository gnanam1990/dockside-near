/**
 * SIMULATED NEAR CHAIN SERVER — test infrastructure only, NOT nearcore and NOT a NEAR node.
 *
 * Serves the M02 simulated host (packages/near/test/sim, which executes the real compiled escrow
 * wasm) over HTTP JSON-RPC so that journal workers in separate OS processes reach it through the
 * production `JsonRpcNearClient` / `NearTxClient`. It models: blocks and block hashes, per-signer
 * access-key nonces, the transaction validity window, idempotent re-broadcast of an identical
 * transaction (same hash), receipts with outcomes (function call, transfer, callback, runtime
 * refunds from "system") and `EXPERIMENTAL_tx_status` lookups by the original hash.
 *
 * Simulated transactions are a JSON envelope (`dockside-sim-tx/1`), not borsh, and carry no
 * signature: access-key signature checks are not modelled (as in the M02 host). Fault controls
 * (`faults`) exist to deliver lost responses, outages, deferred callbacks, hidden receipts and
 * contradicting receipts, the evidence conditions M05 must survive.
 */
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { base58Encode } from "@dockside/core";
import type { FunctionCall, SignedTx, TxSigner } from "@dockside/near";
import type { CallResult, NearSim, PromiseBatch } from "../../near/test/sim/near-sim.js";

export const SIM_TX_VERSION = "dockside-sim-tx/1";

export interface SimEnvelope {
  readonly v: string;
  readonly signerId: string;
  readonly publicKey: string;
  readonly nonce: string;
  readonly blockHash: string;
  readonly receiverId: string;
  readonly methodName: string;
  readonly args: unknown;
  readonly gas: string;
  readonly depositYocto: string;
}

function outcomeStatus(ok: boolean, raw: string | null, error: string | null): Record<string, unknown> {
  return ok
    ? { SuccessValue: Buffer.from(raw ?? "").toString("base64") }
    : { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: error } } } } };
}

export function simTxHash(encoded: string): string {
  return base58Encode(createHash("sha256").update(Buffer.from(encoded, "base64")).digest());
}

/** Relayer signer for the simulated chain (no keys: the envelope is unsigned by design). */
export class SimTxSigner implements TxSigner {
  readonly publicKey: string;
  constructor(readonly signerId: string) {
    this.publicKey = `ed25519:${base58Encode(createHash("sha256").update(`sim-key:${signerId}`).digest())}`;
  }
  async sign(call: FunctionCall, ref: { nonce: bigint; blockHash: string }): Promise<SignedTx> {
    const env: SimEnvelope = {
      v: SIM_TX_VERSION,
      signerId: this.signerId,
      publicKey: this.publicKey,
      nonce: ref.nonce.toString(10),
      blockHash: ref.blockHash,
      receiverId: call.receiverId,
      methodName: call.methodName,
      args: call.args,
      gas: call.gas,
      depositYocto: call.depositYocto,
    };
    const encoded = Buffer.from(JSON.stringify(env)).toString("base64");
    return { txHash: simTxHash(encoded), signerId: this.signerId, encoded };
  }
}

interface SimReceipt {
  receipt_id: string;
  predecessor_id: string;
  receiver_id: string;
  actions: Record<string, unknown>[];
  status: Record<string, unknown> | null;
}

interface StoredTx {
  hash: string;
  env: SimEnvelope;
  refHeight: number;
  receipts: SimReceipt[];
  status: Record<string, unknown> | null;
  final: boolean;
  deferred: { batch: PromiseBatch; deps: ("success" | "failure")[]; receipt: SimReceipt }[];
}

export interface Faults {
  /** Every request answers 503. */
  down: boolean;
  /** Execute the next N send_tx requests, then drop the connection without a response. */
  dropSendResponses: number;
  /** Drop the next N send_tx requests before they reach the chain (never included). */
  dropSendRequests: number;
  /** Execute transfers but hold contract callbacks until `releaseCallbacks()`. */
  deferCallbacks: boolean;
  /** Hashes whose receipts are withheld (pruned/private node). */
  hideReceipts: Set<string>;
  /** EXPERIMENTAL_tx_status answers 503 (status source down) while send_tx works. */
  statusDown: boolean;
}

export class SimChainServer {
  height = 10;
  readonly validityBlocks: number;
  readonly txs = new Map<string, StoredTx>();
  readonly nonces = new Map<string, bigint>();
  readonly sendCount = new Map<string, number>();
  readonly executions = new Map<string, number>();
  readonly faults: Faults = {
    down: false,
    dropSendResponses: 0,
    dropSendRequests: 0,
    deferCallbacks: false,
    hideReceipts: new Set(),
    statusDown: false,
  };
  private server: Server | null = null;
  url = "";

  constructor(
    readonly sim: NearSim,
    private readonly now: () => number,
    opts: { validityBlocks?: number } = {},
  ) {
    this.validityBlocks = opts.validityBlocks ?? 100;
  }

  blockHash(h: number): string {
    return base58Encode(createHash("sha256").update(`sim-block:${h}`).digest());
  }

  heightOf(hash: string): number | null {
    for (let h = this.height; h >= 1 && h > this.height - 10_000; h--)
      if (this.blockHash(h) === hash) return h;
    return null;
  }

  advanceBlocks(n: number): void {
    this.height += n;
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((r) => this.server?.listen(0, "127.0.0.1", r));
    const a = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${a.port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: { id: string; method: string; params: Record<string, unknown> };
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (this.faults.down || (this.faults.statusDown && body.method === "EXPERIMENTAL_tx_status")) {
      res.writeHead(503).end();
      return;
    }
    const reply = (payload: Record<string, unknown>) => {
      const s = JSON.stringify({ jsonrpc: "2.0", id: body.id, ...payload });
      res
        .writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(s) })
        .end(s);
    };
    const error = (cause: string, message = cause) =>
      reply({ error: { name: "HANDLER_ERROR", cause: { name: cause }, message } });
    try {
      switch (body.method) {
        case "block":
          return reply({
            result: {
              header: {
                height: this.height,
                hash: this.blockHash(this.height),
                // NEAR block headers carry the block time in nanoseconds (as a string, and as a number).
                timestamp: this.now() * 1_000_000,
                timestamp_nanosec: (BigInt(this.now()) * 1_000_000n).toString(10),
              },
            },
          });
        case "query":
          return this.query(body.params, reply, error);
        case "send_tx": {
          if (this.faults.dropSendRequests > 0) {
            this.faults.dropSendRequests--;
            res.socket?.destroy();
            return;
          }
          const r = this.send(String(body.params["signed_tx_base64"] ?? ""));
          if ("error" in r) return error(r.error);
          if (this.faults.dropSendResponses > 0) {
            this.faults.dropSendResponses--;
            res.socket?.destroy();
            return;
          }
          return reply({ result: this.outcomeJson(r.tx) });
        }
        case "EXPERIMENTAL_tx_status": {
          const t = this.txs.get(String(body.params["tx_hash"] ?? ""));
          if (!t) return error("UNKNOWN_TRANSACTION");
          return reply({ result: this.outcomeJson(t) });
        }
        default:
          return error("METHOD_NOT_FOUND");
      }
    } catch (e) {
      return error("INTERNAL_ERROR", (e as Error).message);
    }
  }

  private query(
    p: Record<string, unknown>,
    reply: (x: Record<string, unknown>) => void,
    error: (c: string) => void,
  ): void {
    const base = { block_height: this.height, block_hash: this.blockHash(this.height) };
    if (p["request_type"] === "call_function") {
      this.sim.nowMs = this.now();
      const args = JSON.parse(Buffer.from(String(p["args_base64"] ?? ""), "base64").toString("utf8") || "{}");
      try {
        const ext = this.sim.externals.get(String(p["account_id"]));
        if (!ext && String(p["account_id"]) !== this.sim.contractId)
          throw new Error("account has no contract");
        const v = ext
          ? ext.view(String(p["method_name"]), args)
          : this.sim.view(String(p["method_name"]), args);
        reply({ result: { ...base, logs: [], result: [...Buffer.from(JSON.stringify(v))] } });
      } catch (e) {
        reply({ result: { ...base, logs: [], error: (e as Error).message } });
      }
      return;
    }
    if (p["request_type"] === "view_access_key") {
      const k = `${String(p["account_id"])}:${String(p["public_key"])}`;
      reply({ result: { ...base, nonce: Number(this.nonces.get(k) ?? 0n), permission: "FullAccess" } });
      return;
    }
    error("UNSUPPORTED_REQUEST");
  }

  private rid(seed: string): string {
    return base58Encode(createHash("sha256").update(seed).digest());
  }

  /** Include a transaction once; an identical re-broadcast returns the stored outcome. */
  send(encoded: string): { tx: StoredTx } | { error: string } {
    const hash = simTxHash(encoded);
    this.sendCount.set(hash, (this.sendCount.get(hash) ?? 0) + 1);
    const known = this.txs.get(hash);
    if (known) return { tx: known };
    let env: SimEnvelope;
    try {
      env = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as SimEnvelope;
    } catch {
      return { error: "INVALID_TRANSACTION" };
    }
    if (env.v !== SIM_TX_VERSION) return { error: "INVALID_TRANSACTION" };
    const ref = this.heightOf(env.blockHash);
    if (ref === null || this.height - ref > this.validityBlocks) return { error: "INVALID_TRANSACTION" };
    const nk = `${env.signerId}:${env.publicKey}`;
    const nonce = BigInt(env.nonce);
    if (nonce <= (this.nonces.get(nk) ?? 0n)) return { error: "INVALID_TRANSACTION" };
    this.nonces.set(nk, nonce);
    this.height += 1;
    this.sim.nowMs = this.now();
    const deposit = BigInt(env.depositYocto);
    if (this.sim.externals.has(env.receiverId)) return { tx: this.sendExternal(hash, env, ref, deposit) };
    if (env.receiverId !== this.sim.contractId) return { error: "INVALID_TRANSACTION" };
    this.sim.credit(env.signerId, -deposit);
    const r = this.sim.call(env.methodName, env.args, { predecessor: env.signerId, depositYocto: deposit });
    if (!r.ok) this.sim.credit(env.signerId, deposit);
    else this.executions.set(env.methodName, (this.executions.get(env.methodName) ?? 0) + 1);
    const first: SimReceipt = {
      receipt_id: this.rid(`${hash}:0`),
      predecessor_id: env.signerId,
      receiver_id: env.receiverId,
      actions: [
        {
          FunctionCall: {
            method_name: env.methodName,
            args: Buffer.from(JSON.stringify(env.args)).toString("base64"),
            gas: Number(BigInt(env.gas) / 1000n),
            deposit: env.depositYocto,
          },
        },
      ],
      status: r.ok
        ? { SuccessValue: Buffer.from(r.raw ?? "").toString("base64") }
        : { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: r.error } } } } },
    };
    const tx: StoredTx = {
      hash,
      env,
      refHeight: ref,
      receipts: [first],
      status: null,
      final: false,
      deferred: [],
    };
    this.txs.set(hash, tx);
    if (!r.ok) {
      tx.status = first.status;
      tx.final = true;
      tx.receipts.push(this.gasRefund(hash, env.signerId));
      return { tx };
    }
    this.runBatches(tx, r);
    return { tx };
  }

  /** A transaction to another simulated contract (a token wallet call such as ft_transfer_call). */
  private sendExternal(hash: string, env: SimEnvelope, ref: number, deposit: bigint): StoredTx {
    const ext = this.sim.externals.get(env.receiverId);
    if (!ext) throw new Error("no external contract");
    const args = (env.args ?? {}) as Record<string, unknown>;
    const res = ext.call(env.methodName, args, {
      predecessor: env.signerId,
      depositYocto: deposit,
      sim: this.sim,
    });
    if (res.ok) {
      this.sim.credit(env.signerId, -deposit);
      this.sim.credit(env.receiverId, deposit);
      this.executions.set(env.methodName, (this.executions.get(env.methodName) ?? 0) + 1);
    }
    const receipts: SimReceipt[] = [
      {
        receipt_id: this.rid(`${hash}:0`),
        predecessor_id: env.signerId,
        receiver_id: env.receiverId,
        actions: [
          {
            FunctionCall: {
              method_name: env.methodName,
              args: Buffer.from(JSON.stringify(env.args)).toString("base64"),
              gas: Number(BigInt(env.gas) / 1000n),
              deposit: env.depositYocto,
            },
          },
        ],
        status: outcomeStatus(res.ok, res.raw, res.error),
      },
    ];
    for (const [i, n] of res.nested.entries())
      receipts.push({
        receipt_id: this.rid(`${hash}:nested:${i}`),
        predecessor_id: n.predecessor,
        receiver_id: n.receiver,
        actions: [
          {
            FunctionCall: {
              method_name: n.method,
              args: Buffer.from(n.args).toString("base64"),
              deposit: "0",
            },
          },
        ],
        status: outcomeStatus(n.ok, n.raw, n.error),
      });
    receipts.push(this.gasRefund(hash, env.signerId));
    const tx: StoredTx = {
      hash,
      env,
      refHeight: ref,
      receipts,
      status: outcomeStatus(res.ok, res.raw, res.error),
      final: true,
      deferred: [],
    };
    this.txs.set(hash, tx);
    return tx;
  }

  private gasRefund(hash: string, to: string): SimReceipt {
    return {
      receipt_id: this.rid(`${hash}:gas-refund`),
      predecessor_id: "system",
      receiver_id: to,
      actions: [{ Transfer: { deposit: "1" } }],
      status: { SuccessValue: "" },
    };
  }

  private runBatches(tx: StoredTx, r: CallResult): void {
    const outcome = new Map<number, "success" | "failure">();
    let lastValue: Record<string, unknown> | null =
      r.returnedPromise === null ? { SuccessValue: Buffer.from(r.raw ?? "").toString("base64") } : null;
    for (const p of r.promises) {
      const deps = p.after === null ? [] : [outcome.get(p.after) ?? "failure"];
      const receipt: SimReceipt = {
        receipt_id: this.rid(`${tx.hash}:${tx.receipts.length}`),
        predecessor_id: this.sim.contractId,
        receiver_id: p.receiver,
        actions: [],
        status: null,
      };
      const callbacks = p.actions.some((a) => a.kind === "function_call");
      if (callbacks && this.faults.deferCallbacks && p.receiver === this.sim.contractId) {
        for (const a of p.actions)
          receipt.actions.push({
            FunctionCall: {
              method_name: a.method,
              args: Buffer.from(a.args ?? "").toString("base64"),
              deposit: String(a.amountYocto),
            },
          });
        tx.receipts.push(receipt);
        tx.deferred.push({ batch: p, deps, receipt });
        continue;
      }
      let status: "success" | "failure" = "success";
      let externalStatus: Record<string, unknown> | null = null;
      let externalRefund: bigint | null = null;
      const nested: CallResult[] = [];
      for (const a of p.actions) {
        if (a.kind === "transfer") {
          receipt.actions.push({ Transfer: { deposit: String(a.amountYocto) } });
          if (this.sim.missing.has(p.receiver) || this.sim.balance(this.sim.contractId) < a.amountYocto) {
            status = "failure";
            continue;
          }
          this.sim.credit(this.sim.contractId, -a.amountYocto);
          this.sim.credit(p.receiver, a.amountYocto);
        } else {
          receipt.actions.push({
            FunctionCall: {
              method_name: a.method,
              args: Buffer.from(a.args ?? "").toString("base64"),
              deposit: String(a.amountYocto),
            },
          });
          const ext = this.sim.externals.get(p.receiver);
          if (ext) {
            // Cross-contract call from the escrow (the recovery adapter). A failed receipt is
            // reverted and its attached deposit returns to the escrow in a runtime refund receipt.
            const xr = ext.call(a.method ?? "", JSON.parse(a.args ?? "{}"), {
              predecessor: this.sim.contractId,
              depositYocto: a.amountYocto,
              sim: this.sim,
            });
            if (xr.ok) {
              this.sim.credit(this.sim.contractId, -a.amountYocto);
              this.sim.credit(p.receiver, a.amountYocto);
            }
            externalStatus = outcomeStatus(xr.ok, xr.raw, xr.error);
            if (!xr.ok) externalRefund = a.amountYocto;
            status = xr.ok ? "success" : "failure";
            continue;
          }
          const res = this.sim.call(a.method ?? "", JSON.parse(a.args ?? "{}"), {
            predecessor: this.sim.contractId,
            depositYocto: a.amountYocto,
            promiseResults: deps,
          });
          if (res.ok && res.promises.length > 0) nested.push(res);
          status = res.ok ? "success" : "failure";
          if (res.ok) lastValue = { SuccessValue: Buffer.from(res.raw ?? "").toString("base64") };
          else
            lastValue = {
              Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: res.error } } } },
            };
        }
      }
      receipt.status =
        status === "success"
          ? { SuccessValue: "" }
          : { Failure: { ActionError: { kind: "TransferFailed" } } };
      if (callbacks && lastValue) receipt.status = lastValue;
      if (externalStatus) receipt.status = externalStatus;
      tx.receipts.push(receipt);
      if (externalRefund !== null)
        tx.receipts.push({
          receipt_id: this.rid(`${tx.hash}:refund:${p.index}`),
          predecessor_id: "system",
          receiver_id: this.sim.contractId,
          actions: [{ Transfer: { deposit: String(externalRefund) } }],
          status: { SuccessValue: "" },
        });
      for (const n of nested) this.runNested(tx, n);
      if (status === "failure" && !callbacks)
        tx.receipts.push({
          receipt_id: this.rid(`${tx.hash}:refund:${p.index}`),
          predecessor_id: "system",
          receiver_id: this.sim.contractId,
          actions: p.actions
            .filter((a) => a.kind === "transfer")
            .map((a) => ({ Transfer: { deposit: String(a.amountYocto) } })),
          status: { SuccessValue: "" },
        });
      outcome.set(p.index, status);
    }
    if (tx.deferred.length === 0) {
      tx.status = lastValue;
      tx.final = true;
      tx.receipts.push(this.gasRefund(tx.hash, tx.env.signerId));
    }
  }

  /** Transfers a callback scheduled itself (for example returning an adapter deposit). */
  private runNested(tx: StoredTx, r: CallResult): void {
    for (const p of r.promises) {
      const receipt: SimReceipt = {
        receipt_id: this.rid(`${tx.hash}:${tx.receipts.length}`),
        predecessor_id: this.sim.contractId,
        receiver_id: p.receiver,
        actions: [],
        status: { SuccessValue: "" },
      };
      for (const a of p.actions) {
        if (a.kind !== "transfer") continue;
        receipt.actions.push({ Transfer: { deposit: String(a.amountYocto) } });
        if (this.sim.missing.has(p.receiver) || this.sim.balance(this.sim.contractId) < a.amountYocto) {
          receipt.status = { Failure: { ActionError: { kind: "TransferFailed" } } };
          continue;
        }
        this.sim.credit(this.sim.contractId, -a.amountYocto);
        this.sim.credit(p.receiver, a.amountYocto);
      }
      tx.receipts.push(receipt);
    }
  }

  /** Deliver held callbacks (a late settlement in a later block). */
  releaseCallbacks(): void {
    for (const tx of this.txs.values()) {
      if (tx.deferred.length === 0) continue;
      this.height += 1;
      this.sim.nowMs = this.now();
      let last: Record<string, unknown> | null = null;
      for (const d of tx.deferred) {
        for (const a of d.batch.actions) {
          if (a.kind !== "function_call") continue;
          const res = this.sim.call(a.method ?? "", JSON.parse(a.args ?? "{}"), {
            predecessor: this.sim.contractId,
            depositYocto: a.amountYocto,
            promiseResults: d.deps,
          });
          last = res.ok
            ? { SuccessValue: Buffer.from(res.raw ?? "").toString("base64") }
            : { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: res.error } } } } };
        }
        d.receipt.status = last;
      }
      tx.deferred = [];
      tx.status = last;
      tx.final = true;
      tx.receipts.push(this.gasRefund(tx.hash, tx.env.signerId));
    }
  }

  /** Replace what the node reports for a transaction's receipts (a contradicting source). */
  tamperReceipts(txHash: string, fn: (r: SimReceipt[]) => void): void {
    const t = this.txs.get(txHash);
    if (!t) throw new Error("unknown tx");
    fn(t.receipts);
  }

  outcomeJson(t: StoredTx): Record<string, unknown> {
    const hide = this.faults.hideReceipts.has(t.hash);
    return {
      final_execution_status: t.final ? "FINAL" : "EXECUTED_OPTIMISTIC",
      status: t.status ?? {},
      transaction: {
        hash: t.hash,
        signer_id: t.env.signerId,
        receiver_id: t.env.receiverId,
        nonce: Number(t.env.nonce),
        block_hash: t.env.blockHash,
      },
      transaction_outcome: {
        id: t.hash,
        outcome: { status: { SuccessReceiptId: t.receipts[0]?.receipt_id } },
      },
      ...(hide
        ? {}
        : {
            receipts_outcome: t.receipts.map((r) => ({
              id: r.receipt_id,
              outcome: { executor_id: r.receiver_id, status: r.status ?? {}, logs: [] },
            })),
            receipts: t.receipts.map((r) => ({
              receipt_id: r.receipt_id,
              predecessor_id: r.predecessor_id,
              receiver_id: r.receiver_id,
              receipt: { Action: { actions: r.actions } },
            })),
          }),
    };
  }
}
