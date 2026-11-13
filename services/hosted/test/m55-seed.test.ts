/**
 * M55 demo seed: enrols the demo organisations of a hosted deployment through the real control API
 * over HTTP (bootstrap challenges, request proofs, service proof of possession from isolated signer
 * processes). Real SQLite file, real Ed25519 keys; the invited people here are separate clients
 * with their own keys, exactly as a browser would be.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorityService } from "@dockside/authority";
import {
  digestHexFor,
  fromTypedJson,
  generateEd25519KeyPair,
  loadConfig,
  randomIds,
  signFor,
  systemClock,
  type TypedJson,
} from "@dockside/core";
import { EvidenceService, HoldService, LocalObjectStore } from "@dockside/evidence";
import { AssetRecoveryJournal, JournalService } from "@dockside/journal";
import { EscrowContract, JsonRpcNearClient, NearTxClient, Nep141Reader } from "@dockside/near";
import { ReleaseService } from "@dockside/release";
import { Database } from "@dockside/store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../api/src/app.js";
import { commercialDocsPolicy as webTemplate } from "../../../apps/web/src/lib/policy-template.js";
import { commercialDocsPolicy } from "../src/demo-policy.js";
import { type SeedContext, seedEnroll, seedGrant, seedStatus } from "../src/seed.js";

const ORIGIN = "https://dockside.example";
let dir: string;
let db: Database;
let server: Server;
let ctx: SeedContext;

function seedFile(name: string): string {
  const file = join(dir, name);
  writeFileSync(file, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
  return file;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "dockside-m55-seed-"));
  const config = loadConfig({
    DOCKSIDE_DB_PATH: join(dir, "api.sqlite"),
    DOCKSIDE_OBJECT_STORE_DIR: join(dir, "objects"),
    DOCKSIDE_ORIGIN: ORIGIN,
    DOCKSIDE_ESCROW_CONTRACT_ID: "escrow.dockside-demo.testnet",
    DOCKSIDE_NEAR_RPC_URL: "http://127.0.0.1:9",
  });
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
  // The trade modules exactly as services/api/src/main.ts wires them. Nothing in this suite calls
  // the chain: organisations, policies, service identities and invitations live in the database.
  const rpc = new JsonRpcNearClient({
    endpoint: "http://127.0.0.1:9",
    allowedHosts: ["127.0.0.1"],
    timeoutMs: 1_000,
    maxResponseBytes: 1024,
  });
  const escrow = new EscrowContract(rpc, "escrow.dockside-demo.testnet");
  const deps = { db, clock: systemClock, ids: randomIds, authority };
  const evidence = new EvidenceService({
    ...deps,
    objects: new LocalObjectStore(config.DOCKSIDE_OBJECT_STORE_DIR, "m55-seed-test"),
  });
  const holds = new HoldService({ ...deps, evidence });
  const release = new ReleaseService({ ...deps, evidence, holds, escrow });
  const journal = new JournalService({ db, clock: systemClock, ids: randomIds, escrow, release });
  const assetRecovery = {
    journal: new AssetRecoveryJournal(db, systemClock, randomIds),
    token: (c: string) => new Nep141Reader(rpc, c),
    tx: new NearTxClient(rpc),
  };
  server = createServer(
    createApp({
      config,
      db,
      authority,
      clock: systemClock,
      ids: randomIds,
      modules: { evidence, holds, release, journal, escrow, assetRecovery, chain: assetRecovery.tx },
    }),
  );
  const port = await new Promise<number>((res) =>
    server.listen(0, "127.0.0.1", () => res((server.address() as AddressInfo).port)),
  );
  ctx = {
    apiBase: `http://127.0.0.1:${port}`,
    origin: ORIGIN,
    stateDir: join(dir, "demo-seed"),
    manifestAttestorKeyFile: seedFile("manifest-attestor.seed"),
    deterministicPolicyKeyFile: seedFile("deterministic-policy.seed"),
  };
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A person on their own device: accepts an invitation with a key only they hold. */
async function acceptInvitation(secret: string, displayName: string): Promise<string> {
  const key = generateEd25519KeyPair();
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${ctx.apiBase}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const ch = await post("/v1/invitations/challenges", {
    invitationSecret: secret,
    publicKey: key.publicKey,
    displayName,
  });
  expect(ch.status).toBe(201);
  const payload = fromTypedJson(ch.json["payload"] as TypedJson);
  expect(digestHexFor("POP_CHALLENGE", payload)).toBe(ch.json["digestHex"]);
  const done = await post("/v1/invitations/accept", {
    challengeId: ch.json["challengeId"],
    proof: { scheme: "dockside-ed25519", signature: signFor(key.privateKey, "POP_CHALLENGE", payload) },
  });
  expect(done.status).toBe(201);
  return String(done.json["principalId"]);
}

