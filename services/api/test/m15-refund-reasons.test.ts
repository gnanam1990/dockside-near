/**
 * M15: the refund reasons TRADE_EXPIRY, INSPECTION_FAIL and PERMANENT_HOLD driven above the
 * contract (T-009, T-050 rows), over real HTTP with PoP sessions and request proofs, to their
 * real outcomes: REFUNDED to the original funder through the M05 journal worker, a dispute or an
 * appeal that pauses in REVIEW, and revocations that restore the exact source bucket.
 *
 * The compiled escrow wasm runs on the simulated NEAR host; the API reads the contract's clock
 * (final block time) for every payload window and time predicate it prepares. The test clock
 * moves the chain and the API together here; the browser suite runs the chain ahead of the API.
 * Simulated: the chain, not testnet.
 */
import { fromTypedJson, toTypedJson } from "@dockside/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../../packages/authority/test/helpers.js";
import { commercialPolicy, DAY, fillAll } from "../../../packages/evidence/test/world.js";
import { BUYER_ACCT, HOUR, NEAR, TREASURY } from "../../../packages/release/test/chain.js";
import { type ApiWorld, apiWorld, riskHold, run } from "./m07-world.js";

const path = (a: ApiWorld, suffix: string) => `/v1/trades/${a.w.c.t}${suffix}`;
const who = (a: ApiWorld, role: string) => a.actors[role] as Actor;
const refundOf = async (a: ApiWorld, id: string) =>
  (await a.w.c.escrow.getRefunds(a.w.c.t)).find((r) => r.refundIntentId === id);
const funder = async (a: ApiWorld, f: string) => (await a.w.c.escrow.getLedger(a.w.c.t)).funders[f];
const conserved = async (a: ApiWorld) =>
  expect((await a.w.c.escrow.getLedger(a.w.c.t)).conservation).toBe(true);

/** Prepare a request as `by`, sign it as `by`, relay it; returns the refund intent id. */
async function request(a: ApiWorld, by: string, reason: string, f: string): Promise<string> {
  const ch = await a.http(who(a, by), "POST", path(a, "/refund-challenges"), { reason, funder: f });
  expect(ch.status, ch.text).toBe(201);
  const id = ch.json.refundIntentId as string;
  a.relay(
    await a.http(who(a, by), "POST", path(a, `/refunds/${id}/request-signature`), {
      signature: a.sign(who(a, by), "REFUND_REQUEST", ch.json.payload),
    }),
  );
  return id;
}

async function signed(
  a: ApiWorld,
  by: string,
  id: string,
  step: "revocation" | "dispute" | "authorization",
  body: Record<string, string> = {},
) {
  const purpose = {
    revocation: "REFUND_REVOKE",
    dispute: "REFUND_DISPUTE",
    authorization: "REFUND_AUTHORIZE",
  }[step] as "REFUND_REVOKE";
  const ch = await a.http(who(a, by), "POST", path(a, `/refunds/${id}/${step}-challenges`), body);
  expect(ch.status, ch.text).toBe(201);
  const target = step === "authorization" ? "authorization-signature" : step;
  return a.http(who(a, by), "POST", path(a, `/refunds/${id}/${target}`), {
    payload: ch.json.payload,
    signature: a.sign(who(a, by), purpose, ch.json.payload),
  });
}

/** Queue the AUTHORIZED refund; the journal worker returns the slice to its original funder once. */
async function executeOnce(a: ApiWorld, id: string, f: string, amount: bigint): Promise<void> {
  const before = a.w.c.sim.balance(f);
  const ex = await a.http(who(a, "supplier"), "POST", path(a, `/refunds/${id}/execute`));
  expect(ex.status, ex.text).toBe(201);
  await run(a.w);
  const op = a.w.journal.op(ex.json.operationId);
  expect(op.state).toBe("REFUNDED");
  expect(op.submitCount).toBe(1);
  expect(a.w.server.executions.get("execute_refund") ?? 0).toBeGreaterThanOrEqual(1);
  expect((await refundOf(a, id))?.state).toBe("REFUNDED");
  expect(a.w.c.sim.balance(f) - before).toBe(amount);
  expect((await funder(a, f))?.refunded).toBe(amount);
  await conserved(a);
}

