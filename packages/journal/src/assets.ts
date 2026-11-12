import { type Clock, DocksideError, fail, type IdGenerator } from "@dockside/core";
import type {
  AssetRecoveryView,
  EscrowContract,
  FunctionCall,
  Nep141Reader,
  NearTxClient,
  SignedTx,
  TxOutcome,
  TxSigner,
} from "@dockside/near";
import { type Database, isUniqueViolation, type Row, type SqlValue } from "@dockside/store";
import { Journal, type Lease } from "./journal.js";
import { digestOf } from "./sources.js";

/**
 * Execution journal for UNEXPECTED_ASSET_RECOVERY (0007_asset_recoveries.sql).
 *
 * The escrow contract decides every recovery; this journal only makes the one permissionless
 * `execute_asset_recovery` transaction durable and reconcilable:
 * - one operation per recovery id, one unresolved operation per asset record (unique index);
 * - the signed transaction, its hash and the pre-submit token balance are persisted with the
 *   QUEUED -> SUBMITTING transition, in one fenced transaction, before any broadcast;
 * - every later decision reads the contract's recovery record and the ORIGINAL transaction by
 *   its hash. A lost response is reconciled, never answered with a new transaction. Re-sending
 *   the identical persisted bytes (same hash, same nonce) is the only re-broadcast, and only
 *   while that transaction is still inside its validity window;
 * - RECOVERED needs the contract's RECOVERED record and a token balance that moved by at least
 *   the exact amount; a contradiction is REVIEW, which nothing here can leave;
 * - FAILED is the contract's FAILED record (the token contract reverted `ft_transfer`: an
 *   authoritative no-transfer). The recovery cannot be retried; a new request is required;
 * - NOT_SUBMITTED means the execute transaction never took effect (the contract refused it, the
 *   recovery ended before execution, or the transaction expired un-included). A new execution
 *   request then gets a new operation.
 */

export type AssetOpState =
  | "QUEUED"
  | "SUBMITTING"
  | "UNKNOWN"
  | "PROCESSING"
  | "RECOVERED"
  | "FAILED"
  | "NOT_SUBMITTED"
  | "REVIEW";

export const ASSET_OP_TERMINAL: readonly AssetOpState[] = ["RECOVERED", "FAILED", "NOT_SUBMITTED"];
const OPEN: readonly AssetOpState[] = ["QUEUED", "SUBMITTING", "UNKNOWN", "PROCESSING"];

export interface AssetOperation {
  readonly operationId: string;
  readonly recoveryId: string;
  readonly assetIndex: number;
  readonly assetContract: string;
  readonly recipient: string;
  readonly amount: bigint;
  readonly call: FunctionCall;
  readonly operationDigest: string;
  readonly state: AssetOpState;
  readonly version: number;
  readonly signerId: string | null;
  readonly txHash: string | null;
  readonly signedTx: string | null;
  readonly refBlockHeight: number | null;
  readonly tokenBalanceBefore: bigint | null;
  readonly lastReason: string | null;
  readonly nextCheckAt: number;
  readonly checks: number;
  readonly requestedBy: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface AssetObservation {
  readonly source: "CONTRACT" | "TX_STATUS" | "TOKEN" | "BROADCAST";
  readonly fact: Record<string, unknown>;
  readonly observedAt: number;
}

function toOp(r: Row): AssetOperation {
  const n = (k: string) => (r[k] === null || r[k] === undefined ? null : Number(r[k]));
  const s = (k: string) => (r[k] === null || r[k] === undefined ? null : String(r[k]));
  const before = s("token_balance_before");
  return {
    operationId: String(r["operation_id"]),
    recoveryId: String(r["recovery_id"]),
    assetIndex: Number(r["asset_index"]),
    assetContract: String(r["asset_contract"]),
    recipient: String(r["recipient"]),
    amount: BigInt(String(r["amount"])),
    call: JSON.parse(String(r["call_json"])) as FunctionCall,
    operationDigest: String(r["operation_digest"]),
    state: String(r["state"]) as AssetOpState,
    version: Number(r["version"]),
    signerId: s("signer_id"),
    txHash: s("tx_hash"),
    signedTx: s("signed_tx"),
    refBlockHeight: n("ref_block_height"),
    tokenBalanceBefore: before === null ? null : BigInt(before),
    lastReason: s("last_reason"),
    nextCheckAt: Number(r["next_check_at"]),
    checks: Number(r["checks"]),
    requestedBy: String(r["requested_by"]),
    createdAt: Number(r["created_at"]),
    updatedAt: Number(r["updated_at"]),
  };
}

export class AssetRecoveryJournal {
  /** Leases share the worker_leases table (and its fencing) with the M05 journal. */
  readonly leases: Journal;

