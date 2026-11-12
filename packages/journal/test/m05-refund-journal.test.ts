import { tradeRevisionDigest } from "@dockside/core";
import { afterEach, describe, expect, it } from "vitest";
import { codeOfAsync } from "../../release/test/chain.js";
import { reconcileProviderRefund } from "../src/index.js";
import {
  authorizeAfterDelay,
  BUYER_ACCT,
  excessRefund,
  type JWorld,
  jworld,
  ledgerOk,
  NEAR,
  revokeAsFunder,
  run,
  state,
  TREASURY,
} from "./world.js";

let w: JWorld;
afterEach(async () => {
  await w.close();
});

async function excessWorld(): Promise<JWorld> {
  w = await jworld();
  w.c.ok(w.c.escrow.fundCall(w.c.t, tradeRevisionDigest(w.c.w.evidence.terms(w.c.t)), 2n * NEAR), TREASURY);
  const l = await w.c.escrow.getLedger(w.c.t);
  expect(l.funders[TREASURY]?.quarantined).toBe(2n * NEAR);
  return w;
}

async function bucket(funder: string) {
  return (await w.c.escrow.getLedger(w.c.t)).funders[funder];
}

describe("T-057 refund uncertainty and revocation restore the exact bucket", () => {
  it("revocation before execution restores excess strictly to QUARANTINED; the queued operation withdraws", async () => {
    await excessWorld();
    const before = await bucket(TREASURY);
    const rid = await excessRefund(w);
    expect((await bucket(TREASURY))?.refundLocked).toBe(2n * NEAR);
    // Not yet authorized: the journal refuses to queue it.
    expect(await codeOfAsync(w.svc.enqueueRefund(w.c.t, rid))).toBe("INVALID_STATE");
    await authorizeAfterDelay(w, rid);
    const { operationId } = await w.svc.enqueueRefund(w.c.t, rid);
    expect(state(w, operationId)).toBe("QUEUED");
    await revokeAsFunder(w, rid);
    await run(w);
    expect(state(w, operationId)).toBe("WITHDRAWN");
    expect(w.journal.disposition(operationId)?.basis).toBe("SUBJECT_EXITED_EXACT_RESTORATION");
    expect(await bucket(TREASURY)).toMatchObject({
      quarantined: before?.quarantined,
      available: before?.available,
      refundLocked: 0n,
      refunded: 0n,
    });
    expect(w.journal.op(operationId).submitCount).toBe(0);
    expect(w.server.executions.get("execute_refund") ?? 0).toBe(0);
    expect(w.journal.incidents(w.c.t)).toEqual([]);
    await ledgerOk(w);
  });

  it("revocation of a partial-funding return restores PARTIAL, not a generic bucket", async () => {
    w = await jworld({ funded: false });
    w.c.ok(
      w.c.escrow.fundCall(w.c.t, tradeRevisionDigest(w.c.w.evidence.terms(w.c.t)), 6n * NEAR),
      BUYER_ACCT,
    );
    expect((await bucket(BUYER_ACCT))?.partial).toBe(6n * NEAR);
    const rid = await excessRefund(w, {
      reason: "PARTIAL_FUNDING_RETURN",
      funder: BUYER_ACCT,
      amount: 6n * NEAR,
      bucket: "PARTIAL",
    });
    await authorizeAfterDelay(w, rid);
    const { operationId } = await w.svc.enqueueRefund(w.c.t, rid);
    await revokeAsFunder(w, rid, BUYER_ACCT);
    await run(w);
    expect(state(w, operationId)).toBe("WITHDRAWN");
    expect(await bucket(BUYER_ACCT)).toMatchObject({
      partial: 6n * NEAR,
      available: 0n,
      quarantined: 0n,
      refundLocked: 0n,
    });
    await ledgerOk(w);
  });

  it("authoritative FAILED restores QUARANTINED; a new refund needs a new intent; it refunds once", async () => {
    await excessWorld();
    const rid = await excessRefund(w);
    await authorizeAfterDelay(w, rid);
    const { operationId } = await w.svc.enqueueRefund(w.c.t, rid);
    w.c.sim.missing.add(TREASURY);
    await run(w);
    expect(state(w, operationId)).toBe("FAILED");
    expect(w.journal.disposition(operationId)?.basis).toBe("TRANSFER_RETURNED");
    expect(await bucket(TREASURY)).toMatchObject({ quarantined: 2n * NEAR, refundLocked: 0n, refunded: 0n });
    // The same intent joins its FAILED operation; nothing is resubmitted.
    expect(await w.svc.enqueueRefund(w.c.t, rid)).toEqual({ operationId, joined: true });
    await run(w);
    expect(w.server.executions.get("execute_refund")).toBe(1);
    // Fresh intent and authorization.
    w.c.sim.missing.delete(TREASURY);
    const rid2 = await excessRefund(w);
    await authorizeAfterDelay(w, rid2);
    const balance = w.c.sim.balance(TREASURY);
    const second = await w.svc.enqueueRefund(w.c.t, rid2);
    await run(w);
    expect(state(w, second.operationId)).toBe("REFUNDED");
    expect(w.c.sim.balance(TREASURY) - balance).toBe(2n * NEAR);
    expect(await bucket(TREASURY)).toMatchObject({ quarantined: 0n, refunded: 2n * NEAR, refundLocked: 0n });
    expect(w.server.executions.get("execute_refund")).toBe(2);
    await ledgerOk(w);
  });

  it("UNKNOWN after a lost response reconciles by the original transaction to REFUNDED, without retry", async () => {
    await excessWorld();
    const rid = await excessRefund(w);
    await authorizeAfterDelay(w, rid);
    const { operationId } = await w.svc.enqueueRefund(w.c.t, rid);
    w.server.faults.dropSendResponses = 1;
    w.server.faults.statusDown = true;
    await run(w);
    expect(state(w, operationId)).toBe("UNKNOWN");
    expect(w.journal.op(operationId).lockHeld).toBe(true);
    // While the refund is unresolved no release intent can lock value.
    expect(
      await codeOfAsync(
        w.c.rel.prepareIntent(w.c.w.buyer.ctx(), { tradeId: w.c.t, idempotencyKey: "intent-key-0101" }),
      ),
    ).toBe("VALUE_LOCKED");
    w.server.faults.statusDown = false;
    await run(w);
    const op = w.journal.op(operationId);
    expect(op.state).toBe("REFUNDED");
    expect(w.journal.transitions(operationId).map((t) => t.to)).toEqual([
      "QUEUED",
      "EXECUTING",
      "UNKNOWN",
      "REFUNDED",
    ]);
    expect(w.server.sendCount.get(op.txHash as string)).toBe(1);
    expect(w.server.executions.get("execute_refund")).toBe(1);
    await ledgerOk(w);
  });

  it("contradictory success and failure evidence stays locked in REVIEW through reconciliation and adjudication", async () => {
    await excessWorld();
    const rid = await excessRefund(w);
    await authorizeAfterDelay(w, rid);
    const { operationId } = await w.svc.enqueueRefund(w.c.t, rid);
    const realOutcome = w.server.outcomeJson.bind(w.server);
    w.server.outcomeJson = (t) => {
      w.server.faults.hideReceipts.add(t.hash);
      return realOutcome(t);
    };
    await run(w);
    expect(state(w, operationId)).toBe("REVIEW");
    const op = w.journal.op(operationId);
    // A source now reports the funder transfer as failed while the contract says REFUNDED.
    w.server.tamperReceipts(op.txHash as string, (rs) => {
      for (const r of rs)
        if (r.receiver_id === TREASURY && r.predecessor_id !== "system")
          r.status = { Failure: { ActionError: { kind: "TransferFailed" } } };
    });
    w.server.outcomeJson = realOutcome;
    w.server.faults.hideReceipts.clear();
    await run(w);
    expect(state(w, operationId)).toBe("REVIEW");
    expect(w.journal.incidents(w.c.t).map((i) => i.kind)).toEqual(["CONTRADICTION"]);
    w.svc.openAdjudication(w.c.w.risk.ctx(), operationId, "funder receipt contradicts contract");
    await run(w);
    expect(state(w, operationId)).toBe("ADJUDICATION");
    w.svc.requestReconciliation(w.c.w.risk.ctx(), operationId);
    await run(w);
    expect(state(w, operationId)).toBe("REVIEW");
    expect(w.journal.op(operationId).lockHeld).toBe(true);
    expect(() =>
      w.c.w.h.db.run(
        "UPDATE economic_operations SET state = 'REFUNDED', version = version + 1 WHERE operation_id = ?",
        operationId,
      ),
    ).toThrow();
    // Frozen: no new release intent (and no new refund operation) for this trade.
    expect(w.journal.frozen(w.c.t).length).toBeGreaterThan(0);
    expect(
      await codeOfAsync(
        w.c.rel.prepareIntent(w.c.w.buyer.ctx(), { tradeId: w.c.t, idempotencyKey: "intent-key-0103" }),
      ),
    ).toBe("TRADE_FROZEN");
    expect(w.server.executions.get("execute_refund")).toBe(1);
  });

  it("release and refund exclude each other through the journal lock", async () => {
    await excessWorld();
    const rid = await excessRefund(w);
    await authorizeAfterDelay(w, rid);
    const { lockIntent, approve } = await import("../../release/test/chain.js");
    const id = await lockIntent(w.c, "intent-key-0102");
    await approve(w.c, id);
    await w.svc.enqueueRelease(id);
    expect(await codeOfAsync(w.svc.enqueueRefund(w.c.t, rid))).toBe("VALUE_LOCKED");
  });
});

