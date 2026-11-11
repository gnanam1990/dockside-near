/**
 * T-005 — Invitation and role grant require separate sessions (FR-10, FR-15, INV-13).
 * One-time hashed scoped invitation, recipient proof in its own session and later
 * administrator grant; self-consumption, replay, wrong org and role escalation fail.
 */
import { generateEd25519KeyPair } from "@dockside/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  Actor,
  bootstrap,
  closeHarnesses,
  code,
  enrollHuman,
  makeHarness,
  signChallenge,
} from "./helpers.js";

afterEach(closeHarnesses);

describe("T-005 invitation and role grant require separate sessions", () => {
  it("runs invite -> recipient PoP in its own session -> later admin grant", () => {
    const h = makeHarness();
    const admin = bootstrap(h);
    const inv = h.svc.createInvitation(admin.ctx(), { capability: "BUYER_APPROVER" });
    expect(inv.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const buyer = new Actor(h);
    const c = h.svc.createInvitationChallenge({
      invitationSecret: inv.secret,
      publicKey: buyer.key.publicKey,
      displayName: "Ana Buyer",
    });
    expect(c.payload).toMatchObject({
      purpose: "INVITATION_ACCEPT",
      organizationId: admin.organizationId,
      requestedCapability: "BUYER_APPROVER",
      invitationId: inv.invitationId,
    });
    buyer.grant = h.svc.acceptInvitation({ challengeId: c.challengeId, proof: signChallenge(buyer.key, c) });
    expect(buyer.grant.sessionId).not.toBe(admin.grant!.sessionId);
    // Accepted but not yet granted: authenticated, zero capabilities.
    expect(buyer.ctx().capabilities).toEqual([]);
    expect(buyer.ctx().principal.status).toBe("PENDING_GRANT");
    const grant = h.svc.grantRole(admin.ctx(), { invitationId: inv.invitationId });
    expect(grant).toMatchObject({
      capability: "BUYER_APPROVER",
      principalId: buyer.principalId,
      grantedByPrincipalId: admin.principalId,
    });
    expect(buyer.ctx().capabilities).toEqual(["BUYER_APPROVER"]);
    expect(buyer.ctx().principal.status).toBe("ACTIVE");
  });

  it("stores only a hash of the one-time invitation secret", () => {
    const h = makeHarness();
    const admin = bootstrap(h);
    const inv = h.svc.createInvitation(admin.ctx(), { capability: "INSPECTOR" });
    for (const table of ["invitations", "audit_events", "proof_challenges"]) {
      expect(JSON.stringify(h.db.all(`SELECT * FROM ${table}`))).not.toContain(inv.secret);
    }
  });

  it("rejects self-consumption by the inviting administrator", () => {
    const h = makeHarness();
    const admin = bootstrap(h);
    const inv = h.svc.createInvitation(admin.ctx(), { capability: "BUYER_APPROVER" });
    expect(
      code(() =>
        h.svc.createInvitationChallenge({ invitationSecret: inv.secret, publicKey: admin.key.publicKey }),
      ),
    ).toBe("SEPARATION_OF_DUTIES");
    // A fresh key, but accepted from inside the inviter's authenticated session.
    const k = generateEd25519KeyPair();
    const c = h.svc.createInvitationChallenge({ invitationSecret: inv.secret, publicKey: k.publicKey });
    expect(
      code(() =>
        h.svc.acceptInvitation({
          challengeId: c.challengeId,
          proof: signChallenge(k, c),
          presentedSessionToken: admin.grant!.sessionToken,
        }),
      ),
    ).toBe("SEPARATION_OF_DUTIES");
  });

  it("is one-time: a second acceptance or a replayed challenge is denied", () => {
    const h = makeHarness();
    const admin = bootstrap(h);
    const inv = h.svc.createInvitation(admin.ctx(), { capability: "BUYER_APPROVER" });
    const a = new Actor(h);
    const c = h.svc.createInvitationChallenge({ invitationSecret: inv.secret, publicKey: a.key.publicKey });
    const proof = signChallenge(a.key, c);
    a.grant = h.svc.acceptInvitation({ challengeId: c.challengeId, proof });
    expect(code(() => h.svc.acceptInvitation({ challengeId: c.challengeId, proof }))).toBe("NONCE_REPLAYED");
    const b = generateEd25519KeyPair();
    expect(
      code(() => h.svc.createInvitationChallenge({ invitationSecret: inv.secret, publicKey: b.publicKey })),
    ).toBe("INVALID_STATE");
    expect(
      code(() =>
        h.svc.createInvitationChallenge({ invitationSecret: "A".repeat(43), publicKey: b.publicKey }),
      ),
    ).toBe("NOT_FOUND");
  });

  it("only allows one concurrent acceptance per invitation", () => {
    const h = makeHarness();
    const admin = bootstrap(h);
    const inv = h.svc.createInvitation(admin.ctx(), { capability: "INSPECTOR" });
    const a = generateEd25519KeyPair();
    const b = generateEd25519KeyPair();
    const ca = h.svc.createInvitationChallenge({ invitationSecret: inv.secret, publicKey: a.publicKey });
    const cb = h.svc.createInvitationChallenge({ invitationSecret: inv.secret, publicKey: b.publicKey });
    expect(
      code(() => h.svc.acceptInvitation({ challengeId: ca.challengeId, proof: signChallenge(a, ca) })),
    ).toBe("NO_ERROR");
    expect(
      code(() => h.svc.acceptInvitation({ challengeId: cb.challengeId, proof: signChallenge(b, cb) })),
    ).toBe("INVALID_STATE");
  });

  it("denies wrong-organization grants and invitations", () => {
    const h = makeHarness();
    const adminA = bootstrap(h, "Acme");
    const adminB = bootstrap(h, "Other Co");
    const inv = h.svc.createInvitation(adminA.ctx(), { capability: "BUYER_APPROVER" });
    const p = new Actor(h);
    const c = h.svc.createInvitationChallenge({ invitationSecret: inv.secret, publicKey: p.key.publicKey });
    p.grant = h.svc.acceptInvitation({ challengeId: c.challengeId, proof: signChallenge(p.key, c) });
    expect(code(() => h.svc.grantRole(adminB.ctx(), { invitationId: inv.invitationId }))).toBe("FORBIDDEN");
    expect(p.ctx().capabilities).toEqual([]);
  });

  it("denies role escalation and self-escalation", () => {
    const h = makeHarness();
    const admin = bootstrap(h);
    // Recipient cannot grant itself: it holds no admin capability.
    const inv = h.svc.createInvitation(admin.ctx(), { capability: "SUPPLIER_SIGNER" });
    const s = new Actor(h);
    const c = h.svc.createInvitationChallenge({ invitationSecret: inv.secret, publicKey: s.key.publicKey });
    s.grant = h.svc.acceptInvitation({ challengeId: c.challengeId, proof: signChallenge(s.key, c) });
    expect(code(() => h.svc.grantRole(s.ctx(), { invitationId: inv.invitationId }))).toBe("FORBIDDEN");
    expect(code(() => h.svc.createInvitation(s.ctx(), { capability: "ORG_SECURITY_ADMIN" }))).toBe(
      "FORBIDDEN",
    );
    // The grant is fixed by the invitation; a different capability cannot be granted from it.
    expect(
      code(() =>
        h.svc.grantRole(admin.ctx(), { invitationId: inv.invitationId, capability: "RISK_RESOLVER" }),
      ),
    ).toBe("FORBIDDEN");
    h.svc.grantRole(admin.ctx(), { invitationId: inv.invitationId });
    // A second party capability for the same principal violates separation of duties.
    expect(
      code(() =>
        h.svc.grantCapability(admin.ctx(), { principalId: s.principalId, capability: "BUYER_APPROVER" }),
      ),
    ).toBe("SEPARATION_OF_DUTIES");
    // The administrator cannot grant itself a party capability.
    expect(
      code(() =>
        h.svc.grantCapability(admin.ctx(), { principalId: admin.principalId, capability: "BUYER_APPROVER" }),
      ),
    ).toBe("SEPARATION_OF_DUTIES");
    // Service capabilities are never granted to humans or by invitation.
    expect(code(() => h.svc.createInvitation(admin.ctx(), { capability: "MANIFEST_ATTEST" }))).toBe(
      "VALIDATION_FAILED",
    );
  });

  it("requires acceptance before grant and rejects expired invitations", () => {
    const h = makeHarness();
    const admin = bootstrap(h);
    const inv = h.svc.createInvitation(admin.ctx(), { capability: "INSPECTOR" });
    expect(code(() => h.svc.grantRole(admin.ctx(), { invitationId: inv.invitationId }))).toBe(
      "INVALID_STATE",
    );
    h.clock.advance(3 * 24 * 3600_000);
    const k = generateEd25519KeyPair();
    // Admin session also expired by now; the invitation itself is expired regardless.
    expect(
      code(() => h.svc.createInvitationChallenge({ invitationSecret: inv.secret, publicKey: k.publicKey })),
    ).toBe("EXPIRED");
  });

  it("establishes independent buyer, supplier, inspector and risk principals through separate sessions", () => {
    const h = makeHarness();
    const buyerAdmin = bootstrap(h, "Acme Imports");
    const supplierAdmin = bootstrap(h, "Harbor Supply");
    const inspectAdmin = bootstrap(h, "Port Inspections");
    const buyer = enrollHuman(h, buyerAdmin, "BUYER_APPROVER");
    const risk = enrollHuman(h, buyerAdmin, "RISK_RESOLVER");
    const supplier = enrollHuman(h, supplierAdmin, "SUPPLIER_SIGNER");
    const inspector = enrollHuman(h, inspectAdmin, "INSPECTOR");
    const parties = [buyer, supplier, inspector, risk];
    expect(new Set(parties.map((p) => p.principalId)).size).toBe(4);
    expect(new Set(parties.map((p) => p.grant!.sessionId)).size).toBe(4);
    expect(new Set(parties.map((p) => p.key.publicKey)).size).toBe(4);
    const independence = h.svc.assertIndependentParties({
      buyer: { principalId: buyer.principalId, keyVersionId: buyer.keyVersionId },
      supplier: { principalId: supplier.principalId, keyVersionId: supplier.keyVersionId },
      inspector: { principalId: inspector.principalId, keyVersionId: inspector.keyVersionId },
      riskResolver: { principalId: risk.principalId, keyVersionId: risk.keyVersionId },
    });
    expect(independence.ok).toBe(true);
    // The same principal in two party slots fails.
    expect(
      code(() =>
        h.svc.assertIndependentParties({
          buyer: { principalId: buyer.principalId, keyVersionId: buyer.keyVersionId },
          supplier: { principalId: supplier.principalId, keyVersionId: supplier.keyVersionId },
          inspector: { principalId: buyer.principalId, keyVersionId: buyer.keyVersionId },
          riskResolver: { principalId: risk.principalId, keyVersionId: risk.keyVersionId },
        }),
      ),
    ).toBe("SEPARATION_OF_DUTIES");
    // A principal without the slot's capability fails.
    expect(
      code(() =>
        h.svc.assertIndependentParties({
          buyer: { principalId: buyer.principalId, keyVersionId: buyer.keyVersionId },
          supplier: { principalId: supplier.principalId, keyVersionId: supplier.keyVersionId },
          inspector: { principalId: risk.principalId, keyVersionId: risk.keyVersionId },
          riskResolver: { principalId: inspector.principalId, keyVersionId: inspector.keyVersionId },
        }),
      ),
    ).toBe("FORBIDDEN");
  });
});
