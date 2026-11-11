import { type FormEvent, useRef, useState } from "react";
import { useApp, useMutationGate } from "../app/app-context";
import { PageHeader } from "../components/AppShell";
import { AddressDisplay } from "../components/Data";
import { ErrorSummary, Field, type FieldError } from "../components/Forms";
import { BlockedAction, Callout, FailureState } from "../components/States";
import type { ApiFailure } from "../lib/api/client";
import { isApiIdentifier } from "../lib/api/endpoints";

/**
 * Five-step trade draft (UI-SPEC §3.2). Client checks are format help only; the server
 * validates, canonicalizes and returns the signing preview. The UI never signs
 * automatically and never treats a draft as an agreement.
 */
interface Draft {
  supplierOrganizationId: string;
  supplierSignerPrincipalId: string;
  buyerApproverPrincipalId: string;
  amountNear: string;
  milestone: string;
  refundPolicy: string;
  destinationAccount: string;
  inspectorPrincipalId: string;
  manifestAttestorEnrollmentId: string;
  riskResolverPrincipalId: string;
  evidencePolicyId: string;
}

const EMPTY: Draft = {
  supplierOrganizationId: "",
  supplierSignerPrincipalId: "",
  buyerApproverPrincipalId: "",
  amountNear: "",
  milestone: "",
  refundPolicy: "dockside-refund-v1@1",
  destinationAccount: "",
  inspectorPrincipalId: "",
  manifestAttestorEnrollmentId: "",
  riskResolverPrincipalId: "",
  evidencePolicyId: "",
};

type Key = keyof Draft;

interface FieldSpec {
  readonly key: Key;
  readonly label: string;
  readonly help: string;
  readonly validate: (v: string) => string | null;
  readonly mono?: boolean;
}

const id = (what: string) => (v: string) =>
  isApiIdentifier(v.trim()) ? null : `${what} must be a prefix_ followed by 32 hex characters.`;

/** Native NEAR amount: up to 24 decimal places, positive. */
const nearAmount = (v: string) =>
  /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,24})?$/.test(v.trim()) && !/^0(\.0+)?$/.test(v.trim())
    ? null
    : "Enter a positive NEAR amount with at most 24 decimal places, for example 12.5.";

/** Named NEAR testnet account (format help only; the server normalizes and rejects). */
const testnetAccount = (v: string) => {
  const s = v.trim();
  if (s !== s.toLowerCase()) return "NEAR accounts are lowercase. Check the account with the supplier.";
  return /^(?=.{2,64}$)([a-z0-9]+[-_])*[a-z0-9]+(\.([a-z0-9]+[-_])*[a-z0-9]+)*\.testnet$/.test(s)
    ? null
    : "Enter a named NEAR testnet account ending in .testnet, for example supplier-payouts.testnet.";
};

const STEPS: ReadonlyArray<{ title: string; fields: FieldSpec[] }> = [
  {
    title: "Parties and enrolled keys",
    fields: [
      {
        key: "supplierOrganizationId",
        label: "Supplier organization ID",
        help: "org_ followed by 32 hex characters, from the supplier's organization page.",
        validate: id("Supplier organization ID"),
        mono: true,
      },
      {
        key: "supplierSignerPrincipalId",
        label: "Supplier signer principal ID",
        help: "The supplier principal holding the Supplier Signer capability.",
        validate: id("Supplier signer principal ID"),
        mono: true,
      },
      {
        key: "buyerApproverPrincipalId",
        label: "Buyer approver principal ID",
        help: "A principal in your organization holding the Buyer Approver capability.",
        validate: id("Buyer approver principal ID"),
        mono: true,
      },
    ],
  },
  {
    title: "Asset, amount, milestone, refund policy",
    fields: [
      {
        key: "amountNear",
        label: "Amount (native testnet NEAR)",
        help: "Decimal NEAR; stored as exact yoctoNEAR (24 decimals). No rounding.",
        validate: nearAmount,
        mono: true,
      },
      {
        key: "milestone",
        label: "Milestone",
        help: "What must be delivered and inspected before release (1 to 200 characters).",
        validate: (v) => (v.trim().length >= 1 && v.trim().length <= 200 ? null : "Describe the milestone."),
      },
    ],
  },
  {
    title: "Supplier payout destination",
    fields: [
      {
        key: "destinationAccount",
        label: "Supplier NEAR testnet account",
        help: "Exact named account that will receive the direct testnet release.",
        validate: testnetAccount,
        mono: true,
      },
    ],
  },
  {
    title: "Inspector, attestor, risk authority, evidence policy",
    fields: [
      {
        key: "inspectorPrincipalId",
        label: "Named inspector principal ID",
        help: "An enrolled principal with the Inspector capability, independent of buyer and supplier.",
        validate: id("Inspector principal ID"),
        mono: true,
      },
      {
        key: "manifestAttestorEnrollmentId",
        label: "ManifestAttestor enrollment ID",
        help: "Active MANIFEST_ATTEST service enrollment scoped to the evidence policy.",
        validate: id("ManifestAttestor enrollment ID"),
        mono: true,
      },
      {
        key: "riskResolverPrincipalId",
        label: "Risk/policy resolver principal ID",
        help: "The only principal that may sign hold resolutions for this trade.",
        validate: id("Risk/policy resolver principal ID"),
        mono: true,
      },
      {
        key: "evidencePolicyId",
        label: "Evidence policy ID",
        help: "The EvidencePolicy whose slots the manifest must satisfy.",
        validate: id("Evidence policy ID"),
        mono: true,
      },
    ],
  },
  { title: "Review canonical agreement and collect signatures", fields: [] },
];

