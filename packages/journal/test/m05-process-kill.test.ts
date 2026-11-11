/**
 * T-029 / T-057 / NFR-01: real process kills. Journal workers run as separate Node processes over
 * the compiled package, the real SQLite file and the simulated chain's JSON-RPC endpoint. A worker
 * is killed (SIGKILL; TerminateProcess on Windows) while blocked at a named persistence or effect
 * boundary, and a fresh process restarts from persistence. Every scenario proves the same lock,
 * the same identities, no bucket drift and no second economic submit.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { approve, dualCancel, evidenceReady, lockIntent } from "../../release/test/chain.js";
import {
  approvedIntent,
  authorizeAfterDelay,
  CONTRACT,
  excessRefund,
  type JWorld,
  jworld,
  ledgerOk,
  NEAR,
  replaceInvoice,
  SUPPLIER_ACCT,
  TREASURY,
  VALIDITY,
} from "./world.js";

const SCRIPT = fileURLToPath(new URL("./fixtures/journal-worker.mjs", import.meta.url));
const DIST = fileURLToPath(new URL("../dist/index.js", import.meta.url));

let w: JWorld;
const procs: ChildProcess[] = [];
afterEach(async () => {
  for (const p of procs) if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
  procs.length = 0;
  if (w) await w.close();
  w = undefined as unknown as JWorld;
});

interface Proc {
  proc: ChildProcess;
  lines: string[];
  until(re: RegExp): Promise<string>;
  exit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function startWorker(extra: Record<string, string> = {}): Proc {
  const proc = spawn(process.execPath, ["--no-warnings", SCRIPT], {
    env: {
      ...process.env,
      DS_DB: w.c.w.h.dbPath,
      DS_RPC: w.url,
      DS_CONTRACT: CONTRACT,
      DS_TRADE: w.c.t,
      DS_VALIDITY: String(VALIDITY),
      ...extra,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  procs.push(proc);
  const lines: string[] = [];
  const waiters: { re: RegExp; resolve: (l: string) => void }[] = [];
  let buf = "";
  let err = "";
  proc.stdout?.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    let i = buf.indexOf("\n");
    while (i >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      lines.push(line);
      for (const x of [...waiters])
        if (x.re.test(line)) {
          waiters.splice(waiters.indexOf(x), 1);
          x.resolve(line);
        }
      i = buf.indexOf("\n");
    }
  });
  proc.stderr?.on("data", (d: Buffer) => {
    err += d.toString("utf8");
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) =>
    proc.on("exit", (code, signal) => r({ code, signal })),
  );
  return {
    proc,
    lines,
    until(re) {
      const hit = lines.find((l) => re.test(l));
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        waiters.push({ re, resolve });
        void exited.then((e) =>
          reject(
            new Error(`worker exited (${e.code}/${e.signal}) before ${re}: ${lines.join(" | ")} ${err}`),
          ),
        );
      });
    },
    exit: () => exited,
  };
}

/** Run a worker until it blocks at `boundary`, then kill it there. */
async function killAt(boundary: string, extra: Record<string, string> = {}): Promise<string[]> {
  const p = startWorker({ DS_PAUSE_AT: boundary, DS_HOLDER: "victim", ...extra });
  await p.until(new RegExp(`^PAUSED ${boundary.replace(".", "\\.")} `));
  p.proc.kill("SIGKILL");
  const e = await p.exit();
  expect(e.code === null || e.code !== 0).toBe(true);
  return p.lines;
}

async function runToEnd(
  stop = "PAID,REFUNDED,FAILED,WITHDRAWN",
  extra: Record<string, string> = {},
): Promise<string[]> {
  const p = startWorker({ DS_STOP_STATES: stop, DS_HOLDER: `survivor-${procs.length}`, ...extra });
  const e = await p.exit();
  expect(e.code, p.lines.join(" | ")).toBe(0);
  return p.lines;
}

function onlyOp() {
  const ops = w.journal.opsForTrade(w.c.t);
  expect(ops).toHaveLength(1);
  return ops[0] as (typeof ops)[number];
}

function exactlyOnce(method = "execute_release") {
  const op = onlyOp();
  expect(op.submitCount).toBe(1);
  expect(w.server.sendCount.get(op.txHash as string)).toBe(1);
  expect(w.server.executions.get(method)).toBe(1);
  // No duplicate observation rows: every (source, raw digest) pair is unique.
  const obs = w.journal.observations(op.operationId);
  expect(new Set(obs.map((o) => `${o.source}:${o.rawDigest}`)).size).toBe(obs.length);
  return op;
}