  constructor(
    readonly db: Database,
    readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {
    this.leases = new Journal(db, clock, ids);
  }

  /**
   * Persist one execution of an approved, unchallenged recovery. An identical request joins the
   * existing operation; a different one for the same recovery or a second live one for the same
   * asset fails closed.
   */
  enqueue(input: {
    recoveryId: string;
    assetIndex: number;
    assetContract: string;
    recipient: string;
    amount: bigint;
    call: FunctionCall;
    requestedBy: string;
  }): { operationId: string; joined: boolean } {
    const material = {
      kind: "ASSET_RECOVERY",
      recoveryId: input.recoveryId,
      assetIndex: input.assetIndex,
      assetContract: input.assetContract,
      recipient: input.recipient,
      amount: input.amount.toString(10),
      call: [
        input.call.receiverId,
        input.call.methodName,
        JSON.stringify(input.call.args),
        input.call.depositYocto,
      ],
    };
    const digest = digestOf(material);
    const existing = this.forRecovery(input.recoveryId);
    if (existing && existing.state !== "NOT_SUBMITTED") {
      if (existing.state === "RECOVERED" || existing.state === "FAILED")
        fail("INVALID_STATE", `this recovery already settled ${existing.state}; a new request is required`);
      if (existing.operationDigest !== digest)
        fail("IDEMPOTENCY_CONFLICT", "a different execution already exists for this recovery");
      return { operationId: existing.operationId, joined: true };
    }
    const id = this.ids.next("aop");
    const now = this.clock.now();
    try {
      this.db.run(
        `INSERT INTO asset_recovery_operations (operation_id, recovery_id, asset_index, asset_contract, recipient, amount,
           call_json, operation_digest, state, next_check_at, requested_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?, ?)`,
        id,
        input.recoveryId,
        input.assetIndex,
        input.assetContract,
        input.recipient,
        input.amount.toString(10),
        JSON.stringify(input.call),
        digest,
        now,
        input.requestedBy,
        now,
        now,
      );
    } catch (e) {
      if (isUniqueViolation(e))
        fail("VALUE_LOCKED", "an unresolved recovery execution already owns this asset");
      throw e;
    }
    return { operationId: id, joined: false };
  }

  op(operationId: string): AssetOperation {
    const r = this.db.get("SELECT * FROM asset_recovery_operations WHERE operation_id = ?", operationId);
    if (!r) return fail("NOT_FOUND", "asset recovery operation not found");
    return toOp(r);
  }

  forRecovery(recoveryId: string): AssetOperation | null {
    const r = this.db.get(
      "SELECT * FROM asset_recovery_operations WHERE recovery_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      recoveryId,
    );
    return r ? toOp(r) : null;
  }

  forAsset(assetIndex: number): AssetOperation[] {
    return this.db
      .all("SELECT * FROM asset_recovery_operations WHERE asset_index = ? ORDER BY created_at", assetIndex)
      .map(toOp);
  }

  observations(operationId: string): AssetObservation[] {
    return this.db
      .all(
        "SELECT source, fact_json, observed_at FROM asset_recovery_observations WHERE operation_id = ? ORDER BY observed_at, id",
        operationId,
      )
      .map((r) => ({
        source: String(r["source"]) as AssetObservation["source"],
        fact: JSON.parse(String(r["fact_json"])) as Record<string, unknown>,
        observedAt: Number(r["observed_at"]),
      }));
  }

  due(now: number): string[] {
    return this.db
      .all(
        `SELECT operation_id FROM asset_recovery_operations
         WHERE state IN ('QUEUED', 'SUBMITTING', 'UNKNOWN', 'PROCESSING') AND next_check_at <= ?
         ORDER BY next_check_at, created_at`,
        now,
      )
      .map((r) => String(r["operation_id"]));
  }

  /** Fenced update: the caller still holds the lease and the version it read is current. */
  update(
    lease: Lease,
    op: AssetOperation,
    patch: {
      state?: AssetOpState;
      reason?: string | null;
      nextCheckAt?: number;
      tx?: { signerId: string; signed: SignedTx; refBlockHeight: number; tokenBalanceBefore: bigint };
    },
  ): AssetOperation {
    return this.db.transaction(() => {
      this.leases.fence(lease);
      const now = this.clock.now();
      const sets = ["version = version + 1", "updated_at = ?", "checks = checks + 1"];
      const args: SqlValue[] = [now];
      if (patch.state !== undefined) {
        sets.push("state = ?");
        args.push(patch.state);
      }
      if (patch.reason !== undefined) {
        sets.push("last_reason = ?");
        args.push(patch.reason);
      }
      sets.push("next_check_at = ?");
      args.push(patch.nextCheckAt ?? now);
      if (patch.tx) {
        sets.push(
          "signer_id = ?",
          "tx_hash = ?",
          "signed_tx = ?",
          "ref_block_height = ?",
          "token_balance_before = ?",
        );
        args.push(
          patch.tx.signerId,
          patch.tx.signed.txHash,
          patch.tx.signed.encoded,
          patch.tx.refBlockHeight,
          patch.tx.tokenBalanceBefore.toString(10),
        );
      }
      const changed = this.db.run(
        `UPDATE asset_recovery_operations SET ${sets.join(", ")} WHERE operation_id = ? AND version = ?`,
        ...args,
        op.operationId,
        op.version,
      );
      if (Number(changed.changes) === 0)
        fail("VERSION_CONFLICT", "asset recovery operation changed concurrently");
      return this.op(op.operationId);
    });
  }

  observe(
    lease: Lease,
    operationId: string,
    source: AssetObservation["source"],
    fact: Record<string, unknown>,
  ) {
    this.db.transaction(() => {
      this.leases.fence(lease);
      this.db.run(
        "INSERT INTO asset_recovery_observations (id, operation_id, source, fact_json, observed_at) VALUES (?, ?, ?, ?, ?)",
        this.ids.next("aob"),
        operationId,
        source,
        JSON.stringify(fact, (_k, v) => (typeof v === "bigint" ? v.toString(10) : v)),
        this.clock.now(),
      );
    });
  }
}

/* ------------------------------------ engine ------------------------------------ */

export interface AssetChainPorts {
  readonly escrow: EscrowContract;
  readonly tx: NearTxClient;
  /** Read-only NEP-141 views of the asset contract the escrow's record names. */
  readonly token: (assetContract: string) => Nep141Reader;
  readonly txValidityBlocks: number;
}

export interface AssetEngineConfig {
  readonly holder: string;
  readonly leaseTtlMs: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly onBoundary?: (boundary: string, operationId: string) => void;
}

function code(e: unknown): string {
  return e instanceof DocksideError ? e.code : ((e as { code?: string }).code ?? "INTERNAL");
}

function contractCode(outcome: TxOutcome): string | null {
  if (outcome.kind === "NOT_FOUND") return null;
  const m = /DOCKSIDE:([A-Z_]+):/.exec(outcome.error ?? "");
  return m?.[1] ?? null;
}

/**
 * The one component that broadcasts `execute_asset_recovery`, at most once per operation, and
 * reconciles each operation against the contract record and its original transaction.
 */
export class AssetRecoveryEngine {
  constructor(
    private readonly journal: AssetRecoveryJournal,
    private readonly ports: AssetChainPorts,
    private readonly signer: TxSigner,
    private readonly cfg: AssetEngineConfig,
  ) {}

