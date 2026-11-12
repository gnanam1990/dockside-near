/**
 * M17 over the real HTTP API on the M07 world (separately enrolled principals, compiled escrow wasm
 * on the simulated NEAR host behind JSON-RPC):
 *  (a) organization settings: retention revisions with compare-and-swap, evidence-policy ownership,
 *      integrations and the RPC connection test, each with authority checks and audit;
 *  (b) signed audit export with a dedicated export key in an isolated signer process, the published
 *      key list and the offline verifier (library and CLI), against tamper cases;
 *  (c) NEAR account ownership: a test wallet signs real NEP-413 payloads with a locally generated
 *      Ed25519 key (its own Borsh serialisation, independent of @dockside/core); the server verifies
 *      the signature and asks the chain adapter `view_access_key` for a full-access key.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign as edSign } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { IsolatedSigner } from "@dockside/authority";
import {
  type CanonicalValue,
  exportPublicKey,
  generateEd25519KeyPair,
  loadConfig,
  nep413Bytes,
  randomIds,
  signFor,
} from "@dockside/core";
import { NearTxClient } from "@dockside/near";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, ORIGIN } from "../../../packages/authority/test/helpers.js";
import { rpcFor } from "../../../packages/journal/test/world.js";
import { createApp, enrollExportKey, type ExportKeySigner, revokeExportKey } from "../src/app.js";
import { parseTrustedKeys, verifySignedAuditExport } from "../src/verify-export.js";
import { type ApiWorld, apiWorld, lockAndApprove, run } from "./m07-world.js";

const DIST_CLI = fileURLToPath(new URL("../dist/cli/", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "dockside-m17-"));
const seedFile = join(dir, "export-key.seed");
let signerProc: IsolatedSigner;
let signer: ExportKeySigner;
let a: ApiWorld;
let admin: Actor;
let supplierAdmin: Actor;
let auditor: Actor;
let buyer: Actor;

function asSigner(s: IsolatedSigner): ExportKeySigner {
  return { publicKey: s.publicKey, custodyKind: "ISOLATED_SIGNER_PROCESS", sign: (p, v) => s.sign(p, v) };
}

beforeAll(async () => {
  writeFileSync(seedFile, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
  signerProc = await IsolatedSigner.spawn({
    allowedPurposes: ["AUDIT_EXPORT_KEY_ENROLLMENT", "AUDIT_EXPORT"],
    seedFile,
  });
  signer = asSigner(signerProc);
  a = await apiWorld({
    extra: (w) => ({
      exportSigner: signer,
      chain: { rpc: rpcFor(w.url), tx: new NearTxClient(rpcFor(w.url)) },
      oneClick: {
        id: "one-click-blocked",
        dryProbe: async () => ({ kind: "NOT_ATTEMPTED", reason: "M06 BLOCKED" }),
      },
    }),
  });
  const h = a.w.c.w.h;
  await enrollExportKey(
    { db: h.db, clock: h.clock, ids: randomIds, origin: ORIGIN, network: "near-testnet" },
    signer,
  );
  admin = a.actors.buyerAdmin;
  supplierAdmin = a.actors.supplierAdmin;
  auditor = a.actors.auditor;
  buyer = a.actors.buyer;
});
afterAll(async () => {
  signerProc?.close();
  await a?.close();
});

const auditTypes = () =>
  a.w.c.w.h.db.all("SELECT event_type FROM audit_events ORDER BY seq").map((r) => String(r["event_type"]));

/* ================================ (a) settings ================================ */

