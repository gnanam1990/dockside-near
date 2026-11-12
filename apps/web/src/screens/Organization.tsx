import { type FormEvent, useEffect, useState } from "react";
import { useApp, useMutationGate } from "../app/app-context";
import { Link } from "../app/router";
import { PageHeader } from "../components/AppShell";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { AddressDisplay, IdentityList, TableScroller } from "../components/Data";
import { Field } from "../components/Forms";
import { BlockedAction, Callout, FailureState, LoadingState } from "../components/States";
import { StatusBadge } from "../components/Status";
import type { ApiFailure } from "../lib/api/client";
import { isApiIdentifier } from "../lib/api/endpoints";
import {
  HUMAN_CAPABILITIES,
  type HumanCapability,
  type InvitationCreated,
  type RoleGrantView,
  type ServiceEnrollmentView,
} from "../lib/api/types";
import { capabilityLabel, formatUntil, formatUtc } from "../lib/format";
import type { DeviceKeyRecord } from "../lib/keys";
import { OrgNav } from "./org/common";

function InvitePanel() {
  const app = useApp();
  const gate = useMutationGate();
  const [capability, setCapability] = useState<HumanCapability>("BUYER_APPROVER");
  const [created, setCreated] = useState<InvitationCreated | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFailure(null);
    const out = await app.client.createInvitation(capability);
    setBusy(false);
    if (out.ok) setCreated(out.data);
    else setFailure(out.error);
  };
  return (
    <section className="panel" aria-labelledby="invite-panel-title">
      <h2 id="invite-panel-title">Invite a principal</h2>
      <p className="muted">
        Creates a one-time, expiring invitation for one capability. The recipient accepts in their own browser
        session; you grant the capability afterwards.
      </p>
      <form onSubmit={(e) => void onSubmit(e)}>
        <Field
          id="invite-capability"
          label="Capability"
          help="Party capabilities cannot be combined on one principal."
        >
          {(aria) => (
            <select
              {...aria}
              value={capability}
              onChange={(e) => setCapability(e.target.value as HumanCapability)}
            >
              {HUMAN_CAPABILITIES.map((c) => (
                <option key={c} value={c}>
                  {capabilityLabel(c)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <button type="submit" className="btn btn--primary" disabled={busy || !gate.allowed}>
          Create invitation
        </button>
        {gate.reason ? <BlockedAction reason={gate.reason} /> : null}
      </form>
      {failure ? <FailureState failure={failure} what="Invitation" headingLevel={3} /> : null}
      {created ? (
        <div className="secret-once" data-testid="invitation-created">
          <h3>Invitation created — the secret is shown only once</h3>
          <p>
            Send the secret to the intended person over a trusted channel. It is not stored by this browser
            and cannot be shown again.
          </p>
          <IdentityList
            items={[
              ["Invitation ID", <code key="i">{created.invitationId}</code>],
              ["Capability", capabilityLabel(created.capability)],
              ["Organization", <code key="o">{created.organizationId}</code>],
              ["Expires", `${formatUtc(created.expiresAt)} (${formatUntil(created.expiresAt, app.now)})`],
            ]}
          />
          <h4>One-time secret</h4>
          <AddressDisplay value={created.secret} label="invitation secret" />
          <button type="button" className="btn" onClick={() => setCreated(null)}>
            I have sent it — hide the secret
          </button>
        </div>
      ) : null}
    </section>
  );
}

function GrantPanel() {
  const app = useApp();
  const gate = useMutationGate();
  const [invitationId, setInvitationId] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [confirming, setConfirming] = useState(false);
  const [granted, setGranted] = useState<RoleGrantView | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!isApiIdentifier(invitationId.trim())) {
      setError("Enter the invitation ID (inv_ followed by 32 hex characters).");
      document.getElementById("grant-invitation")?.focus();
      return;
    }
    setError(undefined);
    setConfirming(true);
  };
  const confirm = async () => {
    setConfirming(false);
    setFailure(null);
    const out = await app.client.grantInvitation(invitationId.trim());
    if (out.ok) setGranted(out.data);
    else setFailure(out.error);
  };
  return (
    <section className="panel" aria-labelledby="grant-panel-title">
      <h2 id="grant-panel-title">Grant an accepted invitation</h2>
      <p className="muted">
        Grants the invited capability to the principal who accepted it. Must be a different principal and
        session from the recipient.
      </p>
      <form onSubmit={onSubmit} noValidate>
        <Field
          id="grant-invitation"
          label="Invitation ID"
          help="inv_ followed by 32 hex characters."
          error={error}
        >
          {(aria) => (
            <input
              {...aria}
              type="text"
              className="mono"
              spellCheck={false}
              value={invitationId}
              onChange={(e) => setInvitationId(e.target.value)}
            />
          )}
        </Field>
        <button type="submit" className="btn btn--primary" disabled={!gate.allowed}>
          Review grant
        </button>
      </form>
      <ConfirmDialog
        open={confirming}
        title="Grant capability"
        confirmLabel="Grant capability"
        onCancel={() => setConfirming(false)}
        onConfirm={() => void confirm()}
      >
        <p>
          Invitation <code>{invitationId.trim()}</code> will give its accepted principal the capability it was
          issued for, in organization <code>{app.me?.organizationId}</code>. This is recorded in the audit
          log. Revoking it later needs a separate key or capability action.
        </p>
      </ConfirmDialog>
      {failure ? <FailureState failure={failure} what="Grant" headingLevel={3} /> : null}
      {granted ? (
        <Callout tone="neutral" icon="authorized" title="Capability granted" headingLevel={3} role="status">
          <p>
            {capabilityLabel(granted.capability)} granted to <code>{granted.principalId}</code> at{" "}
            {formatUtc(granted.createdAt)} (grant <code>{granted.id}</code>).
          </p>
        </Callout>
      ) : null}
    </section>
  );
}

function ServiceLookupPanel() {
  const app = useApp();
  const [id, setId] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [view, setView] = useState<ServiceEnrollmentView | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!isApiIdentifier(id.trim())) {
      setError("Enter an enrollment ID (prefix_ followed by 32 hex characters).");
      return;
    }
    setError(undefined);
    setFailure(null);
    const out = await app.client.getServiceEnrollment(id.trim());
    if (out.ok) setView(out.data);
    else {
      setView(null);
      setFailure(out.error);
    }
  };
  return (
    <section className="panel" aria-labelledby="svc-title">
      <h2 id="svc-title">Service identities (ManifestAttestor, deterministic policy)</h2>
      <p className="muted">
        Look up an enrolled service by ID. Private keys stay in isolated custody and are never shown; only
        public key, version, capability, scope and status are displayed.
      </p>
      <form onSubmit={(e) => void onSubmit(e)} noValidate>
        <Field id="svc-id" label="Enrollment ID" error={error}>
          {(aria) => (
            <input
              {...aria}
              type="text"
              className="mono"
              spellCheck={false}
              value={id}
              onChange={(e) => setId(e.target.value)}
            />
          )}
        </Field>
        <button type="submit" className="btn">
          Look up enrollment
        </button>
      </form>
      {failure ? <FailureState failure={failure} what="Service enrollment" headingLevel={3} /> : null}
      {view ? (
        <IdentityList
          items={Object.entries(view)
            .filter(([k]) => !/secret|private|reference|seed/i.test(k))
            .map(([k, v]) => [
              k,
              <code key={k}>{typeof v === "object" ? JSON.stringify(v) : String(v)}</code>,
            ])}
        />
      ) : null}
    </section>
  );
}

function DeviceKeysPanel() {
  const app = useApp();
  const [keys, setKeys] = useState<DeviceKeyRecord[] | null>(null);
  useEffect(() => {
    app.keys
      .list()
      .then(setKeys)
      .catch(() => setKeys([]));
  }, [app.keys]);
  return (
    <section className="panel" aria-labelledby="device-keys-title">
      <h2 id="device-keys-title">Device keys in this browser</h2>
      <p className="muted">
        Stored locally as non-exportable WebCrypto keys. This list is local to this browser profile and is not
        authority; the server decides which keys are active.
      </p>
      {keys === null ? (
        <LoadingState what="device keys" />
      ) : keys.length === 0 ? (
        <p>No device keys stored.</p>
      ) : (
        <TableScroller label="Device keys stored in this browser">
          <table>
            <caption>Device keys stored in this browser</caption>
            <thead>
              <tr>
                <th scope="col">Label</th>
                <th scope="col">Public key</th>
                <th scope="col">Principal</th>
                <th scope="col">Created</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.publicKey}>
                  <td>{k.label}</td>
                  <td className="mono">{k.publicKey}</td>
                  <td className="mono">{k.principalId ?? "not enrolled"}</td>
                  <td className="mono">{formatUtc(k.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>
      )}
    </section>
  );
}

export function OrganizationScreen() {
  const app = useApp();
  const me = app.me;
  if (!app.meLoaded) return <LoadingState what="your session" />;
  if (!me) {
    return (
      <>
        <PageHeader title="Organization" />
        <FailureState failure={{ kind: "no-session" }} what="Organization" />
      </>
    );
  }
  const isAdmin = me.capabilities.includes("ORG_SECURITY_ADMIN");
  return (
    <>
      <PageHeader
        title="Organization"
        description="People, keys and service identities for your organization, as reported by the API."
      />
      <OrgNav />
      <section className="panel" aria-labelledby="me-title" data-testid="me-panel">
        <h2 id="me-title">Your principal and session</h2>
        <IdentityList
          items={[
            ["Organization ID", <code key="o">{me.organizationId}</code>],
            ["Principal", <code key="p">{me.principal.id}</code>],
            ["Display name", me.principal.displayName],
            [
              "Principal status",
              <StatusBadge
                key="s"
                dimension="principalStatus"
                value={me.principal.status}
                source="GET /v1/me"
                observedAt={app.connection.lastOkAt}
              />,
            ],
            [
              "Capabilities",
              me.capabilities.length ? me.capabilities.map(capabilityLabel).join(", ") : "None granted yet",
            ],
            [
              "Session expires",
              `${formatUtc(me.session.expiresAt)} (${formatUntil(me.session.expiresAt, app.now)})`,
            ],
            [
              "Key status",
              <StatusBadge
                key="k"
                dimension="keyStatus"
                value={me.keyVersion.status}
                source="GET /v1/me"
                observedAt={app.connection.lastOkAt}
              />,
            ],
            ["Key version", `v${me.keyVersion.version} (${me.keyVersion.id})`],
          ]}
        />
        <h3>Session public key</h3>
        <AddressDisplay value={me.keyVersion.publicKey} label="public key" />
      </section>
      {isAdmin ? (
        <div className="panel-grid">
          <InvitePanel />
          <GrantPanel />
          <ServiceLookupPanel />
        </div>
      ) : (
        <Callout tone="neutral" icon="blocked" title="Administration is not available to your role">
          <p>
            Invitations, grants and service enrollment require the Org Security Admin capability, which this
            session does not hold. The server enforces this independently.
          </p>
        </Callout>
      )}
      <DeviceKeysPanel />
      <Callout tone="neutral" icon="not-run" title="Not yet wired in this build">
        <p>
          Key rotation, recovery, revocation and service enrollment are under{" "}
          <Link href="/organization/keys">Keys and recovery</Link> and{" "}
          <Link href="/organization/services">Service identities</Link>. Policy, retention and integration
          settings are not served by this API build.
        </p>
      </Callout>
    </>
  );
}
