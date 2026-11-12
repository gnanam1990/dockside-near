/**
 * The client's endpoint catalog stays in lock-step with the real API router: every
 * `implemented` entry is served, every served route is in the catalog, and no `planned`
 * entry is silently served (when a module lands, its entry must flip to implemented and
 * the screen must be wired to the real projection).
 */
import { buildRoutes } from "@dockside/api";
import { describe, expect, it } from "vitest";
import { buildPath, ENDPOINTS, type EndpointSpec } from "../src/lib/api/endpoints";

const routes = buildRoutes({} as never);
const sampleId = `trd_${"a".repeat(32)}`;
const sampleRid = `rfd_${"b".repeat(32)}`;
const sample = (s: EndpointSpec) => buildPath(s, { id: sampleId, rid: sampleRid });
const served = (s: EndpointSpec) => routes.some((r) => r.method === s.method && r.pattern.test(sample(s)));

describe("endpoint catalog matches services/api", () => {
  const all = Object.values(ENDPOINTS) as EndpointSpec[];
  for (const s of all.filter((x) => x.availability === "implemented")) {
    it(`implemented ${s.method} ${s.path} is served with the same auth requirement`, () => {
      const r = routes.find((x) => x.method === s.method && x.pattern.test(sample(s)));
      expect(r, `${s.method} ${s.path}`).toBeDefined();
      expect(r?.auth).toBe(s.auth);
    });
  }
  for (const s of all.filter((x) => x.availability === "planned")) {
    it(`planned ${s.method} ${s.path} is not yet served (flip to implemented when it is)`, () => {
      expect(served(s)).toBe(false);
    });
  }
  it("every served route is in the catalog", () => {
    for (const r of routes) {
      const hit = all.some((s) => s.method === r.method && r.pattern.test(sample(s)));
      expect(hit, `${r.method} ${r.pattern}`).toBe(true);
    }
  });
  it("serves the destination-change and refund request and asset-recovery routes as implemented, none planned (M09, M10, M11)", () => {
    const ids = Object.keys(ENDPOINTS);
    for (const id of [
      "destinationChange",
      "destinationChangeChallenge",
      "destinationConsent",
      "destinationRevocationChallenge",
      "destinationRevocation",
      "destinationActivation",
      "destinationBinding",
      "tradeRefund",
      "refundChallenge",
      "refundRequestSignature",
      "refundCosignChallenge",
      "refundCosignature",
      "refundRevocationChallenge",
      "refundRevocation",
      "refundDisputeChallenge",
      "refundDispute",
      "refundAuthorization",
      "refundAuthorizationChallenge",
      "refundAuthorizationSignature",
      "refundExecute",
      "assetRecoveries",
      "assetRecoveryRequest",
      "assetRecoveryApprovalChallenge",
      "assetRecoveryApproval",
      "assetRecoveryChallengePayload",
      "assetRecoveryChallenge",
      "assetRecoveryRevocationChallenge",
      "assetRecoveryRevocation",
      "assetRecoveryExecute",
    ]) {
      expect(ids, id).toContain(id);
      const s = ENDPOINTS[id as keyof typeof ENDPOINTS] as EndpointSpec;
      expect(s.availability, id).toBe("implemented");
      expect(served(s), id).toBe(true);
    }
    expect(all.filter((x) => x.availability === "planned")).toEqual([]);
  });
  it("refuses identifiers the router would not accept", () => {
    expect(() => buildPath(ENDPOINTS.getTrade, { id: "../../v1/audit" })).toThrow();
    expect(() => buildPath(ENDPOINTS.getTrade, {})).toThrow();
  });
});
