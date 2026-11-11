/**
 * T-003: the integrated authority matrix over the real HTTP API and the compiled contract
 * (simulated NEAR host). Every mutating trade route is called by every actor that must not
 * succeed — buyer, supplier, inspector, risk, auditor, security admins, uploaders, an unrelated
 * organisation, a revoked principal and an unauthenticated caller — with a well-formed body. Each
 * call must be denied and the persisted state must not change. Read routes disclose nothing to
 * principals with no relation to the trade (same answer as for a trade that does not exist).
 */
import { AUTHORIZATION_MATRIX, newNonce, toTypedJson } from "@dockside/core";
import { holdSetPayload, releaseIntentPayload, tradeBinding } from "@dockside/near";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, enrollHuman } from "../../../packages/authority/test/helpers.js";
import { pdf } from "../../../packages/evidence/test/world.js";
import { buildRoutes } from "../src/app.js";
import { type ApiWorld, apiWorld, lockAndApprove, run } from "./m07-world.js";

const DENIALS = [
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "KEY_NOT_BOUND",
  "KEY_REVOKED",
  "SIGNATURE_INVALID",
];
const TABLES = [
  "evidence_policies",
  "evidence_trades",
  "evidence_items",
  "evidence_manifests",
  "inspection_attestations",
  "hold_records",
  "hold_resolutions",
  "hold_resolution_requests",
  "release_intents",
  "release_signatures",
  "economic_operations",
  "outbox",
  "operator_requests",
  "trade_freezes",
  "idempotency_keys",
];

let a: ApiWorld;
let intentId = "";
let operationId = "";
let holdId = "";
let revoked: Actor;

beforeAll(async () => {
  a = await apiWorld();
  const c = a.w.c;
  intentId = await lockAndApprove(a, "matrix-intent-01");
  operationId = (await a.http(a.actors["buyer"] as Actor, "POST", `/v1/release-intents/${intentId}/execute`))
    .json.operationId;
  await run(a.w);
  const hold = await c.w.holds.setByPolicy(
    c.t,
    { ruleId: "doc-mismatch@1", reasonCode: "DOC_MISMATCH", ttlMs: 3600_000 },
    c.w.policySigner,
  );
  c.ok(c.escrow.setHoldCall(c.t, toTypedJson(hold.setPayload), hold.setSignature));
  holdId = hold.id;
  revoked = enrollHuman(c.w.h, c.w.buyerAdmin, "EVIDENCE_UPLOADER", "Former clerk");
  const r = await a.http(c.w.buyerAdmin, "POST", `/v1/keys/${revoked.keyVersionId}/revoke`, {
    reason: "OFFBOARDED",
  });
  expect(r.status, r.text).toBe(201);
});
afterAll(async () => {
  await a.close();
});

function fingerprint(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of TABLES) out[t] = Number(a.w.c.w.h.db.get(`SELECT COUNT(*) AS n FROM ${t}`)?.["n"] ?? 0);
  return out;
}

const T = () => a.w.c.t;
const someTyped = () => toTypedJson({ schema: "x", nonce: newNonce() });
const sig = "ab".repeat(32);

