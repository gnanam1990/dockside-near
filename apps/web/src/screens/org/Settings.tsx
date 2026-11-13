import { type FormEvent, type ReactNode, useState } from "react";
import { useApiData, useApp, useMutationGate } from "../../app/app-context";
import { PageHeader } from "../../components/AppShell";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { IdentityList, TableScroller } from "../../components/Data";
import { Field } from "../../components/Forms";
import { BlockedAction, Callout, EmptyState, FailureState, LoadingState } from "../../components/States";
import { StatusBadge } from "../../components/Status";
import type { ApiFailure, ApiOutcome } from "../../lib/api/client";
import { ENDPOINTS } from "../../lib/api/endpoints";
import { capabilityLabel, formatUtc, networkLabel } from "../../lib/format";
import { commercialDocsPolicy } from "../../lib/policy-template";
import { formatDelay, OrgNav } from "./common";

/**
 * Organization settings (UI-SPEC §3.10, M17): evidence policies, retention and integrations.
 * Every value comes from the API; edits are compare-and-swap writes the server checks and audits.
 * Values the server takes from its own configuration are shown read-only with their source.
 */

/* --------------------------------- wire types --------------------------------- */

interface SlotSummary {
  readonly slotId: string;
  readonly purpose: string;
  readonly minItems: number;
  readonly maxItems: number;
  readonly allowedMime: string[];
  readonly maxItemBytes: number;
  readonly freshnessMs: number;
  readonly issuerCapabilities: string[];
  readonly uploaderCapabilities: string[];
}

interface PolicyRevision {
  readonly revision: number;
  readonly digest: string;
  readonly registeredAt: number;
  readonly boundTrades: number;
  readonly policy: Record<string, unknown> & { slots: Record<string, unknown>[] };
  readonly summary: { readonly attestationLifetimeMs: number; readonly slots: SlotSummary[] };
}

interface PolicyView {
  readonly policyId: string;
  readonly ownerOrganizationId: string | null;
  readonly ownedByYou: boolean;
  readonly latestRevision: number;
  readonly revisions: PolicyRevision[];
}

interface PoliciesResponse {
  readonly organizationId: string;
  readonly editable: boolean;
  readonly policies: PolicyView[];
}

interface SettingsDoc {
  readonly retention: { readonly evidenceRetentionDays: number };
}

interface SettingsResponse {
  readonly organizationId: string;
  readonly editable: boolean;
  readonly retention: {
    readonly revision: number;
    readonly settings: SettingsDoc;
    readonly digest: string;
    readonly changedAt: number | null;
    readonly changedByPrincipalId: string | null;
    readonly source: "DEFAULT" | "ORGANIZATION";
    readonly limits: { readonly minDays: number; readonly maxDays: number; readonly defaultDays: number };
    readonly immutableRecords: string[];
  };
  readonly authorityDelays: {
    readonly source: string;
    readonly recoveryDelayMs: number;
    readonly destinationChangeDelayMs: number;
    readonly challengeTtlMs: number;
    readonly sessionTtlMs: number;
    readonly invitationTtlMs: number;
  };
  readonly history: {
    readonly revision: number;
    readonly settings: SettingsDoc;
    readonly digest: string;
    readonly changedByPrincipalId: string;
    readonly changedAt: number;
  }[];
}

interface PreviewResponse {
  readonly settingsRevision: number;
  readonly evaluatedAt: number;
  readonly evidenceRetentionDays: number;
  readonly trades: {
    readonly tradeId: string;
    readonly relation: string;
    readonly status: string;
    readonly settledAt: number | null;
    readonly eligibleAt: number | null;
    readonly evidenceItems: number;
    readonly evidenceBytes: number;
  }[];
  readonly totals: {
    readonly trades: number;
    readonly eligibleItems: number;
    readonly eligibleBytes: number;
  };
  readonly deletion: { readonly state: string; readonly reason: string };
}

interface ExportKeyRow {
  readonly keyId: string;
  readonly publicKey: string;
  readonly status: string;
  readonly enrolledAt: number;
  readonly retiredAt: number | null;
  readonly revokedAt: number | null;
  readonly custodyKind: string;
}

interface IntegrationsResponse {
  readonly network: string;
  readonly escrowContractId: string | null;
  readonly rpc: { readonly configured: boolean; readonly endpoint: string | null; readonly source: string };
  readonly fundedPayouts: { readonly state: string; readonly source: string };
  readonly oneClick: {
    readonly adapter: string | null;
    readonly state: string;
    readonly reason: string;
    readonly credential: { readonly configured: boolean; readonly writeOnly: boolean };
  };
  readonly auditExportKeys: ExportKeyRow[];
  readonly tradeModules: string;
}

