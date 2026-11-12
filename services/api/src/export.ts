import type { AuthContext } from "@dockside/authority";
import { sha256, type TradeTerms, toHex } from "@dockside/core";
import { AuditLog } from "@dockside/store";
import type { AppDeps } from "./app.js";
import type { TradeModules } from "./trades.js";

/**
 * Checksummed, append-only audit export for one trade (FR-15, NFR-06, T-033).
 *
 * Every section is read from the persisted append-only tables of M01-M05 (never from a cache or
 * a UI projection) plus, when requested, one fresh observation of the escrow contract's views.
 * Secrets and private evidence are excluded by construction and the exclusions are listed in the
 * export itself. `checksum` is SHA-256 over the stable JSON encoding (sorted keys, bigint as
 * decimal string, bytes as hex) of every other field; `verifyAuditExport` recomputes it.
 */
export const AUDIT_EXPORT_SCHEMA = "dockside/audit-export@1";
export const AUDIT_EXPORT_CHECKSUM = "sha256/dockside-stable-json@1";

type Row = Record<string, unknown>;

export interface AuditExport {
  readonly schema: typeof AUDIT_EXPORT_SCHEMA;
  readonly checksumAlgorithm: typeof AUDIT_EXPORT_CHECKSUM;
  readonly tradeId: string;
  readonly generatedAt: number;
  readonly exportedBy: { principalId: string; keyVersionId: string; organizationId: string };
  readonly sections: {
    revisions: Row[];
    authorities: { principals: Row[]; keyVersions: Row[]; roleGrants: Row[]; serviceEnrollments: Row[] };
    evidencePolicy: Row[];
    manifests: Row[];
    items: Row[];
    attestations: Row[];
    inspections: Row[];
    holds: Row[];
    holdResolutions: Row[];
    holdResolutionRequests: Row[];
    releaseIntents: Row[];
    releaseEvents: Row[];
    releaseChildren: Row[];
    releaseSignatures: Row[];
    operations: Row[];
    operationTransitions: Row[];
    observations: Row[];
    dispositions: Row[];
    outbox: Row[];
    incidents: Row[];
    freezes: Row[];
    operatorRequests: Row[];
    fundedAuthorizations: Row[];
    auditEvents: Row[];
  };
  readonly chain: unknown;
  readonly integrity: {
    auditChain: { ok: boolean; count?: number; brokenAtSeq?: number };
    auditHeadHash: string | null;
  };
  readonly destinations: "MASKED" | "FULL";
  readonly exclusions: readonly { item: string; reason: string }[];
  readonly checksum: string;
}

export const EXPORT_EXCLUSIONS: readonly { item: string; reason: string }[] = [
  {
    item: "evidence content bytes and derived text",
    reason: "private evidence; digests are exported instead",
  },
  { item: "session tokens, invitation secrets, challenge state", reason: "secret material" },
  {
    item: "private keys and signer custody references",
    reason: "secret material; custody locator digests only",
  },
  { item: "principal display names", reason: "personal data; SHA-256 digests only" },
  { item: "hold resolution request notes", reason: "free text from parties; SHA-256 digests only" },
  { item: "signed transaction bytes", reason: "transaction hash and digest of the signed bytes only" },
  {
    item: "quotes and funded payout authorizations",
    reason: "none exist: FUNDED_RAIL_BLOCKED in the direct testnet profile (M06 not run)",
  },
  {
    item: "provider receipts",
    reason: "none exist in the direct testnet profile; chain receipts are in observations",
  },
];

/* ------------------------------ stable JSON ------------------------------ */

export function stableStringify(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "bigint") return JSON.stringify(v.toString(10));
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("non-finite number in export");
    return JSON.stringify(v);
  }
  if (typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
  if (v instanceof Uint8Array) return JSON.stringify(toHex(v));
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
  }
  throw new Error(`unsupported value in export: ${typeof v}`);
}

function digestText(s: string): string {
  return toHex(sha256(new TextEncoder().encode(s)));
}

export function exportChecksum(body: Omit<AuditExport, "checksum">): string {
  return digestText(stableStringify(body));
}

