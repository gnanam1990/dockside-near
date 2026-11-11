import { type Clock, fail, type IdGenerator } from "@dockside/core";
import type { FunctionCall, SignedTx } from "@dockside/near";
import { type Database, isUniqueViolation, type Row } from "@dockside/store";
import type { BucketSlice, FunderBuckets, IncidentKind, LedgerSnapshot, SourceBucket } from "./decide.js";
import { isLegal, isTerminal, type OperationKind, type OperationState } from "./states.js";

/**
 * Durable journal tables of 0005_journal.sql. Every worker-owned mutation runs in one
 * transaction that first re-checks the caller's fenced lease (same holder, same epoch, not
 * expired); a worker that lost its lease can change nothing.
 */

export interface Lease {
  readonly name: string;
  readonly holder: string;
  readonly epoch: number;
}

export interface OperationRecord {
  readonly operationId: string;
  readonly kind: OperationKind;
  readonly tradeId: string;
  readonly subjectId: string;
  readonly operationDigest: string;
  readonly call: FunctionCall;
  readonly recipient: string;
  readonly amountYocto: bigint;
  readonly slices: BucketSlice[];
  readonly ledgerBefore: LedgerSnapshot;
  readonly state: OperationState;
  readonly lockHeld: boolean;
  readonly version: number;
  readonly submitCount: number;
  readonly txHash: string | null;
  readonly txSigner: string | null;
  readonly signedTx: string | null;
  readonly txRefHeight: number | null;
  readonly attemptId: string | null;
  readonly dispositionId: string | null;
  readonly reviewSeq: number | null;
  readonly checks: number;
  readonly nextCheckAt: number;
  readonly deadlineAt: number;
  readonly watchUntil: number | null;
  readonly createdAt: number;
}

export interface ObservationInput {
  readonly source: "CONTRACT" | "LEDGER" | "TX_STATUS" | "RECEIPT" | "PROVIDER" | "REFUND_AUTHORITY";
  readonly subject: string;
  readonly observedAt: number;
  readonly freshnessMs: number;
  readonly confidence: "AUTHORITATIVE" | "ATTRIBUTED" | "UNAVAILABLE";
  readonly revision: number | null;
  readonly correlationId: string;
  readonly rawDigest: string;
  readonly fact: Record<string, unknown>;
}

export interface Observation extends ObservationInput {
  readonly seq: number;
  readonly observationId: string;
  readonly recordedAt: number;
}

export interface Disposition {
  readonly outcome: "PAID" | "REFUNDED" | "FAILED" | "WITHDRAWN";
  readonly basis: string;
  readonly evidence: Record<string, unknown>;
  readonly ledgerAfter: LedgerSnapshot;
}

const big = (v: bigint) => v.toString(10);

export function ledgerToJson(l: LedgerSnapshot): string {
  const o: Record<string, Record<string, string>> = {};
  for (const k of Object.keys(l).sort()) {
    const b = l[k] as FunderBuckets;
    o[k] = {
      partial: big(b.partial),
      available: big(b.available),
      reserved: big(b.reserved),
      released: big(b.released),
      refundLocked: big(b.refundLocked),
      refunded: big(b.refunded),
      quarantined: big(b.quarantined),
    };
  }
  return JSON.stringify(o);
}

export function ledgerFromJson(s: string): LedgerSnapshot {
  const o = JSON.parse(s) as Record<string, Record<string, string>>;
  const out: Record<string, FunderBuckets> = {};
  for (const [k, b] of Object.entries(o)) {
    out[k] = {
      partial: BigInt(b["partial"] ?? "0"),
      available: BigInt(b["available"] ?? "0"),
      reserved: BigInt(b["reserved"] ?? "0"),
      released: BigInt(b["released"] ?? "0"),
      refundLocked: BigInt(b["refundLocked"] ?? "0"),
      refunded: BigInt(b["refunded"] ?? "0"),
      quarantined: BigInt(b["quarantined"] ?? "0"),
    };
  }
  return out;
}

export function slicesToJson(s: readonly BucketSlice[]): string {
  return JSON.stringify(
    s.map((x) => ({ funder: x.funder, amountYocto: big(x.amountYocto), bucket: x.bucket })),
  );
}

