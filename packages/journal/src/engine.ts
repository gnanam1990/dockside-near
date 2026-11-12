import { DocksideError, fail } from "@dockside/core";
import type { TxSigner } from "@dockside/near";
import { decide, ledgerChecks, postTerminalIncident, type ReceiptClass } from "./decide.js";
import type { Journal, Lease, OperationRecord } from "./journal.js";
import { withRelayerKey } from "./relayer.js";
import { type ChainPorts, digestOf, gatherFacts } from "./sources.js";
import { isTerminal, type OperationState, planPath, submitState } from "./states.js";

/**
 * Outbox worker and reconciler (TDD section 13). Both run under a fenced per-operation lease
 * (`op:<operationId>`): a worker that stalls past its TTL loses the epoch and every later write
 * of it is refused. The outbox worker is the only code that broadcasts, and it does so at most
 * once per operation: the signed transaction and its hash are persisted, together with the
 * SUBMITTING/EXECUTING transition and the outbox completion, before the broadcast. Nothing ever
 * re-reads the outbox for an operation that left QUEUED, so a crash anywhere after that point
 * resumes as reconciliation of the original transaction, never as a second submit.
 */

export interface EngineConfig {
  readonly holder: string;
  readonly leaseTtlMs: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  /** How long terminal operations keep being watched for contradicting late evidence. */
  readonly watchMs: number;
  /** Instrumentation hook at every persistence and effect boundary (structured logs, tests). */
  readonly onBoundary?: (boundary: string, operationId: string) => void;
}

export const DEFAULT_ENGINE_CONFIG = {
  leaseTtlMs: 30_000,
  baseBackoffMs: 2_000,
  maxBackoffMs: 5 * 60_000,
  watchMs: 24 * 3600_000,
} as const;

function isCode(e: unknown, ...codes: string[]): boolean {
  return e instanceof DocksideError && codes.includes(e.code);
}

export class Reconciler {
  constructor(
    private readonly journal: Journal,
    private readonly ports: ChainPorts,
    private readonly cfg: EngineConfig,
  ) {}

  private boundary(b: string, id: string): void {
    this.cfg.onBoundary?.(b, id);
  }

  private backoff(checks: number): number {
    return Math.min(this.cfg.baseBackoffMs * 2 ** Math.min(checks, 20), this.cfg.maxBackoffMs);
  }

  /** Reconcile every due operation once. Returns the operations it acted on. */
  async runOnce(): Promise<string[]> {
    const done: string[] = [];
    for (const id of this.journal.dueForReconciliation(this.journal.clock.now())) {
      const lease = this.journal.acquireLease(`op:${id}`, this.cfg.holder, this.cfg.leaseTtlMs);
      if (!lease) continue;
      try {
        await this.reconcileOne(id, lease);
        done.push(id);
      } catch (e) {
        if (!isCode(e, "LEASE_LOST", "VERSION_CONFLICT")) throw e;
      } finally {
        this.journal.releaseLease(lease);
      }
    }
    return done;
  }

  private receiptHistory(op: OperationRecord, current: ReceiptClass | null): ReceiptClass[] {
    const h = this.journal
      .observations(op.operationId, "RECEIPT")
      .filter((o) => o.fact["final"] === true && o.confidence === "AUTHORITATIVE")
      .map((o) => String(o.fact["class"]) as ReceiptClass);
    if (current) h.push(current);
    return [...new Set(h)];
  }

