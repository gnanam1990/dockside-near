/**
 * M12: read models behind the key-management screens, over the real HTTP API (PoP sessions and
 * request proofs) with the M07 world (compiled escrow wasm on the simulated NEAR host, isolated
 * attestor and policy signer processes). Every mutation below goes through the existing M01
 * routes; the new routes only read what the authority service persisted.
 *
 * Covered: organization directory and own-key views; per-organization trade-binding impact; a
 * rotated service key, a rotated human key and a recovered human key each make the bound trade
 * revision require a new revision; the attestor view lists the organization's attestors with
 * bound/coverage facts (wrong attestor, wrong scope, wrong key version).
 * Simulated: the NEAR chain, not testnet.
 */
import { digestHexFor, fromTypedJson, generateEd25519KeyPair, signFor, type TypedJson } from "@dockside/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Actor } from "../../../packages/authority/test/helpers.js";
import { type ApiWorld, apiWorld } from "./m07-world.js";

let a: ApiWorld;
beforeAll(async () => {
  a = await apiWorld();
});
afterAll(async () => {
  await a.close();
});

const actor = (role: string) => a.actors[role] as Actor;
const trade = () => a.w.c.t;

/** Sign a served human PoP challenge after recomputing its digest from the typed payload. */
function popProof(
  key: ReturnType<typeof generateEd25519KeyPair>,
  ch: { payload: TypedJson; digestHex: string },
) {
  const payload = fromTypedJson(ch.payload);
  expect(digestHexFor("POP_CHALLENGE", payload)).toBe(ch.digestHex);
  return { scheme: "dockside-ed25519", signature: signFor(key.privateKey, "POP_CHALLENGE", payload) };
}

function serviceSignature(
  key: ReturnType<typeof generateEd25519KeyPair>,
  ch: { payload: TypedJson; digestHex: string },
) {
  const payload = fromTypedJson(ch.payload);
  expect(digestHexFor("SERVICE_POP_CHALLENGE", payload)).toBe(ch.digestHex);
  return signFor(key.privateKey, "SERVICE_POP_CHALLENGE", payload);
}

async function login(principalId: string, key: ReturnType<typeof generateEd25519KeyPair>): Promise<Actor> {
  const person = new Actor(a.w.c.w.h, key);
  const ch = await a.http(null, "POST", "/v1/sessions/challenges", { principalId, publicKey: key.publicKey });
  expect(ch.status, ch.text).toBe(201);
  const done = await a.http(null, "POST", "/v1/sessions/complete", {
    challengeId: ch.json.challengeId,
    proof: popProof(key, ch.json),
  });
  expect(done.status, done.text).toBe(201);
  person.grant = done.json;
  return person;
}

async function bindingsFor(admin: Actor) {
  const r = await a.http(admin, "GET", "/v1/organization/trade-bindings");
  expect(r.status, r.text).toBe(200);
  return r.json.trades.find((t: { tradeId: string }) => t.tradeId === trade()) as {
    requiresNewRevision: boolean;
    roles: { role: string; keyVersion: number; issues: string[] }[];
  };
}