/** Supplier uploads, the isolated attestor attests, the inspector decides over HTTP and relays. */
async function inspectOverHttp(a: ApiWorld, decision: "FAIL" | "REVIEW"): Promise<number> {
  const c = a.w.c;
  await fillAll(c.w);
  const att = await c.w.evidence.attest(c.t, c.w.attestor);
  c.ok(c.escrow.submitManifestAttestationCall(c.t, att.typed, att.signature));
  const inspector = who(a, "inspector");
  const ch = await a.http(inspector, "POST", path(a, "/inspection-challenges"), {
    decision,
    reasonCodes: ["DOCS_MISMATCH"],
  });
  expect(ch.status, ch.text).toBe(201);
  a.relay(
    await a.http(inspector, "POST", path(a, "/inspections"), {
      payload: ch.json.payload,
      signature: a.sign(inspector, "INSPECTION_ATTESTATION", ch.json.payload),
    }),
  );
  const ev = await c.escrow.getEvidence(c.t);
  expect(ev.currentInspectionDecision).toBe(decision);
  return ev.inspection?.recordedAt as number;
}

async function resolveHold(a: ApiWorld, holdId: string, code: string): Promise<void> {
  const risk = who(a, "risk");
  const ch = await a.http(risk, "POST", `/v1/holds/${holdId}/resolution-challenges`, {
    resolutionCode: code,
    evidenceDigest: "ef".repeat(32),
  });
  expect(ch.status, ch.text).toBe(201);
  a.relay(
    await a.http(risk, "POST", `/v1/holds/${holdId}/resolution`, {
      payload: ch.json.payload,
      signature: a.sign(risk, "HOLD_RESOLVE", ch.json.payload),
    }),
  );
}

describe("M15 TRADE_EXPIRY above the contract", () => {
  let a: ApiWorld;
  beforeAll(async () => {
    a = await apiWorld();
  });
  afterAll(async () => {
    await a.close();
  });

  it("is refused before the signed expiry, then refunds the buyer's slice after the 24-hour challenge", async () => {
    const c = a.w.c;
    const early = await a.http(who(a, "buyer"), "POST", path(a, "/refund-challenges"), {
      reason: "TRADE_EXPIRY",
      funder: BUYER_ACCT,
    });
    expect(early.json.error.code).toBe("NOT_ELIGIBLE");
    c.advance(c.w.terms.expiresAt - c.w.h.clock.now() + 1);
    const v = await a.http(who(a, "buyer"), "GET", path(a, "/refund"));
    const cand = v.json.candidates.find(
      (x: { funder: string; reason: string }) => x.funder === BUYER_ACCT && x.reason === "TRADE_EXPIRY",
    );
    expect(cand).toMatchObject({
      sourceBucket: "AVAILABLE",
      amountYocto: (6n * NEAR).toString(),
      blockedBy: null,
    });

    // Only the designated initiator signs; the payload window is the contract's clock.
    const ch = await a.http(who(a, "buyer"), "POST", path(a, "/refund-challenges"), {
      reason: "TRADE_EXPIRY",
      funder: BUYER_ACCT,
    });
    expect(ch.status, ch.text).toBe(201);
    expect(ch.json.initiatorRole).toBe("BUYER");
    const p = fromTypedJson(ch.json.payload) as Record<string, unknown>;
    expect(p["issuedAt"]).toBe(c.w.h.clock.now());
    const id = ch.json.refundIntentId as string;
    const asSupplier = await a.http(who(a, "supplier"), "POST", path(a, `/refunds/${id}/request-signature`), {
      signature: a.sign(who(a, "supplier"), "REFUND_REQUEST", ch.json.payload),
    });
    expect(asSupplier.json.error.code).toBe("FORBIDDEN");
    a.relay(
      await a.http(who(a, "buyer"), "POST", path(a, `/refunds/${id}/request-signature`), {
        signature: a.sign(who(a, "buyer"), "REFUND_REQUEST", ch.json.payload),
      }),
    );
    const tl = await refundOf(a, id);
    expect(tl).toMatchObject({ state: "TIMELOCKED", sourceBucket: "AVAILABLE", initiatorRole: "BUYER" });
    expect(tl?.clockOrigin).toBe(c.w.terms.expiresAt);
    expect(tl?.deadline).toBe(c.w.terms.expiresAt + 24 * HOUR);
    expect(await funder(a, BUYER_ACCT)).toMatchObject({ available: 0n, refundLocked: 6n * NEAR });

    // The supplier's request on the treasury slice: only the supplier may revoke it, which restores AVAILABLE.
    const tid = await request(a, "supplier", "TRADE_EXPIRY", TREASURY);
    expect((await refundOf(a, tid))?.initiatorRole).toBe("SUPPLIER");
    expect(
      (await a.http(who(a, "buyer"), "POST", path(a, `/refunds/${tid}/revocation-challenges`))).json.error
        .code,
    ).toBe("FORBIDDEN");
    a.relay(await signed(a, "supplier", tid, "revocation"));
    expect((await refundOf(a, tid))?.state).toBe("REVOKED");
    expect(await funder(a, TREASURY)).toMatchObject({ available: 4n * NEAR, refundLocked: 0n });

    // A new request on the same slice; the buyer disputes before the deadline: REVIEW keeps it locked.
    const tid2 = await request(a, "supplier", "TRADE_EXPIRY", TREASURY);
    a.relay(
      await signed(a, "buyer", tid2, "dispute", {
        reasonCode: "GOODS_SHIPPED",
        evidenceDigest: "aa".repeat(32),
      }),
    );
    expect((await refundOf(a, tid2))?.state).toBe("REVIEW");
    expect(
      (await a.http(who(a, "buyer"), "POST", path(a, `/refunds/${tid2}/authorization`))).json.error.code,
    ).toBe("INVALID_STATE");

    // The contract refuses authorization before the challenge closes, on its own clock.
    expect(
      a.relayExpectFail(await a.http(who(a, "supplier"), "POST", path(a, `/refunds/${id}/authorization`))),
    ).toContain("DELAY_NOT_ELAPSED");
    c.advance(24 * HOUR);
    a.relay(await a.http(who(a, "supplier"), "POST", path(a, `/refunds/${id}/authorization`)));
    expect((await refundOf(a, id))?.state).toBe("AUTHORIZED");
    expect(
      (await a.http(who(a, "buyer"), "POST", path(a, `/refunds/${id}/revocation-challenges`))).json.error
        .code,
    ).toBe("INVALID_STATE");
    await executeOnce(a, id, BUYER_ACCT, 6n * NEAR);
    // The disputed treasury slice stays locked in REVIEW; nothing else moved.
    expect(await funder(a, TREASURY)).toMatchObject({ refundLocked: 4n * NEAR, refunded: 0n });
    expect((await refundOf(a, tid2))?.state).toBe("REVIEW");
  });
});

