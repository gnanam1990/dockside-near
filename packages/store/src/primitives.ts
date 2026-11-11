import {
  type CanonicalValue,
  type Clock,
  decideIdempotency,
  digestHexFor,
  fail,
  type IdGenerator,
  type NonceRegistry,
} from "@dockside/core";
import { type Database, isUniqueViolation } from "./db.js";

/** Durable one-time nonce registry. Consumption is part of the caller's transaction. */
export class SqliteNonceRegistry implements NonceRegistry {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  consume(scope: string, nonce: string, expiresAt: number): void {
    try {
      this.db.run(
        "INSERT INTO nonces (scope, nonce, consumed_at, expires_at) VALUES (?, ?, ?, ?)",
        scope,
        nonce,
        this.clock.now(),
        expiresAt,
      );
    } catch (e) {
      if (isUniqueViolation(e)) fail("NONCE_REPLAYED", "nonce has already been used", { scope });
      throw e;
    }
  }

  isConsumed(scope: string, nonce: string): boolean {
    return this.db.get("SELECT 1 AS x FROM nonces WHERE scope = ? AND nonce = ?", scope, nonce) !== undefined;
  }
}

/** Durable idempotency records: exact repeats replay, conflicting reuse fails closed. */
export class SqliteIdempotencyStore {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  /**
   * Execute `fn` at most once for (scope, key). Must be called inside or creates its own
   * transaction so that the effect and the idempotency record commit together.
   */
  once<T>(scope: string, key: string, requestDigest: string, fn: () => T): { replayed: boolean; result: T } {
    return this.db.transaction(() => {
      const row = this.db.get<{ request_digest: string; response_json: string }>(
        "SELECT request_digest, response_json FROM idempotency_keys WHERE scope = ? AND idem_key = ?",
        scope,
        key,
      );
      const decision = decideIdempotency(
        row ? { requestDigest: row.request_digest, response: row.response_json } : undefined,
        requestDigest,
      );
      if (decision.kind === "REPLAY") return { replayed: true, result: JSON.parse(decision.response) as T };
      const result = fn();
      this.db.run(
        "INSERT INTO idempotency_keys (scope, idem_key, request_digest, response_json, created_at) VALUES (?, ?, ?, ?, ?)",
        scope,
        key,
        requestDigest,
        JSON.stringify(result),
        this.clock.now(),
      );
      return { replayed: false, result };
    });
  }
}

/* ------------------------------------------------------------------ */
/* Append-only, hash-chained audit log (NFR-06 provenance)             */
/* ------------------------------------------------------------------ */

export const AUDIT_GENESIS = "0".repeat(64);
export const AUDIT_SCHEMA_VERSION = 1;

export interface AuditEventInput {
  readonly eventType: string;
  readonly organizationId: string | null;
  readonly actorPrincipalId: string | null;
  readonly actorKeyVersionId: string | null;
  readonly sessionId: string | null;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly correlationId: string;
  readonly source: string;
  readonly observedAt?: number;
  /** Redacted, non-secret facts only. */
  readonly payload: Readonly<Record<string, string | number | boolean | null>>;
}

export interface AuditEvent extends Required<Omit<AuditEventInput, "payload">> {
  readonly seq: number;
  readonly id: string;
  readonly schemaVersion: number;
  readonly recordedAt: number;
  readonly payload: Record<string, string | number | boolean | null>;
  readonly prevHash: string;
  readonly eventHash: string;
}

const SECRETISH = /(secret|token|private|password|seed|mnemonic)/i;

function eventHash(e: Omit<AuditEvent, "seq" | "eventHash">): string {
  const payload: Record<string, CanonicalValue> = {};
  for (const [k, v] of Object.entries(e.payload)) payload[k] = v;
  return digestHexFor("AUDIT_EVENT", {
    id: e.id,
    schemaVersion: e.schemaVersion,
    eventType: e.eventType,
    organizationId: e.organizationId,
    actorPrincipalId: e.actorPrincipalId,
    actorKeyVersionId: e.actorKeyVersionId,
    sessionId: e.sessionId,
    subjectType: e.subjectType,
    subjectId: e.subjectId,
    correlationId: e.correlationId,
    source: e.source,
    observedAt: e.observedAt,
    recordedAt: e.recordedAt,
    payload,
    prevHash: e.prevHash,
  });
}