/** Route, body, and the actors allowed to succeed (who are not called here). */
const MUTATIONS: { path: () => string; body: () => unknown; allowed: string[] }[] = [
  {
    path: () => `/v1/trades/${T()}/evidence`,
    body: () => ({
      slotId: "commercial-invoice",
      contentBase64: Buffer.from(pdf("x")).toString("base64"),
      issuer: { capability: "SUPPLIER_SIGNER", issuedAt: 1, signature: sig },
      expectedManifestRevision: 0,
    }),
    allowed: ["supplier", "supplierClerk"],
  },
  {
    path: () => `/v1/trades/${T()}/inspections`,
    body: () => ({ payload: someTyped(), signature: sig }),
    allowed: ["inspector"],
  },
  {
    path: () => `/v1/trades/${T()}/hold-challenges`,
    body: () => ({ reasonCode: "X", ttlMs: 600_000 }),
    allowed: ["risk"],
  },
  {
    path: () => `/v1/trades/${T()}/holds`,
    body: () => ({ payload: someTyped(), signature: sig }),
    allowed: ["risk"],
  },
  { path: () => `/v1/holds/${holdId}/resolution-requests`, body: () => ({ note: "n" }), allowed: ["buyer"] },
  {
    path: () => `/v1/holds/${holdId}/resolution-challenges`,
    body: () => ({ resolutionCode: "RELEASE_HOLD", evidenceDigest: "ab".repeat(32) }),
    allowed: ["risk"],
  },
  {
    path: () => `/v1/holds/${holdId}/resolution`,
    body: () => ({ payload: someTyped(), signature: sig }),
    allowed: ["risk"],
  },
  {
    path: () => `/v1/trades/${T()}/release-intents`,
    body: () => ({ idempotencyKey: `matrix-${newNonce().slice(0, 16)}` }),
    allowed: ["buyer"],
  },
  {
    path: () => `/v1/release-intents/${intentId}/signature`,
    body: () => ({ signature: sig }),
    allowed: ["buyer"],
  },
  { path: () => `/v1/release-intents/${intentId}/approval-challenges`, body: () => ({}), allowed: ["buyer"] },
  {
    path: () => `/v1/release-intents/${intentId}/approval`,
    body: () => ({ payload: toTypedJson({ releaseIntentId: intentId }), signature: sig }),
    allowed: ["buyer"],
  },
  { path: () => `/v1/release-intents/${intentId}/execute`, body: () => ({}), allowed: ["buyer"] },
  {
    path: () => `/v1/release-intents/${intentId}/cancel-challenges`,
    body: () => ({ reasonCode: "PARTIES_AGREE" }),
    allowed: ["buyer", "supplier"],
  },
  {
    path: () => `/v1/release-intents/${intentId}/cancel-consent-challenges`,
    body: () => ({ cancel: toTypedJson({ releaseIntentId: intentId }) }),
    allowed: ["buyer", "supplier"],
  },
  {
    path: () => `/v1/release-intents/${intentId}/cancel-consents`,
    body: () => ({
      cancel: toTypedJson({ releaseIntentId: intentId }),
      consent: someTyped(),
      signature: sig,
    }),
    allowed: ["buyer", "supplier"],
  },
  {
    path: () => `/v1/release-intents/${intentId}/abandon-challenges`,
    body: () => ({ trigger: "INTENT_EXPIRED" }),
    allowed: ["buyer", "supplier"],
  },
  {
    path: () => `/v1/release-intents/${intentId}/abandon`,
    body: () => ({ payload: toTypedJson({ releaseIntentId: intentId }), signature: sig }),
    allowed: ["buyer", "supplier"],
  },
  {
    path: () => `/v1/operations/${operationId}/reconciliation-requests`,
    body: () => ({}),
    allowed: ["risk"],
  },
  {
    path: () => `/v1/operations/${operationId}/adjudication-requests`,
    body: () => ({ note: "n" }),
    allowed: ["risk"],
  },
  {
    path: () => `/v1/operations/${operationId}/source-hints`,
    body: () => ({ kind: "TX_HASH", locator: "abc" }),
    allowed: ["risk"],
  },
  { path: () => `/v1/trades/${T()}/freeze`, body: () => ({ reason: "SUSPECTED_FRAUD" }), allowed: ["risk"] },
];

const READS = [
  () => `/v1/trades/${T()}`,
  () => `/v1/trades/${T()}/evidence`,
  () => `/v1/trades/${T()}/holds`,
  () => `/v1/trades/${T()}/release`,
  () => `/v1/trades/${T()}/payout`,
  () => `/v1/trades/${T()}/refund`,
  () => `/v1/trades/${T()}/timeline`,
  () => `/v1/trades/${T()}/attestor`,
  () => `/v1/operations/${operationId}`,
];