interface RpcTestResult {
  readonly reachable: boolean;
  readonly blockHeight?: number;
  readonly blockHash?: string;
  readonly code?: string;
  readonly latencyMs: number;
  readonly testedAt: number;
  readonly meaning: string;
}

/* --------------------------------- shared shell --------------------------------- */

const DAY_MS = 24 * 3600_000;

function useReader() {
  const app = useApp();
  const me = app.me;
  const reader =
    !!me && (me.capabilities.includes("ORG_SECURITY_ADMIN") || me.capabilities.includes("AUDITOR"));
  const admin = !!me && me.capabilities.includes("ORG_SECURITY_ADMIN");
  return { app, me, reader, admin };
}

function SettingsShell({
  title,
  description,
  what,
  children,
}: {
  title: string;
  description: string;
  what: string;
  children: (ctx: ReturnType<typeof useReader>) => ReactNode;
}) {
  const ctx = useReader();
  const header = (
    <>
      <PageHeader title={title} description={description} />
      <OrgNav />
    </>
  );
  if (!ctx.app.meLoaded) return <LoadingState what="your session" />;
  if (!ctx.me)
    return (
      <>
        {header}
        <FailureState failure={{ kind: "no-session" }} what={what} />
      </>
    );
  if (!ctx.reader)
    return (
      <>
        {header}
        <Callout
          tone="neutral"
          icon="blocked"
          title={`${what} are not available to your role`}
          testId="settings-role"
        >
          <p>
            Organization settings are readable by the Org Security Admin and Auditor capabilities and changed
            only by an Org Security Admin. The server enforces this independently of this page.
          </p>
        </Callout>
      </>
    );
  return (
    <>
      {header}
      {children(ctx)}
    </>
  );
}

function Loaded<T>({
  what,
  data,
  children,
}: {
  what: string;
  data: { state: string; outcome: ApiOutcome<T> | null; reload: () => void };
  children: (v: T) => ReactNode;
}) {
  if (!data.outcome) return <LoadingState what={what} />;
  if (!data.outcome.ok)
    return <FailureState failure={data.outcome.error} what={what} onRetry={data.reload} />;
  return <>{children(data.outcome.data)}</>;
}

function failureText(f: ApiFailure): string {
  if (f.kind === "http") return `${f.code}: ${f.message}`;
  if (f.kind === "endpoint-unavailable") return `not available in this backend build (${f.method} ${f.path})`;
  if (f.kind === "network") return `network error: ${f.message}`;
  if (f.kind === "refused-to-sign") return f.reason;
  if (f.kind === "invalid-response") return f.message;
  return "sign in first";
}

/* ================================== policies ================================== */

const MIME_TEXT = (m: string[]) => m.join(", ");

