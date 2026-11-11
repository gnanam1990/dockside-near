/**
 * T-042: the adversarial redirection path is reproducible on the built API (M09).
 *
 * Over the real HTTP API (PoP sessions and request proofs), the compiled escrow wasm on the
 * simulated NEAR host, and the M05 worker and reconciler:
 *   1. forged and unilateral destination changes are refused at the API, the service and the
 *      contract, and the bound destination stays effective;
 *   2. a legitimate change needs both bound parties over one successor digest, waits out the
 *      delay, activates by relay, and supersedes the pre-submit intent, the manifest, the
 *      inspection and the buyer approval;
 *   3. release to the new destination needs renewed full authority (fresh evidence revision,
 *      attestation, inspection PASS and buyer approval) and pays exactly the new destination.
 * Simulated: the NEAR chain, not testnet.
 */
import { generateEd25519KeyPair, newNonce, signFor, toTypedJson } from "@dockside/core";
import { inspectionPayload } from "@dockside/evidence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, enrollHuman } from "../../../packages/authority/test/helpers.js";
import { pdf } from "../../../packages/evidence/test/world.js";
import {
  ALT_DEST,
  DAY,
  HOUR,
  panicCode,
  relogin,
  SUPPLIER_ACCT,
} from "../../../packages/release/test/chain.js";
import { type ApiWorld, apiWorld, lockAndApprove, run } from "./m07-world.js";

const ATTACKER_DEST = "harbor-supp1ier.testnet";
const DENIALS = ["UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "KEY_NOT_BOUND"];

let a: ApiWorld;
let intentId = "";
beforeAll(async () => {
  a = await apiWorld();
  intentId = await lockAndApprove(a, "redirect-intent-0001");
});
afterAll(async () => {
  await a.close();
});

const actor = (role: string) => a.actors[role] as Actor;
const path = (suffix: string) => `/v1/trades/${a.w.c.t}${suffix}`;
const count = (table: string) => Number(a.w.c.w.h.db.get(`SELECT COUNT(*) AS n FROM ${table}`)?.["n"] ?? 0);

describe("T-042: forged and unilateral destination changes are denied everywhere", () => {
  it("non-parties cannot obtain, sign or relay a destination change", async () => {
    const before = count("release_signatures");
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
      const ch = await a.http(actor(role), "POST", path("/destination-change-challenges"), {
        destination: ATTACKER_DEST,
      });
      expect(DENIALS, `${role} challenge: ${ch.text}`).toContain(ch.json.error.code);
      const consent = await a.http(actor(role), "POST", path("/destination-consents"), {
        destination: ATTACKER_DEST,
        signature: "ed25519:1111",
      });
      expect(DENIALS, `${role} consent: ${consent.text}`).toContain(consent.json.error.code);
      const act = await a.http(actor(role), "POST", path("/destination-activation"));
      expect(DENIALS, `${role} activation`).toContain(act.json.error.code);
    }
    const anon = await a.http(null, "POST", path("/destination-consents"), {
      destination: ATTACKER_DEST,
      signature: "ed25519:1111",
    });
    expect(anon.json.error.code).toBe("UNAUTHENTICATED");
    expect(count("release_signatures")).toBe(before);
  });

  it("a party session cannot carry another key's or a tampered successor signature", async () => {
    const supplier = actor("supplier");
    const ch = await a.http(supplier, "POST", path("/destination-change-challenges"), {
      destination: ATTACKER_DEST,
    });
    expect(ch.status, ch.text).toBe(201);
    expect(ch.json.revision).toBe(2);
    // Signed by a fresh key that no revision binds.
    const stranger = generateEd25519KeyPair();
    const forged = await a.http(supplier, "POST", path("/destination-consents"), {
      destination: ATTACKER_DEST,
      signature: signFor(
        stranger.privateKey,
        "TRADE_REVISION",
        a.w.c.rel.successorTerms(a.w.c.t, ATTACKER_DEST).canonical,
      ),
    });
    expect(forged.json.error.code).toBe("SIGNATURE_INVALID");
    // The bound supplier's signature over a different successor than the one named.
    const other = a.w.c.rel.successorTerms(a.w.c.t, ALT_DEST).canonical;
    const swapped = await a.http(supplier, "POST", path("/destination-consents"), {
      destination: ATTACKER_DEST,
      signature: a.w.c.sign(supplier, "TRADE_REVISION", other),
    });
    expect(swapped.json.error.code).toBe("SIGNATURE_INVALID");
    // The same destination as today is not a change.
    const same = await a.http(supplier, "POST", path("/destination-change-challenges"), {
      destination: SUPPLIER_ACCT,
    });
    expect(same.json.error.code).toBe("VALIDATION_FAILED");
    // A destination that is not a named testnet account is refused before anything is signed.
    const bad = await a.http(supplier, "POST", path("/destination-change-challenges"), {
      destination: "0xdeadbeef",
    });
    expect(bad.status).toBe(400);
  });

  it("the contract refuses a forged proposal relayed directly, and one consent never activates", async () => {
    const c = a.w.c;
    const s = c.rel.successorTerms(c.t, ATTACKER_DEST);
    // Direct relay with the inspector's key claiming the supplier role.
    const forged = c.exec(
      c.escrow.proposeDestinationChangeCall(
        c.t,
        toTypedJson(s.canonical),
        "SUPPLIER",
        c.sign(actor("inspector"), "TRADE_REVISION", s.canonical),
      ),
    );
    expect(forged.ok).toBe(false);
    expect(panicCode(forged)).toBe("SIGNATURE_INVALID");
    // The bound supplier alone proposes the attacker destination through the API.
    const supplier = actor("supplier");
    const one = await a.http(supplier, "POST", path("/destination-consents"), {
      destination: ATTACKER_DEST,
      signature: c.sign(supplier, "TRADE_REVISION", s.canonical),
    });
    a.relay(one);
    const view = await a.http(supplier, "GET", path("/destination-change"));
    expect(view.json.pending.status).toBe("PROPOSED");
    expect(view.json.activeDestination).toBe(SUPPLIER_ACCT);
    const early = await a.http(supplier, "POST", path("/destination-activation"));
    expect(early.json.error.code).toBe("INVALID_STATE");
    expect(panicCode(c.exec(c.escrow.activateDestinationChangeCall(c.t, s.digest)))).toBe("INVALID_STATE");
    // Longer than the change delay, shorter than the intent lifetime.
    a.w.c.advance(DAY + HOUR);
    for (const r of ["buyer", "supplier"]) relogin(actor(r));
    expect((await a.http(supplier, "POST", path("/destination-activation"))).json.error.code).toBe(
      "INVALID_STATE",
    );
    // A second, different change cannot be stacked on the pending one.
    const buyer = actor("buyer");
    const stacked = await a.http(buyer, "POST", path("/destination-consents"), {
      destination: ALT_DEST,
      signature: c.sign(buyer, "TRADE_REVISION", c.rel.successorTerms(c.t, ALT_DEST).canonical),
    });
    expect(stacked.json.error.code).toBe("DESTINATION_CHANGE_PENDING");
    expect((await c.escrow.getTrade(c.t)).payoutDestination).toBe(SUPPLIER_ACCT);
    // The supplier withdraws its unilateral proposal with its own signed revocation.
    const rch = await a.http(supplier, "POST", path("/destination-revocation-challenges"));
    expect(rch.status, rch.text).toBe(201);
    const rv = await a.http(supplier, "POST", path("/destination-revocations"), {
      payload: rch.json.payload,
      signature: a.sign(supplier, "DESTINATION_CHANGE_REVOKE", rch.json.payload),
    });
    a.relay(rv);
    expect(
      (await a.http(supplier, "GET", path("/destination-change"))).json.pending?.status ?? "NONE",
    ).not.toBe("PROPOSED");
  });
});