describe("organization directory and own keys", () => {
  it("a security admin sees its own organization's principals, keys, services and recoveries", async () => {
    const r = await a.http(actor("buyerAdmin"), "GET", "/v1/organization/directory");
    expect(r.status, r.text).toBe(200);
    const d = r.json;
    expect(d.organization.id).toBe(actor("buyerAdmin").organizationId);
    const ids = d.principals.map((p: { id: string }) => p.id);
    expect(ids).toContain(actor("buyer").principalId);
    expect(ids).toContain(actor("risk").principalId);
    expect(ids).not.toContain(actor("supplier").principalId);
    const buyer = d.principals.find((p: { id: string }) => p.id === actor("buyer").principalId);
    expect(buyer.capabilities).toEqual(["BUYER_APPROVER"]);
    expect(buyer.keys.map((k: { status: string }) => k.status)).toEqual(["ACTIVE"]);
    const att = d.services.find((s: { id: string }) => s.id === a.w.c.w.attestorEnrollment);
    expect(att.capability).toBe("MANIFEST_ATTEST");
    expect(att.versions[0].custodyKind).toBe("ISOLATED_SIGNER_PROCESS");
    // The custody locator is never served.
    expect(r.text).not.toContain("signer://");
    expect(d.recoveryDelayMs).toBeGreaterThan(0);
  });

  it("non-admins and other organizations cannot read the directory", async () => {
    for (const role of ["buyer", "supplier", "inspector", "risk"]) {
      const r = await a.http(actor(role), "GET", "/v1/organization/directory");
      expect(r.status, role).toBe(403);
      expect(r.json.error.code).toBe("FORBIDDEN");
    }
    const other = await a.http(actor("outsiderAdmin"), "GET", "/v1/organization/directory");
    expect(other.status).toBe(200);
    expect(other.text).not.toContain(actor("buyer").principalId);
    const none = await a.http(null, "GET", "/v1/organization/directory");
    expect(none.status).toBe(401);
  });

  it("every principal reads only its own key history", async () => {
    const r = await a.http(actor("supplier"), "GET", "/v1/me/keys");
    expect(r.status, r.text).toBe(200);
    expect(r.json.principalId).toBe(actor("supplier").principalId);
    expect(r.json.currentKeyVersionId).toBe(actor("supplier").keyVersionId);
    expect(r.json.keys).toHaveLength(1);
    expect(r.json.recoveries).toEqual([]);
  });
});

describe("trade-binding impact before any change", () => {
  it("lists only the roles bound to the caller's organization, all current", async () => {
    const buyerSide = await bindingsFor(actor("buyerAdmin"));
    expect(buyerSide.requiresNewRevision).toBe(false);
    expect(buyerSide.roles.map((r) => r.role).sort()).toEqual([
      "buyer",
      "manifestAttestor",
      "policySetter",
      "riskResolver",
    ]);
    for (const r of buyerSide.roles) expect(r.issues).toEqual([]);
    const supplierSide = await bindingsFor(actor("supplierAdmin"));
    expect(supplierSide.roles.map((r) => r.role)).toEqual(["supplier"]);
    const outsider = await a.http(actor("outsiderAdmin"), "GET", "/v1/organization/trade-bindings");
    expect(outsider.json.trades).toEqual([]);
    const denied = await a.http(actor("buyer"), "GET", "/v1/organization/trade-bindings");
    expect(denied.status).toBe(403);
    const t = await a.http(actor("buyer"), "GET", `/v1/trades/${trade()}`);
    expect(t.json.authority).toEqual({ current: true, requiresNewRevision: false, issues: [] });
    expect(t.json.attestation.status).toBe("CURRENT");
  });
});

describe("wrong attestor scope: an attestor enrolled for another policy revision", () => {
  it("is listed for the trade as SCOPE_MISMATCH and not bound", async () => {
    const admin = actor("buyerAdmin");
    const key = generateEd25519KeyPair();
    const e = await a.http(admin, "POST", "/v1/service-enrollments", {
      serviceId: "attestor-policy-v2",
      capability: "MANIFEST_ATTEST",
      publicKey: key.publicKey,
      scope: { tradeId: null, evidencePolicyId: "commercial-docs", evidencePolicyRevision: 2 },
      custody: { kind: "HSM", reference: "hsm://slot-7/attestor-v2" },
    });
    expect(e.status, e.text).toBe(201);
    const proved = await a.http(null, "POST", "/v1/service-enrollments/prove", {
      challengeId: e.json.challenge.challengeId,
      signature: serviceSignature(key, e.json.challenge),
    });
    expect(proved.status, proved.text).toBe(201);
    const act = await a.http(admin, "POST", `/v1/service-enrollments/${e.json.enrollmentId}/activate`, {
      keyVersion: 1,
    });
    expect(act.status, act.text).toBe(201);
    const view = await a.http(actor("buyer"), "GET", `/v1/trades/${trade()}/attestor`);
    expect(view.status, view.text).toBe(200);
    const listed = view.json.organizationAttestors as {
      enrollmentId: string;
      boundByRevision: boolean;
      coverage: string;
      activeKeyVersion: number;
    }[];
    const other = listed.find((x) => x.enrollmentId === e.json.enrollmentId);
    expect(other).toMatchObject({ boundByRevision: false, coverage: "SCOPE_MISMATCH", activeKeyVersion: 1 });
    const bound = listed.find((x) => x.boundByRevision);
    expect(bound).toMatchObject({ enrollmentId: a.w.c.w.attestorEnrollment, coverage: "COVERS" });
    // The supplier's organization enrolled no attestor: nothing of the buyer's is listed to it.
    const sup = await a.http(actor("supplier"), "GET", `/v1/trades/${trade()}/attestor`);
    expect(sup.json.organizationAttestors).toEqual([]);
  });
});