function slicesFromJson(s: string): BucketSlice[] {
  return (JSON.parse(s) as { funder: string; amountYocto: string; bucket: SourceBucket }[]).map((x) => ({
    funder: x.funder,
    amountYocto: BigInt(x.amountYocto),
    bucket: x.bucket,
  }));
}

const nul = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const nnum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function toRecord(r: Row): OperationRecord {
  return {
    operationId: String(r["operation_id"]),
    kind: String(r["kind"]) as OperationKind,
    tradeId: String(r["trade_id"]),
    subjectId: String(r["subject_id"]),
    operationDigest: String(r["operation_digest"]),
    call: JSON.parse(String(r["call_json"])) as FunctionCall,
    recipient: String(r["recipient"]),
    amountYocto: BigInt(String(r["amount_yocto"])),
    slices: slicesFromJson(String(r["buckets_json"])),
    ledgerBefore: ledgerFromJson(String(r["ledger_before_json"])),
    state: String(r["state"]) as OperationState,
    lockHeld: Number(r["lock_held"]) === 1,
    version: Number(r["version"]),
    submitCount: Number(r["submit_count"]),
    txHash: nul(r["tx_hash"]),
    txSigner: nul(r["tx_signer"]),
    signedTx: nul(r["signed_tx"]),
    txRefHeight: nnum(r["tx_ref_height"]),
    attemptId: nul(r["attempt_id"]),
    dispositionId: nul(r["disposition_id"]),
    reviewSeq: nnum(r["review_seq"]),
    checks: Number(r["checks"]),
    nextCheckAt: Number(r["next_check_at"]),
    deadlineAt: Number(r["deadline_at"]),
    watchUntil: nnum(r["watch_until"]),
    createdAt: Number(r["created_at"]),
  };
}

export class Journal {
  constructor(
    readonly db: Database,
    readonly clock: Clock,
    readonly ids: IdGenerator,
  ) {}

  /* ------------------------------- reads ------------------------------- */

  op(operationId: string): OperationRecord {
    const r = this.db.get("SELECT * FROM economic_operations WHERE operation_id = ?", operationId);
    if (!r) fail("NOT_FOUND", "economic operation not found");
    return toRecord(r);
  }

  opForSubject(kind: OperationKind, subjectId: string): OperationRecord | null {
    const r = this.db.get(
      "SELECT * FROM economic_operations WHERE kind = ? AND subject_id = ? AND state <> 'WITHDRAWN'",
      kind,
      subjectId,
    );
    return r ? toRecord(r) : null;
  }

  opsForTrade(tradeId: string): OperationRecord[] {
    return this.db
      .all("SELECT * FROM economic_operations WHERE trade_id = ? ORDER BY created_at, operation_id", tradeId)
      .map(toRecord);
  }

  lockingOps(tradeId: string): OperationRecord[] {
    return this.db
      .all("SELECT * FROM economic_operations WHERE trade_id = ? AND lock_held = 1", tradeId)
      .map(toRecord);
  }

  frozen(tradeId: string): { causeId: string; reason: string }[] {
    return this.db
      .all("SELECT cause_id, reason FROM trade_freezes WHERE trade_id = ? ORDER BY frozen_at", tradeId)
      .map((r) => ({ causeId: String(r["cause_id"]), reason: String(r["reason"]) }));
  }

  pendingOutbox(now: number, limit = 20): { outboxId: string; operationId: string }[] {
    return this.db
      .all(
        "SELECT outbox_id, operation_id FROM outbox WHERE status = 'PENDING' AND available_at <= ? ORDER BY available_at, outbox_id LIMIT ?",
        now,
        limit,
      )
      .map((r) => ({ outboxId: String(r["outbox_id"]), operationId: String(r["operation_id"]) }));
  }

  dueForReconciliation(now: number, limit = 50): string[] {
    return this.db
      .all(
        `SELECT operation_id FROM economic_operations
         WHERE ((lock_held = 1 AND state <> 'QUEUED') OR (lock_held = 0 AND watch_until IS NOT NULL AND watch_until > ?))
           AND next_check_at <= ?
         ORDER BY next_check_at, operation_id LIMIT ?`,
        now,
        now,
        limit,
      )
      .map((r) => String(r["operation_id"]));
  }

