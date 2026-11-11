/**
 * M04 services against the COMPILED escrow contract (dockside_escrow.wasm) under the simulated
 * NEAR host (packages/near/test/sim; not nearcore, no gas/staking). The positive path is a direct
 * native release from escrow to the bound supplier account; it is the local stand-in for the real
 * testnet release, which stays BLOCKED until testnet accounts exist (docs/status/M04.md).
 * Owned IDs exercised here: T-009, T-010, T-015, T-019, T-020, T-021, T-022, T-023, T-046, T-047.
 */
import { newNonce, signFor, toTypedJson } from "@dockside/core";
import {
  holdResolvePayload,
  refundAuthorizePayload,
  refundRequestPayload,
  tradeBinding,
} from "@dockside/near";
import { afterEach, describe, expect, it } from "vitest";
import { closeHarnesses } from "../../authority/test/helpers.js";
import { pdf } from "../../evidence/test/world.js";
import {
  ALT_DEST,
  approve,
  BUYER_ACCT,
  type Chain,
  chain,
  codeOfAsync,
  DAY,
  dualCancel,
  evidenceReady,
  fund,
  HOUR,
  lockIntent,
  NEAR,
  panicCode,
  SUPPLIER_ACCT,
  TREASURY,
} from "./chain.js";

let chains: Chain[] = [];
afterEach(() => {
  for (const c of chains) c.w.close();
  chains = [];
  closeHarnesses();
});
async function fresh(): Promise<Chain> {
  const c = await chain();
  chains.push(c);
  return c;
}