  async reconcileOne(operationId: string, lease: Lease): Promise<OperationRecord> {
    let op = this.journal.op(operationId);
    if (op.state === "QUEUED") return op;
    const now = this.journal.clock.now();
    const facts = await gatherFacts(op, this.ports, now, `cor-${operationId}-${op.version}`);
    for (const o of facts.observations) this.journal.observe(operationId, lease, o);
    this.boundary("reconcile.observed", operationId);
    op = this.journal.op(operationId);
    const history = this.receiptHistory(op, facts.receiptFinal ? facts.receipt : null);

    if (isTerminal(op.state)) {
      const d = this.journal.disposition(operationId);
      const inc = d ? postTerminalIncident(d.outcome, d.basis, facts.contract, history) : null;
      if (inc) this.incident(op, inc.kind, inc.detail, facts.successors);
      this.journal.touch(operationId, lease, op.version, {
        nextCheckAt: now + this.backoff(op.checks),
        checks: op.checks + 1,
      });
      return this.journal.op(operationId);
    }

    // REVIEW and ADJUDICATION move only on new evidence or an operator request, and an
    // operator request can only start reconciliation or adjudication, never decide it.
    const requests = this.journal.pendingRequests(operationId);
    if (op.state === "REVIEW" || op.state === "ADJUDICATION") {
      const adj = requests.find((r) => r.kind === "OPEN_ADJUDICATION");
      const rec = requests.find((r) => r.kind === "REQUEST_RECONCILIATION");
      if (op.state === "REVIEW" && adj && !rec) {
        op = this.journal.transition(
          operationId,
          lease,
          op.version,
          ["ADJUDICATION"],
          "OPERATOR_OPENED_ADJUDICATION",
          {
            requestId: adj.requestId,
          },
        );
        this.journal.consumeRequest(adj.requestId, lease);
        this.boundary("adjudication.persisted", operationId);
        return op;
      }
      const fresh =
        op.state === "REVIEW" &&
        !this.journal.hasIncident(operationId) &&
        this.journal.maxObservationSeq(operationId) > (op.reviewSeq ?? 0);
      if (!rec && !fresh) {
        this.journal.touch(operationId, lease, op.version, {
          nextCheckAt: now + this.backoff(op.checks),
          checks: op.checks + 1,
        });
        return this.journal.op(operationId);
      }
      op = this.journal.transition(
        operationId,
        lease,
        op.version,
        ["RECONCILING"],
        rec ? "OPERATOR_REQUESTED_RECONCILIATION" : "NEW_EVIDENCE",
        { requestId: rec?.requestId ?? null },
      );
      for (const r of requests) this.journal.consumeRequest(r.requestId, lease);
      this.boundary("reconciling.persisted", operationId);
    }

    const decision = decide({
      kind: op.kind,
      state: op.state,
      recipient: op.recipient,
      amountYocto: op.amountYocto,
      slices: op.slices,
      ledgerBefore: op.ledgerBefore,
      ledgerNow: facts.ledger,
      conservation: facts.conservation,
      contract: facts.contract,
      tx: facts.tx,
      receipt: facts.receipt,
      receiptHistory: history,
      frozen: this.journal.hasIncident(operationId),
      pastDeadline: now > op.deadlineAt,
    });
    if (decision.incident)
      this.incident(op, decision.incident.kind, decision.incident.detail, facts.successors);

    let target: OperationState = decision.target;
    let path: OperationState[];
    try {
      path = planPath(op.kind, op.state, target);
    } catch {
      // Unreachable target (e.g. RECONCILING with a lost response): fail closed to REVIEW.
      target = "REVIEW";
      path = op.state === "REVIEW" ? [] : planPath(op.kind, op.state, "REVIEW");
    }
    const evidence = {
      basis: decision.basis,
      contract: facts.contract,
      contractState: facts.contractState,
      tx: facts.tx,
      receipt: facts.receipt,
      observationsDigest: digestOf(facts.observations.map((o) => o.rawDigest)),
    };
    const next = { nextCheckAt: now + this.backoff(op.checks), checks: op.checks + 1 };
    if (path.length === 0) {
      this.journal.touch(operationId, lease, op.version, { ...next, attemptId: facts.attemptId });
      return this.journal.op(operationId);
    }
    const terminal = isTerminal(target);
    op = this.journal.transition(
      operationId,
      lease,
      op.version,
      path,
      `RECONCILED:${decision.basis}`,
      evidence,
      {
        ...next,
        attemptId: facts.attemptId,
        reviewSeq: this.journal.maxObservationSeq(operationId),
        ...(terminal && facts.ledger
          ? {
              disposition: {
                outcome: target as "PAID" | "REFUNDED" | "FAILED",
                basis: decision.basis,
                evidence,
                ledgerAfter: facts.ledger,
              },
              watchUntil: now + this.cfg.watchMs,
            }
          : {}),
      },
    );
    this.boundary(`transition.${op.state}`, operationId);
    return op;
  }

