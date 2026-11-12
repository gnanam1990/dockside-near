import { DocksideError, fail, type JsonValue } from "@dockside/core";
import type { FunctionCall } from "./escrow.js";
import type { JsonRpcNearClient } from "./rpc.js";

/**
 * NEAR transaction boundary for relayed escrow calls (M05).
 *
 * The journal signs exactly one transaction per economic operation, persists its hash and signed
 * bytes, and only then broadcasts. Afterwards the outcome is always looked up by that original
 * hash (`EXPERIMENTAL_tx_status`): a lost response is never answered by a second submit.
 *
 * Signing is behind `TxSigner`. A relayer signer for NEAR testnet needs a relayer account and
 * key, which are BLOCKED in this build (no accounts or keys may be created or used); the
 * simulated chain used by the tests has its own signer in the test tree.
 */

export interface SignedTx {
  readonly txHash: string;
  readonly signerId: string;
  /** base64 of the signed transaction bytes, exactly as broadcast. */
  readonly encoded: string;
}

export interface TxSigner {
  readonly signerId: string;
  readonly publicKey: string;
  sign(call: FunctionCall, ref: { readonly nonce: bigint; readonly blockHash: string }): Promise<SignedTx>;
}

/** One action receipt of a transaction, with its execution outcome. */
export interface ReceiptOutcome {
  readonly receiptId: string;
  readonly predecessorId: string;
  readonly receiverId: string;
  readonly transfers: readonly bigint[];
  readonly calls: readonly { readonly method: string; readonly args: string }[];
  readonly status: "SUCCESS" | "FAILURE" | "PENDING";
}

export type TxOutcome =
  | {
      readonly kind: "FINAL_SUCCESS" | "FINAL_FAILURE" | "EXECUTING";
      readonly txHash: string;
      /** null when the node did not return receipts (pruned, private or unsupported). */
      readonly receipts: readonly ReceiptOutcome[] | null;
      readonly returnValue: string | null;
      readonly error: string | null;
      readonly blockHash: string | null;
    }
  | { readonly kind: "NOT_FOUND"; readonly txHash: string };

function isObj(v: unknown): v is Record<string, JsonValue> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function statusOf(s: unknown): "SUCCESS" | "FAILURE" | "PENDING" {
  if (!isObj(s)) return "PENDING";
  if ("SuccessValue" in s || "SuccessReceiptId" in s) return "SUCCESS";
  if ("Failure" in s) return "FAILURE";
  return "PENDING";
}

function u128(v: unknown): bigint {
  if (typeof v !== "string" || !/^(0|[1-9][0-9]{0,38})$/.test(v)) fail("UPSTREAM_INVALID", "expected u128");
  return BigInt(v);
}

