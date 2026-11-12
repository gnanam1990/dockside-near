/**
 * External security audit (m30): the one-time invitation secret must never be persisted, including
 * through the optional Idempotency-Key replay store (ADR-0003: invitation secrets are returned once
 * and stored only as SHA-256; ADR-0009 item 7: Idempotency-Key on authenticated POSTs).
 * Simulated: NEAR (compiled escrow wasm on the simulated host), not testnet.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiWorld, apiWorld } from "./m07-world.js";

let a: ApiWorld;
beforeAll(async () => {
  a = await apiWorld({ evidence: false });
});
afterAll(async () => {
  await a.close();
});

const invitationCount = () => Number(a.w.c.w.h.db.get("SELECT COUNT(*) AS n FROM invitations")?.["n"] ?? 0);

function tablesContaining(needle: string): string[] {
  const db = a.w.c.w.h.db;
  const hits: string[] = [];
  const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => String(r["name"]));
  for (const t of tables) {
    for (const row of db.all(`SELECT * FROM ${t}`)) {
      const s = JSON.stringify(row, (_k, v) =>
        typeof v === "bigint" ? String(v) : v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : v,
      );
      if (s.includes(needle)) hits.push(t);
    }
  }
  return hits;
}

describe("m30: invitation secrets never reach the idempotency store", () => {
  it("an idempotent invitation returns the secret once, stores none, and a replay creates nothing", async () => {
    const { buyerAdmin } = a.actors;
    const key = "inv-idem-key-0001";
    const hdr = { "idempotency-key": key };
    const before = invitationCount();
    const first = await a.http(buyerAdmin, "POST", "/v1/invitations", { capability: "AUDITOR" }, hdr);
    expect(first.status, first.text).toBe(201);
    const secret = String(first.json.secret);
    expect(secret.length).toBeGreaterThan(16);
    expect(first.headers.get("idempotent-replay")).toBeNull();
    // The secret exists nowhere in the database: only its SHA-256 in invitations.secret_hash.
    expect(tablesContaining(secret)).toEqual([]);
    const stored = a.w.c.w.h.db.get(
      "SELECT response_json FROM idempotency_keys WHERE scope LIKE ? AND idem_key = ?",
      "api:%:POST /v1/invitations",
      key,
    );
    expect(stored).toBeDefined();
    expect(JSON.parse(String(stored?.["response_json"]))).toMatchObject({
      invitationId: first.json.invitationId,
    });
    // An exact repeat still replays (no second invitation), but without the one-time secret.
    const again = await a.http(buyerAdmin, "POST", "/v1/invitations", { capability: "AUDITOR" }, hdr);
    expect(again.status, again.text).toBe(201);
    expect(again.headers.get("idempotent-replay")).toBe("true");
    expect(again.json.invitationId).toBe(first.json.invitationId);
    expect(again.json.secret).toBeUndefined();
    expect(again.text).not.toContain(secret);
    expect(invitationCount()).toBe(before + 1);
    // A different body under the same key still fails closed.
    const conflict = await a.http(buyerAdmin, "POST", "/v1/invitations", { capability: "INSPECTOR" }, hdr);
    expect(conflict.json.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("other idempotent POSTs still replay their full stored response", async () => {
    const { buyer } = a.actors;
    const hdr = { "idempotency-key": "sync-idem-key-0001" };
    const t = a.w.c.t;
    const first = await a.http(buyer, "POST", `/v1/trades/${t}/sync`, {}, hdr);
    expect(first.status, first.text).toBe(201);
    const again = await a.http(buyer, "POST", `/v1/trades/${t}/sync`, {}, hdr);
    expect(again.headers.get("idempotent-replay")).toBe("true");
    expect(again.json).toEqual(first.json);
  });
});
