import { type FormEvent, useEffect, useRef, useState } from "react";
import { useApp, useMutationGate } from "../app/app-context";
import { Link } from "../app/router";
import { PageHeader } from "../components/AppShell";
import { AddressDisplay } from "../components/Data";
import { ErrorSummary, Field, type FieldError } from "../components/Forms";
import { RelayPanel } from "../components/SignedAction";
import { BlockedAction, Callout, FailureState } from "../components/States";
import type { ApiFailure } from "../lib/api/client";
import { ENDPOINTS, isApiIdentifier } from "../lib/api/endpoints";
import type { FunctionCall, Proposal } from "../lib/api/trade";
import { formatUtc } from "../lib/format";
import { prepareSignature, signPrepared } from "../lib/signing";

/**
 * Five-step trade draft (UI-SPEC §3.2). Client checks are format help only; the server
 * validates, canonicalizes and returns the signing preview. The UI never signs
 * automatically and never treats a draft as an agreement.
 */
interface Draft {
  supplierSignerPrincipalId: string;
  amountNear: string;
  milestoneId: string;
  milestone: string;
  refundPolicy: string;
  expiresInDays: string;
  buyerAccountId: string;
  destinationAccount: string;
  inspectorPrincipalId: string;
  riskResolverPrincipalId: string;
  evidencePolicyId: string;
  manifestAttestorEnrollmentId: string;
}

const EMPTY: Draft = {
  supplierSignerPrincipalId: "",
  amountNear: "",
  milestoneId: "",
  milestone: "",
  refundPolicy: "dockside-refund-v1@1",
  expiresInDays: "30",
  buyerAccountId: "",
  destinationAccount: "",
  inspectorPrincipalId: "",
  riskResolverPrincipalId: "",
  evidencePolicyId: "",
  manifestAttestorEnrollmentId: "",
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

const optionalId = (what: string) => (v: string) => (v.trim() === "" ? null : id(what)(v));

/** Native NEAR amount: up to 24 decimal places, positive. */
const nearAmount = (v: string) =>
  /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,24})?$/.test(v.trim()) && !/^0(\.0+)?$/.test(v.trim())
    ? null
    : "Enter a positive NEAR amount with at most 24 decimal places, for example 12.5.";

/** Exact yoctoNEAR from a decimal NEAR string (no floating point). */
export function nearToYocto(v: string): string {
  const [w = "0", f = ""] = v.trim().split(".");
  return (BigInt(w) * 10n ** 24n + BigInt(`${f}${"0".repeat(24)}`.slice(0, 24))).toString(10);
}

/** Named NEAR testnet account (format help only; the server normalizes and rejects). */
const testnetAccount = (v: string) => {
  const s = v.trim();
  if (s !== s.toLowerCase()) return "NEAR accounts are lowercase. Check the account with the supplier.";
  return /^(?=.{2,64}$)([a-z0-9]+[-_])*[a-z0-9]+(\.([a-z0-9]+[-_])*[a-z0-9]+)*\.testnet$/.test(s)
    ? null
    : "Enter a named NEAR testnet account ending in .testnet, for example supplier-payouts.testnet.";
};

const slugField = (what: string) => (v: string) =>
  /^[a-z0-9][a-z0-9-]{0,63}$/.test(v.trim())
    ? null
    : `${what} uses lowercase letters, digits and hyphens, for example shipment-1.`;

const STEPS: ReadonlyArray<{ title: string; fields: FieldSpec[] }> = [
  {
    title: "Parties and enrolled keys",
    fields: [
      {
        key: "supplierSignerPrincipalId",
        label: "Supplier signer principal ID",
        help: "prn_ followed by 32 hex characters, shared by the supplier from their organization page. The server binds their current key version.",
        validate: id("Supplier signer principal ID"),
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
        key: "milestoneId",
        label: "Milestone reference",
        help: "Short lowercase reference, for example shipment-1.",
        validate: slugField("Milestone reference"),
        mono: true,
      },
      {
        key: "milestone",
        label: "Milestone",
        help: "What must be delivered and inspected before release (1 to 200 characters).",
        validate: (v) => (v.trim().length >= 1 && v.trim().length <= 200 ? null : "Describe the milestone."),
      },
      {
        key: "expiresInDays",
        label: "Agreement lifetime (days)",
        help: "Whole days from now, 1 to 180.",
        validate: (v) =>
          /^[1-9][0-9]{0,2}$/.test(v.trim()) && Number(v) <= 180 ? null : "Enter 1 to 180 days.",
        mono: true,
      },
    ],
  },
  {
    title: "Supplier payout network and exact destination",
    fields: [
      {
        key: "destinationAccount",
        label: "Supplier NEAR testnet account",
        help: "Exact named account that signs as the supplier and receives the direct testnet release.",
        validate: testnetAccount,
        mono: true,
      },
      {
        key: "buyerAccountId",
        label: "Buyer funding NEAR testnet account",
        help: "The account your organization funds the escrow from.",
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
        key: "riskResolverPrincipalId",
        label: "Risk/policy resolver principal ID",
        help: "The only principal that may sign hold resolutions for this trade.",
        validate: id("Risk/policy resolver principal ID"),
        mono: true,
      },
      {
        key: "evidencePolicyId",
        label: "Evidence policy ID",
        help: "The registered EvidencePolicy (revision 1) whose slots the manifest must satisfy, for example commercial-docs.",
        validate: slugField("Evidence policy ID"),
        mono: true,
      },
      {
        key: "manifestAttestorEnrollmentId",
        label: "ManifestAttestor enrollment ID (optional)",
        help: "Leave empty to use your organization's single active MANIFEST_ATTEST enrollment for this policy.",
        validate: optionalId("ManifestAttestor enrollment ID"),
        mono: true,
      },
    ],
  },
  { title: "Review canonical agreement and collect signatures", fields: [] },
];

