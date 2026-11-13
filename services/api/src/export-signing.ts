import {
  type CanonicalValue,
  type Clock,
  digestHexFor,
  fail,
  type IdGenerator,
  newNonce,
  parsePublicKey,
  requireSignature,
} from "@dockside/core";
import { AuditLog, type Database } from "@dockside/store";
import type { AuditExport } from "./export.js";
import {
  AUDIT_EXPORT_KEY_LIST_SCHEMA,
  AUDIT_EXPORT_STATEMENT_SCHEMA,
  type AuditExportStatement,
  SIGNED_AUDIT_EXPORT_SCHEMA,
  type SignedAuditExport,
  type TrustedExportKey,
} from "./verify-export.js";

/**
 * Dedicated audit-export signing key (ADR-0018). The deployment operator generates the key with
 * `export-key generate`; the private key is read only by an isolated signer child process that may
 * sign exactly three purposes (the enrollment proof, export statements and, since M54, payment
 * receipts). The API holds the public key, proves possession at enrollment and records the key's
 * lifecycle. A newer key retires the older one; an operator revocation makes every signature by
 * that key untrusted.
 */
export interface ExportKeySigner {
  readonly publicKey: string;
  readonly custodyKind: "ISOLATED_SIGNER_PROCESS" | "HSM" | "KMS";
  sign(
    purpose: "AUDIT_EXPORT" | "AUDIT_EXPORT_KEY_ENROLLMENT" | "PAYMENT_RECEIPT",
    payload: CanonicalValue,
  ): Promise<string>;
}

export interface ExportKeyDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly origin: string;
  readonly network: string;
}

export interface ExportKeyView extends TrustedExportKey {
  readonly custodyKind: string;
  readonly statementDigest: string;
  readonly revokeReason: string | null;
}

const SOURCE = "audit-export-key";
const REASON = /^[A-Z][A-Z0-9_]{0,63}$/;

function view(r: Record<string, unknown>): ExportKeyView {
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    keyId: String(r["key_id"]),
    publicKey: String(r["public_key"]),
    origin: String(r["origin"]),
    network: String(r["network"]),
    status: String(r["status"]) as ExportKeyView["status"],
    enrolledAt: Number(r["enrolled_at"]),
    retiredAt: n(r["retired_at"]),
    revokedAt: n(r["revoked_at"]),
    custodyKind: String(r["custody_kind"]),
    statementDigest: String(r["statement_digest"]),
    revokeReason: r["revoke_reason"] === null ? null : String(r["revoke_reason"]),
  };
}

export function listExportKeys(db: Database, origin?: string): ExportKeyView[] {
  const rows =
    origin === undefined
      ? db.all("SELECT * FROM audit_export_keys ORDER BY enrolled_at, key_id")
      : db.all("SELECT * FROM audit_export_keys WHERE origin = ? ORDER BY enrolled_at, key_id", origin);
  return rows.map(view);
}

/** The published trust anchor for offline verification. */
export function exportKeyList(db: Database, origin: string) {
  return {
    schema: AUDIT_EXPORT_KEY_LIST_SCHEMA,
    origin,
    keys: listExportKeys(db, origin).map((k) => ({
      keyId: k.keyId,
      publicKey: k.publicKey,
      origin: k.origin,
      network: k.network,
      status: k.status,
      enrolledAt: k.enrolledAt,
      retiredAt: k.retiredAt,
      revokedAt: k.revokedAt,
      custodyKind: k.custodyKind,
      statementDigest: k.statementDigest,
    })),
  };
}

/**
 * Enroll the signer's key for this origin, or confirm it is already the active key. A key that was
 * retired or revoked is never re-activated (the operator generates a new one). Possession is proven
 * by the signer signing an enrollment statement that names the key, origin, network and a nonce.
 */
