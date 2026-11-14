import { type FormEvent, useEffect, useRef, useState } from "react";
import { useApp, useMutationGate } from "../app/app-context";
import { Link, useRouter } from "../app/router";
import { PageHeader } from "../components/AppShell";
import { AddressDisplay, IdentityList } from "../components/Data";
import { ErrorSummary, Field, type FieldError } from "../components/Forms";
import { UiIcon } from "../components/Icon";
import { BlockedAction, Callout, FailureState } from "../components/States";
import { StatusBadge } from "../components/Status";
import type { ApiFailure, ApiOutcome, VerifiedChallenge } from "../lib/api/client";
import { isApiIdentifier } from "../lib/api/endpoints";
import type { ChallengeResponse, HumanChallengePurpose, SessionGrant } from "../lib/api/types";
import { capabilityLabel, formatUntil, formatUtc, networkLabel } from "../lib/format";
import { type DeviceKeyRecord, generateDeviceKey } from "../lib/keys";

type Flow = "bootstrap" | "login" | "invite";

interface Pending {
  readonly flow: Flow;
  readonly key: DeviceKeyRecord;
  readonly verified: VerifiedChallenge;
}

const CONSEQUENCE: Record<Flow, string> = {
  bootstrap:
    "Signing proves this browser holds the new key and makes it the security administrator key of a new organization. It grants no buyer, supplier, inspector or risk authority.",
  login:
    "Signing proves this browser still holds the enrolled key and opens a session for that principal only. Every later request is signed again by the same key.",
  invite:
    "Signing proves possession of a new key for this one-time invitation. You receive no capability until an administrator grants it in a separate session.",
};

const PURPOSE: Record<Flow, HumanChallengePurpose> = {
  bootstrap: "ORG_BOOTSTRAP",
  login: "LOGIN",
  invite: "INVITATION_ACCEPT",
};

function ChallengeReview({
  pending,
  onSign,
  onCancel,
  busy,
}: {
  pending: Pending;
  onSign: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const { now } = useApp();
  const gate = useMutationGate();
  const p = pending.verified.payload;
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);
  return (
    <section className="panel" aria-labelledby="review-title" data-testid="challenge-review">
      <h2 id="review-title" tabIndex={-1} ref={headingRef}>
        Review what you are about to sign
      </h2>
      <p className="muted">
        The browser recomputed the canonical digest from the challenge and checked the origin, purpose and key
        before showing this. Nothing is signed until you choose to sign.
      </p>
      <IdentityList
        items={[
          ["Purpose", p.purpose],
          ["Organization", p.subjectName ? `${p.subjectName} (${p.organizationId})` : p.organizationId],
          ["Principal", <code key="p">{p.principalId}</code>],
          ["Requested capability", p.requestedCapability ? capabilityLabel(p.requestedCapability) : "None"],
          ["Origin", <code key="o">{p.origin}</code>],
          ["Network", networkLabel(p.network)],
          ["Key version", String(p.keyVersion)],
          ["Expires", `${formatUtc(p.expiresAt)} (${formatUntil(p.expiresAt, now)})`],
        ]}
      />
      <h3>Device public key</h3>
      <AddressDisplay value={pending.key.publicKey} label="public key" />
      <h3>Canonical digest (dockside/pop-challenge v1)</h3>
      <AddressDisplay value={pending.verified.challenge.digestHex} label="digest" />
      <Callout tone="warning" icon="authorized" title="Consequence" headingLevel={3}>
        <p>{CONSEQUENCE[pending.flow]}</p>
      </Callout>
      <div className="btn-row">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn--primary"
          onClick={onSign}
          disabled={busy || !gate.allowed}
          aria-describedby={gate.allowed ? undefined : "sign-blocked"}
        >
          <UiIcon name="key" />
          Sign with this device key
        </button>
      </div>
      {gate.reason ? (
        <div id="sign-blocked">
          <BlockedAction reason={gate.reason} />
        </div>
      ) : null}
    </section>
  );
}

