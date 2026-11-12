/**
 * Storage an account with no role on a trade can make the escrow pay for (external security
 * audit, m33-contract-storage-bounds), against the COMPILED CONTRACT on the simulated NEAR host.
 * The simulator does not meter gas or storage staking, so these tests measure the persisted
 * bytes directly: every byte is storage stake taken from the balance that holds escrowed value.
 *
 * (a) direct calls of the NEP-141/171/245 receivers stop at the contract-wide record cap;
 * (b) a stranger's request/revoke loop on its own unexpected asset never writes the governing
 *     trade and stops at the per-asset attempt cap;
 * (c) repeated minimum `fund` calls stop at the per-trade deposit cap.
 */
import { newNonce, randomIds, tradeRevisionDigest } from "@dockside/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  assetRecoveryRequestPayload,
  assetRecoveryRevokePayload,
  signPayload,
  tradeBinding,
} from "../src/index.js";
import { HOUR, NEAR, T0, type World, world } from "./asset-world.js";
import { panicCode } from "./sim/near-sim.js";

const STRANGER = "stranger.testnet";
const MAX_UNEXPECTED_ASSETS = 16;
const MAX_RECOVERIES_PER_ASSET = 4;
const MAX_DEPOSITS_PER_TRADE = 64;
const MIN_DEPOSIT = 10n ** 21n;

function bytes(w: World): number {
  let n = 0;
  for (const [k, v] of w.sim.storage) n += k.length + v.length;
  return n;
}

function tradeBytes(w: World): number {
  // The trade record is the single largest value; the other entries do not change in (b).
  let max = 0;
  for (const v of w.sim.storage.values()) max = Math.max(max, v.length);
  return max;
}

/** A batch of maximal NEP-245 records sent directly by the stranger (no real token transfer). */
function mtBatch(w: World, i: number, size: number) {
  const ids = Array.from({ length: size }, (_, j) => `${i}-${j}-`.padEnd(256, "t"));
  return w.sim.call(
    "mt_on_transfer",
    {
      sender_id: STRANGER,
      previous_owner_ids: ids.map(() => STRANGER),
      token_ids: ids,
      amounts: ids.map(() => "340282366920938463463374607431768211455"),
      msg: "",
    },
    { predecessor: STRANGER },
  );
}

