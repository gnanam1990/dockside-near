import { type FormEvent, useState } from "react";
import { useApiData, useApp, useMutationGate } from "../../app/app-context";
import { PageHeader } from "../../components/AppShell";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { AddressDisplay, IdentityList } from "../../components/Data";
import { ErrorSummary, Field, type FieldError } from "../../components/Forms";
import { BlockedAction, Callout, FailureState, LoadingState } from "../../components/States";
import { StatusBadge } from "../../components/Status";
import type { ApiFailure, Custody, VerifiedServiceChallenge } from "../../lib/api/client";
import {
  type DirectoryService,
  SERVICE_CAPABILITIES,
  type ServiceCapability,
  type ServiceChallengePurpose,
  type ServiceChallengeResponse,
  type TradeBindingImpact,
} from "../../lib/api/types";
import { capabilityLabel, formatUntil, formatUtc, networkLabel } from "../../lib/format";
import { PUBLIC_KEY } from "./Keys";
import {
  AffectedTrades,
  formatDelay,
  KeyVersionsTable,
  OrgNav,
  REVISION_CONSEQUENCE,
  REVOKE_REASONS,
  rolesBinding,
  TradeImpactPanel,
} from "./common";

const CUSTODY_KINDS = [
  ["ISOLATED_SIGNER_PROCESS", "Isolated signer process"],
  ["HSM", "Hardware security module"],
  ["KMS", "Key management service"],
] as const;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const LOCATOR = /^[A-Za-z0-9][A-Za-z0-9:/._@-]{0,127}$/;
const TRADE_ID = /^trd_[0-9a-f]{32}$/;
const REVOCABLE = new Set(["ACTIVE", "PENDING_PROOF", "PENDING_ACTIVATION", "SUSPENDED"]);

const CAPABILITY_HELP: Record<string, string> = {
  MANIFEST_ATTEST: "Signs ManifestAttestations over complete evidence manifests for its scope only.",
  DETERMINISTIC_POLICY_SET: "Sets HoldRecords from deterministic rules; it can never resolve a hold.",
  EXECUTOR: "Submits prepared release calls; it holds no party authority.",
};

/** A pending service PoP challenge, verified by the browser, waiting for the custody's signature. */
interface PendingProof {
  readonly enrollmentId: string;
  readonly serviceId: string;
  readonly keyVersion: number;
  readonly verified: VerifiedServiceChallenge;
}

/* --------------------------------- custody fields --------------------------------- */

/**
 * New public key plus custody kind and locator. The locator is write-only: it is sent once and
 * never displayed again (the API never serves it back).
 */
