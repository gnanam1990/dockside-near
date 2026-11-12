import type { AuthContext } from "@dockside/authority";
import { type CanonicalValue, type Capability, digestHexFor, fail, toTypedJson } from "@dockside/core";
import { type EvidencePolicy, parseEvidencePolicy, policyCanonical } from "@dockside/evidence";
import { AuditLog, type Database } from "@dockside/store";
import { z } from "zod";
import type { AppDeps } from "./app.js";
import { exportKeyList } from "./export-signing.js";
import { type Route, route } from "./routing.js";

/**
 * Organization settings (UI-SPEC §3.10, ADR-0018): evidence policies, retention and integrations.
 *
 * - Reads need ORG_SECURITY_ADMIN or AUDITOR of the caller's own organisation; every write needs
 *   ORG_SECURITY_ADMIN. Nobody reads or writes another organisation's settings.
 * - Editable settings are append-only revisions written with compare-and-swap on the revision the
 *   editor saw (`expectedRevision`); a stale editor gets VERSION_CONFLICT and nothing changes.
 * - Values the server takes from its own configuration (authority delays, RPC endpoint, network,
 *   funded payouts) are shown read-only with their source; this API cannot change them.
 * - Every change, connection test and refused write is appended to the hash-chained audit log.
 */
const SOURCE = "dockside-api";
const DAY_MS = 24 * 3600_000;

export const RETENTION_LIMITS = { minDays: 30, maxDays: 3650, defaultDays: 365 } as const;

export interface OrganizationSettingsDoc {
  readonly schema: "dockside/organization-settings@1";
  readonly retention: { readonly evidenceRetentionDays: number };
}

const DEFAULT_SETTINGS: OrganizationSettingsDoc = {
  schema: "dockside/organization-settings@1",
  retention: { evidenceRetentionDays: RETENTION_LIMITS.defaultDays },
};

/** What is never deleted, disclosed before collection (SECURITY.md privacy and retention). */
export const IMMUTABLE_RECORDS = [
  "hash-chained audit events",
  "escrow contract state and transactions on NEAR",
  "trade revisions, signatures and evidence digests",
  "release, refund and recovery journal records",
] as const;

type Row = Record<string, unknown>;

function readers(ctx: AuthContext | null): AuthContext {
  if (!ctx) fail("UNAUTHENTICATED", "authentication required");
  if (!ctx.capabilities.includes("ORG_SECURITY_ADMIN") && !ctx.capabilities.includes("AUDITOR"))
    fail("FORBIDDEN", "organization settings are readable by security administrators and auditors");
  return ctx;
}

function auditLog(d: AppDeps) {
  return new AuditLog(d.db, d.clock, d.ids);
}

function logAs(
  d: AppDeps,
  ctx: AuthContext,
  eventType: string,
  subjectType: string,
  subjectId: string,
  payload: Record<string, string | number | boolean | null>,
) {
  auditLog(d).append({
    eventType,
    organizationId: ctx.organizationId,
    actorPrincipalId: ctx.principal.id,
    actorKeyVersionId: ctx.keyVersion.id,
    sessionId: ctx.session.id,
    subjectType,
    subjectId,
    correlationId: ctx.correlationId,
    source: SOURCE,
    payload,
  });
}

/** Security administrators only; a refused write is audited in its own transaction. */
function writer(d: AppDeps, ctx: AuthContext | null, what: string): AuthContext {
  if (!ctx) fail("UNAUTHENTICATED", "authentication required");
  const need: Capability = "ORG_SECURITY_ADMIN";
  if (!ctx.capabilities.includes(need)) {
    logAs(d, ctx, "SETTINGS_CHANGE_DENIED", "organization", ctx.organizationId, {
      setting: what,
      code: "FORBIDDEN",
    });
    fail("FORBIDDEN", `changing ${what} requires the security administrator capability`);
  }
  return ctx;
}

/* ------------------------------- settings ------------------------------- */

function currentSettings(db: Database, organizationId: string) {
  const r = db.get(
    "SELECT * FROM organization_settings WHERE organization_id = ? ORDER BY revision DESC LIMIT 1",
    organizationId,
  );
  if (!r)
    return {
      revision: 0,
      settings: DEFAULT_SETTINGS,
      digest: digestHexFor("ORGANIZATION_SETTINGS", DEFAULT_SETTINGS as unknown as CanonicalValue),
      changedAt: null as number | null,
      changedByPrincipalId: null as string | null,
      source: "DEFAULT" as const,
    };
  return {
    revision: Number(r["revision"]),
    settings: JSON.parse(String(r["settings_json"])) as OrganizationSettingsDoc,
    digest: String(r["digest"]),
    changedAt: Number(r["changed_at"]),
    changedByPrincipalId: String(r["changed_by_principal_id"]),
    source: "ORGANIZATION" as const,
  };
}