describe("a rotated ManifestAttestor key (wrong key version) requires a new trade revision", () => {
  it("supersedes the bound version, invalidates the attestation and flags the trade", async () => {
    const admin = actor("buyerAdmin");
    const key = generateEd25519KeyPair();
    const rot = await a.http(admin, "POST", `/v1/service-enrollments/${a.w.c.w.attestorEnrollment}/rotate`, {
      publicKey: key.publicKey,
      custody: { kind: "ISOLATED_SIGNER_PROCESS", reference: "signer://manifest-attestor/v2" },
    });
    expect(rot.status, rot.text).toBe(201);
    expect(rot.json.keyVersion).toBe(2);
    const proved = await a.http(null, "POST", "/v1/service-enrollments/prove", {
      challengeId: rot.json.challenge.challengeId,
      signature: serviceSignature(key, rot.json.challenge),
    });
    expect(proved.status, proved.text).toBe(201);
    const act = await a.http(
      admin,
      "POST",
      `/v1/service-enrollments/${a.w.c.w.attestorEnrollment}/activate`,
      {
        keyVersion: 2,
      },
    );
    expect(act.status, act.text).toBe(201);

    const b = await bindingsFor(admin);
    expect(b.requiresNewRevision).toBe(true);
    const att = b.roles.find((r) => r.role === "manifestAttestor");
    expect(att).toMatchObject({ keyVersion: 1, issues: ["KEY_SUPERSEDED"] });
    const t = await a.http(actor("buyer"), "GET", `/v1/trades/${trade()}`);
    expect(t.json.authority.requiresNewRevision).toBe(true);
    expect(t.json.authority.issues).toContainEqual({ role: "manifestAttestor", code: "KEY_SUPERSEDED" });
    // The trade projection no longer reports a current attestation.
    expect(t.json.attestation === null || t.json.attestation.status !== "CURRENT").toBe(true);
    const view = await a.http(actor("inspector"), "GET", `/v1/trades/${trade()}/attestor`);
    expect(view.json.issues).toEqual([{ role: "manifestAttestor", code: "KEY_SUPERSEDED" }]);
    const list = await a.http(actor("supplier"), "GET", "/v1/trades");
    const row = list.json.trades.find((x: { tradeId: string }) => x.tradeId === trade());
    expect(row.requiresNewRevision).toBe(true);
    const dir = await a.http(admin, "GET", "/v1/organization/directory");
    const svc = dir.json.services.find((s: { id: string }) => s.id === a.w.c.w.attestorEnrollment);
    expect(svc.versions.map((v: { status: string }) => v.status)).toEqual(["SUPERSEDED", "ACTIVE"]);
    expect(svc.versions[0].supersededAt).toBeGreaterThan(0);
  });
});

