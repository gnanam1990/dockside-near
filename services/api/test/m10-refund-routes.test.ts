/**
 * M10 refund request routes over `dockside-refund-v1` (T-008, T-009, T-010, T-050, T-051 at the
 * HTTP boundary; T-003 for the new routes).
 *
 * Real HTTP with PoP sessions and request proofs, the compiled escrow wasm on the simulated NEAR
 * host, the M05 journal worker and reconciler. The API prepares exact payloads from the contract
 * ledger, verifies the bound signer and relays; the contract recomputes the eligible slice, checks
 * the caller, clocks and signatures, and holds the value lock. Simulated: the chain, not testnet.
 */
import { fromTypedJson, generateEd25519KeyPair, loadConfig, signFor } from "@dockside/core";
import type { FunctionCall } from "@dockside/near";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, enrollHuman } from "../../../packages/authority/test/helpers.js";
import { BUYER_ACCT, HOUR, NEAR, panicCode, TREASURY } from "../../../packages/release/test/chain.js";
import { type ApiWorld, apiWorld, lockAndApprove, run } from "./m07-world.js";

const DENIALS = ["UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "KEY_NOT_BOUND"];
const NON_PARTIES = [
  "inspector",
  "auditor",
  "buyerAdmin",
  "supplierAdmin",
  "supplierClerk",
  "outsiderClerk",
  "outsiderAdmin",
  "otherInspector",
];

const actorOf = (a: ApiWorld, role: string) => a.actors[role] as Actor;
const path = (a: ApiWorld, suffix: string) => `/v1/trades/${a.w.c.t}${suffix}`;
const count = (a: ApiWorld, table: string) =>
  Number(a.w.c.w.h.db.get(`SELECT COUNT(*) AS n FROM ${table}`)?.["n"] ?? 0);
const refundOf = async (a: ApiWorld, id: string) =>
  (await a.w.c.escrow.getRefunds(a.w.c.t)).find((r) => r.refundIntentId === id);
const funderLedger = async (a: ApiWorld, funder: string) =>
  (await a.w.c.escrow.getLedger(a.w.c.t)).funders[funder];

describe("M10 refund routes: authority and funder returns", () => {
  let a: ApiWorld;
  beforeAll(async () => {
    a = await apiWorld();
    // The treasury sends 2 NEAR beyond the 10 NEAR trade amount: the contract quarantines it.
    a.w.c.ok(a.w.c.escrow.fundCall(a.w.c.t, 2n * NEAR), TREASURY);
  });
  afterAll(async () => {
    await a.close();
  });

  it("non-parties and unauthenticated callers cannot prepare, sign or execute; nothing is journaled", async () => {
    const fake = `rfd_${"a".repeat(32)}`;
    for (const role of NON_PARTIES) {
      const ch = await a.http(actorOf(a, role), "POST", path(a, "/refund-challenges"), {
        reason: "MUTUAL_CANCEL",
        funder: BUYER_ACCT,
      });
      expect(DENIALS, `${role} challenge: ${ch.text}`).toContain(ch.json.error.code);
      for (const suffix of ["/request-signature", "/cosignature"]) {
        const s = await a.http(actorOf(a, role), "POST", path(a, `/refunds/${fake}${suffix}`), {
          signature: "ed25519:1111",
        });
        expect(DENIALS, `${role} ${suffix}`).toContain(s.json.error.code);
      }
      for (const suffix of ["/execute", "/authorization", "/revocation-challenges"]) {
        const s = await a.http(actorOf(a, role), "POST", path(a, `/refunds/${fake}${suffix}`));
        expect(DENIALS, `${role} ${suffix}`).toContain(s.json.error.code);
      }
    }
    const anon = await a.http(null, "POST", path(a, "/refund-challenges"), {
      reason: "MUTUAL_CANCEL",
      funder: BUYER_ACCT,
    });
    expect(anon.json.error.code).toBe("UNAUTHENTICATED");
    expect((await a.http(actorOf(a, "outsiderClerk"), "GET", path(a, "/refund"))).json.error.code).toBe(
      "NOT_FOUND",
    );
    // A second buyer approver of the same organisation holds the capability but is not bound.
    const unbound = enrollHuman(a.w.c.w.h, actorOf(a, "buyerAdmin"), "BUYER_APPROVER");
    const ub = await a.http(unbound, "POST", path(a, "/refund-challenges"), {
      reason: "MUTUAL_CANCEL",
      funder: BUYER_ACCT,
    });
    expect(DENIALS, ub.text).toContain(ub.json.error.code);
    expect((await a.http(unbound, "GET", path(a, "/refund"))).json.viewerRole ?? null).toBeNull();
    expect(count(a, "refund_requests")).toBe(0);
    expect(count(a, "refund_signatures")).toBe(0);
  });

  it("refuses key-loss rows, unknown reasons and the wrong initiator before preparing anything", async () => {
    const buyer = actorOf(a, "buyer");
    const ask = (who: Actor, reason: string, funder = BUYER_ACCT) =>
      a.http(who, "POST", path(a, "/refund-challenges"), { reason, funder });
    for (const r of ["BUYER_KEY_LOSS", "SUPPLIER_KEY_LOSS", "INSPECTOR_KEY_LOSS"])
      expect((await ask(buyer, r)).json.error.code, r).toBe("NO_REFUND_SUBMIT");
    expect((await ask(buyer, "UNEXPECTED_ASSET_RECOVERY")).json.error.code).toBe("VALIDATION_FAILED");
    expect((await ask(buyer, "PERMANENT_HOLD")).json.error.code).toBe("FORBIDDEN");
    expect((await ask(actorOf(a, "risk"), "MUTUAL_CANCEL")).json.error.code).toBe("FORBIDDEN");
    expect((await ask(actorOf(a, "risk"), "EXCESS_FUNDING_RETURN", TREASURY)).json.error.code).toBe(
      "FORBIDDEN",
    );
    // The contract ledger decides what exists: the buyer funder has no excess.
    expect((await ask(buyer, "EXCESS_FUNDING_RETURN", BUYER_ACCT)).json.error.code).toBe("NOTHING_ELIGIBLE");
    expect((await ask(buyer, "PARTIAL_FUNDING_RETURN", BUYER_ACCT)).json.error.code).toBe("NOT_ELIGIBLE");
    expect((await ask(buyer, "TRADE_EXPIRY")).json.error.code).toBe("NOT_ELIGIBLE");
    expect((await ask(buyer, "INSPECTION_FAIL")).json.error.code).toBe("NOT_ELIGIBLE");
    expect(count(a, "refund_requests")).toBe(0);
  });

  it("projects every funder slice from the contract ledger and serves the signed reason matrix", async () => {
    const v = await a.http(actorOf(a, "supplier"), "GET", path(a, "/refund"));
    expect(v.status, v.text).toBe(200);
    expect(v.json.policy.id).toBe("dockside-refund-v1");
    expect(v.json.policy.rows.map((r: { reason: string }) => r.reason)).toHaveLength(9);
    expect(v.json.viewerRole).toBe("SUPPLIER");
    const pick = (funder: string, reason: string) =>
      v.json.candidates.find(
        (x: { funder: string; reason: string }) => x.funder === funder && x.reason === reason,
      );
    expect(pick(TREASURY, "EXCESS_FUNDING_RETURN")).toMatchObject({
      sourceBucket: "QUARANTINED",
      amountYocto: (2n * NEAR).toString(),
      blockedBy: null,
    });
    expect(pick(BUYER_ACCT, "MUTUAL_CANCEL")).toMatchObject({
      sourceBucket: "AVAILABLE",
      amountYocto: (6n * NEAR).toString(),
    });
    expect(pick(BUYER_ACCT, "EXCESS_FUNDING_RETURN").blockedBy).toBe("NOTHING_ELIGIBLE");
    // The inspector sees the projection but holds no refund role.
    expect((await a.http(actorOf(a, "inspector"), "GET", path(a, "/refund"))).json.viewerRole).toBeNull();
  });

  it("EXCESS_FUNDING_RETURN: a party prepares, only the funder's account submits, revocation restores QUARANTINED", async () => {
    const c = a.w.c;
    const buyer = actorOf(a, "buyer");
    const ch = await a.http(buyer, "POST", path(a, "/refund-challenges"), {
      reason: "EXCESS_FUNDING_RETURN",
      funder: TREASURY,
    });
    expect(ch.status, ch.text).toBe(201);
    expect(ch.json).toMatchObject({ initiatorRole: "FUNDER", sourceBucket: "QUARANTINED" });
    const id = ch.json.refundIntentId as string;
    const call = ch.json.funderWallet.call as FunctionCall;
    expect(ch.json.funderWallet.signerId).toBe(TREASURY);
    // A session cannot sign it in the funder's place, and a relayer cannot submit it.
    const asSession = await a.http(buyer, "POST", path(a, `/refunds/${id}/request-signature`), {
      signature: "ed25519:1111",
    });
    expect(asSession.json.error.code).toBe("FORBIDDEN");
    expect(panicCode(c.exec(call, "relayer.testnet"))).toBe("FORBIDDEN");
    expect(panicCode(c.exec(call, BUYER_ACCT))).toBe("FORBIDDEN");
    c.ok(call, TREASURY);
    expect(await refundOf(a, id)).toMatchObject({ state: "TIMELOCKED", sourceBucket: "QUARANTINED" });
    expect((await funderLedger(a, TREASURY))?.quarantined).toBe(0n);
    // The same slice cannot be locked twice.
    const again = await a.http(buyer, "POST", path(a, "/refund-challenges"), {
      reason: "EXCESS_FUNDING_RETURN",
      funder: TREASURY,
    });
    expect(["VALUE_LOCKED", "NOTHING_ELIGIBLE"]).toContain(again.json.error.code);
    // Revocation: the risk resolver has no role on a funder row; the funder's own call revokes.
    const riskRv = await a.http(actorOf(a, "risk"), "POST", path(a, `/refunds/${id}/revocation-challenges`));
    expect(riskRv.json.error.code).toBe("FORBIDDEN");
    const rv = await a.http(actorOf(a, "supplier"), "POST", path(a, `/refunds/${id}/revocation-challenges`));
    expect(rv.status, rv.text).toBe(201);
    expect(rv.json.revokerRole).toBe("FUNDER");
    const signedRv = await a.http(buyer, "POST", path(a, `/refunds/${id}/revocation`), {
      payload: rv.json.payload,
      signature: a.sign(buyer, "REFUND_REVOKE", rv.json.payload),
    });
    expect(signedRv.json.error.code).toBe("FORBIDDEN");
    expect(panicCode(c.exec(rv.json.funderWallet.call as FunctionCall, "relayer.testnet"))).toBe("FORBIDDEN");
    c.ok(rv.json.funderWallet.call as FunctionCall, TREASURY);
    expect((await refundOf(a, id))?.state).toBe("REVOKED");
    expect((await funderLedger(a, TREASURY))?.quarantined).toBe(2n * NEAR);
    expect((await c.escrow.getLedger(c.t)).conservation).toBe(true);
  });

  it("MUTUAL_CANCEL: the buyer signs, the supplier cosigns the identical digest, the timelock holds, the journal refunds", async () => {
    const c = a.w.c;
    const buyer = actorOf(a, "buyer");
    const supplier = actorOf(a, "supplier");
    const ch = await a.http(buyer, "POST", path(a, "/refund-challenges"), {
      reason: "MUTUAL_CANCEL",
      funder: BUYER_ACCT,
    });
    expect(ch.status, ch.text).toBe(201);
    expect(ch.json).toMatchObject({
      initiatorRole: "BUYER",
      sourceBucket: "AVAILABLE",
      amountYocto: (6n * NEAR).toString(),
    });
    const id = ch.json.refundIntentId as string;
    const sigPath = path(a, `/refunds/${id}/request-signature`);
    // A stranger key, the supplier as initiator, and a tampered payload are all refused.
    const stranger = generateEd25519KeyPair();
    const forged = await a.http(buyer, "POST", sigPath, {
      signature: signFor(stranger.privateKey, "REFUND_REQUEST", fromTypedJson(ch.json.payload)),
    });
    expect(forged.json.error.code).toBe("SIGNATURE_INVALID");
    expect(
      (
        await a.http(supplier, "POST", sigPath, {
          signature: a.sign(supplier, "REFUND_REQUEST", ch.json.payload),
        })
      ).json.error.code,
    ).toBe("FORBIDDEN");
    const signed = await a.http(buyer, "POST", sigPath, {
      signature: a.sign(buyer, "REFUND_REQUEST", ch.json.payload),
    });
    a.relay(signed);
    expect(await refundOf(a, id)).toMatchObject({
      state: "REQUESTED",
      buyerSigned: true,
      supplierSigned: false,
    });
    // The buyer cannot cosign its own request; the supplier reviews the exact journaled payload.
    expect((await a.http(buyer, "POST", path(a, `/refunds/${id}/cosign-challenges`))).json.error.code).toBe(
      "INVALID_STATE",
    );
    const co = await a.http(supplier, "POST", path(a, `/refunds/${id}/cosign-challenges`));
    expect(co.status, co.text).toBe(201);
    expect(co.json.digest).toBe((await refundOf(a, id))?.requestDigest);
    expect(co.json.payload).toEqual(ch.json.payload);
    const badCo = await a.http(supplier, "POST", path(a, `/refunds/${id}/cosignature`), {
      signature: a.sign(supplier, "REFUND_REVOKE", co.json.payload),
    });
    expect(["SIGNATURE_INVALID", "WRONG_DOMAIN"]).toContain(badCo.json.error.code);
    a.relay(
      await a.http(supplier, "POST", path(a, `/refunds/${id}/cosignature`), {
        signature: a.sign(supplier, "REFUND_REQUEST", co.json.payload),
      }),
    );
    const tl = await refundOf(a, id);
    expect(tl).toMatchObject({ state: "TIMELOCKED", buyerSigned: true, supplierSigned: true });
    expect((tl?.deadline ?? 0) - (tl?.clockOrigin ?? 0)).toBe(HOUR);
    // Authorization before the cooling period: the API relays, the contract refuses on its clock.
    const early = await a.http(supplier, "POST", path(a, `/refunds/${id}/authorization`));
    expect(a.relayExpectFail(early)).toContain("DELAY_NOT_ELAPSED");
    // Execution needs AUTHORIZED.
    expect((await a.http(buyer, "POST", path(a, `/refunds/${id}/execute`))).json.error.code).toBe(
      "INVALID_STATE",
    );
    c.advance(HOUR + 1);
    a.relay(await a.http(supplier, "POST", path(a, `/refunds/${id}/authorization`)));
    expect((await refundOf(a, id))?.state).toBe("AUTHORIZED");
    // Revocation after authorization is refused for this row.
    expect(
      (await a.http(buyer, "POST", path(a, `/refunds/${id}/revocation-challenges`))).json.error.code,
    ).toBe("INVALID_STATE");
    const ex = await a.http(actorOf(a, "risk"), "POST", path(a, `/refunds/${id}/execute`));
    expect(ex.status, ex.text).toBe(201);
    expect(ex.json.state).toBe("QUEUED");
    const again = await a.http(buyer, "POST", path(a, `/refunds/${id}/execute`));
    expect(again.json).toMatchObject({ operationId: ex.json.operationId, joined: true });
    await run(a.w);
    expect(a.w.journal.op(ex.json.operationId).state).toBe("REFUNDED");
    expect((await refundOf(a, id))?.state).toBe("REFUNDED");
    expect((await funderLedger(a, BUYER_ACCT))?.refunded).toBe(6n * NEAR);
    expect((await c.escrow.getLedger(c.t)).conservation).toBe(true);
    // Every step left an audit event bound to the trade.
    const tl2 = await a.http(buyer, "GET", path(a, "/timeline"));
    const events = tl2.json.events.map((e: { eventType: string }) => e.eventType);
    for (const e of [
      "REFUND_REQUEST_PREPARED",
      "REFUND_REQUEST_SIGNED",
      "REFUND_COSIGNED",
      "REFUND_AUTHORIZATION_RELAYED",
      "REFUND_EXECUTION_REQUESTED",
      "REFUND_REVOCATION_PREPARED",
    ])
      expect(events, e).toContain(e);
    // The journal keeps exactly what was verified: one request and one cosign signature.
    const kinds = a.w.c.w.h.db
      .all(
        "SELECT kind, signer_role FROM refund_signatures WHERE refund_intent_id = ? ORDER BY recorded_at, rowid",
        id,
      )
      .map((r) => `${r["kind"]}:${r["signer_role"]}`);
    expect(kinds).toEqual(["REQUEST:BUYER", "COSIGN:SUPPLIER"]);
    expect(() =>
      a.w.c.w.h.db.run("UPDATE refund_requests SET funder = 'x' WHERE refund_intent_id = ?", id),
    ).toThrow(/append-only/);
  });
  it("EXCESS_FUNDING_RETURN dispute: only buyer or risk may dispute; REVIEW blocks authorization and execution", async () => {
    const c = a.w.c;
    const buyer = actorOf(a, "buyer");
    const risk = actorOf(a, "risk");
    const ch = await a.http(buyer, "POST", path(a, "/refund-challenges"), {
      reason: "EXCESS_FUNDING_RETURN",
      funder: TREASURY,
    });
    expect(ch.status, ch.text).toBe(201);
    c.ok(ch.json.funderWallet.call as FunctionCall, TREASURY);
    const id = ch.json.refundIntentId as string;
    expect((await refundOf(a, id))?.state).toBe("TIMELOCKED");
    const dpath = path(a, `/refunds/${id}/dispute-challenges`);
    const body = { reasonCode: "AMOUNT_MISMATCH", evidenceDigest: "ab".repeat(32) };
    expect((await a.http(actorOf(a, "supplier"), "POST", dpath, body)).json.error.code).toBe("FORBIDDEN");
    expect((await a.http(risk, "POST", dpath, { ...body, evidenceDigest: "xyz" })).json.error.code).toBe(
      "VALIDATION_FAILED",
    );
    const dc = await a.http(risk, "POST", dpath, body);
    expect(dc.status, dc.text).toBe(201);
    expect(fromTypedJson(dc.json.payload)).toMatchObject({
      disputantRole: "RISK_RESOLVER",
      refundIntentId: id,
    });
    const sign = path(a, `/refunds/${id}/dispute`);
    // Another key over the same payload, or the risk payload under the buyer session, is refused.
    expect(
      (
        await a.http(risk, "POST", sign, {
          payload: dc.json.payload,
          signature: a.sign(buyer, "REFUND_DISPUTE", dc.json.payload),
        })
      ).json.error.code,
    ).toBe("SIGNATURE_INVALID");
    expect(
      (
        await a.http(buyer, "POST", sign, {
          payload: dc.json.payload,
          signature: a.sign(buyer, "REFUND_DISPUTE", dc.json.payload),
        })
      ).json.error.code,
    ).toBe("FORBIDDEN");
    a.relay(
      await a.http(risk, "POST", sign, {
        payload: dc.json.payload,
        signature: a.sign(risk, "REFUND_DISPUTE", dc.json.payload),
      }),
    );
    const rv = await refundOf(a, id);
    expect(rv).toMatchObject({ state: "REVIEW" });
    expect(rv?.dispute?.role).toBe("RISK_RESOLVER");
    expect((await a.http(buyer, "POST", dpath, body)).json.error.code).toBe("INVALID_STATE");
    expect((await a.http(buyer, "POST", path(a, `/refunds/${id}/authorization`))).json.error.code).toBe(
      "INVALID_STATE",
    );
    expect((await a.http(buyer, "POST", path(a, `/refunds/${id}/execute`))).json.error.code).toBe(
      "INVALID_STATE",
    );
    // The slice stays locked while disputed.
    expect((await funderLedger(a, TREASURY))?.refundLocked).toBe(2n * NEAR);
    const events = (await a.http(buyer, "GET", path(a, "/timeline"))).json.events.map(
      (e: { eventType: string }) => e.eventType,
    );
    expect(events).toContain("REFUND_DISPUTE_SIGNED");
    expect((await c.escrow.getLedger(c.t)).conservation).toBe(true);
  });
});

describe("M10 refund routes: buckets and the release lock", () => {
  let a: ApiWorld;
  beforeAll(async () => {
    a = await apiWorld({ funded: false });
  });
  afterAll(async () => {
    await a.close();
  });

  it("PARTIAL_FUNDING_RETURN locks the PARTIAL slice; the funder's revocation restores PARTIAL exactly", async () => {
    const c = a.w.c;
    c.ok(c.escrow.fundCall(c.t, 4n * NEAR), BUYER_ACCT);
    const supplier = actorOf(a, "supplier");
    const ch = await a.http(supplier, "POST", path(a, "/refund-challenges"), {
      reason: "PARTIAL_FUNDING_RETURN",
      funder: BUYER_ACCT,
    });
    expect(ch.status, ch.text).toBe(201);
    expect(ch.json).toMatchObject({ sourceBucket: "PARTIAL", amountYocto: (4n * NEAR).toString() });
    c.ok(ch.json.funderWallet.call as FunctionCall, BUYER_ACCT);
    const id = ch.json.refundIntentId as string;
    expect(await refundOf(a, id)).toMatchObject({ state: "TIMELOCKED", sourceBucket: "PARTIAL" });
    expect(await funderLedger(a, BUYER_ACCT)).toMatchObject({ partial: 0n, refundLocked: 4n * NEAR });
    const rv = await a.http(actorOf(a, "buyer"), "POST", path(a, `/refunds/${id}/revocation-challenges`));
    c.ok(rv.json.funderWallet.call as FunctionCall, BUYER_ACCT);
    expect(await funderLedger(a, BUYER_ACCT)).toMatchObject({ partial: 4n * NEAR, refundLocked: 0n });
  });

  it("a live release intent blocks party refunds (VALUE_LOCKED) but not the funder's quarantined excess", async () => {
    const c = a.w.c;
    c.ok(c.escrow.fundCall(c.t, 8n * NEAR), TREASURY);
    const { evidenceReady } = await import("../../../packages/release/test/chain.js");
    await evidenceReady(c);
    await lockAndApprove(a, "m10-refund-intent-1");
    const buyer = actorOf(a, "buyer");
    const mc = await a.http(buyer, "POST", path(a, "/refund-challenges"), {
      reason: "MUTUAL_CANCEL",
      funder: BUYER_ACCT,
    });
    expect(mc.json.error.code).toBe("VALUE_LOCKED");
    const ex = await a.http(buyer, "POST", path(a, "/refund-challenges"), {
      reason: "EXCESS_FUNDING_RETURN",
      funder: TREASURY,
    });
    expect(ex.status, ex.text).toBe(201);
    expect(ex.json).toMatchObject({ sourceBucket: "QUARANTINED", amountYocto: (2n * NEAR).toString() });
    const v = await a.http(buyer, "GET", path(a, "/refund"));
    const mcCand = v.json.candidates.find(
      (x: { funder: string; reason: string }) => x.funder === BUYER_ACCT && x.reason === "MUTUAL_CANCEL",
    );
    expect(mcCand.blockedBy).toBe("VALUE_LOCKED");
  });
});

describe("M10 destination-change delay configuration", () => {
  it("defaults to 24 hours and refuses less than one minute", () => {
    expect(loadConfig({}).DOCKSIDE_DESTINATION_CHANGE_DELAY_MS).toBe(24 * HOUR);
    expect(
      loadConfig({ DOCKSIDE_DESTINATION_CHANGE_DELAY_MS: "60000" }).DOCKSIDE_DESTINATION_CHANGE_DELAY_MS,
    ).toBe(60_000);
    expect(() => loadConfig({ DOCKSIDE_DESTINATION_CHANGE_DELAY_MS: "59999" })).toThrow(
      /invalid configuration/,
    );
  });
});