describe("T-003: integrated authority matrix denies cross-role action", () => {
  it("every forbidden actor is denied on every mutating route and nothing changes", async () => {
    const actors: [string, Actor | null][] = [
      ...(Object.entries(a.actors) as [string, Actor][]),
      ["revoked", revoked],
      ["unauthenticated", null],
    ];
    const before = fingerprint();
    let calls = 0;
    for (const m of MUTATIONS) {
      for (const [role, actor] of actors) {
        if (m.allowed.includes(role)) continue;
        const res = await a.http(actor, "POST", m.path(), m.body());
        calls++;
        expect(res.status, `${role} ${m.path()} ${res.text}`).toBeGreaterThanOrEqual(400);
        expect(DENIALS, `${role} ${m.path()} ${res.text}`).toContain(res.json.error.code);
      }
    }
    expect(calls).toBeGreaterThan(200);
    expect(fingerprint()).toEqual(before);
  });

  it("read routes disclose nothing to unrelated principals and require a session", async () => {
    const missing = `trd_${"0".repeat(32)}`;
    for (const p of READS) {
      for (const role of ["outsiderClerk", "outsiderAdmin"]) {
        const res = await a.http(a.actors[role] as Actor, "GET", p());
        expect(res.status, `${role} ${p()}`).toBe(404);
      }
      expect((await a.http(null, "GET", p())).status).toBe(401);
      expect((await a.http(revoked, "GET", p())).status).toBeGreaterThanOrEqual(401);
    }
    const hidden = await a.http(a.actors["outsiderAdmin"] as Actor, "GET", `/v1/trades/${T()}`);
    const none = await a.http(a.actors["outsiderAdmin"] as Actor, "GET", `/v1/trades/${missing}`);
    expect(hidden.text).toBe(none.text);
    for (const role of ["buyer", "supplier", "inspector", "risk", "auditor", "supplierClerk"])
      expect((await a.http(a.actors[role] as Actor, "GET", `/v1/trades/${T()}`)).status, role).toBe(200);
  });

  it("no route can force a terminal status or release a value lock", () => {
    expect(AUTHORIZATION_MATRIX.FORCE_TERMINAL_STATUS).toEqual([]);
    expect(AUTHORIZATION_MATRIX.RELEASE_VALUE_LOCK).toEqual([]);
    const routes = buildRoutes({} as never).map((r) => r.pattern.source);
    for (const s of routes) expect(s).not.toMatch(/paid|refunded|failed|force|terminal|unlock|disposition/i);
  });

  it("the contract boundary refuses the same cross-role signatures directly", async () => {
    const c = a.w.c;
    const t = c.t;
    const terms = c.w.evidence.terms(t);
    const now = c.w.h.clock.now();
    // A release intent signed by the supplier (not the buyer approver) cannot be created.
    const p = releaseIntentPayload(tradeBinding(terms), {
      network: terms.network,
      releaseIntentId: `rli_${"1".repeat(32)}`,
      amountYocto: terms.amountYocto,
      destination: terms.payout.destination,
      slices: [],
      intentExpiresAt: now + 3600_000,
      issuedAt: now,
      expiresAt: now + 600_000,
      nonce: newNonce(),
    });
    for (const who of [c.w.supplier, c.w.inspector, c.w.risk, a.auditor]) {
      const r = c.exec(c.escrow.createReleaseIntentCall(t, toTypedJson(p), c.sign(who, "RELEASE_INTENT", p)));
      expect(r.ok).toBe(false);
    }
    // A fresh hold SET claiming the risk role but signed by a party key is refused by the contract.
    for (const who of [c.w.buyer, c.w.supplier, c.w.inspector, a.auditor]) {
      const hp = holdSetPayload(tradeBinding(terms), {
        holdId: `hld_${newNonce().slice(0, 32)}`,
        manifestDigest: null,
        reasonCode: "FORGED",
        issuerRole: "RISK_RESOLVER",
        ruleId: null,
        issuedAt: now,
        expiresAt: now + 600_000,
        nonce: newNonce(),
      });
      const r = c.exec(c.escrow.setHoldCall(t, toTypedJson(hp), c.sign(who, "HOLD_SET", hp)));
      expect(r.ok).toBe(false);
    }
    // Control: the bound risk key's signature over the same shape is accepted.
    const ok = holdSetPayload(tradeBinding(terms), {
      holdId: `hld_${newNonce().slice(0, 32)}`,
      manifestDigest: null,
      reasonCode: "CONTROL",
      issuerRole: "RISK_RESOLVER",
      ruleId: null,
      issuedAt: now,
      expiresAt: now + 600_000,
      nonce: newNonce(),
    });
    c.ok(c.escrow.setHoldCall(t, toTypedJson(ok), c.sign(c.w.risk, "HOLD_SET", ok)));
  });
});