export async function enrollExportKey(d: ExportKeyDeps, signer: ExportKeySigner): Promise<ExportKeyView> {
  const pk = parsePublicKey(signer.publicKey);
  const existing = d.db.get("SELECT * FROM audit_export_keys WHERE public_key = ?", pk);
  if (existing) {
    if (existing["status"] !== "ACTIVE")
      fail("KEY_REVOKED", "this audit export key was retired or revoked; generate a new key", {
        status: String(existing["status"]),
      });
    if (existing["origin"] !== d.origin)
      fail("WRONG_ORIGIN", "this audit export key is enrolled for another origin");
    return view(existing);
  }
  const keyId = d.ids.next("aek");
  const enrolledAt = d.clock.now();
  const statement: Record<string, CanonicalValue> = {
    schema: "dockside/audit-export-key-enrollment@1",
    keyId,
    publicKey: pk,
    origin: d.origin,
    network: d.network,
    custodyKind: signer.custodyKind,
    enrolledAt,
    nonce: newNonce(),
  };
  const signature = await signer.sign("AUDIT_EXPORT_KEY_ENROLLMENT", statement);
  requireSignature(pk, "AUDIT_EXPORT_KEY_ENROLLMENT", statement, signature);
  const digest = digestHexFor("AUDIT_EXPORT_KEY_ENROLLMENT", statement);
  const audit = new AuditLog(d.db, d.clock, d.ids);
  d.db.transaction(() => {
    for (const prior of d.db.all(
      "SELECT key_id FROM audit_export_keys WHERE origin = ? AND status = 'ACTIVE'",
      d.origin,
    )) {
      d.db.run(
        "UPDATE audit_export_keys SET status = 'RETIRED', retired_at = ? WHERE key_id = ? AND status = 'ACTIVE'",
        enrolledAt,
        String(prior["key_id"]),
      );
      audit.append({
        eventType: "AUDIT_EXPORT_KEY_RETIRED",
        organizationId: null,
        actorPrincipalId: null,
        actorKeyVersionId: null,
        sessionId: null,
        subjectType: "audit_export_key",
        subjectId: String(prior["key_id"]),
        correlationId: keyId,
        source: SOURCE,
        payload: { supersededBy: keyId },
      });
    }
    d.db.run(
      `INSERT INTO audit_export_keys (key_id, public_key, origin, network, custody_kind, statement_json, statement_digest, statement_signature, status, enrolled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
      keyId,
      pk,
      d.origin,
      d.network,
      signer.custodyKind,
      JSON.stringify(statement),
      digest,
      signature,
      enrolledAt,
    );
    audit.append({
      eventType: "AUDIT_EXPORT_KEY_ENROLLED",
      organizationId: null,
      actorPrincipalId: null,
      actorKeyVersionId: null,
      sessionId: null,
      subjectType: "audit_export_key",
      subjectId: keyId,
      correlationId: keyId,
      source: SOURCE,
      payload: { publicKey: pk, custodyKind: signer.custodyKind, statementDigest: digest },
    });
  });
  return view(d.db.get("SELECT * FROM audit_export_keys WHERE key_id = ?", keyId) ?? {});
}

/** Operator revocation (key compromise): every signature by this key stops verifying. */
export function revokeExportKey(d: ExportKeyDeps, keyId: string, reason: string): ExportKeyView {
  if (!REASON.test(reason)) fail("VALIDATION_FAILED", "reason must be an upper-case code");
  return d.db.transaction(() => {
    const row = d.db.get("SELECT * FROM audit_export_keys WHERE key_id = ?", keyId);
    if (!row) fail("NOT_FOUND", "audit export key not found");
    if (row["status"] === "REVOKED") fail("INVALID_STATE", "audit export key already revoked");
    const now = d.clock.now();
    d.db.run(
      "UPDATE audit_export_keys SET status = 'REVOKED', revoked_at = ?, revoke_reason = ? WHERE key_id = ?",
      now,
      reason,
      keyId,
    );
    new AuditLog(d.db, d.clock, d.ids).append({
      eventType: "AUDIT_EXPORT_KEY_REVOKED",
      organizationId: null,
      actorPrincipalId: null,
      actorKeyVersionId: null,
      sessionId: null,
      subjectType: "audit_export_key",
      subjectId: keyId,
      correlationId: keyId,
      source: SOURCE,
      payload: { reason },
    });
    return view(d.db.get("SELECT * FROM audit_export_keys WHERE key_id = ?", keyId) ?? {});
  });
}

/** Sign a built export: the statement binds its checksum, trade, exporter, audit head and the key. */
export async function signAuditExport(
  d: ExportKeyDeps,
  signer: ExportKeySigner,
  ex: AuditExport,
): Promise<SignedAuditExport> {
  const row = d.db.get(
    "SELECT * FROM audit_export_keys WHERE public_key = ? AND origin = ? AND status = 'ACTIVE'",
    signer.publicKey,
    d.origin,
  );
  if (!row)
    fail("INVALID_STATE", "the audit export key is not the active enrolled key", {
      reason: "EXPORT_KEY_NOT_ACTIVE",
    });
  const statement: AuditExportStatement = {
    schema: AUDIT_EXPORT_STATEMENT_SCHEMA,
    exportSchema: ex.schema,
    checksumAlgorithm: ex.checksumAlgorithm,
    exportChecksum: ex.checksum,
    tradeId: ex.tradeId,
    generatedAt: ex.generatedAt,
    exportedBy: { ...ex.exportedBy },
    destinations: ex.destinations,
    auditHeadHash: ex.integrity.auditHeadHash,
    origin: d.origin,
    network: d.network,
    keyId: String(row["key_id"]),
    publicKey: signer.publicKey,
    signedAt: d.clock.now(),
  };
  const signature = await signer.sign("AUDIT_EXPORT", statement);
  requireSignature(signer.publicKey, "AUDIT_EXPORT", statement, signature);
  return {
    schema: SIGNED_AUDIT_EXPORT_SCHEMA,
    export: ex as unknown as Record<string, unknown>,
    statement,
    statementDigest: digestHexFor("AUDIT_EXPORT", statement),
    signature,
  };
}
