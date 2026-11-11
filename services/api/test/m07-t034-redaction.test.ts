/**
 * T-034 (API, log, audit and export boundaries): canary secrets and private evidence injected
 * through every server boundary never appear in request logs, API history, the audit log, the
 * default export or the relational store. The DOM, browser storage, accessible names and
 * screenshots belong to the web client (M08) and are not exercised here.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, enrollHuman } from "../../../packages/authority/test/helpers.js";
import { pdf } from "../../../packages/evidence/test/world.js";
import { type ApiWorld, apiWorld } from "./m07-world.js";

const CANARY_DOC = "CANARYDOC9f27c1e4b8";
const CANARY_NOTE = "CANARYNOTE51d0aa73e2";
const CANARY_INPUT = "CANARYINPUT0c7e6b19";

let a: ApiWorld;
let invitationSecret = "";
let holdId = "";

beforeAll(async () => {
  a = await apiWorld();
});
afterAll(async () => {
  await a.close();
});

function scanDb(exclude: string[]): string[] {
  const db = a.w.c.w.h.db;
  const hits: string[] = [];
  const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => String(r["name"]));
  for (const t of tables) {
    if (exclude.includes(t)) continue;
    for (const row of db.all(`SELECT * FROM ${t}`)) {
      const s = JSON.stringify(row, (_k, v) =>
        typeof v === "bigint" ? String(v) : v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : v,
      );
      for (const c of [CANARY_DOC, CANARY_NOTE, CANARY_INPUT]) if (s.includes(c)) hits.push(`${t}:${c}`);
    }
  }
  return hits;
}

describe("T-034: secrets and private evidence are redacted at the server boundaries", () => {
  it("injects canaries through uploads, notes, invitations, malformed input, headers and queries", async () => {
    const c = a.w.c;
    const t = c.t;
    const { supplier, buyer, buyerAdmin } = a.actors;
    // Private evidence content.
    const ev = await a.http(supplier, "GET", `/v1/trades/${t}/evidence`);
    const current = ev.json.manifest.items.find((i: any) => i.slotId === "commercial-invoice");
    const content = pdf(`Invoice ${CANARY_DOC} confidential pricing`);
    const up = await a.http(supplier, "POST", `/v1/trades/${t}/evidence`, {
      slotId: "commercial-invoice",
      contentBase64: Buffer.from(content).toString("base64"),
      issuer: c.w.issue(supplier, "SUPPLIER_SIGNER", "commercial-invoice", content),
      replacesItemId: current.itemId,
      expectedManifestRevision: ev.json.manifest.revision,
    });
    expect(up.status, up.text).toBe(201);
    // Free-text note on a hold review request.
    const hold = await c.w.holds.setByPolicy(
      t,
      { ruleId: "doc-mismatch@1", reasonCode: "DOC_MISMATCH", ttlMs: 3600_000, bindManifest: false },
      c.w.policySigner,
    );
    holdId = hold.id;
    const note = await a.http(buyer, "POST", `/v1/holds/${holdId}/resolution-requests`, {
      note: `see ${CANARY_NOTE}`,
    });
    expect(note.status, note.text).toBe(201);
    // One-time invitation secret.
    const inv = await a.http(buyerAdmin, "POST", "/v1/invitations", { capability: "AUDITOR" });
    expect(inv.status).toBe(201);
    invitationSecret = inv.json.secret;
    expect(invitationSecret.length).toBeGreaterThan(16);
    // Malformed input, header and query values are never echoed or logged.
    const bad = await a.http(buyer, "POST", `/v1/trades/${t}/release-intents`, {
      idempotencyKey: `${CANARY_INPUT}!!`,
    });
    expect(bad.status).toBe(400);
    expect(bad.text).not.toContain(CANARY_INPUT);
    const badHeader = await a.http(null, "GET", "/v1/me", undefined, {
      authorization: `Dockside-Session ${CANARY_INPUT}`,
      "dockside-proof": Buffer.from(CANARY_INPUT).toString("base64url"),
    });
    expect(badHeader.status).toBe(401);
    expect(badHeader.text).not.toContain(CANARY_INPUT);
    const q = await a.http(buyer, "GET", `/v1/trades/${t}/holds?token=${CANARY_INPUT}`);
    expect(q.status).toBe(200);
    const badKey = await a.http(
      buyer,
      "POST",
      `/v1/trades/${t}/sync`,
      {},
      { "idempotency-key": `${CANARY_INPUT}$` },
    );
    expect(badKey.text).not.toContain(CANARY_INPUT);
  });

  it("nothing secret reaches logs, API history, the audit log, the export or the database", async () => {
    const t = a.w.c.t;
    const { buyer, supplier, auditor, buyerAdmin } = a.actors;
    const responses: string[] = [];
    for (const [actor, path] of [
      [buyer, `/v1/trades/${t}`],
      [supplier, `/v1/trades/${t}/evidence`],
      [buyer, `/v1/trades/${t}/holds`],
      [buyer, `/v1/trades/${t}/release`],
      [auditor, `/v1/trades/${t}/timeline`],
      [auditor, `/v1/trades/${t}/audit-export`],
      [buyerAdmin, `/v1/audit?limit=1000`],
      [auditor, `/v1/audit?limit=1000`],
      [buyer, `/v1/me`],
    ] as [Actor, string][]) {
      const r = await a.http(actor, "GET", path);
      expect(r.status, `${path} ${r.text.slice(0, 200)}`).toBe(200);
      responses.push(r.text);
    }
    const secrets = [
      CANARY_DOC,
      CANARY_NOTE,
      CANARY_INPUT,
      invitationSecret,
      ...Object.values(a.actors).map((x) => (x as Actor).grant?.sessionToken ?? "never-empty"),
    ];
    for (const s of secrets) {
      for (const r of responses) expect(r.includes(s), `response leaks ${s.slice(0, 12)}`).toBe(false);
      for (const l of a.logs) expect(l.includes(s), `log leaks ${s.slice(0, 12)}`).toBe(false);
    }
    // Private keys never leave their holders: no PKCS8/raw export appears anywhere either.
    for (const x of Object.values(a.actors) as Actor[]) {
      const raw = x.key.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("hex");
      for (const r of responses) expect(r.includes(raw)).toBe(false);
    }
    // The export says what it excluded, and keeps only digests of the note.
    const exp = JSON.parse(responses[5] as string);
    expect(exp.sections.holdResolutionRequests[0].note_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(exp.sections.holdResolutionRequests[0].note).toBeUndefined();
    expect(exp.sections.authorities.principals[0].display_name).toBeUndefined();
    // Evidence bytes stay in the object store: no relational table holds them. The only place the
    // note text lives is its own private table.
    expect(scanDb(["hold_resolution_requests"])).toEqual([]);
    expect(scanDb([]).filter((h) => h.startsWith("hold_resolution_requests"))).toEqual([
      `hold_resolution_requests:${CANARY_NOTE}`,
    ]);
  });

  it("identifiers of another organisation's records are indistinguishable from unknown ones", async () => {
    // A buyer approver of an unrelated organisation holds the right capability but no relation.
    const outsider = enrollHuman(
      a.w.c.w.h,
      a.actors["outsiderAdmin"] as Actor,
      "BUYER_APPROVER",
      "Other buyer",
    );
    const intent = String(
      a.w.c.w.h.db.get("SELECT intent_id FROM release_intents LIMIT 1")?.["intent_id"] ?? "",
    );
    const zero = "0".repeat(32);
    const pairs: [string, string, unknown][] = [
      [`/v1/holds/${holdId}/resolution-requests`, `/v1/holds/hld_${zero}/resolution-requests`, { note: "x" }],
      [
        `/v1/trades/${a.w.c.t}/release-intents`,
        `/v1/trades/trd_${zero}/release-intents`,
        { idempotencyKey: "probe-key-01" },
      ],
      [`/v1/trades/${a.w.c.t}/sync`, `/v1/trades/trd_${zero}/sync`, {}],
    ];
    if (intent)
      pairs.push([
        `/v1/release-intents/${intent}/cancel-challenges`,
        `/v1/release-intents/rli_${zero}/cancel-challenges`,
        { reasonCode: "X" },
      ]);
    for (const [real, fake, body] of pairs) {
      const r1 = await a.http(outsider, "POST", real, body);
      const r2 = await a.http(outsider, "POST", fake, body);
      expect(r1.status, real).toBe(404);
      expect(r1.text).toBe(r2.text);
    }
    for (const p of [`/v1/trades/${a.w.c.t}`, `/v1/trades/${a.w.c.t}/holds`]) {
      const r1 = await a.http(outsider, "GET", p);
      const r2 = await a.http(outsider, "GET", p.replace(a.w.c.t, `trd_${zero}`));
      expect(r1.status).toBe(404);
      expect(r1.text).toBe(r2.text);
    }
  });
});