function PolicyRevisionTable({ p }: { p: PolicyView }) {
  return (
    <TableScroller label={`Revisions of ${p.policyId}`}>
      <table data-testid={`policy-revisions-${p.policyId}`}>
        <caption>Registered revisions of {p.policyId} (newest first)</caption>
        <thead>
          <tr>
            <th scope="col">Revision</th>
            <th scope="col">Digest</th>
            <th scope="col">Attestation lifetime</th>
            <th scope="col">Slots</th>
            <th scope="col">Trades binding it</th>
            <th scope="col">Registered</th>
          </tr>
        </thead>
        <tbody>
          {p.revisions.map((r) => (
            <tr key={r.revision}>
              <td className="tabular">{r.revision}</td>
              <td className="mono wrap">{r.digest}</td>
              <td>{formatDelay(r.summary.attestationLifetimeMs)}</td>
              <td>{r.summary.slots.map((s) => s.slotId).join(", ")}</td>
              <td className="tabular">{r.boundTrades}</td>
              <td className="mono">{formatUtc(r.registeredAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroller>
  );
}

function SlotTable({ r }: { r: PolicyRevision }) {
  return (
    <TableScroller label={`Slots of revision ${r.revision}`}>
      <table>
        <caption>Evidence slots, revision {r.revision}</caption>
        <thead>
          <tr>
            <th scope="col">Slot</th>
            <th scope="col">Items</th>
            <th scope="col">Types</th>
            <th scope="col">Max size</th>
            <th scope="col">Freshness</th>
            <th scope="col">Issuer</th>
            <th scope="col">Uploaders</th>
          </tr>
        </thead>
        <tbody>
          {r.summary.slots.map((s) => (
            <tr key={s.slotId}>
              <th scope="row">{s.slotId}</th>
              <td className="tabular">
                {s.minItems}–{s.maxItems}
              </td>
              <td>{MIME_TEXT(s.allowedMime)}</td>
              <td className="tabular">{s.maxItemBytes.toLocaleString("en-US")} bytes</td>
              <td>{formatDelay(s.freshnessMs)}</td>
              <td>{s.issuerCapabilities.map(capabilityLabel).join(", ")}</td>
              <td>{s.uploaderCapabilities.map(capabilityLabel).join(", ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroller>
  );
}

/** Draft the next revision from the latest one: a few bounded fields; the server validates all of it. */
function PolicyDraft({ p, onDone }: { p: PolicyView; onDone: () => void }) {
  const app = useApp();
  const gate = useMutationGate();
  const latest = p.revisions[0];
  const [lifetimeHours, setLifetimeHours] = useState(
    latest ? String(Math.round(latest.summary.attestationLifetimeMs / 3600_000)) : "24",
  );
  const [fresh, setFresh] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (latest?.summary.slots ?? []).map((s) => [s.slotId, String(Math.round(s.freshnessMs / DAY_MS))]),
    ),
  );
  const [confirm, setConfirm] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [done, setDone] = useState<{ revision: number; digest: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!latest) return null;
  const hours = Number(lifetimeHours);
  const days = Object.fromEntries(Object.entries(fresh).map(([k, v]) => [k, Number(v)]));
  const errors: string[] = [];
  if (!Number.isInteger(hours) || hours < 1 || hours > 24 * 30)
    errors.push("Attestation lifetime must be 1 to 720 hours.");
  for (const [k, v] of Object.entries(days))
    if (!Number.isInteger(v) || v < 1 || v > 365) errors.push(`Freshness of ${k} must be 1 to 365 days.`);
  const next = {
    ...latest.policy,
    revision: latest.revision + 1,
    attestationLifetimeMs: hours * 3600_000,
    slots: latest.policy.slots.map((s) => ({ ...s, freshnessMs: (days[String(s["slotId"])] ?? 1) * DAY_MS })),
  };
  const changes = [
    hours * 3600_000 !== latest.summary.attestationLifetimeMs
      ? `Attestation lifetime ${formatDelay(latest.summary.attestationLifetimeMs)} → ${formatDelay(hours * 3600_000)}`
      : null,
    ...latest.summary.slots.map((s) =>
      (days[s.slotId] ?? 0) * DAY_MS !== s.freshnessMs
        ? `${s.slotId} freshness ${formatDelay(s.freshnessMs)} → ${formatDelay((days[s.slotId] ?? 0) * DAY_MS)}`
        : null,
    ),
  ].filter((x): x is string => x !== null);
  const submit = async () => {
    setBusy(true);
    setFailure(null);
    const out = await app.client.call<{ revision: number; digest: string }>(
      ENDPOINTS.registerEvidencePolicy,
      {
        body: { policy: next },
      },
    );
    setBusy(false);
    setConfirm(false);
    if (out.ok) {
      setDone(out.data);
      onDone();
    } else setFailure(out.error);
  };
  return (
    <section
      className="panel"
      aria-labelledby={`draft-${p.policyId}`}
      data-testid={`policy-draft-${p.policyId}`}
    >
      <h3 id={`draft-${p.policyId}`}>Draft revision {latest.revision + 1}</h3>
      <p className="muted">
        A new revision never changes a trade that is already signed: each trade revision keeps binding the
        policy revision and digest its parties accepted. New proposals may choose the new revision.
      </p>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (errors.length === 0 && changes.length > 0) setConfirm(true);
        }}
      >
        <Field
          id={`lifetime-${p.policyId}`}
          label="Attestation lifetime (hours)"
          help="How long a ManifestAttestor attestation stays current (1 to 720 hours)."
          error={
            !Number.isInteger(hours) || hours < 1 || hours > 720
              ? "Enter whole hours from 1 to 720."
              : undefined
          }
        >
          {(aria) => (
            <input
              {...aria}
              inputMode="numeric"
              value={lifetimeHours}
              onChange={(e) => setLifetimeHours(e.target.value)}
            />
          )}
        </Field>
        {latest.summary.slots.map((s) => (
          <Field
            key={s.slotId}
            id={`fresh-${p.policyId}-${s.slotId}`}
            label={`Freshness of ${s.slotId} (days)`}
            help="An item older than this is STALE and no longer fills the slot (1 to 365 days)."
            error={
              !Number.isInteger(days[s.slotId]) || (days[s.slotId] ?? 0) < 1 || (days[s.slotId] ?? 0) > 365
                ? "Enter whole days from 1 to 365."
                : undefined
            }
          >
            {(aria) => (
              <input
                {...aria}
                inputMode="numeric"
                value={fresh[s.slotId] ?? ""}
                onChange={(e) => setFresh((f) => ({ ...f, [s.slotId]: e.target.value }))}
              />
            )}
          </Field>
        ))}
        <p data-testid="draft-changes">
          {changes.length ? `Changes: ${changes.join("; ")}.` : "No changes yet."}
        </p>
        <button
          type="submit"
          className="btn btn--primary"
          disabled={busy || !gate.allowed || errors.length > 0 || changes.length === 0}
        >
          Review revision {latest.revision + 1}
        </button>
        {gate.reason ? <BlockedAction reason={gate.reason} /> : null}
      </form>
      <ConfirmDialog
        open={confirm}
        title={`Register ${p.policyId} revision ${latest.revision + 1}?`}
        confirmLabel="Register revision"
        onCancel={() => setConfirm(false)}
        onConfirm={() => void submit()}
      >
        <p>
          Registration is permanent: a revision and its digest cannot be edited or removed. Trades that bind
          revision {latest.revision} keep it.
        </p>
        <ul>
          {changes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </ConfirmDialog>
      {failure ? (
        <Callout tone="negative" icon="blocked" title="Revision not registered" headingLevel={3} role="alert">
          <p>{failureText(failure)}</p>
        </Callout>
      ) : null}
      {done ? (
        <Callout
          tone="neutral"
          icon="complete"
          title={`Revision ${done.revision} registered`}
          headingLevel={3}
          role="status"
          testId="policy-registered"
        >
          <p>
            Digest <code className="wrap">{done.digest}</code>
          </p>
        </Callout>
      ) : null}
    </section>
  );
}

export function OrganizationPoliciesScreen() {
  return (
    <SettingsShell
      title="Evidence policies"
      description="EvidencePolicy revisions your organization owns or that your trades bind: slots, limits, freshness and the digest each trade signed."
      what="Evidence policies"
    >
      {({ app, admin }) => <PoliciesBody app={app} admin={admin} />}
    </SettingsShell>
  );
}

function PoliciesBody({ app, admin }: { app: ReturnType<typeof useApp>; admin: boolean }) {
  const [tick, setTick] = useState(0);
  const data = useApiData(() => app.client.call<PoliciesResponse>(ENDPOINTS.evidencePolicies), [tick]);
  return (
    <Loaded what="Evidence policies" data={data}>
      {(v) => (
        <>
          {admin && v.editable ? <NewPolicy onDone={() => setTick((t) => t + 1)} /> : null}
          {v.policies.length === 0 ? (
            <EmptyState title="No evidence policies yet">
              <p>Your organization owns no EvidencePolicy and none of its trades binds one.</p>
            </EmptyState>
          ) : (
            v.policies.map((p) => {
              const latest = p.revisions[0];
              return (
                <section
                  key={p.policyId}
                  className="panel"
                  aria-labelledby={`pol-${p.policyId}`}
                  data-testid={`policy-${p.policyId}`}
                >
                  <h2 id={`pol-${p.policyId}`}>{p.policyId}</h2>
                  <IdentityList
                    items={[
                      ["Latest revision", String(p.latestRevision)],
                      [
                        "Owner",
                        p.ownedByYou
                          ? "Your organization"
                          : p.ownerOrganizationId
                            ? `Another organization (${p.ownerOrganizationId})`
                            : "No owning organization recorded (registered by the operator)",
                      ],
                    ]}
                  />
                  <PolicyRevisionTable p={p} />
                  {latest ? <SlotTable r={latest} /> : null}
                  {p.ownedByYou && admin && v.editable ? (
                    <PolicyDraft p={p} onDone={() => setTick((t) => t + 1)} />
                  ) : (
                    <p className="muted" data-testid={`policy-readonly-${p.policyId}`}>
                      {p.ownedByYou
                        ? admin
                          ? "New revisions need the trade modules of this backend."
                          : "Only an Org Security Admin of the owning organization registers new revisions."
                        : "Read-only here: only the owning organization registers new revisions of this policy."}
                    </p>
                  )}
                </section>
              );
            })
          )}
        </>
      )}
    </Loaded>
  );
}

const POLICY_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Register an organisation's first EvidencePolicy (M43): revision 1 of a new policy id, from the
 * commercial-documents template or an edited document. The first registration claims the id for this
 * organisation; later revisions come from the draft form of that policy.
 */
function NewPolicy({ onDone }: { onDone: () => void }) {
  const app = useApp();
  const gate = useMutationGate();
  const [policyId, setPolicyId] = useState("commercial-docs");
  const [doc, setDoc] = useState(() => JSON.stringify(commercialDocsPolicy("commercial-docs"), null, 2));
  const [confirm, setConfirm] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [done, setDone] = useState<{ policyId: string; revision: number; digest: string } | null>(null);
  const [busy, setBusy] = useState(false);
  let parsed: Record<string, unknown> | null = null;
  try {
    const v = JSON.parse(doc) as unknown;
    if (typeof v === "object" && v !== null && !Array.isArray(v)) parsed = v as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  const idError = POLICY_ID.test(policyId) ? undefined : "Use lowercase letters, digits and hyphens.";
  const docError =
    parsed === null
      ? "The policy document must be a JSON object."
      : parsed["policyId"] !== policyId
        ? "The document's policyId must equal the policy ID above."
        : parsed["revision"] !== 1
          ? "A new policy starts at revision 1."
          : undefined;
  const submit = async () => {
    setBusy(true);
    setFailure(null);
    const out = await app.client.call<{ policyId: string; revision: number; digest: string }>(
      ENDPOINTS.registerEvidencePolicy,
      { body: { policy: parsed } },
    );
    setBusy(false);
    setConfirm(false);
    if (out.ok) {
      setDone(out.data);
      onDone();
    } else setFailure(out.error);
  };
  return (
    <section className="panel" aria-labelledby="new-policy-title" data-testid="policy-new">
      <h2 id="new-policy-title">Register a new evidence policy</h2>
      <p className="muted">
        Revision 1 of a new policy ID, owned by your organization. Trade proposals name it; the
        ManifestAttestor and deterministic-policy services are enrolled for its ID and revision.
      </p>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (!idError && !docError) setConfirm(true);
        }}
      >
        <Field id="new-policy-id" label="New policy ID" error={idError}>
          {(aria) => (
            <input
              {...aria}
              className="mono"
              spellCheck={false}
              autoComplete="off"
              value={policyId}
              onChange={(e) => setPolicyId(e.target.value)}
            />
          )}
        </Field>
        <div className="btn-row">
          <button
            type="button"
            className="btn"
            onClick={() => setDoc(JSON.stringify(commercialDocsPolicy(policyId), null, 2))}
          >
            Use the commercial documents template
          </button>
        </div>
        <Field
          id="new-policy-doc"
          label="Policy document (JSON)"
          help="Slots, uploaders, issuers, limits and freshness. The server validates every field."
          error={docError}
        >
          {(aria) => (
            <textarea
              {...aria}
              className="mono"
              rows={12}
              spellCheck={false}
              value={doc}
              onChange={(e) => setDoc(e.target.value)}
            />
          )}
        </Field>
        <button
          type="submit"
          className="btn btn--primary"
          disabled={busy || !gate.allowed || Boolean(idError) || Boolean(docError)}
        >
          Review new policy
        </button>
        {gate.reason ? <BlockedAction reason={gate.reason} /> : null}
      </form>
      <ConfirmDialog
        open={confirm}
        title={`Register ${policyId} revision 1?`}
        confirmLabel="Register policy"
        onCancel={() => setConfirm(false)}
        onConfirm={() => void submit()}
      >
        <p>
          Registration is permanent: the revision and its digest cannot be edited or removed, and the policy
          ID belongs to your organization from now on.
        </p>
      </ConfirmDialog>
      {failure ? (
        <Callout tone="negative" icon="blocked" title="Policy not registered" headingLevel={3} role="alert">
          <p>{failureText(failure)}</p>
        </Callout>
      ) : null}
      {done ? (
        <Callout
          tone="neutral"
          icon="complete"
          title={`${done.policyId} revision ${done.revision} registered`}
          headingLevel={3}
          role="status"
          testId="policy-created"
        >
          <p>
            Digest <code className="wrap">{done.digest}</code>
          </p>
        </Callout>
      ) : null}
    </section>
  );
}

/* ================================== retention ================================== */

export function OrganizationRetentionScreen() {
  return (
    <SettingsShell
      title="Retention"
      description="How long evidence objects are kept after a trade settles, what is never deleted, and which trades the current period makes eligible."
      what="Retention settings"
    >
      {({ app }) => <RetentionBody app={app} />}
    </SettingsShell>
  );
}

function RetentionBody({ app }: { app: ReturnType<typeof useApp> }) {
  const gate = useMutationGate();
  const [tick, setTick] = useState(0);
  const settings = useApiData(
    () => app.client.call<SettingsResponse>(ENDPOINTS.organizationSettings),
    [tick],
  );
  const preview = useApiData(() => app.client.call<PreviewResponse>(ENDPOINTS.retentionPreview), [tick]);
  const [days, setDays] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  return (
    <Loaded what="Retention settings" data={settings}>
      {(s) => {
        const current = s.retention.settings.retention.evidenceRetentionDays;
        const value = days ?? String(current);
        const n = Number(value);
        const invalid =
          !Number.isInteger(n) || n < s.retention.limits.minDays || n > s.retention.limits.maxDays;
        const save = async () => {
          setConfirm(false);
          setFailure(null);
          const out = await app.client.call<{ revision: number }>(ENDPOINTS.updateRetention, {
            body: { expectedRevision: s.retention.revision, evidenceRetentionDays: n },
          });
          if (out.ok) {
            setSaved(out.data.revision);
            setDays(null);
            setTick((t) => t + 1);
          } else setFailure(out.error);
        };
        return (
          <>
            <section className="panel" aria-labelledby="retention-title" data-testid="retention-panel">
              <h2 id="retention-title">Evidence retention</h2>
              <IdentityList
                items={[
                  ["Current period", `${current} days after a trade settles`],
                  [
                    "Settings revision",
                    s.retention.source === "DEFAULT"
                      ? "0 (default; never changed)"
                      : `${s.retention.revision}, changed ${s.retention.changedAt === null ? "" : formatUtc(s.retention.changedAt)} by ${s.retention.changedByPrincipalId ?? ""}`,
                  ],
                  [
                    "Settings digest",
                    <code key="d" className="wrap">
                      {s.retention.digest}
                    </code>,
                  ],
                  ["Never deleted (disclosed before collection)", s.retention.immutableRecords.join("; ")],
                ]}
              />
              {s.editable ? (
                <form
                  onSubmit={(e: FormEvent) => {
                    e.preventDefault();
                    if (!invalid && n !== current) setConfirm(true);
                  }}
                >
                  <Field
                    id="retention-days"
                    label="Evidence retention after settlement (days)"
                    help={`Whole days from ${s.retention.limits.minDays} to ${s.retention.limits.maxDays}. Applies to evidence objects only.`}
                    error={
                      invalid
                        ? `Enter whole days from ${s.retention.limits.minDays} to ${s.retention.limits.maxDays}.`
                        : undefined
                    }
                  >
                    {(aria) => (
                      <input
                        {...aria}
                        inputMode="numeric"
                        value={value}
                        onChange={(e) => setDays(e.target.value)}
                      />
                    )}
                  </Field>
                  <button
                    type="submit"
                    className="btn btn--primary"
                    disabled={!gate.allowed || invalid || n === current}
                  >
                    Review change
                  </button>
                  {gate.reason ? <BlockedAction reason={gate.reason} /> : null}
                </form>
              ) : (
                <p className="muted" data-testid="retention-readonly">
                  Read-only for your role: only an Org Security Admin changes retention.
                </p>
              )}
              <ConfirmDialog
                open={confirm}
                title="Change evidence retention?"
                confirmLabel="Save retention period"
                onCancel={() => setConfirm(false)}
                onConfirm={() => void save()}
              >
                <p>
                  {current} days → {n} days. This writes settings revision {s.retention.revision + 1}; the
                  change and its digest are recorded in the audit log. It never shortens what is retained on
                  chain or in the audit log.
                </p>
              </ConfirmDialog>
              {failure ? (
                <Callout
                  tone="negative"
                  icon="blocked"
                  title="Retention not changed"
                  headingLevel={3}
                  role="alert"
                  testId="retention-failure"
                >
                  <p>{failureText(failure)}</p>
                  {failure.kind === "http" && failure.code === "VERSION_CONFLICT" ? (
                    <p>
                      Someone changed these settings after you loaded them. The page now shows the current
                      values.
                    </p>
                  ) : null}
                </Callout>
              ) : null}
              {saved !== null ? (
                <Callout
                  tone="neutral"
                  icon="complete"
                  title={`Settings revision ${saved} saved`}
                  headingLevel={3}
                  role="status"
                  testId="retention-saved"
                />
              ) : null}
            </section>
            <RetentionPreviewPanel preview={preview} />
            <section className="panel" aria-labelledby="delays-title">
              <h2 id="delays-title">Authority delays</h2>
              <p className="muted">{s.authorityDelays.source}.</p>
              <IdentityList
                items={[
                  ["Key recovery delay", formatDelay(s.authorityDelays.recoveryDelayMs)],
                  [
                    "Destination-change delay for new proposals",
                    formatDelay(s.authorityDelays.destinationChangeDelayMs),
                  ],
                  ["Proof-of-possession challenge lifetime", formatDelay(s.authorityDelays.challengeTtlMs)],
                  ["Session lifetime", formatDelay(s.authorityDelays.sessionTtlMs)],
                  ["Invitation lifetime", formatDelay(s.authorityDelays.invitationTtlMs)],
                ]}
              />
            </section>
            <SettingsHistory s={s} />
          </>
        );
      }}
    </Loaded>
  );
}

function RetentionPreviewPanel({
  preview,
}: {
  preview: { state: string; outcome: ApiOutcome<PreviewResponse> | null; reload: () => void };
}) {
  return (
    <section className="panel" aria-labelledby="preview-title" data-testid="retention-preview">
      <h2 id="preview-title">Eligibility under the current period</h2>
      <Loaded what="Retention preview" data={preview}>
        {(p) => (
          <>
            <Callout tone="neutral" icon="not-run" title="Preview only" headingLevel={3}>
              <p>
                {p.deletion.reason}. Deletion state: {p.deletion.state}.
              </p>
            </Callout>
            <p>
              {p.totals.eligibleItems} evidence item{p.totals.eligibleItems === 1 ? "" : "s"} (
              {p.totals.eligibleBytes.toLocaleString("en-US")} bytes) would be eligible across{" "}
              {p.totals.trades} trade
              {p.totals.trades === 1 ? "" : "s"}, evaluated {formatUtc(p.evaluatedAt)}.
            </p>
            {p.trades.length === 0 ? (
              <p className="muted">No trade binds your organization.</p>
            ) : (
              <TableScroller label="Retention eligibility by trade">
                <table>
                  <caption>Trades of your organization and their retention state</caption>
                  <thead>
                    <tr>
                      <th scope="col">Trade</th>
                      <th scope="col">State</th>
                      <th scope="col">Settled</th>
                      <th scope="col">Eligible from</th>
                      <th scope="col">Evidence items</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.trades.map((t) => (
                      <tr key={t.tradeId}>
                        <td className="mono wrap">{t.tradeId}</td>
                        <td>
                          <StatusBadge
                            dimension="retentionState"
                            value={t.status}
                            source="API journal records"
                            observedAt={p.evaluatedAt}
                            compact
                          />
                        </td>
                        <td className="mono">{t.settledAt === null ? "—" : formatUtc(t.settledAt)}</td>
                        <td className="mono">{t.eligibleAt === null ? "—" : formatUtc(t.eligibleAt)}</td>
                        <td className="tabular">{t.evidenceItems}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroller>
            )}
          </>
        )}
      </Loaded>
    </section>
  );
}

function SettingsHistory({ s }: { s: SettingsResponse }) {
  return (
    <section className="panel" aria-labelledby="history-title">
      <h2 id="history-title">Change history</h2>
      {s.history.length === 0 ? (
        <p className="muted">No change has been made; the defaults apply.</p>
      ) : (
        <TableScroller label="Settings revisions">
          <table data-testid="settings-history">
            <caption>Settings revisions (append-only, newest first)</caption>
            <thead>
              <tr>
                <th scope="col">Revision</th>
                <th scope="col">Evidence retention</th>
                <th scope="col">Changed by</th>
                <th scope="col">Changed</th>
                <th scope="col">Digest</th>
              </tr>
            </thead>
            <tbody>
              {s.history.map((h) => (
                <tr key={h.revision}>
                  <td className="tabular">{h.revision}</td>
                  <td>{h.settings.retention.evidenceRetentionDays} days</td>
                  <td className="mono wrap">{h.changedByPrincipalId}</td>
                  <td className="mono">{formatUtc(h.changedAt)}</td>
                  <td className="mono wrap">{h.digest}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>
      )}
    </section>
  );
}

/* ================================= integrations ================================= */

export function OrganizationIntegrationsScreen() {
  return (
    <SettingsShell
      title="Integrations"
      description="NEAR RPC endpoint, escrow contract, the optional 1Click dry adapter, funded payouts and the audit-export signing keys. Test connection proves connectivity only."
      what="Integration settings"
    >
      {({ app, admin }) => <IntegrationsBody app={app} admin={admin} />}
    </SettingsShell>
  );
}

function IntegrationsBody({ app, admin }: { app: ReturnType<typeof useApp>; admin: boolean }) {
  const gate = useMutationGate();
  const data = useApiData(() => app.client.call<IntegrationsResponse>(ENDPOINTS.integrations), []);
  const [test, setTest] = useState<RpcTestResult | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    setFailure(null);
    const out = await app.client.call<RpcTestResult>(ENDPOINTS.rpcTest, { body: {} });
    setBusy(false);
    if (out.ok) setTest(out.data);
    else setFailure(out.error);
  };
  return (
    <Loaded what="Integration settings" data={data}>
      {(v) => (
        <>
          <section className="panel" aria-labelledby="rpc-title" data-testid="rpc-panel">
            <h2 id="rpc-title">NEAR network and RPC</h2>
            <IdentityList
              items={[
                ["Network", networkLabel(v.network)],
                [
                  "Escrow contract",
                  v.escrowContractId ? <code key="c">{v.escrowContractId}</code> : "Not configured",
                ],
                ["RPC endpoint", v.rpc.endpoint ? <code key="e">{v.rpc.endpoint}</code> : "Not configured"],
                ["Configured by", `${v.rpc.source} (server configuration; restart to change)`],
                ["Trade modules", v.tradeModules === "CONFIGURED" ? "Configured" : "Not configured"],
              ]}
            />
            {admin ? (
              <>
                <button
                  type="button"
                  className="btn"
                  disabled={busy || !gate.allowed || !v.rpc.configured}
                  onClick={() => void run()}
                >
                  Test connection
                </button>
                {gate.reason ? <BlockedAction reason={gate.reason} /> : null}
              </>
            ) : (
              <p className="muted">Only an Org Security Admin runs the connection test.</p>
            )}
            <p role="status" data-testid="rpc-test-result">
              {busy
                ? "Reading a final block from the RPC endpoint…"
                : test
                  ? test.reachable
                    ? `Reachable: final block ${test.blockHeight} read in ${test.latencyMs} ms at ${formatUtc(test.testedAt)}. ${test.meaning}.`
                    : `Not reachable (${test.code}) at ${formatUtc(test.testedAt)}. ${test.meaning}.`
                  : ""}
            </p>
            {failure ? (
              <Callout
                tone="negative"
                icon="blocked"
                title="Connection test not run"
                headingLevel={3}
                role="alert"
              >
                <p>{failureText(failure)}</p>
              </Callout>
            ) : null}
          </section>
          <section className="panel" aria-labelledby="oneclick-title" data-testid="oneclick-panel">
            <h2 id="oneclick-title">1Click dry adapter and funded payouts</h2>
            <StatusBadge
              dimension="dryCompatibility"
              value={v.oneClick.state}
              source="API dry adapter"
              observedAt={null}
              reason={v.oneClick.reason}
            />
            <IdentityList
              items={[
                ["Adapter", v.oneClick.adapter ?? "None wired"],
                [
                  "Partner credential",
                  `${v.oneClick.credential.configured ? "Configured" : "Not configured"}; secrets are write-only and never shown. This build accepts no provider credential.`,
                ],
                ["Funded payouts", `${v.fundedPayouts.state} (${v.fundedPayouts.source})`],
              ]}
            />
          </section>
          <section className="panel" aria-labelledby="exportkeys-title" data-testid="export-keys-panel">
            <h2 id="exportkeys-title">Audit export signing keys</h2>
            <p className="muted">
              The deployment operator's dedicated key signs audit exports in an isolated signer process.
              Auditors verify offline with the published key list and the <code>verify-export</code> command.
            </p>
            {v.auditExportKeys.length === 0 ? (
              <p data-testid="export-keys-none">
                No audit export key is enrolled; exports are checksummed but not signed.
              </p>
            ) : (
              <TableScroller label="Audit export keys">
                <table>
                  <caption>Enrolled audit export keys</caption>
                  <thead>
                    <tr>
                      <th scope="col">Key</th>
                      <th scope="col">Public key</th>
                      <th scope="col">Status</th>
                      <th scope="col">Custody</th>
                      <th scope="col">Valid</th>
                    </tr>
                  </thead>
                  <tbody>
                    {v.auditExportKeys.map((k) => (
                      <tr key={k.keyId}>
                        <td className="mono wrap">{k.keyId}</td>
                        <td className="mono wrap">{k.publicKey}</td>
                        <td>
                          <StatusBadge
                            dimension="exportKeyStatus"
                            value={k.status}
                            source="API key list"
                            observedAt={null}
                            compact
                          />
                        </td>
                        <td>
                          {k.custodyKind === "ISOLATED_SIGNER_PROCESS"
                            ? "Isolated signer process"
                            : k.custodyKind}
                        </td>
                        <td className="mono">
                          from {formatUtc(k.enrolledAt)}
                          {k.retiredAt === null ? "" : ` until ${formatUtc(k.retiredAt)}`}
                          {k.revokedAt === null ? "" : `; revoked ${formatUtc(k.revokedAt)}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroller>
            )}
          </section>
        </>
      )}
    </Loaded>
  );
}

export { failureText, Loaded };
