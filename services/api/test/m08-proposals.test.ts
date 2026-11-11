/**
 * M08 server routes the browser needs to stay a signer, never a payload builder: trade proposals
 * (server-resolved key versions and service bindings, stored nowhere), the counterparty review,
 * the bound EvidencePolicy read and the inspector's challenge over the current attested manifest.
 * Every request is real HTTP with the actor's own PoP session; relays go to the compiled escrow.
 */
import { IsolatedSigner } from "@dockside/authority";
import { digestHexFor, fromTypedJson, type TypedJson } from "@dockside/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiWorld, apiWorld } from "./m07-world.js";

let a: ApiWorld;
let policySigner: IsolatedSigner;
beforeAll(async () => {
  a = await apiWorld();
  // The M03 world scopes its policy setter to one trade; proposals bind organisation-wide services.
  const h = a.w.c.w.h;
  const admin = a.actors.buyerAdmin;
  policySigner = await IsolatedSigner.spawn({ allowedPurposes: ["SERVICE_POP_CHALLENGE", "HOLD_SET"] });
  const e = h.svc.createServiceEnrollment(admin.ctx(), {
    serviceId: "deterministic-policy-org",
    capability: "DETERMINISTIC_POLICY_SET",
    publicKey: policySigner.publicKey,
    scope: { tradeId: null, evidencePolicyId: "commercial-docs", evidencePolicyRevision: 1 },
    custody: { kind: "ISOLATED_SIGNER_PROCESS", reference: "signer://deterministic-policy-org/v1" },
  });
  h.svc.proveServiceKey({
    challengeId: e.challenge.challengeId,
    signature: await policySigner.sign("SERVICE_POP_CHALLENGE", e.challenge.canonicalPayload),
  });
  h.svc.activateServiceKey(admin.ctx(), { enrollmentId: e.enrollmentId, keyVersion: 1 });
});
afterAll(async () => {
  policySigner.close();
  await a.close();
});

function proposalBody() {
  const { supplier, inspector, risk } = a.actors;
  return {
    supplierPrincipalId: supplier.principalId,
    inspectorPrincipalId: inspector.principalId,
    riskResolverPrincipalId: risk.principalId,
    buyerAccountId: "acme-buyer.testnet",
    supplierAccountId: "harbor-supplier.testnet",
    payoutDestination: "harbor-supplier.testnet",
    amountYocto: (3n * 10n ** 24n).toString(),
    milestone: { id: "shipment-2", description: "Second container loaded" },
    evidencePolicy: { id: "commercial-docs", revision: 1 },
    expiresInDays: 30,
  };
}

describe("M08 trade proposals", () => {
  it("builds exact terms from server-resolved bindings; both parties sign; the contract registers it", async () => {
    const { buyer, supplier } = a.actors;
    const p = await a.http(buyer, "POST", "/v1/trade-proposals", proposalBody());
    expect(p.status, p.text).toBe(201);
    expect(p.json.purpose).toBe("TRADE_REVISION");
    expect(p.json.bindingIssues).toEqual([]);
    expect(digestHexFor("TRADE_REVISION", fromTypedJson(p.json.payload as TypedJson))).toBe(p.json.digest);
    expect(p.json.terms.buyer.keyVersionId).toBe(buyer.keyVersionId);
    expect(p.json.terms.supplier.publicKey).toBe(supplier.key.publicKey);
    expect(p.json.terms.escrowContractId).toBe(a.w.c.escrow.contractId);
    const buyerSignature = a.sign(buyer, "TRADE_REVISION", p.json.payload);

    const review = await a.http(supplier, "POST", "/v1/trade-proposals/review", {
      terms: p.json.terms,
      buyerSignature,
    });
    expect(review.status, review.text).toBe(201);
    expect(review.json.digest).toBe(p.json.digest);
    expect(review.json.buyerSignatureValid).toBe(true);
    const forged = await a.http(supplier, "POST", "/v1/trade-proposals/review", {
      terms: p.json.terms,
      buyerSignature: a.sign(supplier, "TRADE_REVISION", p.json.payload),
    });
    expect(forged.json.buyerSignatureValid).toBe(false);

    const created = await a.http(supplier, "POST", "/v1/trades", {
      terms: p.json.terms,
      buyerSignature,
      supplierSignature: a.sign(supplier, "TRADE_REVISION", review.json.payload),
    });
    expect(created.status, created.text).toBe(201);
    a.relay(created);
    a.relay({ ...created, json: { relay: created.json.policyRelay } });
    const view = await a.w.c.escrow.getTrade(p.json.tradeId);
    expect(view).not.toBeNull();
    const pol = await a.http(buyer, "GET", `/v1/trades/${p.json.tradeId}/evidence-policy`);
    expect(pol.status, pol.text).toBe(200);
    expect(pol.json.policy.policyId).toBe("commercial-docs");
    expect(pol.json.digest).toBe(p.json.terms.evidencePolicy.digest);
  });

  it("refuses proposals from non-buyers and gives one answer for every unusable principal", async () => {
    const { supplier, buyer, auditor } = a.actors;
    expect((await a.http(supplier, "POST", "/v1/trade-proposals", proposalBody())).status).toBe(403);
    const asInspector = await a.http(buyer, "POST", "/v1/trade-proposals", {
      ...proposalBody(),
      inspectorPrincipalId: buyer.principalId,
    });
    const unknown = await a.http(buyer, "POST", "/v1/trade-proposals", {
      ...proposalBody(),
      inspectorPrincipalId: "prn_00000000000000000000000000000000",
    });
    expect(asInspector.status).toBe(400);
    expect(unknown.status).toBe(400);
    expect(asInspector.json.error.message).toBe(unknown.json.error.message);
    const reviewByOutsider = await a.http(auditor, "POST", "/v1/trade-proposals/review", {
      terms: (await a.http(buyer, "POST", "/v1/trade-proposals", proposalBody())).json.terms,
    });
    expect([403]).toContain(reviewByOutsider.status);
  });
});

describe("M08 inspection challenge", () => {
  it("is served only to the bound inspector and binds the current attestation", async () => {
    const t = a.w.c.t;
    const { inspector, buyer, otherInspector } = a.actors;
    const ch = await a.http(inspector, "POST", `/v1/trades/${t}/inspection-challenges`, {
      decision: "PASS",
      reasonCodes: ["DOCS_MATCH"],
    });
    expect(ch.status, ch.text).toBe(201);
    const payload = fromTypedJson(ch.json.payload as TypedJson) as Record<string, unknown>;
    expect(payload["manifestDigest"]).toBe(a.w.c.w.evidence.currentAttestation(t)?.manifestDigest);
    expect(digestHexFor("INSPECTION_ATTESTATION", fromTypedJson(ch.json.payload))).toBe(ch.json.digest);
    const rec = await a.http(inspector, "POST", `/v1/trades/${t}/inspections`, {
      payload: ch.json.payload,
      signature: a.sign(inspector, "INSPECTION_ATTESTATION", ch.json.payload),
    });
    expect(rec.status, rec.text).toBe(201);
    a.relay(rec);
    for (const other of [buyer, otherInspector]) {
      const r = await a.http(other, "POST", `/v1/trades/${t}/inspection-challenges`, {
        decision: "PASS",
        reasonCodes: ["DOCS_MATCH"],
      });
      expect([403, 404]).toContain(r.status);
    }
  });
});
