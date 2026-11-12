/**
 * M27 — revoking the pending key of an open recovery is final (external security audit, low).
 *
 * A security administrator starts a recovery of another principal with a new key it supplies.
 * A second administrator revokes that pending key to stop a suspected rogue recovery. The
 * revocation must close the recovery: the revoked key can never be proven, moved to
 * PENDING_ACTIVATION or ACTIVE, and can never log in as the target. Before the fix proveRecovery
 * overwrote REVOKED with PENDING_ACTIVATION and completeRecovery then activated the key.
 */
import { generateEd25519KeyPair, randomIds } from "@dockside/core";
import { AuditLog } from "@dockside/store";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Actor,
  bootstrap,
  closeHarnesses,
  code,
  enrollHuman,
  makeHarness,
  signChallenge,
} from "./helpers.js";

afterEach(closeHarnesses);

const DAY = 24 * 3600_000;

function world() {
  const h = makeHarness({ recoveryDelayMs: 2 * DAY });
  const admin = bootstrap(h, "Acme Imports");
  const buyer = enrollHuman(h, admin, "BUYER_APPROVER");
  const secondAdmin = enrollHuman(h, admin, "ORG_SECURITY_ADMIN");
  return { h, admin, buyer, secondAdmin };
}

type W = ReturnType<typeof world>;

function keyStatus(w: W, id: string): string {
  return String(w.h.db.get("SELECT status FROM key_versions WHERE id = ?", id)?.["status"]);
}

function recovery(w: W, id: string) {
  return w.h.db.get("SELECT * FROM recoveries WHERE id = ?", id) as Record<string, unknown>;
}

function relogin(w: W, a: Actor) {
  const c = w.h.svc.createLoginChallenge({ principalId: a.principalId, publicKey: a.key.publicKey });
  a.grant = w.h.svc.completeLogin({ challengeId: c.challengeId, proof: signChallenge(a.key, c) });
}

