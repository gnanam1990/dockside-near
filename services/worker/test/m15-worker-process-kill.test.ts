/**
 * M15 (REAL-PRODUCT-GATE item 10): real OS process kills of the journal worker as it is composed
 * for the stack and a provisioned deployment, one process running the compiled WorkerLoop over
 * the M05 OutboxWorker and Reconciler and the M11 AssetRecoveryEngine (fixtures/worker-process.mjs).
 * A native refund and an unexpected-token recovery are queued on the same trade; the process is
 * killed with SIGKILL (TerminateProcess on Windows) at a boundary of either engine, and a fresh
 * process restarts from the SQLite file. Each scenario proves one submit per operation, the exact
 * refund to the original funder once, the exact token amount to the original sender once, and no
 * native-ledger drift. Simulated: the chain, the token and the relayer signer, not testnet.
 */
import { fileURLToPath } from "node:url";
import { randomIds, systemClock } from "@dockside/core";
import { AssetRecoveryJournal } from "@dockside/journal";
import { afterEach, describe, expect, it } from "vitest";
import { killAll, killAt, runToEnd, startProcess } from "../../../packages/journal/test/proc.js";
import {
  authorizeAfterDelay,
  CONTRACT,
  excessRefund,
  HOUR,
  type JWorld,
  jworld,
  ledgerOk,
  NEAR,
  TREASURY,
  VALIDITY,
} from "../../../packages/journal/test/world.js";
import { approve, type Keys, requestCall, type World } from "../../../packages/near/test/asset-world.js";
import { SimFungibleToken } from "../../../packages/near/test/sim/sim-token.js";

const SCRIPT = fileURLToPath(new URL("./fixtures/worker-process.mjs", import.meta.url));
const TOKEN = "sim-usd.testnet";
const SENDER = "token-sender.testnet";
const AMOUNT = 5_000_000n;

let w: JWorld;
afterEach(async () => {
  killAll();
  if (w) await w.close();
  w = undefined as unknown as JWorld;
});

interface Queued {
  refundOp: string;
  assetOp: string;
  token: SimFungibleToken;
  assets: AssetRecoveryJournal;
  treasuryBefore: bigint;
}

/** A trade with quarantined excess and an unexpected NEP-141 deposit; both returns are queued. */
async function queueBoth(): Promise<Queued> {
  w = await jworld();
  const c = w.c;
  const token = new SimFungibleToken(TOKEN);
  token.mint(SENDER, 9_000_000n);
  token.register(c.escrow.contractId);
  c.sim.externals.set(TOKEN, token);
  c.sim.credit(SENDER, 1000n * NEAR);
  // The sender's wallet sends tokens to the escrow by mistake; the contract records them for review.
  c.sim.nowMs = c.w.h.clock.now();
  const sent = token.call(
    "ft_transfer_call",
    { receiver_id: c.escrow.contractId, amount: AMOUNT.toString(), msg: "" },
    { predecessor: SENDER, depositYocto: 1n, sim: c.sim },
  );
  expect(sent.ok, sent.error ?? "").toBe(true);
  // Proof of control (the claimed sender submits a party-signed request) and risk approval.
  const k = c.w;
  const aw = {
    sim: c.sim,
    token,
    keys: {
      buyer: k.buyer.key,
      supplier: k.supplier.key,
      inspector: k.inspector.key,
      risk: k.risk.key,
    } as Keys,
    terms: k.terms,
    escrow: c.escrow,
    exec: c.exec,
  } as unknown as World;
  expect(c.exec(await requestCall(aw, 0, k.h.clock.now()), SENDER).ok).toBe(true);
  expect((await approve(aw, 0, "risk", k.h.clock.now())).ok).toBe(true);
  // The treasury's 2 NEAR excess is quarantined; its own wallet requests the return.
  c.ok(c.escrow.fundCall(c.t, 2n * NEAR), TREASURY);
  const rid = await excessRefund(w);
  await authorizeAfterDelay(w, rid);
  const { operationId: refundOp } = await w.svc.enqueueRefund(c.t, rid);
  // The 72-hour challenge window passes on the chain clock.
  c.advance(72 * HOUR);
  const assets = new AssetRecoveryJournal(k.h.db, systemClock, randomIds);
  const a = await c.escrow.getUnexpectedAsset(0);
  const recoveryId = a.liveRecoveryId as string;
  const assetOp = assets.enqueue({
    recoveryId,
    assetIndex: 0,
    assetContract: a.assetContract,
    recipient: a.claimedSender,
    amount: BigInt(a.observedAmount),
    call: c.escrow.executeAssetRecoveryCall(0, recoveryId),
    requestedBy: "prn_m15",
  }).operationId;
  return { refundOp, assetOp, token, assets, treasuryBefore: c.sim.balance(TREASURY) };
}

const env = (q: Queued, extra: Record<string, string> = {}) => ({
  DS_DB: w.c.w.h.dbPath,
  DS_RPC: w.url,
  DS_CONTRACT: CONTRACT,
  DS_VALIDITY: String(VALIDITY),
  DS_REFUND_OP: q.refundOp,
  DS_ASSET_OP: q.assetOp,
  ...extra,
});