describe("m33 storage bounds (compiled wasm, simulated NEAR host)", () => {
  let w: World;
  beforeEach(() => {
    w = world();
    w.sim.credit(STRANGER, 1000n * NEAR);
  });

  it("(a) the token receivers stop persisting records at the contract-wide cap", async () => {
    const before = bytes(w);
    // One maximal 32-entry batch alone exceeds the cap and is refused whole.
    expect(panicCode(mtBatch(w, 0, 32))).toBe("CAPACITY_EXCEEDED");
    expect(bytes(w)).toBe(before);
    const first = mtBatch(w, 1, 8);
    expect(first.ok, first.error ?? "").toBe(true);
    const perBatch = bytes(w) - before;
    // A batch that does not fit is refused whole: the token standard returns the assets.
    expect(panicCode(mtBatch(w, 2, MAX_UNEXPECTED_ASSETS - 7))).toBe("CAPACITY_EXCEEDED");
    expect(bytes(w) - before).toBe(perBatch);
    // Single records fill the remaining capacity, then every receiver refuses.
    const ft = (n: number) =>
      w.sim.call(
        "ft_on_transfer",
        { sender_id: STRANGER, amount: "1", msg: `${n}` },
        { predecessor: STRANGER },
      );
    for (let n = 8; n < MAX_UNEXPECTED_ASSETS; n++) expect(ft(n).ok).toBe(true);
    expect(panicCode(ft(99))).toBe("CAPACITY_EXCEEDED");
    const nft = w.sim.call(
      "nft_on_transfer",
      { sender_id: STRANGER, previous_owner_id: STRANGER, token_id: "x", msg: "" },
      { predecessor: STRANGER },
    );
    expect(panicCode(nft)).toBe("CAPACITY_EXCEEDED");
    const config = w.sim.view("get_config") as { unexpectedAssets: number };
    expect(config.unexpectedAssets).toBe(MAX_UNEXPECTED_ASSETS);
    // Total growth stays bounded (well under 1 NEAR of stake at 1e19 yoctoNEAR per byte).
    expect(bytes(w) - before).toBeLessThan(100_000);
  });

  it("(b) a stranger's recovery loop never grows the governing trade", async () => {
    const r = w.sim.call(
      "ft_on_transfer",
      { sender_id: STRANGER, amount: "1", msg: "" },
      { predecessor: STRANGER },
    );
    expect(r.ok, r.error ?? "").toBe(true);
    const index = 0;
    const a = await w.escrow.getUnexpectedAsset(index);
    const trade = JSON.stringify(w.sim.view("get_trade", { trade_id: w.terms.tradeId }));
    const tradeSize = tradeBytes(w);
    const binding = tradeBinding(w.terms);
    const cycle = async () => {
      const p = assetRecoveryRequestPayload(binding, {
        recoveryId: randomIds.next("arc"),
        assetIndex: a.index,
        standard: a.standard,
        assetContract: a.assetContract,
        tokenId: a.tokenId,
        amount: a.observedAmount,
        claimedSender: a.claimedSender,
        evidenceDigest: "cd".repeat(32),
        issuedAt: T0,
        expiresAt: T0 + HOUR,
        nonce: newNonce(),
      });
      // The request is unsigned on chain; signPayload only produces the typed JSON form.
      const typed = signPayload(w.keys.buyer.privateKey, "ASSET_RECOVERY_REQUEST", p).payload;
      const req = w.exec(w.escrow.requestAssetRecoveryCall(index, w.terms.tradeId, typed), STRANGER);
      if (!req.ok) return req;
      const live = (await w.escrow.getUnexpectedAsset(index)).recoveries.at(-1);
      const rv = assetRecoveryRevokePayload(binding, {
        recoveryId: live?.recoveryId ?? "",
        requestDigest: live?.requestDigest ?? "",
        revokerRole: "CLAIMED_SENDER",
        issuedAt: T0,
        expiresAt: T0 + HOUR,
        nonce: newNonce(),
      });
      const rvTyped = signPayload(w.keys.buyer.privateKey, "ASSET_RECOVERY_REVOKE", rv).payload;
      return w.exec(w.escrow.revokeAssetRecoveryCall(index, w.terms.tradeId, rvTyped, null), STRANGER);
    };
    for (let i = 0; i < MAX_RECOVERIES_PER_ASSET; i++) {
      const c = await cycle();
      expect(c.ok, c.error ?? "").toBe(true);
    }
    expect(panicCode(await cycle())).toBe("CAPACITY_EXCEEDED");
    expect(JSON.stringify(w.sim.view("get_trade", { trade_id: w.terms.tradeId }))).toBe(trade);
    expect(tradeBytes(w)).toBe(tradeSize);
  });

  it("(c) repeated minimum deposits from a stranger stop at the per-trade cap", async () => {
    // world() funded the trade with one buyer deposit; the stranger's deposits are all excess.
    let accepted = 0;
    for (let i = 0; i < MAX_DEPOSITS_PER_TRADE + 20; i++) {
      const r = w.exec(
        w.escrow.fundCall(w.terms.tradeId, tradeRevisionDigest(w.terms), MIN_DEPOSIT),
        STRANGER,
      );
      if (!r.ok) {
        expect(panicCode(r)).toBe("CAPACITY_EXCEEDED");
        break;
      }
      accepted++;
    }
    expect(accepted).toBe(MAX_DEPOSITS_PER_TRADE - 1);
    const ledger = await w.escrow.getLedger(w.terms.tradeId);
    expect(ledger.deposits.length).toBe(MAX_DEPOSITS_PER_TRADE);
  });
});
