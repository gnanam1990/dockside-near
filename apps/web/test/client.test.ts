/**
 * The browser API client against the real M01 control API: node:http on an ephemeral
 * port, on-disk SQLite, WebCrypto Ed25519 device keys (non-extractable). Nothing is
 * mocked; the client must produce proofs the real authority service accepts.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@dockside/api";
import { AuthorityService } from "@dockside/authority";
import { loadConfig, randomIds, systemClock } from "@dockside/core";
import { Database } from "@dockside/store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ActiveSession, DocksideClient } from "../src/lib/api/client";
import type { ChallengeResponse, SessionGrant } from "../src/lib/api/types";
import { type DeviceKeyRecord, generateDeviceKey } from "../src/lib/keys";

let dir: string;
let db: Database;
let server: Server;
let base: string;
let origin: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "dockside-web-client-"));
  server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  origin = base;
  const config = loadConfig({ DOCKSIDE_DB_PATH: join(dir, "api.sqlite"), DOCKSIDE_ORIGIN: origin });
  db = Database.open(config.DOCKSIDE_DB_PATH);
  db.migrate();
  const authority = new AuthorityService({
    db,
    clock: systemClock,
    ids: randomIds,
    config: {
      origin,
      network: "near-testnet",
      challengeTtlMs: config.DOCKSIDE_CHALLENGE_TTL_MS,
      sessionTtlMs: config.DOCKSIDE_SESSION_TTL_MS,
      invitationTtlMs: config.DOCKSIDE_INVITATION_TTL_MS,
      recoveryDelayMs: config.DOCKSIDE_RECOVERY_DELAY_MS,
      requestProofSkewMs: config.DOCKSIDE_REQUEST_PROOF_SKEW_MS,
    },
  });
  server.on("request", createApp({ config, db, authority, clock: systemClock, ids: randomIds }));
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function client(): DocksideClient {
  return new DocksideClient({ baseUrl: base, origin });
}

async function signIn(
  c: DocksideClient,
  key: DeviceKeyRecord,
  challenge: ChallengeResponse,
  purpose: "ORG_BOOTSTRAP" | "LOGIN" | "INVITATION_ACCEPT",
  complete: (id: string, sig: string) => Promise<{ ok: boolean; data?: SessionGrant }>,
): Promise<ActiveSession> {
  const v = await c.verifyChallenge(challenge, { purpose, publicKey: key.publicKey });
  if (!v.ok) throw new Error(v.reason);
  const sig = await c.signVerified(v.value, key.privateKey);
  const out = await complete(challenge.challengeId, sig);
  if (!out.ok || !out.data) throw new Error("completion failed");
  const s = { grant: out.data, publicKey: key.publicKey, privateKey: key.privateKey };
  c.setSession(s);
  return s;
}

describe("web API client against the real control API", () => {
  it("generates non-extractable device keys", async () => {
    const k = await generateDeviceKey("test", Date.now());
    expect(k.extractable).toBe(false);
    expect(k.publicKey).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  });

  it("bootstraps, authenticates every request with PoP, invites and grants in separate sessions", async () => {
    const admin = client();
    const adminKey = await generateDeviceKey("admin", Date.now());
    const ch = await admin.bootstrapChallenge("Harbor Imports", adminKey.publicKey);
    expect(ch.ok).toBe(true);
    if (!ch.ok) return;
    const s = await signIn(admin, adminKey, ch.data, "ORG_BOOTSTRAP", (id, sig) =>
      admin.bootstrapComplete(id, sig),
    );
    expect(s.grant.capabilities).toContain("ORG_SECURITY_ADMIN");

    const me = await admin.me();
    expect(me.ok && me.data.principal.id).toBe(s.grant.principalId);
    expect(me.ok && me.data.keyVersion.publicKey).toBe(adminKey.publicKey);

    const ready = await admin.ready();
    expect(ready.ok && ready.data.network).toBe("near-testnet");

    const audit = await admin.audit(50);
    expect(audit.ok).toBe(true);
    if (audit.ok) expect(audit.data.events.map((e) => e.eventType)).toContain("ORG_BOOTSTRAPPED");

    const inv = await admin.createInvitation("BUYER_APPROVER");
    expect(inv.ok).toBe(true);
    if (!inv.ok) return;

    // Recipient: its own client, its own key, its own session.
    const buyer = client();
    const buyerKey = await generateDeviceKey("buyer", Date.now());
    const bch = await buyer.invitationChallenge(inv.data.secret, buyerKey.publicKey, "Buyer approver");
    expect(bch.ok).toBe(true);
    if (!bch.ok) return;
    const bs = await signIn(buyer, buyerKey, bch.data, "INVITATION_ACCEPT", (id, sig) =>
      buyer.acceptInvitation(id, sig),
    );
    const pending = await buyer.me();
    expect(pending.ok && pending.data.principal.status).toBe("PENDING_GRANT");
    expect(pending.ok && pending.data.capabilities).toEqual([]);

    // A recipient cannot grant itself; the administrator grants later.
    const self = await buyer.grantInvitation(inv.data.invitationId);
    expect(self.ok).toBe(false);
    const granted = await admin.grantInvitation(inv.data.invitationId);
    expect(granted.ok && granted.data.capability).toBe("BUYER_APPROVER");
    expect(granted.ok && granted.data.principalId).toBe(bs.grant.principalId);
    const after = await buyer.me();
    expect(after.ok && after.data.capabilities).toContain("BUYER_APPROVER");

    // The buyer session cannot read the audit log.
    const denied = await buyer.audit();
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error).toMatchObject({ kind: "http", code: "FORBIDDEN" });

    // Sign in again with the stored key through the login challenge.
    const again = client();
    const lc = await again.loginChallenge(s.grant.principalId, adminKey.publicKey);
    expect(lc.ok).toBe(true);
    if (!lc.ok) return;
    await signIn(again, adminKey, lc.data, "LOGIN", (id, sig) => again.loginComplete(id, sig));
    const me2 = await again.me();
    expect(me2.ok && me2.data.principal.id).toBe(s.grant.principalId);
  });

  it("reports a route the running build does not serve as endpoint-unavailable, not as data", async () => {
    const c = client();
    const k = await generateDeviceKey("t", Date.now());
    const ch = await c.bootstrapChallenge("Unwired Co", k.publicKey);
    if (!ch.ok) throw new Error("challenge failed");
    await signIn(c, k, ch.data, "ORG_BOOTSTRAP", (id, sig) => c.bootstrapComplete(id, sig));
    const trades = await c.listTrades();
    expect(trades.ok).toBe(false);
    if (!trades.ok)
      expect(trades.error).toEqual({ kind: "endpoint-unavailable", method: "GET", path: "/v1/trades" });
  });

  it("refuses to sign a challenge whose digest, origin, key or purpose differs", async () => {
    const c = client();
    const k = await generateDeviceKey("t", Date.now());
    const other = await generateDeviceKey("o", Date.now());
    const ch = await c.bootstrapChallenge("Careful Co", k.publicKey);
    if (!ch.ok) throw new Error("challenge failed");
    const wrongKey = await c.verifyChallenge(ch.data, {
      purpose: "ORG_BOOTSTRAP",
      publicKey: other.publicKey,
    });
    expect(wrongKey).toMatchObject({ ok: false, reason: "challenge names a different key" });
    const wrongPurpose = await c.verifyChallenge(ch.data, { purpose: "LOGIN", publicKey: k.publicKey });
    expect(wrongPurpose.ok).toBe(false);
    const tampered = { ...ch.data, digestHex: "00".repeat(32) };
    const t = await c.verifyChallenge(tampered, { purpose: "ORG_BOOTSTRAP", publicKey: k.publicKey });
    expect(t).toMatchObject({ ok: false, reason: "server digest does not match payload" });
    const elsewhere = new DocksideClient({ baseUrl: base, origin: "https://phish.example" });
    const o = await elsewhere.verifyChallenge(ch.data, { purpose: "ORG_BOOTSTRAP", publicKey: k.publicKey });
    expect(o.ok).toBe(false);
  });

  it("an authenticated call without a session never reaches the network", async () => {
    let calls = 0;
    const c = new DocksideClient({
      baseUrl: base,
      origin,
      fetch: (async (...args: Parameters<typeof fetch>) => {
        calls++;
        return fetch(...args);
      }) as typeof fetch,
    });
    const me = await c.me();
    expect(me).toMatchObject({ ok: false, error: { kind: "no-session" } });
    expect(calls).toBe(0);
  });

  it("a proof signed for another origin is rejected by the server", async () => {
    const c = client();
    const k = await generateDeviceKey("t", Date.now());
    const ch = await c.bootstrapChallenge("Origin Co", k.publicKey);
    if (!ch.ok) throw new Error("challenge failed");
    const s = await signIn(c, k, ch.data, "ORG_BOOTSTRAP", (id, sig) => c.bootstrapComplete(id, sig));
    const wrong = new DocksideClient({ baseUrl: base, origin: "http://127.0.0.1:1" });
    wrong.setSession(s);
    const me = await wrong.me();
    expect(me.ok).toBe(false);
    if (!me.ok) expect(me.error).toMatchObject({ kind: "http", code: "SIGNATURE_INVALID" });
  });
});
