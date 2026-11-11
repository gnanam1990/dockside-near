/**
 * T-035: concurrent requests and workers cannot duplicate authority. Races run over real HTTP
 * (interleaved at every await of the async handlers, contract views and SQLite writes) and with
 * two outbox/reconciler engines on separate SQLite connections. Each race must leave exactly one
 * effect, with every other contender joined or refused.
 */
import { randomIds } from "@dockside/core";
import { Database } from "@dockside/store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../../packages/authority/test/helpers.js";
import { Journal, OutboxWorker, Reconciler } from "../../../packages/journal/src/index.js";
import { SimTxSigner } from "../../../packages/journal/test/sim-chain.js";
import { verifyAuditExport } from "../src/export.js";
import { type ApiWorld, apiWorld, run } from "./m07-world.js";

let a: ApiWorld;
beforeAll(async () => {
  a = await apiWorld();
});
afterAll(async () => {
  await a.close();
});

const n = (sql: string, ...p: string[]) => Number(a.w.c.w.h.db.get(sql, ...p)?.["n"] ?? 0);

describe("T-035: concurrent workers and requests cannot duplicate authority", () => {
  let intentId = "";

  it("racing release-intent preparations under different keys leave one value lock", async () => {
    const buyer = a.actors["buyer"] as Actor;
    const t = a.w.c.t;
    const res = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        a.http(buyer, "POST", `/v1/trades/${t}/release-intents`, { idempotencyKey: `race-intent-${i}0000` }),
      ),
    );
    const ok = res.filter((r) => r.status === 201);
    expect(ok).toHaveLength(1);
    for (const r of res.filter((x) => x.status !== 201)) expect(r.json.error.code).toBe("VALUE_LOCKED");
    expect(n("SELECT COUNT(*) AS n FROM release_intents WHERE trade_id = ? AND live = 1", t)).toBe(1);
    intentId = ok[0]?.json.releaseIntentId;
    const signed = await a.http(buyer, "POST", `/v1/release-intents/${intentId}/signature`, {
      signature: a.sign(buyer, "RELEASE_INTENT", ok[0]?.json.payload),
    });
    a.relay(signed);
    await a.http(buyer, "POST", `/v1/trades/${t}/sync`);
  });

  it("the same Idempotency-Key raced concurrently executes once", async () => {
    const buyer = a.actors["buyer"] as Actor;
    const ch = await a.http(buyer, "POST", `/v1/release-intents/${intentId}/approval-challenges`);
    const body = { payload: ch.json.payload, signature: a.sign(buyer, "BUYER_APPROVAL", ch.json.payload) };
    const res = await Promise.all(
      Array.from({ length: 5 }, () =>
        a.http(buyer, "POST", `/v1/release-intents/${intentId}/approval`, body, {
          "idempotency-key": "approve-race-01",
        }),
      ),
    );
    const ok = res.filter((r) => r.status === 201);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const r of res.filter((x) => x.status !== 201)) expect(r.json.error.code).toBe("VERSION_CONFLICT");
    const calls = new Set(ok.map((r) => JSON.stringify(r.json.relay)));
    expect(calls.size).toBe(1);
    expect(
      n(
        "SELECT COUNT(*) AS n FROM release_signatures WHERE intent_id = ? AND kind = 'BUYER_APPROVAL'",
        intentId,
      ),
    ).toBe(1);
    // A different body under the same key fails closed.
    const conflict = await a.http(
      buyer,
      "POST",
      `/v1/release-intents/${intentId}/approval`,
      { ...body, signature: "00".repeat(64) },
      {
        "idempotency-key": "approve-race-01",
      },
    );
    expect(conflict.json.error.code).toBe("IDEMPOTENCY_CONFLICT");
    a.relay(ok[0] as never);
    await a.http(buyer, "POST", `/v1/trades/${a.w.c.t}/sync`);
  });

  it("racing execute requests queue exactly one economic operation", async () => {
    const buyer = a.actors["buyer"] as Actor;
    const res = await Promise.all(
      Array.from({ length: 6 }, () => a.http(buyer, "POST", `/v1/release-intents/${intentId}/execute`)),
    );
    const ok = res.filter((r) => r.status === 201);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ok.map((r) => r.json.operationId)).size).toBe(1);
    for (const r of res.filter((x) => x.status !== 201)) expect(r.json.error.code).toBe("VALUE_LOCKED");
    expect(n("SELECT COUNT(*) AS n FROM economic_operations WHERE subject_id = ?", intentId)).toBe(1);
    expect(n("SELECT COUNT(*) AS n FROM outbox")).toBe(1);
  });

  it("two engines on separate connections submit once and settle once", async () => {
    const w = a.w;
    const db2 = Database.open(w.c.w.h.dbPath);
    try {
      const cfg = { leaseTtlMs: 30_000, baseBackoffMs: 0, maxBackoffMs: 0, watchMs: 3600_000 };
      const mk = (holder: string, db: Database) => {
        const j = new Journal(db, w.jclock, randomIds);
        const rec = new Reconciler(j, w.ports, { holder, ...cfg });
        return {
          worker: new OutboxWorker(j, w.ports, new SimTxSigner("relayer.testnet"), rec, { holder, ...cfg }),
          rec,
        };
      };
      const e1 = mk("engine-1", w.c.w.h.db);
      const e2 = mk("engine-2", db2);
      for (let i = 0; i < 4; i++) {
        await Promise.all([e1.worker.runOnce(), e2.worker.runOnce()]);
        await Promise.all([e1.rec.runOnce(), e2.rec.runOnce()]);
      }
    } finally {
      db2.close();
    }
    await run(w, "engine-3", 2);
    const op = w.c.w.h.db.get("SELECT * FROM economic_operations WHERE subject_id = ?", intentId);
    expect(op?.["state"]).toBe("PAID");
    expect(Number(op?.["submit_count"])).toBe(1);
    expect(
      n(
        "SELECT COUNT(*) AS n FROM operation_dispositions WHERE operation_id = ?",
        String(op?.["operation_id"]),
      ),
    ).toBe(1);
    const ledger = await w.c.escrow.getLedger(w.c.t);
    expect(ledger.conservation).toBe(true);
  });

  it("racing hold resolutions and key revocations each take effect once", async () => {
    const c = a.w.c;
    const { risk, buyerAdmin } = a.actors;
    const hold = await c.w.holds.setByPolicy(
      c.t,
      { ruleId: "doc-mismatch@1", reasonCode: "LATE_DOC", ttlMs: 3600_000, bindManifest: false },
      c.w.policySigner,
    );
    const prepared = await Promise.all(
      ["RELEASE_HOLD", "RETRY_INSPECTION"].map((code) =>
        a.http(risk, "POST", `/v1/holds/${hold.id}/resolution-challenges`, {
          resolutionCode: code,
          evidenceDigest: "aa".repeat(32),
        }),
      ),
    );
    const res = await Promise.all(
      prepared.map((p) =>
        a.http(risk, "POST", `/v1/holds/${hold.id}/resolution`, {
          payload: p.json.payload,
          signature: a.sign(risk, "HOLD_RESOLVE", p.json.payload),
        }),
      ),
    );
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(res.find((r) => r.status !== 201)?.json.error.code).toBe("INVALID_STATE");
    expect(n("SELECT COUNT(*) AS n FROM hold_resolutions WHERE hold_id = ?", hold.id)).toBe(1);
    // Two admins' sessions racing to revoke the same key: one revocation, one refusal.
    const clerk = a.actors["supplierClerk"] as Actor;
    const supplierAdmin = a.actors["supplierAdmin"] as Actor;
    const rv = await Promise.all(
      [supplierAdmin, supplierAdmin].map((adm) =>
        a.http(adm, "POST", `/v1/keys/${clerk.keyVersionId}/revoke`, { reason: "ROTATED_OUT" }),
      ),
    );
    expect(rv.filter((r) => r.status === 201)).toHaveLength(1);
    expect(
      n("SELECT COUNT(*) AS n FROM key_versions WHERE id = ? AND status = 'REVOKED'", clerk.keyVersionId),
    ).toBe(1);
    // The buyer-side admin cannot revoke the other organisation's key at all.
    const cross = await a.http(
      buyerAdmin,
      "POST",
      `/v1/keys/${(a.actors["supplier"] as Actor).keyVersionId}/revoke`,
      {
        reason: "HOSTILE",
      },
    );
    expect(cross.status).toBeGreaterThanOrEqual(400);
  });

  it("concurrent exports are each internally consistent and verifiable", async () => {
    const res = await Promise.all(
      Array.from({ length: 4 }, () => a.http(a.auditor, "GET", `/v1/trades/${a.w.c.t}/audit-export`)),
    );
    for (const r of res) {
      expect(r.status).toBe(200);
      expect(verifyAuditExport(r.json).ok).toBe(true);
      expect(r.json.integrity.auditChain.ok).toBe(true);
    }
  });
});