describe("M04 release through the services and the compiled contract", () => {
  it("T-019/T-022: the exact complete conjunction releases native NEAR to the bound supplier once", async () => {
    const c = await fresh();
    fund(c);
    expect(await c.rel.readiness(c.t)).toEqual(
      expect.arrayContaining(["MANIFEST_NOT_CURRENT", "INSPECTION_NOT_PASS", "NO_RELEASE_INTENT"]),
    );
    await evidenceReady(c);
    const id = await lockIntent(c);
    expect(id).toMatch(/^rli_[0-9a-f]{32}$/);
    const j = c.rel.intent(id);
    expect(j.state).toBe("VALUE_LOCKED");
    expect(j.slices).toEqual([
      { funder: BUYER_ACCT, amountYocto: 6n * NEAR },
      { funder: TREASURY, amountYocto: 4n * NEAR },
    ]);
    const ledger = await c.escrow.getLedger(c.t);
    expect(ledger.totals.reserved).toBe(10n * NEAR);
    expect(await c.rel.readiness(c.t)).toEqual(["APPROVAL_MISSING"]);
    await expect(c.rel.prepareExecution(id)).rejects.toMatchObject({ code: "APPROVAL_MISSING" });
    await approve(c, id);
    expect(await c.rel.readiness(c.t)).toEqual([]);
    const supplierBefore = c.sim.balance(SUPPLIER_ACCT);
    const r = c.ok(await c.rel.prepareExecution(id), "anyone.testnet");
    expect(r.promises[0]).toMatchObject({
      receiver: SUPPLIER_ACCT,
      actions: [{ kind: "transfer", amountYocto: 10n * NEAR }],
    });
    // Before the receipt the value is still reserved and the intent is SUBMITTING.
    await c.rel.sync(c.t);
    expect(c.rel.intent(id).state).toBe("SUBMITTING");
    expect(c.rel.intent(id).children.map((x) => x.kind)).toEqual(["ATTEMPT"]);
    expect(c.sim.runPromises(r)[0]?.value).toBe(true);
    await c.rel.sync(c.t);
    expect(c.rel.intent(id).state).toBe("PAID");
    expect(c.sim.balance(SUPPLIER_ACCT) - supplierBefore).toBe(10n * NEAR);
    const after = await c.escrow.getLedger(c.t);
    expect(after.funders[BUYER_ACCT]?.released).toBe(6n * NEAR);
    expect(after.funders[TREASURY]?.released).toBe(4n * NEAR);
    expect(after.conservation).toBe(true);
    expect((await c.escrow.getEvidence(c.t)).current?.consumed).toBe(true);
    // Consumed value: the private callback cannot be forged and no second release exists.
    const forged = c.sim.call(
      "on_release_transfer",
      { trade_id: c.t, release_intent_id: id, attempt_id: c.rel.intent(id).children[0]?.childId },
      { predecessor: BUYER_ACCT, promiseResults: ["success"] },
    );
    expect(forged.ok).toBe(false);
    expect(panicCode(c.exec(c.escrow.executeReleaseCall(c.t, id)))).toBe("INVALID_STATE");
    expect(
      await codeOfAsync(
        c.rel.prepareIntent(c.w.buyer.ctx(), { tradeId: c.t, idempotencyKey: "intent-key-0002" }),
      ),
    ).toBe("INVALID_STATE");
  });

  it("T-015: deterministic-policy and risk holds reject the direct contract release entry point", async () => {
    const c = await fresh();
    fund(c);
    await evidenceReady(c);
    const id = await lockIntent(c);
    await approve(c, id);
    const hold = await c.w.holds.setByPolicy(
      c.t,
      { ruleId: "doc-mismatch@1", reasonCode: "DOC_MISMATCH", ttlMs: 10 * 60_000 },
      c.w.policySigner,
    );
    c.ok(c.escrow.setHoldCall(c.t, toTypedJson(hold.setPayload), hold.setSignature));
    // The service refuses the relay, and the contract refuses the call made directly by anyone.
    await expect(c.rel.prepareExecution(id)).rejects.toMatchObject({ code: "HOLD_ACTIVE" });
    expect(panicCode(c.exec(c.escrow.executeReleaseCall(c.t, id), SUPPLIER_ACCT))).toBe("HOLD_ACTIVE");
    // Expiry never clears it.
    c.w.h.clock.advance(20 * 60_000);
    expect((await c.escrow.getHolds(c.t))[0]?.status).toBe("EXPIRED_UNRESOLVED");
    expect(panicCode(c.exec(c.escrow.executeReleaseCall(c.t, id), SUPPLIER_ACCT))).toBe("HOLD_ACTIVE");
    expect(await c.rel.readiness(c.t)).toContain("HOLD_ACTIVE");
    // Only the risk key resolves; afterwards the approval is stale (it saw another holds view).
    const now = c.w.h.clock.now();
    const res = holdResolvePayload(tradeBinding(c.w.terms), {
      holdId: hold.id,
      holdReasonCode: "DOC_MISMATCH",
      manifestDigest: c.w.evidence.currentAcceptedManifestDigest(c.t),
      resolutionCode: "RELEASE_HOLD",
      evidenceDigest: "ef".repeat(32),
      issuedAt: now,
      expiresAt: now + HOUR,
      nonce: newNonce(),
    });
    expect(
      panicCode(
        c.exec(c.escrow.resolveHoldCall(c.t, toTypedJson(res), c.sign(c.w.buyer, "HOLD_RESOLVE", res))),
      ),
    ).toBe("SIGNATURE_INVALID");
    const riskSig = c.sign(c.w.risk, "HOLD_RESOLVE", res);
    c.w.holds.recordResolve(c.t, res, riskSig);
    c.ok(c.escrow.resolveHoldCall(c.t, toTypedJson(res), riskSig));
    expect(panicCode(c.exec(c.escrow.executeReleaseCall(c.t, id)))).toBe("APPROVAL_STALE");
    // T-046: dual CANCEL retires the stale authorized intent; a new intent and approval release.
    expect((await dualCancel(c, id)).value).toBe("CANCELLED");
    expect(c.rel.intent(id).state).toBe("CANCELLED_PRE_SUBMIT");
    expect((await c.escrow.getLedger(c.t)).totals.available).toBe(10n * NEAR);
    const id2 = await lockIntent(c, "intent-key-0002");
    await approve(c, id2);
    const r = c.ok(await c.rel.prepareExecution(id2));
    expect(c.sim.runPromises(r)[0]?.value).toBe(true);
  });

  it("T-022/T-023: duplicate joins, conflicting reuse, a cross-connection race and unresolved-state denials", async () => {
    const c = await fresh();
    fund(c);
    await evidenceReady(c);
    const a = await c.rel.prepareIntent(c.w.buyer.ctx(), { tradeId: c.t, idempotencyKey: "dup-key-00001" });
    const again = await c.rel.prepareIntent(c.w.buyer.ctx(), {
      tradeId: c.t,
      idempotencyKey: "dup-key-00001",
    });
    expect(again).toMatchObject({ releaseIntentId: a.releaseIntentId, digest: a.digest, joined: true });
    expect(
      await codeOfAsync(
        c.rel.prepareIntent(c.w.buyer.ctx(), {
          tradeId: c.t,
          idempotencyKey: "dup-key-00001",
          intentLifetimeMs: DAY,
        }),
      ),
    ).toBe("IDEMPOTENCY_CONFLICT");
    // A second process cannot take the lock for another request while this one is live.
    const other = c.second();
    try {
      expect(
        await codeOfAsync(
          other.rel.prepareIntent(c.w.buyer.ctx(), { tradeId: c.t, idempotencyKey: "dup-key-00002" }),
        ),
      ).toBe("VALUE_LOCKED");
    } finally {
      other.db.close();
    }
    // Non-buyer sessions cannot prepare or sign the intent.
    for (const actor of [c.w.supplier, c.w.risk, c.w.inspector, c.w.buyerAdmin]) {
      expect(
        await codeOfAsync(
          c.rel.prepareIntent(actor.ctx(), { tradeId: c.t, idempotencyKey: "dup-key-00003" }),
        ),
      ).toBe("FORBIDDEN");
    }
    expect(
      await codeOfAsync(() =>
        c.rel.recordIntentSignature(c.w.buyer.ctx(), {
          releaseIntentId: a.releaseIntentId,
          signature: c.sign(c.w.supplier, "RELEASE_INTENT", a.payload),
        }),
      ),
    ).toBe("SIGNATURE_INVALID");
    const call = c.rel.recordIntentSignature(c.w.buyer.ctx(), {
      releaseIntentId: a.releaseIntentId,
      signature: c.sign(c.w.buyer, "RELEASE_INTENT", a.payload),
    });
    expect(c.ok(call).value).toEqual({ releaseIntentId: a.releaseIntentId, joined: false });
    // Exact duplicate delivery to the contract joins.
    expect(c.ok(call).value).toEqual({ releaseIntentId: a.releaseIntentId, joined: true });
    await approve(c, a.releaseIntentId);
    // Submit without delivering the receipt: SUBMITTING stays locked.
    c.ok(await c.rel.prepareExecution(a.releaseIntentId));
    await c.rel.sync(c.t);
    expect(c.rel.intent(a.releaseIntentId).state).toBe("SUBMITTING");
    const denied = [
      await codeOfAsync(
        c.rel.prepareIntent(c.w.buyer.ctx(), { tradeId: c.t, idempotencyKey: "dup-key-00004" }),
      ),
      await codeOfAsync(c.rel.prepareExecution(a.releaseIntentId)),
      await codeOfAsync(
        c.rel.prepareCancel(c.w.buyer.ctx(), { releaseIntentId: a.releaseIntentId, reasonCode: "X" }),
      ),
      await codeOfAsync(
        c.rel.prepareAbandon(c.w.supplier.ctx(), {
          releaseIntentId: a.releaseIntentId,
          trigger: "INTENT_EXPIRED",
        }),
      ),
      await codeOfAsync(() => c.rel.assertNoUnresolvedRelease(c.t)),
    ];
    expect(denied).toEqual(["VALUE_LOCKED", "VALUE_LOCKED", "VALUE_LOCKED", "VALUE_LOCKED", "VALUE_LOCKED"]);
    // Destination change can be agreed, but activation is refused by the service and the contract.
    const s = c.rel.successorTerms(c.t, ALT_DEST);
    c.ok(
      await c.rel.recordDestinationConsent(c.w.supplier.ctx(), {
        tradeId: c.t,
        destination: ALT_DEST,
        signature: c.sign(c.w.supplier, "TRADE_REVISION", s.canonical),
      }),
    );
    c.ok(
      await c.rel.recordDestinationConsent(c.w.buyer.ctx(), {
        tradeId: c.t,
        destination: ALT_DEST,
        signature: c.sign(c.w.buyer, "TRADE_REVISION", s.canonical),
      }),
    );
    c.advance(DAY);
    expect(await codeOfAsync(c.rel.prepareActivation(c.t))).toBe("VALUE_LOCKED");
    expect(panicCode(c.exec(c.escrow.activateDestinationChangeCall(c.t, s.digest)))).toBe("VALUE_LOCKED");
    // Refund requests built and signed by the parties are refused by the contract too.
    const now = c.w.h.clock.now();
    const req = refundRequestPayload(tradeBinding(c.w.terms), {
      refundIntentId: randomRfd(),
      reason: "MUTUAL_CANCEL",
      funder: BUYER_ACCT,
      amountYocto: 6n * NEAR,
      sourceBucket: "AVAILABLE",
      initiatorRole: "BUYER",
      issuedAt: now,
      expiresAt: now + HOUR,
      nonce: newNonce(),
    });
    expect(
      panicCode(
        c.exec(
          c.escrow.requestRefundCall(c.t, toTypedJson(req), {
            buyer: c.sign(c.w.buyer, "REFUND_REQUEST", req),
            supplier: c.sign(c.w.supplier, "REFUND_REQUEST", req),
          }),
        ),
      ),
    ).toBe("VALUE_LOCKED");
    expect((await c.escrow.getLedger(c.t)).totals.reserved).toBe(10n * NEAR);
  });

  it("T-022/NFR-01: two API processes racing for the value lock have exactly one winner; the journal is immutable", async () => {
    const c = await fresh();
    fund(c);
    await evidenceReady(c);
    const other = c.second();
    try {
      const results = await Promise.allSettled([
        c.rel.prepareIntent(c.w.buyer.ctx(), { tradeId: c.t, idempotencyKey: "race-key-0001" }),
        other.rel.prepareIntent(c.w.buyer.ctx(), { tradeId: c.t, idempotencyKey: "race-key-0002" }),
      ]);
      const won = results.filter((r) => r.status === "fulfilled");
      const lost = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      expect(won).toHaveLength(1);
      expect(lost.map((r) => (r.reason as { code: string }).code)).toEqual(["VALUE_LOCKED"]);
      const id = (won[0] as PromiseFulfilledResult<{ releaseIntentId: string }>).value.releaseIntentId;
      // Durable across connections: the other process sees the same single live row.
      expect(other.rel.liveIntent(c.t)?.releaseIntentId).toBe(id);
      // Identity, amount and slices are immutable; events and rows cannot be deleted.
      const db = c.w.h.db;
      expect(() => db.run("UPDATE release_intents SET amount_yocto = '1' WHERE intent_id = ?", id)).toThrow(
        /immutable/,
      );
      expect(() =>
        db.run("UPDATE release_intents SET destination = 'mallory.testnet' WHERE intent_id = ?", id),
      ).toThrow(/immutable/);
      expect(() => db.run("DELETE FROM release_intents WHERE intent_id = ?", id)).toThrow(/append-only/);
      expect(() => db.run("UPDATE release_intent_events SET to_state = 'PAID'")).toThrow(/append-only/);
      expect(() =>
        db.run(
          "INSERT INTO release_intents (intent_id, trade_id, trade_revision, amount_yocto, slices_json, destination, profile, state, live, version, intent_expires_at, prepared_expires_at, created_at, updated_at) VALUES ('rli_x', ?, 1, '1', '[]', 'x', 'DIRECT_TESTNET', 'VALUE_LOCKED', 1, 1, 0, 0, 0, 0)",
          c.t,
        ),
      ).toThrow(/UNIQUE/);
    } finally {
      other.db.close();
    }
  });

  it("T-020/T-021/T-047: dual-consent delayed change supersedes the pre-submit intent and invalidates release facts", async () => {
    const c = await fresh();
    fund(c);
    await evidenceReady(c);
    const id = await lockIntent(c);
    await approve(c, id);
    const oldApproval = await codeOfAsync(c.rel.prepareApproval(c.w.buyer.ctx(), { releaseIntentId: id }));
    expect(oldApproval).toBe("INVALID_STATE");
    const oldAtt = c.w.evidence.currentAttestation(c.t);
    const s = c.rel.successorTerms(c.t, ALT_DEST);
    // Unilateral: outsiders and non-party roles cannot consent; one party alone never activates.
    for (const actor of [c.w.risk, c.w.inspector, c.w.supplierClerk, c.w.buyerAdmin]) {
      expect(
        await codeOfAsync(
          c.rel.recordDestinationConsent(actor.ctx(), {
            tradeId: c.t,
            destination: ALT_DEST,
            signature: c.sign(actor, "TRADE_REVISION", s.canonical),
          }),
        ),
      ).toBe("FORBIDDEN");
    }
    c.ok(
      await c.rel.recordDestinationConsent(c.w.supplier.ctx(), {
        tradeId: c.t,
        destination: ALT_DEST,
        signature: c.sign(c.w.supplier, "TRADE_REVISION", s.canonical),
      }),
    );
    expect(await codeOfAsync(c.rel.prepareActivation(c.t))).toBe("INVALID_STATE");
    expect(panicCode(c.exec(c.escrow.activateDestinationChangeCall(c.t, s.digest)))).toBe("INVALID_STATE");
    c.ok(
      await c.rel.recordDestinationConsent(c.w.buyer.ctx(), {
        tradeId: c.t,
        destination: ALT_DEST,
        signature: c.sign(c.w.buyer, "TRADE_REVISION", s.canonical),
      }),
    );
    // Enforced delay; the old destination stays effective meanwhile.
    expect(await codeOfAsync(c.rel.prepareActivation(c.t))).toBe("DELAY_NOT_ELAPSED");
    expect(panicCode(c.exec(c.escrow.activateDestinationChangeCall(c.t, s.digest)))).toBe(
      "DELAY_NOT_ELAPSED",
    );
    expect((await c.escrow.getTrade(c.t)).payoutDestination).toBe(SUPPLIER_ACCT);
    c.advance(DAY);
    const act = c.ok(await c.rel.prepareActivation(c.t));
    const successor = (act.value as { successorIntent: string }).successorIntent;
    await c.rel.sync(c.t);
    expect(c.rel.intent(id).state).toBe("SUPERSEDED_PRE_SUBMIT");
    expect(c.rel.intent(successor)).toMatchObject({
      state: "VALUE_LOCKED",
      tradeRevision: 2,
      destination: ALT_DEST,
      predecessorId: id,
    });
    expect(c.rel.liveIntent(c.t)?.releaseIntentId).toBe(successor);
    // Bind revision 2 for evidence/holds; every predecessor fact is invalid.
    await c.rel.bindActivatedRevision(c.t);
    expect(c.w.evidence.terms(c.t).revision).toBe(2);
    expect(c.w.evidence.currentAttestation(c.t)).toBeNull();
    expect(c.w.evidence.currentInspection(c.t)).toBeNull();
    expect(c.w.evidence.currentAcceptedManifestDigest(c.t)).toBeNull();
    expect(
      panicCode(
        c.exec(
          c.escrow.submitManifestAttestationCall(
            c.t,
            oldAtt?.typed ?? toTypedJson(null),
            oldAtt?.signature ?? "",
          ),
        ),
      ),
    ).toBe("STALE_REVISION");
    expect(panicCode(c.exec(c.escrow.executeReleaseCall(c.t, id)))).toBe("INVALID_STATE");
    expect(await c.rel.readiness(c.t)).toEqual(
      expect.arrayContaining(["MANIFEST_NOT_CURRENT", "INSPECTION_NOT_PASS", "APPROVAL_MISSING"]),
    );
    // A replacement manifest under revision 2, a new attestation, inspection and approval.
    const old = c.w.evidence.manifest(c.t).items.find((i) => i.slotId === "commercial-invoice");
    const inv = pdf("Invoice INV-1 payable to harbor-payouts.testnet");
    await c.w.evidence.upload(c.w.supplier.ctx(), {
      tradeId: c.t,
      slotId: "commercial-invoice",
      content: inv,
      issuer: c.w.issue(c.w.supplier, "SUPPLIER_SIGNER", "commercial-invoice", inv),
      replacesItemId: old?.itemId ?? "",
      expectedManifestRevision: c.w.evidence.currentRevision(c.t),
    });
    await evidenceReady(c, "PASS", false);
    await approve(c, successor);
    const before = c.sim.balance(ALT_DEST);
    const r = c.ok(await c.rel.prepareExecution(successor));
    expect(r.promises[0]?.receiver).toBe(ALT_DEST);
    expect(c.sim.runPromises(r)[0]?.value).toBe(true);
    expect(c.sim.balance(ALT_DEST) - before).toBe(10n * NEAR);
    await c.rel.sync(c.t);
    expect(c.rel.intent(successor).state).toBe("PAID");
    expect((await c.escrow.getLedger(c.t)).conservation).toBe(true);
  });

  it("T-046: ABANDON only after the objective trigger plus grace, by a designated party", async () => {
    const c = await fresh();
    fund(c);
    await evidenceReady(c);
    const p = await c.rel.prepareIntent(c.w.buyer.ctx(), {
      tradeId: c.t,
      idempotencyKey: "abandon-key-1",
      intentLifetimeMs: HOUR,
    });
    c.ok(
      c.rel.recordIntentSignature(c.w.buyer.ctx(), {
        releaseIntentId: p.releaseIntentId,
        signature: c.sign(c.w.buyer, "RELEASE_INTENT", p.payload),
      }),
    );
    const id = p.releaseIntentId;
    c.advance(2 * HOUR);
    expect(
      await codeOfAsync(
        c.rel.prepareAbandon(c.w.supplier.ctx(), { releaseIntentId: id, trigger: "INTENT_EXPIRED" }),
      ),
    ).toBe("DELAY_NOT_ELAPSED");
    c.advance(DAY);
    expect(
      await codeOfAsync(
        c.rel.prepareAbandon(c.w.risk.ctx(), { releaseIntentId: id, trigger: "INTENT_EXPIRED" }),
      ),
    ).toBe("FORBIDDEN");
    expect(
      await codeOfAsync(
        c.rel.prepareAbandon(c.w.buyerAdmin.ctx(), { releaseIntentId: id, trigger: "INTENT_EXPIRED" }),
      ),
    ).toBe("FORBIDDEN");
    const ab = await c.rel.prepareAbandon(c.w.supplier.ctx(), {
      releaseIntentId: id,
      trigger: "INTENT_EXPIRED",
    });
    // A risk-key signature over the supplier's payload fails at the service and at the contract.
    expect(
      await codeOfAsync(
        c.rel.recordAbandon(c.w.supplier.ctx(), {
          payload: ab.payload,
          signature: c.sign(c.w.risk, "ABANDON_RELEASE_INTENT", ab.payload),
        }),
      ),
    ).toBe("SIGNATURE_INVALID");
    expect(
      panicCode(
        c.exec(
          c.escrow.abandonReleaseIntentCall(
            c.t,
            ab.typed,
            c.sign(c.w.risk, "ABANDON_RELEASE_INTENT", ab.payload),
          ),
        ),
      ),
    ).toBe("SIGNATURE_INVALID");
    c.ok(
      await c.rel.recordAbandon(c.w.supplier.ctx(), {
        payload: ab.payload,
        signature: c.sign(c.w.supplier, "ABANDON_RELEASE_INTENT", ab.payload),
      }),
    );
    await c.rel.sync(c.t);
    expect(c.rel.intent(id).state).toBe("ABANDONED_PRE_SUBMIT");
    const l = await c.escrow.getLedger(c.t);
    expect([l.funders[BUYER_ACCT]?.available, l.funders[TREASURY]?.available, l.totals.reserved]).toEqual([
      6n * NEAR,
      4n * NEAR,
      0n,
    ]);
  });

  it("T-009/T-010: an inspector FAIL refunds each original funder after the window and blocks a release intent", async () => {
    const c = await fresh();
    fund(c);
    await evidenceReady(c, "FAIL");
    const b = tradeBinding(c.w.terms);
    const now = c.w.h.clock.now();
    const mk = (funder: string, amount: bigint, initiatorRole: "BUYER" | "SUPPLIER") =>
      refundRequestPayload(b, {
        refundIntentId: randomRfd(),
        reason: "INSPECTION_FAIL",
        funder,
        amountYocto: amount,
        sourceBucket: "AVAILABLE",
        initiatorRole,
        issuedAt: now,
        expiresAt: now + HOUR,
        nonce: newNonce(),
      });
    const r1 = mk(BUYER_ACCT, 6n * NEAR, "BUYER");
    const id1 = String(
      c.ok(
        c.escrow.requestRefundCall(c.t, toTypedJson(r1), { buyer: c.sign(c.w.buyer, "REFUND_REQUEST", r1) }),
      ).value,
    );
    const r2 = mk(TREASURY, 4n * NEAR, "SUPPLIER");
    const id2 = String(
      c.ok(
        c.escrow.requestRefundCall(c.t, toTypedJson(r2), {
          supplier: c.sign(c.w.supplier, "REFUND_REQUEST", r2),
        }),
      ).value,
    );
    // T-010: with accepted value refund-locked, no intent can lock it.
    expect(
      await codeOfAsync(
        c.rel.prepareIntent(c.w.buyer.ctx(), { tradeId: c.t, idempotencyKey: "blocked-key-1" }),
      ),
    ).toBe("NOT_FULLY_FUNDED");
    c.advance(48 * HOUR);
    for (const [rid, funder, amount] of [
      [id1, BUYER_ACCT, 6n * NEAR],
      [id2, TREASURY, 4n * NEAR],
    ] as const) {
      expect(panicCode(c.exec(c.escrow.authorizeRefundCall(c.t, rid)))).toBe("FORBIDDEN");
      const refunds = await c.escrow.getRefunds(c.t);
      const t = c.w.h.clock.now();
      const auth = refundAuthorizePayload(tradeBinding(c.w.terms), {
        refundIntentId: rid,
        requestDigest: refunds.find((x) => x.refundIntentId === rid)?.requestDigest ?? "",
        issuedAt: t,
        expiresAt: t + HOUR,
        nonce: newNonce(),
      });
      expect(
        panicCode(
          c.exec(
            c.escrow.authorizeRefundSignedCall(
              c.t,
              toTypedJson(auth),
              c.sign(c.w.inspector, "REFUND_AUTHORIZE", auth),
            ),
          ),
        ),
      ).toBe("SIGNATURE_INVALID");
      c.ok(
        c.escrow.authorizeRefundSignedCall(
          c.t,
          toTypedJson(auth),
          signFor(c.w.risk.key.privateKey, "REFUND_AUTHORIZE", auth),
        ),
      );
      const before = c.sim.balance(funder);
      const ex = c.ok(c.escrow.executeRefundCall(c.t, rid), "anyone.testnet");
      expect(ex.promises[0]?.receiver).toBe(funder);
      expect(c.sim.runPromises(ex)[0]?.value).toBe(true);
      expect(c.sim.balance(funder) - before).toBe(amount);
    }
    const l = await c.escrow.getLedger(c.t);
    expect([l.totals.refunded, l.totals.reserved, l.conservation]).toEqual([10n * NEAR, 0n, true]);
    expect(
      (await c.escrow.getRefunds(c.t)).every((r) => r.reason === "INSPECTION_FAIL" && r.basis !== null),
    ).toBe(true);
  });
});

function randomRfd(): string {
  return `rfd_${newNonce().slice(0, 32)}`;
}
