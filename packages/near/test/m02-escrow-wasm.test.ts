/**
 * M02 against the COMPILED CONTRACT (dockside_escrow.wasm) under the simulated NEAR host
 * (test/sim/near-sim.ts — not nearcore, no gas/staking). Payloads are built and signed by the
 * TypeScript adapter (@dockside/near) with real Ed25519 keys, so this is also the TS -> contract
 * cross-language check. Owned: T-007 (lower layer), T-008, T-051 (wasm boundary half).
 */
import {
  type Ed25519KeyPair,
  generateEd25519KeyPair,
  newNonce,
  randomIds,
  signFor,
  type TradeTerms,
  tradeRevisionDigest,
  tradeTermsCanonical,
  tradeTermsFromJson,
} from "@dockside/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  EscrowContract,
  type FunctionCall,
  holdResolvePayload,
  holdSetPayload,
  type NearRpc,
  refundRequestPayload,
  signPayload,
  termsArg,
  tradeBinding,
} from "../src/index.js";
import { type CallResult, NearSim, panicCode } from "./sim/near-sim.js";

const CONTRACT = "dockside-escrow.testnet";
const BUYER = "acme-buyer.testnet";
const SUPPLIER = "harbor-supplier.testnet";
const OTHER = "treasury-acme.testnet";
const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;
const NEAR = 10n ** 24n;

type Keys = Record<"buyer" | "supplier" | "inspector" | "risk" | "attestor" | "policy", Ed25519KeyPair>;

export function makeTerms(keys: Keys, overrides: Record<string, unknown> = {}): TradeTerms {
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
  return tradeTermsFromJson({
    schemaVersion: 1,
    profileVersion: "dockside-direct-testnet-v1",
    tradeId,
    revision: 1,
    predecessorDigest: null,
    network: "near-testnet",
    escrowContractId: CONTRACT,
    buyer: {
      organizationId: buyerOrg,
      principalId: randomIds.next("prn"),
      keyVersionId: randomIds.next("key"),
      publicKey: keys.buyer.publicKey,
      accountId: BUYER,
    },
    supplier: {
      organizationId: randomIds.next("org"),
      principalId: randomIds.next("prn"),
      keyVersionId: randomIds.next("key"),
      publicKey: keys.supplier.publicKey,
      accountId: SUPPLIER,
    },
    asset: { kind: "NEAR_NATIVE", network: "near-testnet" },
    amountYocto: (10n * NEAR).toString(),
    milestone: { id: "shipment-1", description: "Container MSCU1234565 loaded" },
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
    ...overrides,
  });
}

export function newKeys(): Keys {
  return {
    buyer: generateEd25519KeyPair(),
    supplier: generateEd25519KeyPair(),
    inspector: generateEd25519KeyPair(),
    risk: generateEd25519KeyPair(),
    attestor: generateEd25519KeyPair(),
    policy: generateEd25519KeyPair(),
  };
}

