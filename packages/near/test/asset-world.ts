/**
 * M11 test world for unexpected-asset recovery: the compiled escrow wasm on the simulated NEAR
 * host, a simulated NEP-141 token (sim/sim-token.ts) registered as an external contract, one
 * registered and funded trade whose keys the test holds, and helpers that drive the real
 * ft_transfer_call, the claimed sender's request and the risk/policy approval.
 */
import {
  type Ed25519KeyPair,
  generateEd25519KeyPair,
  newNonce,
  randomIds,
  signFor,
  type TradeTerms,
  tradeTermsCanonical,
  tradeRevisionDigest,
  tradeTermsFromJson,
} from "@dockside/core";
import { expect } from "vitest";
import {
  assetRecoveryApprovalPayload,
  assetRecoveryRequestPayload,
  EscrowContract,
  type FunctionCall,
  NEP141_RECOVERY_CAPABILITY,
  type NearRpc,
  signPayload,
  termsArg,
  tradeBinding,
} from "../src/index.js";
import { type CallResult, NearSim } from "./sim/near-sim.js";
import { SimFungibleToken } from "./sim/sim-token.js";

export const CONTRACT = "dockside-escrow.testnet";
export const BUYER = "acme-buyer.testnet";
export const SUPPLIER = "harbor-supplier.testnet";
export const SENDER = "token-sender.testnet";
export const CLAIMANT = "other-claimant.testnet";
export const RELAYER = "relayer.testnet";
export const TOKEN = "sim-usd.testnet";
export const T0 = 1_800_000_000_000;
export const HOUR = 3_600_000;
export const NEAR = 10n ** 24n;

export type Role = "buyer" | "supplier" | "inspector" | "risk" | "attestor" | "policy";
export type Keys = Record<Role, Ed25519KeyPair>;

export function terms(keys: Keys): TradeTerms {
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

export class SimRpc implements NearRpc {
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

export interface World {
  sim: NearSim;
  token: SimFungibleToken;
  keys: Keys;
  terms: TradeTerms;
  escrow: EscrowContract;
  exec(call: FunctionCall, predecessor: string): CallResult;
}

export function world(): World {
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
  expect(exec(escrow.fundCall(t.tradeId, tradeRevisionDigest(t), 12n * NEAR), BUYER).ok).toBe(true);
  return { sim, token, keys, terms: t, escrow, exec };
}

/** The sender's wallet sends tokens to the escrow with ft_transfer_call (msg is untrusted). */
export function sendTokens(w: World, amount: bigint, msg = `{"trade_id":"${"x".repeat(8)}","credit":true}`) {
  const r = w.token.call(
    "ft_transfer_call",
    { receiver_id: CONTRACT, amount: amount.toString(), msg },
    { predecessor: SENDER, depositYocto: 1n, sim: w.sim },
  );
  expect(r.ok, r.error ?? "").toBe(true);
  return r;
}

export async function requestCall(w: World, index: number, now = T0) {
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

export async function approve(w: World, index: number, signer: Role = "risk", now = T0) {
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