describe("M17 settings: retention, evidence policies and integrations", () => {
  it("reads settings only as a security administrator or auditor of the same organisation", async () => {
    const r = await a.http(admin, "GET", "/v1/organization/settings");
    expect(r.status, r.text).toBe(200);
    expect(r.json.retention.revision).toBe(0);
    expect(r.json.retention.source).toBe("DEFAULT");
    expect(r.json.retention.settings.retention.evidenceRetentionDays).toBe(365);
    expect(r.json.editable).toBe(true);
    expect(r.json.authorityDelays.recoveryDelayMs).toBeGreaterThan(0);
    expect((await a.http(auditor, "GET", "/v1/organization/settings")).json.editable).toBe(false);
    for (const who of [buyer, a.actors.supplier, a.actors.inspector, a.actors.risk])
      expect((await a.http(who, "GET", "/v1/organization/settings")).json.error.code).toBe("FORBIDDEN");
    expect((await a.http(null, "GET", "/v1/organization/settings")).status).toBe(401);
  });

  it("changes retention with compare-and-swap, refuses stale, out-of-range and extra fields, and audits", async () => {
    const before = auditTypes().length;
    const ok = await a.http(admin, "POST", "/v1/organization/settings/retention", {
      expectedRevision: 0,
      evidenceRetentionDays: 90,
    });
    expect(ok.status, ok.text).toBe(201);
    expect(ok.json.revision).toBe(1);
    expect(ok.json.settings.retention.evidenceRetentionDays).toBe(90);
    expect(ok.json.digest).toMatch(/^[0-9a-f]{64}$/);
    const stale = await a.http(admin, "POST", "/v1/organization/settings/retention", {
      expectedRevision: 0,
      evidenceRetentionDays: 120,
    });
    expect(stale.json.error.code).toBe("VERSION_CONFLICT");
    expect(stale.json.error.details.currentRevision).toBe(1);
    for (const days of [29, 3651])
      expect(
        (
          await a.http(admin, "POST", "/v1/organization/settings/retention", {
            expectedRevision: 1,
            evidenceRetentionDays: days,
          })
        ).json.error.code,
      ).toBe("VALIDATION_FAILED");
    const extra = await a.http(admin, "POST", "/v1/organization/settings/retention", {
      expectedRevision: 1,
      evidenceRetentionDays: 60,
      force: true,
    });
    expect(extra.json.error.code).toBe("UNKNOWN_FIELD");
    const denied = await a.http(auditor, "POST", "/v1/organization/settings/retention", {
      expectedRevision: 1,
      evidenceRetentionDays: 60,
    });
    expect(denied.json.error.code).toBe("FORBIDDEN");
    const types = auditTypes().slice(before);
    expect(types).toContain("ORGANIZATION_SETTINGS_CHANGED");
    expect(types).toContain("SETTINGS_CHANGE_DENIED");
    // Nothing but revision 1 was written; the supplier organisation is untouched.
    const s = await a.http(admin, "GET", "/v1/organization/settings");
    expect(s.json.history.map((h: { revision: number }) => h.revision)).toEqual([1]);
    expect((await a.http(supplierAdmin, "GET", "/v1/organization/settings")).json.retention.revision).toBe(0);
    expect(a.w.c.w.h.db.get("SELECT COUNT(*) AS n FROM organization_settings")?.["n"]).toBe(1);
    // The settings table is append-only.
    expect(() => a.w.c.w.h.db.run("UPDATE organization_settings SET digest = 'x'")).toThrow(/append-only/);
  });

  it("previews retention eligibility from the persisted journal, never deleting", async () => {
    const pre = await a.http(admin, "GET", "/v1/organization/retention-preview");
    expect(pre.status, pre.text).toBe(200);
    const row = pre.json.trades.find((t: { tradeId: string }) => t.tradeId === a.w.c.t);
    expect(row.status).toBe("NOT_SETTLED");
    expect(row.evidenceItems).toBeGreaterThan(0);
    expect(pre.json.deletion.state).toBe("NOT_BUILT");
    // Settle the trade: buyer locks and approves, the queued release runs through the outbox worker.
    const intentId = await lockAndApprove(a, "m17-retention-01");
    const ex = await a.http(buyer, "POST", `/v1/release-intents/${intentId}/execute`);
    expect(ex.status, ex.text).toBe(201);
    await run(a.w);
    const op = a.w.c.w.h.db.get(
      "SELECT state, updated_at FROM economic_operations WHERE trade_id = ?",
      a.w.c.t,
    );
    expect(op?.["state"]).toBe("PAID");
    const settled = (await a.http(admin, "GET", "/v1/organization/retention-preview")).json;
    const s1 = settled.trades.find((t: { tradeId: string }) => t.tradeId === a.w.c.t);
    expect(s1.settledAt).toBe(Number(op?.["updated_at"]));
    expect(s1.eligibleAt).toBe(s1.settledAt + 90 * 24 * 3600_000);
    const now = a.w.c.w.h.clock.now();
    expect(s1.status).toBe(now >= s1.eligibleAt ? "ELIGIBLE" : "RETAINED");
    // The same period evaluated at a later date (planning view; the clock does not move).
    const asOf = Math.max(now, s1.eligibleAt) + 1000;
    const later = (await a.http(admin, "GET", `/v1/organization/retention-preview?asOf=${asOf}`)).json;
    const s2 = later.trades.find((t: { tradeId: string }) => t.tradeId === a.w.c.t);
    expect(s2.status).toBe("ELIGIBLE");
    expect(later.asOf).toBe(asOf);
    const early = Math.max(now, s1.eligibleAt - 1000);
    if (early >= now && early < s1.eligibleAt)
      expect(
        (await a.http(admin, "GET", `/v1/organization/retention-preview?asOf=${early}`)).json.trades.find(
          (t: { tradeId: string }) => t.tradeId === a.w.c.t,
        ).status,
      ).toBe("RETAINED");
    for (const bad of ["1", "abc", String(now + 3700 * 24 * 3600_000)])
      expect(
        (await a.http(admin, "GET", `/v1/organization/retention-preview?asOf=${bad}`)).json.error.code,
      ).toBe("VALIDATION_FAILED");
    expect(later.totals.eligibleItems).toBe(s2.evidenceItems);
    // Nothing was deleted.
    expect(
      Number(a.w.c.w.h.db.get("SELECT COUNT(*) AS n FROM evidence_items WHERE trade_id = ?", a.w.c.t)?.["n"]),
    ).toBe(s2.evidenceItems);
    expect((await a.http(buyer, "GET", "/v1/organization/retention-preview")).json.error.code).toBe(
      "FORBIDDEN",
    );
  });

  it("lists policies the organisation owns or binds and enforces ownership and next revision", async () => {
    const list = await a.http(admin, "GET", "/v1/evidence-policies");
    expect(list.status, list.text).toBe(200);
    const bound = list.json.policies.find((p: { policyId: string }) => p.policyId === "commercial-docs");
    expect(bound.ownedByYou).toBe(false);
    expect(bound.revisions[0].boundTrades).toBe(1);
    expect(bound.revisions[0].summary.slots.length).toBeGreaterThan(0);
    const base = bound.revisions[0].policy;
    // The world's policy was registered without an owner: no organisation may extend it.
    const unowned = await a.http(admin, "POST", "/v1/evidence-policies", {
      policy: { ...base, revision: base.revision + 1 },
    });
    expect(unowned.json.error.code).toBe("FORBIDDEN");
    const mine = { ...base, policyId: "m17-acme-docs", revision: 1 };
    expect(
      (await a.http(admin, "POST", "/v1/evidence-policies", { policy: { ...mine, revision: 2 } })).json.error
        .code,
    ).toBe("VERSION_CONFLICT");
    const r1 = await a.http(admin, "POST", "/v1/evidence-policies", { policy: mine });
    expect(r1.status, r1.text).toBe(201);
    expect(r1.json.revision).toBe(1);
    const theirs = await a.http(supplierAdmin, "POST", "/v1/evidence-policies", {
      policy: { ...mine, revision: 2 },
    });
    expect(theirs.json.error.code).toBe("FORBIDDEN");
    expect(
      (await a.http(buyer, "POST", "/v1/evidence-policies", { policy: { ...mine, revision: 2 } })).json.error
        .code,
    ).toBe("FORBIDDEN");
    const r2 = await a.http(admin, "POST", "/v1/evidence-policies", {
      policy: { ...mine, revision: 2, attestationLifetimeMs: 2 * 24 * 3600_000 },
    });
    expect(r2.status, r2.text).toBe(201);
    expect(r2.json.digest).not.toBe(r1.json.digest);
    const after = (await a.http(admin, "GET", "/v1/evidence-policies")).json.policies.find(
      (p: { policyId: string }) => p.policyId === "m17-acme-docs",
    );
    expect(after.ownedByYou).toBe(true);
    expect(after.revisions.map((x: { revision: number }) => x.revision)).toEqual([2, 1]);
    // The supplier organisation does not see the buyer organisation's unbound policy.
    const sup = (await a.http(supplierAdmin, "GET", "/v1/evidence-policies")).json.policies.map(
      (p: { policyId: string }) => p.policyId,
    );
    expect(sup).not.toContain("m17-acme-docs");
    expect(sup).toContain("commercial-docs");
  });

  it("shows integrations read-only and tests RPC connectivity as an administrator only", async () => {
    const i = await a.http(auditor, "GET", "/v1/organization/integrations");
    expect(i.status, i.text).toBe(200);
    expect(i.json.network).toBe("near-testnet");
    expect(i.json.oneClick.state).toBe("NOT_RUN");
    expect(i.json.oneClick.credential).toEqual({ configured: false, writeOnly: true });
    expect(i.json.fundedPayouts.state).toBe("BLOCKED");
    expect(i.json.auditExportKeys).toHaveLength(1);
    const t = await a.http(admin, "POST", "/v1/organization/integrations/rpc-test", {});
    expect(t.status, t.text).toBe(201);
    expect(t.json.reachable).toBe(true);
    expect(t.json.blockHeight).toBe(a.w.server.height);
    expect(t.json.meaning).toMatch(/connectivity only/);
    expect(
      (await a.http(auditor, "POST", "/v1/organization/integrations/rpc-test", {})).json.error.code,
    ).toBe("FORBIDDEN");
    a.w.server.faults.down = true;
    const down = await a.http(admin, "POST", "/v1/organization/integrations/rpc-test", {});
    a.w.server.faults.down = false;
    expect(down.json.reachable).toBe(false);
    expect(down.json.code).toBe("UPSTREAM_ERROR");
    expect(auditTypes().filter((x) => x === "INTEGRATION_CONNECTION_TESTED").length).toBe(2);
  });
});

