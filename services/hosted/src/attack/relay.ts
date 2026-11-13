import type { JsonValue } from "@dockside/core";
import { JsonRpcNearClient, type TxSigner } from "@dockside/near";
import {
  AttackError,
  type AttackId,
  attackSpec,
  buildAttack,
  type ChainSnapshot,
  type DemoConfig,
  demoArmed,
  type EvidenceView,
  type HoldView,
  type LedgerView,
  type ReleaseView,
  refusalOf,
} from "./attacks.js";

/**
 * The attack relay (M53, ADR-0029): turns one button press into one real transaction from the
 * demo account's function-call key, and reports what the escrow answered.
 *
 * What it will and will not do:
 * - It sends only the five fixed calls of `ATTACKS`, built from the chain's own views; a caller
 *   chooses which one, never its arguments.
 * - It sends nothing unless the demo is armed (`demoArmed`): unreleased, paying the bound supplier,
 *   and blocked by a hold. If an attempt is ever accepted by the contract, the relay stops for good
 *   (`ACCEPTED`) until it is restarted by its operator.
 * - One transaction at a time (nonces stay ordered), a minimum interval per client, and a rolling
 *   cap over all clients. The key is a function-call key restricted to the escrow with an allowance,
 *   so the cap is also bounded on chain.
 * - It never reports a refusal it did not read: the code comes from the escrow receipt of the
 *   transaction, read back from the RPC.
 */

export const ATTACK_GAS = "50000000000000";

export interface RelayChain {
  nowMs(): Promise<number>;
  view(contract: string, method: string, args: Record<string, unknown>): Promise<unknown>;
  accessKeyNonce(accountId: string, publicKey: string): Promise<bigint>;
  latestBlockHash(): Promise<string>;
  /** Broadcast and wait for the final outcome; returns the raw RPC transaction result. */
  send(encoded: string, txHash: string, signerId: string): Promise<Record<string, unknown>>;
  /** A transaction's final outcome by hash (`EXPERIMENTAL_tx_status`). */
  txStatus(txHash: string, signerId: string): Promise<Record<string, unknown>>;
}

export interface RelayLimits {
  /** Minimum time between two attempts of one client. */
  readonly perClientMs: number;
  /** At most `windowMax` attempts over all clients in any `windowMs`. */
  readonly windowMs: number;
  readonly windowMax: number;
}

export const DEFAULT_LIMITS: RelayLimits = { perClientMs: 20_000, windowMs: 10 * 60_000, windowMax: 30 };

export interface AttemptResult {
  readonly attack: AttackId;
  readonly title: string;
  readonly method: string;
  readonly txHash: string;
  readonly signer: string;
  readonly refused: boolean;
  readonly code: string | null;
  readonly message: string | null;
  readonly expected: string;
  readonly blockHash: string | null;
  /** The trade's ledger totals before and after the attempt, read from the chain. */
  readonly ledgerBefore: Readonly<Record<string, string>>;
  readonly ledgerAfter: Readonly<Record<string, string>>;
  readonly fundsUnchanged: boolean;
  /** Transactions sent with the demo key since the demo was set up (access key nonce delta). */
  readonly attempts: string;
  readonly sentAt: string;
}

/** The escrow's receipt of a function-call transaction and the panic text it carries, if any. */
export function escrowOutcome(
  tx: Record<string, unknown>,
  escrow: string,
): { ran: boolean; failed: boolean; text: string | null; blockHash: string | null } {
  const outcomes = Array.isArray(tx["receipts_outcome"])
    ? (tx["receipts_outcome"] as Record<string, unknown>[])
    : [];
  const main = outcomes.find(
    (o) => (o["outcome"] as Record<string, unknown> | undefined)?.["executor_id"] === escrow,
  );
  if (!main) return { ran: false, failed: false, text: null, blockHash: null };
  const status = (main["outcome"] as Record<string, unknown>)["status"] as
    | Record<string, unknown>
    | undefined;
  const failure = status?.["Failure"] as Record<string, unknown> | undefined;
  const kind = (failure?.["ActionError"] as Record<string, unknown> | undefined)?.["kind"] as
    | Record<string, unknown>
    | undefined;
  const fce = kind?.["FunctionCallError"] as Record<string, unknown> | undefined;
  const text = typeof fce?.["ExecutionError"] === "string" ? (fce["ExecutionError"] as string) : null;
  return {
    ran: true,
    failed: failure !== undefined,
    text: text ?? (failure ? JSON.stringify(failure) : null),
    blockHash: typeof main["block_hash"] === "string" ? (main["block_hash"] as string) : null,
  };
}