  private boundary(b: string, id: string): void {
    this.cfg.onBoundary?.(b, id);
  }

  private later(op: AssetOperation): number {
    return (
      this.journal.clock.now() +
      Math.min(this.cfg.baseBackoffMs * 2 ** Math.min(op.checks, 20), this.cfg.maxBackoffMs)
    );
  }

  async runOnce(): Promise<string[]> {
    const done: string[] = [];
    for (const id of this.journal.due(this.journal.clock.now())) {
      const lease = this.journal.leases.acquireLease(`asset-op:${id}`, this.cfg.holder, this.cfg.leaseTtlMs);
      if (!lease) continue;
      try {
        const op = this.journal.op(id);
        if (op.state === "QUEUED") await this.submit(op, lease);
        else await this.reconcile(op, lease);
        done.push(id);
      } catch (e) {
        if (!["LEASE_LOST", "VERSION_CONFLICT"].includes(code(e))) throw e;
      } finally {
        this.journal.leases.releaseLease(lease);
      }
    }
    return done;
  }

  private async recovery(op: AssetOperation): Promise<AssetRecoveryView | null> {
    const a = await this.ports.escrow.getUnexpectedAsset(op.assetIndex);
    return a.recoveries.find((r) => r.recoveryId === op.recoveryId) ?? null;
  }