  private incident(
    op: OperationRecord,
    kind: Parameters<Journal["openIncident"]>[0]["kind"],
    detail: string,
    successors: string[],
  ) {
    const id = this.journal.openIncident({
      tradeId: op.tradeId,
      operationId: op.operationId,
      kind,
      detail,
      frozen: [op.subjectId, ...successors],
      dedupeKey: digestOf({ op: op.operationId, kind, detail }),
    });
    if (id) this.boundary(`incident.${kind}`, op.operationId);
  }
}

export class OutboxWorker {
  constructor(
    private readonly journal: Journal,
    private readonly ports: ChainPorts,
    private readonly signer: TxSigner,
    private readonly reconciler: Reconciler,
    private readonly cfg: EngineConfig,
  ) {}

  private boundary(b: string, id: string): void {
    this.cfg.onBoundary?.(b, id);
  }

  /** Deliver every due outbox row once. Returns the operations it delivered or withdrew. */
  async runOnce(): Promise<string[]> {
    const done: string[] = [];
    for (const row of this.journal.pendingOutbox(this.journal.clock.now())) {
      const lease = this.journal.acquireLease(`op:${row.operationId}`, this.cfg.holder, this.cfg.leaseTtlMs);
      if (!lease) continue;
      try {
        if (await this.deliver(row.operationId, lease)) done.push(row.operationId);
      } catch (e) {
        if (!isCode(e, "LEASE_LOST", "VERSION_CONFLICT")) throw e;
      } finally {
        this.journal.releaseLease(lease);
      }
    }
    return done;
  }