const sameTotals = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>) =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

export class AttackRelay {
  private inFlight = false;
  private stopped: string | null = null;
  private readonly lastByClient = new Map<string, number>();
  private readonly recent: number[] = [];
  readonly log: AttemptResult[] = [];

  constructor(
    private readonly o: {
      readonly config: DemoConfig;
      readonly chain: RelayChain;
      readonly signer: TxSigner;
      readonly limits?: RelayLimits;
      readonly clock?: () => number;
      readonly onAttempt?: (r: AttemptResult) => void;
    },
  ) {
    const c = o.config;
    if (c.status !== "LIVE" || !c.escrow || !c.attacker)
      throw new AttackError("DEMO_NOT_SET_UP", "the demo trade is not set up");
    if (o.signer.signerId !== c.attacker.accountId || o.signer.publicKey !== c.attacker.publicKey)
      throw new AttackError("KEY_REFUSED", "the key is not the demo config's attacker key");
    if (
      c.parties &&
      (o.signer.signerId === c.parties.buyer ||
        o.signer.signerId === c.parties.supplier ||
        o.signer.signerId === c.escrow)
    )
      throw new AttackError("KEY_REFUSED", "the attacker must not be a party of the trade");
  }

  private get limits(): RelayLimits {
    return this.o.limits ?? DEFAULT_LIMITS;
  }
  private now(): number {
    return (this.o.clock ?? Date.now)();
  }

  async snapshot(): Promise<ChainSnapshot> {
    const c = this.o.config;
    const escrow = c.escrow as string;
    const trade_id = c.tradeId as string;
    const [nowMs, release, holds, evidence, ledger] = await Promise.all([
      this.o.chain.nowMs(),
      this.o.chain.view(escrow, "get_release", { trade_id }),
      this.o.chain.view(escrow, "get_holds", { trade_id }),
      this.o.chain.view(escrow, "get_evidence", { trade_id }),
      this.o.chain.view(escrow, "get_ledger", { trade_id }),
    ]);
    return {
      nowMs,
      release: release as ReleaseView,
      holds: holds as HoldView[],
      evidence: evidence as EvidenceView,
      ledger: ledger as LedgerView,
    };
  }

  async attemptsSoFar(): Promise<bigint> {
    const c = this.o.config;
    const nonce = await this.o.chain.accessKeyNonce(this.o.signer.signerId, this.o.signer.publicKey);
    return nonce - BigInt(c.baselineNonce ?? "0");
  }

  async status(): Promise<Record<string, unknown>> {
    const s = await this.snapshot();
    const armed = demoArmed(this.o.config, s);
    return {
      enabled: this.stopped === null,
      stopped: this.stopped,
      armed: armed.armed,
      why: armed.why,
      attacker: this.o.signer.signerId,
      attempts: (await this.attemptsSoFar()).toString(),
      limits: this.limits,
      blockers: s.release.blockers,
      ledger: s.ledger.totals,
    };
  }

  /** Rate limits; throws RATE_LIMITED with the time to wait. Records the attempt when allowed. */
  private admit(client: string): void {
    const t = this.now();
    const l = this.limits;
    while (this.recent.length > 0 && t - (this.recent[0] as number) >= l.windowMs) this.recent.shift();
    const last = this.lastByClient.get(client);
    if (last !== undefined && t - last < l.perClientMs)
      throw new AttackError("RATE_LIMITED", "one attempt per client at a time", l.perClientMs - (t - last));
    if (this.recent.length >= l.windowMax)
      throw new AttackError(
        "RATE_LIMITED",
        "the console's attempt budget for this period is used up",
        l.windowMs - (t - (this.recent[0] as number)),
      );
    this.lastByClient.set(client, t);
    this.recent.push(t);
    if (this.lastByClient.size > 10_000) this.lastByClient.clear();
  }