/** Recompute the checksum of a received export (after JSON transport). */
export function verifyAuditExport(x: unknown): { ok: boolean; expected: string; actual: string | null } {
  if (typeof x !== "object" || x === null) return { ok: false, expected: "", actual: null };
  const { checksum, ...rest } = x as Record<string, unknown>;
  const expected = digestText(stableStringify(rest));
  return {
    ok: typeof checksum === "string" && checksum === expected,
    expected,
    actual: (checksum as string) ?? null,
  };
}

/* -------------------------------- builder -------------------------------- */

const REDACT_DIGEST = new Set(["display_name", "custody_ref", "note", "signed_tx"]);

/** Parse `*_json` columns and replace redacted columns with their digest. */
function clean(r: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(r)) {
    if (REDACT_DIGEST.has(k)) {
      out[`${k}_sha256`] = v === null || v === undefined ? null : digestText(String(v));
      continue;
    }
    if (k.endsWith("_json") && typeof v === "string") {
      try {
        out[k.slice(0, -5)] = JSON.parse(v);
      } catch {
        out[k] = v;
      }
      continue;
    }
    out[k] = typeof v === "bigint" ? v.toString(10) : v;
  }
  return out;
}

function placeholders(n: number): string {
  return new Array(n).fill("?").join(",");
}