const txsOf = (method: string) => [...w.server.txs.values()].filter((t) => t.env.methodName === method);

/** Both operations settled exactly once from the persisted identities. */
async function bothOnce(q: Queued): Promise<void> {
  const r = w.journal.op(q.refundOp);
  expect(r.state).toBe("REFUNDED");
  expect(r.submitCount).toBe(1);
  expect(w.server.sendCount.get(r.txHash as string)).toBe(1);
  expect(w.server.executions.get("execute_refund")).toBe(1);
  expect(txsOf("execute_refund").map((t) => t.hash)).toEqual([r.txHash]);
  expect(w.c.sim.balance(TREASURY) - q.treasuryBefore).toBe(2n * NEAR);
  expect((await w.c.escrow.getLedger(w.c.t)).funders[TREASURY]).toMatchObject({
    refunded: 2n * NEAR,
    quarantined: 0n,
    refundLocked: 0n,
  });
  const a = q.assets.op(q.assetOp);
  expect(a).toMatchObject({ state: "RECOVERED", lastReason: "CONTRACT_RECOVERED_TOKEN_MOVED" });
  expect(txsOf("execute_asset_recovery").map((t) => t.hash)).toEqual([a.txHash]);
  expect(w.server.executions.get("execute_asset_recovery")).toBe(1);
  expect(q.token.balanceOf(SENDER)).toBe(9_000_000n);
  expect(q.token.balanceOf(CONTRACT)).toBe(0n);
  // Native NEAR is untouched by the token recovery: the escrow ledger still conserves.
  await ledgerOk(w);
}

describe("M15 the journal worker process survives real kills across both engines", () => {
  it("the compiled worker loop runs both engines to completion in one process", async () => {
    const q = await queueBoth();
    const lines = await runToEnd(SCRIPT, env(q, { DS_HOLDER: "single" }));
    expect(lines.some((l) => l.startsWith("BOUNDARY submit.persisted"))).toBe(true);
    expect(lines.some((l) => l.startsWith("BOUNDARY asset.submit.persisted"))).toBe(true);
    await bothOnce(q);
  });

  for (const boundary of ["outbox.claimed", "submit.returned", "reconcile.observed"] as const) {
    it(`kill at the refund's ${boundary}: the restarted process refunds once and recovers the token once`, async () => {
      const q = await queueBoth();
      await killAt(SCRIPT, boundary, env(q, { DS_HOLDER: "victim" }));
      const mid = w.journal.op(q.refundOp);
      expect(mid.lockHeld).toBe(true);
      if (boundary === "outbox.claimed") expect(w.server.executions.get("execute_refund") ?? 0).toBe(0);
      else expect(mid.submitCount).toBe(1);
      // The asset engine runs after the refund engines in a tick: it had not started.
      expect(q.assets.op(q.assetOp).state).toBe("QUEUED");
      await runToEnd(SCRIPT, env(q, { DS_HOLDER: "survivor" }));
      await bothOnce(q);
    });
  }

  for (const boundary of [
    "asset.submit.persisted",
    "asset.submit.broadcast",
    "asset.transition.UNKNOWN",
  ] as const) {
    it(`killed twice, at asset.claimed and at ${boundary}: no second refund submit, the token is recovered once`, async () => {
      const q = await queueBoth();
      // First kill: the asset engine claimed its operation; the refund went out once in that tick.
      await killAt(SCRIPT, "asset.claimed", env(q, { DS_HOLDER: "victim-1" }));
      expect(q.assets.op(q.assetOp)).toMatchObject({ state: "QUEUED", txHash: null });
      expect(w.journal.op(q.refundOp).submitCount).toBe(1);
      // Only the asset broadcast's response is lost in the UNKNOWN case (the refund sends nothing more).
      if (boundary === "asset.transition.UNKNOWN") w.server.faults.dropSendResponses = 1;
      await killAt(SCRIPT, boundary, env(q, { DS_HOLDER: "victim-2" }));
      const mid = q.assets.op(q.assetOp);
      expect(mid.state).toBe(boundary === "asset.transition.UNKNOWN" ? "UNKNOWN" : "SUBMITTING");
      expect(mid.txHash).not.toBeNull();
      expect(w.journal.op(q.refundOp).submitCount).toBe(1);
      await runToEnd(SCRIPT, env(q, { DS_HOLDER: "survivor" }));
      expect(q.assets.op(q.assetOp).txHash).toBe(mid.txHash);
      await bothOnce(q);
    });
  }

  it("two worker processes race both queues: one submit per operation", async () => {
    const q = await queueBoth();
    const a = startProcess(SCRIPT, env(q, { DS_HOLDER: "racer-a" }));
    const b = startProcess(SCRIPT, env(q, { DS_HOLDER: "racer-b" }));
    const [ea, eb] = await Promise.all([a.exit(), b.exit()]);
    expect([ea.code, eb.code], [...a.lines.slice(-8), "---", ...b.lines.slice(-8)].join(" | ")).toEqual([
      0, 0,
    ]);
    await bothOnce(q);
    for (const marker of ["BOUNDARY submit.persisted", "BOUNDARY asset.submit.persisted"])
      expect([a, b].filter((p) => p.lines.some((l) => l.startsWith(marker)))).toHaveLength(1);
  });
});
