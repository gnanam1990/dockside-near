import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { DocksideError, fail } from "@dockside/core";

/**
 * Durable store on Node's built-in SQLite (node:sqlite). See docs/adr/0001.
 * - WAL journal + synchronous=FULL: an acknowledged commit survives process crash.
 * - foreign keys enforced, STRICT tables.
 * - single-writer transactions with BEGIN IMMEDIATE; nested work uses savepoints.
 */
export type SqlValue = string | number | bigint | null | Uint8Array;
export type Row = Record<string, SqlValue>;

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

export function loadMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): Migration[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const out: Migration[] = [];
  for (const f of files) {
    const m = /^(\d{4})_([a-z0-9_]+)\.sql$/.exec(f);
    if (!m) fail("MIGRATION_FAILED", "migration file name must be NNNN_name.sql", { file: f });
    const sql = readFileSync(join(dir, f), "utf8").replace(/\r\n/g, "\n");
    out.push({
      version: Number(m[1]),
      name: m[2] as string,
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
    });
  }
  out.forEach((mig, i) => {
    if (mig.version !== i + 1) fail("MIGRATION_FAILED", "migration versions must be contiguous from 0001");
  });
  return out;
}

export class Database {
  readonly raw: DatabaseSync;
  private depth = 0;

  private constructor(raw: DatabaseSync) {
    this.raw = raw;
  }

  static open(path: string): Database {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const raw = new DatabaseSync(path);
    const db = new Database(raw);
    if (path !== ":memory:") db.raw.exec("PRAGMA journal_mode = WAL");
    db.raw.exec("PRAGMA synchronous = FULL");
    db.raw.exec("PRAGMA foreign_keys = ON");
    db.raw.exec("PRAGMA busy_timeout = 5000");
    return db;
  }

  close(): void {
    this.raw.close();
  }

  run(sql: string, ...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
    return this.raw.prepare(sql).run(...params);
  }

  get<T extends Row = Row>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  all<T extends Row = Row>(sql: string, ...params: SqlValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  /**
   * Run fn atomically. Outer calls take the write lock up front (BEGIN IMMEDIATE) so
   * read-check-write sequences inside cannot interleave with another writer.
   */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) {
      const sp = `sp_${this.depth}`;
      this.raw.exec(`SAVEPOINT ${sp}`);
      this.depth++;
      try {
        const r = fn();
        this.raw.exec(`RELEASE ${sp}`);
        return r;
      } catch (e) {
        this.raw.exec(`ROLLBACK TO ${sp}`);
        this.raw.exec(`RELEASE ${sp}`);
        throw e;
      } finally {
        this.depth--;
      }
    }
    this.raw.exec("BEGIN IMMEDIATE");
    this.depth = 1;
    try {
      const r = fn();
      if (r instanceof Promise) fail("INTERNAL", "transactions must be synchronous");
      this.raw.exec("COMMIT");
      return r;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    } finally {
      this.depth = 0;
    }
  }

  get inTransaction(): boolean {
    return this.depth > 0;
  }

  /** Apply pending migrations; verify checksums of applied ones. Fails closed on drift. */
  migrate(migrations: readonly Migration[] = loadMigrations()): { applied: number[]; current: number } {
    this.raw.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    ) STRICT`);
    const applied = this.all<{ version: number; name: string; checksum: string }>(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
    );
    for (const a of applied) {
      const m = migrations.find((x) => x.version === a.version);
      if (!m) {
        fail("MIGRATION_FAILED", "database has a migration unknown to this build (newer schema)", {
          version: a.version,
        });
      }
      if (m.checksum !== a.checksum) {
        fail("MIGRATION_FAILED", "applied migration checksum changed", { version: a.version });
      }
    }
    const done = new Set(applied.map((a) => a.version));
    const newly: number[] = [];
    for (const m of migrations) {
      if (done.has(m.version)) continue;
      try {
        this.transaction(() => {
          this.raw.exec(m.sql);
          this.run(
            "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
            m.version,
            m.name,
            m.checksum,
            Date.now(),
          );
        });
      } catch (e) {
        if (e instanceof DocksideError) throw e;
        fail("MIGRATION_FAILED", "migration failed to apply", {
          version: m.version,
          reason: String((e as Error).message).slice(0, 200),
        });
      }
      newly.push(m.version);
    }
    return { applied: newly, current: migrations.length };
  }

  schemaVersion(): number {
    const r = this.get<{ v: number | null }>("SELECT MAX(version) AS v FROM schema_migrations");
    return r?.v ?? 0;
  }
}

export function isUniqueViolation(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed|PRIMARY KEY/.test(e.message);
}
