/**
 * M11 against the COMPILED CONTRACT (dockside_escrow.wasm) under the simulated NEAR host, with a
 * simulated NEP-141 token contract (test/sim/sim-token.ts). The token transfer arrives through a
 * real `ft_transfer_call` -> `ft_on_transfer`, the claimed sender's own account requests recovery,
 * the risk/policy key signs the approval with the TypeScript payload builders, and the escrow's
 * NEP-141 adapter moves the exact observed amount back through `ft_transfer`. Owned: T-051
 * (recovery protocol, wasm boundary), REAL-PRODUCT-GATE item 9 (unexpected assets).
 */
import {
  type Ed25519KeyPair,
  generateEd25519KeyPair,
  newNonce,
  randomIds,
  signFor,
  type TradeTerms,
  tradeTermsCanonical,
  tradeTermsFromJson,
} from "@dockside/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ASSET_RECOVERY_CHALLENGE_MS,
  assetRecoveryApprovalPayload,
  assetRecoveryChallengePayload,
  assetRecoveryRequestPayload,
  assetRecoveryRevokePayload,
  EscrowContract,
  type FunctionCall,
  NEP141_RECOVERY_CAPABILITY,
  type NearRpc,
  signPayload,
  termsArg,
  tradeBinding,
} from "../src/index.js";
import { type CallResult, NearSim, panicCode } from "./sim/near-sim.js";
import { SimFungibleToken } from "./sim/sim-token.js";

const CONTRACT = "dockside-escrow.testnet";
const BUYER = "acme-buyer.testnet";
const SUPPLIER = "harbor-supplier.testnet";
const SENDER = "token-sender.testnet";
const CLAIMANT = "other-claimant.testnet";
const RELAYER = "relayer.testnet";
const TOKEN = "sim-usd.testnet";
const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;
const NEAR = 10n ** 24n;

type Role = "buyer" | "supplier" | "inspector" | "risk" | "attestor" | "policy";
type Keys = Record<Role, Ed25519KeyPair>;

function terms(keys: Keys): TradeTerms {
  const buyerOrg = randomIds.next("org");
  const tradeId = randomIds.next("trd");
  const svc = (pk: string, cap: string, serviceId: string, schema: string) => ({
    enrollmentId: randomIds.next("svc"),
    serviceId,
    keyVersion: 1,
    publicKey: pk,
    capability: cap,
    scope: {
      organizationId: buyerOrg,
      tradeId,
      evidencePolicyId: "commercial-docs",
      evidencePolicyRevision: 1,
    },
    attestationSchema: schema,
  });
  const party = (org: string, pk: string, accountId: string) => ({
    organizationId: org,
    principalId: randomIds.next("prn"),
    keyVersionId: randomIds.next("key"),
    publicKey: pk,
    accountId,
  });
  return tradeTermsFromJson({
    schemaVersion: 1,
    profileVersion: "dockside-direct-testnet-v1",
    tradeId,
    revision: 1,
    predecessorDigest: null,
    network: "near-testnet",
    escrowContractId: CONTRACT,
    buyer: party(buyerOrg, keys.buyer.publicKey, BUYER),
    supplier: party(randomIds.next("org"), keys.supplier.publicKey, SUPPLIER),
    asset: { kind: "NEAR_NATIVE", network: "near-testnet" },
    amountYocto: (10n * NEAR).toString(),
    milestone: { id: "shipment-1", description: "Container loaded" },
    evidencePolicy: { id: "commercial-docs", revision: 1, digest: "ab".repeat(32) },
    inspector: {
      principalId: randomIds.next("prn"),
      keyVersionId: randomIds.next("key"),
      publicKey: keys.inspector.publicKey,
      attestationSchema: "dockside/inspection-attestation@1",
    },
    manifestAttestor: svc(
      keys.attestor.publicKey,
      "MANIFEST_ATTEST",
      "manifest-attestor",
      "dockside/manifest-attestation@1",
    ),
    policySetter: svc(
      keys.policy.publicKey,
      "DETERMINISTIC_POLICY_SET",
      "deterministic-policy",
      "dockside/hold-set@1",
    ),
    riskResolver: {
      principalId: randomIds.next("prn"),
      keyVersionId: randomIds.next("key"),
      publicKey: keys.risk.publicKey,
    },
    payout: { network: "near-testnet", recipientType: "NEAR_ACCOUNT", destination: SUPPLIER },
    refundPolicy: { id: "dockside-refund-v1", revision: 1 },
    delayPolicy: { destinationChangeDelayMs: 86_400_000 },
    expiresAt: T0 + 30 * 24 * HOUR,
  });
}

