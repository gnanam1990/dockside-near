import { type CanonicalValue, digestHexFor, verifyFor } from "@dockside/core";
import { verifyAuditExport } from "./export.js";

/**
 * Offline verification of a signed audit export bundle (ADR-0018). Pure: no database, no network,
 * no clock. The verifier is given the bundle and the operator's published export keys (the trust
 * anchor, obtained out of band from `GET /v1/audit-export-keys` or `export-key show`) and answers
 * every check separately, so a failure names exactly what does not hold.
 */
export const SIGNED_AUDIT_EXPORT_SCHEMA = "dockside/signed-audit-export@1";
export const AUDIT_EXPORT_STATEMENT_SCHEMA = "dockside/audit-export-statement@1";
export const AUDIT_EXPORT_KEY_LIST_SCHEMA = "dockside/audit-export-keys@1";

export interface AuditExportStatement {
  readonly [key: string]: CanonicalValue;
  readonly schema: typeof AUDIT_EXPORT_STATEMENT_SCHEMA;
  readonly exportSchema: string;
  readonly checksumAlgorithm: string;
  readonly exportChecksum: string;
  readonly tradeId: string;
  readonly generatedAt: number;
  readonly exportedBy: { principalId: string; keyVersionId: string; organizationId: string };
  readonly destinations: string;
  readonly auditHeadHash: string | null;
  readonly origin: string;
  readonly network: string;
  readonly keyId: string;
  readonly publicKey: string;
  readonly signedAt: number;
}

export interface SignedAuditExport {
  readonly schema: typeof SIGNED_AUDIT_EXPORT_SCHEMA;
  readonly export: Record<string, unknown>;
  readonly statement: AuditExportStatement;
  readonly statementDigest: string;
  readonly signature: string;
}

export interface TrustedExportKey {
  readonly keyId: string;
  readonly publicKey: string;
  readonly origin: string;
  readonly network: string;
  readonly status: "ACTIVE" | "RETIRED" | "REVOKED";
  readonly enrolledAt: number;
  readonly retiredAt: number | null;
  readonly revokedAt: number | null;
}