describe("T-030 provider refund reconciliation (funded-profile logic; corridor BLOCKED)", () => {
  const base = {
    refundAuthority: "dockside-escrow.near",
    asset: "nep141:wrap.near",
    expectedYocto: 1000n,
    slices: [
      { funder: "b.near", amountYocto: 333n },
      { funder: "a.near", amountYocto: 667n },
    ],
  };
  const rc = (
    id: string,
    amount: bigint,
    over: Partial<{ receiverId: string; asset: string; final: boolean }> = {},
  ) => ({
    receiptId: id,
    receiverId: over.receiverId ?? base.refundAuthority,
    asset: over.asset ?? base.asset,
    amountYocto: amount,
    final: over.final ?? true,
  });

  it("duplicate and late receipts count once each; exact return allocates to the original funders", () => {
    const r = reconcileProviderRefund({
      ...base,
      receipts: [rc("r1", 600n), rc("r1", 600n), rc("r2", 400n)],
    });
    expect(r.status).toBe("RETURNED_EXACT");
    expect(r.countedReceipts).toEqual(["r1", "r2"]);
    expect(r.allocation).toEqual([
      { funder: "a.near", amountYocto: 667n },
      { funder: "b.near", amountYocto: 333n },
    ]);
    expect(r.unmatchedYocto).toBe(0n);
    // Idempotent: the same facts give the same result.
    expect(reconcileProviderRefund({ ...base, receipts: [rc("r2", 400n), rc("r1", 600n)] })).toEqual(r);
  });

  it("short refund leaves the unmatched amount locked; excess is quarantined; non-final waits", () => {
    const short = reconcileProviderRefund({ ...base, receipts: [rc("r1", 500n)] });
    expect(short.status).toBe("SHORT");
    expect(short.unmatchedYocto).toBe(500n);
    expect(short.allocation.reduce((a, s) => a + s.amountYocto, 0n)).toBe(500n);
    const excess = reconcileProviderRefund({ ...base, receipts: [rc("r1", 1200n)] });
    expect(excess.status).toBe("EXCESS");
    expect(excess.quarantineYocto).toBe(200n);
    expect(excess.allocation.reduce((a, s) => a + s.amountYocto, 0n)).toBe(1000n);
    expect(reconcileProviderRefund({ ...base, receipts: [rc("r1", 1000n, { final: false })] }).status).toBe(
      "AWAITING",
    );
  });

  it("a refund to any other target or asset counts for nothing and needs REVIEW", () => {
    const r = reconcileProviderRefund({
      ...base,
      receipts: [rc("r1", 1000n, { receiverId: "executor.near" }), rc("r2", 1000n, { asset: "native" })],
    });
    expect(r.status).toBe("WRONG_TARGET");
    expect(r.allocation.reduce((a, s) => a + s.amountYocto, 0n)).toBe(0n);
    expect(r.unmatchedYocto).toBe(1000n);
    // The same receipt id re-delivered with another amount is contradictory.
    expect(reconcileProviderRefund({ ...base, receipts: [rc("r1", 1000n), rc("r1", 10n)] }).status).toBe(
      "WRONG_TARGET",
    );
  });
});