class SimRpc implements NearRpc {
  constructor(private readonly sim: NearSim) {}
  async callView(c: string, method: string, args: Record<string, unknown>) {
    const ext = this.sim.externals.get(c);
    const value = ext ? ext.view(method, args) : this.sim.view(method, args);
    return { value: value as never, logs: [], blockHeight: 1, blockHash: "sim" };
  }
  viewAccount(): never {
    throw new Error("not simulated");
  }
  viewAccessKey(): never {
    throw new Error("not simulated");
  }
  txStatus(): never {
    throw new Error("not simulated");
  }
}

interface World {
  sim: NearSim;
  token: SimFungibleToken;
  keys: Keys;
  terms: TradeTerms;
  escrow: EscrowContract;
  exec(call: FunctionCall, predecessor: string): CallResult;
}

function world(): World {
  const sim = new NearSim(CONTRACT, T0);
  for (const a of [BUYER, SUPPLIER, SENDER, CLAIMANT, RELAYER]) sim.credit(a, 1000n * NEAR);
  expect(
    sim.call("new", { network: "near-testnet", min_deposit_yocto: null }, { predecessor: CONTRACT }).ok,
  ).toBe(true);
  const token = new SimFungibleToken(TOKEN);
  token.mint(SENDER, 9_000_000n);
  token.register(CONTRACT);
  sim.externals.set(TOKEN, token);
  const keys = Object.fromEntries(
    (["buyer", "supplier", "inspector", "risk", "attestor", "policy"] as const).map((r) => [
      r,
      generateEd25519KeyPair(),
    ]),
  ) as Keys;
  const t = terms(keys);
  const escrow = new EscrowContract(new SimRpc(sim), CONTRACT);
  const exec = (call: FunctionCall, predecessor: string) => {
    const deposit = BigInt(call.depositYocto);
    sim.credit(predecessor, -deposit);
    const r = sim.call(call.methodName, call.args, { predecessor, depositYocto: deposit });
    if (!r.ok) sim.credit(predecessor, deposit);
    return r;
  };
  const canonical = tradeTermsCanonical(t);
  const reg = exec(
    escrow.registerTradeCall(
      termsArg(t),
      signFor(keys.buyer.privateKey, "TRADE_REVISION", canonical),
      signFor(keys.supplier.privateKey, "TRADE_REVISION", canonical),
    ),
    RELAYER,
  );
  expect(reg.ok, reg.error ?? "").toBe(true);
  expect(exec(escrow.fundCall(t.tradeId, 12n * NEAR), BUYER).ok).toBe(true);
  return { sim, token, keys, terms: t, escrow, exec };
}

/** The sender's wallet sends tokens to the escrow with ft_transfer_call (msg is untrusted). */
function sendTokens(w: World, amount: bigint, msg = `{"trade_id":"${"x".repeat(8)}","credit":true}`) {
  const r = w.token.call(
    "ft_transfer_call",
    { receiver_id: CONTRACT, amount: amount.toString(), msg },
    { predecessor: SENDER, depositYocto: 1n, sim: w.sim },
  );
  expect(r.ok, r.error ?? "").toBe(true);
  return r;
}

async function requestCall(w: World, index: number, now = T0) {
  const a = await w.escrow.getUnexpectedAsset(index);
  const p = assetRecoveryRequestPayload(tradeBinding(w.terms), {
    recoveryId: randomIds.next("arc"),
    assetIndex: a.index,
    standard: a.standard,
    assetContract: a.assetContract,
    tokenId: a.tokenId,
    amount: a.observedAmount,
    claimedSender: a.claimedSender,
    evidenceDigest: "cd".repeat(32),
    issuedAt: now,
    expiresAt: now + 24 * HOUR,
    nonce: newNonce(),
  });
  return w.escrow.requestAssetRecoveryCall(
    index,
    w.terms.tradeId,
    signPayload(w.keys.buyer.privateKey, "ASSET_RECOVERY_REQUEST", p).payload,
  );
}

async function approve(w: World, index: number, signer: Role = "risk", now = T0) {
  const a = await w.escrow.getUnexpectedAsset(index);
  const r = a.recoveries.at(-1);
  if (!r) throw new Error("no recovery");
  const p = assetRecoveryApprovalPayload(tradeBinding(w.terms), {
    recoveryId: r.recoveryId,
    requestDigest: r.requestDigest,
    assetIndex: index,
    amount: r.amount,
    recipient: r.recipient,
    recoveryCapability: NEP141_RECOVERY_CAPABILITY,
    validationDigest: "ef".repeat(32),
    issuedAt: now,
    expiresAt: now + HOUR,
    nonce: newNonce(),
  });
  const s = signPayload(w.keys[signer].privateKey, "ASSET_RECOVERY_APPROVAL", p);
  return w.exec(w.escrow.approveAssetRecoveryCall(index, w.terms.tradeId, s.payload, s.signature), RELAYER);
}

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
