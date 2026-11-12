/**
 * M11 against the COMPILED CONTRACT (dockside_escrow.wasm) under the simulated NEAR host, with a
 * simulated NEP-141 token contract (test/sim/sim-token.ts). The token transfer arrives through a
 * real `ft_transfer_call` -> `ft_on_transfer`, the claimed sender's own account requests recovery,
 * the risk/policy key signs the approval with the TypeScript payload builders, and the escrow's
 * NEP-141 adapter moves the exact observed amount back through `ft_transfer`. Owned: T-051
 * (recovery protocol, wasm boundary), REAL-PRODUCT-GATE item 9 (unexpected assets).
 */
import { newNonce, randomIds } from "@dockside/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ASSET_RECOVERY_CHALLENGE_MS,
  assetRecoveryChallengePayload,
  assetRecoveryRevokePayload,
  NEP141_RECOVERY_CAPABILITY,
  signPayload,
  tradeBinding,
} from "../src/index.js";
import {
  approve,
  BUYER,
  CLAIMANT,
  CONTRACT,
  HOUR,
  RELAYER,
  requestCall,
  SENDER,
  sendTokens,
  T0,
  TOKEN,
  type World,
  world,
} from "./asset-world.js";
import { type CallResult, panicCode } from "./sim/near-sim.js";

