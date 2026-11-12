/**
 * M11 journaled submission of `execute_asset_recovery` (REAL-PRODUCT-GATE items 9 and 10 for
 * unexpected assets). The compiled escrow wasm and a simulated NEP-141 token run on the
 * simulated NEAR host behind SimChainServer; the engine reaches them only through the
 * production `JsonRpcNearClient`, `EscrowContract`, `NearTxClient` and `Nep141Reader`.
 * Proven here: the transaction is persisted before broadcast, a crash before broadcast and a lost
 * response are reconciled from the original hash (never a second transaction), an early or
 * refused execution is NOT_SUBMITTED, an adapter failure is FAILED without retry, a pending
 * callback is PROCESSING, and a token balance that contradicts the contract is REVIEW.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManualClock, randomIds } from "@dockside/core";
import { EscrowContract, JsonRpcNearClient, NearTxClient, Nep141Reader } from "@dockside/near";
import { Database } from "@dockside/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  approve,
  CONTRACT,
  RELAYER,
  requestCall,
  SENDER,
  sendTokens,
  T0,
  TOKEN,
  type World,
  world,
} from "../../near/test/asset-world.js";
import {
  type AssetChainPorts,
  type AssetEngineConfig,
  AssetRecoveryEngine,
  AssetRecoveryJournal,
} from "../src/index.js";
import { SimChainServer, SimTxSigner } from "./sim-chain.js";

const CHALLENGE = 72 * 3600_000;
const VALIDITY = 20;

interface JW {
  w: World;
  server: SimChainServer;
  db: Database;
  clock: ManualClock;
  journal: AssetRecoveryJournal;
  ports: AssetChainPorts;
  chainNow: { t: number };
  engine(holder: string, cfg?: Partial<AssetEngineConfig>): AssetRecoveryEngine;
  enqueue(index?: number): Promise<string>;
}

async function setup(): Promise<JW> {
  const w = world();
  const chainNow = { t: T0 };
  const server = new SimChainServer(w.sim, () => chainNow.t, { validityBlocks: VALIDITY });
  const url = await server.start();
  const rpc = new JsonRpcNearClient({
    endpoint: url,
    allowedHosts: ["127.0.0.1"],
    timeoutMs: 5_000,
    maxResponseBytes: 4 * 1024 * 1024,
  });
  const db = Database.open(join(mkdtempSync(join(tmpdir(), "dockside-m11-")), "j.sqlite"));
  db.migrate();
  const clock = new ManualClock(Date.now());
  const journal = new AssetRecoveryJournal(db, clock, randomIds);
  const escrow = new EscrowContract(rpc, CONTRACT);
  const ports: AssetChainPorts = {
    escrow,
    tx: new NearTxClient(rpc),
    token: (c) => new Nep141Reader(rpc, c),
    txValidityBlocks: VALIDITY,
  };
  const jw: JW = {
    w,
    server,
    db,
    clock,
    journal,
    ports,
    chainNow,
    engine(holder, cfg = {}) {
      return new AssetRecoveryEngine(
        new AssetRecoveryJournal(db, clock, randomIds),
        ports,
        new SimTxSigner(RELAYER),
        {
          holder,
          leaseTtlMs: 30_000,
          baseBackoffMs: 0,
          maxBackoffMs: 0,
          ...cfg,
        },
      );
    },
    async enqueue(index = 0) {
      const a = await escrow.getUnexpectedAsset(index);
      const rid = (a.liveRecoveryId ?? a.recoveries.at(-1)?.recoveryId) as string;
      return journal.enqueue({
        recoveryId: rid,
        assetIndex: index,
        assetContract: a.assetContract,
        recipient: a.claimedSender,
        amount: BigInt(a.observedAmount),
        call: escrow.executeAssetRecoveryCall(index, rid),
        requestedBy: "prn_test",
      }).operationId;
    },
  };
  return jw;
}

/** Tokens arrive, the sender requests, risk approves at T0; the chain clock then passes 72 hours. */
async function approvedAsset(j: JW, amount = 5_000_000n, index = 0): Promise<void> {
  sendTokens(j.w, amount);
  expect(j.w.exec(await requestCall(j.w, index), SENDER).ok).toBe(true);
  expect((await approve(j.w, index)).ok).toBe(true);
}

const execHashes = (j: JW) =>
  [...j.server.txs.values()].filter((t) => t.env.methodName === "execute_asset_recovery").map((t) => t.hash);