  private async submit(op: AssetOperation, lease: Lease): Promise<void> {
    let rec: AssetRecoveryView | null;
    let before: bigint;
    try {
      rec = await this.recovery(op);
      before = await this.ports.token(op.assetContract).balanceOf(this.ports.escrow.contractId);
    } catch (e) {
      // Nothing was signed or sent: try again later.
      this.journal.update(lease, op, {
        reason: `PRECHECK_UNAVAILABLE:${code(e)}`,
        nextCheckAt: this.later(op),
      });
      return;
    }
    this.journal.observe(lease, op.operationId, "CONTRACT", { recovery: rec, phase: "pre-submit" });
    this.journal.observe(lease, op.operationId, "TOKEN", { escrowBalance: before, phase: "pre-submit" });
    if (rec?.state !== "CHALLENGE_PERIOD") {
      const reason = rec ? `RECOVERY_${rec.state}` : "RECOVERY_NOT_FOUND";
      this.journal.update(lease, op, { state: "NOT_SUBMITTED", reason });
      return;
    }
    const block = await this.ports.tx.latestBlock();
    const nonce =
      (await this.ports.tx.accessKeyNonce(this.signer.signerId, this.signer.publicKey).catch(() => 0n)) + 1n;
    const signed = await this.signer.sign(op.call, { nonce, blockHash: block.hash });
    const submitting = this.journal.update(lease, op, {
      state: "SUBMITTING",
      reason: null,
      nextCheckAt: this.later(op),
      tx: {
        signerId: this.signer.signerId,
        signed,
        refBlockHeight: block.height,
        tokenBalanceBefore: before,
      },
    });
    this.boundary("asset.submit.persisted", op.operationId);
    let outcome: TxOutcome;
    try {
      outcome = await this.ports.tx.send(signed);
    } catch (e) {
      this.journal.update(lease, submitting, {
        state: "UNKNOWN",
        reason: `BROADCAST_UNCERTAIN:${code(e)}`,
        nextCheckAt: this.later(submitting),
      });
      return;
    }
    this.journal.observe(lease, op.operationId, "BROADCAST", { kind: outcome.kind, txHash: signed.txHash });
    this.boundary("asset.submit.broadcast", op.operationId);
    await this.reconcile(this.journal.op(op.operationId), lease, outcome);
  }

