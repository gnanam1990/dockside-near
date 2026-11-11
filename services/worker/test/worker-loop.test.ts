/**
 * The worker loop drives a queued direct release to PAID through the M05 outbox worker and
 * reconciler against the simulated chain server (compiled escrow wasm on the M02 host over
 * JSON-RPC; not testnet). Overlapping ticks never run twice.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvedIntent, type JWorld, jworld } from "../../../packages/journal/test/world.js";
import { WorkerLoop } from "../src/index.js";

let w: JWorld;
beforeAll(async () => {
  w = await jworld();
});
afterAll(async () => {
  await w.close();
});

describe("services/worker loop", () => {
  it("delivers once and reconciles to PAID; overlapping ticks share one pass", async () => {
    const id = await approvedIntent(w, "worker-loop-0001");
    const { operationId } = await w.svc.enqueueRelease(id);
    const e = w.engine("loop-worker");
    const lines: Record<string, unknown>[] = [];
    const loop = new WorkerLoop({
      worker: e.worker,
      reconciler: e.rec,
      intervalMs: 10,
      log: (l) => lines.push(l),
    });
    const [a, b] = await Promise.all([loop.tick(), loop.tick()]);
    expect(a).toBe(b);
    expect(a.delivered).toEqual([operationId]);
    for (let i = 0; i < 5 && w.journal.op(operationId).state !== "PAID"; i++) await loop.tick();
    expect(w.journal.op(operationId).state).toBe("PAID");
    expect(w.journal.op(operationId).submitCount).toBe(1);
    loop.start();
    await new Promise((r) => setTimeout(r, 40));
    await loop.stop();
    expect(w.journal.op(operationId).submitCount).toBe(1);
    expect(lines.some((l) => l["event"] === "worker.tick")).toBe(true);
    expect(JSON.stringify(lines)).not.toMatch(/signed|signature|secret/i);
  });

  it("refuses a busy-loop interval", () => {
    const e = w.engine("bad");
    expect(() => new WorkerLoop({ worker: e.worker, reconciler: e.rec, intervalMs: 0 })).toThrow();
  });
});
