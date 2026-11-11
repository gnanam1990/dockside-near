/**
 * T-004 — Organization bootstrap proves key possession (FR-15, INV-13, NFR-02).
 * Origin/org/role/nonce/expiry-bound challenge, actual wallet signature (canonical
 * Ed25519 and NEAR NEP-413 signMessage), replay denial, distinct enrolled key version,
 * and per-request proof-of-possession sessions.
 */
import { generateEd25519KeyPair, randomIds, signFor } from "@dockside/core";
import { AuditLog } from "@dockside/store";
import { afterEach, describe, expect, it } from "vitest";
import {
  Actor,
  bootstrap,
  closeHarnesses,
  code,
  makeHarness,
  ORIGIN,
  signChallenge,
  signChallengeNep413,
} from "./helpers.js";

afterEach(closeHarnesses);

describe("T-004 organization bootstrap proves key possession", () => {
  it("binds origin, organization, role, key, nonce and expiry into the signed challenge", () => {
    const h = makeHarness();
    const key = generateEd25519KeyPair();
    const c = h.svc.createBootstrapChallenge({ organizationName: "Acme Imports", publicKey: key.publicKey });
    expect(c.payload).toMatchObject({
      purpose: "ORG_BOOTSTRAP",
      origin: ORIGIN,
      network: "near-testnet",
      requestedCapability: "ORG_SECURITY_ADMIN",
      publicKey: key.publicKey,
      keyVersion: 1,
    });
    expect(c.payload.organizationId).toMatch(/^org_[0-9a-f]{32}$/);
    expect(c.payload.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(c.payload.expiresAt - c.payload.issuedAt).toBe(5 * 60_000);
    expect(c.nep413.recipient).toBe(ORIGIN);
    expect(c.nep413.message).toContain(c.digestHex);
  });

  it("creates the organization, admin principal, key version 1, grant and a PoP session from a real signature", () => {
    const h = makeHarness();
    const admin = bootstrap(h);
    const g = admin.grant!;
    expect(g.organizationId).toMatch(/^org_/);
    expect(g.keyVersion).toBe(1);
    expect(g.capabilities).toEqual(["ORG_SECURITY_ADMIN"]);
    const ctx = admin.ctx();
    expect(ctx.principal.id).toBe(g.principalId);
    expect(ctx.keyVersion.publicKey).toBe(admin.key.publicKey);
    expect(ctx.keyVersion.status).toBe("ACTIVE");
    const events = new AuditLog(h.db, h.clock, randomIds)
      .list({ organizationId: g.organizationId })
      .map((e) => e.eventType);
    expect(events).toEqual(
      expect.arrayContaining([
        "POP_CHALLENGE_ISSUED",
        "ORG_BOOTSTRAPPED",
        "KEY_ACTIVATED",
        "ROLE_GRANTED",
        "SESSION_CREATED",
      ]),
    );
    expect(new AuditLog(h.db, h.clock, randomIds).verifyChain().ok).toBe(true);
  });

  it("accepts an actual NEAR wallet NEP-413 signMessage signature", () => {
    const h = makeHarness();
    const key = generateEd25519KeyPair();
    const c = h.svc.createBootstrapChallenge({ organizationName: "Harbor Supply", publicKey: key.publicKey });
    const grant = h.svc.completeBootstrap({ challengeId: c.challengeId, proof: signChallengeNep413(key, c) });
    expect(grant.capabilities).toEqual(["ORG_SECURITY_ADMIN"]);
  });

  it("denies replay of a consumed challenge, including after restart", () => {
    const h = makeHarness();
    const key = generateEd25519KeyPair();
    const c = h.svc.createBootstrapChallenge({ organizationName: "Acme", publicKey: key.publicKey });
    const proof = signChallenge(key, c);
    h.svc.completeBootstrap({ challengeId: c.challengeId, proof });
    expect(code(() => h.svc.completeBootstrap({ challengeId: c.challengeId, proof }))).toBe("NONCE_REPLAYED");
    h.reopen();
    expect(code(() => h.svc.completeBootstrap({ challengeId: c.challengeId, proof }))).toBe("NONCE_REPLAYED");
  });

  it("rejects a signature from another key, over altered facts, or under another domain", () => {
    const h = makeHarness();
    const key = generateEd25519KeyPair();
    const other = generateEd25519KeyPair();
    const c = h.svc.createBootstrapChallenge({ organizationName: "Acme", publicKey: key.publicKey });
    expect(
      code(() => h.svc.completeBootstrap({ challengeId: c.challengeId, proof: signChallenge(other, c) })),
    ).toBe("SIGNATURE_INVALID");
    const altered = {
      ...(c.canonicalPayload as Record<string, never>),
      requestedCapability: "RISK_RESOLVER",
    };
    const forged = {
      scheme: "dockside-ed25519" as const,
      signature: signFor(key.privateKey, "POP_CHALLENGE", altered),
    };
    expect(code(() => h.svc.completeBootstrap({ challengeId: c.challengeId, proof: forged }))).toBe(
      "SIGNATURE_INVALID",
    );
    const wrongDomain = {
      scheme: "dockside-ed25519" as const,
      signature: signFor(key.privateKey, "REQUEST_PROOF", c.canonicalPayload),
    };
    expect(code(() => h.svc.completeBootstrap({ challengeId: c.challengeId, proof: wrongDomain }))).toBe(
      "WRONG_DOMAIN",
    );
    // Failed attempts do not consume the challenge; the genuine proof still works once.
    expect(
      code(() => h.svc.completeBootstrap({ challengeId: c.challengeId, proof: signChallenge(key, c) })),
    ).toBe("NO_ERROR");
  });

  it("rejects expired challenges", () => {
    const h = makeHarness();
    const key = generateEd25519KeyPair();
    const c = h.svc.createBootstrapChallenge({ organizationName: "Acme", publicKey: key.publicKey });
    h.clock.advance(5 * 60_000);
    expect(
      code(() => h.svc.completeBootstrap({ challengeId: c.challengeId, proof: signChallenge(key, c) })),
    ).toBe("EXPIRED");
  });

  it("rejects wrong origin at the verifier and in the wallet recipient", () => {
    const h = makeHarness();
    const key = generateEd25519KeyPair();
    const c = h.svc.createBootstrapChallenge({ organizationName: "Acme", publicKey: key.publicKey });
    const phishing = h.withOrigin("https://dockside-login.example");
    expect(
      code(() => phishing.completeBootstrap({ challengeId: c.challengeId, proof: signChallenge(key, c) })),
    ).toBe("WRONG_ORIGIN");
    const walletForOtherSite = signChallengeNep413(key, c, "https://dockside-login.example");
    expect(
      code(() => h.svc.completeBootstrap({ challengeId: c.challengeId, proof: walletForOtherSite })),
    ).toBe("SIGNATURE_INVALID");
  });

  it("enrolls a distinct key version: an enrolled key cannot bootstrap or enroll again", () => {
    const h = makeHarness();
    const admin = bootstrap(h);
    const again = h.svc.createBootstrapChallenge.bind(h.svc);
    expect(code(() => again({ organizationName: "Shadow Org", publicKey: admin.key.publicKey }))).toBe(
      "SEPARATION_OF_DUTIES",
    );
    const second = bootstrap(h, "Second Org");
    expect(second.keyVersionId).not.toBe(admin.keyVersionId);
    expect(second.organizationId).not.toBe(admin.organizationId);
  });

  it("authenticates every request with a fresh proof signed by the session key", () => {
    const h = makeHarness();
    const admin = bootstrap(h);
    const g = admin.grant!;
    const body = '{"a":1}';
    const proof = admin.proof("POST", "/v1/x", body);
    expect(
      code(() =>
        h.svc.authenticate({ sessionToken: g.sessionToken, proof, method: "POST", path: "/v1/x", body }),
      ),
    ).toBe("NO_ERROR");
    // Replayed proof nonce.
    expect(
      code(() =>
        h.svc.authenticate({ sessionToken: g.sessionToken, proof, method: "POST", path: "/v1/x", body }),
      ),
    ).toBe("NONCE_REPLAYED");
    // Proof bound to a different path or body.
    const p2 = admin.proof("POST", "/v1/x", body);
    expect(
      code(() =>
        h.svc.authenticate({ sessionToken: g.sessionToken, proof: p2, method: "POST", path: "/v1/y", body }),
      ),
    ).toBe("SIGNATURE_INVALID");
    const p3 = admin.proof("POST", "/v1/x", body);
    expect(
      code(() =>
        h.svc.authenticate({
          sessionToken: g.sessionToken,
          proof: p3,
          method: "POST",
          path: "/v1/x",
          body: '{"a":2}',
        }),
      ),
    ).toBe("SIGNATURE_INVALID");
    // Stolen bearer token without the key.
    const thief = generateEd25519KeyPair();
    const p4 = admin.proof("POST", "/v1/x", body, thief);
    expect(
      code(() =>
        h.svc.authenticate({ sessionToken: g.sessionToken, proof: p4, method: "POST", path: "/v1/x", body }),
      ),
    ).toBe("SIGNATURE_INVALID");
    // Unknown token and stale proof.
    const p5 = admin.proof("POST", "/v1/x", body);
    expect(
      code(() =>
        h.svc.authenticate({ sessionToken: "x".repeat(43), proof: p5, method: "POST", path: "/v1/x", body }),
      ),
    ).toBe("UNAUTHENTICATED");
    const p6 = admin.proof("POST", "/v1/x", body);
    h.clock.advance(2 * 60_000 + 1);
    expect(
      code(() =>
        h.svc.authenticate({ sessionToken: g.sessionToken, proof: p6, method: "POST", path: "/v1/x", body }),
      ),
    ).toBe("EXPIRED");
  });

  it("issues separate sessions for separate logins and expires them", () => {
    const h = makeHarness();
    const admin = bootstrap(h);
    const c = h.svc.createLoginChallenge({ principalId: admin.principalId, publicKey: admin.key.publicKey });
    expect(c.payload.purpose).toBe("LOGIN");
    const second = h.svc.completeLogin({ challengeId: c.challengeId, proof: signChallenge(admin.key, c) });
    expect(second.sessionId).not.toBe(admin.grant!.sessionId);
    expect(second.sessionToken).not.toBe(admin.grant!.sessionToken);
    // A key that is not the principal's enrolled key cannot log in as it.
    const impostor = generateEd25519KeyPair();
    expect(
      code(() =>
        h.svc.createLoginChallenge({ principalId: admin.principalId, publicKey: impostor.publicKey }),
      ),
    ).toBe("UNAUTHENTICATED");
    h.clock.advance(8 * 3600_000);
    expect(code(() => admin.ctx())).toBe("UNAUTHENTICATED");
  });

  it("keeps sessions and consumed request nonces durable across restart", () => {
    const h = makeHarness();
    const admin = bootstrap(h);
    const body = "{}";
    const proof = admin.proof("POST", "/v1/x", body);
    h.svc.authenticate({
      sessionToken: admin.grant!.sessionToken,
      proof,
      method: "POST",
      path: "/v1/x",
      body,
    });
    h.reopen();
    expect(code(() => admin.ctx())).toBe("NO_ERROR");
    expect(
      code(() =>
        h.svc.authenticate({
          sessionToken: admin.grant!.sessionToken,
          proof,
          method: "POST",
          path: "/v1/x",
          body,
        }),
      ),
    ).toBe("NONCE_REPLAYED");
  });

  it("never stores session tokens in plaintext", () => {
    const h = makeHarness();
    const admin = new Actor(h);
    const c = h.svc.createBootstrapChallenge({ organizationName: "Acme", publicKey: admin.key.publicKey });
    admin.grant = h.svc.completeBootstrap({ challengeId: c.challengeId, proof: signChallenge(admin.key, c) });
    const rows = h.db.all("SELECT * FROM sessions");
    expect(JSON.stringify(rows)).not.toContain(admin.grant.sessionToken);
  });
});
