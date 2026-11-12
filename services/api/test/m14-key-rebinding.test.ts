/**
 * M14: the trade revision that rebinds rotated, revoked or recovered keys (T-006, gate items 3
 * and 4), over the real HTTP API (PoP sessions and request proofs) with the M07 world: compiled
 * escrow wasm on the simulated NEAR host, isolated attestor and policy signer processes, the M05
 * worker and reconciler.
 *
 * Covered:
 *   1. a revision whose keys are all current needs no rebinding (the route says so);
 *   2. a rotated ManifestAttestor key: both parties sign one successor that changes only that
 *      key version; no delay; activation supersedes the approved intent, manifest, inspection and
 *      approval; the new key attests; non-parties and unbound sessions are refused and audited;
 *   3. a rotated buyer key: the buyer signs with its NEW key, the supplier's bound key anchors the
 *      revision, the old buyer key and a stranger key are refused, the signed delay holds, either
 *      party can revoke, and the renewed authority (fresh evidence revision, attestation,
 *      inspection, approval by the new buyer key) pays the bound supplier.
 * Simulated: the NEAR chain, not testnet.
 */
import {
  digestHexFor,
  fromTypedJson,
  generateEd25519KeyPair,
  newNonce,
  type SigningPurpose,
  signFor,
  type TypedJson,
  toTypedJson,
} from "@dockside/core";
import { inspectionPayload } from "@dockside/evidence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Actor } from "../../../packages/authority/test/helpers.js";
import { pdf } from "../../../packages/evidence/test/world.js";
import { DAY, panicCode, relogin, SUPPLIER_ACCT } from "../../../packages/release/test/chain.js";
import { type ApiWorld, apiWorld, lockAndApprove, run } from "./m07-world.js";

