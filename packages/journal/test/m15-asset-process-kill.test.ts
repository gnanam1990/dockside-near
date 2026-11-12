/**
 * M15 (REAL-PRODUCT-GATE item 10 for unexpected assets): real OS process kills of the
 * asset-recovery engine. The engine runs as a separate Node process over the compiled package
 * (fixtures/asset-worker.mjs), the real SQLite file and the simulated chain's JSON-RPC endpoint; it
 * is killed with SIGKILL (TerminateProcess on Windows) while blocked at a named boundary, and a
 * fresh process restarts from persistence. Every scenario proves one transaction identity, at most
 * one execution, the exact token amount to the original sender once, and no exit from REVIEW.
 * Simulated: the chain and the NEP-141 token, not testnet.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomIds, systemClock } from "@dockside/core";
import { EscrowContract, JsonRpcNearClient } from "@dockside/near";
import { Database } from "@dockside/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  approve,
  CONTRACT,
  requestCall,
  SENDER,
  sendTokens,
  T0,
  type World,
  world,
} from "../../near/test/asset-world.js";
import { AssetRecoveryJournal } from "../src/index.js";
import { killAll, killAt, runToEnd, startProcess } from "./proc.js";
import { SimChainServer } from "./sim-chain.js";

const SCRIPT = fileURLToPath(new URL("./fixtures/asset-worker.mjs", import.meta.url));
const CHALLENGE = 72 * 3600_000;
const VALIDITY = 20;
const AMOUNT = 5_000_000n;

interface K {
  w: World;
  server: SimChainServer;
  db: Database;
  dbPath: string;
  url: string;
  journal: AssetRecoveryJournal;
  escrow: EscrowContract;
  chainNow: { t: number };
}

let k: K;

beforeEach(async () => {
  const w = world();
  const chainNow = { t: T0 };
  const server = new SimChainServer(w.sim, () => chainNow.t, { validityBlocks: VALIDITY });
  const url = await server.start();
  const dbPath = join(mkdtempSync(join(tmpdir(), "dockside-m15-")), "j.sqlite");
  const db = Database.open(dbPath);
  db.migrate();
  const rpc = new JsonRpcNearClient({
    endpoint: url,
    allowedHosts: ["127.0.0.1"],
    timeoutMs: 5_000,
    maxResponseBytes: 4 * 1024 * 1024,
  });
  k = {
    w,
    server,
    db,
    dbPath,
    url,
    journal: new AssetRecoveryJournal(db, systemClock, randomIds),
    escrow: new EscrowContract(rpc, CONTRACT),
    chainNow,
  };
});

afterEach(async () => {
  killAll();
  await k.server.stop();
  k.db.close();
});

const env = (extra: Record<string, string> = {}) => ({
  DS_DB: k.dbPath,
  DS_RPC: k.url,
  DS_CONTRACT: CONTRACT,
  DS_VALIDITY: String(VALIDITY),
  ...extra,
});

/** Tokens arrive, the sender requests, risk approves; the chain passes the 72-hour window; queued. */
async function queued(): Promise<string> {
  sendTokens(k.w, AMOUNT);
  expect(k.w.exec(await requestCall(k.w, 0), SENDER).ok).toBe(true);
  expect((await approve(k.w, 0)).ok).toBe(true);
  k.chainNow.t = T0 + CHALLENGE;
  const a = await k.escrow.getUnexpectedAsset(0);
  const rid = a.liveRecoveryId as string;
  return k.journal.enqueue({
    recoveryId: rid,
    assetIndex: 0,
    assetContract: a.assetContract,
    recipient: a.claimedSender,
    amount: BigInt(a.observedAmount),
    call: k.escrow.executeAssetRecoveryCall(0, rid),
    requestedBy: "prn_m15",
  }).operationId;
}

const execHashes = () =>
  [...k.server.txs.values()].filter((t) => t.env.methodName === "execute_asset_recovery").map((t) => t.hash);

const kill = (id: string, boundary: string, holder = "victim") =>
  killAt(SCRIPT, boundary, env({ DS_OPS: id, DS_HOLDER: holder }));
const finish = (id: string, stop = "RECOVERED,FAILED,NOT_SUBMITTED", holder = "survivor") =>
  runToEnd(SCRIPT, env({ DS_OPS: id, DS_STOP_STATES: stop, DS_HOLDER: holder }));

/** One transaction identity, one execution, the exact amount back to the sender once. */
async function recoveredOnce(id: string, txHash: string | null = null): Promise<void> {
  const op = k.journal.op(id);
  expect(op.state).toBe("RECOVERED");
  expect(op.lastReason).toBe("CONTRACT_RECOVERED_TOKEN_MOVED");
  if (txHash) expect(op.txHash).toBe(txHash);
  expect(execHashes()).toEqual([op.txHash]);
  expect(k.server.executions.get("execute_asset_recovery")).toBe(1);
  expect(k.w.token.balanceOf(SENDER)).toBe(9_000_000n);
  expect(k.w.token.balanceOf(CONTRACT)).toBe(0n);
  expect((await k.escrow.getUnexpectedAsset(0)).state).toBe("RECOVERED");
  // Observations are append-only facts: no (source, fact) pair is recorded twice by a restart.
  const obs = k.journal.observations(id);
  expect(new Set(obs.map((o) => `${o.source}:${o.observedAt}:${JSON.stringify(o.fact)}`)).size).toBe(
    obs.length,
  );
}