/** Parse an `EXPERIMENTAL_tx_status` / `send_tx` result into a typed outcome. */
export function parseTxOutcome(txHash: string, r: JsonValue): TxOutcome {
  if (!isObj(r)) fail("UPSTREAM_INVALID", "transaction outcome malformed");
  const fin = r["final_execution_status"];
  const st = r["status"];
  const overall = statusOf(st);
  let receipts: ReceiptOutcome[] | null = null;
  if (Array.isArray(r["receipts"]) && Array.isArray(r["receipts_outcome"])) {
    const outcomes = new Map<string, "SUCCESS" | "FAILURE" | "PENDING">();
    for (const o of r["receipts_outcome"]) {
      if (!isObj(o) || typeof o["id"] !== "string" || !isObj(o["outcome"]))
        fail("UPSTREAM_INVALID", "receipt outcome malformed");
      outcomes.set(o["id"], statusOf(o["outcome"]["status"]));
    }
    receipts = [];
    for (const x of r["receipts"]) {
      if (!isObj(x) || typeof x["receipt_id"] !== "string") fail("UPSTREAM_INVALID", "receipt malformed");
      const rc = x["receipt"];
      const action = isObj(rc) && isObj(rc["Action"]) ? rc["Action"] : null;
      const actions = action && Array.isArray(action["actions"]) ? action["actions"] : [];
      const transfers: bigint[] = [];
      const calls: { method: string; args: string }[] = [];
      for (const a of actions) {
        if (isObj(a) && isObj(a["Transfer"])) transfers.push(u128(a["Transfer"]["deposit"]));
        else if (isObj(a) && isObj(a["FunctionCall"])) {
          const fc = a["FunctionCall"];
          calls.push({
            method: String(fc["method_name"] ?? ""),
            args: Buffer.from(String(fc["args"] ?? ""), "base64").toString("utf8"),
          });
        }
      }
      receipts.push({
        receiptId: x["receipt_id"],
        predecessorId: String(x["predecessor_id"] ?? ""),
        receiverId: String(x["receiver_id"] ?? ""),
        transfers,
        calls,
        status: outcomes.get(x["receipt_id"]) ?? "PENDING",
      });
    }
  }
  const final = fin === "FINAL" && overall !== "PENDING" && !receipts?.some((x) => x.status === "PENDING");
  const kind = final ? (overall === "SUCCESS" ? "FINAL_SUCCESS" : "FINAL_FAILURE") : "EXECUTING";
  const sv = isObj(st) ? st["SuccessValue"] : undefined;
  const tx = r["transaction"];
  return {
    kind,
    txHash,
    receipts,
    returnValue: typeof sv === "string" && sv.length > 0 ? Buffer.from(sv, "base64").toString("utf8") : null,
    error: isObj(st) && "Failure" in st ? JSON.stringify(st["Failure"]).slice(0, 2000) : null,
    blockHash: isObj(tx) && typeof tx["block_hash"] === "string" ? tx["block_hash"] : null,
  };
}

export class NearTxClient {
  constructor(private readonly rpc: JsonRpcNearClient) {}

  async latestBlock(): Promise<{ height: number; hash: string }> {
    const r = await this.rpc.request("block", { finality: "final" });
    const h = isObj(r) && isObj(r["header"]) ? r["header"] : null;
    if (!h || typeof h["height"] !== "number" || typeof h["hash"] !== "string")
      fail("UPSTREAM_INVALID", "block header malformed");
    return { height: h["height"], hash: h["hash"] };
  }

  /**
   * Time of the latest final block in milliseconds (`header.timestamp_nanosec`). This is the clock
   * the escrow contract checks windows, deadlines and expiry against; callers that prepare
   * contract-checked payloads or pre-check contract time use it instead of their own wall clock.
   */
  async blockTimeMs(): Promise<number> {
    const r = await this.rpc.request("block", { finality: "final" });
    const h = isObj(r) && isObj(r["header"]) ? r["header"] : null;
    const ns = h ? h["timestamp_nanosec"] : undefined;
    if (typeof ns !== "string" || !/^[0-9]{1,30}$/.test(ns))
      fail("UPSTREAM_INVALID", "block timestamp malformed");
    const ms = BigInt(ns) / 1_000_000n;
    if (ms > BigInt(Number.MAX_SAFE_INTEGER)) fail("UPSTREAM_INVALID", "block timestamp out of range");
    return Number(ms);
  }

  async accessKeyNonce(accountId: string, publicKey: string): Promise<bigint> {
    return (await this.rpc.viewAccessKey(accountId, publicKey)).nonce;
  }

  /** Broadcast the persisted signed transaction once; any transport doubt propagates. */
  async send(tx: SignedTx): Promise<TxOutcome> {
    const r = await this.rpc.request("send_tx", { signed_tx_base64: tx.encoded, wait_until: "FINAL" });
    return parseTxOutcome(tx.txHash, r);
  }

  /** Outcome of the original transaction, by its hash. NOT_FOUND is a fact, not a failure. */
  async status(txHash: string, senderId: string): Promise<TxOutcome> {
    try {
      const r = await this.rpc.request("EXPERIMENTAL_tx_status", {
        tx_hash: txHash,
        sender_account_id: senderId,
        wait_until: "NONE",
      });
      return parseTxOutcome(txHash, r);
    } catch (e) {
      if (e instanceof DocksideError && e.code === "NOT_FOUND") return { kind: "NOT_FOUND", txHash };
      throw e;
    }
  }
}
