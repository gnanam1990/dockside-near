import type { AuthContext } from "@dockside/authority";
import { type Clock, fail, type IdGenerator, toTypedJson } from "@dockside/core";
import type { AttestorSigner, HoldService } from "@dockside/evidence";
import type { EscrowContract, FunctionCall } from "@dockside/near";
import type { ReleaseService } from "@dockside/release";
import { AuditLog, type Database, isUniqueViolation } from "@dockside/store";
import type { BucketSlice, LedgerSnapshot } from "./decide.js";
import { Journal, type OperationRecord } from "./journal.js";
import { digestOf } from "./sources.js";

/**
 * API-side entry points of the journal: persist an economic operation and its outbox row in one
 * transaction (after the release or refund predicate holds), exact duplicates join, conflicting
 * reuse fails closed; operator requests that can only ask for reconciliation or adjudication;
 * read models with provenance; and contract-level escalation of conservation incidents through
 * the deterministic-policy hold path.
 */

export interface JournalServiceDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly escrow: EscrowContract;
  readonly release: ReleaseService;
  /** Time an unresolved operation may stay UNKNOWN/PROCESSING before it goes to REVIEW. */
  readonly reconciliationDeadlineMs?: number;
}

export const INCIDENT_HOLD_RULE = "reconciliation-incident@1";
const SOURCE = "dockside-journal";

async function ledgerSnapshot(escrow: EscrowContract, tradeId: string): Promise<LedgerSnapshot> {
  const l = await escrow.getLedger(tradeId);
  const out: Record<string, LedgerSnapshot[string]> = {};
  for (const [k, b] of Object.entries(l.funders))
    out[k] = {
      partial: b.partial,
      available: b.available,
      reserved: b.reserved,
      released: b.released,
      refundLocked: b.refundLocked,
      refunded: b.refunded,
      quarantined: b.quarantined,
    };
  return out;
}

export class JournalService {
  readonly journal: Journal;
  private readonly escrow: EscrowContract;
  private readonly release: ReleaseService;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly audit: AuditLog;
  private readonly deadlineMs: number;

  constructor(deps: JournalServiceDeps) {
    this.journal = new Journal(deps.db, deps.clock, deps.ids);
    this.escrow = deps.escrow;
    this.release = deps.release;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.audit = new AuditLog(deps.db, deps.clock, deps.ids);
    this.deadlineMs = deps.reconciliationDeadlineMs ?? 24 * 3600_000;
  }

  private assertNotFrozen(tradeId: string): void {
    const f = this.journal.frozen(tradeId);
    if (f.length)
      fail("TRADE_FROZEN", "trade is frozen by a reconciliation incident", { cause: f[0]?.causeId ?? null });
  }

  private insert(input: Parameters<Journal["insertOperation"]>[0]): { operationId: string; joined: boolean } {
    try {
      const id = this.journal.db.transaction(() => this.journal.insertOperation(input));
      this.log("ECONOMIC_OPERATION_QUEUED", id, { kind: input.kind, digest: input.operationDigest });
      return { operationId: id, joined: false };
    } catch (e) {
      if (isUniqueViolation(e)) fail("VALUE_LOCKED", "a concurrent economic operation owns this value");
      throw e;
    }
  }

  private joinOrConflict(
    existing: OperationRecord | null,
    digest: string,
  ): { operationId: string; joined: boolean } | null {
    if (!existing) return null;
    if (existing.operationDigest !== digest)
      fail("IDEMPOTENCY_CONFLICT", "the subject already has an economic operation with other material");
    return { operationId: existing.operationId, joined: true };
  }