describe("T-029 restart resumes reconciliation without resubmit (release boundaries)", () => {
  it("the compiled worker exists (pretest build)", () => {
    expect(existsSync(DIST)).toBe(true);
  });

  for (const [boundary, faults] of [
    ["outbox.claimed", {}],
    ["submit.returned", {}],
    ["reconcile.observed", {}],
    ["unknown.persisted", { dropSendResponses: 1 }],
  ] as const) {
    it(`kill at ${boundary}: restart pays exactly once from persisted state`, async () => {
      w = await jworld();
      const id = await approvedIntent(w);
      const supplier = w.c.sim.balance(SUPPLIER_ACCT);
      const { operationId } = await w.svc.enqueueRelease(id);
      Object.assign(w.server.faults, faults);
      await killAt(boundary);
      const mid = w.journal.op(operationId);
      expect(mid.lockHeld).toBe(true);
      if (boundary === "outbox.claimed") {
        expect(mid.state).toBe("QUEUED");
        expect(w.server.executions.get("execute_release") ?? 0).toBe(0);
      } else {
        expect(mid.submitCount).toBe(1);
        expect(w.server.executions.get("execute_release")).toBe(1);
      }
      if (boundary === "unknown.persisted") expect(mid.state).toBe("UNKNOWN");
      await runToEnd();
      const op = exactlyOnce();
      expect(op.operationId).toBe(operationId);
      expect(op.subjectId).toBe(id);
      expect(op.state).toBe("PAID");
      expect(w.c.sim.balance(SUPPLIER_ACCT) - supplier).toBe(10n * NEAR);
      await ledgerOk(w);
    });
  }

  it("kill after the signed transaction is persisted but before broadcast: never rebroadcast; expiry proves FAILED; fresh intent pays", async () => {
    w = await jworld();
    const id = await approvedIntent(w);
    const { operationId } = await w.svc.enqueueRelease(id);
    await killAt("submit.persisted");
    let op = w.journal.op(operationId);
    expect(op.state).toBe("SUBMITTING");
    expect(op.txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,64}$/);
    expect(w.journal.outbox(operationId).status).toBe("DONE");
    expect(w.server.sendCount.get(op.txHash as string) ?? 0).toBe(0);
    // Restart: the outcome is unknown (the broadcast may have left), so nothing is re-sent.
    await runToEnd("UNKNOWN");
    op = w.journal.op(operationId);
    expect(op.state).toBe("UNKNOWN");
    expect(w.server.sendCount.get(op.txHash as string) ?? 0).toBe(0);
    expect((await w.c.escrow.getLedger(w.c.t)).totals.reserved).toBe(10n * NEAR);
    // The transaction's validity window passes: it can never be included.
    w.server.advanceBlocks(VALIDITY + 1);
    await runToEnd("FAILED");
    expect(w.journal.op(operationId).state).toBe("FAILED");
    expect(w.journal.disposition(operationId)?.basis).toBe("EXPIRED_NOT_INCLUDED");
    expect(w.server.send(op.signedTx as string)).toEqual({ error: "INVALID_TRANSACTION" });
    expect(w.server.executions.get("execute_release") ?? 0).toBe(0);
    // Fresh-new-intent rule: the dead intent exits (exact restoration), a new one is approved.
    await dualCancel(w.c, id);
    expect((await w.c.escrow.getLedger(w.c.t)).totals.available).toBe(10n * NEAR);
    const id2 = await lockIntent(w.c, "intent-key-0201");
    await approve(w.c, id2);
    const second = await w.svc.enqueueRelease(id2);
    await runToEnd();
    expect(w.journal.op(second.operationId).state).toBe("PAID");
    expect(w.server.executions.get("execute_release")).toBe(1);
    await ledgerOk(w);
  });

  it("kill at REVIEW and at the adjudication and reconciliation boundaries: the lock and states survive", async () => {
    w = await jworld();
    const id = await approvedIntent(w);
    const { operationId } = await w.svc.enqueueRelease(id);
    const real = w.server.outcomeJson.bind(w.server);
    w.server.outcomeJson = (t) => {
      w.server.faults.hideReceipts.add(t.hash);
      return real(t);
    };
    await killAt("transition.REVIEW");
    expect(w.journal.op(operationId).state).toBe("REVIEW");
    await runToEnd("REVIEW");
    expect(w.journal.op(operationId).state).toBe("REVIEW");
    w.svc.openAdjudication(w.c.w.risk.ctx(), operationId, "receipts withheld by node");
    await killAt("adjudication.persisted");
    expect(w.journal.op(operationId).state).toBe("ADJUDICATION");
    await runToEnd("ADJUDICATION");
    expect(w.journal.op(operationId).lockHeld).toBe(true);
    w.server.outcomeJson = real;
    w.server.faults.hideReceipts.clear();
    w.svc.requestReconciliation(w.c.w.risk.ctx(), operationId);
    await killAt("reconciling.persisted");
    expect(w.journal.op(operationId).state).toBe("RECONCILING");
    await runToEnd();
    const op = exactlyOnce();
    expect(op.state).toBe("PAID");
    expect(w.journal.transitions(operationId).map((t) => t.to)).toEqual([
      "QUEUED",
      "SUBMITTING",
      "PROCESSING",
      "REVIEW",
      "ADJUDICATION",
      "RECONCILING",
      "PAID",
    ]);
  });

  it("two worker processes race the same outbox row: one submit, one payout", async () => {
    w = await jworld();
    const id = await approvedIntent(w);
    await w.svc.enqueueRelease(id);
    const a = startWorker({ DS_STOP_STATES: "PAID", DS_HOLDER: "racer-a" });
    const b = startWorker({ DS_STOP_STATES: "PAID", DS_HOLDER: "racer-b" });
    const [ea, eb] = await Promise.all([a.exit(), b.exit()]);
    expect([ea.code, eb.code]).toEqual([0, 0]);
    exactlyOnce();
    const submitters = [a, b].filter((p) => p.lines.some((l) => l.startsWith("BOUNDARY submit.persisted")));
    expect(submitters).toHaveLength(1);
  });

  it("FAILED retry after a restart still needs a new intent with fresh attestation and approval", async () => {
    w = await jworld();
    const id = await approvedIntent(w);
    const { operationId } = await w.svc.enqueueRelease(id);
    w.c.sim.missing.add(SUPPLIER_ACCT);
    await killAt("submit.returned");
    await runToEnd("FAILED");
    expect(w.journal.disposition(operationId)?.basis).toBe("TRANSFER_RETURNED");
    expect(await w.svc.enqueueRelease(id)).toEqual({ operationId, joined: true });
    w.c.sim.missing.delete(SUPPLIER_ACCT);
    await replaceInvoice(w, "Commercial invoice INV-1 total 10 NEAR (re-issued)");
    await evidenceReady(w.c, "PASS", false);
    const id2 = await lockIntent(w.c, "intent-key-0202");
    await approve(w.c, id2);
    await w.svc.enqueueRelease(id2);
    await runToEnd();
    expect(w.server.executions.get("execute_release")).toBe(2);
    expect((await w.c.escrow.getLedger(w.c.t)).totals.released).toBe(10n * NEAR);
    await ledgerOk(w);
  });
});