/* ============================ (b) signed audit export ============================ */

describe("M17 signed audit export (dedicated export key, offline verification)", () => {
  let bundle: any;
  let keys: any;

  it("signs the checksummed export with the enrolled export key and verifies offline", async () => {
    const r = await a.http(buyer, "GET", `/v1/trades/${a.w.c.t}/signed-audit-export`);
    expect(r.status, r.text).toBe(200);
    bundle = r.json;
    expect(bundle.schema).toBe("dockside/signed-audit-export@1");
    expect(bundle.statement.publicKey).toBe(signer.publicKey);
    expect(bundle.statement.exportChecksum).toBe(bundle.export.checksum);
    const k = await a.http(auditor, "GET", "/v1/audit-export-keys");
    expect(k.status, k.text).toBe(200);
    keys = k.json;
    expect(keys.keys[0].status).toBe("ACTIVE");
    const v = verifySignedAuditExport(bundle, parseTrustedKeys(keys));
    expect(v.checks.filter((c) => !c.ok)).toEqual([]);
    expect(v.ok).toBe(true);
    expect(auditTypes()).toContain("AUDIT_EXPORT_SIGNED");
    // The private seed never leaves the signer process: not in the bundle, the key list or the logs.
    const seed = readFileSync(seedFile, "utf8").trim();
    for (const text of [JSON.stringify(bundle), JSON.stringify(keys), a.logs.join("\n")])
      expect(text).not.toContain(seed);
  });

  it("denies the signed export to unrelated principals exactly like a missing trade", async () => {
    const out = await a.http(a.actors.outsiderAdmin, "GET", `/v1/trades/${a.w.c.t}/signed-audit-export`);
    const missing = await a.http(buyer, "GET", `/v1/trades/trd_${"0".repeat(32)}/signed-audit-export`);
    expect(out.json.error).toEqual(missing.json.error);
    expect((await a.http(null, "GET", `/v1/trades/${a.w.c.t}/signed-audit-export`)).status).toBe(401);
    expect((await a.http(null, "GET", "/v1/audit-export-keys")).status).toBe(401);
  });

  const tampered = (f: (b: any) => void) => {
    const copy = JSON.parse(JSON.stringify(bundle));
    f(copy);
    return verifySignedAuditExport(copy, parseTrustedKeys(keys));
  };
  const failed = (v: ReturnType<typeof verifySignedAuditExport>) =>
    v.checks.filter((c) => !c.ok).map((c) => c.id);

  it("fails every tamper case and names the failing check", async () => {
    // 1. Edit a section value: the export checksum no longer matches.
    expect(failed(tampered((b) => (b.export.sections.holds = [{ forged: true }])))).toContain(
      "export.checksum",
    );
    // 2. Edit a section and recompute the export checksum: the signed statement no longer binds it.
    const { verifyAuditExport } = await import("../src/export.js");
    const v2 = tampered((b) => {
      b.export.destinations = "FULL";
      b.export.checksum = verifyAuditExport(b.export).expected;
    });
    expect(failed(v2)).toEqual(expect.arrayContaining(["statement.binds-export"]));
    expect(v2.ok).toBe(false);
    // 3. Edit the statement to match the edited export: the signature fails.
    const v3 = tampered((b) => {
      b.export.destinations = "FULL";
      b.export.checksum = verifyAuditExport(b.export).expected;
      b.statement.destinations = "FULL";
      b.statement.exportChecksum = b.export.checksum;
    });
    expect(failed(v3)).toEqual(expect.arrayContaining(["statement.digest", "signature"]));
    // 4. Re-sign the edited statement with another key: the key is not trusted.
    const attacker = generateEd25519KeyPair();
    const v4 = tampered((b) => {
      b.statement.publicKey = attacker.publicKey;
      b.signature = signFor(attacker.privateKey, "AUDIT_EXPORT", b.statement as CanonicalValue);
    });
    expect(failed(v4)).toEqual(["statement.digest", "key.trusted"]);
    // 5. A signature over the same statement under another domain does not verify.
    const v5 = tampered((b) => {
      b.statement.publicKey = attacker.publicKey;
      b.signature = signFor(attacker.privateKey, "MANIFEST_ATTESTATION", b.statement as CanonicalValue);
    });
    expect(failed(v5)).toContain("signature");
    // 6. Truncated or missing signature, extra bundle field, missing statement field.
    expect(failed(tampered((b) => (b.signature = String(b.signature).slice(0, 40))))).toContain("signature");
    expect(failed(tampered((b) => (b.extra = 1)))).toContain("bundle.fields");
    expect(failed(tampered((b) => delete b.statement.auditHeadHash))).toContain("statement.fields");
    // 7. A statement from another export: trade id swapped.
    expect(failed(tampered((b) => (b.export.tradeId = `trd_${"1".repeat(32)}`)))).toContain(
      "export.checksum",
    );
    expect(failed(tampered((b) => (b.statement.tradeId = `trd_${"1".repeat(32)}`)))).toEqual(
      expect.arrayContaining(["statement.binds-export", "signature"]),
    );
    // 8. A trusted list that does not hold this key, or binds it to another origin.
    expect(failed(verifySignedAuditExport(bundle, []))).toEqual(["key.trusted"]);
    const other = parseTrustedKeys(keys).map((k) => ({ ...k, origin: "https://elsewhere.test" }));
    expect(failed(verifySignedAuditExport(bundle, other))).toEqual(["key.origin"]);
    expect(failed(verifySignedAuditExport("not a bundle", []))).toEqual(["bundle.shape"]);
    expect(failed(tampered((b) => (b.schema = "dockside/signed-audit-export@0")))).toEqual(["bundle.schema"]);
  });

  it("rotation retires the old key; revocation makes its signatures untrusted; neither is re-enrolled", async () => {
    const h = a.w.c.w.h;
    const deps = { db: h.db, clock: h.clock, ids: randomIds, origin: ORIGIN, network: "near-testnet" };
    const same = await enrollExportKey(deps, signer);
    expect(same.keyId).toBe(bundle.statement.keyId);
    const next = await IsolatedSigner.spawn({
      allowedPurposes: ["AUDIT_EXPORT_KEY_ENROLLMENT", "AUDIT_EXPORT"],
    });
    try {
      h.clock.advance(1000);
      const k2 = await enrollExportKey(deps, asSigner(next));
      expect(k2.status).toBe("ACTIVE");
      const list = (await a.http(auditor, "GET", "/v1/audit-export-keys")).json;
      const old = list.keys.find((k: { keyId: string }) => k.keyId === bundle.statement.keyId);
      expect(old.status).toBe("RETIRED");
      // The bundle signed before retirement still verifies against the new list.
      expect(verifySignedAuditExport(bundle, parseTrustedKeys(list)).ok).toBe(true);
      // The process still holding the retired key can no longer sign.
      const refused = await a.http(buyer, "GET", `/v1/trades/${a.w.c.t}/signed-audit-export`);
      expect(refused.json.error.code).toBe("INVALID_STATE");
      expect(refused.json.error.details.reason).toBe("EXPORT_KEY_NOT_ACTIVE");
      // A statement claiming a signing time after retirement fails the validity window.
      const late = JSON.parse(JSON.stringify(bundle));
      late.statement.signedAt = old.retiredAt + 1;
      expect(failed(verifySignedAuditExport(late, parseTrustedKeys(list)))).toEqual(
        expect.arrayContaining(["key.validity-window"]),
      );
      await expect(enrollExportKey(deps, signer)).rejects.toMatchObject({ code: "KEY_REVOKED" });
      revokeExportKey(deps, bundle.statement.keyId, "KEY_COMPROMISED");
      const revoked = (await a.http(auditor, "GET", "/v1/audit-export-keys")).json;
      expect(failed(verifySignedAuditExport(bundle, parseTrustedKeys(revoked)))).toEqual(["key.not-revoked"]);
      keys = revoked;
    } finally {
      next.close();
    }
    expect(auditTypes()).toEqual(
      expect.arrayContaining([
        "AUDIT_EXPORT_KEY_ENROLLED",
        "AUDIT_EXPORT_KEY_RETIRED",
        "AUDIT_EXPORT_KEY_REVOKED",
      ]),
    );
  });

  it("the offline verifier CLI exits 0 on a valid bundle, 1 on tamper or revoked key, 2 on usage", () => {
    const cli = join(DIST_CLI, "verify-export.js");
    const bundleFile = join(dir, "bundle.json");
    const tamperFile = join(dir, "tampered.json");
    const goodKeys = join(dir, "keys-before-revocation.json");
    const revokedKeys = join(dir, "keys-revoked.json");
    writeFileSync(bundleFile, JSON.stringify(bundle));
    const t = JSON.parse(JSON.stringify(bundle));
    t.export.sections.operations = [];
    writeFileSync(tamperFile, JSON.stringify(t));
    const unrevoked = {
      ...keys,
      keys: keys.keys.map((k: any) =>
        k.status === "REVOKED" ? { ...k, status: "RETIRED", revokedAt: null } : k,
      ),
    };
    writeFileSync(goodKeys, JSON.stringify(unrevoked));
    writeFileSync(revokedKeys, JSON.stringify(keys));
    const ok = spawnSync(process.execPath, [cli, bundleFile, "--trusted-keys", goodKeys], {
      encoding: "utf8",
    });
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);
    expect(ok.stdout).toContain("VERIFIED: trade");
    const bad = spawnSync(process.execPath, [cli, tamperFile, "--trusted-keys", goodKeys], {
      encoding: "utf8",
    });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain("FAIL  export.checksum");
    const rev = spawnSync(process.execPath, [cli, bundleFile, "--trusted-keys", revokedKeys, "--json"], {
      encoding: "utf8",
    });
    expect(rev.status).toBe(1);
    expect(JSON.parse(rev.stdout).checks.find((c: { id: string }) => c.id === "key.not-revoked").ok).toBe(
      false,
    );
    expect(spawnSync(process.execPath, [cli, bundleFile], { encoding: "utf8" }).status).toBe(2);
  });

  it("export-key CLI generates exclusively, shows, enrolls, lists and revokes without printing the seed", () => {
    const cli = join(DIST_CLI, "export-key.js");
    const file = join(dir, "operator.seed");
    const db = join(dir, "operator.sqlite");
    const gen = JSON.parse(
      execFileSync(process.execPath, [cli, "generate", "--out", file], { encoding: "utf8" }),
    );
    const seed = readFileSync(file, "utf8").trim();
    expect(seed).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(gen)).not.toContain(seed);
    const again = spawnSync(process.execPath, [cli, "generate", "--out", file], { encoding: "utf8" });
    expect(again.status).toBe(1);
    expect(readFileSync(file, "utf8").trim()).toBe(seed);
    const show = JSON.parse(
      execFileSync(process.execPath, [cli, "show", "--key-file", file], { encoding: "utf8" }),
    );
    expect(show.publicKey).toBe(gen.publicKey);
    const enrolled = JSON.parse(
      execFileSync(
        process.execPath,
        [cli, "enroll", "--db", db, "--origin", ORIGIN, "--network", "near-testnet", "--key-file", file],
        { encoding: "utf8" },
      ),
    );
    expect(enrolled.status).toBe("ACTIVE");
    expect(enrolled.publicKey).toBe(gen.publicKey);
    const listed = JSON.parse(
      execFileSync(process.execPath, [cli, "list", "--db", db, "--origin", ORIGIN], { encoding: "utf8" }),
    );
    expect(listed.keys.map((k: { keyId: string }) => k.keyId)).toEqual([enrolled.keyId]);
    const revoked = JSON.parse(
      execFileSync(
        process.execPath,
        [cli, "revoke", "--db", db, "--key-id", enrolled.keyId, "--reason", "ROTATED_OUT"],
        {
          encoding: "utf8",
        },
      ),
    );
    expect(revoked.status).toBe("REVOKED");
    expect(spawnSync(process.execPath, [cli, "nonsense"], { encoding: "utf8" }).status).toBe(2);
  });

  it("answers INVALID_STATE EXPORT_KEY_NOT_CONFIGURED when no export key is wired", async () => {
    const h = a.w.c.w.h;
    const server: Server = createServer(
      createApp({
        config: loadConfig({ DOCKSIDE_DB_PATH: h.dbPath, DOCKSIDE_ORIGIN: ORIGIN }),
        db: h.db,
        authority: h.svc,
        clock: h.clock,
        ids: randomIds,
      }),
    );
    const base = await new Promise<string>((r) =>
      server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)),
    );
    try {
      const path = `/v1/trades/${a.w.c.t}/signed-audit-export`;
      const res = await fetch(base + path, {
        headers: {
          authorization: `Dockside-Session ${buyer.grant?.sessionToken}`,
          "dockside-proof": Buffer.from(JSON.stringify(buyer.proof("GET", path, ""))).toString("base64url"),
        },
      });
      const j = (await res.json()) as any;
      expect(j.error.code).toBe("INVALID_STATE");
      expect(j.error.details.reason).toBe("EXPORT_KEY_NOT_CONFIGURED");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

/* ======================== (c) NEP-413 and NEAR account ownership ======================== */

/**
 * Test wallet: holds a locally generated Ed25519 key and signs NEP-413 exactly as a NEAR wallet's
 * signMessage does, with its own Borsh serialisation (not @dockside/core's).
 */
class TestWallet {
  readonly keys = generateKeyPairSync("ed25519");
  readonly publicKey = exportPublicKey(this.keys.publicKey);
  constructor(readonly accountId: string) {}

  static payload(message: string, nonce: Buffer, recipient: string): Buffer {
    const u32 = (n: number) => {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(n >>> 0, 0);
      return b;
    };
    const str = (s: string) => {
      const b = Buffer.from(s, "utf8");
      return Buffer.concat([u32(b.length), b]);
    };
    // tag = 2^31 + 413, then {message: string, nonce: [u8; 32], recipient: string, callbackUrl: Option<string>}
    return Buffer.concat([u32(2 ** 31 + 413), str(message), nonce, str(recipient), Buffer.from([0])]);
  }

  signMessage(p: { message: string; nonce: Buffer; recipient: string }) {
    const digest = createHash("sha256")
      .update(TestWallet.payload(p.message, p.nonce, p.recipient))
      .digest();
    return {
      accountId: this.accountId,
      publicKey: this.publicKey,
      signature: edSign(null, digest, this.keys.privateKey).toString("base64"),
    };
  }
}

describe("M17 NEP-413 signatures and NEAR account key ownership (view_access_key)", () => {
  const account = "acme-wallet.testnet";
  const challenge = async (who: Actor, accountId = account) => {
    const r = await a.http(who, "POST", "/v1/me/near-accounts/challenges", { accountId });
    expect(r.status, r.text).toBe(201);
    return r.json;
  };
  const answer = (c: any, w: TestWallet, recipient = c.nep413.recipient, message = c.nep413.message) =>
    w.signMessage({ message, nonce: Buffer.from(c.nep413.nonceHex, "hex"), recipient });
  const link = (who: Actor, c: any, s: { accountId: string; publicKey: string; signature: string }) =>
    a.http(who, "POST", "/v1/me/near-accounts", { challengeId: c.challengeId, ...s });

  it("the test wallet's Borsh payload equals the server's NEP-413 serialisation", async () => {
    const c = await challenge(buyer);
    const nonce = Buffer.from(c.nep413.nonceHex, "hex");
    expect(nonce.length).toBe(32);
    expect(c.nep413.recipient).toBe(ORIGIN);
    expect(c.nep413.message).toContain(`account: ${account}`);
    expect(c.nep413.message).toContain(`digest: ${c.digestHex}`);
    const mine = TestWallet.payload(c.nep413.message, nonce, c.nep413.recipient);
    expect(
      Buffer.from(nep413Bytes({ message: c.nep413.message, nonce, recipient: ORIGIN })).equals(mine),
    ).toBe(true);
  });

  it("links an account only when the NEP-413 signer is a full-access key of it on chain", async () => {
    const w = new TestWallet(account);
    const before = auditTypes().length;
    // Not an access key of the account yet.
    const c1 = await challenge(buyer);
    const missing = await link(buyer, c1, answer(c1, w));
    expect(missing.json.error.code).toBe("ACCESS_KEY_NOT_FOUND");
    // A function-call key is not ownership.
    a.w.server.addAccessKey(account, w.publicKey, "FunctionCall");
    const fc = await link(buyer, c1, answer(c1, w));
    expect(fc.json.error.code).toBe("ACCESS_KEY_NOT_FULL_ACCESS");
    // Full access: linked, with the observed block height.
    a.w.server.addAccessKey(account, w.publicKey, "FullAccess");
    const ok = await link(buyer, c1, answer(c1, w));
    expect(ok.status, ok.text).toBe(201);
    expect(ok.json.status).toBe("VERIFIED");
    expect(ok.json.permission).toBe("FullAccess");
    expect(ok.json.blockHeight).toBe(a.w.server.height);
    expect(ok.json.accountId).toBe(account);
    expect(ok.json.publicKey).toBe(w.publicKey);
    // One-time challenge.
    expect((await link(buyer, c1, answer(c1, w))).json.error.code).toBe("NONCE_REPLAYED");
    const types = auditTypes().slice(before);
    expect(types.filter((t) => t === "NEAR_ACCOUNT_LINK_DENIED")).toHaveLength(2);
    expect(types).toContain("NEAR_ACCOUNT_LINKED");
    const mine = await a.http(buyer, "GET", "/v1/me/near-accounts");
    expect(mine.json.links.map((l: { accountId: string }) => l.accountId)).toEqual([account]);
  });

  it("refuses wrong recipient, edited message, wrong nonce, wrong account, wrong principal and expiry", async () => {
    const w = new TestWallet(account);
    a.w.server.addAccessKey(account, w.publicKey, "FullAccess");
    const c = await challenge(buyer);
    expect((await link(buyer, c, answer(c, w, "https://phishing.test"))).json.error.code).toBe(
      "SIGNATURE_INVALID",
    );
    expect(
      (await link(buyer, c, answer(c, w, c.nep413.recipient, `${c.nep413.message} `))).json.error.code,
    ).toBe("SIGNATURE_INVALID");
    const other = await challenge(buyer);
    expect((await link(buyer, c, answer(other, w))).json.error.code).toBe("SIGNATURE_INVALID");
    // A signature from another key than the one reported.
    const liar = new TestWallet(account);
    expect((await link(buyer, c, { ...answer(c, liar), publicKey: w.publicKey })).json.error.code).toBe(
      "SIGNATURE_INVALID",
    );
    const elsewhere = new TestWallet("someone-else.testnet");
    expect((await link(buyer, c, answer(c, elsewhere))).json.error.code).toBe("SCOPE_MISMATCH");
    // Another principal cannot answer this principal's challenge.
    expect((await link(a.actors.supplier, c, answer(c, w))).json.error.code).toBe("NOT_FOUND");
    // Expired.
    a.w.c.w.h.clock.advance(5 * 60_000 + 1);
    expect((await link(buyer, c, answer(c, w))).json.error.code).toBe("EXPIRED");
    // Malformed signature encodings.
    const c2 = await challenge(buyer);
    expect((await link(buyer, c2, { ...answer(c2, w), signature: "not-base64" })).json.error.code).toBe(
      "SIGNATURE_INVALID",
    );
    expect(
      (await a.http(buyer, "POST", "/v1/me/near-accounts/challenges", { accountId: "Bad Account" })).status,
    ).toBe(400);
  });

  it("re-checks ownership against the chain after a key is deleted; only the owner or own-org admin may", async () => {
    const links = (await a.http(buyer, "GET", "/v1/me/near-accounts")).json.links;
    const l = links[0];
    const key = l.publicKey as string;
    expect(a.w.server.deleteAccessKey(account, key)).toBe(true);
    const r = await a.http(buyer, "POST", `/v1/near-accounts/${l.linkId}/recheck`, {});
    expect(r.status, r.text).toBe(201);
    expect(r.json.status).toBe("KEY_NOT_FOUND");
    expect(
      (await a.http(a.actors.outsiderAdmin, "POST", `/v1/near-accounts/${l.linkId}/recheck`, {})).json.error
        .code,
    ).toBe("NOT_FOUND");
    expect(
      (await a.http(supplierAdmin, "POST", `/v1/near-accounts/${l.linkId}/recheck`, {})).json.error.code,
    ).toBe("NOT_FOUND");
    a.w.server.addAccessKey(account, key, "FullAccess");
    const back = await a.http(admin, "POST", `/v1/near-accounts/${l.linkId}/recheck`, {});
    expect(back.json.status).toBe("VERIFIED");
    const checks = a.w.c.w.h.db.all(
      "SELECT result FROM near_account_checks WHERE link_id = ? ORDER BY checked_at",
      l.linkId,
    );
    expect(checks.map((x) => x["result"])).toEqual(["VERIFIED", "KEY_NOT_FOUND", "VERIFIED"]);
    const org = await a.http(auditor, "GET", "/v1/organization/near-accounts");
    expect(org.json.links.map((x: { linkId: string }) => x.linkId)).toContain(l.linkId);
    expect((await a.http(buyer, "GET", "/v1/organization/near-accounts")).json.error.code).toBe("FORBIDDEN");
    // The link grants no capability: the buyer's capabilities are unchanged.
    expect((await a.http(buyer, "GET", "/v1/me")).json.capabilities).toEqual(["BUYER_APPROVER"]);
  });
});