export function SignInScreen() {
  const app = useApp();
  const { navigate } = useRouter();
  const gate = useMutationGate();
  const [pending, setPending] = useState<Pending | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const [storedKeys, setStoredKeys] = useState<DeviceKeyRecord[]>([]);
  const [keyStoreError, setKeyStoreError] = useState<string | null>(null);

  const [orgName, setOrgName] = useState("");
  const [orgError, setOrgError] = useState<string | undefined>();
  const [loginKey, setLoginKey] = useState("");
  const [loginPrincipal, setLoginPrincipal] = useState("");
  const [loginErrors, setLoginErrors] = useState<FieldError[]>([]);
  const [secret, setSecret] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [inviteError, setInviteError] = useState<string | undefined>();
  const loginSummary = useRef<HTMLElement>(null);

  useEffect(() => {
    app.keys
      .list()
      .then((list) => setStoredKeys(list.filter((k) => k.principalId !== null)))
      .catch((e: unknown) => setKeyStoreError((e as Error).message));
  }, [app.keys]);

  useEffect(() => {
    const k = storedKeys[0];
    if (k && !loginKey) {
      setLoginKey(k.publicKey);
      setLoginPrincipal(k.principalId ?? "");
    }
  }, [storedKeys, loginKey]);

  async function begin(
    flow: Flow,
    key: DeviceKeyRecord,
    request: () => Promise<ApiOutcome<ChallengeResponse>>,
    subjectName?: string,
  ) {
    setFailure(null);
    setBusy(true);
    try {
      const ch = await request();
      if (!ch.ok) {
        setFailure(ch.error);
        return;
      }
      const v = await app.client.verifyChallenge(ch.data, {
        purpose: PURPOSE[flow],
        publicKey: key.publicKey,
        ...(subjectName === undefined ? {} : { subjectName }),
      });
      if (!v.ok) {
        setFailure({ kind: "refused-to-sign", reason: `The challenge was not signed: ${v.reason}.` });
        return;
      }
      setPending({ flow, key, verified: v.value });
    } finally {
      setBusy(false);
    }
  }

  async function sign() {
    if (!pending) return;
    setBusy(true);
    setFailure(null);
    try {
      const sig = await app.client.signVerified(pending.verified, pending.key.privateKey);
      const id = pending.verified.challenge.challengeId;
      let out: ApiOutcome<SessionGrant>;
      if (pending.flow === "bootstrap") out = await app.client.bootstrapComplete(id, sig);
      else if (pending.flow === "login") out = await app.client.loginComplete(id, sig);
      else out = await app.client.acceptInvitation(id, sig);
      if (!out.ok) {
        setFailure(out.error);
        setPending(null);
        return;
      }
      await app.adoptSession(out.data, pending.key);
      setPending(null);
      navigate("/organization");
    } finally {
      setBusy(false);
    }
  }

  const onBootstrap = async (e: FormEvent) => {
    e.preventDefault();
    const name = orgName.normalize("NFC").trim();
    if (name.length < 1 || name.length > 120) {
      setOrgError("Enter the organization's legal or trading name (1 to 120 characters).");
      document.getElementById("org-name")?.focus();
      return;
    }
    setOrgError(undefined);
    const key = await generateDeviceKey(`${name} security admin`, Date.now());
    await begin("bootstrap", key, () => app.client.bootstrapChallenge(name, key.publicKey), name);
  };

  const onLogin = async (e: FormEvent) => {
    e.preventDefault();
    const errs: FieldError[] = [];
    const key = storedKeys.find((k) => k.publicKey === loginKey);
    if (!key) errs.push({ fieldId: "login-key", message: "Choose a device key stored in this browser." });
    if (!isApiIdentifier(loginPrincipal.trim()))
      errs.push({
        fieldId: "login-principal",
        message: "Enter the principal ID, for example prn_ followed by 32 hex characters.",
      });
    setLoginErrors(errs);
    if (errs.length || !key) {
      requestAnimationFrame(() => loginSummary.current?.focus());
      return;
    }
    await begin("login", key, () => app.client.loginChallenge(loginPrincipal.trim(), key.publicKey));
  };

  const onInvite = async (e: FormEvent) => {
    e.preventDefault();
    const s = secret.trim();
    if (s.length < 16 || s.length > 64) {
      setInviteError("Paste the one-time invitation secret exactly as you received it.");
      document.getElementById("invite-secret")?.focus();
      return;
    }
    setInviteError(undefined);
    const key = await generateDeviceKey(displayName.trim() || "Invited principal", Date.now());
    await begin("invite", key, () =>
      app.client.invitationChallenge(s, key.publicKey, displayName.trim() || undefined),
    );
  };

  if (pending) {
    return (
      <>
        <PageHeader title="Sign challenge" description="Proof of possession for this browser's device key." />
        {failure ? <FailureState failure={failure} what="Challenge" /> : null}
        <ChallengeReview
          pending={pending}
          onSign={() => void sign()}
          onCancel={() => setPending(null)}
          busy={busy}
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Sign in"
        description="Dockside sessions are proof-of-possession: a device key held by this browser signs every request. The key cannot be exported."
      />
      {app.me ? (
        <Callout tone="neutral" icon="active" title="You are signed in">
          <p>
            Principal <code>{app.me.principal.id}</code> in organization <code>{app.me.organizationId}</code>.{" "}
            Signing in as someone else requires signing out first; a session cannot switch roles.
          </p>
          <StatusBadge
            dimension="principalStatus"
            value={app.me.principal.status}
            source="GET /v1/me"
            observedAt={app.connection.lastOkAt}
          />
        </Callout>
      ) : null}
      {failure ? <FailureState failure={failure} what="Sign-in" /> : null}
      {gate.reason ? <BlockedAction reason={gate.reason} /> : null}
      <div className="signin-layout">
        <div className="signin-main">
          <section className="panel panel--lead" aria-labelledby="bootstrap-title">
            <h2 id="bootstrap-title">Create an organization</h2>
            <p className="muted">
              Creates a new organization and its security administrator. A new device key is generated in this
              browser.
            </p>
            <form onSubmit={(e) => void onBootstrap(e)} noValidate>
              <Field
                id="org-name"
                label="Organization name"
                help="1 to 120 characters: letters, digits, spaces and . , ' & ( ) _ -"
                error={orgError}
              >
                {(aria) => (
                  <input
                    {...aria}
                    type="text"
                    autoComplete="organization"
                    value={orgName}
                    onChange={(e) => setOrgName(e.target.value)}
                    onBlur={() =>
                      setOrgError(orgName.trim() || !orgError ? undefined : "Enter the organization name.")
                    }
                  />
                )}
              </Field>
              <button type="submit" className="btn btn--primary" disabled={busy || !gate.allowed}>
                Request bootstrap challenge
              </button>
            </form>
          </section>
          <section className="panel" aria-labelledby="invite-title">
            <h2 id="invite-title">Accept an invitation</h2>
            <p className="muted">
              Use the one-time secret your administrator gave you. Acceptance happens in your own session; the
              capability is granted later by the administrator.
            </p>
            <form onSubmit={(e) => void onInvite(e)} noValidate>
              <Field
                id="invite-secret"
                label="Invitation secret"
                help="Paste is allowed. The secret is sent once and never stored by this browser."
                error={inviteError}
              >
                {(aria) => (
                  <input
                    {...aria}
                    type="text"
                    className="mono"
                    autoComplete="one-time-code"
                    spellCheck={false}
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                  />
                )}
              </Field>
              <Field id="invite-name" label="Your display name (optional)" help="Shown to your organization.">
                {(aria) => (
                  <input
                    {...aria}
                    type="text"
                    autoComplete="name"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                  />
                )}
              </Field>
              <button type="submit" className="btn btn--primary" disabled={busy || !gate.allowed}>
                Request invitation challenge
              </button>
            </form>
          </section>
        </div>
        <div className="signin-aside">
          <section className="panel enforce" aria-labelledby="enforce-title">
            <h2 id="enforce-title">What the escrow enforces</h2>
            <p className="muted">
              Each trade binds these rules into the agreement both parties sign; the API and the escrow
              contract refuse anything else.
            </p>
            <ol className="enforce__list">
              <li>
                <h3>The payout account is fixed</h3>
                <p>
                  Changing the supplier&apos;s destination needs a new revision, consent from buyer and
                  supplier, and an activation delay the contract enforces.
                </p>
              </li>
              <li>
                <h3>No release before inspection</h3>
                <p>
                  Funds move only after the evidence policy is complete and attested, the named inspector
                  records PASS and the buyer approves.
                </p>
              </li>
              <li>
                <h3>Refunds go back to the funder</h3>
                <p>
                  A refund returns to the original funding account from its exact source bucket, never to a
                  new address.
                </p>
              </li>
            </ol>
          </section>
          <section className="panel" aria-labelledby="login-title">
            <h2 id="login-title">Sign in with a stored device key</h2>
            {keyStoreError ? (
              <Callout tone="warning" icon="blocked" title="Key storage unavailable" headingLevel={3}>
                <p>This browser blocked key storage ({keyStoreError}). Use a regular browser profile.</p>
              </Callout>
            ) : storedKeys.length === 0 ? (
              <p className="muted" data-testid="no-stored-keys">
                No enrolled device key is stored in this browser. Create an organization or accept an
                invitation first; lost keys are replaced only through administrator recovery.
              </p>
            ) : (
              <form onSubmit={(e) => void onLogin(e)} noValidate>
                <ErrorSummary errors={loginErrors} ref={loginSummary} />
                <Field id="login-key" label="Device key" help="Keys enrolled from this browser.">
                  {(aria) => (
                    <select
                      {...aria}
                      value={loginKey}
                      onChange={(e) => {
                        setLoginKey(e.target.value);
                        const k = storedKeys.find((x) => x.publicKey === e.target.value);
                        if (k?.principalId) setLoginPrincipal(k.principalId);
                      }}
                    >
                      {storedKeys.map((k) => (
                        <option key={k.publicKey} value={k.publicKey}>
                          {k.label} — {k.publicKey.slice(0, 18)}…
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                <Field
                  id="login-principal"
                  label="Principal ID"
                  help="prn_ followed by 32 hex characters."
                  error={loginErrors.find((x) => x.fieldId === "login-principal")?.message}
                >
                  {(aria) => (
                    <input
                      {...aria}
                      type="text"
                      className="mono"
                      spellCheck={false}
                      value={loginPrincipal}
                      onChange={(e) => setLoginPrincipal(e.target.value)}
                    />
                  )}
                </Field>
                <button type="submit" className="btn btn--primary" disabled={busy || !gate.allowed}>
                  Request sign-in challenge
                </button>
              </form>
            )}
          </section>
          <section className="panel" aria-labelledby="recover-title">
            <h2 id="recover-title">Lost or suspended key</h2>
            <p className="muted">
              A lost key is replaced only through a delayed recovery started by a security administrator of
              your organization. You prove the new key from your own device, or veto a recovery you did not
              ask for.
            </p>
            <p>
              <Link href="/recovery">Recover access</Link>
            </p>
          </section>
          <section className="panel" aria-labelledby="wallet-title">
            <h2 id="wallet-title">NEAR wallet signature (NEP-413)</h2>
            <StatusBadge
              dimension="productGate"
              value="BLOCKED"
              source="this web build"
              observedAt={null}
              reason="The API accepts NEP-413 wallet proofs, but no wallet connector is bundled in this web build yet."
            />
          </section>
        </div>
      </div>
    </>
  );
}