describe("M15 INSPECTION_FAIL above the contract", () => {
  let a: ApiWorld;
  beforeAll(async () => {
    a = await apiWorld({ evidence: false, policy: commercialPolicy({ attestationLifetimeMs: 4 * DAY }) });
  });
  afterAll(async () => {
    await a.close();
  });

  it("appeal pauses in REVIEW and risk revokes; the other slice is authorized by risk after the window and refunded", async () => {
    const c = a.w.c;
    const recordedAt = await inspectOverHttp(a, "FAIL");
    // The deterministic policy service SETs its inspection-fail hold (isolated signer).
    for (const h of await c.w.holds.applyDeterministicPolicy(c.t, c.w.policySigner))
      c.ok(c.escrow.setHoldCall(c.t, toTypedJson(h.setPayload), h.setSignature));
    const hold = (await c.escrow.getHolds(c.t))[0];
    expect(hold?.status).toBe("ACTIVE");

    const id = await request(a, "buyer", "INSPECTION_FAIL", BUYER_ACCT);
    const tl = await refundOf(a, id);
    expect(tl).toMatchObject({ state: "TIMELOCKED", initiatorRole: "BUYER", sourceBucket: "AVAILABLE" });
    expect(tl?.clockOrigin).toBe(recordedAt);
    expect(tl?.deadline).toBe(recordedAt + 48 * HOUR);

    // Treasury slice: the buyer cannot appeal, the supplier appeals, REVIEW; risk revokes, AVAILABLE again.
    const tid = await request(a, "buyer", "INSPECTION_FAIL", TREASURY);
    const body = { reasonCode: "REINSPECT", evidenceDigest: "bb".repeat(32) };
    expect(
      (await a.http(who(a, "buyer"), "POST", path(a, `/refunds/${tid}/dispute-challenges`), body)).json.error
        .code,
    ).toBe("FORBIDDEN");
    a.relay(await signed(a, "supplier", tid, "dispute", body));
    expect((await refundOf(a, tid))?.state).toBe("REVIEW");
    expect(
      (await a.http(who(a, "supplier"), "POST", path(a, `/refunds/${tid}/revocation-challenges`))).json.error
        .code,
    ).toBe("FORBIDDEN");
    a.relay(await signed(a, "risk", tid, "revocation"));
    expect((await refundOf(a, tid))?.state).toBe("REVOKED");
    expect(await funder(a, TREASURY)).toMatchObject({ available: 4n * NEAR, refundLocked: 0n });

    // No permissionless authorization for this row; risk's signed authorization waits for the window.
    expect(
      (await a.http(who(a, "buyer"), "POST", path(a, `/refunds/${id}/authorization`))).json.error.code,
    ).toBe("FORBIDDEN");
    expect(
      (await a.http(who(a, "supplier"), "POST", path(a, `/refunds/${id}/authorization-challenges`))).json
        .error.code,
    ).toBe("FORBIDDEN");
    expect(a.relayExpectFail(await signed(a, "risk", id, "authorization"))).toContain("DELAY_NOT_ELAPSED");
    c.advance(48 * HOUR + 1);
    // The policy hold still blocks; risk resolves it to refund, then authorizes.
    expect(a.relayExpectFail(await signed(a, "risk", id, "authorization"))).toContain("HOLD_ACTIVE");
    await resolveHold(a, hold?.holdId as string, "RESOLVE_TO_REFUND");
    a.relay(await signed(a, "risk", id, "authorization"));
    expect((await refundOf(a, id))?.state).toBe("AUTHORIZED");
    await executeOnce(a, id, BUYER_ACCT, 6n * NEAR);
    // The trade fell below its amount, so the contract moved the treasury's deposit to PARTIAL.
    expect(await funder(a, TREASURY)).toMatchObject({ available: 0n, partial: 4n * NEAR, refunded: 0n });
  });
});