export function buildAuditExport(
  d: AppDeps,
  m: TradeModules,
  terms: TradeTerms,
  ctx: AuthContext,
  opts: { observedChain: unknown; destinations?: DestinationMode },
): AuditExport {
  const db = d.db;
  const t = terms.tradeId;
  const mode: DestinationMode = opts.destinations ?? "MASKED";
  const all = (sql: string, ...p: (string | number)[]) => db.all(sql, ...p).map(clean);
  const inList = (table: string, col: string, ids: string[], order = "rowid") =>
    ids.length
      ? all(`SELECT * FROM ${table} WHERE ${col} IN (${placeholders(ids.length)}) ORDER BY ${order}`, ...ids)
      : [];

  const revisions = [
    ...all(
      "SELECT trade_id, trade_revision, terms_digest, terms_json, policy_id, policy_revision, bound_at FROM evidence_trades WHERE trade_id = ?",
      t,
    ),
    ...all("SELECT * FROM evidence_trade_successors WHERE trade_id = ? ORDER BY trade_revision", t),
  ];
  // Every principal and service any revision of this trade bound.
  const principalIds = new Set<string>();
  const enrollmentIds = new Set<string>();
  for (const r of revisions) {
    const tj = r["terms"] as Record<string, Record<string, unknown>> | undefined;
    if (!tj) continue;
    for (const role of ["buyer", "supplier", "inspector", "riskResolver"])
      if (typeof tj[role]?.["principalId"] === "string") principalIds.add(tj[role]["principalId"] as string);
    for (const role of ["manifestAttestor", "policySetter"])
      if (typeof tj[role]?.["enrollmentId"] === "string")
        enrollmentIds.add(tj[role]["enrollmentId"] as string);
  }
  const serviceEnrollments = inList("service_enrollments", "id", [...enrollmentIds]);
  for (const e of serviceEnrollments) principalIds.add(String(e["principal_id"]));
  const pids = [...principalIds].sort();
  const authorities = {
    principals: inList("principals", "id", pids, "id"),
    keyVersions: inList("key_versions", "principal_id", pids, "principal_id, version"),
    roleGrants: inList("role_grants", "principal_id", pids, "created_at, id"),
    serviceEnrollments,
  };
  const evidencePolicy = all(
    "SELECT p.* FROM evidence_policies p JOIN evidence_trades t ON t.policy_id = p.policy_id AND t.policy_revision = p.revision WHERE t.trade_id = ?",
    t,
  );
  const manifests = all("SELECT * FROM evidence_manifests WHERE trade_id = ? ORDER BY revision", t);
  const items = all("SELECT * FROM evidence_items WHERE trade_id = ? ORDER BY created_at, rowid", t);
  const attestations = all(
    "SELECT * FROM manifest_attestations WHERE trade_id = ? ORDER BY recorded_at, rowid",
    t,
  ).map((a): Row => ({ ...a, status: m.evidence.attestationStatus(String(a["id"])) }));
  const inspections = all(
    "SELECT * FROM inspection_attestations WHERE trade_id = ? ORDER BY recorded_at, rowid",
    t,
  );
  const holds = all("SELECT * FROM hold_records WHERE trade_id = ? ORDER BY recorded_at, rowid", t).map(
    (h): Row => ({ ...h, status: m.holds.get(String(h["id"])).status }),
  );
  const holdIds = holds.map((h) => String(h["id"]));
  const holdResolutions = inList("hold_resolutions", "hold_id", holdIds);
  const holdResolutionRequests = inList("hold_resolution_requests", "hold_id", holdIds);
  const releaseIntents = all(
    "SELECT * FROM release_intents WHERE trade_id = ? ORDER BY created_at, rowid",
    t,
  );
  const intentIds = releaseIntents.map((i) => String(i["intent_id"]));
  const releaseEvents = inList("release_intent_events", "intent_id", intentIds);
  const releaseChildren = inList("release_children", "intent_id", intentIds);
  const releaseSignatures = all(
    "SELECT * FROM release_signatures WHERE trade_id = ? ORDER BY recorded_at, rowid",
    t,
  );
  const operations = all(
    "SELECT * FROM economic_operations WHERE trade_id = ? ORDER BY created_at, rowid",
    t,
  );
  const opIds = operations.map((o) => String(o["operation_id"]));
  const operationTransitions = inList("operation_transitions", "operation_id", opIds);
  const observations = inList("operation_observations", "operation_id", opIds, "seq");
  const dispositions = inList("operation_dispositions", "operation_id", opIds);
  const outbox = inList("outbox", "operation_id", opIds);
  const incidents = all(
    "SELECT * FROM reconciliation_incidents WHERE trade_id = ? ORDER BY opened_at, rowid",
    t,
  );
  const freezes = all("SELECT * FROM trade_freezes WHERE trade_id = ? ORDER BY frozen_at, rowid", t);
  const operatorRequests = all(
    "SELECT * FROM operator_requests WHERE trade_id = ? ORDER BY requested_at, rowid",
    t,
  );

  const subjects = new Set<string>([
    t,
    ...holdIds,
    ...intentIds,
    ...opIds,
    ...items.map((i) => String(i["item_id"])),
    ...attestations.map((a) => String(a["id"])),
    ...inspections.map((i) => String(i["id"])),
    ...incidents.map((i) => String(i["incident_id"])),
    ...releaseChildren.map((c) => String(c["child_id"])),
  ]);
  const subj = [...subjects];
  const auditEvents = db
    .all(
      `SELECT * FROM audit_events WHERE subject_id IN (${placeholders(subj.length)}) OR payload_json LIKE ? ORDER BY seq`,
      ...subj,
      `%"tradeId":"${t}"%`,
    )
    .map((r) => {
      const e = clean(r);
      return {
        seq: e["seq"],
        id: e["id"],
        schemaVersion: e["schema_version"],
        eventType: e["event_type"],
        organizationId: e["organization_id"],
        actorPrincipalId: e["actor_principal_id"],
        actorKeyVersionId: e["actor_key_version_id"],
        sessionId: e["session_id"],
        subjectType: e["subject_type"],
        subjectId: e["subject_id"],
        correlationId: e["correlation_id"],
        source: e["source"],
        observedAt: e["observed_at"],
        recordedAt: e["recorded_at"],
        payload: e["payload"],
        prevHash: e["prev_hash"],
        eventHash: e["event_hash"],
      } as Row;
    });
  const head = db.get<{ event_hash: string }>(
    "SELECT event_hash FROM audit_events ORDER BY seq DESC LIMIT 1",
  );
  const body: Omit<AuditExport, "checksum"> = {
    schema: AUDIT_EXPORT_SCHEMA,
    checksumAlgorithm: AUDIT_EXPORT_CHECKSUM,
    tradeId: t,
    generatedAt: d.clock.now(),
    exportedBy: {
      principalId: ctx.principal.id,
      keyVersionId: ctx.keyVersion.id,
      organizationId: ctx.organizationId,
    },
    sections: {
      revisions,
      authorities,
      evidencePolicy,
      manifests,
      items,
      attestations,
      inspections,
      holds,
      holdResolutions,
      holdResolutionRequests,
      releaseIntents,
      releaseEvents,
      releaseChildren,
      releaseSignatures,
      operations,
      operationTransitions,
      observations,
      dispositions,
      outbox,
      incidents,
      freezes,
      operatorRequests,
      fundedAuthorizations: [],
      auditEvents,
    },
    chain: opts.observedChain,
    integrity: {
      auditChain: new AuditLog(d.db, d.clock, d.ids).verifyChain(),
      auditHeadHash: head?.event_hash ?? null,
    },
    destinations: mode,
    exclusions:
      mode === "MASKED"
        ? [
            ...EXPORT_EXCLUSIONS,
            {
              item: "full NEAR account ids of parties, funders and the payout destination",
              reason:
                "default export; replaced by acct_<sha256 prefix>, request destinations=full as a party",
            },
          ]
        : EXPORT_EXCLUSIONS,
  };
  // Normalise through JSON so the checksum is computed over exactly what the client receives.
  let normalised = JSON.parse(
    JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString(10) : v)),
  ) as Omit<AuditExport, "checksum">;
  if (mode === "MASKED") {
    const accounts = new Set<string>();
    for (const r of revisions) {
      const tj = r["terms"] as Record<string, Record<string, unknown>> | undefined;
      for (const v of [
        tj?.["buyer"]?.["accountId"],
        tj?.["supplier"]?.["accountId"],
        tj?.["payout"]?.["destination"],
      ])
        if (typeof v === "string") accounts.add(v);
    }
    for (const o of operations) if (typeof o["recipient"] === "string") accounts.add(o["recipient"]);
    // Contract views can name accounts no API record holds yet (proposed, revoked, expired or
    // activated-but-unbound destination changes), so they feed the mask set too.
    for (const acct of chainAccounts(opts.observedChain)) accounts.add(acct);
    for (const i of releaseIntents)
      for (const sl of (i["slices"] as { funder?: string }[] | undefined) ?? [])
        if (typeof sl.funder === "string") accounts.add(sl.funder);
    accounts.delete(terms.escrowContractId);
    normalised = maskAccounts(normalised, [...accounts]) as Omit<AuditExport, "checksum">;
  }
  return { ...normalised, checksum: exportChecksum(normalised) };
}