  /**
   * Persist the direct release of a pre-submit, approved release intent. The full release
   * conjunction is re-checked through ReleaseService (which also refuses frozen trades and any
   * subject with an existing operation), then operation + outbox are written atomically.
   */
  async enqueueRelease(releaseIntentId: string): Promise<{ operationId: string; joined: boolean }> {
    const j = this.release.intent(releaseIntentId);
    const call = { ...this.escrow.executeReleaseCall(j.tradeId, releaseIntentId) };
    const slices: BucketSlice[] = j.slices.map((s) => ({
      funder: s.funder,
      amountYocto: s.amountYocto,
      bucket: "RESERVED",
    }));
    const material = {
      kind: "RELEASE",
      tradeId: j.tradeId,
      tradeRevision: j.tradeRevision,
      releaseIntentId,
      amountYocto: j.amountYocto.toString(10),
      asset: "NEAR_NATIVE",
      recipient: j.destination,
      slices: slices.map((s) => [s.funder, s.amountYocto.toString(10)]),
      profile: "DIRECT_TESTNET",
      call: [call.receiverId, call.methodName, JSON.stringify(call.args)],
    };
    const digest = digestOf(material);
    const joined = this.joinOrConflict(this.journal.opForSubject("RELEASE", releaseIntentId), digest);
    if (joined) return joined;
    this.assertNotFrozen(j.tradeId);
    const relay = await this.release.prepareExecution(releaseIntentId);
    if (relay.methodName !== call.methodName || JSON.stringify(relay.args) !== JSON.stringify(call.args))
      fail("INTERNAL", "release relay differs from the journaled call");
    const before = await ledgerSnapshot(this.escrow, j.tradeId);
    for (const s of slices)
      if ((before[s.funder]?.reserved ?? -1n) !== s.amountYocto)
        fail("STALE_LEDGER", "contract reservation differs from the intent's slices");
    return this.insert({
      kind: "RELEASE",
      tradeId: j.tradeId,
      subjectId: releaseIntentId,
      operationDigest: digest,
      material,
      call,
      recipient: j.destination,
      amountYocto: j.amountYocto,
      slices,
      ledgerBefore: before,
      deadlineMs: this.deadlineMs,
    });
  }

  /** Persist the execution of an AUTHORIZED escrow refund (original funder, exact source bucket). */
  async enqueueRefund(
    tradeId: string,
    refundIntentId: string,
  ): Promise<{ operationId: string; joined: boolean }> {
    const refunds = await this.escrow.getRefunds(tradeId);
    const r = refunds.find((x) => x.refundIntentId === refundIntentId);
    if (!r) fail("NOT_FOUND", "refund intent not on the contract");
    const call = { ...this.escrow.executeRefundCall(tradeId, refundIntentId) };
    const slices: BucketSlice[] = [{ funder: r.funder, amountYocto: r.amount, bucket: r.sourceBucket }];
    const material = {
      kind: "REFUND",
      tradeId,
      refundIntentId,
      reason: r.reason,
      requestDigest: r.requestDigest,
      funder: r.funder,
      amountYocto: r.amount.toString(10),
      sourceBucket: r.sourceBucket,
      asset: "NEAR_NATIVE",
      call: [call.receiverId, call.methodName, JSON.stringify(call.args)],
    };
    const digest = digestOf(material);
    const joined = this.joinOrConflict(this.journal.opForSubject("REFUND", refundIntentId), digest);
    if (joined) return joined;
    this.assertNotFrozen(tradeId);
    if (r.state !== "AUTHORIZED") fail("INVALID_STATE", `refund intent is ${r.state}`);
    this.release.assertNoUnresolvedRelease(tradeId);
    if (this.journal.lockingOps(tradeId).some((o) => o.kind === "RELEASE"))
      fail("VALUE_LOCKED", "an unresolved release operation owns the trade's value lock");
    const before = await ledgerSnapshot(this.escrow, tradeId);
    return this.insert({
      kind: "REFUND",
      tradeId,
      subjectId: refundIntentId,
      operationDigest: digest,
      material,
      call,
      recipient: r.funder,
      amountYocto: r.amount,
      slices,
      ledgerBefore: before,
      deadlineMs: this.deadlineMs,
    });
  }

  /* --------------------------- operator requests --------------------------- */