export interface ExportCheck {
  readonly id: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface ExportVerification {
  readonly ok: boolean;
  readonly checks: readonly ExportCheck[];
  readonly tradeId: string | null;
  readonly keyId: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Statement fields that must equal the export they sign over. */
function bindingMismatches(st: Record<string, unknown>, ex: Record<string, unknown>): string[] {
  const out: string[] = [];
  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (st["exportSchema"] !== ex["schema"]) out.push("exportSchema");
  if (st["checksumAlgorithm"] !== ex["checksumAlgorithm"]) out.push("checksumAlgorithm");
  if (st["exportChecksum"] !== ex["checksum"]) out.push("exportChecksum");
  if (st["tradeId"] !== ex["tradeId"]) out.push("tradeId");
  if (st["generatedAt"] !== ex["generatedAt"]) out.push("generatedAt");
  if (st["destinations"] !== ex["destinations"]) out.push("destinations");
  const by = isObj(ex["exportedBy"]) ? ex["exportedBy"] : {};
  const sb = isObj(st["exportedBy"]) ? st["exportedBy"] : {};
  if (!eq(Object.keys(sb).sort(), ["keyVersionId", "organizationId", "principalId"]))
    out.push("exportedBy.fields");
  for (const k of ["principalId", "keyVersionId", "organizationId"])
    if (sb[k] !== by[k]) out.push(`exportedBy.${k}`);
  const integrity = isObj(ex["integrity"]) ? ex["integrity"] : {};
  if ((st["auditHeadHash"] ?? null) !== (integrity["auditHeadHash"] ?? null)) out.push("auditHeadHash");
  return out;
}

const STATEMENT_FIELDS = [
  "auditHeadHash",
  "checksumAlgorithm",
  "destinations",
  "exportChecksum",
  "exportSchema",
  "exportedBy",
  "generatedAt",
  "keyId",
  "network",
  "origin",
  "publicKey",
  "schema",
  "signedAt",
  "tradeId",
];

export function verifySignedAuditExport(
  bundle: unknown,
  trusted: readonly TrustedExportKey[],
): ExportVerification {
  const checks: ExportCheck[] = [];
  const add = (id: string, ok: boolean, detail: string) => {
    checks.push({ id, ok, detail });
    return ok;
  };
  const done = (tradeId: string | null, keyId: string | null): ExportVerification => ({
    ok: checks.length > 0 && checks.every((c) => c.ok),
    checks,
    tradeId,
    keyId,
  });
  if (!isObj(bundle)) {
    add("bundle.shape", false, "bundle is not a JSON object");
    return done(null, null);
  }
  const fields = Object.keys(bundle).sort().join(",");
  if (
    !add(
      "bundle.schema",
      bundle["schema"] === SIGNED_AUDIT_EXPORT_SCHEMA,
      `schema ${String(bundle["schema"])}`,
    )
  )
    return done(null, null);
  if (
    !add("bundle.fields", fields === "export,schema,signature,statement,statementDigest", `fields ${fields}`)
  )
    return done(null, null);
  const ex = bundle["export"];
  const st = bundle["statement"];
  if (!isObj(ex) || !isObj(st)) {
    add("bundle.shape", false, "export and statement must be objects");
    return done(null, null);
  }
  const tradeId = typeof st["tradeId"] === "string" ? st["tradeId"] : null;
  const keyId = typeof st["keyId"] === "string" ? st["keyId"] : null;

  // 1. The export body still matches its own checksum (any edit to any section fails here).
  const sum = verifyAuditExport(ex);
  add(
    "export.checksum",
    sum.ok,
    sum.ok ? `checksum ${sum.expected}` : `recomputed ${sum.expected}, carried ${sum.actual}`,
  );

  // 2. The statement has exactly the signed fields and binds this export.
  const stFields = Object.keys(st).sort();
  add(
    "statement.fields",
    JSON.stringify(stFields) === JSON.stringify(STATEMENT_FIELDS) &&
      st["schema"] === AUDIT_EXPORT_STATEMENT_SCHEMA,
    `fields ${stFields.join(",")}`,
  );
  const mism = bindingMismatches(st, ex);
  add(
    "statement.binds-export",
    mism.length === 0,
    mism.length ? `differs: ${mism.join(", ")}` : "every bound field matches",
  );

  // 3. Digest and signature under the audit-export domain with the key the statement names.
  let digest = "";
  try {
    digest = digestHexFor("AUDIT_EXPORT", st as CanonicalValue);
  } catch (e) {
    add("statement.digest", false, `statement is not canonical: ${(e as Error).message}`);
    return done(tradeId, keyId);
  }
  add("statement.digest", digest === bundle["statementDigest"], `recomputed ${digest}`);
  const pk = typeof st["publicKey"] === "string" ? st["publicKey"] : "";
  const sig = typeof bundle["signature"] === "string" ? bundle["signature"] : "";
  add(
    "signature",
    pk !== "" && sig !== "" && verifyFor(pk, "AUDIT_EXPORT", st as CanonicalValue, sig),
    "Ed25519 over the DCE-1 statement digest, domain dockside/audit-export",
  );

  // 4. The signing key is one of the operator's published export keys and was valid when it signed.
  const k = trusted.find((t) => t.keyId === keyId && t.publicKey === pk);
  if (
    !add(
      "key.trusted",
      k !== undefined,
      k ? `key ${k.keyId} ${k.publicKey}` : "the signing key is not in the trusted key list",
    )
  )
    return done(tradeId, keyId);
  if (!k) return done(tradeId, keyId);
  add(
    "key.origin",
    k.origin === st["origin"] && k.network === st["network"],
    `key bound to ${k.origin} on ${k.network}`,
  );
  const signedAt = typeof st["signedAt"] === "number" ? st["signedAt"] : -1;
  add(
    "key.not-revoked",
    k.status !== "REVOKED",
    k.status === "REVOKED" ? `revoked at ${k.revokedAt}` : `status ${k.status}`,
  );
  const inWindow = signedAt >= k.enrolledAt && (k.retiredAt === null || signedAt < k.retiredAt);
  add(
    "key.validity-window",
    inWindow,
    `signed at ${signedAt}; key valid from ${k.enrolledAt}${k.retiredAt === null ? "" : ` until ${k.retiredAt}`}`,
  );
  return done(tradeId, keyId);
}

/** Parse a trusted key list file (`{schema, keys}` or a bare array of keys). */
export function parseTrustedKeys(raw: unknown): TrustedExportKey[] {
  const list = Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw["keys"]) ? raw["keys"] : null;
  if (!list) throw new Error("trusted key list must be an array or {schema, keys}");
  return list.map((k, i) => {
    if (!isObj(k)) throw new Error(`key ${i} is not an object`);
    const s = (n: string) => {
      if (typeof k[n] !== "string") throw new Error(`key ${i}: ${n} must be a string`);
      return k[n] as string;
    };
    const n = (f: string) => {
      const v = k[f];
      if (v === null || v === undefined) return null;
      if (typeof v !== "number" || !Number.isSafeInteger(v))
        throw new Error(`key ${i}: ${f} must be an integer`);
      return v;
    };
    const status = s("status");
    if (status !== "ACTIVE" && status !== "RETIRED" && status !== "REVOKED")
      throw new Error(`key ${i}: unknown status`);
    const enrolledAt = n("enrolledAt");
    if (enrolledAt === null) throw new Error(`key ${i}: enrolledAt required`);
    return {
      keyId: s("keyId"),
      publicKey: s("publicKey"),
      origin: s("origin"),
      network: s("network"),
      status,
      enrolledAt,
      retiredAt: n("retiredAt"),
      revokedAt: n("revokedAt"),
    };
  });
}