function settingsHistory(db: Database, organizationId: string) {
  return db
    .all(
      "SELECT revision, settings_json, digest, changed_by_principal_id, changed_by_key_version_id, changed_at FROM organization_settings WHERE organization_id = ? ORDER BY revision DESC LIMIT 50",
      organizationId,
    )
    .map((r) => ({
      revision: Number(r["revision"]),
      settings: JSON.parse(String(r["settings_json"])) as OrganizationSettingsDoc,
      digest: String(r["digest"]),
      changedByPrincipalId: String(r["changed_by_principal_id"]),
      changedByKeyVersionId: String(r["changed_by_key_version_id"]),
      changedAt: Number(r["changed_at"]),
    }));
}

/* --------------------------- org-related trades --------------------------- */

interface OrgTrade {
  tradeId: string;
  policyId: string;
  policyRevision: number;
  relation: "BUYER_ORG" | "SUPPLIER_ORG";
}

function orgTrades(db: Database, organizationId: string): OrgTrade[] {
  const out: OrgTrade[] = [];
  for (const r of db.all(
    "SELECT trade_id, terms_json, policy_id, policy_revision FROM evidence_trades ORDER BY bound_at, trade_id",
  )) {
    const t = JSON.parse(String(r["terms_json"])) as {
      buyer?: { organizationId?: string };
      supplier?: { organizationId?: string };
    };
    const rel =
      t.buyer?.organizationId === organizationId
        ? "BUYER_ORG"
        : t.supplier?.organizationId === organizationId
          ? "SUPPLIER_ORG"
          : null;
    if (rel)
      out.push({
        tradeId: String(r["trade_id"]),
        policyId: String(r["policy_id"]),
        policyRevision: Number(r["policy_revision"]),
        relation: rel,
      });
  }
  return out;
}

/* ------------------------------ retention ------------------------------ */

const TERMINAL = new Set(["PAID", "REFUNDED", "FAILED", "WITHDRAWN"]);

/**
 * Which evidence objects the current retention period makes eligible for deletion. Computed from the
 * persisted journal and hold records: a trade is settled once it has a PAID release or a REFUNDED
 * refund and no operation is still open; nothing under an unresolved hold or a freeze is eligible.
 * This is a preview: no object is deleted by this build (the deletion job is not built, ADR-0018).
 */
function retentionPreview(d: AppDeps, organizationId: string, days: number, asOf: number) {
  const now = asOf;
  const trades = orgTrades(d.db, organizationId).map((t) => {
    const ops = d.db.all(
      "SELECT kind, state, updated_at FROM economic_operations WHERE trade_id = ? ORDER BY updated_at",
      t.tradeId,
    );
    const open = ops.filter((o) => !TERMINAL.has(String(o["state"]))).length;
    const settled = ops.filter(
      (o) =>
        (o["kind"] === "RELEASE" && o["state"] === "PAID") ||
        (o["kind"] === "REFUND" && o["state"] === "REFUNDED"),
    );
    const settledAt = settled.length ? Math.max(...settled.map((o) => Number(o["updated_at"]))) : null;
    const holds = d.db.all("SELECT id FROM hold_records WHERE trade_id = ?", t.tradeId).length;
    const resolved = d.db.all(
      "SELECT DISTINCT r.hold_id FROM hold_resolutions r JOIN hold_records h ON h.id = r.hold_id WHERE h.trade_id = ?",
      t.tradeId,
    ).length;
    const frozen = d.db.all("SELECT 1 AS x FROM trade_freezes WHERE trade_id = ?", t.tradeId).length > 0;
    const items = d.db.all(
      "SELECT COUNT(*) AS n, COALESCE(SUM(byte_length), 0) AS bytes FROM evidence_items WHERE trade_id = ?",
      t.tradeId,
    )[0] as Row | undefined;
    const eligibleAt = settledAt === null ? null : settledAt + days * DAY_MS;
    let status: "NOT_SETTLED" | "OPEN_OPERATION" | "UNRESOLVED_HOLD" | "FROZEN" | "RETAINED" | "ELIGIBLE";
    if (frozen) status = "FROZEN";
    else if (holds > resolved) status = "UNRESOLVED_HOLD";
    else if (open > 0) status = "OPEN_OPERATION";
    else if (settledAt === null) status = "NOT_SETTLED";
    else status = now >= (eligibleAt ?? Number.POSITIVE_INFINITY) ? "ELIGIBLE" : "RETAINED";
    return {
      tradeId: t.tradeId,
      relation: t.relation,
      status,
      settledAt,
      eligibleAt,
      evidenceItems: Number(items?.["n"] ?? 0),
      evidenceBytes: Number(items?.["bytes"] ?? 0),
    };
  });
  const eligible = trades.filter((t) => t.status === "ELIGIBLE");
  return {
    evaluatedAt: d.clock.now(),
    asOf: now,
    evidenceRetentionDays: days,
    trades,
    totals: {
      trades: trades.length,
      eligibleTrades: eligible.length,
      eligibleItems: eligible.reduce((a, t) => a + t.evidenceItems, 0),
      eligibleBytes: eligible.reduce((a, t) => a + t.evidenceBytes, 0),
    },
    deletion: {
      state: "NOT_BUILT",
      reason: "this build computes eligibility only; no evidence object is deleted",
    },
  };
}

