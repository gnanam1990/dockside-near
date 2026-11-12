import { type FormEvent, type ReactNode, useMemo, useState } from "react";
import { useApiData, useApp, useMutationGate } from "../../app/app-context";
import { Link } from "../../app/router";
import { PageHeader } from "../../components/AppShell";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { AddressDisplay, IdentityList, TableScroller } from "../../components/Data";
import { Field } from "../../components/Forms";
import { BlockedAction, Callout, FailureState, LoadingState } from "../../components/States";
import { StatusBadge } from "../../components/Status";
import type { ApiFailure, VerifiedChallenge } from "../../lib/api/client";
import { TradeApi, type TradeListItem } from "../../lib/api/trade";
import type {
  DirectoryPrincipal,
  KeyVersionDetail,
  OrganizationDirectory,
  RecoveryPackage,
  RecoveryView,
  TradeBindingImpact,
} from "../../lib/api/types";
import { capabilityLabel, formatUntil, formatUtc } from "../../lib/format";
import { type DeviceKeyRecord, generateDeviceKey } from "../../lib/keys";
import {
  AffectedTrades,
  ChallengeReviewPanel,
  formatDelay,
  KeyVersionsTable,
  OrgNav,
  REVISION_CONSEQUENCE,
  REVOKE_REASONS,
  rolesBinding,
  TradeImpactPanel,
} from "./common";

export const PUBLIC_KEY = /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/;

/** Key statuses an administrator may still revoke (the server decides; this only offers the control). */
const REVOCABLE = new Set(["ACTIVE", "PENDING_PROOF", "PENDING_ACTIVATION", "SUSPENDED"]);

/* ------------------------------------------------------------------------------------------ */
/* Your keys: every principal sees and rotates only its own key                                */
/* ------------------------------------------------------------------------------------------ */

interface Rotated {
  readonly version: number;
  readonly publicKey: string;
  readonly principalId: string;
  readonly boundTrades: number;
}

/** Trades in the caller's own list whose revision binds this principal in a party or authority role. */
function tradesBindingMe(trades: TradeListItem[] | null, principalId: string): TradeListItem[] {
  return (trades ?? []).filter(
    (t) =>
      t.buyer.principalId === principalId ||
      t.supplier.principalId === principalId ||
      t.inspector.principalId === principalId ||
      t.riskResolver.principalId === principalId,
  );
}