/** NearRpc backed by the simulator, so EscrowContract view schemas are checked against real output. */
class SimRpc implements NearRpc {
  constructor(private readonly sim: NearSim) {}
  async callView(_c: string, method: string, args: Record<string, unknown>) {
    return { value: this.sim.view(method, args) as never, logs: [], blockHeight: 1, blockHash: "sim" };
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
  keys: Keys;
  terms: TradeTerms;
  escrow: EscrowContract;
  exec(call: FunctionCall, predecessor: string): CallResult;
}

function world(): World {
  const sim = new NearSim(CONTRACT, T0);
  for (const a of [BUYER, SUPPLIER, OTHER]) sim.credit(a, 1000n * NEAR);
  const init = sim.call(
    "new",
    { network: "near-testnet", min_deposit_yocto: null },
    { predecessor: CONTRACT },
  );
  expect(init.ok, init.error ?? "").toBe(true);
  const keys = newKeys();
  const terms = makeTerms(keys);
  const escrow = new EscrowContract(new SimRpc(sim), CONTRACT);
  const exec = (call: FunctionCall, predecessor: string) => {
    expect(call.receiverId).toBe(CONTRACT);
    const deposit = BigInt(call.depositYocto);
    sim.credit(predecessor, -deposit);
    const r = sim.call(call.methodName, call.args, { predecessor, depositYocto: deposit });
    if (!r.ok) sim.credit(predecessor, deposit); // runtime refunds the deposit of a failed receipt
    return r;
  };
  return { sim, keys, terms, escrow, exec };
}

function register(w: World): CallResult {
  const canonical = tradeTermsCanonical(w.terms);
  return w.exec(
    w.escrow.registerTradeCall(
      termsArg(w.terms),
      signFor(w.keys.buyer.privateKey, "TRADE_REVISION", canonical),
      signFor(w.keys.supplier.privateKey, "TRADE_REVISION", canonical),
    ),
    "relayer.testnet",
  );
}

describe("M02 escrow contract (compiled wasm, simulated NEAR host)", () => {
  let w: World;
  beforeEach(() => {
    w = world();
  });

  it("init refuses mainnet: the funded rail stays BLOCKED", () => {
    const sim = new NearSim("dockside-escrow.near", T0);
    const r = sim.call(
      "new",
      { network: "near-mainnet", min_deposit_yocto: null },
      { predecessor: "dockside-escrow.near" },
    );
    expect(panicCode(r)).toBe("FUNDED_RAIL_BLOCKED");
  });

  it("T-007: registers the TS-signed revision and accepts exact native funding from the recorded funder", async () => {
    const r = register(w);
    expect(r.ok, r.error ?? "").toBe(true);
    expect(r.value).toBe(tradeRevisionDigest(w.terms));
    // Re-registration and tampered terms fail.
    expect(panicCode(register(w))).toBe("INVALID_STATE");

    const fund = w.exec(w.escrow.fundCall(w.terms.tradeId, 10n * NEAR), BUYER);
    expect(fund.ok, fund.error ?? "").toBe(true);
    expect(fund.value).toEqual({
      index: 0,
      accepted: (10n * NEAR).toString(),
      quarantined: "0",
      fullyFunded: true,
    });
    expect(w.sim.balance(CONTRACT)).toBe(10n * NEAR);
    const trade = await w.escrow.getTrade(w.terms.tradeId);
    expect(trade.termsDigest).toBe(tradeRevisionDigest(w.terms));
    expect(trade.payoutDestination).toBe(SUPPLIER);
    expect(trade.ledger.fullyFunded).toBe(true);
    expect(trade.ledger.funders[BUYER]?.available).toBe(10n * NEAR);
    expect(trade.ledger.deposits[0]?.funder).toBe(BUYER);
    expect(trade.ledger.conservation).toBe(true);
  });

  it("T-007: tampered terms, wrong signer and a different contract are rejected by the wasm", () => {
    const canonical = tradeTermsCanonical(w.terms);
    const bs = signFor(w.keys.buyer.privateKey, "TRADE_REVISION", canonical);
    const ss = signFor(w.keys.supplier.privateKey, "TRADE_REVISION", canonical);
    const tampered = { ...termsArg(w.terms) } as { struct: Record<string, unknown> };
    tampered.struct = { ...tampered.struct, amountYocto: { u128: "1" } };
    expect(panicCode(w.exec(w.escrow.registerTradeCall(tampered as never, bs, ss), BUYER))).toBe(
      "SIGNATURE_INVALID",
    );
    expect(panicCode(w.exec(w.escrow.registerTradeCall(termsArg(w.terms), bs, bs), BUYER))).toBe(
      "SIGNATURE_INVALID",
    );
    const other = makeTerms(w.keys, { escrowContractId: "other-escrow.testnet" });
    const oc = tradeTermsCanonical(other);
    const r = w.exec(
      w.escrow.registerTradeCall(
        termsArg(other),
        signFor(w.keys.buyer.privateKey, "TRADE_REVISION", oc),
        signFor(w.keys.supplier.privateKey, "TRADE_REVISION", oc),
      ),
      BUYER,
    );
    expect(panicCode(r)).toBe("WRONG_CONTRACT");
  });

  it("T-008: partial funding is unavailable, excess is quarantined per funder, failed calls revert", async () => {
    expect(register(w).ok).toBe(true);
    expect(w.exec(w.escrow.fundCall(w.terms.tradeId, 6n * NEAR), BUYER).ok).toBe(true);
    let l = await w.escrow.getLedger(w.terms.tradeId);
    expect(l.fullyFunded).toBe(false);
    expect(l.totals.available).toBe(0n);
    expect(l.funders[BUYER]?.partial).toBe(6n * NEAR);
    const o = w.exec(w.escrow.fundCall(w.terms.tradeId, 7n * NEAR), OTHER);
    expect(o.value).toMatchObject({
      accepted: (4n * NEAR).toString(),
      quarantined: (3n * NEAR).toString(),
      fullyFunded: true,
    });
    l = await w.escrow.getLedger(w.terms.tradeId);
    expect(l.funders[OTHER]?.quarantined).toBe(3n * NEAR);
    expect(l.funders[BUYER]?.quarantined).toBe(0n);
    expect(l.totals.available).toBe(10n * NEAR);
    expect(l.totals.funded).toBe(13n * NEAR);
    // Dust below the storage minimum is refused and the deposit returns to the sender.
    const before = w.sim.balance(OTHER);
    expect(panicCode(w.exec(w.escrow.fundCall(w.terms.tradeId, 1n), OTHER))).toBe("INVALID_AMOUNT");
    expect(w.sim.balance(OTHER)).toBe(before);
    expect((await w.escrow.getLedger(w.terms.tradeId)).deposits).toHaveLength(2);
    // Unknown trade.
    expect(panicCode(w.exec(w.escrow.fundCall(randomIds.next("trd"), NEAR), OTHER))).toBe("NOT_FOUND");
    // Expired trade.
    w.sim.nowMs = w.terms.expiresAt;
    expect(panicCode(w.exec(w.escrow.fundCall(w.terms.tradeId, NEAR), OTHER))).toBe("EXPIRED");
    expect(w.sim.balance(CONTRACT)).toBe(13n * NEAR);
  });

  it("T-008: excess return executes a native transfer to the original funder only; FAILED restores QUARANTINED", async () => {
    expect(register(w).ok).toBe(true);
    w.exec(w.escrow.fundCall(w.terms.tradeId, 10n * NEAR), BUYER);
    w.exec(w.escrow.fundCall(w.terms.tradeId, 2n * NEAR), OTHER);
    const b = tradeBinding(w.terms);
    const mk = (id: string) =>
      refundRequestPayload(b, {
        refundIntentId: id,
        reason: "EXCESS_FUNDING_RETURN",
        funder: OTHER,
        amountYocto: 2n * NEAR,
        sourceBucket: "QUARANTINED",
        initiatorRole: "FUNDER",
        issuedAt: w.sim.nowMs,
        expiresAt: w.sim.nowMs + HOUR,
        nonce: newNonce(),
      });
    const id1 = randomIds.next("rfd");
    const p1 = signPayload(w.keys.buyer.privateKey, "REFUND_REQUEST", mk(id1)).payload;
    // The buyer cannot request the other funder's excess.
    expect(panicCode(w.exec(w.escrow.requestRefundCall(w.terms.tradeId, p1), BUYER))).toBe("FORBIDDEN");
    expect(w.exec(w.escrow.requestRefundCall(w.terms.tradeId, p1), OTHER).ok).toBe(true);
    expect(panicCode(w.exec(w.escrow.authorizeRefundCall(w.terms.tradeId, id1), BUYER))).toBe(
      "DELAY_NOT_ELAPSED",
    );
    w.sim.nowMs += HOUR;
    expect(w.exec(w.escrow.authorizeRefundCall(w.terms.tradeId, id1), "anyone.testnet").ok).toBe(true);
    // Recipient account does not exist: transfer fails, value stays with escrow, FAILED restores QUARANTINED.
    w.sim.missing.add(OTHER);
    const ex = w.exec(w.escrow.executeRefundCall(w.terms.tradeId, id1), "anyone.testnet");
    expect(ex.ok, ex.error ?? "").toBe(true);
    expect(ex.promises[0]).toMatchObject({
      receiver: OTHER,
      actions: [{ kind: "transfer", amountYocto: 2n * NEAR }],
    });
    const cb = w.sim.runPromises(ex);
    expect(cb[0]?.ok).toBe(true);
    expect(cb[0]?.value).toBe(false);
    let refunds = await w.escrow.getRefunds(w.terms.tradeId);
    expect(refunds[0]?.state).toBe("FAILED");
    expect((await w.escrow.getLedger(w.terms.tradeId)).funders[OTHER]?.quarantined).toBe(2n * NEAR);
    expect(w.sim.balance(CONTRACT)).toBe(12n * NEAR);
    // A new intent with fresh authority succeeds once the account exists.
    w.sim.missing.delete(OTHER);
    const id2 = randomIds.next("rfd");
    w.exec(
      w.escrow.requestRefundCall(
        w.terms.tradeId,
        signPayload(w.keys.buyer.privateKey, "REFUND_REQUEST", mk(id2)).payload,
      ),
      OTHER,
    );
    w.exec(w.escrow.authorizeRefundCall(w.terms.tradeId, id2), OTHER);
    const before = w.sim.balance(OTHER);
    const ex2 = w.exec(w.escrow.executeRefundCall(w.terms.tradeId, id2), OTHER);
    expect(w.sim.runPromises(ex2)[0]?.value).toBe(true);
    refunds = await w.escrow.getRefunds(w.terms.tradeId);
    expect(refunds.find((r) => r.refundIntentId === id2)?.state).toBe("REFUNDED");
    expect(w.sim.balance(OTHER) - before).toBe(2n * NEAR);
    expect(w.sim.balance(CONTRACT)).toBe(10n * NEAR);
    const l = await w.escrow.getLedger(w.terms.tradeId);
    expect(l.funders[OTHER]).toMatchObject({ refunded: 2n * NEAR, quarantined: 0n, available: 0n });
    expect(l.conservation).toBe(true);
    // Callback is private; a second execution is impossible.
    const forged = w.sim.call(
      "on_refund_transfer",
      { trade_id: w.terms.tradeId, refund_intent_id: id2 },
      { predecessor: OTHER, promiseResults: ["success"] },
    );
    expect(forged.ok).toBe(false);
    expect(panicCode(w.exec(w.escrow.executeRefundCall(w.terms.tradeId, id2), OTHER))).toBe("INVALID_STATE");
  });

  it("T-051: token and NFT transfers are recorded for review only and never touch native fields", async () => {
    expect(register(w).ok).toBe(true);
    w.exec(w.escrow.fundCall(w.terms.tradeId, 10n * NEAR), BUYER);
    const ledgerBefore = await w.escrow.getLedger(w.terms.tradeId);
    const ft = w.sim.call(
      "ft_on_transfer",
      { sender_id: BUYER, amount: "5000000", msg: `{"trade_id":"${w.terms.tradeId}","credit":true}` },
      { predecessor: "usdc.fakes.testnet" },
    );
    expect(ft.ok, ft.error ?? "").toBe(true);
    expect(ft.value).toBe("0");
    const nft = w.sim.call(
      "nft_on_transfer",
      { sender_id: OTHER, previous_owner_id: OTHER, token_id: "bill-of-lading-7", msg: "" },
      { predecessor: "nft.fakes.testnet" },
    );
    expect(nft.value).toBe(false);
    const mt = w.sim.call(
      "mt_on_transfer",
      {
        sender_id: OTHER,
        previous_owner_ids: [OTHER, OTHER],
        token_ids: ["a", "b"],
        amounts: ["1", "2"],
        msg: "",
      },
      { predecessor: "mt.fakes.testnet" },
    );
    expect(mt.value).toEqual(["0", "0"]);
    // Attaching NEAR to the token callback is refused (non-payable), so nothing native arrives here.
    const paid = w.sim.call(
      "ft_on_transfer",
      { sender_id: BUYER, amount: "1", msg: "" },
      { predecessor: "usdc.fakes.testnet", depositYocto: 1n },
    );
    expect(paid.ok).toBe(false);
    const assets = await w.escrow.getUnexpectedAssets();
    expect(assets.map((a) => a.standard)).toEqual(["NEP-141", "NEP-171", "NEP-245", "NEP-245"]);
    expect(assets[0]).toMatchObject({
      assetContract: "usdc.fakes.testnet",
      observedAmount: "5000000",
      claimedSender: BUYER,
      originalFunder: null,
      withdrawable: false,
      state: "ASSET_RECOVERY_REVIEW",
    });
    expect(await w.escrow.getLedger(w.terms.tradeId)).toEqual(ledgerBefore);
    expect(w.sim.balance(CONTRACT)).toBe(10n * NEAR);
    // Native refund entry points reject unexpected-asset recovery.
    const p = refundRequestPayload(tradeBinding(w.terms), {
      refundIntentId: randomIds.next("rfd"),
      reason: "EXCESS_FUNDING_RETURN",
      funder: BUYER,
      amountYocto: 5_000_000n,
      sourceBucket: "QUARANTINED",
      initiatorRole: "FUNDER",
      issuedAt: T0,
      expiresAt: T0 + HOUR,
      nonce: newNonce(),
    });
    const r = w.exec(
      w.escrow.requestRefundCall(
        w.terms.tradeId,
        signPayload(w.keys.buyer.privateKey, "REFUND_REQUEST", p).payload,
      ),
      BUYER,
    );
    expect(panicCode(r)).toBe("NOTHING_ELIGIBLE");
    const exported = WebAssembly.Module.exports(w.sim.module).map((e) => e.name);
    // No unilateral withdrawal or sweep exists. The only recovery entry points are the separate
    // UNEXPECTED_ASSET_RECOVERY protocol (M11: sender request, risk approval, 72-hour challenge).
    expect(exported.filter((n) => /withdraw|sweep/i.test(n))).toEqual([]);
    expect(exported.filter((n) => /recover/i.test(n)).sort()).toEqual([
      "approve_asset_recovery",
      "challenge_asset_recovery",
      "execute_asset_recovery",
      "on_asset_recovery_transfer",
      "request_asset_recovery",
      "revoke_asset_recovery",
    ]);
  });

  it("holds: policy setter SETs, only the risk resolver RESOLVEs, on the compiled contract", async () => {
    expect(register(w).ok).toBe(true);
    const b = tradeBinding(w.terms);
    const holdId = randomIds.next("hld");
    const set = holdSetPayload(b, {
      holdId,
      manifestDigest: null,
      reasonCode: "SANCTIONS_SCREEN_MATCH",
      issuerRole: "POLICY_SETTER",
      ruleId: "sanctions-screen@3",
      issuedAt: T0,
      expiresAt: T0 + HOUR,
      nonce: newNonce(),
    });
    const bySupplier = signPayload(w.keys.supplier.privateKey, "HOLD_SET", set);
    expect(
      panicCode(
        w.exec(w.escrow.setHoldCall(w.terms.tradeId, bySupplier.payload, bySupplier.signature), SUPPLIER),
      ),
    ).toBe("SIGNATURE_INVALID");
    const byPolicy = signPayload(w.keys.policy.privateKey, "HOLD_SET", set);
    const r = w.exec(
      w.escrow.setHoldCall(w.terms.tradeId, byPolicy.payload, byPolicy.signature),
      "policy-worker.testnet",
    );
    expect(r.ok, r.error ?? "").toBe(true);
    expect(r.value).toBe(byPolicy.digestHex);
    w.sim.nowMs += 2 * HOUR;
    let holds = await w.escrow.getHolds(w.terms.tradeId);
    expect(holds[0]?.status).toBe("EXPIRED_UNRESOLVED");
    expect((await w.escrow.getTrade(w.terms.tradeId)).blockingHolds).toBe(1);
    const res = holdResolvePayload(b, {
      holdId,
      holdReasonCode: "SANCTIONS_SCREEN_MATCH",
      manifestDigest: null,
      resolutionCode: "RELEASE_HOLD",
      evidenceDigest: "ef".repeat(32),
      issuedAt: w.sim.nowMs,
      expiresAt: w.sim.nowMs + HOUR,
      nonce: newNonce(),
    });
    const byPolicyResolve = signPayload(w.keys.policy.privateKey, "HOLD_RESOLVE", res);
    expect(
      panicCode(
        w.exec(
          w.escrow.resolveHoldCall(w.terms.tradeId, byPolicyResolve.payload, byPolicyResolve.signature),
          BUYER,
        ),
      ),
    ).toBe("SIGNATURE_INVALID");
    const byRisk = signPayload(w.keys.risk.privateKey, "HOLD_RESOLVE", res);
    expect(
      w.exec(w.escrow.resolveHoldCall(w.terms.tradeId, byRisk.payload, byRisk.signature), BUYER).ok,
    ).toBe(true);
    holds = await w.escrow.getHolds(w.terms.tradeId);
    expect(holds[0]?.status).toBe("RESOLVED");
    // Mutations carry no attached deposit.
    const paid = w.sim.call(
      "set_hold",
      { trade_id: w.terms.tradeId, payload: byPolicy.payload, signature: byPolicy.signature },
      { predecessor: BUYER, depositYocto: 1n },
    );
    expect(paid.ok).toBe(false);
  });
});