describe("a rotated human key requires a new trade revision", () => {
  it("the buyer's old version is SUPERSEDED, the new session is not the bound key", async () => {
    const buyer = actor("buyer");
    const key = generateEd25519KeyPair();
    const ch = await a.http(buyer, "POST", "/v1/keys/rotation/challenges", { publicKey: key.publicKey });
    expect(ch.status, ch.text).toBe(201);
    const done = await a.http(buyer, "POST", "/v1/keys/rotation/complete", {
      challengeId: ch.json.challengeId,
      proof: popProof(key, ch.json),
    });
    expect(done.status, done.text).toBe(201);
    expect(done.json.version).toBe(2);
    // The old session died with the old key.
    expect((await a.http(buyer, "GET", "/v1/me")).status).toBe(401);
    const fresh = await login(buyer.principalId, key);
    const mine = await a.http(fresh, "GET", "/v1/me/keys");
    expect(mine.json.keys.map((k: { status: string }) => k.status)).toEqual(["SUPERSEDED", "ACTIVE"]);
    const b = await bindingsFor(actor("buyerAdmin"));
    expect(b.roles.find((r) => r.role === "buyer")).toMatchObject({
      keyVersion: 1,
      issues: ["KEY_SUPERSEDED"],
    });
    // Acting on the trade with the new key is refused: the revision binds version 1.
    const prep = await a.http(fresh, "POST", `/v1/trades/${trade()}/release-intents`, {
      idempotencyKey: "m12-rotated-buyer-0001",
    });
    expect(prep.status).toBeGreaterThanOrEqual(400);
    expect(prep.json.error.code).toBe("KEY_NOT_BOUND");
  });
});

describe("a recovered human key requires a new trade revision", () => {
  it("a different admin starts, the principal proves, the delay holds, completion revokes the bound key", async () => {
    const admin = actor("buyerAdmin");
    const risk = actor("risk");
    const key = generateEd25519KeyPair();
    const start = await a.http(admin, "POST", "/v1/recoveries", {
      principalId: risk.principalId,
      publicKey: key.publicKey,
    });
    expect(start.status, start.text).toBe(201);
    const recoveryId = start.json.recoveryId as string;
    // New authority is frozen at once: the suspended key's session no longer works.
    expect((await a.http(risk, "GET", "/v1/me")).status).toBeGreaterThanOrEqual(400);
    const proved = await a.http(null, "POST", "/v1/recoveries/prove", {
      challengeId: start.json.challenge.challengeId,
      proof: popProof(key, start.json.challenge),
    });
    expect(proved.status, proved.text).toBe(201);
    const dir = await a.http(admin, "GET", "/v1/organization/directory");
    const rec = dir.json.recoveries.find((r: { id: string }) => r.id === recoveryId);
    expect(rec).toMatchObject({ status: "WAITING", principalId: risk.principalId, newKeyVersion: 2 });
    const early = await a.http(admin, "POST", `/v1/recoveries/${recoveryId}/complete`, {});
    expect(early.json.error.code).toBe("DELAY_NOT_ELAPSED");
    const during = await bindingsFor(admin);
    expect(during.roles.find((r) => r.role === "riskResolver")?.issues).toEqual(["KEY_REVOKED"]);
    a.w.c.w.h.clock.advance(dir.json.recoveryDelayMs + 1000);
    // Sessions are hours long; the administrator signs in again after the multi-day delay.
    const admin2 = await login(admin.principalId, admin.key);
    const done = await a.http(admin2, "POST", `/v1/recoveries/${recoveryId}/complete`, {});
    expect(done.status, done.text).toBe(201);
    const after = await bindingsFor(admin2);
    expect(after.roles.find((r) => r.role === "riskResolver")?.issues).toEqual(["KEY_REVOKED"]);
    const fresh = await login(risk.principalId, key);
    const mine = await a.http(fresh, "GET", "/v1/me/keys");
    expect(
      mine.json.keys.map((k: { status: string; revokeReason: string | null }) => [k.status, k.revokeReason]),
    ).toEqual([
      ["REVOKED", "RECOVERED"],
      ["ACTIVE", null],
    ]);
    expect(mine.json.recoveries[0]).toMatchObject({ id: recoveryId, status: "COMPLETED" });
  });
});