/* --------------------------- evidence policies --------------------------- */

function policySummary(p: EvidencePolicy) {
  return {
    attestationLifetimeMs: p.attestationLifetimeMs,
    slots: p.slots.map((s) => ({
      slotId: s.slotId,
      purpose: s.purpose,
      minItems: s.minItems,
      maxItems: s.maxItems,
      allowedMime: s.allowedMime,
      maxItemBytes: s.maxItemBytes,
      freshnessMs: s.freshnessMs,
      issuerCapabilities: s.issuerCapabilities,
      uploaderCapabilities: s.uploaderCapabilities,
    })),
  };
}

function policiesFor(db: Database, organizationId: string) {
  const trades = orgTrades(db, organizationId);
  const owners = new Map(
    db
      .all("SELECT policy_id, organization_id FROM evidence_policy_owners")
      .map((r) => [String(r["policy_id"]), String(r["organization_id"])]),
  );
  const visible = new Set<string>();
  for (const [id, org] of owners) if (org === organizationId) visible.add(id);
  for (const t of trades) visible.add(t.policyId);
  const ids = [...visible].sort();
  return ids.map((policyId) => {
    const revisions = db
      .all(
        "SELECT revision, digest, policy_json, registered_at FROM evidence_policies WHERE policy_id = ? ORDER BY revision DESC",
        policyId,
      )
      .map((r) => {
        const p = parseEvidencePolicy(JSON.parse(String(r["policy_json"])));
        const revision = Number(r["revision"]);
        return {
          revision,
          digest: String(r["digest"]),
          registeredAt: Number(r["registered_at"]),
          boundTrades: trades.filter((t) => t.policyId === policyId && t.policyRevision === revision).length,
          policy: p,
          summary: policySummary(p),
        };
      });
    const owner = owners.get(policyId) ?? null;
    return {
      policyId,
      ownerOrganizationId: owner,
      ownedByYou: owner === organizationId,
      latestRevision: revisions[0]?.revision ?? 0,
      revisions,
    };
  });
}

/**
 * Register an EvidencePolicy revision for the caller's organisation: the first registration claims
 * the policy id; later revisions must come from the same organisation and be exactly the next
 * revision. A trade revision keeps binding the policy revision and digest it was signed with.
 */
export function registerOwnedPolicy(
  d: AppDeps,
  ctx: AuthContext,
  register: (p: unknown) => { policyId: string; revision: number; digest: string },
  raw: unknown,
) {
  const p = parseEvidencePolicy(raw);
  return d.db.transaction(() => {
    const owner = d.db.get(
      "SELECT organization_id FROM evidence_policy_owners WHERE policy_id = ?",
      p.policyId,
    );
    const latest = Number(
      d.db.get("SELECT MAX(revision) AS r FROM evidence_policies WHERE policy_id = ?", p.policyId)?.["r"] ??
        0,
    );
    if (owner && owner["organization_id"] !== ctx.organizationId)
      fail("FORBIDDEN", "this EvidencePolicy id belongs to another organization");
    if (!owner && latest > 0)
      fail("FORBIDDEN", "this EvidencePolicy id is registered without an owning organization");
    if (p.revision !== latest + 1)
      fail("VERSION_CONFLICT", "a new EvidencePolicy revision must be exactly the next revision", {
        expectedRevision: latest + 1,
      });
    const out = register(raw);
    if (!owner)
      d.db.run(
        "INSERT INTO evidence_policy_owners (policy_id, organization_id, registered_by_principal_id, registered_at) VALUES (?, ?, ?, ?)",
        p.policyId,
        ctx.organizationId,
        ctx.principal.id,
        d.clock.now(),
      );
    return { ...out, relayTyped: toTypedJson(policyCanonical(p)) };
  });
}