function CustodyFields({
  prefix,
  publicKey,
  setPublicKey,
  kind,
  setKind,
  locator,
  setLocator,
  errors,
}: {
  prefix: string;
  publicKey: string;
  setPublicKey: (v: string) => void;
  kind: string;
  setKind: (v: string) => void;
  locator: string;
  setLocator: (v: string) => void;
  errors: FieldError[];
}) {
  const err = (id: string) => errors.find((e) => e.fieldId === id)?.message;
  return (
    <>
      <Field
        id={`${prefix}-pk`}
        label="Service public key"
        help="From the custody operator: the private key is created inside custody and never leaves it."
        error={err(`${prefix}-pk`)}
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
      <Field id={`${prefix}-kind`} label="Custody kind">
        {(aria) => (
          <select {...aria} value={kind} onChange={(e) => setKind(e.target.value)}>
            {CUSTODY_KINDS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field
        id={`${prefix}-locator`}
        label="Custody locator (write-only)"
        help="An opaque pointer such as signer://attestor/k2 or hsm://slot-7/attestor. Sent once, never shown again; never key material."
        error={err(`${prefix}-locator`)}
      >
        {(aria) => (
          <input
            {...aria}
            type="password"
            className="mono"
            spellCheck={false}
            autoComplete="off"
            value={locator}
            onChange={(e) => setLocator(e.target.value)}
          />
        )}
      </Field>
    </>
  );
}

function custodyErrors(prefix: string, publicKey: string, locator: string): FieldError[] {
  const out: FieldError[] = [];
  if (!PUBLIC_KEY.test(publicKey.trim()))
    out.push({
      fieldId: `${prefix}-pk`,
      message: "Enter the service public key (ed25519: followed by base58).",
    });
  if (!LOCATOR.test(locator.trim()))
    out.push({
      fieldId: `${prefix}-locator`,
      message: "Enter the custody locator: letters, digits and : / . _ @ - only, up to 128 characters.",
    });
  return out;
}

/* ------------------------------- service PoP proof ------------------------------- */

const PURPOSE_TEXT: Record<string, string> = {
  SERVICE_ENROLL: "Enrollment of a new service identity, version 1.",
  SERVICE_ROTATE: "Rotation: a new version that supersedes the active one when activated.",
  SERVICE_RECOVER:
    "Recovery: the current versions are already suspended; the new version activates only after the recovery delay.",
};

function ServiceProofPanel({
  pending,
  onProved,
  onCancel,
}: {
  pending: PendingProof;
  onProved: () => void;
  onCancel: () => void;
}) {
  const app = useApp();
  const gate = useMutationGate();
  const [signature, setSignature] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const p = pending.verified.payload;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature.trim())) {
      setError("Paste the custody's Ed25519 signature (ed25519: followed by base58).");
      document.getElementById("svc-proof-signature")?.focus();
      return;
    }
    setError(undefined);
    setBusy(true);
    setFailure(null);
    const out = await app.client.proveServiceKey(pending.verified.challenge.challengeId, signature.trim());
    setBusy(false);
    if (!out.ok) setFailure(out.error);
    else onProved();
  };
  return (
    <section className="panel review" aria-labelledby="svc-proof-title" data-testid="service-proof">
      <h3 id="svc-proof-title">Proof of possession by the service's custody</h3>
      <p>
        The browser recomputed the canonical digest (dockside/service-pop-challenge v1) and checked origin,
        purpose, enrollment, key and version. <strong>The browser never signs a service challenge</strong>:
        hand the challenge to the custody operator, who signs it inside custody and returns only the
        signature.
      </p>
      <IdentityList
        items={[
          ["Purpose", `${p.purpose}: ${PURPOSE_TEXT[p.purpose] ?? ""}`],
          ["Enrollment", <code key="e">{p.enrollmentId}</code>],
          ["Service", <code key="s">{p.serviceId}</code>],
          ["Capability", capabilityLabel(p.capability)],
          [
            "Scope",
            `organization ${p.scope.organizationId}, ${p.scope.tradeId ? `trade ${p.scope.tradeId}` : "every trade"}, EvidencePolicy ${p.scope.evidencePolicyId} revision ${p.scope.evidencePolicyRevision}`,
          ],
          ["Key version", `v${p.keyVersion}`],
          ["Custody kind", p.custodyKind ?? "not recorded"],
          ["Network", networkLabel(p.network)],
          ["Expires", `${formatUtc(p.expiresAt)} (${formatUntil(p.expiresAt, app.now)})`],
        ]}
      />
      <h4>Public key being proven</h4>
      <AddressDisplay value={p.publicKey} label="service public key" />
      <h4>Digest</h4>
      <AddressDisplay value={pending.verified.challenge.digestHex} label="digest" />
      <h4>Challenge for the custody operator</h4>
      <AddressDisplay
        value={JSON.stringify({ challenge: pending.verified.challenge })}
        label="service challenge"
      />
      <form onSubmit={(e) => void submit(e)} noValidate>
        <Field
          id="svc-proof-signature"
          label="Signature returned by the custody"
          help="Paste is allowed. The server verifies it against the public key above."
          error={error}
        >
          {(aria) => (
            <input
              {...aria}
              type="text"
              className="mono"
              spellCheck={false}
              autoComplete="off"
              value={signature}
              onChange={(e) => setSignature(e.target.value)}
            />
          )}
        </Field>
        <div className="btn-row">
          <button type="button" className="btn" onClick={onCancel}>
            Close
          </button>
          <button type="submit" className="btn btn--primary" disabled={busy || !gate.allowed}>
            Submit custody proof
          </button>
        </div>
      </form>
      {failure ? <FailureState failure={failure} what="Service key proof" headingLevel={3} /> : null}
    </section>
  );
}

