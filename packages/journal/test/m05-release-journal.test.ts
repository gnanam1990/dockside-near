import { randomIds, toTypedJson } from "@dockside/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approve, codeOfAsync, dualCancel, evidenceReady, lockIntent } from "../../release/test/chain.js";
import { Journal, OPERATION_STATES, transitionTable } from "../src/index.js";
import {
  approvedIntent,
  type JWorld,
  jworld,
  ledgerOk,
  replaceInvoice,
  NEAR,
  RELAYER,
  run,
  SUPPLIER_ACCT,
  state,
  TREASURY,
  BUYER_ACCT,
  VALIDITY,
} from "./world.js";

let w: JWorld;

beforeEach(async () => {
  w = await jworld();
});
afterEach(async () => {
  await w.close();
});

function counts(txHash: string | null) {
  return {
    sends: txHash ? (w.server.sendCount.get(txHash) ?? 0) : 0,
    executes: w.server.executions.get("execute_release") ?? 0,
  };
}

describe("M05 journal: state machine, outbox and exactly-once submit", () => {
  it("the service transition table is exactly the database rule table", () => {
    const rows = w.c.w.h.db.all("SELECT kind, from_state, to_state FROM operation_transition_rules");
    const db = new Set(
      rows.map((r) => `${String(r["kind"])}:${String(r["from_state"])}>${String(r["to_state"])}`),
    );
    const code = new Set<string>();
    for (const kind of ["RELEASE", "REFUND"] as const)
      for (const [from, tos] of Object.entries(transitionTable(kind)))
        for (const to of tos) code.add(`${kind}:${from}>${to}`);
    expect([...db].sort()).toEqual([...code].sort());
    expect(OPERATION_STATES).toContain("ADJUDICATION");
  });

  it("T-029/NFR-01: operation and outbox are persisted before submit; duplicates join; one submit, one payout", async () => {
    const id = await approvedIntent(w);
    const supplierBefore = w.c.sim.balance(SUPPLIER_ACCT);
    const a = await w.svc.enqueueRelease(id);
    expect(a.joined).toBe(false);
    expect(state(w, a.operationId)).toBe("QUEUED");
    expect(w.journal.outbox(a.operationId).status).toBe("PENDING");
    // Exact duplicate joins; nothing new is written.
    const b = await w.svc.enqueueRelease(id);
    expect(b).toEqual({ operationId: a.operationId, joined: true });
    // While queued the value is locked for every competing service action.
    expect(
      await codeOfAsync(
        w.c.rel.prepareCancel(w.c.w.supplier.ctx(), { releaseIntentId: id, reasonCode: "X" }),
      ),
    ).toBe("VALUE_LOCKED");
    expect(await codeOfAsync(w.c.rel.prepareExecution(id))).toBe("VALUE_LOCKED");
    // Two workers race the same outbox row: the fenced lease admits one.
    await Promise.all([w.engine("worker-a").worker.runOnce(), w.engine("worker-b").worker.runOnce()]);
    await run(w);
    const op = w.journal.op(a.operationId);
    expect(op.state).toBe("PAID");
    expect(op.lockHeld).toBe(false);
    expect(op.submitCount).toBe(1);
    expect(counts(op.txHash)).toEqual({ sends: 1, executes: 1 });
    expect(w.c.sim.balance(SUPPLIER_ACCT) - supplierBefore).toBe(10n * NEAR);
    expect(w.journal.disposition(a.operationId)?.basis).toBe("AUTHORITATIVE_RECEIPT_AND_LEDGER");
    expect(w.journal.outbox(a.operationId).status).toBe("DONE");
    // Transitions are the legal path, each under a lease epoch.
    expect(w.journal.transitions(a.operationId).map((t) => t.to)).toEqual([
      "QUEUED",
      "SUBMITTING",
      "PROCESSING",
      "PAID",
    ]);
    // Provenance of every fact behind the status (NFR-06).
    const v = w.svc.view(a.operationId);
    for (const o of v.observations) {
      expect(o.correlationId).toMatch(/^cor-/);
      expect(o.rawDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(["AUTHORITATIVE", "ATTRIBUTED", "UNAVAILABLE"]).toContain(o.confidence);
    }
    expect(new Set(v.observations.map((o) => o.source))).toEqual(
      new Set(["CONTRACT", "LEDGER", "TX_STATUS", "RECEIPT"]),
    );
    await ledgerOk(w);
    // Running everything again changes nothing.
    await run(w, "worker-c");
    expect(counts(op.txHash)).toEqual({ sends: 1, executes: 1 });
    // A changed call under the same subject cannot be written: identity is immutable in the database.
    expect(() =>
      w.c.w.h.db.run(
        "UPDATE economic_operations SET recipient = 'evil.testnet', version = version + 1 WHERE operation_id = ?",
        a.operationId,
      ),
    ).toThrow(/immutable/);
  });

  it("T-028: accepted then lost response stays UNKNOWN with the lock; a late success binds the original intent", async () => {
    const id = await approvedIntent(w);
    const { operationId } = await w.svc.enqueueRelease(id);
    w.server.faults.dropSendResponses = 1;
    w.server.faults.statusDown = true;
    await run(w);
    let op = w.journal.op(operationId);
    expect(op.state).toBe("UNKNOWN");
    expect(op.lockHeld).toBe(true);
    // The chain did accept and execute it; nothing in the journal infers failure or retries.
    expect(counts(op.txHash)).toEqual({ sends: 1, executes: 1 });
    expect(
      await codeOfAsync(
        w.c.rel.prepareIntent(w.c.w.buyer.ctx(), { tradeId: w.c.t, idempotencyKey: "intent-key-0002" }),
      ),
    ).toBe("VALUE_LOCKED");
    expect(await codeOfAsync(w.svc.enqueueRelease(id))).toBe("NO_ERROR");
    expect(w.journal.opsForTrade(w.c.t)).toHaveLength(1);
    await run(w, "worker-b");
    expect(counts(op.txHash).sends).toBe(1);
    expect(state(w, operationId)).toBe("UNKNOWN");
    // Status source recovers: late success reconciles the original operation.
    w.server.faults.statusDown = false;
    await run(w, "worker-c");
    op = w.journal.op(operationId);
    expect(op.state).toBe("PAID");
    expect(w.journal.transitions(operationId).map((t) => t.to)).toEqual([
      "QUEUED",
      "SUBMITTING",
      "UNKNOWN",
      "PAID",
    ]);
    expect(counts(op.txHash)).toEqual({ sends: 1, executes: 1 });
    await ledgerOk(w);
  });
});

describe("M05 journal: evidence hierarchy for PAID (T-031)", () => {
  it("provider-style success alone is not PAID: hidden receipts give REVIEW; adjudication cannot force; late receipt reconciles", async () => {
    const id = await approvedIntent(w);
    const { operationId } = await w.svc.enqueueRelease(id);
    // Hide receipts for every transaction from the start (pruned/private node).
    const realOutcome = w.server.outcomeJson.bind(w.server);
    w.server.outcomeJson = (t) => {
      w.server.faults.hideReceipts.add(t.hash);
      return realOutcome(t);
    };
    await run(w);
    let op = w.journal.op(operationId);
    expect((await w.c.escrow.getRelease(w.c.t)).intents[0]?.state).toBe("PAID");
    expect(op.state).toBe("REVIEW");
    expect(op.lockHeld).toBe(true);
    // No database flag can assert PAID, release the lock, or skip the disposition.
    const db = w.c.w.h.db;
    expect(() =>
      db.run(
        "UPDATE economic_operations SET state = 'PAID', version = version + 1 WHERE operation_id = ?",
        operationId,
      ),
    ).toThrow(/illegal economic operation transition|terminal operation holds no lock/);
    expect(() =>
      db.run(
        "UPDATE economic_operations SET state = 'PAID', lock_held = 0, version = version + 1 WHERE operation_id = ?",
        operationId,
      ),
    ).toThrow(/illegal economic operation transition|requires an evidence disposition/);
    expect(() =>
      db.run(
        "UPDATE economic_operations SET lock_held = 0, version = version + 1 WHERE operation_id = ?",
        operationId,
      ),
    ).toThrow(/lock is released only/);
    expect(() => db.run("DELETE FROM economic_operations WHERE operation_id = ?", operationId)).toThrow(
      /append-only/,
    );
    // REVIEW keeps the value lock against every competing action.
    expect(
      await codeOfAsync(
        w.c.rel.prepareIntent(w.c.w.buyer.ctx(), { tradeId: w.c.t, idempotencyKey: "intent-key-0003" }),
      ),
    ).toBe("VALUE_LOCKED");
    // Operators: only the risk/policy principal, and only requests.
    expect(
      await codeOfAsync(() => w.svc.openAdjudication(w.c.w.buyer.ctx(), operationId, "check receipts")),
    ).toBe("FORBIDDEN");
    w.svc.openAdjudication(w.c.w.risk.ctx(), operationId, "check receipts");
    await run(w);
    expect(state(w, operationId)).toBe("ADJUDICATION");
    w.svc.identifySource(w.c.w.risk.ctx(), operationId, {
      kind: "ARCHIVAL_RPC",
      locator: "archival.example",
    });
    await run(w);
    expect(state(w, operationId)).toBe("ADJUDICATION");
    w.svc.requestReconciliation(w.c.w.risk.ctx(), operationId);
    await run(w);
    // Reconciliation ran and, with the evidence still missing, went back to REVIEW.
    expect(state(w, operationId)).toBe("REVIEW");
    expect(w.journal.transitions(operationId).map((t) => t.to)).toEqual([
      "QUEUED",
      "SUBMITTING",
      "PROCESSING",
      "REVIEW",
      "ADJUDICATION",
      "RECONCILING",
      "REVIEW",
    ]);
    // The receipts become available: new evidence, PAID on the original operation.
    w.server.outcomeJson = realOutcome;
    w.server.faults.hideReceipts.clear();
    await run(w);
    op = w.journal.op(operationId);
    expect(op.state).toBe("PAID");
    expect(
      w.journal
        .transitions(operationId)
        .map((t) => t.to)
        .slice(-2),
    ).toEqual(["RECONCILING", "PAID"]);
    expect(counts(op.txHash)).toEqual({ sends: 1, executes: 1 });
  });

  it("wrong recipient or amount in the receipt is a mismatch: REVIEW, incident, trade frozen", async () => {
    const id = await approvedIntent(w);
    const { operationId } = await w.svc.enqueueRelease(id);
    w.server.faults.deferCallbacks = true;
    await w.engine("worker-a").worker.runOnce();
    expect(state(w, operationId)).toBe("PROCESSING");
    const op = w.journal.op(operationId);
    // A node reports the transfer to another account.
    w.server.tamperReceipts(op.txHash as string, (rs) => {
      for (const r of rs) if (r.receiver_id === SUPPLIER_ACCT) r.receiver_id = "harbor-other.testnet";
    });
    w.server.releaseCallbacks();
    await run(w);
    expect(state(w, operationId)).toBe("REVIEW");
    const inc = w.journal.incidents(w.c.t);
    expect(inc.map((i) => i.kind)).toEqual(["DESTINATION_MISMATCH"]);
    expect(inc[0]?.frozen).toContain(id);
    expect(
      await codeOfAsync(
        w.c.rel.prepareIntent(w.c.w.buyer.ctx(), { tradeId: w.c.t, idempotencyKey: "intent-key-0004" }),
      ),
    ).toBe("TRADE_FROZEN");
    // Frozen REVIEW does not move on its own; a reconciliation request re-reads and returns to REVIEW.
    await run(w);
    expect(state(w, operationId)).toBe("REVIEW");
    w.svc.requestReconciliation(w.c.w.risk.ctx(), operationId);
    await run(w);
    expect(state(w, operationId)).toBe("REVIEW");
    expect(w.journal.op(operationId).lockHeld).toBe(true);
  });
});

describe("M05 journal: authoritative FAILED and fresh intent (T-056)", () => {
  it("runtime-returned transfer is FAILED with exact per-funder restoration; old intent is dead; new intent pays once", async () => {
    const id = await approvedIntent(w);
    const before = await w.c.escrow.getLedger(w.c.t);
    const { operationId } = await w.svc.enqueueRelease(id);
    w.c.sim.missing.add(SUPPLIER_ACCT);
    await run(w);
    const op = w.journal.op(operationId);
    expect(op.state).toBe("FAILED");
    expect(op.lockHeld).toBe(false);
    expect(w.journal.disposition(operationId)?.basis).toBe("TRANSFER_RETURNED");
    const after = await w.c.escrow.getLedger(w.c.t);
    for (const f of [BUYER_ACCT, TREASURY]) {
      expect(after.funders[f]?.available).toBe(
        (before.funders[f]?.reserved ?? 0n) + (before.funders[f]?.available ?? 0n),
      );
      expect(after.funders[f]?.reserved).toBe(0n);
      expect(after.funders[f]?.released).toBe(0n);
    }
    await ledgerOk(w);
    // The old intent can never be approved, submitted or queued again.
    expect(await codeOfAsync(w.c.rel.prepareExecution(id))).not.toBe("NO_ERROR");
    expect(await w.svc.enqueueRelease(id)).toEqual({ operationId, joined: true });
    await run(w);
    expect(counts(op.txHash)).toEqual({ sends: 1, executes: 1 });
    // Retry: new intent, fresh attestation (the old one was consumed) and fresh buyer approval.
    w.c.sim.missing.delete(SUPPLIER_ACCT);
    await replaceInvoice(w, "Commercial invoice INV-1 total 10 NEAR (retry)");
    await evidenceReady(w.c, "PASS", false);
    const id2 = await lockIntent(w.c, "intent-key-0005");
    expect(id2).not.toBe(id);
    await approve(w.c, id2);
    const second = await w.svc.enqueueRelease(id2);
    expect(second.operationId).not.toBe(operationId);
    await run(w);
    expect(state(w, second.operationId)).toBe("PAID");
    expect(w.server.executions.get("execute_release")).toBe(2);
    expect((await w.c.escrow.getLedger(w.c.t)).totals.released).toBe(10n * NEAR);
    await ledgerOk(w);
  });

  it("contract rejection before any effect is FAILED; the parties exit the dead intent and start fresh", async () => {
    const id = await approvedIntent(w);
    const { operationId } = await w.svc.enqueueRelease(id);
    // A hold is SET after queueing: the contract refuses execute_release.
    await w.c.w.holds.setByPolicy(
      w.c.t,
      { ruleId: "inspection-fail@1", reasonCode: "MANUAL_TEST", ttlMs: 3600_000 },
      w.c.w.policySigner,
    );
    const h = w.c.w.holds.list(w.c.t)[0];
    w.c.ok(w.c.escrow.setHoldCall(w.c.t, toTypedJson(h?.setPayload as never), h?.setSignature as string));
    await run(w);
    expect(state(w, operationId)).toBe("FAILED");
    expect(w.journal.disposition(operationId)?.basis).toBe("REJECTED_BEFORE_EFFECT");
    expect(w.server.executions.get("execute_release") ?? 0).toBe(0);
    // The reservation is untouched until the parties exit the intent (exact restoration by CANCEL).
    expect((await w.c.escrow.getLedger(w.c.t)).totals.reserved).toBe(10n * NEAR);
    expect(await codeOfAsync(w.c.rel.prepareApproval(w.c.w.buyer.ctx(), { releaseIntentId: id }))).not.toBe(
      "NO_ERROR",
    );
    await dualCancel(w.c, id);
    expect((await w.c.escrow.getLedger(w.c.t)).totals.available).toBe(10n * NEAR);
    await ledgerOk(w);
  });

  it("post-submit uncertainty never becomes FAILED: deferred settlement and a dead status source go to REVIEW", async () => {
    const id = await approvedIntent(w);
    const { operationId } = await w.svc.enqueueRelease(id);
    w.server.faults.deferCallbacks = true;
    await run(w);
    expect(state(w, operationId)).toBe("PROCESSING");
    expect((await w.c.escrow.getRelease(w.c.t)).intents[0]?.state).toBe("SUBMITTING");
    w.server.faults.statusDown = true;
    w.jclock.advance(11 * 60_000);
    await run(w);
    expect(state(w, operationId)).toBe("REVIEW");
    expect(w.journal.op(operationId).lockHeld).toBe(true);
    expect(await codeOfAsync(dualCancel(w.c, id))).not.toBe("NO_ERROR");
    // Settlement arrives later and the status source recovers.
    w.server.releaseCallbacks();
    w.server.faults.statusDown = false;
    await run(w);
    expect(state(w, operationId)).toBe("PAID");
    expect(w.server.executions.get("execute_release")).toBe(1);
  });
});

describe("M05 journal: fencing and late evidence (T-032)", () => {
  it("a worker that lost its lease epoch can write nothing", async () => {
    const id = await approvedIntent(w);
    const { operationId } = await w.svc.enqueueRelease(id);
    const j = new Journal(w.c.w.h.db, w.jclock, randomIds);
    const a = j.acquireLease(`op:${operationId}`, "stale-worker", 1_000);
    expect(a?.epoch).toBe(1);
    expect(j.acquireLease(`op:${operationId}`, "worker-b", 1_000)).toBeNull();
    w.jclock.advance(1_001);
    const b = j.acquireLease(`op:${operationId}`, "worker-b", 1_000);
    expect(b?.epoch).toBe(2);
    const op = j.op(operationId);
    expect(() => j.transition(operationId, a as never, op.version, ["SUBMITTING"], "STALE", {})).toThrow(
      /lease lost/,
    );
    expect(() =>
      j.observe(operationId, a as never, {
        source: "CONTRACT",
        subject: id,
        observedAt: 0,
        freshnessMs: 0,
        confidence: "AUTHORITATIVE",
        revision: null,
        correlationId: "cor-x",
        rawDigest: "00".repeat(32),
        fact: {},
      }),
    ).toThrow(/lease lost/);
    expect(j.op(operationId).state).toBe("QUEUED");
    expect(() =>
      w.c.w.h.db.run("UPDATE worker_leases SET epoch = 1 WHERE lease_name = ?", `op:${operationId}`),
    ).toThrow(/monotonic/);
  });

  it("evidence after an authoritative FAILED is a conservation incident: trade and successors frozen, no second payout", async () => {
    const id = await approvedIntent(w);
    const { operationId } = await w.svc.enqueueRelease(id);
    // The broadcast never reaches the chain; the transaction's validity window then expires.
    w.server.faults.dropSendRequests = 1;
    await run(w);
    expect(state(w, operationId)).toBe("UNKNOWN");
    w.server.advanceBlocks(VALIDITY + 1);
    await run(w);
    const op = w.journal.op(operationId);
    expect(op.state).toBe("FAILED");
    expect(w.journal.disposition(operationId)?.basis).toBe("EXPIRED_NOT_INCLUDED");
    // A stale worker re-broadcasting the persisted transaction cannot get it included.
    expect(w.server.send(op.signedTx as string)).toEqual({ error: "INVALID_TRANSACTION" });
    // Somebody relays the old intent directly to the contract (the call is permissionless).
    const r = w.c.ok(w.c.escrow.executeReleaseCall(w.c.t, id), "someone-else.testnet");
    w.c.sim.runPromises(r);
    await run(w);
    const inc = w.journal.incidents(w.c.t);
    expect(inc.map((i) => i.kind)).toEqual(["POST_FAILED_EVIDENCE"]);
    expect(state(w, operationId)).toBe("FAILED");
    expect(
      await codeOfAsync(
        w.c.rel.prepareIntent(w.c.w.buyer.ctx(), { tradeId: w.c.t, idempotencyKey: "intent-key-0006" }),
      ),
    ).toBe("TRADE_FROZEN");
    // Contract-level freeze through the deterministic-policy hold path.
    const call = await w.svc.escalateIncident(inc[0]?.incidentId as string, w.c.w.holds, w.c.w.policySigner);
    w.c.ok(call);
    expect((await w.c.escrow.getTrade(w.c.t)).blockingHolds).toBe(1);
    expect(w.c.sim.balance(SUPPLIER_ACCT)).toBeGreaterThan(0n);
    expect((await w.c.escrow.getLedger(w.c.t)).totals.released).toBe(10n * NEAR);
    await ledgerOk(w);
    expect(RELAYER).toBe("relayer.testnet");
  });
});