describe("M27 revoking a pending recovery key closes the recovery", () => {
  it("a revoked PENDING_PROOF recovery key cannot be proven, activated or used to log in", () => {
    const w = world();
    const rogueKey = generateEd25519KeyPair();
    const r = w.h.svc.startRecovery(w.admin.ctx(), {
      principalId: w.buyer.principalId,
      publicKey: rogueKey.publicKey,
    });
    const newKeyId = String(recovery(w, r.recoveryId)["new_key_version_id"]);
    expect(keyStatus(w, newKeyId)).toBe("PENDING_PROOF");
    expect(keyStatus(w, w.buyer.keyVersionId)).toBe("SUSPENDED");

    const revoked = w.h.svc.revokeKey(w.secondAdmin.ctx(), {
      keyVersionId: newKeyId,
      reason: "SUSPECTED_ROGUE",
    });
    expect(revoked.status).toBe("REVOKED");
    // The recovery is closed, exactly like a principal veto, and the target's keys come back.
    expect(recovery(w, r.recoveryId)["status"]).toBe("CANCELLED");
    expect(keyStatus(w, w.buyer.keyVersionId)).toBe("ACTIVE");
    const closed = new AuditLog(w.h.db, w.h.clock, randomIds)
      .list({}, 5000)
      .filter((e) => e.eventType === "RECOVERY_CANCELLED" && e.subjectId === r.recoveryId);
    expect(closed).toHaveLength(1);

    // The original challenge, still within its TTL, can no longer move the revoked key.
    expect(
      code(() =>
        w.h.svc.proveRecovery({
          challengeId: r.challenge.challengeId,
          proof: signChallenge(rogueKey, r.challenge),
        }),
      ),
    ).toBe("INVALID_STATE");
    expect(keyStatus(w, newKeyId)).toBe("REVOKED");

    w.h.clock.advance(2 * DAY + 1);
    relogin(w, w.admin);
    expect(code(() => w.h.svc.completeRecovery(w.admin.ctx(), { recoveryId: r.recoveryId }))).toBe(
      "INVALID_STATE",
    );
    expect(keyStatus(w, newKeyId)).toBe("REVOKED");
    // Never activated, so the key is unknown to login.
    expect(
      code(() =>
        w.h.svc.createLoginChallenge({ principalId: w.buyer.principalId, publicKey: rogueKey.publicKey }),
      ),
    ).toBe("UNAUTHENTICATED");
    // The target is not left without recourse: its own key still works and a new recovery may start.
    relogin(w, w.buyer);
    expect(code(() => w.buyer.ctx())).toBe("NO_ERROR");
    relogin(w, w.secondAdmin);
    expect(
      code(() =>
        w.h.svc.startRecovery(w.secondAdmin.ctx(), {
          principalId: w.buyer.principalId,
          publicKey: generateEd25519KeyPair().publicKey,
        }),
      ),
    ).toBe("NO_ERROR");
  });

  it("revoking a proven (PENDING_ACTIVATION) recovery key stops completion during the delay", () => {
    const w = world();
    const rogueKey = generateEd25519KeyPair();
    const r = w.h.svc.startRecovery(w.admin.ctx(), {
      principalId: w.buyer.principalId,
      publicKey: rogueKey.publicKey,
    });
    w.h.svc.proveRecovery({
      challengeId: r.challenge.challengeId,
      proof: signChallenge(rogueKey, r.challenge),
    });
    const newKeyId = String(recovery(w, r.recoveryId)["new_key_version_id"]);
    expect(keyStatus(w, newKeyId)).toBe("PENDING_ACTIVATION");
    w.h.svc.revokeKey(w.secondAdmin.ctx(), { keyVersionId: newKeyId, reason: "SUSPECTED_ROGUE" });
    expect(recovery(w, r.recoveryId)["status"]).toBe("CANCELLED");
    w.h.clock.advance(2 * DAY + 1);
    relogin(w, w.admin);
    expect(code(() => w.h.svc.completeRecovery(w.admin.ctx(), { recoveryId: r.recoveryId }))).toBe(
      "INVALID_STATE",
    );
    expect(keyStatus(w, newKeyId)).toBe("REVOKED");
    // The target's own key was restored, not revoked as RECOVERED.
    expect(keyStatus(w, w.buyer.keyVersionId)).toBe("ACTIVE");
  });

  it("proveRecovery and completeRecovery fail closed when the key left its expected state", () => {
    const w = world();
    const k = generateEd25519KeyPair();
    const r = w.h.svc.startRecovery(w.admin.ctx(), {
      principalId: w.buyer.principalId,
      publicKey: k.publicKey,
    });
    const newKeyId = String(recovery(w, r.recoveryId)["new_key_version_id"]);
    // Simulate a key row changed outside the recovery path while the recovery row stays open.
    w.h.db.run("UPDATE key_versions SET status = 'REVOKED' WHERE id = ?", newKeyId);
    expect(
      code(() =>
        w.h.svc.proveRecovery({ challengeId: r.challenge.challengeId, proof: signChallenge(k, r.challenge) }),
      ),
    ).toBe("INVALID_STATE");
    expect(keyStatus(w, newKeyId)).toBe("REVOKED");
    expect(recovery(w, r.recoveryId)["status"]).toBe("PENDING_PROOF");

    w.h.db.run("UPDATE key_versions SET status = 'PENDING_ACTIVATION' WHERE id = ?", newKeyId);
    w.h.db.run("UPDATE recoveries SET status = 'WAITING' WHERE id = ?", r.recoveryId);
    w.h.db.run("UPDATE key_versions SET status = 'REVOKED' WHERE id = ?", newKeyId);
    w.h.clock.advance(2 * DAY + 1);
    relogin(w, w.admin);
    expect(code(() => w.h.svc.completeRecovery(w.admin.ctx(), { recoveryId: r.recoveryId }))).toBe(
      "INVALID_STATE",
    );
    expect(keyStatus(w, newKeyId)).toBe("REVOKED");
    // The suspended key was not revoked as RECOVERED by a completion that never activated.
    expect(keyStatus(w, w.buyer.keyVersionId)).toBe("SUSPENDED");
    expect(recovery(w, r.recoveryId)["status"]).toBe("WAITING");
  });

  it("an ordinary recovery still completes", () => {
    const w = world();
    const k = generateEd25519KeyPair();
    const r = w.h.svc.startRecovery(w.admin.ctx(), {
      principalId: w.buyer.principalId,
      publicKey: k.publicKey,
    });
    w.h.svc.proveRecovery({ challengeId: r.challenge.challengeId, proof: signChallenge(k, r.challenge) });
    w.h.clock.advance(2 * DAY);
    relogin(w, w.admin);
    expect(w.h.svc.completeRecovery(w.admin.ctx(), { recoveryId: r.recoveryId }).status).toBe("ACTIVE");
  });
});
