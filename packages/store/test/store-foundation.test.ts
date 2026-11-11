/**
 * M00 storage foundation: migrations, durability across restart, nonce replay,
 * idempotency and append-only audit (supports T-001/T-002 handoff; NFR-01 groundwork).
 * Uses a real on-disk SQLite file per test.
 */
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { idempotencyRequestDigest, isDocksideError, ManualClock, randomIds } from "@dockside/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  AuditLog,
  Database,
  DEFAULT_MIGRATIONS_DIR,
  loadMigrations,
  SqliteIdempotencyStore,
  SqliteNonceRegistry,
} from "../src/index.js";

const dirs: string[] = [];
function tempDb(): string {
  const d = mkdtempSync(join(tmpdir(), "dockside-store-"));
  dirs.push(d);
  return join(d, "db.sqlite");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("store foundation", () => {
  it("applies migrations once and is idempotent on reopen", () => {
    const path = tempDb();
    const db = Database.open(path);
    const first = db.migrate();
    expect(first.applied.length).toBeGreaterThanOrEqual(1);
    db.close();
    const again = Database.open(path);
    expect(again.migrate().applied).toEqual([]);
    expect(again.schemaVersion()).toBe(loadMigrations().length);
    expect(again.get<{ journal_mode: string }>("PRAGMA journal_mode")?.["journal_mode"]).toBe("wal");
    again.close();
  });

  it("fails closed when an applied migration was edited or the database is newer than the build", () => {
    const path = tempDb();
    const db = Database.open(path);
    db.migrate();
    const migs = loadMigrations();
    const tampered = migs.map((m, i) => (i === 0 ? { ...m, checksum: "0".repeat(64) } : m));
    expect(() => db.migrate(tampered)).toThrowError(/checksum changed/);
    expect(() => db.migrate(migs.slice(0, 0))).toThrowError(/unknown to this build/);
    db.close();
  });

  it("rolls back a failing migration atomically", () => {
    const dir = mkdtempSync(join(tmpdir(), "dockside-mig-"));
    dirs.push(dir);
    cpSync(DEFAULT_MIGRATIONS_DIR, dir, { recursive: true });
    const next = String(loadMigrations().length + 1).padStart(4, "0");
    writeFileSync(
      join(dir, `${next}_broken.sql`),
      "CREATE TABLE half_done (x INTEGER) STRICT;\nTHIS IS NOT SQL;\n",
    );
    const db = Database.open(tempDb());
    expect(() => db.migrate(loadMigrations(dir))).toThrow();
    expect(db.get("SELECT name FROM sqlite_master WHERE name = 'half_done'")).toBeUndefined();
    expect(db.schemaVersion()).toBe(loadMigrations().length);
    db.close();
  });

  it("persists consumed nonces across restart so replay is denied after a crash", () => {
    const path = tempDb();
    const clock = new ManualClock(1_000);
    let db = Database.open(path);
    db.migrate();
    new SqliteNonceRegistry(db, clock).consume("pop", "ab".repeat(16), 9_999);
    db.close();
    db = Database.open(path);
    db.migrate();
    const reg = new SqliteNonceRegistry(db, clock);
    expect(reg.isConsumed("pop", "ab".repeat(16))).toBe(true);
    try {
      reg.consume("pop", "ab".repeat(16), 9_999);
      expect.unreachable();
    } catch (e) {
      expect(isDocksideError(e, "NONCE_REPLAYED")).toBe(true);
    }
    reg.consume("other-scope", "ab".repeat(16), 9_999);
    db.close();
  });

  it("joins exact idempotent repeats and rejects conflicting reuse without re-running the effect", () => {
    const db = Database.open(tempDb());
    db.migrate();
    const store = new SqliteIdempotencyStore(db, new ManualClock(5));
    let effects = 0;
    const d1 = idempotencyRequestDigest("create", { a: 1 });
    const r1 = store.once("s", "key-aaaaaaaaaaaaaaaa", d1, () => ({ n: ++effects }));
    const r2 = store.once("s", "key-aaaaaaaaaaaaaaaa", d1, () => ({ n: ++effects }));
    expect(r1).toEqual({ replayed: false, result: { n: 1 } });
    expect(r2).toEqual({ replayed: true, result: { n: 1 } });
    const d2 = idempotencyRequestDigest("create", { a: 2 });
    expect(() => store.once("s", "key-aaaaaaaaaaaaaaaa", d2, () => ({ n: ++effects }))).toThrowError(
      /different request/,
    );
    expect(effects).toBe(1);
    db.close();
  });

  it("keeps the audit log append-only and hash-chained", () => {
    const db = Database.open(tempDb());
    db.migrate();
    const log = new AuditLog(db, new ManualClock(100), randomIds);
    const base = {
      organizationId: null,
      actorPrincipalId: null,
      actorKeyVersionId: null,
      sessionId: null,
      subjectType: "test",
      correlationId: randomIds.next("cor"),
      source: "store-test",
    };
    log.append({ ...base, eventType: "A", subjectId: "s1", payload: { n: 1 } });
    log.append({ ...base, eventType: "B", subjectId: "s1", payload: { ok: true } });
    expect(log.verifyChain()).toEqual({ ok: true, count: 2 });
    expect(() => db.run("UPDATE audit_events SET event_type = 'X'")).toThrowError(/append-only/);
    expect(() => db.run("DELETE FROM audit_events")).toThrowError(/append-only/);
    expect(() =>
      log.append({ ...base, eventType: "C", subjectId: "s1", payload: { sessionToken: "x" } }),
    ).toThrow();
    // Tamper below the API (drop triggers) and the chain detects it.
    db.raw.exec("DROP TRIGGER audit_events_no_update");
    db.run("UPDATE audit_events SET payload_json = '{\"n\":2}' WHERE seq = 1");
    expect(log.verifyChain()).toEqual({ ok: false, brokenAtSeq: 1 });
    db.close();
  });

  it("rolls back every write of a failed transaction", () => {
    const db = Database.open(tempDb());
    db.migrate();
    const reg = new SqliteNonceRegistry(db, new ManualClock(1));
    expect(() =>
      db.transaction(() => {
        reg.consume("x", "cd".repeat(16), 10);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(reg.isConsumed("x", "cd".repeat(16))).toBe(false);
    db.close();
  });
});