describe("T-042: legitimate dual consent, delay and renewed full authority", () => {
  it("both parties consent, the delay is enforced, activation supersedes every release fact", async () => {
    const c = a.w.c;
    const buyer = actor("buyer");
    const supplier = actor("supplier");
    relogin(buyer);
    relogin(supplier);
    // The approved intent from before is still live: the changed trade must not keep it.
    expect(c.rel.intent(intentId).state).toBe("DIRECT_TESTNET_AUTHORIZED");
    const ch = await a.http(supplier, "POST", path("/destination-change-challenges"), {
      destination: ALT_DEST,
    });
    expect(ch.status, ch.text).toBe(201);
    const s = c.rel.successorTerms(c.t, ALT_DEST);
    expect(ch.json.digest).toBe(s.digest);
    for (const p of [supplier, buyer]) {
      const res = await a.http(p, "POST", path("/destination-consents"), {
        destination: ALT_DEST,
        signature: a.sign(p, "TRADE_REVISION", ch.json.payload),
      });
      a.relay(res);
    }
    const pending = await a.http(buyer, "GET", path("/destination-change"));
    expect(pending.json.pending.status).toBe("CONSENTED");
    const early = await a.http(buyer, "POST", path("/destination-activation"));
    expect(early.json.error.code).toBe("DELAY_NOT_ELAPSED");
    expect(panicCode(c.exec(c.escrow.activateDestinationChangeCall(c.t, s.digest)))).toBe(
      "DELAY_NOT_ELAPSED",
    );
    // Meanwhile the approved intent still pays only the bound destination, if anything.
    expect((await c.escrow.getTrade(c.t)).payoutDestination).toBe(SUPPLIER_ACCT);
    c.advance(DAY + 1);
    relogin(buyer);
    relogin(supplier);
    // Even with both consents and the delay elapsed, only a bound party gets the relay.
    // (Capability is checked before the trade is loaded, so an outsider learns nothing either.)
    for (const role of ["inspector", "risk", "auditor", "supplierClerk", "buyerAdmin", "outsiderAdmin"]) {
      relogin(actor(role));
      const r = await a.http(actor(role), "POST", path("/destination-activation"));
      expect(r.json.error?.code, `${role} activation`).toBe("FORBIDDEN");
    }
    // A second buyer approver of the same organisation holds the capability but is not bound.
    const unbound = enrollHuman(c.w.h, actor("buyerAdmin"), "BUYER_APPROVER");
    for (const p of [
      "/destination-activation",
      "/destination-binding",
      "/destination-revocation-challenges",
    ]) {
      const r = await a.http(unbound, "POST", path(p));
      expect(r.json.error?.code, `unbound approver ${p}`).toBe("FORBIDDEN");
    }
    const act = await a.http(supplier, "POST", path("/destination-activation"));
    a.relay(act);
    const bind = await a.http(buyer, "POST", path("/destination-binding"));
    expect(bind.status, bind.text).toBe(201);
    expect(bind.json.revision).toBe(2);
    await a.http(buyer, "POST", path("/sync"));
    expect(c.rel.intent(intentId).state).toBe("SUPERSEDED_PRE_SUBMIT");
    const view = await a.http(buyer, "GET", path(""));
    expect(view.json.trade.revision).toBe(2);
    expect(view.json.release.blockers).toEqual(
      expect.arrayContaining(["MANIFEST_NOT_CURRENT", "INSPECTION_NOT_PASS", "APPROVAL_MISSING"]),
    );
    // The superseded intent and its approval are dead at every layer.
    const exec = await a.http(buyer, "POST", `/v1/release-intents/${intentId}/execute`);
    expect(exec.status).toBeGreaterThanOrEqual(400);
    expect(panicCode(c.exec(c.escrow.executeReleaseCall(c.t, intentId)))).toBe("INVALID_STATE");
    expect((await a.http(buyer, "GET", path("/destination-change"))).json).toMatchObject({
      activeDestination: ALT_DEST,
      boundRevision: 2,
      contractRevision: 2,
      bindingRequired: false,
    });
  });

  it("release to the new destination needs fresh evidence, attestation, inspection and approval", async () => {
    const c = a.w.c;
    const buyer = actor("buyer");
    const supplier = actor("supplier");
    const inspector = actor("inspector");
    relogin(inspector);
    const t = c.t;
    // New evidence revision under revision 2: replace the invoice over HTTP.
    const ev = (await a.http(supplier, "GET", `/v1/trades/${t}/evidence`)).json;
    const old = ev.manifest.items.find((i: { slotId: string }) => i.slotId === "commercial-invoice");
    const inv = pdf("Invoice INV-1 payable to harbor-payouts.testnet");
    const up = await a.http(supplier, "POST", `/v1/trades/${t}/evidence`, {
      slotId: "commercial-invoice",
      contentBase64: Buffer.from(inv).toString("base64"),
      issuer: c.w.issue(supplier, "SUPPLIER_SIGNER", "commercial-invoice", inv),
      replacesItemId: old.itemId,
      expectedManifestRevision: ev.manifest.revision,
    });
    expect(up.status, up.text).toBe(201);
    const att = await c.w.evidence.attest(t, c.w.attestor);
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
      await a.http(inspector, "POST", `/v1/trades/${t}/inspections`, {
        payload: ip,
        signature: a.sign(inspector, "INSPECTION_ATTESTATION", ip),
      }),
    );
    const live = c.rel.liveIntent(t);
    expect(live?.destination).toBe(ALT_DEST);
    expect(live?.predecessorId).toBe(intentId);
    const successor = live?.releaseIntentId as string;
    const ch = await a.http(buyer, "POST", `/v1/release-intents/${successor}/approval-challenges`);
    expect(ch.status, ch.text).toBe(201);
    a.relay(
      await a.http(buyer, "POST", `/v1/release-intents/${successor}/approval`, {
        payload: ch.json.payload,
        signature: a.sign(buyer, "BUYER_APPROVAL", ch.json.payload),
      }),
    );
    await a.http(buyer, "POST", `/v1/trades/${t}/sync`);
    const before = c.sim.balance(ALT_DEST);
    const oldBefore = c.sim.balance(SUPPLIER_ACCT);
    const exec = await a.http(buyer, "POST", `/v1/release-intents/${successor}/execute`);
    expect(exec.status, exec.text).toBe(201);
    await run(a.w);
    const op = await a.http(supplier, "GET", `/v1/operations/${exec.json.operationId}`);
    expect(op.json.state).toBe("PAID");
    expect(c.sim.balance(ALT_DEST) - before).toBe(10n * 10n ** 24n);
    expect(c.sim.balance(SUPPLIER_ACCT)).toBe(oldBefore);
    expect(c.sim.balance(ATTACKER_DEST)).toBe(0n);
  });
});