  observations(operationId: string, source?: ObservationInput["source"]): Observation[] {
    const rows = source
      ? this.db.all(
          "SELECT * FROM operation_observations WHERE operation_id = ? AND source = ? ORDER BY seq",
          operationId,
          source,
        )
      : this.db.all("SELECT * FROM operation_observations WHERE operation_id = ? ORDER BY seq", operationId);
    return rows.map((r) => ({
      seq: Number(r["seq"]),
      observationId: String(r["observation_id"]),
      source: String(r["source"]) as ObservationInput["source"],
      subject: String(r["subject"]),
      observedAt: Number(r["observed_at"]),
      recordedAt: Number(r["recorded_at"]),
      freshnessMs: Number(r["freshness_ms"]),
      confidence: String(r["confidence"]) as ObservationInput["confidence"],
      revision: nnum(r["revision"]),
      correlationId: String(r["correlation_id"]),
      rawDigest: String(r["raw_digest"]),
      fact: JSON.parse(String(r["fact_json"])) as Record<string, unknown>,
    }));
  }

  maxObservationSeq(operationId: string): number {
    const r = this.db.get(
      "SELECT COALESCE(MAX(seq), 0) AS s FROM operation_observations WHERE operation_id = ?",
      operationId,
    );
    return Number(r?.["s"] ?? 0);
  }

  transitions(
    operationId: string,
  ): { from: string | null; to: string; cause: string; epoch: number | null }[] {
    return this.db
      .all("SELECT * FROM operation_transitions WHERE operation_id = ? ORDER BY version", operationId)
      .map((r) => ({
        from: nul(r["from_state"]),
        to: String(r["to_state"]),
        cause: String(r["cause"]),
        epoch: nnum(r["lease_epoch"]),
      }));
  }

  disposition(operationId: string): (Disposition & { dispositionId: string }) | null {
    const r = this.db.get("SELECT * FROM operation_dispositions WHERE operation_id = ?", operationId);
    if (!r) return null;
    return {
      dispositionId: String(r["disposition_id"]),
      outcome: String(r["outcome"]) as Disposition["outcome"],
      basis: String(r["basis"]),
      evidence: JSON.parse(String(r["evidence_json"])) as Record<string, unknown>,
      ledgerAfter: ledgerFromJson(String(r["ledger_after_json"])),
    };
  }

  incidents(
    tradeId: string,
  ): {
    incidentId: string;
    operationId: string | null;
    kind: IncidentKind;
    detail: string;
    frozen: string[];
  }[] {
    return this.db
      .all(
        "SELECT * FROM reconciliation_incidents WHERE trade_id = ? ORDER BY opened_at, incident_id",
        tradeId,
      )
      .map((r) => ({
        incidentId: String(r["incident_id"]),
        operationId: nul(r["operation_id"]),
        kind: String(r["kind"]) as IncidentKind,
        detail: String((JSON.parse(String(r["detail_json"])) as { detail: string }).detail),
        frozen: JSON.parse(String(r["frozen_json"])) as string[],
      }));
  }

  hasIncident(operationId: string): boolean {
    return (
      this.db.get(
        "SELECT 1 AS x FROM reconciliation_incidents WHERE operation_id = ? LIMIT 1",
        operationId,
      ) !== undefined
    );
  }

  pendingRequests(operationId: string): { requestId: string; kind: string }[] {
    return this.db
      .all(
        `SELECT r.request_id, r.kind FROM operator_requests r
         LEFT JOIN operator_request_consumptions c ON c.request_id = r.request_id
         WHERE r.operation_id = ? AND c.request_id IS NULL AND r.kind IN ('REQUEST_RECONCILIATION', 'OPEN_ADJUDICATION')
         ORDER BY r.requested_at, r.request_id`,
        operationId,
      )
      .map((r) => ({ requestId: String(r["request_id"]), kind: String(r["kind"]) }));
  }

  outbox(operationId: string): { status: string; deliveries: number; doneEpoch: number | null } {
    const r = this.db.get("SELECT * FROM outbox WHERE operation_id = ?", operationId);
    if (!r) fail("NOT_FOUND", "outbox row not found");
    return {
      status: String(r["status"]),
      deliveries: Number(r["deliveries"]),
      doneEpoch: nnum(r["done_epoch"]),
    };
  }

  /* ------------------------------- leases ------------------------------- */

