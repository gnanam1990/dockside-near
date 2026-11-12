/**
 * M11 unexpected-asset recovery routes (T-051, T-008 unexpected assets, T-003 for the new routes;
 * REAL-PRODUCT-GATE items 9 and 11 at the HTTP boundary).
 *
 * Real HTTP with PoP sessions and request proofs, the compiled escrow wasm on the simulated NEAR
 * host, a simulated NEP-141 token, the production JSON-RPC client for token views and transaction
 * lookups, and the asset-recovery journal engine. The sender's tokens arrive through a real
 * ft_transfer_call transaction; the sender's own account submits its request; the bound risk key
 * approves over a journaled read-only validation; the contract enforces the 72-hour challenge.
 * Simulated: the chain and the token, not testnet.
 */
import { randomIds, sha256, toHex } from "@dockside/core";
import { AssetRecoveryEngine, AssetRecoveryJournal } from "@dockside/journal";
import { EscrowContract, type FunctionCall, NearTxClient, Nep141Reader } from "@dockside/near";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../../packages/authority/test/helpers.js";
import { SimTxSigner } from "../../../packages/journal/test/sim-chain.js";
import { rpcFor } from "../../../packages/journal/test/world.js";
import { SimFungibleToken } from "../../../packages/near/test/sim/sim-token.js";
import {
  BUYER_ACCT,
  CONTRACT,
  HOUR,
  NEAR,
  panicCode,
  relogin,
} from "../../../packages/release/test/chain.js";
import { type ApiWorld, apiWorld } from "./m07-world.js";

