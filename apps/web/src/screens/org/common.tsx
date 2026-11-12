import { type ReactNode, useEffect, useRef } from "react";
import { useApp, useMutationGate } from "../../app/app-context";
import { Link, useRouter } from "../../app/router";
import { AddressDisplay, IdentityList, TableScroller } from "../../components/Data";
import { UiIcon } from "../../components/Icon";
import { BlockedAction, Callout } from "../../components/States";
import { StatusBadge } from "../../components/Status";
import type { VerifiedChallenge } from "../../lib/api/client";
import type { BoundRole, KeyVersionDetail, TradeBindingImpact } from "../../lib/api/types";
import { capabilityLabel, formatUntil, formatUtc, networkLabel } from "../../lib/format";

/** Sub-navigation of the Organization area (people, keys, service identities). */
export function OrgNav() {
  const { path } = useRouter();
  const items = [
    ["/organization", "Overview and invitations"],
    ["/organization/keys", "Keys and recovery"],
    ["/organization/services", "Service identities"],
    ["/organization/policies", "Evidence policies"],
    ["/organization/retention", "Retention"],
    ["/organization/integrations", "Integrations"],
    ["/organization/near-accounts", "NEAR accounts"],
  ] as const;
  return (
    <nav aria-label="Organization sections" className="tabnav">
      <ul>
        {items.map(([href, label]) => (
          <li key={href}>
            <Link href={href} current={path === href}>
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export const ROLE_LABEL: Record<string, string> = {
  buyer: "Buyer approver",
  supplier: "Supplier signer",
  inspector: "Named inspector",
  riskResolver: "Risk/policy resolver",
  manifestAttestor: "ManifestAttestor",
  policySetter: "Deterministic policy",
};

export const REVISION_CONSEQUENCE =
  "Rotation, revocation and recovery never change an active trade silently: the revision keeps binding the old key, so evidence attestation, inspection and release authority under it are refused until both parties accept a new trade revision that binds current keys.";

/** Roles in the impact list that bind exactly this human key version or this service version. */
export function rolesBinding(
  trades: TradeBindingImpact[] | null,
  match: { keyVersionId?: string; enrollmentId?: string; keyVersion?: number; principalId?: string },
): { trade: TradeBindingImpact; role: BoundRole }[] {
  const out: { trade: TradeBindingImpact; role: BoundRole }[] = [];
  for (const t of trades ?? [])
    for (const r of t.roles) {
      if (match.keyVersionId !== undefined && r.keyVersionId !== match.keyVersionId) continue;
      if (match.principalId !== undefined && r.principalId !== match.principalId) continue;
      if (match.enrollmentId !== undefined && r.enrollmentId !== match.enrollmentId) continue;
      if (match.keyVersion !== undefined && r.keyVersion !== match.keyVersion) continue;
      out.push({ trade: t, role: r });
    }
  return out;
}

/** The list a confirmation dialog shows: which trade revisions this change will force onto a new revision. */
export function AffectedTrades({
  affected,
  none,
}: {
  affected: { trade: TradeBindingImpact; role: BoundRole }[];
  none: string;
}) {
  if (affected.length === 0) return <p data-testid="affected-none">{none}</p>;
  return (
    <div data-testid="affected-trades">
      <p>
        <strong>
          {affected.length} trade revision{affected.length === 1 ? "" : "s"} bind this key and will require a
          new trade revision:
        </strong>
      </p>
      <ul>
        {affected.map(({ trade, role }) => (
          <li key={`${trade.tradeId}-${role.role}`}>
            <code>{trade.tradeId}</code> revision {trade.revision}, as {ROLE_LABEL[role.role] ?? role.role}
            {trade.liveIntentState ? ` (live release intent ${trade.liveIntentState})` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Every trade revision binding this organization's authority, with its per-role binding status. */
export function TradeImpactPanel({
  trades,
  observedAt,
}: {
  trades: TradeBindingImpact[];
  observedAt: number;
}) {
  const affected = trades.filter((t) => t.requiresNewRevision).length;
  return (
    <section className="panel" aria-labelledby="impact-title" data-testid="trade-impact">
      <h2 id="impact-title">Effect on in-flight trades</h2>
      <p>
        {trades.length === 0
          ? "No trade revision binds a principal or service of this organization."
          : `${trades.length} trade revision${trades.length === 1 ? "" : "s"} bind authority of this organization; ${affected} require${affected === 1 ? "s" : ""} a new trade revision.`}
      </p>
      <p className="muted">{REVISION_CONSEQUENCE}</p>
      {trades.length ? (
        <TableScroller label="Trade revisions binding this organization">
          <table>
            <caption>Bound roles by trade revision (source: GET /v1/organization/trade-bindings)</caption>
            <thead>
              <tr>
                <th scope="col">Trade</th>
                <th scope="col">Role</th>
                <th scope="col">Bound key</th>
                <th scope="col">Binding</th>
              </tr>
            </thead>
            <tbody>
              {trades.flatMap((t) =>
                t.roles.map((r) => (
                  <tr key={`${t.tradeId}-${r.role}`} data-trade={t.tradeId} data-role={r.role}>
                    <td>
                      <Link href={`/trades/${t.tradeId}/overview`} className="mono wrap">
                        {t.tradeId}
                      </Link>
                      <br />
                      <span className="small">revision {t.revision}</span>
                      {t.liveIntentState ? (
                        <span className="small"> · live intent {t.liveIntentState}</span>
                      ) : null}
                    </td>
                    <td>
                      {ROLE_LABEL[r.role] ?? r.role}
                      <br />
                      <code className="small wrap">{r.serviceId ?? r.principalId}</code>
                    </td>
                    <td className="mono small">
                      v{r.keyVersion ?? "?"}
                      {r.keyVersionId ? ` (${r.keyVersionId})` : ""}
                    </td>
                    <td>
                      {r.issues.length === 0 ? (
                        <span className="status tone-neutral">
                          <span className="status__label">Current: the bound key is active</span>
                        </span>
                      ) : (
                        r.issues.map((code) => (
                          <StatusBadge
                            key={code}
                            dimension="bindingIssue"
                            value={code}
                            source="authority bindingStatus"
                            observedAt={observedAt}
                          />
                        ))
                      )}
                    </td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </TableScroller>
      ) : null}
    </section>
  );
}

/** Key versions with full lifecycle, as served. Never key material. */
export function KeyVersionsTable({
  keys,
  caption,
  observedAt,
  currentKeyVersionId,
  action,
}: {
  keys: KeyVersionDetail[];
  caption: string;
  observedAt: number;
  currentKeyVersionId?: string;
  action?: ((k: KeyVersionDetail) => ReactNode) | undefined;
}) {
  return (
    <TableScroller label={caption}>
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Version</th>
            <th scope="col">Public key</th>
            <th scope="col">Status</th>
            <th scope="col">Lifecycle</th>
            {action ? <th scope="col">Action</th> : null}
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k.id} data-key-version={k.version} data-status={k.status}>
              <td className="mono">
                v{k.version}
                {k.id === currentKeyVersionId ? (
                  <>
                    <br />
                    <span className="small">this session</span>
                  </>
                ) : null}
              </td>
              <td className="mono small wrap">{k.publicKey}</td>
              <td>
                <StatusBadge
                  dimension="keyStatus"
                  value={k.status}
                  source="authority key versions"
                  observedAt={observedAt}
                  compact
                />
              </td>
              <td className="small">
                {[
                  `created ${formatUtc(k.createdAt)}`,
                  k.provenAt ? `proven ${formatUtc(k.provenAt)}` : null,
                  k.activatedAt ? `activated ${formatUtc(k.activatedAt)}` : null,
                  k.notBefore ? `not before ${formatUtc(k.notBefore)}` : null,
                  k.supersededAt ? `superseded ${formatUtc(k.supersededAt)}` : null,
                  k.suspendedAt ? `suspended ${formatUtc(k.suspendedAt)}` : null,
                  k.revokedAt ? `revoked ${formatUtc(k.revokedAt)} (${k.revokeReason ?? "no reason"})` : null,
                  k.custodyKind ? `custody ${k.custodyKind} (locator never shown)` : null,
                ]
                  .filter(Boolean)
                  .join("; ")}
              </td>
              {action ? <td>{action(k)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroller>
  );
}

const PURPOSE_CONSEQUENCE: Record<string, string> = {
  KEY_ROTATION:
    "Signing proves this browser holds the new key. The new version becomes active at once, the current version becomes SUPERSEDED and your current session ends with it. Trades that bound the old version require a new trade revision.",
  LOGIN: "Signing proves this browser holds the enrolled key and opens a session for that principal only.",
  RECOVERY_KEY:
    "Signing proves this browser holds the recovery key the administrator named. It does not activate it: a different administrator completes the recovery only after the delay, and your existing key can veto until then.",
  RECOVERY_CANCEL:
    "Signing with your existing key vetoes the recovery: your prior keys are restored and the recovery key is revoked.",
};

/** Browser-verified human PoP challenge review before an explicit signature. */
export function ChallengeReviewPanel({
  verified,
  publicKey,
  signLabel,
  onSign,
  onCancel,
  busy,
  testId,
}: {
  verified: VerifiedChallenge;
  publicKey: string;
  signLabel: string;
  onSign: () => void;
  onCancel: () => void;
  busy: boolean;
  testId: string;
}) {
  const { now } = useApp();
  const gate = useMutationGate();
  const p = verified.payload;
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <section className="panel review" aria-labelledby={`${testId}-title`} data-testid={testId}>
      <h3 id={`${testId}-title`} tabIndex={-1} ref={ref}>
        Review what you are about to sign
      </h3>
      <p className="muted">
        The browser recomputed the canonical digest and checked the origin, purpose and key before showing
        this.
      </p>
      <IdentityList
        items={[
          ["Purpose", p.purpose],
          ["Organization", <code key="o">{p.organizationId}</code>],
          ["Principal", <code key="p">{p.principalId}</code>],
          ["New key version", `v${p.keyVersion}`],
          ["Recovery", p.recoveryId ? <code key="r">{p.recoveryId}</code> : "None"],
          ["Requested capability", p.requestedCapability ? capabilityLabel(p.requestedCapability) : "None"],
          ["Origin", <code key="g">{p.origin}</code>],
          ["Network", networkLabel(p.network)],
          ["Expires", `${formatUtc(p.expiresAt)} (${formatUntil(p.expiresAt, now)})`],
        ]}
      />
      <h4>Signing key (this browser)</h4>
      <AddressDisplay value={publicKey} label="public key" />
      <h4>Canonical digest (dockside/pop-challenge v1)</h4>
      <AddressDisplay value={verified.challenge.digestHex} label="digest" />
      <Callout tone="warning" icon="authorized" title="Consequence" headingLevel={3}>
        <p>
          {PURPOSE_CONSEQUENCE[p.purpose] ?? "Signing proves possession of this key for the purpose above."}
        </p>
      </Callout>
      <div className="btn-row">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn--primary" onClick={onSign} disabled={busy || !gate.allowed}>
          <UiIcon name="key" />
          {signLabel}
        </button>
      </div>
      {gate.reason ? <BlockedAction reason={gate.reason} /> : null}
    </section>
  );
}

export const REVOKE_REASONS = [
  ["KEY_COMPROMISED", "Key compromised"],
  ["DEVICE_LOST", "Device lost"],
  ["PRINCIPAL_DEPARTED", "Principal left the organization"],
  ["ADMIN_DECISION", "Security administrator decision"],
] as const;

export function formatDelay(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  if (ms < 172_800_000) return `${Math.round(ms / 3_600_000)} h`;
  return `${Math.round(ms / 86_400_000)} days`;
}
