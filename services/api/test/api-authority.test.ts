/**
 * M01 over real HTTP (T-004, T-005 at the API boundary): a node:http server on an
 * ephemeral port, real on-disk SQLite, real Ed25519 keys held by separate clients.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorityService } from "@dockside/authority";
import {
  digestHexFor,
  type Ed25519KeyPair,
  fromHex,
  fromTypedJson,
  generateEd25519KeyPair,
  loadConfig,
  newNonce,
  randomIds,
  sha256,
  signFor,
  signNep413,
  systemClock,
  type TypedJson,
  toHex,
} from "@dockside/core";
import { Database } from "@dockside/store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

const ORIGIN = "http://localhost:8787";
let dir: string;
let db: Database;
let server: Server;
let base: string;

function start(): Promise<void> {
  const config = loadConfig({ DOCKSIDE_DB_PATH: join(dir, "api.sqlite"), DOCKSIDE_ORIGIN: ORIGIN });
  db = Database.open(config.DOCKSIDE_DB_PATH);
  db.migrate();
  const authority = new AuthorityService({
    db,
    clock: systemClock,
    ids: randomIds,
    config: {
      origin: ORIGIN,
      network: "near-testnet",
      challengeTtlMs: config.DOCKSIDE_CHALLENGE_TTL_MS,
      sessionTtlMs: config.DOCKSIDE_SESSION_TTL_MS,
      invitationTtlMs: config.DOCKSIDE_INVITATION_TTL_MS,
      recoveryDelayMs: config.DOCKSIDE_RECOVERY_DELAY_MS,
      requestProofSkewMs: config.DOCKSIDE_REQUEST_PROOF_SKEW_MS,
    },
  });
  server = createServer(createApp({ config, db, authority, clock: systemClock, ids: randomIds }));
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    }),
  );
}

function stop(): Promise<void> {
  return new Promise((resolve) =>
    server.close(() => {
      db.close();
      resolve();
    }),
  );
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "dockside-api-"));
  await start();
});
afterAll(async () => {
  await stop();
  rmSync(dir, { recursive: true, force: true });
});

async function call(path: string, body?: unknown, headers: Record<string, string> = {}, rawBody?: string) {
  const init: RequestInit = {
    method: body === undefined && rawBody === undefined ? "GET" : "POST",
    headers: { ...headers },
  };
  if (init.method === "POST") {
    init.body = rawBody ?? JSON.stringify(body);
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  }
  const res = await fetch(base + path, init);
  return { status: res.status, headers: res.headers, json: (await res.json()) as any };
}

/** A client that recomputes the digest from the served typed payload before signing. */
function signServed(key: Ed25519KeyPair, ch: { payload: TypedJson; digestHex: string }) {
  const payload = fromTypedJson(ch.payload);
  expect(digestHexFor("POP_CHALLENGE", payload)).toBe(ch.digestHex);
  return { scheme: "dockside-ed25519", signature: signFor(key.privateKey, "POP_CHALLENGE", payload) };
}

class Client {
  token = "";
  sessionId = "";
  principalId = "";
  constructor(readonly key: Ed25519KeyPair = generateEd25519KeyPair()) {}
  headers(method: string, path: string, body: string): Record<string, string> {
    const issuedAt = Date.now();
    const nonce = newNonce();
    const payload = {
      sessionId: this.sessionId,
      origin: ORIGIN,
      method,
      path,
      bodyDigest: toHex(sha256(new TextEncoder().encode(body))),
      issuedAt,
      nonce,
    };
    const proof = {
      sessionId: this.sessionId,
      issuedAt,
      nonce,
      signature: signFor(this.key.privateKey, "REQUEST_PROOF", payload),
    };
    return {
      authorization: `Dockside-Session ${this.token}`,
      "dockside-proof": Buffer.from(JSON.stringify(proof)).toString("base64url"),
    };
  }
  async get(path: string) {
    return call(path, undefined, this.headers("GET", path, ""));
  }
  async post(path: string, body: unknown) {
    const raw = JSON.stringify(body);
    return call(path, undefined, this.headers("POST", path, raw), raw);
  }
  adopt(grant: { sessionToken: string; sessionId: string; principalId: string }) {
    this.token = grant.sessionToken;
    this.sessionId = grant.sessionId;
    this.principalId = grant.principalId;
  }
}

async function bootstrap(name: string, nep413 = false): Promise<Client> {
  const c = new Client();
  const ch = await call("/v1/bootstrap/challenges", { organizationName: name, publicKey: c.key.publicKey });
  expect(ch.status).toBe(201);
  const proof = nep413
    ? {
        scheme: "nep413",
        signature: signNep413(c.key.privateKey, {
          message: ch.json.nep413.message,
          nonce: fromHex(ch.json.nep413.nonceHex),
          recipient: ch.json.nep413.recipient,
        }),
      }
    : signServed(c.key, ch.json);
  const done = await call("/v1/bootstrap/complete", { challengeId: ch.json.challengeId, proof });
  expect(done.status).toBe(201);
  c.adopt(done.json);
  return c;
}