function MyKeysPanel({ onRotated }: { onRotated: (r: Rotated) => void }) {
  const app = useApp();
  const gate = useMutationGate();
  const me = app.me;
  const api = useMemo(() => new TradeApi(app.client), [app.client]);
  const [tick, setTick] = useState(0);
  const mine = useApiData(() => app.client.myKeys(), [tick]);
  const trades = useApiData(() => api.list(), [tick]);
  const [pending, setPending] = useState<{ key: DeviceKeyRecord; verified: VerifiedChallenge } | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [busy, setBusy] = useState(false);
  if (!me) return null;
  const bound = tradesBindingMe(trades.outcome?.ok ? trades.outcome.data.trades : null, me.principal.id);
  const tradesKnown = trades.outcome?.ok === true;

  const begin = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const key = await generateDeviceKey(
        `${me.principal.displayName} key v${me.keyVersion.version + 1}`,
        Date.now(),
      );
      const ch = await app.client.rotationChallenge(key.publicKey);
      if (!ch.ok) {
        setFailure(ch.error);
        return;
      }
      const v = await app.client.verifyChallenge(ch.data, {
        purpose: "KEY_ROTATION",
        publicKey: key.publicKey,
      });
      if (!v.ok) {
        setFailure({
          kind: "refused-to-sign",
          reason: `The rotation challenge was not signed: ${v.reason}.`,
        });
        return;
      }
      if (
        v.value.payload.principalId !== me.principal.id ||
        v.value.payload.organizationId !== me.organizationId
      ) {
        setFailure({
          kind: "refused-to-sign",
          reason: "The rotation challenge names a different principal.",
        });
        return;
      }
      setPending({ key, verified: v.value });
    } finally {
      setBusy(false);
    }
  };

  const sign = async () => {
    if (!pending) return;
    setBusy(true);
    setFailure(null);
    try {
      const sig = await app.client.signVerified(pending.verified, pending.key.privateKey);
      const out = await app.client.rotationComplete(pending.verified.challenge.challengeId, sig);
      if (!out.ok) {
        setFailure(out.error);
        setPending(null);
        return;
      }
      // The server activated the new version and ended this session with the old one.
      await app.keys.put({ ...pending.key, principalId: me.principal.id, organizationId: me.organizationId });
      const old = app.client.getSession()?.publicKey;
      if (old && old !== pending.key.publicKey) await app.keys.remove(old).catch(() => undefined);
      setPending(null);
      onRotated({
        version: out.data.version,
        publicKey: out.data.publicKey,
        principalId: me.principal.id,
        boundTrades: bound.length,
      });
      app.signOut();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" aria-labelledby="my-keys-title" data-testid="my-keys">
      <h2 id="my-keys-title">Your keys</h2>
      <p className="muted">
        Every version of your principal's key, as the authority service recorded it (source: GET /v1/me/keys).
        Only the public key is ever shown.
      </p>
      {mine.outcome === null ? (
        <LoadingState what="your keys" />
      ) : !mine.outcome.ok ? (
        <FailureState failure={mine.outcome.error} what="Your keys" headingLevel={3} onRetry={mine.reload} />
      ) : (
        <>
          <KeyVersionsTable
            keys={mine.outcome.data.keys}
            caption="Key versions of your principal"
            observedAt={mine.outcome.data.observedAt}
            currentKeyVersionId={mine.outcome.data.currentKeyVersionId}
          />
          {mine.outcome.data.recoveries.length ? (
            <RecoveriesTable
              recoveries={mine.outcome.data.recoveries}
              observedAt={mine.outcome.data.observedAt}
              caption="Recoveries of your principal"
            />
          ) : null}
        </>
      )}
      <h3>Rotate this browser's key</h3>
      <p>
        A new non-extractable key is generated in this browser and proves possession under your current
        session. The new version becomes active at once; the current version becomes SUPERSEDED and this
        session ends.
      </p>
      <div data-testid="rotation-impact">
        {!tradesKnown ? (
          <p className="muted">
            Trades binding your principal could not be read; the server still enforces the revision binding.
          </p>
        ) : bound.length === 0 ? (
          <p>No trade you can see binds your principal; rotation affects no in-flight trade.</p>
        ) : (
          <>
            <p>
              <strong>
                {bound.length} trade revision{bound.length === 1 ? "" : "s"} bind your current key and will
                require a new trade revision:
              </strong>
            </p>
            <ul>
              {bound.map((t) => (
                <li key={t.tradeId}>
                  <Link href={`/trades/${t.tradeId}/overview`} className="mono wrap">
                    {t.tradeId}
                  </Link>{" "}
                  revision {t.revision}
                  {t.liveIntentState ? ` (live release intent ${t.liveIntentState})` : ""}
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="muted">{REVISION_CONSEQUENCE}</p>
      </div>
      {failure ? <FailureState failure={failure} what="Key rotation" headingLevel={3} /> : null}
      {pending ? (
        <ChallengeReviewPanel
          verified={pending.verified}
          publicKey={pending.key.publicKey}
          signLabel="Sign rotation with the new key"
          onSign={() => void sign()}
          onCancel={() => {
            setPending(null);
            setTick((x) => x + 1);
          }}
          busy={busy}
          testId="rotation-review"
        />
      ) : (
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void begin()}
          disabled={busy || !gate.allowed}
        >
          Prepare key rotation
        </button>
      )}
      {gate.reason ? <BlockedAction reason={gate.reason} /> : null}
    </section>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Security administrator: people, revocation and delayed recovery                             */
/* ------------------------------------------------------------------------------------------ */

function RecoveriesTable({
  recoveries,
  observedAt,
  caption,
  principalName,
  action,
}: {
  recoveries: RecoveryView[];
  observedAt: number;
  caption: string;
  principalName?: (id: string) => string;
  action?: ((r: RecoveryView) => ReactNode) | undefined;
}) {
  const { now } = useApp();
  return (
    <TableScroller label={caption}>
      <table data-testid="recoveries-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Recovery</th>
            <th scope="col">Principal</th>
            <th scope="col">Status</th>
            <th scope="col">Delay</th>
            {action ? <th scope="col">Action</th> : null}
          </tr>
        </thead>
        <tbody>
          {recoveries.map((r) => (
            <tr key={r.id} data-recovery={r.id} data-status={r.status}>
              <td className="mono small wrap">
                {r.id}
                <br />
                new key v{r.newKeyVersion}
              </td>
              <td className="small">
                {principalName ? principalName(r.principalId) : null}
                <br />
                <code className="wrap">{r.principalId}</code>
              </td>
              <td>
                <StatusBadge
                  dimension="recoveryStatus"
                  value={r.status}
                  source="authority recoveries"
                  observedAt={observedAt}
                />
              </td>
              <td className="small">
                requested {formatUtc(r.requestedAt)} by <code className="wrap">{r.requestedBy}</code>; not
                before {formatUtc(r.notBefore)}
                {r.status === "WAITING" || r.status === "PENDING_PROOF"
                  ? ` (${formatUntil(r.notBefore, now)})`
                  : ""}
                {r.completedAt ? `; completed ${formatUtc(r.completedAt)} by ${r.completedBy ?? "?"}` : ""}
                {r.cancelledAt ? `; vetoed ${formatUtc(r.cancelledAt)}` : ""}
              </td>
              {action ? <td>{action(r)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroller>
  );
}

function RevokeKeyControl({
  principal,
  keyVersion,
  trades,
  onDone,
}: {
  principal: DirectoryPrincipal;
  keyVersion: KeyVersionDetail;
  trades: TradeBindingImpact[] | null;
  onDone: () => void;
}) {
  const app = useApp();
  const gate = useMutationGate();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string>(REVOKE_REASONS[0][0]);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const affected = rolesBinding(trades, { keyVersionId: keyVersion.id });
  const confirm = async () => {
    setOpen(false);
    setFailure(null);
    const out = await app.client.revokeKey(keyVersion.id, reason);
    if (!out.ok) setFailure(out.error);
    else onDone();
  };
  const fieldId = `revoke-reason-${keyVersion.id}`;
  return (
    <>
      <button type="button" className="btn btn--small" onClick={() => setOpen(true)} disabled={!gate.allowed}>
        Revoke v{keyVersion.version}
      </button>
      <ConfirmDialog
        open={open}
        title={`Revoke key v${keyVersion.version} of ${principal.displayName}`}
        confirmLabel="Revoke key"
        onCancel={() => setOpen(false)}
        onConfirm={() => void confirm()}
      >
        <IdentityList
          items={[
            ["Principal", <code key="p">{principal.id}</code>],
            ["Key version", `v${keyVersion.version} (${keyVersion.id})`],
            [
              "Public key",
              <code key="k" className="wrap">
                {keyVersion.publicKey}
              </code>,
            ],
            [
              "Reversible",
              "No. A revoked key never signs again; the principal needs recovery for a new key.",
            ],
          ]}
        />
        <Field id={fieldId} label="Revocation reason" help="Recorded in the audit log.">
          {(aria) => (
            <select {...aria} value={reason} onChange={(e) => setReason(e.target.value)}>
              {REVOKE_REASONS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          )}
        </Field>
        <p>Every session of this key ends at once.</p>
        <AffectedTrades affected={affected} none="No trade revision binds this key version." />
      </ConfirmDialog>
      {failure ? <FailureState failure={failure} what="Revocation" headingLevel={3} /> : null}
    </>
  );
}

function StartRecoveryControl({
  principal,
  delayMs,
  trades,
  onStarted,
}: {
  principal: DirectoryPrincipal;
  delayMs: number;
  trades: TradeBindingImpact[] | null;
  onStarted: (p: RecoveryPackage) => void;
}) {
  const app = useApp();
  const gate = useMutationGate();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [publicKey, setPublicKey] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const fieldId = `recovery-key-${principal.id}`;
  const affected = rolesBinding(trades, { principalId: principal.id });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!PUBLIC_KEY.test(publicKey.trim())) {
      setError(
        "Paste the new public key the principal generated on their own device (ed25519: followed by base58).",
      );
      document.getElementById(fieldId)?.focus();
      return;
    }
    setError(undefined);
    setConfirming(true);
  };
  const confirm = async () => {
    setConfirming(false);
    setFailure(null);
    const out = await app.client.startRecovery(principal.id, publicKey.trim());
    if (!out.ok) {
      setFailure(out.error);
      return;
    }
    setOpen(false);
    setPublicKey("");
    onStarted({
      schema: "dockside/recovery-package@1",
      recoveryId: out.data.recoveryId,
      principalId: principal.id,
      notBefore: out.data.notBefore,
      challenge: out.data.challenge,
    });
  };
  if (!open)
    return (
      <button type="button" className="btn btn--small" onClick={() => setOpen(true)} disabled={!gate.allowed}>
        Start recovery for {principal.displayName}
      </button>
    );
  return (
    <form
      onSubmit={onSubmit}
      noValidate
      className="inline-form"
      data-testid={`recovery-form-${principal.id}`}
    >
      <Field
        id={fieldId}
        label={`New public key for ${principal.displayName}`}
        help="Generated by the principal on their own device under Recover access; never a private key."
        error={error}
      >
        {(aria) => (
          <input
            {...aria}
            type="text"
            className="mono"
            spellCheck={false}
            autoComplete="off"
            value={publicKey}
            onChange={(e) => setPublicKey(e.target.value)}
          />
        )}
      </Field>
      <div className="btn-row">
        <button type="button" className="btn" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button type="submit" className="btn btn--primary" disabled={!gate.allowed}>
          Review recovery
        </button>
      </div>
      <ConfirmDialog
        open={confirming}
        title={`Start recovery for ${principal.displayName}`}
        confirmLabel="Start recovery"
        onCancel={() => setConfirming(false)}
        onConfirm={() => void confirm()}
      >
        <IdentityList
          items={[
            ["Principal", <code key="p">{principal.id}</code>],
            ["Capabilities", principal.capabilities.map(capabilityLabel).join(", ") || "None"],
            [
              "New public key",
              <code key="k" className="wrap">
                {publicKey.trim()}
              </code>,
            ],
            ["Recovery delay", formatDelay(delayMs)],
          ]}
        />
        <p>
          Every usable key of this principal is suspended at once and its sessions end. The new key must prove
          possession from the principal's own device; a security administrator other than the principal can
          complete only after the delay, and the principal can veto with an existing key until then.
        </p>
        <AffectedTrades affected={affected} none="No trade revision binds this principal." />
      </ConfirmDialog>
      {failure ? <FailureState failure={failure} what="Recovery" headingLevel={3} /> : null}
    </form>
  );
}

function CompleteRecoveryControl({
  recovery,
  trades,
  onDone,
}: {
  recovery: RecoveryView;
  trades: TradeBindingImpact[] | null;
  onDone: () => void;
}) {
  const app = useApp();
  const gate = useMutationGate();
  const [open, setOpen] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const affected = rolesBinding(trades, { principalId: recovery.principalId });
  const confirm = async () => {
    setOpen(false);
    setFailure(null);
    const out = await app.client.completeRecovery(recovery.id);
    if (!out.ok) setFailure(out.error);
    else onDone();
  };
  return (
    <>
      <button type="button" className="btn btn--small" onClick={() => setOpen(true)} disabled={!gate.allowed}>
        Complete recovery
      </button>
      <ConfirmDialog
        open={open}
        title="Complete recovery"
        confirmLabel="Complete recovery"
        onCancel={() => setOpen(false)}
        onConfirm={() => void confirm()}
      >
        <IdentityList
          items={[
            ["Recovery", <code key="r">{recovery.id}</code>],
            ["Principal", <code key="p">{recovery.principalId}</code>],
            ["New key version", `v${recovery.newKeyVersion}`],
            ["Delay ends", formatUtc(recovery.notBefore)],
          ]}
        />
        <p>
          The new key becomes active and the suspended keys are revoked (reason RECOVERED). This cannot be
          undone. The server refuses completion before the delay ends and by the recovered principal itself.
        </p>
        <AffectedTrades affected={affected} none="No trade revision binds this principal." />
      </ConfirmDialog>
      {failure ? <FailureState failure={failure} what="Recovery completion" headingLevel={3} /> : null}
    </>
  );
}

function RecoveryPackagePanel({ pkg, onHide }: { pkg: RecoveryPackage; onHide: () => void }) {
  const { now } = useApp();
  return (
    <div className="secret-once" data-testid="recovery-package" role="status">
      <h3>Recovery started: hand this package to the principal</h3>
      <p>
        It contains no secret: only the server's challenge for the new key, which the principal signs in their
        own browser under <Link href="/recovery">Recover access</Link>. The challenge expires{" "}
        {formatUtc(pkg.challenge.expiresAt)} ({formatUntil(pkg.challenge.expiresAt, now)}).
      </p>
      <IdentityList
        items={[
          ["Recovery", <code key="r">{pkg.recoveryId}</code>],
          ["Principal", <code key="p">{pkg.principalId}</code>],
          ["Not before", formatUtc(pkg.notBefore)],
        ]}
      />
      <AddressDisplay value={JSON.stringify(pkg)} label="recovery package" />
      <button type="button" className="btn" onClick={onHide}>
        Hide the package
      </button>
    </div>
  );
}

function PeoplePanel({
  dir,
  trades,
  admin,
  onChanged,
}: {
  dir: OrganizationDirectory;
  trades: TradeBindingImpact[] | null;
  admin: boolean;
  onChanged: () => void;
}) {
  const app = useApp();
  const [pkg, setPkg] = useState<RecoveryPackage | null>(null);
  const openRecovery = new Set(
    dir.recoveries
      .filter((r) => r.status === "PENDING_PROOF" || r.status === "WAITING")
      .map((r) => r.principalId),
  );
  const nameOf = (id: string) => dir.principals.find((p) => p.id === id)?.displayName ?? "";
  return (
    <section className="panel" aria-labelledby="people-title" data-testid="people">
      <h2 id="people-title">People and their keys</h2>
      <p className="muted">
        Human principals of {dir.organization.name} (<code>{dir.organization.id}</code>), their capabilities
        and every key version (source: GET /v1/organization/directory, {formatUtc(dir.observedAt)}). Recovery
        delay configured on the server: {formatDelay(dir.recoveryDelayMs)}.
      </p>
      {pkg ? <RecoveryPackagePanel pkg={pkg} onHide={() => setPkg(null)} /> : null}
      <ul className="stack-list">
        {dir.principals.map((p) => {
          const self = p.id === app.me?.principal.id;
          return (
            <li key={p.id} className="principal" data-testid={`principal-${p.id}`} data-principal={p.id}>
              <h3>
                {p.displayName} {self ? <span className="small">(you)</span> : null}
              </h3>
              <IdentityList
                items={[
                  ["Principal", <code key="p">{p.id}</code>],
                  [
                    "Status",
                    <StatusBadge
                      key="s"
                      dimension="principalStatus"
                      value={p.status}
                      source="authority directory"
                      observedAt={dir.observedAt}
                      compact
                    />,
                  ],
                  [
                    "Capabilities",
                    p.capabilities.length ? p.capabilities.map(capabilityLabel).join(", ") : "None",
                  ],
                  ["Enrolled via", `${p.enrolledVia} at ${formatUtc(p.createdAt)}`],
                ]}
              />
              <KeyVersionsTable
                keys={p.keys}
                caption={`Key versions of ${p.displayName}`}
                observedAt={dir.observedAt}
                action={
                  admin
                    ? (k) =>
                        REVOCABLE.has(k.status) ? (
                          <RevokeKeyControl principal={p} keyVersion={k} trades={trades} onDone={onChanged} />
                        ) : (
                          <span className="small">No action</span>
                        )
                    : undefined
                }
              />
              {admin ? (
                self ? (
                  <p className="small">
                    A different security administrator must recover your own principal (separation of duties).
                  </p>
                ) : openRecovery.has(p.id) ? (
                  <p className="small">A recovery is already in progress for this principal.</p>
                ) : (
                  <StartRecoveryControl
                    principal={p}
                    delayMs={dir.recoveryDelayMs}
                    trades={trades}
                    onStarted={(x) => {
                      setPkg(x);
                      onChanged();
                    }}
                  />
                )
              ) : null}
            </li>
          );
        })}
      </ul>
      <h3>Recoveries</h3>
      {dir.recoveries.length === 0 ? (
        <p>No recovery has been requested in this organization.</p>
      ) : (
        <RecoveriesTable
          recoveries={dir.recoveries}
          observedAt={dir.observedAt}
          caption="Recoveries in this organization"
          principalName={nameOf}
          action={
            admin
              ? (r) =>
                  r.status === "WAITING" ? (
                    <CompleteRecoveryControl recovery={r} trades={trades} onDone={onChanged} />
                  ) : r.status === "PENDING_PROOF" ? (
                    <span className="small">Waiting for the principal's key proof</span>
                  ) : (
                    <span className="small">Closed</span>
                  )
              : undefined
          }
        />
      )}
    </section>
  );
}

function AdminSections() {
  const app = useApp();
  const [tick, setTick] = useState(0);
  const dir = useApiData(() => app.client.organizationDirectory(), [tick]);
  const bindings = useApiData(() => app.client.tradeBindings(), [tick]);
  const me = app.me;
  if (!me) return null;
  const admin = me.capabilities.includes("ORG_SECURITY_ADMIN");
  const reader = admin || me.capabilities.includes("AUDITOR");
  if (!reader)
    return (
      <Callout
        tone="neutral"
        icon="blocked"
        title="Organization key administration is not available to your role"
      >
        <p>
          Revocation, recovery and the organization directory require the Org Security Admin capability
          (Auditor may read). The server enforces this independently.
        </p>
      </Callout>
    );
  const trades = bindings.outcome?.ok ? bindings.outcome.data.trades : null;
  return (
    <>
      {dir.outcome === null ? (
        <LoadingState what="the organization directory" />
      ) : !dir.outcome.ok ? (
        <FailureState failure={dir.outcome.error} what="Organization directory" onRetry={dir.reload} />
      ) : (
        <PeoplePanel
          dir={dir.outcome.data}
          trades={trades}
          admin={admin}
          onChanged={() => setTick((x) => x + 1)}
        />
      )}
      {bindings.outcome === null ? (
        <LoadingState what="trade-binding impact" />
      ) : !bindings.outcome.ok ? (
        <FailureState
          failure={bindings.outcome.error}
          what="Trade-binding impact"
          onRetry={bindings.reload}
        />
      ) : (
        <TradeImpactPanel
          trades={bindings.outcome.data.trades}
          observedAt={bindings.outcome.data.observedAt}
        />
      )}
    </>
  );
}

export function OrganizationKeysScreen() {
  const app = useApp();
  const [rotated, setRotated] = useState<Rotated | null>(null);
  const header = (
    <>
      <PageHeader
        title="Keys and recovery"
        description="Your own key rotation, and for security administrators: people, revocation, delayed recovery and the effect on in-flight trades."
      />
      <OrgNav />
    </>
  );
  if (rotated)
    return (
      <>
        {header}
        <Callout
          tone="neutral"
          icon="active"
          title="Key rotated: sign in again with the new key"
          role="status"
          testId="rotation-done"
        >
          <p>
            Version v{rotated.version} of <code>{rotated.principalId}</code> is active and stored in this
            browser. The previous version is SUPERSEDED and its session has ended.
          </p>
          <AddressDisplay value={rotated.publicKey} label="new public key" />
          <p>
            {rotated.boundTrades === 0
              ? "No trade you could see bound the previous key."
              : `${rotated.boundTrades} trade revision${rotated.boundTrades === 1 ? "" : "s"} still bind the previous key and require a new trade revision before you can act on them.`}
          </p>
          <p>
            <Link href="/sign-in">Sign in with the new key</Link>.
          </p>
        </Callout>
      </>
    );
  if (!app.meLoaded) return <LoadingState what="your session" />;
  if (!app.me)
    return (
      <>
        {header}
        <FailureState failure={{ kind: "no-session" }} what="Keys and recovery" />
        <p>
          Lost your key or your keys were suspended? <Link href="/recovery">Recover access</Link>.
        </p>
      </>
    );
  return (
    <>
      {header}
      <MyKeysPanel onRotated={setRotated} />
      <AdminSections />
    </>
  );
}