describe("M15 INSPECTION_FAIL under a 24-hour attestation lifetime", () => {
  it("is refused up front when the FAIL inspection would expire inside its 48-hour appeal window", async () => {
    // The default policy's 24-hour attestation lifetime bounds the inspection: the contract could
    // never authorize such a request, so the API refuses to lock the slice for it.
    const a = await apiWorld({ evidence: false });
    try {
      await inspectOverHttp(a, "FAIL");
      const r = await a.http(who(a, "buyer"), "POST", path(a, "/refund-challenges"), {
        reason: "INSPECTION_FAIL",
        funder: BUYER_ACCT,
      });
      expect(r.json.error.code).toBe("NOT_ELIGIBLE");
      expect(r.json.error.message).toMatch(/appeal window/);
      expect(Number(a.w.c.w.h.db.get("SELECT COUNT(*) AS n FROM refund_requests")?.["n"])).toBe(0);
    } finally {
      await a.close();
    }
  });
});

describe("M15 PERMANENT_HOLD above the contract", () => {
  let a: ApiWorld;
  beforeAll(async () => {
    a = await apiWorld();
  });
  afterAll(async () => {
    await a.close();
  });

  it("risk initiates after RESOLVE_TO_REFUND, the supplier consents, cooling holds, the slice is refunded", async () => {
    const c = a.w.c;
    const holdId = await riskHold(a, 3 * DAY);
    const risk = who(a, "risk");
    const ask = (by: string, f = BUYER_ACCT) =>
      a.http(who(a, by), "POST", path(a, "/refund-challenges"), { reason: "PERMANENT_HOLD", funder: f });
    expect((await ask("risk")).json.error.code).toBe("NOT_ELIGIBLE");
    await resolveHold(a, holdId, "RESOLVE_TO_REFUND");
    expect((await ask("buyer")).json.error.code).toBe("FORBIDDEN");
    expect((await ask("supplier")).json.error.code).toBe("FORBIDDEN");

    const id = await request(a, "risk", "PERMANENT_HOLD", BUYER_ACCT);
    expect(await refundOf(a, id)).toMatchObject({
      state: "REQUESTED",
      initiatorRole: "RISK_RESOLVER",
      supplierSigned: false,
    });
    expect(
      (await a.http(who(a, "buyer"), "POST", path(a, `/refunds/${id}/cosign-challenges`))).json.error.code,
    ).toBe("FORBIDDEN");
    const co = await a.http(who(a, "supplier"), "POST", path(a, `/refunds/${id}/cosign-challenges`));
    expect(co.status, co.text).toBe(201);
    expect(co.json.digest).toBe((await refundOf(a, id))?.requestDigest);
    a.relay(
      await a.http(who(a, "supplier"), "POST", path(a, `/refunds/${id}/cosignature`), {
        signature: a.sign(who(a, "supplier"), "REFUND_REQUEST", co.json.payload),
      }),
    );
    const tl = await refundOf(a, id);
    expect(tl).toMatchObject({ state: "TIMELOCKED", supplierSigned: true });
    expect((tl?.deadline ?? 0) - (tl?.clockOrigin ?? 0)).toBe(48 * HOUR);
    expect(
      (
        await a.http(risk, "POST", path(a, `/refunds/${id}/dispute-challenges`), {
          reasonCode: "X",
          evidenceDigest: "cc".repeat(32),
        })
      ).json.error.code,
    ).toBe("DISPUTE_NOT_ALLOWED");

    // Treasury slice: either signer may revoke during cooling; the supplier does, AVAILABLE again.
    const tid = await request(a, "risk", "PERMANENT_HOLD", TREASURY);
    const co2 = await a.http(who(a, "supplier"), "POST", path(a, `/refunds/${tid}/cosign-challenges`));
    a.relay(
      await a.http(who(a, "supplier"), "POST", path(a, `/refunds/${tid}/cosignature`), {
        signature: a.sign(who(a, "supplier"), "REFUND_REQUEST", co2.json.payload),
      }),
    );
    a.relay(await signed(a, "supplier", tid, "revocation"));
    expect((await refundOf(a, tid))?.state).toBe("REVOKED");
    expect(await funder(a, TREASURY)).toMatchObject({ available: 4n * NEAR, refundLocked: 0n });

    expect(
      a.relayExpectFail(await a.http(who(a, "buyer"), "POST", path(a, `/refunds/${id}/authorization`))),
    ).toContain("DELAY_NOT_ELAPSED");
    c.advance(48 * HOUR + 1);
    a.relay(await a.http(who(a, "buyer"), "POST", path(a, `/refunds/${id}/authorization`)));
    expect((await refundOf(a, id))?.state).toBe("AUTHORIZED");
    await executeOnce(a, id, BUYER_ACCT, 6n * NEAR);
  });
});

