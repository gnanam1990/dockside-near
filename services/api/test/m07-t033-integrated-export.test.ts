/**
 * M07 positive path and audit export (T-033) over the real HTTP API: evidence upload, inspection,
 * a risk hold SET / buyer review request / risk RESOLVE, release intent, buyer approval, queued
 * direct release, the M05 outbox worker and reconciler against the simulated chain server, the
 * resulting PAID projection, and a checksummed export that links every revision and authority.
 * Simulated: NEAR (compiled escrow wasm on the M02 host over JSON-RPC), not testnet.
 */
import { newNonce, toTypedJson } from "@dockside/core";
import { inspectionPayload } from "@dockside/evidence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pdf, png } from "../../../packages/evidence/test/world.js";
import { verifyAuditExport } from "../src/export.js";
import { type ApiWorld, apiWorld, lockAndApprove, riskHold, run } from "./m07-world.js";

let a: ApiWorld;
beforeAll(async () => {
  a = await apiWorld({ evidence: false });
});
afterAll(async () => {
  await a.close();
});

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

describe("M07 integrated API: evidence to PAID over HTTP", () => {
  let exported: any;
  let operationId = "";
  let holdId = "";
  let intentId = "";

  it("lists the trade only for principals related to it", async () => {
    const { buyer, outsiderClerk, inspector } = a.actors as any;
    const mine = await a.http(buyer, "GET", "/v1/trades");
    expect(mine.status).toBe(200);
    expect(mine.json.trades.map((t: any) => t.tradeId)).toEqual([a.w.c.t]);
    expect(mine.json.trades[0].relations).toEqual(expect.arrayContaining(["BUYER", "BUYER_ORG"]));
    expect((await a.http(inspector, "GET", "/v1/trades")).json.trades[0].relations).toEqual(["INSPECTOR"]);
    expect((await a.http(outsiderClerk, "GET", "/v1/trades")).json.trades).toEqual([]);
  });

  it("uploads evidence and records the bound inspector's PASS over HTTP", async () => {
    const c = a.w.c;
    const t = c.t;
    const { supplier, inspector } = a.actors as any;
    const up = async (actor: any, cap: string, slotId: string, content: Uint8Array) => {
      const rev = (await a.http(actor, "GET", `/v1/trades/${t}/evidence`)).json.manifest.revision;
      const res = await a.http(actor, "POST", `/v1/trades/${t}/evidence`, {
        slotId,
        contentBase64: b64(content),
        issuer: c.w.issue(actor, cap, slotId, content),
        expectedManifestRevision: rev,
      });
      expect(res.status, res.text).toBe(201);
      return res.json;
    };
    await up(
      supplier,
      "SUPPLIER_SIGNER",
      "commercial-invoice",
      pdf("Commercial invoice INV-7 total 10 NEAR"),
    );
    await up(
      inspector,
      "INSPECTOR",
      "inspection-report",
      new TextEncoder().encode("Report: 12 pallets, sealed.\n"),
    );
    await up(inspector, "INSPECTOR", "cargo-photos", png(24, 12));
    const ev = await a.http(supplier, "GET", `/v1/trades/${t}/evidence`);
    expect(ev.json.evaluation.status).toBe("COMPLETE");
    // Stale optimistic revision is refused.
    const stale = await a.http(supplier, "POST", `/v1/trades/${t}/evidence`, {
      slotId: "commercial-invoice",
      contentBase64: b64(pdf("late")),
      issuer: c.w.issue(supplier, "SUPPLIER_SIGNER", "commercial-invoice", pdf("late")),
      expectedManifestRevision: 0,
    });
    expect(stale.json.error.code).toBe("VERSION_CONFLICT");

    // The ManifestAttestor signs in its own isolated process (service side, no session).
    const att = await c.w.evidence.attest(t, c.w.attestor);
    c.ok(c.escrow.submitManifestAttestationCall(t, att.typed, att.signature));
    const attestor = await a.http(supplier, "GET", `/v1/trades/${t}/attestor`);
    expect(attestor.json.issues).toEqual([]);
    expect(attestor.json.currentAttestation).toBe(att.digest);

    const now = c.w.h.clock.now();
    const ip = inspectionPayload(c.w.evidence.terms(t), {
      manifestRevision: att.manifestRevision,
      manifestDigest: att.manifestDigest,
      decision: "PASS",
      reasonCodes: ["DOCS_MATCH"],
      issuedAt: now,
      expiresAt: now + 7 * 24 * 3600_000,
      nonce: newNonce(),
    });
    const typed = toTypedJson(ip);
    // Another inspector of the same organisation is not the one this revision binds.
    const other = await a.http(a.actors["otherInspector"] ?? null, "POST", `/v1/trades/${t}/inspections`, {
      payload: typed,
      signature: a.sign(a.actors["otherInspector"] as any, "INSPECTION_ATTESTATION", typed),
    });
    expect(other.status).toBe(404);
    const rec = await a.http(inspector, "POST", `/v1/trades/${t}/inspections`, {
      payload: typed,
      signature: a.sign(inspector, "INSPECTION_ATTESTATION", typed),
    });
    a.relay(rec);
    const view = await a.http(supplier, "GET", `/v1/trades/${t}`);
    expect(view.json.inspection.decision).toBe("PASS");
    expect(view.json.attestation.status).toBe("CURRENT");
    expect(view.json.release.blockers).toContain("NO_RELEASE_INTENT");
  });

  it("risk SETs a hold, the buyer's review request changes nothing, only risk RESOLVEs", async () => {
    const t = a.w.c.t;
    const { buyer, risk } = a.actors as any;
    holdId = await riskHold(a);
    const req = await a.http(buyer, "POST", `/v1/holds/${holdId}/resolution-requests`, {
      note: "please review",
    });
    expect(req.status, req.text).toBe(201);
    expect(req.json.authorizing).toBe(false);
    expect(req.json.holdStatus).toBe("ACTIVE");
    const view = await a.http(buyer, "GET", `/v1/trades/${t}/holds`);
    expect(view.json.blocking).toBe(1);
    expect(view.json.holds[0].resolutionRequests).toHaveLength(1);
    expect((await a.http(buyer, "GET", `/v1/trades/${t}`)).json.release.blockers).toContain("HOLD_ACTIVE");
    const ch = await a.http(risk, "POST", `/v1/holds/${holdId}/resolution-challenges`, {
      resolutionCode: "RELEASE_HOLD",
      evidenceDigest: "ab".repeat(32),
    });
    expect(ch.status, ch.text).toBe(201);
    const res = await a.http(risk, "POST", `/v1/holds/${holdId}/resolution`, {
      payload: ch.json.payload,
      signature: a.sign(risk, "HOLD_RESOLVE", ch.json.payload),
    });
    a.relay(res);
    expect(res.json.hold.status).toBe("RESOLVED");
    expect((await a.http(buyer, "GET", `/v1/trades/${t}/holds`)).json.blocking).toBe(0);
  });

  it("buyer locks, approves and queues the release; the worker reaches PAID with provenance", async () => {
    const t = a.w.c.t;
    const { buyer, supplier } = a.actors as any;
    intentId = await lockAndApprove(a);
    const exec = await a.http(
      buyer,
      "POST",
      `/v1/release-intents/${intentId}/execute`,
      {},
      {
        "idempotency-key": "execute-0001",
      },
    );
    expect(exec.status, exec.text).toBe(201);
    expect(exec.json.state).toBe("QUEUED");
    operationId = exec.json.operationId;
    const again = await a.http(
      buyer,
      "POST",
      `/v1/release-intents/${intentId}/execute`,
      {},
      {
        "idempotency-key": "execute-0001",
      },
    );
    expect(again.headers.get("idempotent-replay")).toBe("true");
    expect(again.json.operationId).toBe(operationId);
    // The supplier cannot queue the buyer's release.
    expect((await a.http(supplier, "POST", `/v1/release-intents/${intentId}/execute`)).json.error.code).toBe(
      "FORBIDDEN",
    );
    await run(a.w);
    const op = await a.http(supplier, "GET", `/v1/operations/${operationId}`);
    expect(op.json.state).toBe("PAID");
    expect(op.json.submitCount).toBe(1);
    expect(op.json.disposition.outcome).toBe("PAID");
    expect(op.json.observations.length).toBeGreaterThan(0);
    const payout = await a.http(supplier, "GET", `/v1/trades/${t}/payout`);
    expect(payout.json.operations[0].state).toBe("PAID");
    expect(payout.json.fundedPayout.status).toBe("BLOCKED");
    const list = await a.http(supplier, "GET", "/v1/payouts");
    expect(list.json.payouts).toHaveLength(1);
  });

  it("T-033: the auditor's checksummed export links revisions, authorities, holds, release, attempt and receipt", async () => {
    const t = a.w.c.t;
    const c = a.w.c;
    const res = await a.http(a.auditor, "GET", `/v1/trades/${t}/audit-export`);
    expect(res.status, res.text).toBe(200);
    exported = res.json;
    expect(verifyAuditExport(exported).ok).toBe(true);
    const s = exported.sections;
    expect(s.revisions[0].terms_digest).toMatch(/^[0-9a-f]{64}$/);
    const terms = c.w.evidence.terms(t);
    for (const p of [terms.buyer, terms.supplier, terms.inspector, terms.riskResolver]) {
      const kv = s.authorities.keyVersions.find((k: any) => k.id === p.keyVersionId);
      expect(kv, p.principalId).toBeDefined();
      expect(kv.public_key).toBe(p.publicKey);
      expect(kv.status).toBe("ACTIVE");
    }
    const enrollments = s.authorities.serviceEnrollments.map((e: any) => e.id).sort();
    expect(enrollments).toEqual(
      [terms.manifestAttestor.enrollmentId, terms.policySetter.enrollmentId].sort(),
    );
    expect(s.authorities.serviceEnrollments[0].scope).toBeDefined();
    expect(s.manifests.length).toBeGreaterThanOrEqual(3);
    expect(["CURRENT", "SUPERSEDED", "EXPIRED", "STALE", "INVALIDATED"]).toContain(s.attestations[0].status);
    expect(s.attestations[0].manifest_digest).toBe(s.inspections[0].manifest_digest);
    expect(s.inspections[0].decision).toBe("PASS");
    expect(s.holds.map((h: any) => h.id)).toEqual([holdId]);
    expect(s.holdResolutions[0].resolution_code).toBe("RELEASE_HOLD");
    expect(s.holdResolutionRequests[0].note_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(s.releaseIntents.map((i: any) => i.intent_id)).toEqual([intentId]);
    expect(s.releaseSignatures.map((x: any) => x.kind)).toContain("BUYER_APPROVAL");
    expect(s.operations[0].operation_id).toBe(operationId);
    expect(s.operations[0].state).toBe("PAID");
    expect(s.operations[0].attempt_id).toBeTruthy();
    expect(s.operations[0].signed_tx_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(s.dispositions[0].outcome).toBe("PAID");
    expect(
      s.observations.some(
        (o: any) => o.source === "RECEIPT" || o.source === "TX_STATUS" || o.source === "CONTRACT",
      ),
    ).toBe(true);
    expect(s.fundedAuthorizations).toEqual([]);
    expect(exported.chain.ledger.conservation).toBe(true);
    expect(exported.integrity.auditChain.ok).toBe(true);
    const types = new Set(s.auditEvents.map((e: any) => e.eventType));
    for (const ev of [
      "HOLD_SET",
      "HOLD_RESOLVED",
      "HOLD_RESOLUTION_REQUESTED",
      "RELEASE_EXECUTION_REQUESTED",
    ])
      expect(types.has(ev), ev).toBe(true);
    expect(exported.exclusions.map((x: any) => x.item)).toEqual(
      expect.arrayContaining([
        "quotes and funded payout authorizations",
        "evidence content bytes and derived text",
      ]),
    );
  });

  it("T-033: any change, reordering-insensitive, to the export breaks the checksum", () => {
    const clone = () => JSON.parse(JSON.stringify(exported));
    const reordered = clone();
    const { checksum, ...rest } = reordered;
    const flipped = Object.fromEntries(Object.entries(rest).reverse());
    expect(verifyAuditExport({ ...flipped, checksum }).ok).toBe(true);
    const mutations: ((x: any) => void)[] = [
      (x) => (x.sections.holds[0].reason_code = "NONE"),
      (x) => x.sections.auditEvents.pop(),
      (x) => (x.sections.operations[0].state = "FAILED"),
      (x) => (x.sections.authorities.keyVersions[0].public_key = "ed25519:tampered"),
      (x) => (x.chain.ledger.conservation = false),
      (x) => (x.exclusions = []),
      (x) => (x.checksum = "0".repeat(64)),
    ];
    for (const m of mutations) {
      const x = clone();
      m(x);
      expect(verifyAuditExport(x).ok).toBe(false);
    }
  });

  it("export authority: auditor and party admins yes, uploader no, outsider sees nothing", async () => {
    const t = a.w.c.t;
    const { supplierAdmin, supplierClerk, outsiderClerk } = a.actors as any;
    expect((await a.http(supplierAdmin, "GET", `/v1/trades/${t}/audit-export`)).status).toBe(200);
    expect((await a.http(supplierClerk, "GET", `/v1/trades/${t}/audit-export`)).json.error.code).toBe(
      "FORBIDDEN",
    );
    // The capability check precedes the trade lookup, so the answer is the same for any trade id.
    const outsider = await a.http(outsiderClerk, "GET", `/v1/trades/${t}/audit-export`);
    const unknown = await a.http(outsiderClerk, "GET", `/v1/trades/trd_${"0".repeat(32)}/audit-export`);
    expect(outsider.status).toBe(403);
    expect(outsider.text).toBe(unknown.text);
    // An unrelated security admin holds EXPORT_AUDIT but has no relation to the trade.
    const otherAdmin = a.actors["outsiderAdmin"] as any;
    const hidden = await a.http(otherAdmin, "GET", `/v1/trades/${t}/audit-export`);
    const missing = await a.http(otherAdmin, "GET", `/v1/trades/trd_${"0".repeat(32)}/audit-export`);
    expect(hidden.status).toBe(404);
    expect(hidden.text).toBe(missing.text);
    expect((await a.http(null, "GET", `/v1/trades/${t}/audit-export`)).status).toBe(401);
    const tl = await a.http(supplierAdmin, "GET", `/v1/trades/${t}/timeline`);
    expect(tl.json.events.map((e: any) => e.eventType)).toContain("AUDIT_EXPORTED");
  });
});