describe("M15 asset-recovery engine survives real process kills", () => {
  it("kill after claiming the operation, before any signing: the restart submits once", async () => {
    const id = await queued();
    await kill(id, "asset.claimed");
    expect(k.journal.op(id)).toMatchObject({ state: "QUEUED", txHash: null });
    expect(execHashes()).toEqual([]);
    await finish(id);
    await recoveredOnce(id);
    expect(k.server.sendCount.get(k.journal.op(id).txHash as string)).toBe(1);
  });

  it("kill after the signed transaction is persisted, before broadcast: the restart re-sends only the identical bytes", async () => {
    const id = await queued();
    await kill(id, "asset.submit.persisted");
    const persisted = k.journal.op(id);
    expect(persisted.state).toBe("SUBMITTING");
    expect(persisted.txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,64}$/);
    expect(persisted.signedTx).not.toBeNull();
    expect(k.server.sendCount.get(persisted.txHash as string) ?? 0).toBe(0);
    await finish(id);
    await recoveredOnce(id, persisted.txHash);
    expect(k.server.sendCount.get(persisted.txHash as string)).toBe(1);
  });

  it("kill after the broadcast, before its outcome is recorded: the restart reconciles from the original hash", async () => {
    const id = await queued();
    await kill(id, "asset.submit.broadcast");
    const mid = k.journal.op(id);
    expect(mid.state).toBe("SUBMITTING");
    expect(k.server.executions.get("execute_asset_recovery")).toBe(1);
    await finish(id);
    await recoveredOnce(id, mid.txHash);
    expect(k.server.sendCount.get(mid.txHash as string)).toBe(1);
  });

  it("kill after observing the chain, before deciding: the restart decides from fresh observations", async () => {
    const id = await queued();
    await kill(id, "asset.reconcile.observed");
    expect(k.journal.op(id).state).toBe("SUBMITTING");
    await finish(id);
    await recoveredOnce(id);
  });

  it("a lost broadcast response persisted as UNKNOWN, killed there: no second transaction, RECOVERED", async () => {
    const id = await queued();
    k.server.faults.dropSendResponses = 1;
    await kill(id, "asset.transition.UNKNOWN");
    const mid = k.journal.op(id);
    expect(mid).toMatchObject({ state: "UNKNOWN" });
    expect(mid.lastReason).toMatch(/^BROADCAST_UNCERTAIN:/);
    await finish(id);
    await recoveredOnce(id, mid.txHash);
    expect(k.server.sendCount.get(mid.txHash as string)).toBe(1);
  });

  it("killed in PROCESSING (callback pending) and again at REVIEW: REVIEW survives every restart and is never left", async () => {
    const id = await queued();
    k.server.faults.deferCallbacks = true;
    await kill(id, "asset.transition.PROCESSING");
    expect(k.journal.op(id).state).toBe("PROCESSING");
    await finish(id, "PROCESSING", "survivor-1");
    expect(k.journal.op(id).state).toBe("PROCESSING");
    // Unrelated tokens arrive before the callback settles: the balance contradicts the contract.
    sendTokens(k.w, 4_000_000n);
    k.server.releaseCallbacks();
    await kill(id, "asset.transition.REVIEW", "victim-2");
    expect(k.journal.op(id)).toMatchObject({
      state: "REVIEW",
      lastReason: "TOKEN_BALANCE_CONTRADICTS_CONTRACT",
    });
    // A restarted engine finds nothing due and changes nothing.
    const p = startProcess(
      SCRIPT,
      env({ DS_OPS: id, DS_STOP_STATES: "REVIEW", DS_HOLDER: "survivor-2", DS_MAX_MS: "1500" }),
    );
    expect((await p.exit()).code).toBe(0);
    expect(p.lines.some((l) => l.startsWith("BOUNDARY"))).toBe(false);
    expect(k.journal.op(id).state).toBe("REVIEW");
    expect(execHashes()).toHaveLength(1);
    expect(k.server.executions.get("execute_asset_recovery")).toBe(1);
  });

  it("two engine processes race the same queued operation: one submit, one execution", async () => {
    const id = await queued();
    const a = startProcess(SCRIPT, env({ DS_OPS: id, DS_STOP_STATES: "RECOVERED", DS_HOLDER: "racer-a" }));
    const b = startProcess(SCRIPT, env({ DS_OPS: id, DS_STOP_STATES: "RECOVERED", DS_HOLDER: "racer-b" }));
    const [ea, eb] = await Promise.all([a.exit(), b.exit()]);
    expect([ea.code, eb.code]).toEqual([0, 0]);
    await recoveredOnce(id);
    const submitters = [a, b].filter((p) =>
      p.lines.some((l) => l.startsWith("BOUNDARY asset.submit.persisted")),
    );
    expect(submitters).toHaveLength(1);
  });
});