describe("M11 unexpected-asset recovery (compiled wasm, simulated NEAR host and NEP-141 token)", () => {
  let w: World;
  beforeEach(() => {
    w = world();
  });

  it("ft_transfer_call is recorded with the token as asset contract and never credited", async () => {
    const ledger = await w.escrow.getLedger(w.terms.tradeId);
    const r = sendTokens(w, 5_000_000n);
    expect(r.raw).toBe(JSON.stringify("5000000"));
    expect(w.token.balanceOf(CONTRACT)).toBe(5_000_000n);
    const a = await w.escrow.getUnexpectedAsset(0);
    expect(a).toMatchObject({
      standard: "NEP-141",
      assetContract: TOKEN,
      observedAmount: "5000000",
      claimedSender: SENDER,
      state: "ASSET_RECOVERY_REVIEW",
      recoveryCapability: NEP141_RECOVERY_CAPABILITY,
      originalFunder: null,
      withdrawable: false,
      liveRecoveryId: null,
      recoveries: [],
    });
    expect(await w.escrow.getLedger(w.terms.tradeId)).toEqual(ledger);
  });

  it("sender request, risk approval, 72-hour challenge, then the exact amount reaches the sender", async () => {
    sendTokens(w, 5_000_000n);
    const nativeBefore = w.sim.balance(CONTRACT);
    const ledger = await w.escrow.getLedger(w.terms.tradeId);
    // Proof of control: the buyer's account cannot request recovery of the sender's tokens.
    expect(panicCode(w.exec(await requestCall(w, 0), BUYER))).toBe("FORBIDDEN");
    const req = w.exec(await requestCall(w, 0), SENDER);
    expect(req.ok, req.error ?? "").toBe(true);
    expect((await w.escrow.getUnexpectedAsset(0)).state).toBe("RECOVERY_REQUESTED");
    // Only the governing trade's bound risk/policy key approves.
    expect(panicCode(await approve(w, 0, "buyer"))).toBe("SIGNATURE_INVALID");
    const ap = await approve(w, 0);
    expect(ap.ok, ap.error ?? "").toBe(true);
    expect(ap.value).toBe(T0 + ASSET_RECOVERY_CHALLENGE_MS);
    let a = await w.escrow.getUnexpectedAsset(0);
    const rid = a.liveRecoveryId as string;
    expect(a.state).toBe("RECOVERY_CHALLENGE_PERIOD");
    // Before the window: refused. Without the adapter deposit: refused.
    w.sim.nowMs = T0 + ASSET_RECOVERY_CHALLENGE_MS - 1;
    expect(panicCode(w.exec(w.escrow.executeAssetRecoveryCall(0, rid), RELAYER))).toBe("DELAY_NOT_ELAPSED");
    w.sim.nowMs = T0 + ASSET_RECOVERY_CHALLENGE_MS;
    const noDeposit = { ...w.escrow.executeAssetRecoveryCall(0, rid), depositYocto: "0" };
    expect(panicCode(w.exec(noDeposit, RELAYER))).toBe("INVALID_AMOUNT");
    const ex = w.exec(w.escrow.executeAssetRecoveryCall(0, rid), RELAYER);
    expect(ex.ok, ex.error ?? "").toBe(true);
    expect(ex.promises.map((p) => [p.receiver, p.actions.map((x) => x.method ?? x.kind)])).toEqual([
      [TOKEN, ["ft_transfer"]],
      [CONTRACT, ["on_asset_recovery_transfer"]],
    ]);
    expect(JSON.parse(ex.promises[0]?.actions[0]?.args ?? "{}")).toMatchObject({
      receiver_id: SENDER,
      amount: "5000000",
    });
    expect((await w.escrow.getUnexpectedAsset(0)).state).toBe("RECOVERY_SUBMITTED");
    // While submitted the asset is locked: a second execution and a revocation are refused.
    expect(panicCode(w.exec(w.escrow.executeAssetRecoveryCall(0, rid), RELAYER))).toBe("INVALID_STATE");
    const cbs = w.sim.runPromises(ex);
    expect(cbs.every((c) => c.ok)).toBe(true);
    a = await w.escrow.getUnexpectedAsset(0);
    expect(a.state).toBe("RECOVERED");
    expect(a.recoveries[0]?.state).toBe("RECOVERED");
    expect(w.token.balanceOf(SENDER)).toBe(9_000_000n);
    expect(w.token.balanceOf(CONTRACT)).toBe(0n);
    // Native value: the escrow kept every yoctoNEAR of the trade; the adapter deposit was the relayer's.
    expect(w.sim.balance(CONTRACT)).toBe(nativeBefore);
    expect(await w.escrow.getLedger(w.terms.tradeId)).toEqual(ledger);
    expect(await w.escrow.getRefunds(w.terms.tradeId)).toEqual([]);
    // The private callback cannot be forged.
    const forged = w.sim.call(
      "on_asset_recovery_transfer",
      { asset_index: 0, recovery_id: rid },
      { predecessor: SENDER, promiseResults: ["success"] },
    );
    expect(forged.ok).toBe(false);
  });

  it("a refused ft_transfer is an authoritative failure: asset back to review, deposit back to the executor", async () => {
    sendTokens(w, 5_000_000n);
    expect(w.exec(await requestCall(w, 0), SENDER).ok).toBe(true);
    expect((await approve(w, 0)).ok).toBe(true);
    const rid = (await w.escrow.getUnexpectedAsset(0)).liveRecoveryId as string;
    w.sim.nowMs = T0 + ASSET_RECOVERY_CHALLENGE_MS;
    w.token.failTransfers = 1;
    const relayerBefore = w.sim.balance(RELAYER);
    const ex = w.exec(w.escrow.executeAssetRecoveryCall(0, rid), RELAYER);
    expect(ex.ok).toBe(true);
    const cbs = w.sim.runPromises(ex);
    expect(cbs[0]?.ok).toBe(true);
    expect(cbs[0]?.value).toBe(false);
    expect(cbs[0]?.promises.map((p) => [p.receiver, p.actions[0]?.kind, p.actions[0]?.amountYocto])).toEqual([
      [RELAYER, "transfer", 1n],
    ]);
    w.sim.runPromises(cbs[0] as CallResult);
    expect(w.sim.balance(RELAYER)).toBe(relayerBefore);
    const a = await w.escrow.getUnexpectedAsset(0);
    expect(a.state).toBe("ASSET_RECOVERY_REVIEW");
    expect(a.recoveries[0]?.state).toBe("FAILED");
    expect(w.token.balanceOf(CONTRACT)).toBe(5_000_000n);
    // No blind retry of the failed recovery.
    expect(panicCode(w.exec(w.escrow.executeAssetRecoveryCall(0, rid), RELAYER))).toBe("INVALID_STATE");
  });

  it("challenge by another claimant and revocation by the sender return the asset to review", async () => {
    sendTokens(w, 2_000_000n);
    sendTokens(w, 3_000_000n);
    for (const i of [0, 1]) expect(w.exec(await requestCall(w, i), SENDER).ok).toBe(true);
    expect((await approve(w, 0)).ok).toBe(true);
    const a0 = await w.escrow.getUnexpectedAsset(0);
    const r0 = a0.recoveries[0];
    if (!r0) throw new Error("missing");
    const c = assetRecoveryChallengePayload(tradeBinding(w.terms), {
      recoveryId: r0.recoveryId,
      requestDigest: r0.requestDigest,
      challengerRole: "CLAIMANT",
      challengerAccount: CLAIMANT,
      reasonCode: "OWNERSHIP_DISPUTED",
      evidenceDigest: "12".repeat(32),
      issuedAt: T0,
      expiresAt: T0 + HOUR,
      nonce: newNonce(),
    });
    const typed = signPayload(w.keys.buyer.privateKey, "ASSET_RECOVERY_CHALLENGE", c).payload;
    // The claimant must be the transaction signer.
    expect(
      panicCode(w.exec(w.escrow.challengeAssetRecoveryCall(0, w.terms.tradeId, typed, null), RELAYER)),
    ).toBe("FORBIDDEN");
    expect(w.exec(w.escrow.challengeAssetRecoveryCall(0, w.terms.tradeId, typed, null), CLAIMANT).ok).toBe(
      true,
    );
    const after = await w.escrow.getUnexpectedAsset(0);
    expect(after.state).toBe("ASSET_RECOVERY_REVIEW");
    expect(after.recoveries[0]).toMatchObject({
      state: "CHALLENGED",
      challenge: { role: "CLAIMANT", account: CLAIMANT },
    });
    const a1 = await w.escrow.getUnexpectedAsset(1);
    const r1 = a1.recoveries[0];
    if (!r1) throw new Error("missing");
    const rv = assetRecoveryRevokePayload(tradeBinding(w.terms), {
      recoveryId: r1.recoveryId,
      requestDigest: r1.requestDigest,
      revokerRole: "CLAIMED_SENDER",
      issuedAt: T0,
      expiresAt: T0 + HOUR,
      nonce: newNonce(),
    });
    const rvTyped = signPayload(w.keys.buyer.privateKey, "ASSET_RECOVERY_REVOKE", rv).payload;
    expect(
      panicCode(w.exec(w.escrow.revokeAssetRecoveryCall(1, w.terms.tradeId, rvTyped, null), BUYER)),
    ).toBe("FORBIDDEN");
    expect(w.exec(w.escrow.revokeAssetRecoveryCall(1, w.terms.tradeId, rvTyped, null), SENDER).ok).toBe(true);
    expect((await w.escrow.getUnexpectedAsset(1)).recoveries[0]?.state).toBe("REVOKED");
    expect(w.token.balanceOf(CONTRACT)).toBe(5_000_000n);
  });

  it("an NFT has no safe adapter: UNRECOVERABLE_OR_REVIEW and requests are refused", async () => {
    const nft = w.sim.call(
      "nft_on_transfer",
      { sender_id: SENDER, previous_owner_id: SENDER, token_id: "bol-7", msg: "" },
      { predecessor: "nft.fakes.testnet" },
    );
    expect(nft.value).toBe(false);
    const a = await w.escrow.getUnexpectedAsset(0);
    expect(a).toMatchObject({
      standard: "NEP-171",
      state: "UNRECOVERABLE_OR_REVIEW",
      recoveryCapability: null,
    });
    expect(panicCode(w.exec(await requestCall(w, 0), SENDER))).toBe("ADAPTER_UNSAFE");
    expect(panicCode(w.exec(w.escrow.executeAssetRecoveryCall(0, randomIds.next("arc")), RELAYER))).toBe(
      "NOT_FOUND",
    );
  });
});