  private async deliver(operationId: string, lease: Lease): Promise<boolean> {
    let op = this.journal.op(operationId);
    this.boundary("outbox.claimed", operationId);
    if (op.state !== "QUEUED") {
      this.journal.db.transaction(() => {
        this.journal.fence(lease);
        this.journal.markOutboxDone(operationId, lease);
      });
      return false;
    }
    const now = this.journal.clock.now();
    if (this.journal.frozen(op.tradeId).length > 0) {
      this.journal.deferOutbox(operationId, lease, now + this.cfg.maxBackoffMs);
      return false;
    }
    // Independent pre-submit read: the subject must still be executable by this operation.
    const facts = await gatherFacts(op, this.ports, now, `cor-${operationId}-presubmit`);
    for (const o of facts.observations) this.journal.observe(operationId, lease, o);
    if (facts.contract === "EXITED") {
      if (!facts.ledger) return false;
      const exact =
        op.kind === "REFUND"
          ? ledgerChecks.refundRestored(op.ledgerBefore, facts.ledger, op.slices)
          : ledgerChecks.valueUnmoved(op.ledgerBefore, facts.ledger, op.slices);
      if (!exact)
        this.journal.openIncident({
          tradeId: op.tradeId,
          operationId,
          kind: "CONSERVATION",
          detail: `subject ${facts.contractState} without exact bucket restoration`,
          frozen: [op.subjectId, ...facts.successors],
          dedupeKey: digestOf({ op: operationId, withdraw: true }),
        });
      this.journal.transition(
        operationId,
        lease,
        op.version,
        ["WITHDRAWN"],
        "SUBJECT_EXITED_BEFORE_SUBMIT",
        { contractState: facts.contractState, exact },
        {
          disposition: {
            outcome: "WITHDRAWN",
            basis: exact ? "SUBJECT_EXITED_EXACT_RESTORATION" : "SUBJECT_EXITED_RESTORATION_MISMATCH",
            evidence: { contractState: facts.contractState },
            ledgerAfter: facts.ledger,
          },
          outboxDone: lease,
        },
      );
      this.boundary("transition.WITHDRAWN", operationId);
      return true;
    }
    if (facts.contract === "MISSING" || facts.contractState === null) {
      this.journal.deferOutbox(operationId, lease, now + this.cfg.baseBackoffMs);
      return false;
    }
    if (facts.contract !== "NOT_EXECUTED") {
      // Somebody else already executed the subject (the contract call is permissionless).
      // Bind to it without broadcasting anything; reconciliation follows the contract.
      op = this.journal.transition(
        operationId,
        lease,
        op.version,
        [submitState(op.kind)],
        "EXTERNAL_EXECUTION_OBSERVED",
        { contractState: facts.contractState },
        { outboxDone: lease, attemptId: facts.attemptId },
      );
      await this.reconciler.reconcileOne(operationId, lease);
      return true;
    }
    // One submitter per relayer access key; the nonce is allocated durably (relayer.ts).
    const sent = await withRelayerKey(
      this.journal,
      this.signer,
      this.cfg.holder,
      this.cfg.leaseTtlMs,
      () => this.ports.tx.accessKeyNonce(this.signer.signerId, this.signer.publicKey),
      async (nonce) => {
        const block = await this.ports.tx.latestBlock();
        const signed = await this.signer.sign(op.call, { nonce, blockHash: block.hash });
        const persisted = this.journal.transition(
          operationId,
          lease,
          op.version,
          [submitState(op.kind)],
          "SUBMIT_PERSISTED",
          { txHash: signed.txHash, refHeight: block.height },
          { submit: { ...signed, refHeight: block.height }, outboxDone: lease },
        );
        this.boundary("submit.persisted", operationId);
        let outcome: Awaited<ReturnType<ChainPorts["tx"]["send"]>> | null = null;
        let lostCode = "";
        try {
          outcome = await this.ports.tx.send(signed);
        } catch (e) {
          lostCode = (e as { code?: string }).code ?? "FOREIGN";
        }
        if (!outcome) {
          this.boundary("submit.lost", operationId);
          this.journal.observe(operationId, lease, {
            source: "TX_STATUS",
            subject: signed.txHash,
            observedAt: this.journal.clock.now(),
            freshnessMs: 0,
            confidence: "UNAVAILABLE",
            revision: null,
            correlationId: `cor-${operationId}-submit`,
            rawDigest: digestOf({ lost: signed.txHash, code: lostCode, at: this.journal.clock.now() }),
            fact: { kind: "RESPONSE_LOST", error: lostCode },
          });
          this.journal.transition(
            operationId,
            lease,
            persisted.version,
            ["UNKNOWN"],
            "RESPONSE_LOST",
            {
              txHash: signed.txHash,
              error: lostCode,
            },
            { nextCheckAt: this.journal.clock.now() + this.cfg.baseBackoffMs },
          );
          this.boundary("unknown.persisted", operationId);
          return "LOST" as const;
        }
        return "RETURNED" as const;
      },
    );
    if (!sent.ran) {
      // Another submitter holds the relayer key: nothing was signed; try again shortly.
      this.journal.deferOutbox(operationId, lease, now + this.cfg.baseBackoffMs);
      return false;
    }
    if (sent.value === "LOST") return true;
    this.boundary("submit.returned", operationId);
    await this.reconciler.reconcileOne(operationId, lease);
    return true;
  }
}

/** Run worker and reconciler until nothing is due (bounded), e.g. for a one-shot process. */
export async function drain(worker: OutboxWorker, reconciler: Reconciler, rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    const a = await worker.runOnce();
    const b = await reconciler.runOnce();
    if (a.length === 0 && b.length === 0) return;
  }
  if (rounds <= 0) fail("VALIDATION_FAILED", "rounds must be positive");
}