describe("M11 asset recovery journal (simulated chain over JSON-RPC)", () => {
  let j: JW;
  beforeEach(async () => {
    j = await setup();
  });
  afterEach(async () => {
    await j.server.stop();
    j.db.close();
  });

  it("persists the signed transaction before broadcast and settles RECOVERED with the token moved", async () => {
    await approvedAsset(j);
    j.chainNow.t = T0 + CHALLENGE;
    const id = await j.enqueue();
    expect(j.journal.enqueue({ ...j.journal.op(id), requestedBy: "prn_other" }).joined).toBe(true);
    const seen: string[] = [];
    const e = j.engine("worker-a", {
      onBoundary: (b, op) => {
        // At the persistence boundary the hash is durable and nothing has reached the chain yet.
        if (b === "asset.submit.persisted") {
          const o = j.journal.op(op);
          seen.push(`${o.state}:${o.txHash !== null}:${execHashes(j).length}`);
        }
      },
    });
    await e.runOnce();
    expect(seen).toEqual(["SUBMITTING:true:0"]);
    const op = j.journal.op(id);
    expect(op.state).toBe("RECOVERED");
    expect(op.lastReason).toBe("CONTRACT_RECOVERED_TOKEN_MOVED");
    expect(op.tokenBalanceBefore).toBe(5_000_000n);
    expect(j.w.token.balanceOf(SENDER)).toBe(9_000_000n);
    expect((await j.ports.escrow.getUnexpectedAsset(0)).state).toBe("RECOVERED");
    expect(execHashes(j)).toEqual([op.txHash]);
    expect(j.server.sendCount.get(op.txHash as string)).toBe(1);
    const sources = j.journal.observations(id).map((o) => o.source);
    expect(sources).toEqual(expect.arrayContaining(["CONTRACT", "TOKEN", "BROADCAST", "TX_STATUS"]));
    // Settled: a further execution request for the same recovery is refused.
    await expect(j.enqueue()).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("a crash after persisting and before broadcast resumes with the identical transaction, once", async () => {
    await approvedAsset(j);
    j.chainNow.t = T0 + CHALLENGE;
    const id = await j.enqueue();
    const crashing = j.engine("worker-a", {
      onBoundary: (b) => {
        if (b === "asset.submit.persisted") throw new Error("process killed");
      },
    });
    await expect(crashing.runOnce()).rejects.toThrow("process killed");
    const persisted = j.journal.op(id);
    expect(persisted.state).toBe("SUBMITTING");
    expect(execHashes(j)).toEqual([]);
    // A second worker after the lease TTL: reconciliation finds the tx NOT_FOUND inside its validity
    // window and re-sends the identical persisted bytes (same hash, same nonce).
    j.clock.advance(31_000);
    const b = j.engine("worker-b");
    await b.runOnce();
    await b.runOnce();
    const op = j.journal.op(id);
    expect(op.txHash).toBe(persisted.txHash);
    expect(op.state).toBe("RECOVERED");
    expect(execHashes(j)).toEqual([persisted.txHash]);
    expect(j.server.executions.get("execute_asset_recovery")).toBe(1);
    expect(j.w.token.balanceOf(SENDER)).toBe(9_000_000n);
  });

  it("a lost broadcast response is UNKNOWN, then reconciled from the original hash without resubmitting", async () => {
    await approvedAsset(j);
    j.chainNow.t = T0 + CHALLENGE;
    const id = await j.enqueue();
    j.server.faults.dropSendResponses = 1;
    const e = j.engine("worker-a");
    await e.runOnce();
    expect(j.journal.op(id).state).toBe("UNKNOWN");
    await e.runOnce();
    const op = j.journal.op(id);
    expect(op.state).toBe("RECOVERED");
    expect(j.server.sendCount.get(op.txHash as string)).toBe(1);
    expect(j.server.executions.get("execute_asset_recovery")).toBe(1);
  });

  it("an execution before the challenge window ends is refused by the contract: NOT_SUBMITTED, then a new attempt", async () => {
    await approvedAsset(j);
    j.chainNow.t = T0 + CHALLENGE - 60_000;
    const first = await j.enqueue();
    await j.engine("worker-a").runOnce();
    expect(j.journal.op(first)).toMatchObject({
      state: "NOT_SUBMITTED",
      lastReason: "CONTRACT_REFUSED:DELAY_NOT_ELAPSED",
    });
    expect((await j.ports.escrow.getUnexpectedAsset(0)).state).toBe("RECOVERY_CHALLENGE_PERIOD");
    j.chainNow.t = T0 + CHALLENGE;
    const second = await j.enqueue();
    expect(second).not.toBe(first);
    await j.engine("worker-a").runOnce();
    expect(j.journal.op(second).state).toBe("RECOVERED");
  });

  it("a refused ft_transfer is FAILED (authoritative no-transfer) and cannot be executed again", async () => {
    await approvedAsset(j);
    j.chainNow.t = T0 + CHALLENGE;
    j.w.token.failTransfers = 1;
    const relayer = j.w.sim.balance(RELAYER);
    const id = await j.enqueue();
    await j.engine("worker-a").runOnce();
    expect(j.journal.op(id)).toMatchObject({ state: "FAILED", lastReason: "ADAPTER_TRANSFER_REVERTED" });
    const a = await j.ports.escrow.getUnexpectedAsset(0);
    expect(a.state).toBe("ASSET_RECOVERY_REVIEW");
    expect(a.recoveries[0]?.state).toBe("FAILED");
    expect(j.w.token.balanceOf(CONTRACT)).toBe(5_000_000n);
    // The adapter deposit came back to the relayer.
    expect(j.w.sim.balance(RELAYER)).toBe(relayer);
    await expect(j.enqueue()).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("a pending callback is PROCESSING; a token balance that contradicts the contract is REVIEW", async () => {
    await approvedAsset(j);
    j.chainNow.t = T0 + CHALLENGE;
    j.server.faults.deferCallbacks = true;
    const id = await j.enqueue();
    const e = j.engine("worker-a");
    await e.runOnce();
    expect(j.journal.op(id).state).toBe("PROCESSING");
    expect((await j.ports.escrow.getUnexpectedAsset(0)).state).toBe("RECOVERY_SUBMITTED");
    // Unrelated tokens arrive before the callback settles, so the escrow balance did not drop by
    // the recovered amount: the journal refuses to call that RECOVERED.
    sendTokens(j.w, 4_000_000n);
    j.server.releaseCallbacks();
    await e.runOnce();
    expect(j.journal.op(id)).toMatchObject({
      state: "REVIEW",
      lastReason: "TOKEN_BALANCE_CONTRADICTS_CONTRACT",
    });
    // REVIEW is not due again and nothing in this module moves it.
    expect(j.journal.due(j.clock.now() + 3600_000)).toEqual([]);
    expect(() =>
      j.db.run("UPDATE asset_recovery_operations SET state = 'RECOVERED' WHERE operation_id = ?", id),
    ).toThrow(/illegal asset recovery transition/);
  });

  it("fences stale workers and keeps the transaction identity write-once", async () => {
    await approvedAsset(j);
    j.chainNow.t = T0 + CHALLENGE;
    const id = await j.enqueue();
    // A second live operation for the same asset cannot be queued.
    expect(() =>
      j.journal.enqueue({
        recoveryId: randomIds.next("arc"),
        assetIndex: 0,
        assetContract: TOKEN,
        recipient: SENDER,
        amount: 5_000_000n,
        call: j.ports.escrow.executeAssetRecoveryCall(0, randomIds.next("arc")),
        requestedBy: "prn_test",
      }),
    ).toThrow(/unresolved recovery execution/);
    const lease = j.journal.leases.acquireLease(`asset-op:${id}`, "worker-a", 1_000);
    expect(lease).not.toBeNull();
    expect(j.journal.leases.acquireLease(`asset-op:${id}`, "worker-b", 1_000)).toBeNull();
    j.clock.advance(2_000);
    const taken = j.journal.leases.acquireLease(`asset-op:${id}`, "worker-b", 1_000);
    expect(taken?.epoch).toBe(2);
    expect(() => j.journal.update(lease as never, j.journal.op(id), { reason: "stale" })).toThrow(
      /lease lost/,
    );
    await j.engine("worker-c").runOnce(); // lease held by worker-b: nothing happens
    expect(j.journal.op(id).state).toBe("QUEUED");
    j.clock.advance(2_000);
    await j.engine("worker-c").runOnce();
    const op = j.journal.op(id);
    expect(op.state).toBe("RECOVERED");
    expect(() =>
      j.db.run("UPDATE asset_recovery_operations SET tx_hash = 'x' WHERE operation_id = ?", id),
    ).toThrow(/write-once/);
    expect(() => j.db.run("DELETE FROM asset_recovery_operations WHERE operation_id = ?", id)).toThrow(
      /append-only/,
    );
  });
});