describe("M15 T-010 both orders of the release/refund race over HTTP", () => {
  /** Prepare and sign the buyer's release intent and a supplier MUTUAL_CANCEL request; relay neither. */
  async function prepared(a: ApiWorld) {
    const buyer = who(a, "buyer");
    const supplier = who(a, "supplier");
    const t = a.w.c.t;
    const ri = await a.http(buyer, "POST", `/v1/trades/${t}/release-intents`, {
      idempotencyKey: "m15-race-1",
    });
    expect(ri.status, ri.text).toBe(201);
    const lock = await a.http(buyer, "POST", `/v1/release-intents/${ri.json.releaseIntentId}/signature`, {
      signature: a.sign(buyer, "RELEASE_INTENT", ri.json.payload),
    });
    const ch = await a.http(supplier, "POST", path(a, "/refund-challenges"), {
      reason: "MUTUAL_CANCEL",
      funder: BUYER_ACCT,
    });
    expect(ch.status, ch.text).toBe(201);
    const refund = await a.http(
      supplier,
      "POST",
      path(a, `/refunds/${ch.json.refundIntentId}/request-signature`),
      {
        signature: a.sign(supplier, "REFUND_REQUEST", ch.json.payload),
      },
    );
    return { lock, refund, rid: ch.json.refundIntentId as string };
  }

  it("refund first: the release intent cannot lock; release first: the refund request is VALUE_LOCKED", async () => {
    const a1 = await apiWorld();
    try {
      const p = await prepared(a1);
      a1.relay(p.refund);
      expect((await refundOf(a1, p.rid))?.state).toBe("REQUESTED");
      expect(a1.relayExpectFail(p.lock)).toMatch(/NOTHING_ELIGIBLE|NOT_FULLY_FUNDED|VALUE_LOCKED/);
      const l = await a1.w.c.escrow.getLedger(a1.w.c.t);
      expect(l.totals.reserved).toBe(0n);
      expect(l.funders[BUYER_ACCT]).toMatchObject({ refundLocked: 6n * NEAR, reserved: 0n });
      await conserved(a1);
    } finally {
      await a1.close();
    }
    const a2 = await apiWorld();
    try {
      const p = await prepared(a2);
      a2.relay(p.lock);
      expect(a2.relayExpectFail(p.refund)).toContain("VALUE_LOCKED");
      expect(await refundOf(a2, p.rid)).toBeUndefined();
      const l = await a2.w.c.escrow.getLedger(a2.w.c.t);
      expect(l.totals.reserved).toBe(10n * NEAR);
      expect(l.funders[BUYER_ACCT]?.refundLocked).toBe(0n);
      await conserved(a2);
    } finally {
      await a2.close();
    }
  });
});