export function TradeCreateScreen() {
  const app = useApp();
  const gate = useMutationGate();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<Partial<Record<Key, string | undefined>>>({});
  const [summaryErrors, setSummaryErrors] = useState<FieldError[]>([]);
  const [serverFailure, setServerFailure] = useState<ApiFailure | null>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  if (!app.sessionGrant) {
    return (
      <>
        <PageHeader title="Create trade" />
        <FailureState failure={{ kind: "no-session" }} what="Trade creation" />
      </>
    );
  }

  const current = STEPS[step] ?? STEPS[0];
  const fields = current?.fields ?? [];

  const validateStep = (specs: readonly FieldSpec[]): FieldError[] =>
    specs.flatMap((f) => {
      const m = f.validate(draft[f.key]);
      return m ? [{ fieldId: `trade-${f.key}`, message: m }] : [];
    });

  const goTo = (n: number) => {
    setStep(n);
    setSummaryErrors([]);
    requestAnimationFrame(() => headingRef.current?.focus());
  };

  const onNext = (e: FormEvent) => {
    e.preventDefault();
    const errs = validateStep(fields);
    setSummaryErrors(errs);
    setErrors((prev) => {
      const next = { ...prev };
      for (const f of fields) next[f.key] = errs.find((x) => x.fieldId === `trade-${f.key}`)?.message;
      return next;
    });
    if (errs.length) {
      requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }
    goTo(step + 1);
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const all = STEPS.flatMap((s) => s.fields);
    const errs = validateStep(all);
    setSummaryErrors(errs);
    if (errs.length) {
      requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }
    setServerFailure(null);
    const out = await app.client.createTrade({ ...draft, network: app.ready?.network ?? null });
    if (!out.ok) {
      setServerFailure(out.error);
      requestAnimationFrame(() => summaryRef.current?.focus());
    }
  };

  const isReview = step === STEPS.length - 1;

  return (
    <>
      <PageHeader
        title="Create trade"
        description="Draft the agreement. The server returns the canonical agreement and digest for each party to sign."
        network={app.ready?.network ?? null}
      />
      <nav aria-label="Trade creation steps">
        <ol className="steps">
          {STEPS.map((s, i) => (
            <li key={s.title} aria-current={i === step ? "step" : undefined}>
              <span className="tabular">{i + 1}.</span> {s.title}
            </li>
          ))}
        </ol>
      </nav>
      <div className="form-layout">
        <form className="panel" onSubmit={(e) => (isReview ? void onSubmit(e) : onNext(e))} noValidate>
          <h2 tabIndex={-1} ref={headingRef}>
            Step {step + 1} of {STEPS.length}: {current?.title}
          </h2>
          <ErrorSummary
            ref={summaryRef}
            errors={summaryErrors}
            {...(serverFailure
              ? {
                  serverError:
                    serverFailure.kind === "endpoint-unavailable"
                      ? `The server cannot accept trades yet: ${serverFailure.method} ${serverFailure.path} is not available in this backend build. Your inputs are kept.`
                      : serverFailure.kind === "http"
                        ? `Server refused the draft (${serverFailure.code}): ${serverFailure.message}`
                        : "The draft did not reach the server. Your inputs are kept.",
                }
              : {})}
          />
          {fields.map((f) => (
            <Field key={f.key} id={`trade-${f.key}`} label={f.label} help={f.help} error={errors[f.key]}>
              {(aria) => (
                <input
                  {...aria}
                  type="text"
                  className={f.mono ? "mono" : undefined}
                  spellCheck={false}
                  value={draft[f.key]}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                  onBlur={() =>
                    setErrors((prev) => ({
                      ...prev,
                      [f.key]:
                        draft[f.key] === "" && !prev[f.key]
                          ? undefined
                          : (f.validate(draft[f.key]) ?? undefined),
                    }))
                  }
                />
              )}
            </Field>
          ))}
          {step === 1 ? (
            <Field
              id="trade-refundPolicy"
              label="Refund policy"
              help="Signed refund policy bound into the agreement."
            >
              {(aria) => (
                <select
                  {...aria}
                  value={draft.refundPolicy}
                  onChange={(e) => setDraft((d) => ({ ...d, refundPolicy: e.target.value }))}
                >
                  <option value="dockside-refund-v1@1">dockside-refund-v1, revision 1</option>
                </select>
              )}
            </Field>
          ) : null}
          {step === 2 ? (
            <>
              <Callout
                tone="warning"
                icon="authorized"
                title="Acceptance binds payment to this destination"
                headingLevel={3}
              >
                <p>
                  Once both parties sign, release can only pay this exact account. Changing it later requires
                  a destination revision with buyer and supplier consent and an activation delay.
                </p>
              </Callout>
              {draft.destinationAccount && !testnetAccount(draft.destinationAccount) ? (
                <>
                  <h3>Normalized destination</h3>
                  <AddressDisplay
                    value={draft.destinationAccount.trim()}
                    label="destination"
                    network={app.ready?.network ?? "near-testnet"}
                  />
                </>
              ) : null}
            </>
          ) : null}
          {isReview ? (
            <>
              <p>
                Check every material fact. Submitting asks the server for the canonical agreement; signing
                happens on the next screen with the exact digest, revision and expiry shown.
              </p>
              <dl className="identity">
                {STEPS.flatMap((s) => s.fields).map((f) => (
                  <div key={f.key}>
                    <dt>{f.label}</dt>
                    <dd className={f.mono ? "mono" : undefined}>{draft[f.key] || "Not entered"}</dd>
                  </div>
                ))}
                <div>
                  <dt>Refund policy</dt>
                  <dd>{draft.refundPolicy}</dd>
                </div>
              </dl>
            </>
          ) : null}
          <div className="btn-row">
            {step > 0 ? (
              <button type="button" className="btn" onClick={() => goTo(step - 1)}>
                Back
              </button>
            ) : null}
            <button type="submit" className="btn btn--primary" disabled={isReview && !gate.allowed}>
              {isReview ? "Request canonical agreement" : "Continue"}
            </button>
          </div>
          {isReview && gate.reason ? <BlockedAction reason={gate.reason} /> : null}
          {serverFailure && serverFailure.kind !== "endpoint-unavailable" && serverFailure.kind !== "http" ? (
            <FailureState failure={serverFailure} what="Trade draft" headingLevel={3} />
          ) : null}
        </form>
        <aside className="panel form-summary" aria-labelledby="draft-summary-title">
          <details open>
            <summary id="draft-summary-title">Draft summary</summary>
            <dl>
              <div>
                <dt>Buyer organization</dt>
                <dd className="mono">{app.sessionGrant.organizationId}</dd>
              </div>
              <div>
                <dt>Supplier</dt>
                <dd className="mono">{draft.supplierOrganizationId || "Not entered"}</dd>
              </div>
              <div>
                <dt>Amount</dt>
                <dd className="mono tabular">
                  {draft.amountNear ? `${draft.amountNear} NEAR (testnet)` : "Not entered"}
                </dd>
              </div>
              <div>
                <dt>Destination</dt>
                <dd className="mono">{draft.destinationAccount || "Not entered"}</dd>
              </div>
              <div>
                <dt>Inspector</dt>
                <dd className="mono">{draft.inspectorPrincipalId || "Not entered"}</dd>
              </div>
            </dl>
            <p className="small muted">
              A draft is not an agreement. Nothing is signed or funded from this page.
            </p>
          </details>
        </aside>
      </div>
    </>
  );
}