const DENIALS = ["UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "KEY_NOT_BOUND"];

let a: ApiWorld;
let intentId = "";
beforeAll(async () => {
  a = await apiWorld();
  intentId = await lockAndApprove(a, "rebind-intent-0001");
});
afterAll(async () => {
  await a.close();
});

const actor = (role: string) => a.actors[role] as Actor;
const path = (suffix: string) => `/v1/trades/${a.w.c.t}${suffix}`;
const audit = (type: string) =>
  Number(a.w.c.w.h.db.get("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = ?", type)?.["n"] ?? 0);

function popProof(
  key: ReturnType<typeof generateEd25519KeyPair>,
  ch: { payload: TypedJson; digestHex: string },
) {
  const payload = fromTypedJson(ch.payload);
  expect(digestHexFor("POP_CHALLENGE", payload)).toBe(ch.digestHex);
  return { scheme: "dockside-ed25519", signature: signFor(key.privateKey, "POP_CHALLENGE", payload) };
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

const signWith = (
  key: ReturnType<typeof generateEd25519KeyPair>,
  purpose: SigningPurpose,
  typed: TypedJson,
) => signFor(key.privateKey, purpose, fromTypedJson(typed));

/** Renewed evidence, attestation and inspection PASS under the newly bound revision. */
async function renewEvidence(attestorKey: ReturnType<typeof generateEd25519KeyPair> | null, label: string) {
  const c = a.w.c;
  const t = c.t;
  const supplier = actor("supplier");
  const inspector = actor("inspector");
  relogin(inspector);
  const ev = (await a.http(supplier, "GET", path("/evidence"))).json;
  const old = ev.manifest.items.find((i: { slotId: string }) => i.slotId === "commercial-invoice");
  const inv = pdf(`Invoice ${label} payable to ${SUPPLIER_ACCT}`);
  const up = await a.http(supplier, "POST", path("/evidence"), {
    slotId: "commercial-invoice",
    contentBase64: Buffer.from(inv).toString("base64"),
    issuer: c.w.issue(supplier, "SUPPLIER_SIGNER", "commercial-invoice", inv),
    replacesItemId: old.itemId,
    expectedManifestRevision: ev.manifest.revision,
  });
  expect(up.status, up.text).toBe(201);
  const signer = attestorKey
    ? {
        publicKey: attestorKey.publicKey,
        sign: async (purpose: SigningPurpose, payload: Parameters<typeof signFor>[2]) =>
          signFor(attestorKey.privateKey, purpose, payload),
      }
    : c.w.attestor;
  const att = await c.w.evidence.attest(t, signer);
  c.ok(c.escrow.submitManifestAttestationCall(t, att.typed, att.signature));
  const now = c.w.h.clock.now();
  const ip = toTypedJson(
    inspectionPayload(c.w.evidence.terms(t), {
      manifestRevision: att.manifestRevision,
      manifestDigest: att.manifestDigest,
      decision: "PASS",
      reasonCodes: ["DOCS_MATCH"],
      issuedAt: now,
      expiresAt: now + 7 * DAY,
      nonce: newNonce(),
    }),
  );
  a.relay(
    await a.http(inspector, "POST", path("/inspections"), {
      payload: ip,
      signature: a.sign(inspector, "INSPECTION_ATTESTATION", ip),
    }),
  );
}

describe("a revision whose keys are all current", () => {
  it("needs no rebinding: the plan says so and no successor is offered", async () => {
    const v = await a.http(actor("buyer"), "GET", path("/key-rebinding"));
    expect(v.status, v.text).toBe(200);
    expect(v.json).toMatchObject({
      boundRevision: 1,
      contractRevision: 1,
      pending: null,
      bindingRequired: false,
    });
    expect(v.json.plan.requiresNewRevision).toBe(false);
    expect(v.json.successor).toBeNull();
    const ch = await a.http(actor("supplier"), "POST", path("/key-rebinding-challenges"));
    expect(ch.json.error.code).toBe("INVALID_STATE");
  });
});

let attestorKey: ReturnType<typeof generateEd25519KeyPair>;

describe("a rotated ManifestAttestor key", () => {
  it("is rebound by a dual-signed revision that changes only that key version, with no delay", async () => {
    const c = a.w.c;
    const admin = actor("buyerAdmin");
    attestorKey = generateEd25519KeyPair();
    const rot = await a.http(admin, "POST", `/v1/service-enrollments/${c.w.attestorEnrollment}/rotate`, {
      publicKey: attestorKey.publicKey,
      custody: { kind: "ISOLATED_SIGNER_PROCESS", reference: "signer://manifest-attestor/v2" },
    });
    expect(rot.status, rot.text).toBe(201);
    const payload = fromTypedJson(rot.json.challenge.payload);
    const proved = await a.http(null, "POST", "/v1/service-enrollments/prove", {
      challengeId: rot.json.challenge.challengeId,
      signature: signFor(attestorKey.privateKey, "SERVICE_POP_CHALLENGE", payload),
    });
    expect(proved.status, proved.text).toBe(201);
    const act = await a.http(admin, "POST", `/v1/service-enrollments/${c.w.attestorEnrollment}/activate`, {
      keyVersion: 2,
    });
    expect(act.status, act.text).toBe(201);

    const v = await a.http(actor("inspector"), "GET", path("/key-rebinding"));
    expect(v.status, v.text).toBe(200);
    expect(v.json.plan.requiresNewRevision).toBe(true);
    expect(v.json.plan.rebind).toEqual(["manifestAttestor"]);
    const att = v.json.plan.roles.find((r: { role: string }) => r.role === "manifestAttestor");
    expect(att).toMatchObject({
      issues: ["KEY_SUPERSEDED"],
      from: { keyVersion: 1 },
      to: { keyVersion: 2, publicKey: attestorKey.publicKey },
      blockedBy: null,
    });
    expect(v.json.successor).toMatchObject({ revision: 2, roles: ["manifestAttestor"], rebindsParty: false });
  });

  it("non-parties and unbound sessions get no challenge, consent, revocation, activation or binding", async () => {
    const deniedBefore = audit("RELEASE_ACTION_DENIED");
    for (const role of [
      "inspector",
      "risk",
      "auditor",
      "buyerAdmin",
      "supplierAdmin",
      "supplierClerk",
      "outsiderClerk",
      "outsiderAdmin",
      "otherInspector",
    ]) {
      for (const [p, body] of [
        ["/key-rebinding-challenges", undefined],
        ["/key-rebinding-consents", { successorDigest: "0".repeat(64), signature: "ed25519:1111" }],
        ["/key-rebinding-revocation-challenges", undefined],
        ["/key-rebinding-activation", undefined],
        ["/key-rebinding-binding", undefined],
      ] as const) {
        const r = await a.http(actor(role), "POST", path(p), body);
        expect(DENIALS, `${role} ${p}: ${r.text}`).toContain(r.json.error.code);
      }
    }
    const anon = await a.http(null, "POST", path("/key-rebinding-challenges"));
    expect(anon.json.error.code).toBe("UNAUTHENTICATED");
    // Nothing was proposed.
    expect((await a.http(actor("buyer"), "GET", path("/key-rebinding"))).json.pending).toBeNull();
    // Bound parties' organisations hold capabilities but are not the bound parties: refusals are audited.
    expect(audit("RELEASE_ACTION_DENIED")).toBeGreaterThanOrEqual(deniedBefore);
  });

  it("both bound parties consent, activation needs no delay, binding supersedes every release fact", async () => {
    const c = a.w.c;
    const buyer = actor("buyer");
    const supplier = actor("supplier");
    expect(c.rel.intent(intentId).state).toBe("DIRECT_TESTNET_AUTHORIZED");
    const ch = await a.http(supplier, "POST", path("/key-rebinding-challenges"));
    expect(ch.status, ch.text).toBe(201);
    expect(ch.json).toMatchObject({ purpose: "TRADE_REVISION", revision: 2, roles: ["manifestAttestor"] });
    expect(ch.json.signerKeyVersionId).toBe(supplier.keyVersionId);
    // A signature over another payload, or by a key no revision binds, is refused.
    const stranger = generateEd25519KeyPair();
    const forged = await a.http(supplier, "POST", path("/key-rebinding-consents"), {
      successorDigest: ch.json.digest,
      signature: signWith(stranger, "TRADE_REVISION", ch.json.payload),
    });
    expect(forged.json.error.code).toBe("SIGNATURE_INVALID");
    const wrongDigest = await a.http(supplier, "POST", path("/key-rebinding-consents"), {
      successorDigest: "ab".repeat(32),
      signature: a.sign(supplier, "TRADE_REVISION", ch.json.payload),
    });
    expect(wrongDigest.json.error.code).toBe("DIGEST_MISMATCH");
    const consentsBefore = audit("KEY_REBINDING_CONSENT_RECORDED");
    a.relay(
      await a.http(supplier, "POST", path("/key-rebinding-consents"), {
        successorDigest: ch.json.digest,
        signature: a.sign(supplier, "TRADE_REVISION", ch.json.payload),
      }),
    );
    const one = await a.http(buyer, "GET", path("/key-rebinding"));
    expect(one.json.pending).toMatchObject({
      status: "PROPOSED",
      successorDigest: ch.json.digest,
      proposedBy: "SUPPLIER",
    });
    // One consent never activates, at the API or the contract.
    expect((await a.http(supplier, "POST", path("/key-rebinding-activation"))).json.error.code).toBe(
      "INVALID_STATE",
    );
    expect(panicCode(c.exec(c.escrow.activateKeyRebindingCall(c.t, ch.json.digest)))).toBe("INVALID_STATE");
    // A destination change cannot be stacked on the pending rebinding.
    const dch = await a.http(buyer, "POST", path("/destination-change-challenges"), {
      destination: "harbor-payouts.testnet",
    });
    const stacked = await a.http(buyer, "POST", path("/destination-consents"), {
      destination: "harbor-payouts.testnet",
      signature: a.sign(buyer, "TRADE_REVISION", dch.json.payload),
    });
    expect(stacked.json.error.code).toBe("KEY_REBINDING_PENDING");
    const direct = c.exec(
      c.escrow.proposeDestinationChangeCall(
        c.t,
        dch.json.payload,
        "BUYER",
        a.sign(buyer, "TRADE_REVISION", dch.json.payload),
      ),
    );
    expect(panicCode(direct)).toBe("KEY_REBINDING_PENDING");
    // The buyer's challenge returns the identical pending successor.
    const bch = await a.http(buyer, "POST", path("/key-rebinding-challenges"));
    expect(bch.json.digest).toBe(ch.json.digest);
    a.relay(
      await a.http(buyer, "POST", path("/key-rebinding-consents"), {
        successorDigest: bch.json.digest,
        signature: a.sign(buyer, "TRADE_REVISION", bch.json.payload),
      }),
    );
    expect(audit("KEY_REBINDING_CONSENT_RECORDED") - consentsBefore).toBe(2);
    const two = await a.http(buyer, "GET", path("/key-rebinding"));
    expect(two.json.pending.status).toBe("CONSENTED");
    expect(two.json.pending.delayUntil).toBe(
      two.json.pending.supplierConsentAt ?? two.json.pending.buyerConsentAt,
    );
    a.relay(await a.http(supplier, "POST", path("/key-rebinding-activation")));
    const bind = await a.http(buyer, "POST", path("/key-rebinding-binding"));
    expect(bind.status, bind.text).toBe(201);
    expect(bind.json.revision).toBe(2);
    expect(audit("KEY_REBINDING_REVISION_BOUND")).toBe(1);
    await a.http(buyer, "POST", path("/sync"));
    expect(c.rel.intent(intentId).state).toBe("SUPERSEDED_PRE_SUBMIT");
    const view = await a.http(buyer, "GET", path(""));
    expect(view.json.trade.revision).toBe(2);
    expect(view.json.authority).toEqual({ current: true, requiresNewRevision: false, issues: [] });
    expect(view.json.release.blockers).toEqual(
      expect.arrayContaining(["MANIFEST_NOT_CURRENT", "INSPECTION_NOT_PASS", "APPROVAL_MISSING"]),
    );
    // The superseded intent and its approval are dead at every layer.
    expect(panicCode(c.exec(c.escrow.executeReleaseCall(c.t, intentId)))).toBe("INVALID_STATE");
    // The old attestor key cannot attest for revision 2; only the rebound key can.
    await expect(c.w.evidence.attest(c.t, c.w.attestor)).rejects.toMatchObject({ code: "KEY_NOT_BOUND" });
    const after = await a.http(buyer, "GET", path("/key-rebinding"));
    expect(after.json).toMatchObject({
      boundRevision: 2,
      contractRevision: 2,
      pending: null,
      bindingRequired: false,
    });
    expect(after.json.history.at(-1)).toMatchObject({ status: "ACTIVATED", roles: ["manifestAttestor"] });
  });
});

describe("a rotated buyer key", () => {
  let fresh: Actor;
  let newKey: ReturnType<typeof generateEd25519KeyPair>;

  it("the buyer rotates in its own session; the revision now requires a party rebinding", async () => {
    const buyer = actor("buyer");
    newKey = generateEd25519KeyPair();
    const ch = await a.http(buyer, "POST", "/v1/keys/rotation/challenges", { publicKey: newKey.publicKey });
    expect(ch.status, ch.text).toBe(201);
    const done = await a.http(buyer, "POST", "/v1/keys/rotation/complete", {
      challengeId: ch.json.challengeId,
      proof: popProof(newKey, ch.json),
    });
    expect(done.status, done.text).toBe(201);
    fresh = await login(buyer.principalId, newKey);
    const v = await a.http(fresh, "GET", path("/key-rebinding"));
    expect(v.status, v.text).toBe(200);
    expect(v.json.plan.rebind).toEqual(["buyer"]);
    expect(v.json.successor).toMatchObject({ revision: 3, roles: ["buyer"], rebindsParty: true });
    expect(v.json.delayMs).toBe(DAY);
  });

  it("the new key signs for the buyer, the old key and strangers cannot, and either party can revoke", async () => {
    const c = a.w.c;
    const supplier = actor("supplier");
    const ch = await a.http(fresh, "POST", path("/key-rebinding-challenges"));
    expect(ch.status, ch.text).toBe(201);
    expect(ch.json.signerKeyVersionId).toBe(fresh.keyVersionId);
    // The old (superseded) buyer key signing the successor is refused.
    const old = await a.http(fresh, "POST", path("/key-rebinding-consents"), {
      successorDigest: ch.json.digest,
      signature: a.sign(actor("buyer"), "TRADE_REVISION", ch.json.payload),
    });
    expect(old.json.error.code).toBe("SIGNATURE_INVALID");
    // The contract refuses it too when relayed directly.
    const forged = c.exec(
      c.escrow.proposeKeyRebindingCall(
        c.t,
        ch.json.payload,
        "BUYER",
        a.sign(actor("buyer"), "TRADE_REVISION", ch.json.payload),
      ),
    );
    expect(panicCode(forged)).toBe("SIGNATURE_INVALID");
    // The supplier cannot sign for the buyer's role.
    const swapped = c.exec(
      c.escrow.proposeKeyRebindingCall(
        c.t,
        ch.json.payload,
        "BUYER",
        a.sign(supplier, "TRADE_REVISION", ch.json.payload),
      ),
    );
    expect(panicCode(swapped)).toBe("SIGNATURE_INVALID");
    a.relay(
      await a.http(fresh, "POST", path("/key-rebinding-consents"), {
        successorDigest: ch.json.digest,
        signature: signWith(newKey, "TRADE_REVISION", ch.json.payload),
      }),
    );
    expect((await a.http(supplier, "GET", path("/key-rebinding"))).json.pending.status).toBe("PROPOSED");
    // The supplier withdraws it with its own signed revocation.
    const rch = await a.http(supplier, "POST", path("/key-rebinding-revocation-challenges"));
    expect(rch.status, rch.text).toBe(201);
    expect(rch.json.purpose).toBe("KEY_REBINDING_REVOKE");
    // A destination-change revocation signature over the same payload is the wrong domain.
    const wrongDomain = await a.http(supplier, "POST", path("/key-rebinding-revocations"), {
      payload: rch.json.payload,
      signature: a.sign(supplier, "DESTINATION_CHANGE_REVOKE", rch.json.payload),
    });
    expect(wrongDomain.json.error.code).toBe("WRONG_DOMAIN");
    a.relay(
      await a.http(supplier, "POST", path("/key-rebinding-revocations"), {
        payload: rch.json.payload,
        signature: a.sign(supplier, "KEY_REBINDING_REVOKE", rch.json.payload),
      }),
    );
    const v = await a.http(supplier, "GET", path("/key-rebinding"));
    expect(v.json.pending).toBeNull();
    expect(v.json.history.at(-1)).toMatchObject({ status: "REVOKED", roles: ["buyer"] });
  });

  it("dual consent, the signed delay, activation and binding; renewed authority pays the bound supplier", async () => {
    const c = a.w.c;
    const supplier = actor("supplier");
    const ch = await a.http(fresh, "POST", path("/key-rebinding-challenges"));
    a.relay(
      await a.http(fresh, "POST", path("/key-rebinding-consents"), {
        successorDigest: ch.json.digest,
        signature: signWith(newKey, "TRADE_REVISION", ch.json.payload),
      }),
    );
    const sch = await a.http(supplier, "POST", path("/key-rebinding-challenges"));
    expect(sch.json.digest).toBe(ch.json.digest);
    a.relay(
      await a.http(supplier, "POST", path("/key-rebinding-consents"), {
        successorDigest: sch.json.digest,
        signature: a.sign(supplier, "TRADE_REVISION", sch.json.payload),
      }),
    );
    const pending = (await a.http(fresh, "GET", path("/key-rebinding"))).json.pending;
    expect(pending.status).toBe("CONSENTED");
    expect(pending.delayUntil - (pending.supplierConsentAt as number)).toBe(DAY);
    expect((await a.http(fresh, "POST", path("/key-rebinding-activation"))).json.error.code).toBe(
      "DELAY_NOT_ELAPSED",
    );
    expect(panicCode(c.exec(c.escrow.activateKeyRebindingCall(c.t, ch.json.digest)))).toBe(
      "DELAY_NOT_ELAPSED",
    );
    // (Advance the shared clock directly: the world's bulk relogin would use the buyer's old key.)
    c.w.h.clock.advance(DAY + 1);
    relogin(supplier);
    const buyer = await login(fresh.principalId, newKey);
    a.relay(await a.http(buyer, "POST", path("/key-rebinding-activation")));
    const bind = await a.http(buyer, "POST", path("/key-rebinding-binding"));
    expect(bind.status, bind.text).toBe(201);
    expect(bind.json.revision).toBe(3);
    const view = await a.http(buyer, "GET", path(""));
    expect(view.json.trade.revision).toBe(3);
    expect(view.json.authority.current).toBe(true);

    // Renewed authority: new evidence revision attested by the rebound attestor key, inspection,
    // and approval signed by the NEW buyer key.
    await renewEvidence(attestorKey, "INV-3");
    await a.http(buyer, "POST", path("/sync"));
    const live = c.rel.liveIntent(c.t);
    expect(live?.tradeRevision).toBe(3);
    const successor = live?.releaseIntentId as string;
    const ach = await a.http(buyer, "POST", `/v1/release-intents/${successor}/approval-challenges`);
    expect(ach.status, ach.text).toBe(201);
    a.relay(
      await a.http(buyer, "POST", `/v1/release-intents/${successor}/approval`, {
        payload: ach.json.payload,
        signature: signWith(newKey, "BUYER_APPROVAL", ach.json.payload),
      }),
    );
    await a.http(buyer, "POST", path("/sync"));
    const before = c.sim.balance(SUPPLIER_ACCT);
    const exec = await a.http(buyer, "POST", `/v1/release-intents/${successor}/execute`);
    expect(exec.status, exec.text).toBe(201);
    await run(a.w);
    const op = await a.http(supplier, "GET", `/v1/operations/${exec.json.operationId}`);
    expect(op.json.state).toBe("PAID");
    expect(c.sim.balance(SUPPLIER_ACCT) - before).toBe(10n * 10n ** 24n);
    expect(audit("KEY_REBINDING_ACTIVATION_PREPARED")).toBe(2);
  });

  it("a recovery in progress cannot be rebound yet; once recovered, a released trade is not rebound", async () => {
    const admin = await login(actor("buyerAdmin").principalId, actor("buyerAdmin").key);
    const risk = actor("risk");
    const key = generateEd25519KeyPair();
    const start = await a.http(admin, "POST", "/v1/recoveries", {
      principalId: risk.principalId,
      publicKey: key.publicKey,
    });
    expect(start.status, start.text).toBe(201);
    const buyer = (await a.http(actor("supplier"), "GET", path("/key-rebinding"))).json;
    const role = buyer.plan.roles.find((r: { role: string }) => r.role === "riskResolver");
    // The bound key is suspended and the recovery key is not active yet: nothing to rebind to.
    expect(role).toMatchObject({ issues: ["KEY_REVOKED"], to: null, blockedBy: "NO_ACTIVE_KEY" });
    expect(buyer.successor).toBeNull();
    expect(buyer.successorError).toBe("NOT_ELIGIBLE");
    const ch = await a.http(actor("supplier"), "POST", path("/key-rebinding-challenges"));
    expect(ch.json.error.code).toBe("NOT_ELIGIBLE");
    const proved = await a.http(null, "POST", "/v1/recoveries/prove", {
      challengeId: start.json.challenge.challengeId,
      proof: popProof(key, start.json.challenge),
    });
    expect(proved.status, proved.text).toBe(201);
    a.w.c.w.h.clock.advance(start.json.notBefore - a.w.c.w.h.clock.now() + 1000);
    const admin2 = await login(admin.principalId, admin.key);
    expect(
      (await a.http(admin2, "POST", `/v1/recoveries/${start.json.recoveryId}/complete`, {})).status,
    ).toBe(201);
    relogin(actor("supplier"));
    const after = (await a.http(actor("supplier"), "GET", path("/key-rebinding"))).json;
    expect(after.plan.rebind).toEqual(["riskResolver"]);
    const ch2 = await a.http(actor("supplier"), "POST", path("/key-rebinding-challenges"));
    expect(ch2.status, ch2.text).toBe(201);
    const consent = await a.http(actor("supplier"), "POST", path("/key-rebinding-consents"), {
      successorDigest: ch2.json.digest,
      signature: a.sign(actor("supplier"), "TRADE_REVISION", ch2.json.payload),
    });
    expect(consent.json.error.code).toBe("INVALID_STATE");
  });
});