  private operator(
    ctx: AuthContext,
    kind: "REQUEST_RECONCILIATION" | "OPEN_ADJUDICATION" | "IDENTIFY_SOURCE" | "FREEZE_TRADE",
    tradeId: string,
    operationId: string | null,
    detail: Record<string, string>,
  ): string {
    if (!ctx.capabilities.includes("RISK_RESOLVER"))
      fail("FORBIDDEN", "reconciliation and adjudication requests need the risk/policy capability");
    const id = this.ids.next("opr");
    this.journal.db.run(
      `INSERT INTO operator_requests (request_id, operation_id, trade_id, kind, actor_principal, actor_key_version, detail_json, requested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      operationId,
      tradeId,
      kind,
      ctx.principal.id,
      ctx.keyVersion.id,
      JSON.stringify(detail),
      this.clock.now(),
    );
    this.audit.append({
      eventType: `RECONCILIATION_${kind}`,
      organizationId: ctx.organizationId,
      actorPrincipalId: ctx.principal.id,
      actorKeyVersionId: ctx.keyVersion.id,
      sessionId: ctx.session.id,
      subjectType: operationId ? "economic_operation" : "trade",
      subjectId: operationId ?? tradeId,
      correlationId: ctx.correlationId,
      source: SOURCE,
      payload: { requestId: id },
    });
    return id;
  }

  /** Ask the reconciler to re-read every source for an operation in REVIEW or ADJUDICATION. */
  requestReconciliation(ctx: AuthContext, operationId: string): string {
    const op = this.journal.op(operationId);
    if (op.state !== "REVIEW" && op.state !== "ADJUDICATION")
      fail("INVALID_STATE", `operation is ${op.state}; reconciliation runs on its own schedule`);
    return this.operator(ctx, "REQUEST_RECONCILIATION", op.tradeId, operationId, {});
  }

  openAdjudication(ctx: AuthContext, operationId: string, note: string): string {
    const op = this.journal.op(operationId);
    if (op.state !== "REVIEW") fail("INVALID_STATE", "adjudication opens only from REVIEW");
    if (!/^[\x20-\x7e]{1,200}$/.test(note)) fail("VALIDATION_FAILED", "note must be short printable text");
    return this.operator(ctx, "OPEN_ADJUDICATION", op.tradeId, operationId, { note });
  }

  /** Point the reconciler at an evidence source (recorded; it never asserts the evidence). */
  identifySource(ctx: AuthContext, operationId: string, source: { kind: string; locator: string }): string {
    const op = this.journal.op(operationId);
    if (!/^[A-Z_]{1,32}$/.test(source.kind) || !/^[\x21-\x7e]{1,256}$/.test(source.locator))
      fail("VALIDATION_FAILED", "source kind or locator malformed");
    return this.operator(ctx, "IDENTIFY_SOURCE", op.tradeId, operationId, source);
  }

  freezeTrade(ctx: AuthContext, tradeId: string, reason: string): string {
    if (!/^[A-Z0-9_]{1,64}$/.test(reason)) fail("VALIDATION_FAILED", "reason code malformed");
    const id = this.operator(ctx, "FREEZE_TRADE", tradeId, null, { reason });
    this.journal.freezeTrade(tradeId, id, reason);
    return id;
  }

  /* ------------------------------ read models ------------------------------ */

  /** Operation status with the provenance of every fact behind it (NFR-06). */
  view(operationId: string) {
    const op = this.journal.op(operationId);
    return {
      operationId: op.operationId,
      kind: op.kind,
      tradeId: op.tradeId,
      subjectId: op.subjectId,
      operationDigest: op.operationDigest,
      state: op.state,
      lockHeld: op.lockHeld,
      version: op.version,
      submitCount: op.submitCount,
      txHash: op.txHash,
      attemptId: op.attemptId,
      disposition: this.journal.disposition(operationId),
      transitions: this.journal.transitions(operationId),
      observations: this.journal.observations(operationId).map((o) => ({
        source: o.source,
        subject: o.subject,
        observedAt: o.observedAt,
        freshnessMs: o.freshnessMs,
        confidence: o.confidence,
        revision: o.revision,
        correlationId: o.correlationId,
        rawDigest: o.rawDigest,
        fact: o.fact,
      })),
      incidents: this.journal.incidents(op.tradeId).filter((i) => i.operationId === operationId),
    };
  }

  /* ------------------------------ escalation ------------------------------ */

  /**
   * Turn an incident's freeze into contract authority: the deterministic-policy service SETs a
   * HoldRecord under the versioned rule `reconciliation-incident@1`, which the contract's release
   * predicate then enforces for any successor intent. Returns the relay call for the hold.
   */
  async escalateIncident(
    incidentId: string,
    holds: HoldService,
    policySigner: AttestorSigner,
  ): Promise<FunctionCall> {
    const r = this.journal.db.get(
      "SELECT trade_id, kind FROM reconciliation_incidents WHERE incident_id = ?",
      incidentId,
    );
    if (!r) fail("NOT_FOUND", "incident not found");
    const tradeId = String(r["trade_id"]);
    const hold = await holds.setByPolicy(
      tradeId,
      {
        ruleId: INCIDENT_HOLD_RULE,
        reasonCode: `RECONCILIATION_${String(r["kind"])}`,
        ttlMs: 90 * 24 * 3600_000 - 1,
        bindManifest: false,
      },
      policySigner,
    );
    this.log("RECONCILIATION_INCIDENT_ESCALATED", incidentId, { holdId: hold.id });
    return this.escrow.setHoldCall(tradeId, toTypedJson(hold.setPayload), hold.setSignature);
  }

  private log(
    eventType: string,
    subjectId: string,
    payload: Record<string, string | number | boolean | null>,
  ): void {
    this.audit.append({
      eventType,
      organizationId: null,
      actorPrincipalId: null,
      actorKeyVersionId: null,
      sessionId: null,
      subjectType: "economic_operation",
      subjectId,
      correlationId: this.ids.next("cor"),
      source: SOURCE,
      payload,
    });
  }
}