export class AuditLog {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  append(input: AuditEventInput): AuditEvent {
    for (const k of Object.keys(input.payload)) {
      if (SECRETISH.test(k))
        fail("INTERNAL", "audit payload keys must not carry secret material", { key: k });
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(k)) fail("INTERNAL", "invalid audit payload key");
    }
    return this.db.transaction(() => {
      const last = this.db.get<{ event_hash: string }>(
        "SELECT event_hash FROM audit_events ORDER BY seq DESC LIMIT 1",
      );
      const now = this.clock.now();
      const base = {
        id: this.ids.next("aud"),
        schemaVersion: AUDIT_SCHEMA_VERSION,
        eventType: input.eventType,
        organizationId: input.organizationId,
        actorPrincipalId: input.actorPrincipalId,
        actorKeyVersionId: input.actorKeyVersionId,
        sessionId: input.sessionId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        correlationId: input.correlationId,
        source: input.source,
        observedAt: input.observedAt ?? now,
        recordedAt: now,
        payload: { ...input.payload },
        prevHash: last?.event_hash ?? AUDIT_GENESIS,
      };
      const hash = eventHash(base);
      const r = this.db.run(
        `INSERT INTO audit_events (id, schema_version, event_type, organization_id, actor_principal_id, actor_key_version_id,
           session_id, subject_type, subject_id, correlation_id, source, observed_at, recorded_at, payload_json, prev_hash, event_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        base.id,
        base.schemaVersion,
        base.eventType,
        base.organizationId,
        base.actorPrincipalId,
        base.actorKeyVersionId,
        base.sessionId,
        base.subjectType,
        base.subjectId,
        base.correlationId,
        base.source,
        base.observedAt,
        base.recordedAt,
        JSON.stringify(base.payload),
        base.prevHash,
        hash,
      );
      return { ...base, seq: Number(r.lastInsertRowid), eventHash: hash };
    });
  }

  list(
    filter: { subjectId?: string; organizationId?: string; eventType?: string } = {},
    limit = 500,
  ): AuditEvent[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.subjectId) {
      where.push("subject_id = ?");
      params.push(filter.subjectId);
    }
    if (filter.organizationId) {
      where.push("organization_id = ?");
      params.push(filter.organizationId);
    }
    if (filter.eventType) {
      where.push("event_type = ?");
      params.push(filter.eventType);
    }
    const sql = `SELECT * FROM audit_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq LIMIT ${Math.min(Math.max(1, limit), 5000)}`;
    return this.db.all(sql, ...params).map(rowToEvent);
  }

  /** Recompute the hash chain; returns the first broken seq or null when intact. */
  verifyChain(): { ok: true; count: number } | { ok: false; brokenAtSeq: number } {
    let prev = AUDIT_GENESIS;
    let count = 0;
    for (const row of this.db.all("SELECT * FROM audit_events ORDER BY seq")) {
      const e = rowToEvent(row);
      if (e.prevHash !== prev || eventHash(e) !== e.eventHash) return { ok: false, brokenAtSeq: e.seq };
      prev = e.eventHash;
      count++;
    }
    return { ok: true, count };
  }
}

function rowToEvent(r: Record<string, unknown>): AuditEvent {
  return {
    seq: Number(r["seq"]),
    id: String(r["id"]),
    schemaVersion: Number(r["schema_version"]),
    eventType: String(r["event_type"]),
    organizationId: (r["organization_id"] as string | null) ?? null,
    actorPrincipalId: (r["actor_principal_id"] as string | null) ?? null,
    actorKeyVersionId: (r["actor_key_version_id"] as string | null) ?? null,
    sessionId: (r["session_id"] as string | null) ?? null,
    subjectType: String(r["subject_type"]),
    subjectId: String(r["subject_id"]),
    correlationId: String(r["correlation_id"]),
    source: String(r["source"]),
    observedAt: Number(r["observed_at"]),
    recordedAt: Number(r["recorded_at"]),
    payload: JSON.parse(String(r["payload_json"])) as Record<string, string | number | boolean | null>,
    prevHash: String(r["prev_hash"]),
    eventHash: String(r["event_hash"]),
  };
}
