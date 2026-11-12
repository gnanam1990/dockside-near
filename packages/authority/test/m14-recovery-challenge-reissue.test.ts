/**
 * M14 — re-issuing an expired key-recovery challenge (T-006 follow-up, ADR-0012 consequence).
 *
 * A recovery whose RECOVERY_KEY challenge expired before the principal proved the new key was
 * stuck: the challenge could not be answered and a second recovery was refused while it stayed
 * open. A different security administrator of the same organization may now re-issue the
 * challenge for the same recovery: same new key and version, same not-before (the delay keeps
 * running from the original request), the old challenge stays unusable, every step is audited.
 */
import { generateEd25519KeyPair, randomIds } from "@dockside/core";
import { AuditLog } from "@dockside/store";
import { afterAll, describe, expect, it } from "vitest";
import { bootstrap, closeHarnesses, code, enrollHuman, makeHarness, signChallenge } from "./helpers.js";

afterAll(() => closeHarnesses());

const DAY = 24 * 3600_000;

function world(recoveryChallengeTtlMs?: number) {
  const h = makeHarness({
    recoveryDelayMs: 2 * DAY,
    ...(recoveryChallengeTtlMs ? { recoveryChallengeTtlMs } : {}),
  });
  const admin = bootstrap(h, "Acme Imports");
  const otherAdmin = bootstrap(h, "Elsewhere Freight");
  const buyer = enrollHuman(h, admin, "BUYER_APPROVER");
  const secondAdmin = enrollHuman(h, admin, "ORG_SECURITY_ADMIN");
  const auditor = enrollHuman(h, admin, "AUDITOR");
  return { h, admin, otherAdmin, buyer, secondAdmin, auditor };
}

function events(w: ReturnType<typeof world>, type: string) {
  return new AuditLog(w.h.db, w.h.clock, randomIds).list({}, 5000).filter((e) => e.eventType === type);
}