  /** Decide from the contract record and the original transaction; never sends a new one. */
  async reconcile(op: AssetOperation, lease: Lease, known?: TxOutcome): Promise<AssetOperation> {
    if (!op.txHash || !op.signerId || !op.signedTx) return op;
    let rec: AssetRecoveryView | null;
    let outcome: TxOutcome;
    let height: number;
    try {
      rec = await this.recovery(op);
      outcome = known ?? (await this.ports.tx.status(op.txHash, op.signerId));
      height = (await this.ports.tx.latestBlock()).height;
    } catch (e) {
      const to: AssetOpState | undefined = op.state === "SUBMITTING" ? "UNKNOWN" : undefined;
      return this.journal.update(lease, op, {
        ...(to ? { state: to } : {}),
        reason: `SOURCE_UNAVAILABLE:${code(e)}`,
        nextCheckAt: this.later(op),
      });
    }
    this.journal.observe(lease, op.operationId, "CONTRACT", { recovery: rec });
    this.journal.observe(lease, op.operationId, "TX_STATUS", {
      kind: outcome.kind,
      txHash: op.txHash,
      error: outcome.kind === "NOT_FOUND" ? null : outcome.error,
    });
    const state = rec?.state ?? null;
    if (state === "RECOVERED") {
      const after = await this.ports.token(op.assetContract).balanceOf(this.ports.escrow.contractId);
      this.journal.observe(lease, op.operationId, "TOKEN", {
        escrowBalance: after,
        phase: "post-settlement",
      });
      const moved = op.tokenBalanceBefore === null ? false : op.tokenBalanceBefore - after >= op.amount;
      return this.journal.update(lease, op, {
        state: moved ? "RECOVERED" : "REVIEW",
        reason: moved ? "CONTRACT_RECOVERED_TOKEN_MOVED" : "TOKEN_BALANCE_CONTRADICTS_CONTRACT",
        nextCheckAt: this.later(op),
      });
    }
    if (state === "FAILED")
      return this.journal.update(lease, op, { state: "FAILED", reason: "ADAPTER_TRANSFER_REVERTED" });
    if (state === "SUBMITTED")
      return this.journal.update(lease, op, {
        ...(op.state === "PROCESSING" ? {} : { state: "PROCESSING" as const }),
        reason: "AWAITING_ADAPTER_OUTCOME",
        nextCheckAt: this.later(op),
      });
    // The recovery was not executed by this transaction (still open, or ended before execution).
    if (outcome.kind === "FINAL_FAILURE")
      return this.journal.update(lease, op, {
        state: "NOT_SUBMITTED",
        reason: `CONTRACT_REFUSED:${contractCode(outcome) ?? "UNKNOWN"}`,
      });
    if (outcome.kind === "FINAL_SUCCESS")
      return this.journal.update(lease, op, {
        state: "REVIEW",
        reason: "TX_SUCCESS_WITHOUT_CONTRACT_EXECUTION",
      });
    if (outcome.kind === "NOT_FOUND" && op.refBlockHeight !== null) {
      if (height - op.refBlockHeight > this.ports.txValidityBlocks)
        return this.journal.update(lease, op, { state: "NOT_SUBMITTED", reason: "TX_EXPIRED_NOT_INCLUDED" });
      if (state === "CHALLENGE_PERIOD") {
        // Identical persisted bytes: same hash and nonce, so the chain can include it at most once.
        try {
          const again = await this.ports.tx.send({
            txHash: op.txHash,
            signerId: op.signerId,
            encoded: op.signedTx,
          });
          this.journal.observe(lease, op.operationId, "BROADCAST", {
            kind: again.kind,
            txHash: op.txHash,
            identical: true,
          });
        } catch (e) {
          this.journal.observe(lease, op.operationId, "BROADCAST", {
            error: code(e),
            txHash: op.txHash,
            identical: true,
          });
        }
      }
    }
    return this.journal.update(lease, op, {
      ...(op.state === "UNKNOWN" ? {} : { state: "UNKNOWN" as const }),
      reason: `TX_${outcome.kind}`,
      nextCheckAt: this.later(op),
    });
  }
}

export function isOpenAssetOp(s: AssetOpState): boolean {
  return OPEN.includes(s);
}