/** Operator/bootstrap helper: record which organisation owns an EvidencePolicy id. */
export function claimPolicyOwnership(
  db: Database,
  policyId: string,
  organizationId: string,
  principalId: string | null,
  at: number,
): void {
  db.run(
    "INSERT INTO evidence_policy_owners (policy_id, organization_id, registered_by_principal_id, registered_at) VALUES (?, ?, ?, ?) ON CONFLICT (policy_id) DO NOTHING",
    policyId,
    organizationId,
    principalId,
    at,
  );
}

/* ------------------------------ integrations ------------------------------ */

async function integrations(d: AppDeps) {
  const rpcUrl = d.config.DOCKSIDE_NEAR_RPC_URL;
  const probe = d.oneClick ? await d.oneClick.dryProbe() : null;
  return {
    network: d.config.DOCKSIDE_NETWORK,
    escrowContractId: d.config.DOCKSIDE_ESCROW_CONTRACT_ID ?? null,
    rpc: rpcUrl
      ? {
          configured: true,
          // Scheme and host only: the path or any provider token in it is never shown.
          endpoint: `${new URL(rpcUrl).protocol}//${new URL(rpcUrl).host}`,
          source: "DOCKSIDE_NEAR_RPC_URL",
          editable: false,
        }
      : { configured: false, endpoint: null, source: "DOCKSIDE_NEAR_RPC_URL", editable: false },
    fundedPayouts: { state: d.config.DOCKSIDE_FUNDED_PAYOUTS, source: "DOCKSIDE_FUNDED_PAYOUTS" },
    oneClick: probe
      ? {
          adapter: d.oneClick?.id ?? null,
          state: probe.kind === "NOT_ATTEMPTED" ? "NOT_RUN" : "UNKNOWN",
          reason:
            probe.kind === "NOT_ATTEMPTED" ? (probe.reason ?? "") : "probe result is not classified here",
          credential: { configured: false, writeOnly: true },
        }
      : {
          adapter: null,
          state: "NOT_RUN",
          reason: "no dry adapter is wired into this process",
          credential: { configured: false, writeOnly: true },
        },
    auditExportKeys: exportKeyList(d.db, d.config.DOCKSIDE_ORIGIN).keys,
    tradeModules: d.modules ? "CONFIGURED" : "NOT_CONFIGURED",
  };
}

/* --------------------------------- routes --------------------------------- */