/** Every party, funder and destination account named by the embedded contract views. */
function chainAccounts(observed: unknown): string[] {
  type Change = { fromDestination?: unknown; toDestination?: unknown } | null | undefined;
  const v = (observed ?? {}) as {
    trade?: { buyerAccount?: unknown; supplierAccount?: unknown; payoutDestination?: unknown } | null;
    ledger?: { funders?: Record<string, unknown>; deposits?: { funder?: unknown }[] } | null;
    refunds?: { funder?: unknown }[] | null;
    release?: {
      payoutDestination?: unknown;
      intents?: { destination?: unknown; slices?: { funder?: unknown }[] }[];
      pendingDestinationChange?: Change;
      destinationHistory?: Change[];
    } | null;
  };
  const out: unknown[] = [
    v.trade?.buyerAccount,
    v.trade?.supplierAccount,
    v.trade?.payoutDestination,
    v.release?.payoutDestination,
    ...Object.keys(v.ledger?.funders ?? {}),
    ...(v.ledger?.deposits ?? []).map((d) => d.funder),
    ...(Array.isArray(v.refunds) ? v.refunds : []).map((r) => r.funder),
  ];
  for (const i of v.release?.intents ?? []) {
    out.push(i.destination);
    for (const s of i.slices ?? []) out.push(s.funder);
  }
  for (const ch of [v.release?.pendingDestinationChange, ...(v.release?.destinationHistory ?? [])])
    out.push(ch?.fromDestination, ch?.toDestination);
  return out.filter((a): a is string => typeof a === "string" && a.length > 0);
}

export type DestinationMode = "MASKED" | "FULL";

export function maskAccount(account: string): string {
  return `acct_${digestText(account).slice(0, 24)}`;
}

/** Replace every occurrence of the given account ids (values, keys and inside strings). */
function maskAccounts(v: unknown, accounts: string[]): unknown {
  const sorted = [...accounts].sort((a, b) => b.length - a.length);
  const masks = sorted.map((a) => [a, maskAccount(a)] as const);
  const str = (x: string) => {
    let out = x;
    for (const [a, m] of masks) if (out.includes(a)) out = out.split(a).join(m);
    return out;
  };
  const walk = (x: unknown): unknown => {
    if (typeof x === "string") return str(x);
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object")
      return Object.fromEntries(
        Object.entries(x as Record<string, unknown>).map(([k, y]) => [str(k), walk(y)]),
      );
    return x;
  };
  return walk(v);
}
