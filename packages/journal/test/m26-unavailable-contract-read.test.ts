import { tradeRevisionDigest } from "@dockside/core";
import { afterEach, describe, expect, it } from "vitest";
import { codeOfAsync } from "../../release/test/chain.js";
import { postTerminalIncident } from "../src/index.js";
import {
  approvedIntent,
  authorizeAfterDelay,
  excessRefund,
  type JWorld,
  jworld,
  NEAR,
  run,
  state,
  TREASURY,
  VALIDITY,
} from "./world.js";

/**
 * External security audit, finding 2: a contract view that fails during the post-terminal watch
 * window is UNAVAILABLE evidence, not a contract status. It must not open an incident (which
 * freezes the trade permanently); the watch check is simply rescheduled.
 */

let w: JWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

/** Make the next `n` calls of one escrow view throw a transport-style error. */
function failView(name: "getRelease" | "getRefunds", n = 1): () => number {
  const escrow = w!.ports.escrow as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const real = escrow[name]?.bind(w!.ports.escrow) as (...a: unknown[]) => Promise<unknown>;
  let left = n;
  let thrown = 0;
  escrow[name] = async (...a: unknown[]) => {
    if (left > 0) {
      left--;
      thrown++;
      throw Object.assign(new Error("view timed out"), { code: "UPSTREAM_TIMEOUT" });
    }
    return real(...a);
  };
  return () => thrown;
}

function lastContractObservation(operationId: string) {
  return w!.journal.observations(operationId, "CONTRACT").at(-1);
}

describe("M26 unavailable contract read during the post-terminal watch", () => {
  it("PAID release: one failed release view opens no incident and no freeze; the watch continues", async () => {
    w = await jworld();
    const id = await approvedIntent(w);
    const { operationId } = await w!.svc.enqueueRelease(id);
    await run(w);
    expect(state(w, operationId)).toBe("PAID");
    expect(w!.journal.incidents(w!.c.t)).toEqual([]);
    const checksBefore = w!.journal.op(operationId).checks;

    const thrown = failView("getRelease");
    await w!.engine("worker-a").rec.runOnce();
    expect(thrown()).toBe(1);
    expect(lastContractObservation(operationId)).toMatchObject({
      confidence: "UNAVAILABLE",
      fact: { error: "UPSTREAM_TIMEOUT" },
    });
    expect(w!.journal.incidents(w!.c.t)).toEqual([]);
    expect(state(w, operationId)).toBe("PAID");
    // The check was rescheduled, not dropped.
    expect(w!.journal.op(operationId).checks).toBe(checksBefore + 1);
    // The trade is not frozen: a new service action is refused for ordinary reasons only.
    expect(
      await codeOfAsync(
        w!.c.rel.prepareIntent(w!.c.w.buyer.ctx(), { tradeId: w!.c.t, idempotencyKey: "intent-key-0026" }),
      ),
    ).not.toBe("TRADE_FROZEN");

    // The read recovers: still no incident, and the watch keeps checking.
    await w!.engine("worker-a").rec.runOnce();
    expect(w!.journal.op(operationId).checks).toBe(checksBefore + 2);
    expect(w!.journal.incidents(w!.c.t)).toEqual([]);
  });

  it("FAILED release: one failed release view is not POST_FAILED_EVIDENCE; real late evidence still is", async () => {
    w = await jworld();
    const id = await approvedIntent(w);
    const { operationId } = await w!.svc.enqueueRelease(id);
    w!.server.faults.dropSendRequests = 1;
    await run(w);
    w!.server.advanceBlocks(VALIDITY + 1);
    await run(w);
    expect(state(w, operationId)).toBe("FAILED");
    expect(w!.journal.incidents(w!.c.t)).toEqual([]);

    failView("getRelease");
    await w!.engine("worker-a").rec.runOnce();
    expect(lastContractObservation(operationId)?.confidence).toBe("UNAVAILABLE");
    expect(w!.journal.incidents(w!.c.t)).toEqual([]);
    expect(
      await codeOfAsync(
        w!.c.rel.prepareIntent(w!.c.w.buyer.ctx(), { tradeId: w!.c.t, idempotencyKey: "intent-key-0027" }),
      ),
    ).not.toBe("TRADE_FROZEN");

    // Authoritative contradicting evidence still opens the incident (SECURITY.md: post-FAILED contradiction).
    const r = w!.c.ok(w!.c.escrow.executeReleaseCall(w!.c.t, id), "someone-else.testnet");
    w!.c.sim.runPromises(r);
    await run(w);
    expect(w!.journal.incidents(w!.c.t).map((i) => i.kind)).toEqual(["POST_FAILED_EVIDENCE"]);
  });

  it("REFUNDED refund: one failed refunds view opens no incident", async () => {
    w = await jworld();
    w!.c.ok(
      w!.c.escrow.fundCall(w!.c.t, tradeRevisionDigest(w!.c.w.evidence.terms(w!.c.t)), 2n * NEAR),
      TREASURY,
    );
    const rid = await excessRefund(w);
    await authorizeAfterDelay(w, rid);
    const { operationId } = await w!.svc.enqueueRefund(w!.c.t, rid);
    await run(w);
    expect(state(w, operationId)).toBe("REFUNDED");
    expect(w!.journal.incidents(w!.c.t)).toEqual([]);

    failView("getRefunds");
    await w!.engine("worker-a").rec.runOnce();
    expect(lastContractObservation(operationId)?.confidence).toBe("UNAVAILABLE");
    expect(w!.journal.incidents(w!.c.t)).toEqual([]);
  });

  it("postTerminalIncident treats an unavailable contract read as no contract evidence", () => {
    expect(postTerminalIncident("FAILED", "EXPIRED_NOT_INCLUDED", null, [])).toBeNull();
    expect(postTerminalIncident("PAID", "AUTHORITATIVE_RECEIPT_AND_LEDGER", null, ["CONFIRMED"])).toBeNull();
    expect(postTerminalIncident("REFUNDED", "AUTHORITATIVE_RECEIPT_AND_LEDGER", null, [])).toBeNull();
    // Receipt evidence is independent of the contract read and still counts.
    expect(postTerminalIncident("FAILED", "EXPIRED_NOT_INCLUDED", null, ["CONFIRMED"])?.kind).toBe(
      "POST_FAILED_EVIDENCE",
    );
    // An authoritative PENDING read is still contradicting evidence.
    expect(postTerminalIncident("FAILED", "EXPIRED_NOT_INCLUDED", "PENDING", [])?.kind).toBe(
      "POST_FAILED_EVIDENCE",
    );
    expect(postTerminalIncident("PAID", "AUTHORITATIVE_RECEIPT_AND_LEDGER", "PENDING", [])?.kind).toBe(
      "CONTRADICTION",
    );
  });
});