export function settingsRoutes(d: AppDeps): Route[] {
  const r = route;
  return [
    r("GET", "/v1/organization/settings", true, undefined, ({ ctx }) => {
      const c = readers(ctx);
      const cur = currentSettings(d.db, c.organizationId);
      return {
        organizationId: c.organizationId,
        editable: c.capabilities.includes("ORG_SECURITY_ADMIN"),
        retention: {
          ...cur,
          limits: RETENTION_LIMITS,
          immutableRecords: IMMUTABLE_RECORDS,
        },
        authorityDelays: {
          source: "server configuration (DOCKSIDE_* variables); not editable here",
          recoveryDelayMs: d.config.DOCKSIDE_RECOVERY_DELAY_MS,
          destinationChangeDelayMs: d.config.DOCKSIDE_DESTINATION_CHANGE_DELAY_MS,
          challengeTtlMs: d.config.DOCKSIDE_CHALLENGE_TTL_MS,
          sessionTtlMs: d.config.DOCKSIDE_SESSION_TTL_MS,
          invitationTtlMs: d.config.DOCKSIDE_INVITATION_TTL_MS,
        },
        history: settingsHistory(d.db, c.organizationId),
      };
    }),
    r(
      "POST",
      "/v1/organization/settings/retention",
      true,
      z
        .object({
          expectedRevision: z.number().int().min(0),
          evidenceRetentionDays: z.number().int(),
        })
        .strict(),
      ({ ctx, body }) => {
        const c = writer(d, ctx, "retention");
        const b = body as { expectedRevision: number; evidenceRetentionDays: number };
        if (
          b.evidenceRetentionDays < RETENTION_LIMITS.minDays ||
          b.evidenceRetentionDays > RETENTION_LIMITS.maxDays
        )
          fail("VALIDATION_FAILED", "evidence retention must be between 30 and 3650 days", {
            minDays: RETENTION_LIMITS.minDays,
            maxDays: RETENTION_LIMITS.maxDays,
          });
        return d.db.transaction(() => {
          const cur = currentSettings(d.db, c.organizationId);
          if (cur.revision !== b.expectedRevision)
            fail("VERSION_CONFLICT", "settings changed since you loaded them; reload and review", {
              currentRevision: cur.revision,
            });
          const next: OrganizationSettingsDoc = {
            ...cur.settings,
            retention: { ...cur.settings.retention, evidenceRetentionDays: b.evidenceRetentionDays },
          };
          const digest = digestHexFor("ORGANIZATION_SETTINGS", next as unknown as CanonicalValue);
          const revision = cur.revision + 1;
          d.db.run(
            "INSERT INTO organization_settings (organization_id, revision, settings_json, digest, changed_by_principal_id, changed_by_key_version_id, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            c.organizationId,
            revision,
            JSON.stringify(next),
            digest,
            c.principal.id,
            c.keyVersion.id,
            d.clock.now(),
          );
          logAs(d, c, "ORGANIZATION_SETTINGS_CHANGED", "organization", c.organizationId, {
            setting: "retention.evidenceRetentionDays",
            from: cur.settings.retention.evidenceRetentionDays,
            to: b.evidenceRetentionDays,
            revision,
            digest,
            previousDigest: cur.digest,
          });
          return { ...currentSettings(d.db, c.organizationId) };
        });
      },
    ),
    r("GET", "/v1/organization/retention-preview", true, undefined, ({ ctx, query }) => {
      const c = readers(ctx);
      const cur = currentSettings(d.db, c.organizationId);
      // Optional `asOf` (ms): what the current period makes eligible at a later date (planning only).
      const now = d.clock.now();
      const raw = query.get("asOf");
      const asOf = raw === null ? now : Number(raw);
      if (
        !/^[0-9]{1,16}$/.test(raw ?? "0") ||
        !Number.isSafeInteger(asOf) ||
        asOf < now ||
        asOf > now + 3660 * DAY_MS
      )
        fail("VALIDATION_FAILED", "asOf must be a time in milliseconds from now up to ten years ahead");
      return {
        settingsRevision: cur.revision,
        ...retentionPreview(d, c.organizationId, cur.settings.retention.evidenceRetentionDays, asOf),
      };
    }),
    r("GET", "/v1/evidence-policies", true, undefined, ({ ctx }) => {
      const c = readers(ctx);
      return {
        organizationId: c.organizationId,
        editable: c.capabilities.includes("ORG_SECURITY_ADMIN") && d.modules !== undefined,
        policies: policiesFor(d.db, c.organizationId),
      };
    }),
    r("GET", "/v1/organization/integrations", true, undefined, async ({ ctx }) => {
      const c = readers(ctx);
      return { organizationId: c.organizationId, ...(await integrations(d)) };
    }),
    r("POST", "/v1/organization/integrations/rpc-test", true, z.object({}).strict(), async ({ ctx }) => {
      const c = writer(d, ctx, "integrations");
      if (!d.chain) fail("NOT_FOUND", "no such endpoint", { reason: "CHAIN_NOT_CONFIGURED" });
      const started = Date.now();
      try {
        const b = await d.chain.tx.latestBlock();
        const out = {
          reachable: true,
          blockHeight: b.height,
          blockHash: b.hash,
          latencyMs: Date.now() - started,
          testedAt: d.clock.now(),
          meaning: "connectivity only: a final block was read; nothing about trades or funds is implied",
        };
        logAs(d, c, "INTEGRATION_CONNECTION_TESTED", "integration", "near-rpc", {
          reachable: true,
          blockHeight: b.height,
        });
        return out;
      } catch (e) {
        const code = (e as { code?: string }).code ?? "UPSTREAM_ERROR";
        logAs(d, c, "INTEGRATION_CONNECTION_TESTED", "integration", "near-rpc", { reachable: false, code });
        return {
          reachable: false,
          code,
          latencyMs: Date.now() - started,
          testedAt: d.clock.now(),
          meaning: "the RPC endpoint did not return a final block",
        };
      }
    }),
  ];
}