describe("T-057 refund submit and reconciliation boundaries survive process kills", () => {
  for (const boundary of [
    "outbox.claimed",
    "submit.persisted",
    "submit.returned",
    "reconcile.observed",
  ] as const) {
    it(`kill at refund ${boundary}: restart refunds the original funder exactly once (or never, if not broadcast)`, async () => {
      w = await jworld();
      w.c.ok(w.c.escrow.fundCall(w.c.t, 2n * NEAR), TREASURY);
      const rid = await excessRefund(w);
      await authorizeAfterDelay(w, rid);
      const balance = w.c.sim.balance(TREASURY);
      const { operationId } = await w.svc.enqueueRefund(w.c.t, rid);
      await killAt(boundary);
      if (boundary === "submit.persisted") {
        await runToEnd("UNKNOWN");
        w.server.advanceBlocks(VALIDITY + 1);
        await runToEnd("FAILED");
        expect(w.journal.disposition(operationId)?.basis).toBe("EXPIRED_NOT_INCLUDED");
        expect(w.server.executions.get("execute_refund") ?? 0).toBe(0);
        // The refund lock is the contract's: the AUTHORIZED intent still holds the slice.
        const f = (await w.c.escrow.getLedger(w.c.t)).funders[TREASURY];
        expect(f).toMatchObject({ refundLocked: 2n * NEAR, quarantined: 0n, refunded: 0n });
        return;
      }
      await runToEnd();
      const op = exactlyOnce("execute_refund");
      expect(op.state).toBe("REFUNDED");
      expect(w.c.sim.balance(TREASURY) - balance).toBe(2n * NEAR);
      expect((await w.c.escrow.getLedger(w.c.t)).funders[TREASURY]).toMatchObject({
        refunded: 2n * NEAR,
        quarantined: 0n,
        refundLocked: 0n,
      });
      await ledgerOk(w);
    });
  }
});