async function verifyOrRefuse(
  app: ReturnType<typeof useApp>,
  challenge: ServiceChallengeResponse,
  expect: { purpose: ServiceChallengePurpose; enrollmentId?: string; keyVersion: number; publicKey: string },
  serviceId: string,
): Promise<{ ok: true; pending: PendingProof } | { ok: false; failure: ApiFailure }> {
  const v = await app.client.verifyServiceChallenge(challenge, {
    purpose: expect.purpose,
    publicKey: expect.publicKey,
    keyVersion: expect.keyVersion,
    ...(expect.enrollmentId === undefined ? {} : { enrollmentId: expect.enrollmentId }),
  });
  if (!v.ok)
    return {
      ok: false,
      failure: { kind: "refused-to-sign", reason: `The service challenge was refused: ${v.reason}.` },
    };
  return {
    ok: true,
    pending: {
      enrollmentId: v.value.payload.enrollmentId,
      serviceId,
      keyVersion: v.value.payload.keyVersion,
      verified: v.value,
    },
  };
}

/* ------------------------------------ enroll ------------------------------------ */

function EnrollServicePanel({ onCreated }: { onCreated: (p: PendingProof) => void }) {
  const app = useApp();
  const gate = useMutationGate();
  const [serviceId, setServiceId] = useState("");
  const [capability, setCapability] = useState<ServiceCapability>("MANIFEST_ATTEST");
  const [tradeId, setTradeId] = useState("");
  const [policyId, setPolicyId] = useState("");
  const [policyRevision, setPolicyRevision] = useState("1");
  const [publicKey, setPublicKey] = useState("");
  const [kind, setKind] = useState<string>("ISOLATED_SIGNER_PROCESS");
  const [locator, setLocator] = useState("");
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const err = (id: string) => errors.find((e) => e.fieldId === id)?.message;
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const errs: FieldError[] = [];
    if (!SLUG.test(serviceId.trim()))
      errs.push({
        fieldId: "enroll-service-id",
        message: "Enter a service ID: lowercase letters, digits and -.",
      });
    if (tradeId.trim() && !TRADE_ID.test(tradeId.trim()))
      errs.push({
        fieldId: "enroll-trade",
        message: "Leave empty for every trade, or enter trd_ and 32 hex characters.",
      });
    if (!SLUG.test(policyId.trim()))
      errs.push({
        fieldId: "enroll-policy",
        message: "Enter the EvidencePolicy ID the service is scoped to.",
      });
    const rev = Number(policyRevision);
    if (!Number.isSafeInteger(rev) || rev < 1)
      errs.push({
        fieldId: "enroll-policy-revision",
        message: "Enter the EvidencePolicy revision (1 or more).",
      });
    errs.push(...custodyErrors("enroll", publicKey, locator));
    setErrors(errs);
    if (errs.length) {
      requestAnimationFrame(() => document.getElementById("enroll-errors")?.focus());
      return;
    }
    setConfirming(true);
  };
  const confirm = async () => {
    setConfirming(false);
    setFailure(null);
    const custody: Custody = { kind, reference: locator.trim() };
    const out = await app.client.createServiceEnrollment({
      serviceId: serviceId.trim(),
      capability,
      publicKey: publicKey.trim(),
      scope: {
        tradeId: tradeId.trim() || null,
        evidencePolicyId: policyId.trim(),
        evidencePolicyRevision: Number(policyRevision),
      },
      custody,
    });
    setLocator("");
    if (!out.ok) {
      setFailure(out.error);
      return;
    }
    const v = await verifyOrRefuse(
      app,
      out.data.challenge,
      {
        purpose: "SERVICE_ENROLL",
        enrollmentId: out.data.enrollmentId,
        keyVersion: 1,
        publicKey: publicKey.trim(),
      },
      serviceId.trim(),
    );
    if (!v.ok) setFailure(v.failure);
    else {
      onCreated(v.pending);
      setServiceId("");
      setPublicKey("");
      setTradeId("");
    }
  };
  return (
    <section className="panel" aria-labelledby="enroll-title" data-testid="enroll-service">
      <h2 id="enroll-title">Enroll a service identity</h2>
      <p className="muted">
        ManifestAttestor and deterministic-policy services sign only within their enrolled organization, trade
        and EvidencePolicy scope. Enrollment creates version 1 pending proof; the custody proves possession;
        you then activate it.
      </p>
      <form onSubmit={onSubmit} noValidate>
        <div id="enroll-errors" tabIndex={-1}>
          <ErrorSummary errors={errors} />
        </div>
        <Field
          id="enroll-service-id"
          label="Service ID"
          help="A slug, unique in this organization."
          error={err("enroll-service-id")}
        >
          {(aria) => (
            <input
              {...aria}
              type="text"
              className="mono"
              spellCheck={false}
              value={serviceId}
              onChange={(e) => setServiceId(e.target.value)}
            />
          )}
        </Field>
        <Field id="enroll-capability" label="Service capability" help={CAPABILITY_HELP[capability] ?? ""}>
          {(aria) => (
            <select
              {...aria}
              value={capability}
              onChange={(e) => setCapability(e.target.value as ServiceCapability)}
            >
              {SERVICE_CAPABILITIES.map((c) => (
                <option key={c} value={c}>
                  {capabilityLabel(c)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field
          id="enroll-trade"
          label="Trade scope (optional)"
          help="Empty means every trade of this organization that binds the EvidencePolicy below."
          error={err("enroll-trade")}
        >
          {(aria) => (
            <input
              {...aria}
              type="text"
              className="mono"
              spellCheck={false}
              value={tradeId}
              onChange={(e) => setTradeId(e.target.value)}
            />
          )}
        </Field>
        <Field id="enroll-policy" label="EvidencePolicy ID" error={err("enroll-policy")}>
          {(aria) => (
            <input
              {...aria}
              type="text"
              className="mono"
              spellCheck={false}
              value={policyId}
              onChange={(e) => setPolicyId(e.target.value)}
            />
          )}
        </Field>
        <Field
          id="enroll-policy-revision"
          label="EvidencePolicy revision"
          error={err("enroll-policy-revision")}
        >
          {(aria) => (
            <input
              {...aria}
              type="text"
              inputMode="numeric"
              className="mono"
              value={policyRevision}
              onChange={(e) => setPolicyRevision(e.target.value)}
            />
          )}
        </Field>
        <CustodyFields
          prefix="enroll"
          publicKey={publicKey}
          setPublicKey={setPublicKey}
          kind={kind}
          setKind={setKind}
          locator={locator}
          setLocator={setLocator}
          errors={errors}
        />
        <button type="submit" className="btn btn--primary" disabled={!gate.allowed}>
          Review enrollment
        </button>
        {gate.reason ? <BlockedAction reason={gate.reason} /> : null}
      </form>
      <ConfirmDialog
        open={confirming}
        title="Enroll service identity"
        confirmLabel="Enroll service"
        onCancel={() => setConfirming(false)}
        onConfirm={() => void confirm()}
      >
        <IdentityList
          items={[
            ["Service ID", <code key="s">{serviceId.trim()}</code>],
            ["Capability", capabilityLabel(capability)],
            [
              "Scope",
              `organization ${app.me?.organizationId ?? "?"}, ${tradeId.trim() ? `trade ${tradeId.trim()}` : "every trade"}, EvidencePolicy ${policyId.trim()} revision ${policyRevision}`,
            ],
            [
              "Public key",
              <code key="k" className="wrap">
                {publicKey.trim()}
              </code>,
            ],
            ["Custody", `${kind} (locator sent once, never shown)`],
          ]}
        />
        <p>
          The service gains no authority until its custody proves possession and you activate it. It never
          acts for a party, and a trade binds it only when a new trade revision names it.
        </p>
      </ConfirmDialog>
      {failure ? <FailureState failure={failure} what="Service enrollment" headingLevel={3} /> : null}
    </section>
  );
}

/* ---------------------------------- per service ---------------------------------- */

function NewVersionForm({
  service,
  mode,
  delayMs,
  trades,
  onCreated,
  onCancel,
}: {
  service: DirectoryService;
  mode: "rotate" | "recover";
  delayMs: number;
  trades: TradeBindingImpact[] | null;
  onCreated: (p: PendingProof) => void;
  onCancel: () => void;
}) {
  const app = useApp();
  const gate = useMutationGate();
  const [publicKey, setPublicKey] = useState("");
  const [kind, setKind] = useState<string>("ISOLATED_SIGNER_PROCESS");
  const [locator, setLocator] = useState("");
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const prefix = `${mode}-${service.id}`;
  const affected = rolesBinding(trades, { enrollmentId: service.id });
  const next = Math.max(0, ...service.versions.map((v) => v.version)) + 1;
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const errs = custodyErrors(prefix, publicKey, locator);
    setErrors(errs);
    if (errs.length) {
      document.getElementById(errs[0]?.fieldId ?? "")?.focus();
      return;
    }
    setConfirming(true);
  };
  const confirm = async () => {
    setConfirming(false);
    setFailure(null);
    const custody: Custody = { kind, reference: locator.trim() };
    const out =
      mode === "rotate"
        ? await app.client.rotateServiceKey(service.id, publicKey.trim(), custody)
        : await app.client.recoverServiceKey(service.id, publicKey.trim(), custody);
    setLocator("");
    if (!out.ok) {
      setFailure(out.error);
      return;
    }
    const v = await verifyOrRefuse(
      app,
      out.data.challenge,
      {
        purpose: mode === "rotate" ? "SERVICE_ROTATE" : "SERVICE_RECOVER",
        enrollmentId: service.id,
        keyVersion: out.data.keyVersion,
        publicKey: publicKey.trim(),
      },
      service.serviceId,
    );
    if (!v.ok) setFailure(v.failure);
    else onCreated(v.pending);
  };
  const title = mode === "rotate" ? `Rotate ${service.serviceId}` : `Recover ${service.serviceId}`;
  return (
    <form onSubmit={onSubmit} noValidate className="inline-form" data-testid={`${mode}-form-${service.id}`}>
      <h4>
        {title}: new version v{next}
      </h4>
      <CustodyFields
        prefix={prefix}
        publicKey={publicKey}
        setPublicKey={setPublicKey}
        kind={kind}
        setKind={setKind}
        locator={locator}
        setLocator={setLocator}
        errors={errors}
      />
      <div className="btn-row">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn--primary" disabled={!gate.allowed}>
          Review {mode === "rotate" ? "rotation" : "recovery"}
        </button>
      </div>
      <ConfirmDialog
        open={confirming}
        title={title}
        confirmLabel={mode === "rotate" ? "Create rotation version" : "Suspend and start recovery"}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void confirm()}
      >
        <IdentityList
          items={[
            ["Enrollment", <code key="e">{service.id}</code>],
            ["Capability", capabilityLabel(service.capability)],
            ["New version", `v${next}`],
            [
              "New public key",
              <code key="k" className="wrap">
                {publicKey.trim()}
              </code>,
            ],
            ["Custody", `${kind} (locator sent once, never shown)`],
          ]}
        />
        <p>
          {mode === "rotate"
            ? "The current version keeps signing until you activate the proven new version; activation makes it SUPERSEDED."
            : `Key loss or compromise: every current version is SUSPENDED at once and can no longer sign. The new version can be activated only after the recovery delay (${formatDelay(delayMs)} configured on the server).`}
        </p>
        <AffectedTrades affected={affected} none="No trade revision binds this service." />
        <p className="small">{REVISION_CONSEQUENCE}</p>
      </ConfirmDialog>
      {failure ? <FailureState failure={failure} what={title} headingLevel={3} /> : null}
    </form>
  );
}

function ActivateControl({
  service,
  version,
  trades,
  onDone,
}: {
  service: DirectoryService;
  version: number;
  trades: TradeBindingImpact[] | null;
  onDone: () => void;
}) {
  const app = useApp();
  const gate = useMutationGate();
  const [open, setOpen] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const affected = rolesBinding(trades, { enrollmentId: service.id }).filter(
    (x) => x.role.keyVersion !== version,
  );
  const confirm = async () => {
    setOpen(false);
    setFailure(null);
    const out = await app.client.activateServiceKey(service.id, version);
    if (!out.ok) setFailure(out.error);
    else onDone();
  };
  return (
    <>
      <button type="button" className="btn btn--small" onClick={() => setOpen(true)} disabled={!gate.allowed}>
        Activate v{version}
      </button>
      <ConfirmDialog
        open={open}
        title={`Activate ${service.serviceId} v${version}`}
        confirmLabel={`Activate v${version}`}
        onCancel={() => setOpen(false)}
        onConfirm={() => void confirm()}
      >
        <p>
          Version v{version} becomes the only active key of <code>{service.id}</code>. The active version
          becomes SUPERSEDED and suspended versions are revoked. Trade revisions that bound an older version
          keep binding it: its attestations or hold signatures are refused there as the wrong key version.
        </p>
        <AffectedTrades
          affected={affected}
          none="No trade revision binds an older version of this service."
        />
      </ConfirmDialog>
      {failure ? <FailureState failure={failure} what="Activation" headingLevel={3} /> : null}
    </>
  );
}

function RevokeServiceVersion({
  service,
  version,
  trades,
  onDone,
}: {
  service: DirectoryService;
  version: number;
  trades: TradeBindingImpact[] | null;
  onDone: () => void;
}) {
  const app = useApp();
  const gate = useMutationGate();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string>(REVOKE_REASONS[0][0]);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const affected = rolesBinding(trades, { enrollmentId: service.id, keyVersion: version });
  const confirm = async () => {
    setOpen(false);
    setFailure(null);
    const out = await app.client.revokeServiceKey(service.id, version, reason);
    if (!out.ok) setFailure(out.error);
    else onDone();
  };
  const fieldId = `svc-revoke-${service.id}-${version}`;
  return (
    <>
      <button type="button" className="btn btn--small" onClick={() => setOpen(true)} disabled={!gate.allowed}>
        Revoke v{version}
      </button>
      <ConfirmDialog
        open={open}
        title={`Revoke ${service.serviceId} v${version}`}
        confirmLabel="Revoke version"
        onCancel={() => setOpen(false)}
        onConfirm={() => void confirm()}
      >
        <p>This version never signs again. This cannot be undone.</p>
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
        <AffectedTrades affected={affected} none="No trade revision binds this version." />
      </ConfirmDialog>
      {failure ? <FailureState failure={failure} what="Revocation" headingLevel={3} /> : null}
    </>
  );
}

function ServiceCard({
  service,
  trades,
  delayMs,
  observedAt,
  admin,
  onChanged,
  onPending,
}: {
  service: DirectoryService;
  trades: TradeBindingImpact[] | null;
  delayMs: number;
  observedAt: number;
  admin: boolean;
  onChanged: () => void;
  onPending: (p: PendingProof) => void;
}) {
  const [mode, setMode] = useState<"rotate" | "recover" | null>(null);
  const bound = rolesBinding(trades, { enrollmentId: service.id });
  const s = service.scope;
  return (
    <li className="principal" data-testid={`service-${service.serviceId}`} data-enrollment={service.id}>
      <h3>{service.serviceId}</h3>
      <StatusBadge
        dimension="enrollmentStatus"
        value={service.status}
        source="authority directory"
        observedAt={observedAt}
      />
      <IdentityList
        items={[
          ["Enrollment", <code key="e">{service.id}</code>],
          ["Service principal", <code key="p">{service.principalId}</code>],
          [
            "Capability",
            `${capabilityLabel(service.capability)}: ${CAPABILITY_HELP[service.capability] ?? ""}`,
          ],
          [
            "Scope",
            `organization ${s.organizationId}; ${s.tradeId ? `trade ${s.tradeId}` : "every trade"}; EvidencePolicy ${s.evidencePolicyId} revision ${s.evidencePolicyRevision}`,
          ],
          ["Enrolled", `${formatUtc(service.createdAt)} by ${service.createdBy}`],
          ["Custody", "Isolated; the locator and the private key are never served or shown"],
          [
            "Bound by trade revisions",
            bound.length
              ? bound
                  .map((b) => `${b.trade.tradeId} r${b.trade.revision} at v${b.role.keyVersion ?? "?"}`)
                  .join("; ")
              : "None",
          ],
        ]}
      />
      <KeyVersionsTable
        keys={service.versions}
        caption={`Key versions of ${service.serviceId}`}
        observedAt={observedAt}
        action={
          admin
            ? (k) => (
                <div className="btn-row">
                  {k.status === "PENDING_ACTIVATION" ? (
                    <ActivateControl
                      service={service}
                      version={k.version}
                      trades={trades}
                      onDone={onChanged}
                    />
                  ) : null}
                  {REVOCABLE.has(k.status) ? (
                    <RevokeServiceVersion
                      service={service}
                      version={k.version}
                      trades={trades}
                      onDone={onChanged}
                    />
                  ) : null}
                  {!REVOCABLE.has(k.status) ? <span className="small">No action</span> : null}
                </div>
              )
            : undefined
        }
      />
      {admin && service.status !== "REVOKED" ? (
        mode ? (
          <NewVersionForm
            service={service}
            mode={mode}
            delayMs={delayMs}
            trades={trades}
            onCreated={(p) => {
              setMode(null);
              onPending(p);
              onChanged();
            }}
            onCancel={() => setMode(null)}
          />
        ) : (
          <div className="btn-row">
            <button type="button" className="btn btn--small" onClick={() => setMode("rotate")}>
              Rotate {service.serviceId} key
            </button>
            <button type="button" className="btn btn--small" onClick={() => setMode("recover")}>
              Recover {service.serviceId} key
            </button>
          </div>
        )
      ) : null}
    </li>
  );
}

export function OrganizationServicesScreen() {
  const app = useApp();
  const [tick, setTick] = useState(0);
  const me = app.me;
  const reader =
    !!me && (me.capabilities.includes("ORG_SECURITY_ADMIN") || me.capabilities.includes("AUDITOR"));
  const admin = !!me && me.capabilities.includes("ORG_SECURITY_ADMIN");
  const dir = useApiData(reader ? () => app.client.organizationDirectory() : null, [reader, tick]);
  const bindings = useApiData(reader ? () => app.client.tradeBindings() : null, [reader, tick]);
  const [pending, setPending] = useState<PendingProof | null>(null);
  const [proved, setProved] = useState<string | null>(null);
  const changed = () => setTick((x) => x + 1);
  const header = (
    <>
      <PageHeader
        title="Service identities"
        description="ManifestAttestor, deterministic-policy and executor service enrollments: scope, key versions, custody kind, rotation, recovery, revocation and their effect on in-flight trades."
      />
      <OrgNav />
    </>
  );
  if (!app.meLoaded) return <LoadingState what="your session" />;
  if (!me)
    return (
      <>
        {header}
        <FailureState failure={{ kind: "no-session" }} what="Service identities" />
      </>
    );
  if (!reader)
    return (
      <>
        {header}
        <Callout tone="neutral" icon="blocked" title="Service administration is not available to your role">
          <p>
            Service enrollment and its key lifecycle require the Org Security Admin capability (Auditor may
            read). The server enforces this independently.
          </p>
        </Callout>
      </>
    );
  const trades = bindings.outcome?.ok ? bindings.outcome.data.trades : null;
  return (
    <>
      {header}
      {proved ? (
        <Callout
          tone="neutral"
          icon="pending"
          title="Custody proof accepted"
          role="status"
          testId="service-proved"
        >
          <p>{proved}</p>
        </Callout>
      ) : null}
      {pending ? (
        <ServiceProofPanel
          pending={pending}
          onCancel={() => setPending(null)}
          onProved={() => {
            setProved(
              `${pending.serviceId} v${pending.keyVersion} proved possession and is pending activation. Activate it below when you are ready.`,
            );
            setPending(null);
            changed();
          }}
        />
      ) : null}
      {dir.outcome === null ? (
        <LoadingState what="service enrollments" />
      ) : !dir.outcome.ok ? (
        <FailureState failure={dir.outcome.error} what="Service enrollments" onRetry={dir.reload} />
      ) : (
        <section className="panel" aria-labelledby="services-title" data-testid="services">
          <h2 id="services-title">Enrolled services</h2>
          <p className="muted">
            Source: GET /v1/organization/directory, {formatUtc(dir.outcome.data.observedAt)}. Secrets are
            write-only: neither private keys nor custody locators are ever served.
          </p>
          {dir.outcome.data.services.length === 0 ? (
            <p>No service identity is enrolled in this organization.</p>
          ) : (
            <ul className="stack-list">
              {dir.outcome.data.services.map((s) => (
                <ServiceCard
                  key={s.id}
                  service={s}
                  trades={trades}
                  delayMs={dir.outcome?.ok ? dir.outcome.data.recoveryDelayMs : 0}
                  observedAt={dir.outcome?.ok ? dir.outcome.data.observedAt : 0}
                  admin={admin}
                  onChanged={changed}
                  onPending={(p) => {
                    setProved(null);
                    setPending(p);
                  }}
                />
              ))}
            </ul>
          )}
        </section>
      )}
      {admin ? (
        <EnrollServicePanel
          onCreated={(p) => {
            setProved(null);
            setPending(p);
            changed();
          }}
        />
      ) : null}
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