  /** Acquire or renew a fenced lease. A takeover after expiry increments the epoch. */
  acquireLease(name: string, holder: string, ttlMs: number): Lease | null {
    return this.db.transaction(() => {
      const now = this.clock.now();
      const r = this.db.get("SELECT * FROM worker_leases WHERE lease_name = ?", name);
      if (!r) {
        this.db.run(
          "INSERT INTO worker_leases (lease_name, holder, epoch, expires_at, acquired_at) VALUES (?, ?, 1, ?, ?)",
          name,
          holder,
          now + ttlMs,
          now,
        );
        return { name, holder, epoch: 1 };
      }
      const epoch = Number(r["epoch"]);
      if (String(r["holder"]) === holder && Number(r["expires_at"]) > now) {
        this.db.run("UPDATE worker_leases SET expires_at = ? WHERE lease_name = ?", now + ttlMs, name);
        return { name, holder, epoch };
      }
      if (Number(r["expires_at"]) > now) return null;
      this.db.run(
        "UPDATE worker_leases SET holder = ?, epoch = ?, expires_at = ?, acquired_at = ? WHERE lease_name = ?",
        holder,
        epoch + 1,
        now + ttlMs,
        now,
        name,
      );
      return { name, holder, epoch: epoch + 1 };
    });
  }

  /** Give the lease up early (expire it now) so another worker need not wait for the TTL. */
  releaseLease(lease: Lease): void {
    this.db.run(
      "UPDATE worker_leases SET expires_at = ? WHERE lease_name = ? AND holder = ? AND epoch = ?",
      this.clock.now(),
      lease.name,
      lease.holder,
      lease.epoch,
    );
  }

  /** Inside a transaction: the caller still holds the current epoch, or nothing happens. */
  fence(lease: Lease): void {
    const r = this.db.get(
      "SELECT holder, epoch, expires_at FROM worker_leases WHERE lease_name = ?",
      lease.name,
    );
    if (
      !r ||
      String(r["holder"]) !== lease.holder ||
      Number(r["epoch"]) !== lease.epoch ||
      Number(r["expires_at"]) <= this.clock.now()
    )
      fail("LEASE_LOST", "worker lease lost; a newer epoch owns this operation", {
        lease: lease.name,
        epoch: lease.epoch,
      });
  }

  /* ------------------------------- writes ------------------------------- */

  insertOperation(input: {
    kind: OperationKind;
    tradeId: string;
    subjectId: string;
    operationDigest: string;
    material: Record<string, unknown>;
    call: FunctionCall;
    recipient: string;
    amountYocto: bigint;
    slices: readonly BucketSlice[];
    ledgerBefore: LedgerSnapshot;
    deadlineMs: number;
  }): string {
    const now = this.clock.now();
    const id = this.ids.next("eop");
    this.db.run(
      `INSERT INTO economic_operations (operation_id, kind, trade_id, subject_id, operation_digest, material_json, call_json,
         recipient, amount_yocto, buckets_json, ledger_before_json, state, lock_held, version, submit_count,
         next_check_at, deadline_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', 1, 1, 0, ?, ?, ?, ?)`,
      id,
      input.kind,
      input.tradeId,
      input.subjectId,
      input.operationDigest,
      JSON.stringify(input.material),
      JSON.stringify(input.call),
      input.recipient,
      big(input.amountYocto),
      slicesToJson(input.slices),
      ledgerToJson(input.ledgerBefore),
      now,
      now + input.deadlineMs,
      now,
      now,
    );
    this.db.run(
      `INSERT INTO operation_transitions (id, operation_id, from_state, to_state, version, cause, lease_name, lease_epoch, evidence_json, recorded_at)
       VALUES (?, ?, NULL, 'QUEUED', 1, 'ENQUEUED', NULL, NULL, '{}', ?)`,
      this.ids.next("otr"),
      id,
      now,
    );
    this.db.run(
      "INSERT INTO outbox (outbox_id, operation_id, effect, status, available_at, created_at) VALUES (?, ?, 'SUBMIT', 'PENDING', ?, ?)",
      this.ids.next("obx"),
      id,
      now,
      now,
    );
    return id;
  }