const TOKEN = "sim-usd.testnet";
const SENDER = "token-sender.testnet";
const CLAIMANT = "other-claimant.testnet";
const CHALLENGE = 72 * HOUR;
const DENIALS = ["UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "KEY_NOT_BOUND"];

const actor = (a: ApiWorld, role: string) => a.actors[role] as Actor;
const tpath = (a: ApiWorld, suffix: string) => `/v1/trades/${a.w.c.t}${suffix}`;
const count = (a: ApiWorld, table: string) =>
  Number(a.w.c.w.h.db.get(`SELECT COUNT(*) AS n FROM ${table}`)?.["n"] ?? 0);
const digestOf = (s: string) => toHex(sha256(new TextEncoder().encode(s)));

describe("M11 unexpected-asset recovery routes", () => {
  let a: ApiWorld;
  let token: SimFungibleToken;
  let tx: NearTxClient;
  let engine: AssetRecoveryEngine;
  const transfers: string[] = [];

  /** The sender's wallet sends tokens with ft_transfer_call through the simulated chain. */
  async function send(amount: bigint, from = SENDER): Promise<string> {
    const signer = new SimTxSigner(from);
    const block = await tx.latestBlock();
    const nonce = (await tx.accessKeyNonce(from, signer.publicKey).catch(() => 0n)) + 1n;
    const call: FunctionCall = {
      receiverId: TOKEN,
      methodName: "ft_transfer_call",
      args: { receiver_id: CONTRACT, amount: amount.toString(), msg: "credit trade please" },
      gas: "100000000000000",
      depositYocto: "1",
    };
    const signed = await signer.sign(call, { nonce, blockHash: block.hash });
    const out = await tx.send(signed);
    expect(out.kind).toBe("FINAL_SUCCESS");
    transfers.push(signed.txHash);
    return signed.txHash;
  }

  const get = async (who = "buyer") => {
    const r = await a.http(actor(a, who), "GET", tpath(a, "/asset-recoveries"));
    expect(r.status, r.text).toBe(200);
    return r.json;
  };
  const prepare = (who: string, assetIndex: number, transferTxHash?: string) =>
    a.http(actor(a, who), "POST", tpath(a, "/asset-recovery-requests"), {
      assetIndex,
      ...(transferTxHash ? { transferTxHash } : {}),
    });
  const rec = (rid: string, suffix: string) => tpath(a, `/asset-recoveries/${rid}${suffix}`);
  /** Buyer prepares, the sender's own wallet submits, risk validates and approves. */
  async function approved(index: number, txHash?: string): Promise<string> {
    const p = await prepare("buyer", index, txHash);
    expect(p.status, p.text).toBe(201);
    a.w.c.ok(p.json.senderWallet.call, SENDER);
    const ch = await a.http(actor(a, "risk"), "POST", rec(p.json.recoveryId, "/approval-challenges"));
    expect(ch.status, ch.text).toBe(201);
    const ap = await a.http(actor(a, "risk"), "POST", rec(p.json.recoveryId, "/approval"), {
      payload: ch.json.payload,
      signature: a.sign(actor(a, "risk"), "ASSET_RECOVERY_APPROVAL", ch.json.payload),
    });
    a.relay(ap);
    return p.json.recoveryId as string;
  }

  beforeAll(async () => {
    a = await apiWorld();
    token = new SimFungibleToken(TOKEN);
    token.mint(SENDER, 50_000_000n);
    token.register(CONTRACT);
    a.w.c.sim.externals.set(TOKEN, token);
    for (const x of [SENDER, CLAIMANT]) a.w.c.sim.credit(x, 100n * NEAR);
    tx = new NearTxClient(rpcFor(a.w.url));
    const rpc = rpcFor(a.w.url);
    engine = new AssetRecoveryEngine(
      new AssetRecoveryJournal(a.w.c.w.h.db, a.w.c.w.h.clock, randomIds),
      {
        escrow: new EscrowContract(rpc, CONTRACT),
        tx: new NearTxClient(rpc),
        token: (c) => new Nep141Reader(rpc, c),
        txValidityBlocks: 20,
      },
      new SimTxSigner("relayer.testnet"),
      { holder: "api-test-worker", leaseTtlMs: 30_000, baseBackoffMs: 0, maxBackoffMs: 0 },
    );
    await send(5_000_000n); // 0: main recovery
    a.w.c.ok(
      {
        receiverId: CONTRACT,
        methodName: "nft_on_transfer",
        args: { sender_id: SENDER, previous_owner_id: SENDER, token_id: "bol-7", msg: "" },
        gas: "30000000000000",
        depositYocto: "0",
      },
      "nft.fakes.testnet",
    ); // 1: NFT, no adapter
    await send(2_000_000n); // 2: supplier challenge
    await send(1_000_000n); // 3: claimant challenge
    await send(700_000n); // 4: risk revocation
    await send(300_000n); // 5: sender revocation, then unsafe validation
  });
  afterAll(async () => {
    await a.close();
  });

  it("non-parties and unauthenticated callers can neither read nor act; nothing is journaled", async () => {
    const fake = `arc_${"a".repeat(32)}`;
    for (const role of ["outsiderClerk", "outsiderAdmin", "otherInspector"]) {
      const g = await a.http(actor(a, role), "GET", tpath(a, "/asset-recoveries"));
      expect(DENIALS, `${role} GET ${g.text}`).toContain(g.json?.error?.code);
    }
    // Organisation members who may read the trade see the records but hold no recovery role.
    for (const role of [
      "auditor",
      "buyerAdmin",
      "supplierAdmin",
      "supplierClerk",
      "outsiderClerk",
      "outsiderAdmin",
      "otherInspector",
    ]) {
      const g = await a.http(actor(a, role), "GET", tpath(a, "/asset-recoveries"));
      if (g.status === 200) expect(g.json.viewerRole, role).toBeNull();
      const p = await prepare(role, 0);
      expect(DENIALS, `${role} prepare`).toContain(p.json.error.code);
      for (const s of ["/approval-challenges", "/revocation-challenges", "/execute"]) {
        const x = await a.http(actor(a, role), "POST", rec(fake, s));
        expect(DENIALS, `${role} ${s}`).toContain(x.json.error.code);
      }
    }
    // The inspector relates to the trade and may read, but holds no recovery role.
    const iv = await get("inspector");
    expect(iv.viewerRole).toBeNull();
    expect((await prepare("inspector", 0)).json.error.code).toBe("FORBIDDEN");
    expect((await a.http(null, "GET", tpath(a, "/asset-recoveries"))).json.error.code).toBe(
      "UNAUTHENTICATED",
    );
    expect(count(a, "asset_recovery_requests")).toBe(0);
  });

  it("lists every unexpected asset from the contract, outside the native ledger and refund candidates", async () => {
    const v = await get("supplier");
    expect(v.viewerRole).toBe("SUPPLIER");
    expect(v.policy.row.reason).toBe("UNEXPECTED_ASSET_RECOVERY");
    expect(v.challengeWindowMs).toBe(CHALLENGE);
    expect(v.assets.map((x: { standard: string; state: string }) => [x.standard, x.state])).toEqual([
      ["NEP-141", "ASSET_RECOVERY_REVIEW"],
      ["NEP-171", "UNRECOVERABLE_OR_REVIEW"],
      ["NEP-141", "ASSET_RECOVERY_REVIEW"],
      ["NEP-141", "ASSET_RECOVERY_REVIEW"],
      ["NEP-141", "ASSET_RECOVERY_REVIEW"],
      ["NEP-141", "ASSET_RECOVERY_REVIEW"],
    ]);
    expect(v.assets[0]).toMatchObject({
      assetContract: TOKEN,
      claimedSender: SENDER,
      observedAmount: "5000000",
      originalFunder: null,
      withdrawable: false,
    });
    const refund = await a.http(actor(a, "supplier"), "GET", tpath(a, "/refund"));
    expect(Object.keys(refund.json.ledger.funders)).not.toContain(SENDER);
    expect(refund.json.candidates.some((c: { funder: string }) => c.funder === SENDER)).toBe(false);
  });

  it("prepares the sender's request with verified transfer evidence; only the sender's account submits it", async () => {
    expect((await prepare("risk", 0)).json.error.code).toBe("FORBIDDEN");
    expect((await prepare("buyer", 1)).json.error.code).toBe("ADAPTER_UNSAFE");
    expect((await prepare("buyer", 99)).json.error.code).toBe("NOT_FOUND");
    // A transaction that did not deliver this record is not evidence for it.
    expect((await prepare("buyer", 0, transfers[1])).json.error.code).toBe("VALIDATION_FAILED");
    const p = await prepare("buyer", 0, transfers[0]);
    expect(p.status, p.text).toBe(201);
    expect(p.json).toMatchObject({
      recipient: SENDER,
      amount: "5000000",
      evidence: { transferVerified: true, assetContract: TOKEN },
    });
    expect(p.json.senderWallet.signerId).toBe(SENDER);
    // The buyer's account (or a relayer) cannot submit it: proof of control is the sender's own transaction.
    expect(panicCode(a.w.c.exec(p.json.senderWallet.call, BUYER_ACCT))).toBe("FORBIDDEN");
    a.w.c.ok(p.json.senderWallet.call, SENDER);
    const v = await get();
    expect(v.assets[0].state).toBe("RECOVERY_REQUESTED");
    expect(v.assets[0].recoveries[0]).toMatchObject({
      governedHere: true,
      payloadJournaled: true,
      state: "REQUESTED",
    });
    // A second request while one is live is refused before anything is prepared.
    expect((await prepare("supplier", 0)).json.error.code).toBe("INVALID_STATE");
  });

  it("risk approves only over its own journaled SAFE validation; other keys and roles are refused", async () => {
    const rid = (await get()).assets[0].liveRecoveryId as string;
    expect((await a.http(actor(a, "buyer"), "POST", rec(rid, "/approval-challenges"))).json.error.code).toBe(
      "FORBIDDEN",
    );
    const ch = await a.http(actor(a, "risk"), "POST", rec(rid, "/approval-challenges"));
    expect(ch.status, ch.text).toBe(201);
    expect(ch.json.validation.report).toMatchObject({
      verdict: "SAFE",
      escrowTokenBalance: "9000000",
      outstandingObservedTotal: "9000000",
      checks: { recipientRegistered: true, adapterCompiled: true },
    });
    const risk = actor(a, "risk");
    // An approval over any digest other than the journaled SAFE validation is refused.
    const tampered = JSON.parse(JSON.stringify(ch.json.payload));
    tampered.struct.validationDigest = { str: "0".repeat(64) };
    const tamperedRes = await a.http(risk, "POST", rec(rid, "/approval"), {
      payload: tampered,
      signature: a.sign(risk, "ASSET_RECOVERY_APPROVAL", tampered),
    });
    expect(tamperedRes.json.error.code).toBe("VALIDATION_FAILED");
    const wrongKey = await a.http(risk, "POST", rec(rid, "/approval"), {
      payload: ch.json.payload,
      signature: a.sign(actor(a, "buyer"), "ASSET_RECOVERY_APPROVAL", ch.json.payload),
    });
    expect(wrongKey.json.error.code).toBe("SIGNATURE_INVALID");
    const wrongDomain = await a.http(risk, "POST", rec(rid, "/approval"), {
      payload: ch.json.payload,
      signature: a.sign(risk, "REFUND_AUTHORIZE", ch.json.payload),
    });
    expect(["SIGNATURE_INVALID", "WRONG_DOMAIN"]).toContain(wrongDomain.json.error.code);
    const ap = await a.http(risk, "POST", rec(rid, "/approval"), {
      payload: ch.json.payload,
      signature: a.sign(risk, "ASSET_RECOVERY_APPROVAL", ch.json.payload),
    });
    a.relay(ap);
    const v = await get();
    expect(v.assets[0].state).toBe("RECOVERY_CHALLENGE_PERIOD");
    expect(v.assets[0].recoveries[0].deadline - v.assets[0].recoveries[0].approvedAt).toBe(CHALLENGE);
    expect(v.assets[0].recoveries[0].validation.verdict).toBe("SAFE");
  });

  it("supplier challenge, claimant challenge, risk revocation and sender revocation all return assets to review", async () => {
    // Supplier, with its bound key.
    const r2 = await approved(2, transfers[1]);
    const sc = await a.http(actor(a, "supplier"), "POST", rec(r2, "/challenge-payloads"), {
      reasonCode: "OWNERSHIP_DISPUTED",
      evidenceDigest: digestOf("supplier statement"),
    });
    expect(sc.status, sc.text).toBe(201);
    const wrongRole = await a.http(actor(a, "buyer"), "POST", rec(r2, "/challenge"), {
      payload: sc.json.payload,
      signature: a.sign(actor(a, "buyer"), "ASSET_RECOVERY_CHALLENGE", sc.json.payload),
    });
    expect(wrongRole.json.error.code).toBe("FORBIDDEN");
    a.relay(
      await a.http(actor(a, "supplier"), "POST", rec(r2, "/challenge"), {
        payload: sc.json.payload,
        signature: a.sign(actor(a, "supplier"), "ASSET_RECOVERY_CHALLENGE", sc.json.payload),
      }),
    );
    // Another claimant, from its own account (prepared by the buyer, unsigned).
    const r3 = await approved(3);
    const cc = await a.http(actor(a, "buyer"), "POST", rec(r3, "/challenge-payloads"), {
      reasonCode: "ANOTHER_OWNER",
      evidenceDigest: digestOf("claimant statement"),
      claimantAccount: CLAIMANT,
    });
    expect(cc.json.claimantWallet.signerId).toBe(CLAIMANT);
    expect(panicCode(a.w.c.exec(cc.json.claimantWallet.call, BUYER_ACCT))).toBe("FORBIDDEN");
    a.w.c.ok(cc.json.claimantWallet.call, CLAIMANT);
    // The recipient itself cannot be the challenging claimant.
    const self = await a.http(actor(a, "buyer"), "POST", rec(r3, "/challenge-payloads"), {
      reasonCode: "X",
      evidenceDigest: digestOf("x"),
      claimantAccount: SENDER,
    });
    expect(["FORBIDDEN", "INVALID_STATE"]).toContain(self.json.error.code);
    // Risk revokes with its key.
    const r4 = await approved(4);
    const rv = await a.http(actor(a, "risk"), "POST", rec(r4, "/revocation-challenges"));
    expect(rv.json.revokerRole).toBe("RISK_RESOLVER");
    a.relay(
      await a.http(actor(a, "risk"), "POST", rec(r4, "/revocation"), {
        payload: rv.json.payload,
        signature: a.sign(actor(a, "risk"), "ASSET_RECOVERY_REVOKE", rv.json.payload),
      }),
    );
    // The sender revokes from its own account (prepared by the supplier).
    const p5 = await prepare("supplier", 5);
    a.w.c.ok(p5.json.senderWallet.call, SENDER);
    const sr = await a.http(actor(a, "supplier"), "POST", rec(p5.json.recoveryId, "/revocation-challenges"));
    expect(sr.json.revokerRole).toBe("CLAIMED_SENDER");
    expect(
      (
        await a.http(actor(a, "supplier"), "POST", rec(p5.json.recoveryId, "/revocation"), {
          payload: sr.json.payload,
          signature: "ed25519:1111",
        })
      ).json.error.code,
    ).toBe("FORBIDDEN");
    a.w.c.ok(sr.json.senderWallet.call, SENDER);
    const v = await get();
    const last = (i: number) => v.assets[i].recoveries.at(-1);
    expect([2, 3, 4, 5].map((i) => [v.assets[i].state, last(i).state])).toEqual([
      ["ASSET_RECOVERY_REVIEW", "CHALLENGED"],
      ["ASSET_RECOVERY_REVIEW", "CHALLENGED"],
      ["ASSET_RECOVERY_REVIEW", "REVOKED"],
      ["ASSET_RECOVERY_REVIEW", "REVOKED"],
    ]);
    expect(last(2).challenge).toMatchObject({ role: "SUPPLIER", reasonCode: "OWNERSHIP_DISPUTED" });
    expect(last(3).challenge).toMatchObject({ role: "CLAIMANT", account: CLAIMANT });
    // Execution of a challenged recovery is refused before anything is queued.
    expect((await a.http(actor(a, "buyer"), "POST", rec(r2, "/execute"))).json.error.code).toBe(
      "INVALID_STATE",
    );
  });

  it("an unregistered recipient fails read-only validation: UNSAFE is journaled and nothing is signable", async () => {
    const p = await prepare("buyer", 5);
    a.w.c.ok(p.json.senderWallet.call, SENDER);
    token.unregister(SENDER);
    const ch = await a.http(actor(a, "risk"), "POST", rec(p.json.recoveryId, "/approval-challenges"));
    expect(ch.json.error.code).toBe("ADAPTER_UNSAFE");
    const row = a.w.c.w.h.db.get(
      "SELECT verdict, report_json FROM asset_recovery_validations WHERE recovery_id = ?",
      p.json.recoveryId,
    );
    expect(row?.["verdict"]).toBe("UNSAFE");
    expect(JSON.parse(String(row?.["report_json"])).checks.recipientRegistered).toBe(false);
    token.register(SENDER);
  });

  it("executes through the journal: early is refused by the contract, after 72 hours the exact amount reaches the sender", async () => {
    const rid = (await get()).assets[0].liveRecoveryId as string;
    const early = await a.http(actor(a, "buyer"), "POST", rec(rid, "/execute"));
    expect(early.status, early.text).toBe(201);
    await engine.runOnce();
    let v = await get();
    expect(v.assets[0].recoveries[0].operations[0]).toMatchObject({
      state: "NOT_SUBMITTED",
      reason: "CONTRACT_REFUSED:DELAY_NOT_ELAPSED",
    });
    expect(v.assets[0].state).toBe("RECOVERY_CHALLENGE_PERIOD");
    // The contract clock passes the 72-hour window (sessions renew after their 8-hour TTL).
    a.w.c.advance(CHALLENGE + 60_000);
    for (const r of ["buyer", "supplier", "risk"]) relogin(actor(a, r));
    const ex = await a.http(actor(a, "supplier"), "POST", rec(rid, "/execute"));
    expect(ex.status, ex.text).toBe(201);
    expect(ex.json.operationId).not.toBe(early.json.operationId);
    const again = await a.http(actor(a, "buyer"), "POST", rec(rid, "/execute"));
    expect(again.json).toMatchObject({ operationId: ex.json.operationId, joined: true });
    await engine.runOnce();
    v = await get();
    expect(v.assets[0].state).toBe("RECOVERED");
    expect(v.assets[0].recoveries[0]).toMatchObject({ state: "RECOVERED", displayState: "RECOVERED" });
    expect(v.assets[0].recoveries[0].operations.at(-1)).toMatchObject({
      state: "RECOVERED",
      amount: "5000000",
      recipient: SENDER,
    });
    expect(token.balanceOf(SENDER)).toBe(50_000_000n - 9_000_000n + 5_000_000n);
    expect((await a.http(actor(a, "buyer"), "POST", rec(rid, "/execute"))).json.error.code).toBe(
      "INVALID_STATE",
    );
    const events = a.w.c.w.h.db
      .all("SELECT event_type FROM audit_events WHERE subject_type = 'asset_recovery'")
      .map((r) => String(r["event_type"]));
    for (const e of [
      "ASSET_RECOVERY_REQUEST_PREPARED",
      "ASSET_RECOVERY_VALIDATED",
      "ASSET_RECOVERY_APPROVAL_SIGNED",
      "ASSET_RECOVERY_CHALLENGE_SIGNED",
      "ASSET_RECOVERY_CLAIMANT_CHALLENGE_PREPARED",
      "ASSET_RECOVERY_REVOCATION_SIGNED",
      "ASSET_RECOVERY_SENDER_REVOCATION_PREPARED",
      "ASSET_RECOVERY_EXECUTION_REQUESTED",
    ])
      expect(events, e).toContain(e);
    expect(() => a.w.c.w.h.db.run("UPDATE asset_recovery_requests SET amount = '1'")).toThrow(/append-only/);
    expect(() => a.w.c.w.h.db.run("DELETE FROM asset_recovery_signatures")).toThrow(/append-only/);
  });
});