describe("M55 demo seed through the real API", () => {
  it("uses the same commercial-documents policy as the web app's template", () => {
    expect(commercialDocsPolicy("commercial-docs")).toEqual(webTemplate("commercial-docs"));
  });

  const secrets: Record<string, string> = {};
  let first: Awaited<ReturnType<typeof seedEnroll>>;

  it("enrols three organisations, the evidence policy, both services and four invitations", async () => {
    first = await seedEnroll(ctx);
    expect(first.organizations.map((o) => o.role)).toEqual(["buyer", "supplier", "inspector"]);
    expect(new Set(first.organizations.map((o) => o.organizationId)).size).toBe(3);
    for (const o of first.organizations) {
      expect(o.organizationId).toMatch(/^org_/);
      expect(o.created).toBe(true);
      expect(db.get("SELECT name FROM organizations WHERE id = ?", o.organizationId)?.["name"]).toBe(o.name);
    }
    expect(first.policy).toMatchObject({ policyId: "commercial-docs", revision: 1, created: true });
    expect(
      db.get("SELECT organization_id FROM evidence_policy_owners WHERE policy_id = 'commercial-docs'")?.[
        "organization_id"
      ],
    ).toBe(first.organizations[0]?.organizationId);
    expect(first.services.map((s) => [s.serviceId, s.capability, s.status, s.created])).toEqual([
      ["manifest-attestor", "MANIFEST_ATTEST", "ACTIVE", true],
      ["deterministic-policy", "DETERMINISTIC_POLICY_SET", "ACTIVE", true],
    ]);
    const enrolled = db.all(
      "SELECT service_id, status, organization_id FROM service_enrollments ORDER BY created_at, id",
    );
    expect(enrolled.map((r) => [r["service_id"], r["status"], r["organization_id"]])).toEqual([
      ["manifest-attestor", "ACTIVE", first.organizations[0]?.organizationId],
      ["deterministic-policy", "ACTIVE", first.organizations[0]?.organizationId],
    ]);
    expect(first.invitations.map((i) => [i.role, i.capability])).toEqual([
      ["buyer", "BUYER_APPROVER"],
      ["buyer", "RISK_RESOLVER"],
      ["supplier", "SUPPLIER_SIGNER"],
      ["inspector", "INSPECTOR"],
    ]);
    for (const i of first.invitations) {
      expect(i.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      secrets[i.capability] = i.secret as string;
    }
    expect(first.signInUrl).toBe(`${ORIGIN}/sign-in`);
  });

  it("keeps administrator keys in owner-only files and no invitation secret on disk", () => {
    const names = readdirSync(ctx.stateDir).sort();
    expect(names).toEqual(["buyer-admin.seed", "inspector-admin.seed", "state.json", "supplier-admin.seed"]);
    const state = readFileSync(join(ctx.stateDir, "state.json"), "utf8");
    for (const s of Object.values(secrets)) expect(state).not.toContain(s);
    for (const n of names.filter((f) => f.endsWith(".seed")))
      expect(state).not.toContain(readFileSync(join(ctx.stateDir, n), "utf8").trim());
    if (process.platform !== "win32")
      for (const n of names) expect(statSync(join(ctx.stateDir, n)).mode & 0o077).toBe(0);
  });

  it("is safe to run again: nothing is created twice and no secret is shown again", async () => {
    const again = await seedEnroll(ctx);
    expect(again.organizations.map((o) => [o.organizationId, o.created])).toEqual(
      first.organizations.map((o) => [o.organizationId, false]),
    );
    expect(again.policy.created).toBe(false);
    expect(again.services.map((s) => [s.status, s.created])).toEqual([
      ["ACTIVE", false],
      ["ACTIVE", false],
    ]);
    expect(again.invitations.map((i) => i.invitationId)).toEqual(
      first.invitations.map((i) => i.invitationId),
    );
    for (const i of again.invitations) expect(i.secret).toBeUndefined();
    expect(Number(db.get("SELECT COUNT(*) AS n FROM organizations")?.["n"])).toBe(3);
    expect(Number(db.get("SELECT COUNT(*) AS n FROM invitations")?.["n"])).toBe(4);
  });

  it("grants a role only after its person accepted, and reports who is still pending", async () => {
    const before = await seedGrant(ctx);
    expect(before.map((g) => g.state)).toEqual(["PENDING", "PENDING", "PENDING", "PENDING"]);

    const approver = await acceptInvitation(secrets["BUYER_APPROVER"] as string, "Asha (buyer approver)");
    const supplier = await acceptInvitation(secrets["SUPPLIER_SIGNER"] as string, "Ravi (supplier signer)");
    const after = await seedGrant(ctx);
    expect(after.map((g) => [g.capability, g.state, g.principalId ?? null])).toEqual([
      ["BUYER_APPROVER", "GRANTED", approver],
      ["RISK_RESOLVER", "PENDING", null],
      ["SUPPLIER_SIGNER", "GRANTED", supplier],
      ["INSPECTOR", "PENDING", null],
    ]);
    const grants = db.all("SELECT principal_id, capability FROM role_grants WHERE invitation_id IS NOT NULL");
    expect(grants.map((g) => [g["principal_id"], g["capability"]]).sort()).toEqual(
      [
        [approver, "BUYER_APPROVER"],
        [supplier, "SUPPLIER_SIGNER"],
      ].sort(),
    );
    // Granting again changes nothing.
    expect((await seedGrant(ctx)).map((g) => g.state)).toEqual(["GRANTED", "PENDING", "GRANTED", "PENDING"]);
  });

  it("issues fresh invitations for roles nobody holds yet when asked to", async () => {
    const re = await seedEnroll({ ...ctx, reissue: true });
    const fresh = re.invitations.filter((i) => i.secret !== undefined);
    expect(fresh.map((i) => i.capability)).toEqual(["RISK_RESOLVER", "INSPECTOR"]);
    for (const i of fresh) expect(first.invitations.map((f) => f.invitationId)).not.toContain(i.invitationId);
    const inspector = await acceptInvitation(
      fresh.find((i) => i.capability === "INSPECTOR")?.secret as string,
      "Meera (inspector)",
    );
    const g = await seedGrant(ctx);
    expect(g.find((x) => x.capability === "INSPECTOR")).toMatchObject({
      state: "GRANTED",
      principalId: inspector,
    });
  });

  it("reports each organisation's people and services as the API lists them", async () => {
    const status = await seedStatus(ctx);
    expect(status.organizations.map((o) => o.role)).toEqual(["buyer", "supplier", "inspector"]);
    const buyer = status.organizations[0];
    expect(buyer?.services.map((s) => [s.serviceId, s.status])).toEqual([
      ["manifest-attestor", "ACTIVE"],
      ["deterministic-policy", "ACTIVE"],
    ]);
    expect(buyer?.principals.map((p) => p.capabilities.join(","))).toEqual([
      "ORG_SECURITY_ADMIN",
      "BUYER_APPROVER",
    ]);
    expect(status.organizations[2]?.principals.map((p) => p.displayName)).toContain("Meera (inspector)");
  });

  it("refuses to run against a deployment with another origin than the one it enrolled", async () => {
    await expect(seedEnroll({ ...ctx, origin: "https://other.example" })).rejects.toMatchObject({
      code: "SEED_STATE_MISMATCH",
    });
  });

  it("stops with the API's own error when the API refuses a step", async () => {
    const other = { ...ctx, stateDir: join(dir, "second-seed") };
    // A second seed state on the same database: its buyer organisation cannot take over the
    // policy id the first one registered. The API refuses, and the seed reports that refusal.
    await expect(seedEnroll(other)).rejects.toMatchObject({ code: "FORBIDDEN", step: "evidence-policy" });
    expect(existsSync(join(other.stateDir, "state.json"))).toBe(true);
  });
});