  /** Append an observation; an identical raw fact for the same source joins (duplicate delivery). */
  observe(
    operationId: string,
    lease: Lease | null,
    o: ObservationInput,
  ): { seq: number; duplicate: boolean } {
    const run = () => {
      if (lease) this.fence(lease);
      try {
        const r = this.db.run(
          `INSERT INTO operation_observations (observation_id, operation_id, source, subject, observed_at, recorded_at,
             freshness_ms, confidence, revision, correlation_id, raw_digest, fact_json, lease_epoch)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          this.ids.next("obs"),
          operationId,
          o.source,
          o.subject,
          o.observedAt,
          this.clock.now(),
          o.freshnessMs,
          o.confidence,
          o.revision,
          o.correlationId,
          o.rawDigest,
          JSON.stringify(o.fact),
          lease?.epoch ?? null,
        );
        return { seq: Number(r.lastInsertRowid), duplicate: false };
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        const prior = this.db.get(
          "SELECT seq FROM operation_observations WHERE operation_id = ? AND source = ? AND raw_digest = ?",
          operationId,
          o.source,
          o.rawDigest,
        );
        return { seq: Number(prior?.["seq"] ?? 0), duplicate: true };
      }
    };
    return this.db.transaction(run);
  }

  /**
   * Apply a planned path of legal transitions in one fenced transaction. The expected version
   * guards against a concurrent writer; a terminal step records its disposition first (the
   * database refuses a terminal state without one) and releases the lock.
   */
  transition(
    operationId: string,
    lease: Lease | null,
    expectedVersion: number,
    path: readonly OperationState[],
    cause: string,
    evidence: Record<string, unknown>,
    extra: {
      disposition?: Disposition;
      submit?: SignedTx & { refHeight: number };
      outboxDone?: Lease;
      attemptId?: string | null;
      reviewSeq?: number | null;
      nextCheckAt?: number;
      checks?: number;
      watchUntil?: number | null;
    } = {},
  ): OperationRecord {
    return this.db.transaction(() => {
      if (lease) this.fence(lease);
      let cur = this.op(operationId);
      if (cur.version !== expectedVersion)
        fail("VERSION_CONFLICT", "economic operation changed concurrently", {
          expected: expectedVersion,
          actual: cur.version,
        });
      const now = this.clock.now();
      let dispositionId: string | null = cur.dispositionId;
      for (let i = 0; i < path.length; i++) {
        const to = path[i] as OperationState;
        if (!isLegal(cur.kind, cur.state, to))
          fail("ILLEGAL_TRANSITION", `illegal transition ${cur.state} -> ${to}`, { from: cur.state, to });
        const last = i === path.length - 1;
        if (isTerminal(to)) {
          const d = extra.disposition;
          if (!last || !d || d.outcome !== to)
            fail("ILLEGAL_TRANSITION", "terminal state needs its disposition");
          dispositionId = this.ids.next("dsp");
          this.db.run(
            `INSERT INTO operation_dispositions (disposition_id, operation_id, outcome, basis, evidence_json, ledger_after_json, recorded_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            dispositionId,
            operationId,
            d.outcome,
            d.basis,
            JSON.stringify(d.evidence),
            ledgerToJson(d.ledgerAfter),
            now,
          );
        }
        const version = cur.version + 1;
        const submit = extra.submit && i === 0 ? extra.submit : null;
        this.db.run(
          `UPDATE economic_operations SET state = ?, version = ?, lock_held = ?, disposition_id = ?,
             submit_count = ?, tx_hash = COALESCE(?, tx_hash), tx_signer = COALESCE(?, tx_signer),
             signed_tx = COALESCE(?, signed_tx), tx_ref_height = COALESCE(?, tx_ref_height), attempt_id = COALESCE(?, attempt_id),
             review_seq = ?, checks = ?, next_check_at = ?, watch_until = ?, updated_at = ?
           WHERE operation_id = ? AND version = ?`,
          to,
          version,
          isTerminal(to) ? 0 : 1,
          dispositionId,
          submit ? 1 : cur.submitCount,
          submit?.txHash ?? null,
          submit?.signerId ?? null,
          submit?.encoded ?? null,
          submit?.refHeight ?? null,
          extra.attemptId ?? null,
          to === "REVIEW" ? (extra.reviewSeq ?? cur.reviewSeq) : cur.reviewSeq,
          extra.checks ?? cur.checks,
          extra.nextCheckAt ?? cur.nextCheckAt,
          isTerminal(to) ? (extra.watchUntil ?? null) : cur.watchUntil,
          now,
          operationId,
          cur.version,
        );
        this.db.run(
          `INSERT INTO operation_transitions (id, operation_id, from_state, to_state, version, cause, lease_name, lease_epoch, evidence_json, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          this.ids.next("otr"),
          operationId,
          cur.state,
          to,
          version,
          cause,
          lease?.name ?? null,
          lease?.epoch ?? null,
          JSON.stringify(evidence),
          now,
        );
        cur = this.op(operationId);
      }
      if (extra.outboxDone) this.markOutboxDone(operationId, extra.outboxDone);
      return cur;
    });
  }

  /** Bookkeeping without a state change: schedule, attempt binding, watch window. */
  touch(
    operationId: string,
    lease: Lease | null,
    expectedVersion: number,
    set: { nextCheckAt?: number; checks?: number; attemptId?: string | null; watchUntil?: number | null },
  ): void {
    this.db.transaction(() => {
      if (lease) this.fence(lease);
      const cur = this.op(operationId);
      if (cur.version !== expectedVersion)
        fail("VERSION_CONFLICT", "economic operation changed concurrently");
      this.db.run(
        `UPDATE economic_operations SET version = ?, next_check_at = ?, checks = ?, attempt_id = COALESCE(?, attempt_id),
           watch_until = ?, updated_at = ? WHERE operation_id = ? AND version = ?`,
        cur.version + 1,
        set.nextCheckAt ?? cur.nextCheckAt,
        set.checks ?? cur.checks,
        set.attemptId ?? null,
        set.watchUntil === undefined ? cur.watchUntil : set.watchUntil,
        this.clock.now(),
        operationId,
        cur.version,
      );
    });
  }

  markOutboxDone(operationId: string, lease: Lease): void {
    this.db.run(
      "UPDATE outbox SET status = 'DONE', done_by = ?, done_epoch = ?, done_at = ?, deliveries = deliveries + 1 WHERE operation_id = ? AND status = 'PENDING'",
      lease.holder,
      lease.epoch,
      this.clock.now(),
      operationId,
    );
  }

  deferOutbox(operationId: string, lease: Lease, untilMs: number): void {
    this.db.transaction(() => {
      this.fence(lease);
      this.db.run(
        "UPDATE outbox SET available_at = ?, deliveries = deliveries + 1 WHERE operation_id = ? AND status = 'PENDING'",
        untilMs,
        operationId,
      );
    });
  }

  /** Open an incident and freeze the trade (and any successor intents) exactly once per dedupe key. */
  openIncident(input: {
    tradeId: string;
    operationId: string | null;
    kind: IncidentKind;
    detail: string;
    frozen: readonly string[];
    dedupeKey: string;
  }): string | null {
    return this.db.transaction(() => {
      const id = this.ids.next("inc");
      try {
        this.db.run(
          `INSERT INTO reconciliation_incidents (incident_id, trade_id, operation_id, kind, detail_json, frozen_json, dedupe_key, opened_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          input.tradeId,
          input.operationId,
          input.kind,
          JSON.stringify({ detail: input.detail }),
          JSON.stringify(input.frozen),
          input.dedupeKey,
          this.clock.now(),
        );
      } catch (e) {
        if (isUniqueViolation(e)) return null;
        throw e;
      }
      this.db.run(
        "INSERT INTO trade_freezes (trade_id, cause_id, reason, frozen_at) VALUES (?, ?, ?, ?)",
        input.tradeId,
        id,
        input.kind,
        this.clock.now(),
      );
      return id;
    });
  }

  freezeTrade(tradeId: string, causeId: string, reason: string): void {
    try {
      this.db.run(
        "INSERT INTO trade_freezes (trade_id, cause_id, reason, frozen_at) VALUES (?, ?, ?, ?)",
        tradeId,
        causeId,
        reason,
        this.clock.now(),
      );
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
  }

  consumeRequest(requestId: string, lease: Lease | null): void {
    this.db.run(
      "INSERT OR IGNORE INTO operator_request_consumptions (request_id, consumed_at, lease_epoch) VALUES (?, ?, ?)",
      requestId,
      this.clock.now(),
      lease?.epoch ?? null,
    );
  }
}