  async attempt(id: AttackId, client: string): Promise<AttemptResult> {
    const spec = attackSpec(id);
    if (this.stopped) throw new AttackError("ACCEPTED", this.stopped);
    if (this.inFlight)
      throw new AttackError("BUSY", "another attempt is being sent; try again in a few seconds");
    this.inFlight = true;
    try {
      const c = this.o.config;
      const escrow = c.escrow as string;
      const before = await this.snapshot();
      const armed = demoArmed(c, before);
      if (!armed.armed) throw new AttackError("DEMO_NOT_ARMED", `nothing is sent: ${armed.why}`);
      const built = buildAttack(id, c, before);
      this.admit(client);
      const nonce = (await this.o.chain.accessKeyNonce(this.o.signer.signerId, this.o.signer.publicKey)) + 1n;
      const blockHash = await this.o.chain.latestBlockHash();
      const signed = await this.o.signer.sign(
        {
          receiverId: escrow,
          methodName: built.method,
          args: built.args,
          gas: ATTACK_GAS,
          depositYocto: "0",
        },
        { nonce, blockHash },
      );
      let tx: Record<string, unknown>;
      try {
        tx = await this.o.chain.send(signed.encoded, signed.txHash, signed.signerId);
      } catch (e) {
        throw new AttackError(
          "SEND_FAILED",
          `the transaction ${signed.txHash} could not be confirmed: ${(e as Error).message}`,
        );
      }
      const out = escrowOutcome(tx, escrow);
      if (!out.ran)
        throw new AttackError("SEND_FAILED", `the transaction ${signed.txHash} did not reach the escrow`);
      const after = await this.snapshot();
      const r = refusalOf(out.text);
      const result: AttemptResult = {
        attack: id,
        title: spec.title,
        method: built.method,
        txHash: signed.txHash,
        signer: signed.signerId,
        refused: out.failed,
        code: r.code,
        message: r.message,
        expected: spec.expect,
        blockHash: out.blockHash,
        ledgerBefore: before.ledger.totals,
        ledgerAfter: after.ledger.totals,
        fundsUnchanged: sameTotals(before.ledger.totals, after.ledger.totals),
        attempts: (await this.attemptsSoFar()).toString(),
        sentAt: new Date(this.now()).toISOString(),
      };
      this.log.push(result);
      if (this.log.length > 500) this.log.shift();
      this.o.onAttempt?.(result);
      if (!out.failed || !result.fundsUnchanged) {
        this.stopped = `attempt ${signed.txHash} (${id}) was not refused; the console stopped sending`;
      }
      return result;
    } finally {
      this.inFlight = false;
    }
  }
}

/* ------------------------------------------------------------------------------------------ */
/* JSON-RPC adapter                                                                            */
/* ------------------------------------------------------------------------------------------ */

function isObj(v: unknown): v is Record<string, JsonValue> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The relay's chain over NEAR JSON-RPC (one endpoint; https, or http on loopback). */
export function rpcChain(endpoint: string, timeoutMs = 60_000): RelayChain {
  const host = new URL(endpoint).hostname;
  const rpc = new JsonRpcNearClient({
    endpoint,
    allowedHosts: [host],
    timeoutMs,
    maxResponseBytes: 4 * 1024 * 1024,
  });
  const block = async () => {
    const r = await rpc.request("block", { finality: "final" });
    const h = isObj(r) && isObj(r["header"]) ? r["header"] : null;
    if (!h || typeof h["hash"] !== "string" || typeof h["timestamp_nanosec"] !== "string")
      throw new Error("block header malformed");
    return { hash: h["hash"], ms: Number(BigInt(h["timestamp_nanosec"]) / 1_000_000n) };
  };
  const status = async (txHash: string, signerId: string) => {
    const r = await rpc.request("EXPERIMENTAL_tx_status", {
      tx_hash: txHash,
      sender_account_id: signerId,
      wait_until: "FINAL",
    });
    if (!isObj(r)) throw new Error("transaction outcome malformed");
    return r as Record<string, unknown>;
  };
  return {
    nowMs: async () => (await block()).ms,
    txStatus: status,
    latestBlockHash: async () => (await block()).hash,
    view: async (contract, method, args) => (await rpc.callView(contract, method, args)).value,
    accessKeyNonce: async (accountId, publicKey) => (await rpc.viewAccessKey(accountId, publicKey)).nonce,
    send: async (encoded, txHash, signerId) => {
      try {
        const r = await rpc.request("send_tx", { signed_tx_base64: encoded, wait_until: "FINAL" });
        if (isObj(r)) return r as Record<string, unknown>;
      } catch {
        // A timeout or a lost answer: the transaction may still have been included. Ask by hash.
      }
      for (let i = 0; i < 10; i++) {
        try {
          return await status(txHash, signerId);
        } catch {
          await new Promise((ok) => setTimeout(ok, 3000));
        }
      }
      throw new Error("no final outcome");
    },
  };
}
