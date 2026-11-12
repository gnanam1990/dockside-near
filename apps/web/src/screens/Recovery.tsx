import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useApp, useMutationGate } from "../app/app-context";
import { Link } from "../app/router";
import { PageHeader } from "../components/AppShell";
import { AddressDisplay, IdentityList } from "../components/Data";
import { Field } from "../components/Forms";
import { BlockedAction, Callout, FailureState } from "../components/States";
import type { ApiFailure, VerifiedChallenge } from "../lib/api/client";
import { isApiIdentifier } from "../lib/api/endpoints";
import type { RecoveryPackage } from "../lib/api/types";
import { fromTypedJson } from "../lib/canonical";
import { formatUtc } from "../lib/format";
import { type DeviceKeyRecord, generateDeviceKey } from "../lib/keys";
import { ChallengeReviewPanel } from "./org/common";

const RECOVERY_LABEL = "Recovery key";

interface Pending {
  readonly kind: "prove" | "veto";
  readonly key: DeviceKeyRecord;
  readonly verified: VerifiedChallenge;
  readonly notBefore: number | null;
}

/** The principal's own side of a recovery: a new key, its proof, or a veto with the existing key. */
export function RecoveryScreen() {
  const app = useApp();
  const gate = useMutationGate();
  const [keys, setKeys] = useState<DeviceKeyRecord[]>([]);
  const [storeError, setStoreError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<DeviceKeyRecord | null>(null);
  const [pkgText, setPkgText] = useState("");
  const [pkgError, setPkgError] = useState<string | undefined>();
  const [vetoKey, setVetoKey] = useState("");
  const [vetoId, setVetoId] = useState("");
  const [vetoError, setVetoError] = useState<string | undefined>();
  const [pending, setPending] = useState<Pending | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [done, setDone] = useState<{ title: string; body: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const reloadKeys = useCallback(() => {
    app.keys
      .list()
      .then(setKeys)
      .catch((e: unknown) => setStoreError((e as Error).message));
  }, [app.keys]);
  useEffect(reloadKeys, [reloadKeys]);
  const enrolled = keys.filter((k) => k.principalId !== null);
  useEffect(() => {
    const first = enrolled[0];
    if (first && !vetoKey) setVetoKey(first.publicKey);
  }, [enrolled, vetoKey]);

  const generate = async () => {
    setFailure(null);
    const k = await generateDeviceKey(`${RECOVERY_LABEL} ${formatUtc(Date.now())}`, Date.now());
    await app.keys.put(k);
    setFresh(k);
    reloadKeys();
  };

  const onPackage = async (e: FormEvent) => {
    e.preventDefault();
    setFailure(null);
    setDone(null);
    let pkg: RecoveryPackage;
    let named: string;
    try {
      pkg = JSON.parse(pkgText.trim()) as RecoveryPackage;
      if (pkg.schema !== "dockside/recovery-package@1") throw new Error("not a recovery package");
      const payload = fromTypedJson(pkg.challenge.payload) as unknown as {
        publicKey: string;
        recoveryId: string | null;
        principalId: string;
      };
      if (payload.recoveryId !== pkg.recoveryId || payload.principalId !== pkg.principalId)
        throw new Error("the package and its challenge disagree");
      named = payload.publicKey;
    } catch (err) {
      setPkgError(
        `Paste the recovery package exactly as your administrator gave it (${(err as Error).message}).`,
      );
      document.getElementById("recovery-package-input")?.focus();
      return;
    }
    const key = keys.find((k) => k.publicKey === named);
    if (!key) {
      setPkgError(
        "The package names a key that is not stored in this browser. Prove it on the device that generated the recovery key.",
      );
      document.getElementById("recovery-package-input")?.focus();
      return;
    }
    setPkgError(undefined);
    const v = await app.client.verifyChallenge(pkg.challenge, {
      purpose: "RECOVERY_KEY",
      publicKey: key.publicKey,
    });
    if (!v.ok) {
      setFailure({ kind: "refused-to-sign", reason: `The recovery challenge was not signed: ${v.reason}.` });
      return;
    }
    setPending({ kind: "prove", key, verified: v.value, notBefore: pkg.notBefore });
  };

  const onVeto = async (e: FormEvent) => {
    e.preventDefault();
    setFailure(null);
    setDone(null);
    const key = enrolled.find((k) => k.publicKey === vetoKey);
    if (!key || !isApiIdentifier(vetoId.trim()) || !vetoId.trim().startsWith("rec_")) {
      setVetoError(
        "Choose your existing key and enter the recovery ID (rec_ followed by 32 hex characters).",
      );
      document.getElementById("veto-recovery-id")?.focus();
      return;
    }
    setVetoError(undefined);
    setBusy(true);
    try {
      const ch = await app.client.recoveryCancelChallenge(vetoId.trim());
      if (!ch.ok) {
        setFailure(ch.error);
        return;
      }
      const v = await app.client.verifyChallenge(ch.data, {
        purpose: "RECOVERY_CANCEL",
        publicKey: key.publicKey,
      });
      if (!v.ok) {
        setFailure({ kind: "refused-to-sign", reason: `The veto challenge was not signed: ${v.reason}.` });
        return;
      }
      setPending({ kind: "veto", key, verified: v.value, notBefore: null });
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
      const id = pending.verified.challenge.challengeId;
      const p = pending.verified.payload;
      if (pending.kind === "prove") {
        const out = await app.client.proveRecovery(id, sig);
        if (!out.ok) {
          setFailure(out.error);
          setPending(null);
          return;
        }
        // The server confirmed the proof for this principal: record the binding locally.
        await app.keys.put({ ...pending.key, principalId: p.principalId, organizationId: p.organizationId });
        setDone({
          title: "Recovery key proven",
          body: `Recovery ${out.data.recoveryId} is ${out.data.status}. A security administrator can complete it after ${formatUtc(pending.notBefore ?? 0)}; then sign in with this key as principal ${p.principalId}.`,
        });
      } else {
        const out = await app.client.cancelRecovery(id, sig);
        if (!out.ok) {
          setFailure(out.error);
          setPending(null);
          return;
        }
        setDone({
          title: "Recovery vetoed",
          body: `Recovery ${out.data.recoveryId} is ${out.data.status}. Your previous keys are restored and the recovery key is revoked.`,
        });
      }
      setPending(null);
      setPkgText("");
      setVetoId("");
      reloadKeys();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Recover access"
        description="For a principal whose key was lost or suspended: generate a new device key, prove it with the package your administrator gives you, or veto a recovery you did not ask for."
      />
      {failure ? <FailureState failure={failure} what="Recovery" /> : null}
      {done ? (
        <Callout tone="neutral" icon="pending" title={done.title} role="status" testId="recovery-done">
          <p>{done.body}</p>
          <p>
            <Link href="/sign-in">Go to sign in</Link>.
          </p>
        </Callout>
      ) : null}
      {gate.reason ? <BlockedAction reason={gate.reason} /> : null}
      {storeError ? (
        <Callout tone="warning" icon="blocked" title="Key storage unavailable">
          <p>This browser blocked key storage ({storeError}). Use a regular browser profile.</p>
        </Callout>
      ) : null}
      {pending ? (
        <ChallengeReviewPanel
          verified={pending.verified}
          publicKey={pending.key.publicKey}
          signLabel={pending.kind === "prove" ? "Sign recovery proof" : "Sign veto with my existing key"}
          onSign={() => void sign()}
          onCancel={() => setPending(null)}
          busy={busy}
          testId="recovery-review"
        />
      ) : (
        <div className="panel-grid">
          <section className="panel" aria-labelledby="gen-title" data-testid="recovery-key-panel">
            <h2 id="gen-title">1. Generate a recovery key on this device</h2>
            <p className="muted">
              A new non-extractable key is generated and stored only in this browser. Give its public key to a
              security administrator of your organization over a trusted channel; it carries no secret.
            </p>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void generate()}
              disabled={busy}
            >
              Generate recovery key
            </button>
            {fresh ? (
              <div data-testid="recovery-public-key">
                <h3>Public key to give your administrator</h3>
                <AddressDisplay value={fresh.publicKey} label="recovery public key" />
              </div>
            ) : null}
          </section>
          <section className="panel" aria-labelledby="prove-title">
            <h2 id="prove-title">2. Prove the recovery key</h2>
            <p className="muted">
              Paste the recovery package your administrator gave you. The browser checks that it names a key
              stored here, recomputes the digest and shows exactly what you sign. Proving does not activate
              the key: the recovery delay still runs.
            </p>
            <form onSubmit={(e) => void onPackage(e)} noValidate>
              <Field
                id="recovery-package-input"
                label="Recovery package from your administrator"
                help="Paste is allowed. It contains no secret."
                error={pkgError}
              >
                {(aria) => (
                  <textarea
                    {...aria}
                    className="mono"
                    rows={4}
                    spellCheck={false}
                    value={pkgText}
                    onChange={(e) => setPkgText(e.target.value)}
                  />
                )}
              </Field>
              <button type="submit" className="btn btn--primary" disabled={busy || !gate.allowed}>
                Review recovery proof
              </button>
            </form>
          </section>
          <section className="panel" aria-labelledby="veto-title">
            <h2 id="veto-title">Veto a recovery you did not ask for</h2>
            <p className="muted">
              While a recovery is waiting, the principal can cancel it by signing with an existing key stored
              in this browser. The prior keys are restored and the recovery key is revoked.
            </p>
            {enrolled.length === 0 ? (
              <p data-testid="no-veto-keys">No enrolled key is stored in this browser.</p>
            ) : (
              <form onSubmit={(e) => void onVeto(e)} noValidate>
                <Field id="veto-key" label="Your existing key">
                  {(aria) => (
                    <select {...aria} value={vetoKey} onChange={(e) => setVetoKey(e.target.value)}>
                      {enrolled.map((k) => (
                        <option key={k.publicKey} value={k.publicKey}>
                          {k.label} — {k.publicKey.slice(0, 18)}…
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                <Field
                  id="veto-recovery-id"
                  label="Recovery ID"
                  help="rec_ followed by 32 hex characters, from your administrator or the audit log."
                  error={vetoError}
                >
                  {(aria) => (
                    <input
                      {...aria}
                      type="text"
                      className="mono"
                      spellCheck={false}
                      value={vetoId}
                      onChange={(e) => setVetoId(e.target.value)}
                    />
                  )}
                </Field>
                <button type="submit" className="btn" disabled={busy || !gate.allowed}>
                  Review veto
                </button>
              </form>
            )}
          </section>
        </div>
      )}
      {keys.length ? (
        <section className="panel" aria-labelledby="stored-title">
          <h2 id="stored-title">Keys stored in this browser</h2>
          <IdentityList
            items={keys.map((k) => [
              k.label,
              <code key={k.publicKey} className="wrap">
                {k.publicKey} {k.principalId ? `(principal ${k.principalId})` : "(not yet proven)"}
              </code>,
            ])}
          />
        </section>
      ) : null}
    </>
  );
}
