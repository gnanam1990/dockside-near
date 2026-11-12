/**
 * M28 (external security audit, finding 4): a recovery whose sender-chosen NEP-141 contract fails
 * its post-settlement `ft_balance_of` view must not stall the shared asset-recovery engine. The
 * failure is recorded on that operation with a reason and backoff, the operation stays open for
 * reconciliation (never asserted RECOVERED without the token read), and every other due
 * operation is still processed in the same pass. Runs the compiled escrow wasm on the simulated
 * NEAR host behind SimChainServer through the production JSON-RPC, escrow, tx and token clients.
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
  type World,
  world,
} from "../../near/test/asset-world.js";
import { SimFungibleToken } from "../../near/test/sim/sim-token.js";
import { AssetRecoveryEngine, AssetRecoveryJournal } from "../src/index.js";
import { SimChainServer, SimTxSigner } from "./sim-chain.js";

const CHALLENGE = 72 * 3600_000;
const VALIDITY = 20;
const HOSTILE = "hostile-usd.testnet";

/** A sender-deployed token whose balance view panics once the escrow holds none of it. */
class HostileToken extends SimFungibleToken {
  armed = true;
  override view(method: string, args: Record<string, unknown>): unknown {
    if (
      this.armed &&
      method === "ft_balance_of" &&
      args["account_id"] === CONTRACT &&
      this.balanceOf(CONTRACT) === 0n
    )
      throw new Error("wasm execution failed: Smart contract panicked: balance view unavailable");
    return super.view(method, args);
  }
}

describe("M28 asset recovery engine: a failing post-settlement token view does not poison the queue", () => {
  let w: World;
  let server: SimChainServer;
  let db: Database;
  let journal: AssetRecoveryJournal;
  let escrow: EscrowContract;
  let engine: AssetRecoveryEngine;
  let clock: ManualClock;
  let hostile: HostileToken;
  const chainNow = { t: T0 };

  beforeEach(async () => {
    w = world();
    chainNow.t = T0;
    hostile = new HostileToken(HOSTILE, "EVIL");
    hostile.mint(SENDER, 7_000_000n);
    hostile.register(CONTRACT);
    w.sim.externals.set(HOSTILE, hostile);
    server = new SimChainServer(w.sim, () => chainNow.t, { validityBlocks: VALIDITY });
    const url = await server.start();
    const rpc = new JsonRpcNearClient({
      endpoint: url,
      allowedHosts: ["127.0.0.1"],
      timeoutMs: 5_000,
      maxResponseBytes: 4 * 1024 * 1024,
    });
    db = Database.open(join(mkdtempSync(join(tmpdir(), "dockside-m28-")), "j.sqlite"));
    db.migrate();
    clock = new ManualClock(Date.now());
    journal = new AssetRecoveryJournal(db, clock, randomIds);
    escrow = new EscrowContract(rpc, CONTRACT);
    engine = new AssetRecoveryEngine(
      journal,
      {
        escrow,
        tx: new NearTxClient(rpc),
        token: (c) => new Nep141Reader(rpc, c),
        txValidityBlocks: VALIDITY,
      },
      new SimTxSigner(RELAYER),
      { holder: "worker-a", leaseTtlMs: 30_000, baseBackoffMs: 1_000, maxBackoffMs: 60_000 },
    );
  });
  afterEach(async () => {
    await server.stop();
    db.close();
  });

  async function enqueue(index: number): Promise<string> {
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
  }

  it("records the failure on the operation and still processes the operations due after it", async () => {
    // Asset 0: the hostile token. Asset 1: an ordinary token from an unrelated recovery.
    const r = hostile.call(
      "ft_transfer_call",
      { receiver_id: CONTRACT, amount: "5000000", msg: `{"trade_id":"${"x".repeat(8)}","credit":true}` },
      { predecessor: SENDER, depositYocto: 1n, sim: w.sim },
    );
    expect(r.ok, r.error ?? "").toBe(true);
    sendTokens(w, 3_000_000n);
    for (const i of [0, 1]) {
      expect(w.exec(await requestCall(w, i), SENDER).ok).toBe(true);
      expect((await approve(w, i)).ok).toBe(true);
    }
    expect((await escrow.getUnexpectedAsset(0)).assetContract).toBe(HOSTILE);
    chainNow.t = T0 + CHALLENGE;
    const poisoned = await enqueue(0);
    clock.advance(1);
    const other = await enqueue(1);
    expect(journal.due(clock.now())).toEqual([poisoned, other]);

    await expect(engine.runOnce()).resolves.toEqual(expect.arrayContaining([poisoned, other]));

    // The contract settled the hostile recovery, but without the independent token read the
    // journal does not call it RECOVERED: it is UNKNOWN with a reason and a backed-off next check.
    expect((await escrow.getUnexpectedAsset(0)).state).toBe("RECOVERED");
    const p = journal.op(poisoned);
    expect(p.state).toBe("UNKNOWN");
    expect(p.lastReason).toMatch(/^POST_SETTLEMENT_TOKEN_UNAVAILABLE:/);
    expect(p.nextCheckAt).toBeGreaterThan(clock.now());
    // The unrelated recovery after it in the due order was submitted and settled in the same pass.
    expect(journal.op(other)).toMatchObject({
      state: "RECOVERED",
      lastReason: "CONTRACT_RECOVERED_TOKEN_MOVED",
    });
    expect(w.token.balanceOf(SENDER)).toBe(9_000_000n);

    // Not due until its backoff passes; later passes keep running and leave it open.
    expect(journal.due(clock.now())).toEqual([]);
    clock.advance(p.nextCheckAt - clock.now());
    await expect(engine.runOnce()).resolves.toEqual([poisoned]);
    expect(journal.op(poisoned).state).toBe("UNKNOWN");
    expect(journal.op(poisoned).nextCheckAt).toBeGreaterThan(p.nextCheckAt);

    // Once the view answers, reconciliation finishes from the original transaction identity.
    hostile.armed = false;
    clock.advance(journal.op(poisoned).nextCheckAt - clock.now());
    await engine.runOnce();
    expect(journal.op(poisoned)).toMatchObject({
      state: "RECOVERED",
      lastReason: "CONTRACT_RECOVERED_TOKEN_MOVED",
      txHash: p.txHash,
    });
    expect(server.executions.get("execute_asset_recovery")).toBe(2);
  });
});