describe("M14 re-issuing an expired recovery challenge", () => {
  it("refuses while the current challenge is still open, then re-issues once it expired", () => {
    const w = world();
    const newKey = generateEd25519KeyPair();
    const r = w.h.svc.startRecovery(w.admin.ctx(), {
      principalId: w.buyer.principalId,
      publicKey: newKey.publicKey,
    });
    expect(code(() => w.h.svc.reissueRecoveryChallenge(w.admin.ctx(), { recoveryId: r.recoveryId }))).toBe(
      "INVALID_STATE",
    );
    const dir0 = w.h.svc.organizationDirectory(w.admin.ctx());
    expect(dir0.recoveries[0]).toMatchObject({
      status: "PENDING_PROOF",
      challengeExpiresAt: r.challenge.expiresAt,
    });
    w.h.clock.advance(r.challenge.expiresAt - w.h.clock.now());
    // The expired challenge can no longer be answered.
    expect(
      code(() =>
        w.h.svc.proveRecovery({
          challengeId: r.challenge.challengeId,
          proof: signChallenge(newKey, r.challenge),
        }),
      ),
    ).toBe("EXPIRED");
    // And a second recovery is still refused while this one is open.
    expect(
      code(() =>
        w.h.svc.startRecovery(w.admin.ctx(), {
          principalId: w.buyer.principalId,
          publicKey: generateEd25519KeyPair().publicKey,
        }),
      ),
    ).toBe("INVALID_STATE");
    const again = w.h.svc.reissueRecoveryChallenge(w.admin.ctx(), { recoveryId: r.recoveryId });
    expect(again.recoveryId).toBe(r.recoveryId);
    expect(again.keyVersion).toBe(r.keyVersion);
    expect(again.notBefore).toBe(r.notBefore);
    expect(again.challenge.challengeId).not.toBe(r.challenge.challengeId);
    expect(again.challenge.payload).toMatchObject({
      purpose: "RECOVERY_KEY",
      recoveryId: r.recoveryId,
      principalId: w.buyer.principalId,
      publicKey: newKey.publicKey,
      keyVersion: r.keyVersion,
    });
    expect(again.challenge.expiresAt).toBeGreaterThan(w.h.clock.now());
    expect(events(w, "RECOVERY_CHALLENGE_REISSUED")).toHaveLength(1);
    const dir = w.h.svc.organizationDirectory(w.admin.ctx());
    expect(dir.recoveries[0]?.challengeExpiresAt).toBe(again.challenge.expiresAt);
    // The old challenge stays dead; the new one is proven by the new key only.
    expect(
      code(() =>
        w.h.svc.proveRecovery({
          challengeId: r.challenge.challengeId,
          proof: signChallenge(newKey, r.challenge),
        }),
      ),
    ).toBe("EXPIRED");
    expect(
      code(() =>
        w.h.svc.proveRecovery({
          challengeId: again.challenge.challengeId,
          proof: signChallenge(generateEd25519KeyPair(), again.challenge),
        }),
      ),
    ).toBe("SIGNATURE_INVALID");
    w.h.svc.proveRecovery({
      challengeId: again.challenge.challengeId,
      proof: signChallenge(newKey, again.challenge),
    });
    // Once proven there is nothing to re-issue; the delay still runs from the original request.
    expect(code(() => w.h.svc.reissueRecoveryChallenge(w.admin.ctx(), { recoveryId: r.recoveryId }))).toBe(
      "INVALID_STATE",
    );
    expect(code(() => w.h.svc.completeRecovery(w.admin.ctx(), { recoveryId: r.recoveryId }))).toBe(
      "DELAY_NOT_ELAPSED",
    );
  });

  it("only a security administrator of the same organization other than the principal may re-issue", () => {
    const w = world();
    const newKey = generateEd25519KeyPair();
    const r = w.h.svc.startRecovery(w.admin.ctx(), {
      principalId: w.secondAdmin.principalId,
      publicKey: newKey.publicKey,
    });
    w.h.clock.advance(r.challenge.expiresAt - w.h.clock.now() + 1);
    expect(code(() => w.h.svc.reissueRecoveryChallenge(w.auditor.ctx(), { recoveryId: r.recoveryId }))).toBe(
      "FORBIDDEN",
    );
    expect(
      code(() => w.h.svc.reissueRecoveryChallenge(w.otherAdmin.ctx(), { recoveryId: r.recoveryId })),
    ).toBe("FORBIDDEN");
    expect(code(() => w.h.svc.reissueRecoveryChallenge(w.buyer.ctx(), { recoveryId: r.recoveryId }))).toBe(
      "FORBIDDEN",
    );
    expect(code(() => w.h.svc.reissueRecoveryChallenge(w.admin.ctx(), { recoveryId: "rec_missing" }))).toBe(
      "NOT_FOUND",
    );
    expect(events(w, "RECOVERY_CHALLENGE_REISSUED")).toHaveLength(0);
    expect(events(w, "AUTHORITY_DENIED").length).toBeGreaterThanOrEqual(1);
    const ok = w.h.svc.reissueRecoveryChallenge(w.admin.ctx(), { recoveryId: r.recoveryId });
    expect(ok.challenge.payload).toMatchObject({ principalId: w.secondAdmin.principalId });
  });

  it("a cancelled or completed recovery is closed for re-issue", () => {
    const w = world();
    const newKey = generateEd25519KeyPair();
    const r = w.h.svc.startRecovery(w.admin.ctx(), {
      principalId: w.buyer.principalId,
      publicKey: newKey.publicKey,
    });
    const veto = w.h.svc.createRecoveryCancelChallenge({ recoveryId: r.recoveryId });
    w.h.svc.cancelRecovery({ challengeId: veto.challengeId, proof: signChallenge(w.buyer.key, veto) });
    w.h.clock.advance(r.challenge.expiresAt - w.h.clock.now() + 1);
    expect(code(() => w.h.svc.reissueRecoveryChallenge(w.admin.ctx(), { recoveryId: r.recoveryId }))).toBe(
      "INVALID_STATE",
    );
  });

  it("the recovery challenge lifetime is its own setting (out-of-band hand-over), bounded by its own maximum", () => {
    const w = world(30 * 60_000);
    const newKey = generateEd25519KeyPair();
    const r = w.h.svc.startRecovery(w.admin.ctx(), {
      principalId: w.buyer.principalId,
      publicKey: newKey.publicKey,
    });
    expect(r.challenge.expiresAt - w.h.clock.now()).toBe(30 * 60_000);
    // Longer than the general five-minute challenge lifetime, and still provable.
    w.h.clock.advance(20 * 60_000);
    expect(
      w.h.svc.proveRecovery({
        challengeId: r.challenge.challengeId,
        proof: signChallenge(newKey, r.challenge),
      }).status,
    ).toBe("WAITING");
    // Sign-in challenges keep the general lifetime.
    const login = w.h.svc.createLoginChallenge({
      principalId: w.admin.principalId,
      publicKey: w.admin.key.publicKey,
    });
    expect(login.expiresAt - w.h.clock.now()).toBe(5 * 60_000);
  });
});