/** Material facts of a proposal, grouped (never behind a generic checkbox). */
function ProposalFacts({ terms }: { terms: Record<string, unknown> }) {
  const g = (path: string): string => {
    let v: unknown = terms;
    for (const k of path.split(".")) v = (v as Record<string, unknown> | undefined)?.[k];
    return v === undefined || v === null ? "—" : String(v);
  };
  const groups: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, string]>]> = [
    [
      "Parties",
      [
        ["Buyer approver", `${g("buyer.principalId")} key ${g("buyer.keyVersionId")}`],
        ["Buyer funding account", g("buyer.accountId")],
        ["Supplier signer", `${g("supplier.principalId")} key ${g("supplier.keyVersionId")}`],
      ],
    ],
    [
      "Money",
      [
        ["Asset", `${g("asset.kind")} on ${g("asset.network")}`],
        ["Amount (yoctoNEAR)", g("amountYocto")],
        ["Escrow contract", g("escrowContractId")],
      ],
    ],
    [
      "Destination (binds payment)",
      [
        ["Payout destination", g("payout.destination")],
        ["Destination change delay (ms)", g("delayPolicy.destinationChangeDelayMs")],
      ],
    ],
    [
      "Authority",
      [
        ["Named inspector", `${g("inspector.principalId")} key ${g("inspector.keyVersionId")}`],
        ["Risk/policy resolver", `${g("riskResolver.principalId")} key ${g("riskResolver.keyVersionId")}`],
        [
          "ManifestAttestor",
          `${g("manifestAttestor.serviceId")} (${g("manifestAttestor.enrollmentId")}) key v${g("manifestAttestor.keyVersion")}`,
        ],
        [
          "Deterministic policy",
          `${g("policySetter.serviceId")} (${g("policySetter.enrollmentId")}) key v${g("policySetter.keyVersion")}`,
        ],
      ],
    ],
    [
      "Milestone, evidence and lifetime",
      [
        ["Milestone", `${g("milestone.id")}: ${g("milestone.description")}`],
        [
          "Evidence policy",
          `${g("evidencePolicy.id")} r${g("evidencePolicy.revision")} ${g("evidencePolicy.digest")}`,
        ],
        ["Refund policy", `${g("refundPolicy.id")} r${g("refundPolicy.revision")}`],
        ["Trade", `${g("tradeId")} revision ${g("revision")}`],
        ["Expires", formatUtc(Number(g("expiresAt")))],
      ],
    ],
  ];
  return (
    <div className="proposal-facts" data-testid="proposal-facts">
      {groups.map(([title, rows]) => (
        <section key={title} aria-label={title}>
          <h3>{title}</h3>
          <dl className="identity">
            {rows.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd className="mono wrap">{v}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

interface Submitted {
  readonly tradeId: string;
  readonly relay: FunctionCall;
  readonly policyRelay: FunctionCall;
}

/** Review, explicit signature, and the package the counterparty needs. */
function ProposalSigning({
  proposal,
  party,
  buyerSignature,
}: {
  proposal: Proposal;
  party: "buyer" | "supplier";
  buyerSignature?: string;
}) {
  const app = useApp();
  const gate = useMutationGate();
  const [check, setCheck] = useState<{ ok: boolean; digest: string; reason?: string } | null>(null);
  const [pkg, setPkg] = useState<string | null>(null);
  const [submit, setSubmit] = useState<Submitted | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [relayed, setRelayed] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
    void prepareSignature(proposal.purpose, proposal.payload, proposal.digest).then((r) =>
      setCheck(r.ok ? { ok: true, digest: r.value.digestHex } : { ok: false, digest: "", reason: r.reason }),
    );
  }, [proposal]);
  const sign = async () => {
    const s = app.client.getSession();
    const prep = await prepareSignature(proposal.purpose, proposal.payload, proposal.digest);
    if (!s || !prep.ok) return;
    const signature = await signPrepared(prep.value, s.privateKey);
    if (party === "buyer") {
      setPkg(JSON.stringify({ terms: proposal.terms, buyerSignature: signature }));
      return;
    }
    const out = await app.client.call<Submitted>(ENDPOINTS.createTrade, {
      body: { terms: proposal.terms, buyerSignature, supplierSignature: signature },
    });
    if (!out.ok) return setFailure(out.error);
    setSubmit(out.data);
  };
  const issues = proposal.bindingIssues;
  return (
    <section className="panel" aria-labelledby="proposal-title" data-testid="proposal-review">
      <h2 id="proposal-title" tabIndex={-1} ref={headingRef}>
        Canonical agreement for {proposal.tradeId}
      </h2>
      <ProposalFacts terms={proposal.terms} />
      <h3>Signature</h3>
      <dl className="identity">
        <div>
          <dt>Actor</dt>
          <dd className="mono">
            {app.sessionGrant?.principalId} ({party === "buyer" ? "buyer approver" : "supplier signer"}, key{" "}
            {app.sessionGrant?.keyVersionId})
          </dd>
        </div>
        <div>
          <dt>Revision</dt>
          <dd>Revision 1 (new trade)</dd>
        </div>
        <div>
          <dt>Consequence</dt>
          <dd>
            Your signature accepts these exact terms. Once both parties sign and the contract registers them,
            payment can only go to the destination above, after the evidence, inspection, hold and approval
            conditions.
          </dd>
        </div>
      </dl>
      <h3>Digest (dockside/trade-revision v1, recomputed by this browser)</h3>
      {check?.ok ? <AddressDisplay value={check.digest} label="agreement digest" /> : null}
      {check && !check.ok ? (
        <Callout tone="negative" icon="blocked" title="Signature withheld" headingLevel={3} role="alert">
          <p>{check.reason}</p>
        </Callout>
      ) : null}
      {party === "supplier" ? (
        <p data-testid="buyer-signature-check">
          {proposal.buyerSignatureValid === true
            ? "The buyer approver's signature verifies against the buyer key these terms bind."
            : "The buyer approver's signature does NOT verify for these terms. Do not sign."}
        </p>
      ) : null}
      {issues.length ? (
        <Callout tone="warning" icon="blocked" title="Binding issues" headingLevel={3}>
          <p>{issues.map((i) => `${i.role}: ${i.code}`).join("; ")}</p>
        </Callout>
      ) : null}
      {!pkg && !submit ? (
        <div className="btn-row">
          <button
            type="button"
            className="btn btn--primary"
            disabled={
              !check?.ok || !gate.allowed || (party === "supplier" && proposal.buyerSignatureValid !== true)
            }
            onClick={() => void sign()}
          >
            {party === "buyer" ? "Sign as buyer approver" : "Sign as supplier signer and submit"}
          </button>
        </div>
      ) : null}
      {pkg ? (
        <div data-testid="proposal-package">
          <h3>Proposal package for the supplier</h3>
          <p>
            Send this exact text to the supplier signer. They open{" "}
            <Link href="/trades/countersign">Countersign a proposal</Link> in their own session, review the
            same facts and digest, sign, and submit.
          </p>
          <AddressDisplay value={pkg} label="proposal package" />
        </div>
      ) : null}
      {submit ? (
        <div data-testid="trade-submitted">
          <h3>Both signatures recorded</h3>
          <p>
            The server verified both signatures for {submit.tradeId}. The contract registers the trade and its
            EvidencePolicy when these calls are submitted.
          </p>
          <RelayPanel
            call={submit.relay}
            label="register trade"
            onRelayed={(r) => {
              if (r.outcome === "FINAL_SUCCESS") setRelayed((x) => Math.max(x, 1));
            }}
          />
          {relayed >= 1 ? (
            <RelayPanel
              call={submit.policyRelay}
              label="register evidence policy"
              onRelayed={(r) => {
                if (r.outcome === "FINAL_SUCCESS") setRelayed(2);
              }}
            />
          ) : null}
          {relayed >= 2 ? (
            <p role="status" data-testid="trade-registered">
              Registered on the escrow contract.{" "}
              <Link href={`/trades/${submit.tradeId}`}>Open the trade workspace</Link>.
            </p>
          ) : null}
        </div>
      ) : null}
      {failure ? <FailureState failure={failure} what="Trade submission" headingLevel={3} /> : null}
    </section>
  );
}

/** Supplier side: paste the buyer's package, review the same facts, countersign and submit. */
export function CountersignScreen() {
  const app = useApp();
  const gate = useMutationGate();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<{ p: Proposal; buyerSignature: string } | null>(null);
  const errorRef = useRef<HTMLElement>(null);
  if (!app.sessionGrant)
    return (
      <>
        <PageHeader title="Countersign a proposal" />
        <FailureState failure={{ kind: "no-session" }} what="Countersigning" />
      </>
    );
  const fail = (m: string) => {
    setError(m);
    requestAnimationFrame(() => errorRef.current?.focus());
  };
  const review = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    let pkg: { terms?: Record<string, unknown>; buyerSignature?: string };
    try {
      pkg = JSON.parse(text) as typeof pkg;
    } catch {
      return fail("The package is not valid JSON. Paste it exactly as received.");
    }
    if (!pkg.terms || typeof pkg.buyerSignature !== "string")
      return fail("The package must contain terms and the buyer's signature.");
    const out = await app.client.call<Proposal>(ENDPOINTS.reviewTradeProposal, {
      body: { terms: pkg.terms, buyerSignature: pkg.buyerSignature },
    });
    if (!out.ok)
      return fail(
        out.error.kind === "http"
          ? `Server refused the terms (${out.error.code}): ${out.error.message}`
          : "The terms did not reach the server.",
      );
    setProposal({ p: out.data, buyerSignature: pkg.buyerSignature });
  };
  return (
    <>
      <PageHeader
        title="Countersign a proposal"
        description="Review the buyer's proposed agreement in your own session. The server re-derives the canonical terms and checks the buyer's signature."
        network={app.ready?.network ?? null}
      />
      <form className="panel" onSubmit={(e) => void review(e)} noValidate>
        <h2>Proposal package</h2>
        {error ? (
          <section className="error-summary" tabIndex={-1} ref={errorRef} aria-labelledby="cs-error">
            <h3 id="cs-error">There is a problem</h3>
            <p>{error}</p>
          </section>
        ) : null}
        <Field
          id="countersign-package"
          label="Proposal package from the buyer"
          help="Paste the text the buyer approver sent you."
        >
          {(aria) => (
            <textarea
              {...aria}
              className="mono"
              rows={6}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          )}
        </Field>
        <button type="submit" className="btn btn--primary" disabled={!gate.allowed || text.trim() === ""}>
          Review proposal
        </button>
      </form>
      {proposal ? (
        <ProposalSigning proposal={proposal.p} party="supplier" buyerSignature={proposal.buyerSignature} />
      ) : null}
    </>
  );
}

export function TradeCreateScreen() {
  const app = useApp();
  const gate = useMutationGate();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<Partial<Record<Key, string | undefined>>>({});
  const [summaryErrors, setSummaryErrors] = useState<FieldError[]>([]);
  const [serverFailure, setServerFailure] = useState<ApiFailure | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
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
    const out = await app.client.call<Proposal>(ENDPOINTS.proposeTrade, {
      body: {
        supplierPrincipalId: draft.supplierSignerPrincipalId.trim(),
        inspectorPrincipalId: draft.inspectorPrincipalId.trim(),
        riskResolverPrincipalId: draft.riskResolverPrincipalId.trim(),
        buyerAccountId: draft.buyerAccountId.trim(),
        supplierAccountId: draft.destinationAccount.trim(),
        payoutDestination: draft.destinationAccount.trim(),
        amountYocto: nearToYocto(draft.amountNear),
        milestone: { id: draft.milestoneId.trim(), description: draft.milestone.trim() },
        evidencePolicy: { id: draft.evidencePolicyId.trim(), revision: 1 },
        expiresInDays: Number(draft.expiresInDays),
        ...(draft.manifestAttestorEnrollmentId.trim()
          ? { manifestAttestorEnrollmentId: draft.manifestAttestorEnrollmentId.trim() }
          : {}),
      },
    });
    if (!out.ok) {
      setServerFailure(out.error);
      requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }
    setProposal(out.data);
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
                  onChange={(e) => {
                    const v = e.target.value;
                    setDraft((d) => ({ ...d, [f.key]: v }));
                    // Clear a shown error as soon as the value is fixed, so the layout does not shift
                    // under the pointer when the user moves on to Continue.
                    setErrors((prev) =>
                      prev[f.key] ? { ...prev, [f.key]: f.validate(v) ?? undefined } : prev,
                    );
                  }}
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
                <dt>Buyer approver (you)</dt>
                <dd className="mono">{app.sessionGrant.principalId}</dd>
              </div>
              <div>
                <dt>Supplier signer</dt>
                <dd className="mono">{draft.supplierSignerPrincipalId || "Not entered"}</dd>
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
      {proposal ? <ProposalSigning proposal={proposal} party="buyer" /> : null}
    </>
  );
}