describe("M01 authority API over HTTP", () => {
  it("reports health and readiness with the migrated schema", async () => {
    expect((await call("/healthz")).json).toEqual({ status: "ok" });
    const ready = await call("/readyz");
    expect(ready.json).toMatchObject({
      ready: true,
      schemaVersion: 2,
      network: "near-testnet",
      fundedPayouts: "BLOCKED",
    });
  });

  it("bootstraps with a canonical signature and with a NEP-413 wallet signature", async () => {
    const a = await bootstrap("Acme Imports");
    const me = await a.get("/v1/me");
    expect(me.status).toBe(200);
    expect(me.json.capabilities).toEqual(["ORG_SECURITY_ADMIN"]);
    const b = await bootstrap("Harbor Supply", true);
    expect((await b.get("/v1/me")).json.principal.id).toBe(b.principalId);
  });

  it("requires a fresh proof for every authenticated request", async () => {
    const a = await bootstrap("Proof Org");
    expect((await call("/v1/me")).status).toBe(401);
    expect(
      (await call("/v1/me", undefined, { authorization: `Dockside-Session ${a.token}` })).json.error.code,
    ).toBe("UNAUTHENTICATED");
    const h = a.headers("GET", "/v1/me", "");
    expect((await call("/v1/me", undefined, h)).status).toBe(200);
    const replay = await call("/v1/me", undefined, h);
    expect(replay.status).toBe(409);
    expect(replay.json.error.code).toBe("NONCE_REPLAYED");
    // A proof for one path cannot authorize another.
    const other = await call("/v1/audit", undefined, a.headers("GET", "/v1/me", ""));
    expect(other.json.error.code).toBe("SIGNATURE_INVALID");
  });

  it("runs the invitation flow across separate HTTP sessions and blocks self-consumption", async () => {
    const admin = await bootstrap("Invite Org");
    const inv = await admin.post("/v1/invitations", { capability: "INSPECTOR" });
    expect(inv.status).toBe(201);
    const inspector = new Client();
    const ch = await call("/v1/invitations/challenges", {
      invitationSecret: inv.json.secret,
      publicKey: inspector.key.publicKey,
      displayName: "Ines Inspector",
    });
    // Accepting from inside the admin's session is rejected.
    const hostile = await call(
      "/v1/invitations/accept",
      { challengeId: ch.json.challengeId, proof: signServed(inspector.key, ch.json) },
      { authorization: `Dockside-Session ${admin.token}` },
    );
    expect(hostile.json.error.code).toBe("SEPARATION_OF_DUTIES");
    const acc = await call("/v1/invitations/accept", {
      challengeId: ch.json.challengeId,
      proof: signServed(inspector.key, ch.json),
    });
    expect(acc.status).toBe(201);
    inspector.adopt(acc.json);
    expect((await inspector.get("/v1/me")).json.capabilities).toEqual([]);
    // Recipient cannot grant itself.
    expect((await inspector.post(`/v1/invitations/${inv.json.invitationId}/grant`, {})).json.error.code).toBe(
      "FORBIDDEN",
    );
    const g = await admin.post(`/v1/invitations/${inv.json.invitationId}/grant`, {});
    expect(g.status).toBe(201);
    expect((await inspector.get("/v1/me")).json.capabilities).toEqual(["INSPECTOR"]);
    const audit = await admin.get("/v1/audit?limit=500");
    expect(audit.json.events.map((e: { eventType: string }) => e.eventType)).toEqual(
      expect.arrayContaining(["INVITATION_CREATED", "INVITATION_ACCEPTED", "ROLE_GRANTED"]),
    );
    expect(JSON.stringify(audit.json)).not.toContain(inv.json.secret);
    expect((await inspector.get("/v1/audit")).json.error.code).toBe("FORBIDDEN");
  });

  it("fails closed on wrong origin, duplicate keys, unknown fields, oversize bodies and wrong content type", async () => {
    const pk = generateEd25519KeyPair().publicKey;
    const wrongOrigin = await call(
      "/v1/bootstrap/challenges",
      { organizationName: "X", publicKey: pk },
      { origin: "https://evil.example" },
    );
    expect(wrongOrigin.status).toBe(403);
    expect(wrongOrigin.json.error.code).toBe("WRONG_ORIGIN");
    const dup = await call(
      "/v1/bootstrap/challenges",
      undefined,
      {},
      `{"organizationName":"X","organizationName":"Y","publicKey":"${pk}"}`,
    );
    expect(dup.json.error.code).toBe("DUPLICATE_KEY");
    const unknown = await call("/v1/bootstrap/challenges", {
      organizationName: "X",
      publicKey: pk,
      role: "RISK_RESOLVER",
    });
    expect(unknown.json.error.code).toBe("UNKNOWN_FIELD");
    const big = await call(
      "/v1/bootstrap/challenges",
      undefined,
      {},
      JSON.stringify({ organizationName: "x".repeat(70_000), publicKey: pk }),
    );
    expect(big.status).toBe(413);
    const res = await fetch(`${base}/v1/bootstrap/challenges`, {
      method: "POST",
      body: "organizationName=X",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(((await res.json()) as any).error.code).toBe("VALIDATION_FAILED");
    expect((await call("/v1/nope")).status).toBe(404);
  });

  it("sets security headers and never leaks stacks", async () => {
    const r = await call("/v1/bootstrap/complete", {
      challengeId: `chl_${"0".repeat(32)}`,
      proof: { scheme: "dockside-ed25519", signature: "x" },
    });
    expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(r.json)).not.toMatch(/at .*\.ts:\d+/);
  });

  it("keeps sessions valid across a server and database restart", async () => {
    const a = await bootstrap("Restart Org");
    await stop();
    await start();
    expect((await a.get("/v1/me")).json.principal.id).toBe(a.principalId);
  });
});
