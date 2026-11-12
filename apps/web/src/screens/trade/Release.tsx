import { useRef, useState } from "react";
import { useApiData, useMutationGate } from "../../app/app-context";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { AddressDisplay, IdentityList, TableScroller } from "../../components/Data";
import { Field } from "../../components/Forms";
import { SignedAction } from "../../components/SignedAction";
import { BlockedAction, Callout, FailureState } from "../../components/States";
import { StatusBadge } from "../../components/Status";
import type { ApiFailure, ApiOutcome } from "../../lib/api/client";
import type { ContractIntent, Prepared, ReleaseView } from "../../lib/api/trade";
import type { TypedJson } from "../../lib/canonical";
import { formatUtc } from "../../lib/format";
import { digestOf } from "../../lib/signing";
import { describeStatus } from "../../lib/status";
import { BlockerList, Near, Section, useTrade } from "./common";

const PRE_SUBMIT = [
  "VALUE_LOCKED",
  "DIRECT_TESTNET_AUTHORIZED",
  "FUNDED_AUTHORIZATION_REQUIRED",
  "FUNDED_AUTHORIZED",
];

function randomKey(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return `ui-${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}

const CONSENT_KEY = (intentId: string) => `dockside.cancel-consent.${intentId}`;

function storeConsent(intentId: string, consent: TypedJson): void {
  try {
    window.sessionStorage.setItem(CONSENT_KEY(intentId), JSON.stringify(consent));
  } catch {
    /* per-tab convenience only */
  }
}

function readConsent(intentId: string): TypedJson | null {
  try {
    const raw = window.sessionStorage.getItem(CONSENT_KEY(intentId));
    return raw ? (JSON.parse(raw) as TypedJson) : null;
  } catch {
    return null;
  }
}

function ExitFlows({
  intentId,
  contract,
  onChange,
}: {
  intentId: string;
  contract: ContractIntent | undefined;
  onChange: () => void;
}) {
  const t = useTrade();
  const cancelRef = useRef<TypedJson | null>(null);
  const [reason, setReason] = useState("PARTIES_AGREE");
  const [pkg, setPkg] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [pastedCheck, setPastedCheck] = useState<{ ok: boolean; text: string; cancel?: TypedJson } | null>(
    null,
  );
  const [trigger, setTrigger] = useState("INTENT_EXPIRED");
  const pending = contract?.pendingCancel ?? null;
  const myConsent = readConsent(intentId);
  const role = t.has("BUYER") ? "BUYER_APPROVER" : "SUPPLIER_SIGNER";

  const consentFlow =
    (getCancel: () => Promise<ApiOutcome<Prepared> | { ok: true; data: Prepared }>) => async () => {
      const c = await getCancel();
      if (!c.ok) return c as ApiOutcome<Prepared>;
      cancelRef.current = c.data.payload;
      return t.api.call<Prepared>("cancelConsentChallenge", {
        params: { id: intentId },
        body: { cancel: c.data.payload },
      });
    };
  const recordConsent = async (payload: TypedJson, signature: string) => {
    const out = await t.api.call<{ relay?: never }>("cancelConsent", {
      params: { id: intentId },
      body: { cancel: cancelRef.current, consent: payload, signature },
    });
    if (out.ok) {
      storeConsent(intentId, payload);
      setPkg(JSON.stringify({ releaseIntentId: intentId, cancel: cancelRef.current }));
    }
    return out;
  };

  return (
    <section aria-labelledby="exit-title" data-testid="exit-flows">
      <h3 id="exit-title">Before submission: cancel or abandon</h3>
      <p className="small">
        Two different, non-interchangeable flows. Cancellation needs matching consents from the buyer approver
        and the supplier signer. Abandonment is only for an expired intent after the signed policy trigger and
        grace, and it does not cancel the trade or refund funds.
      </p>
      {pending ? (
        <Callout
          tone="warning"
          icon="pending"
          title="Cancellation pending on the contract"
          headingLevel={3}
          testId="pending-cancel"
        >
          <p>
            Cancel digest <code className="wrap">{pending.digest}</code>, reason {pending.reasonCode}, expires{" "}
            {formatUtc(pending.expiresAt)}. Consents:{" "}
            {pending.consents.length
              ? pending.consents
                  .map((c) => `${c.role}${c.revoked ? " (revoked)" : ""} at ${formatUtc(c.recordedAt)}`)
                  .join("; ")
              : "none"}
            . The intent stays locked until both parties' consents are current.
          </p>
        </Callout>
      ) : null}
      <SignedAction
        id="cancel"
        onBusyChange={t.busy("exits")}
        title="Request cancellation"
        consequence={`Your signature records your consent (${role}) to cancel this pre-submit intent. It takes effect only when the other party signs the same canonical cancellation; the reservation then returns to AVAILABLE.`}
        startLabel="Prepare cancellation"
        signLabel="Sign my consent"
        prepare={consentFlow(() =>
          t.api.call<Prepared>("cancelChallenge", { params: { id: intentId }, body: { reasonCode: reason } }),
        )}
        record={recordConsent}
        onDone={onChange}
      >
        <Field
          id="cancel-reason"
          label="Cancellation reason code"
          help="Uppercase code bound into the payload."
        >
          {(aria) => (
            <input
              {...aria}
              className="mono"
              value={reason}
              onChange={(e) => setReason(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))}
            />
          )}
        </Field>
      </SignedAction>
      {pkg ? (
        <div data-testid="cancel-package">
          <h4>Cancellation package for the other party</h4>
          <p className="small">
            Send this exact text to the counterparty; they paste it below in their own session.
          </p>
          <AddressDisplay value={pkg} label="cancellation package" />
        </div>
      ) : null}
      <section aria-labelledby="consent-title">
        <h4 id="consent-title">Consent to a cancellation the other party proposed</h4>
        <Field id="cancel-paste" label="Cancellation package" help="Paste the package exactly as received.">
          {(aria) => (
            <textarea
              {...aria}
              className="mono"
              value={pasted}
              onChange={(e) => {
                setPasted(e.target.value);
                setPastedCheck(null);
              }}
            />
          )}
        </Field>
        <button
          type="button"
          className="btn"
          onClick={() =>
            void (async () => {
              try {
                const j = JSON.parse(pasted) as { releaseIntentId?: string; cancel?: TypedJson };
                if (j.releaseIntentId !== intentId || !j.cancel)
                  return setPastedCheck({ ok: false, text: "The package names a different release intent." });
                const d = await digestOf("CANCEL_RELEASE_INTENT", j.cancel);
                if (!pending || pending.digest !== d)
                  return setPastedCheck({
                    ok: false,
                    text: `Digest ${d} does not match the cancellation pending on the contract; nothing to sign.`,
                  });
                setPastedCheck({
                  ok: true,
                  text: `Digest ${d} matches the contract's pending cancellation.`,
                  cancel: j.cancel,
                });
              } catch {
                setPastedCheck({ ok: false, text: "The package is not valid JSON." });
              }
            })()
          }
        >
          Check package against the contract
        </button>
        <p role="status" data-testid="cancel-paste-check">
          {pastedCheck?.text}
        </p>
        {pastedCheck?.ok && pastedCheck.cancel ? (
          <SignedAction
            id="cancel-consent"
            onBusyChange={t.busy("exits")}
            title="Consent to this cancellation"
            consequence={`Your signature (${role}) completes the cancellation if the other consent is still current; the reservation returns to AVAILABLE.`}
            startLabel="Prepare my consent"
            signLabel="Sign my consent"
            prepare={consentFlow(async () => ({
              ok: true,
              data: { purpose: "CANCEL_RELEASE_INTENT", payload: pastedCheck.cancel as TypedJson },
            }))}
            record={recordConsent}
            onDone={onChange}
          />
        ) : null}
      </section>
      {myConsent ? (
        <SignedAction
          id="revoke-consent"
          onBusyChange={t.busy("exits")}
          title="Revoke my pending consent"
          consequence="Your signature withdraws only your own consent; the intent stays locked."
          startLabel="Prepare revocation"
          signLabel="Sign revocation"
          prepare={() =>
            t.api.call("cancelConsentRevocationChallenge", {
              params: { id: intentId },
              body: { consent: myConsent },
            })
          }
          record={(payload, signature) =>
            t.api.call("cancelConsentRevocation", { params: { id: intentId }, body: { payload, signature } })
          }
          onDone={onChange}
        />
      ) : null}
      <SignedAction
        id="abandon"
        onBusyChange={t.busy("exits")}
        title="Abandon expired intent"
        consequence="Abandonment returns the exact reservation to AVAILABLE. It does not cancel the trade and does not refund funds. The backend refuses it before the signed policy trigger plus grace."
        startLabel="Check eligibility and prepare"
        signLabel="Sign abandonment"
        prepare={() => t.api.call("abandonChallenge", { params: { id: intentId }, body: { trigger } })}
        record={(payload, signature) =>
          t.api.call("abandonRelease", { params: { id: intentId }, body: { payload, signature } })
        }
        onDone={onChange}
      >
        <Field id="abandon-trigger" label="Policy trigger" help="Policy dockside-abandon-v1 revision 1.">
          {(aria) => (
            <select {...aria} value={trigger} onChange={(e) => setTrigger(e.target.value)}>
              <option value="INTENT_EXPIRED">INTENT_EXPIRED</option>
              <option value="BUYER_APPROVAL_EXPIRED">BUYER_APPROVAL_EXPIRED</option>
            </select>
          )}
        </Field>
      </SignedAction>
    </section>
  );
}

function ExecuteRelease({ intentId, onChange }: { intentId: string; onChange: () => void }) {
  const t = useTrade();
  const gate = useMutationGate();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const tr = t.p.trade;
  // A condition can lapse after approval (for example an evidence slot going stale): the control
  // stays visible but blocked, naming the conditions; the journal and the contract refuse anyway.
  const blockers = t.p.release.blockers;
  return (
    <section
      aria-labelledby="execute-title"
      data-testid="execute-release"
      data-blocked={blockers.length ? "yes" : "no"}
    >
      <h3 id="execute-title">Queue the direct testnet release</h3>
      <p>
        The journal re-checks every release condition, holds the value lock and queues one operation; the
        worker submits it once and the reconciler records the outcome from the chain.
      </p>
      <button
        type="button"
        className="btn btn--primary"
        disabled={!gate.allowed || blockers.length > 0}
        onClick={() => setOpen(true)}
      >
        Execute direct release
      </button>
      {blockers.length ? (
        <BlockedAction
          reason={`Release is blocked until every condition holds again: ${blockers.join(", ")}.`}
        />
      ) : null}
      <ConfirmDialog
        open={open}
        title="Execute direct release"
        confirmLabel="Queue release"
        onCancel={() => setOpen(false)}
        onConfirm={() => {
          setOpen(false);
          t.busy("execute")(true);
          void (async () => {
            const out = await t.api.call<{ operationId: string; state: string }>("executeRelease", {
              params: { id: intentId },
              body: {},
            });
            if (!out.ok) return setFailure(out.error);
            setFailure(null);
            setResult(`Operation ${out.data.operationId} is ${out.data.state}.`);
            onChange();
          })();
        }}
      >
        <IdentityList
          items={[
            ["Amount", <Near key="a" yocto={tr.amountYocto} network={tr.network} />],
            [
              "Recipient",
              <code key="r" className="wrap">
                {tr.payout.destination}
              </code>,
            ],
            ["Network", tr.network],
            ["Revision", `r${tr.revision}`],
            ["Release intent", <code key="i">{intentId}</code>],
          ]}
        />
        <p>
          This cannot be undone once submitted. If the outcome is not proven, value stays locked for
          reconciliation.
        </p>
      </ConfirmDialog>
      <p role="status" data-testid="execute-status">
        {result}
      </p>
      {failure ? <FailureState failure={failure} what="Execute release" headingLevel={3} /> : null}
    </section>
  );
}

export function ReleaseTab() {
  const t = useTrade();
  const rel = useApiData(() => t.api.release(t.tradeId), [t.tradeId, t.tick]);
  const intentRef = useRef<string>("");
  const changed = async () => {
    await t.api.sync(t.tradeId);
    t.refresh();
  };
  const tr = t.p.trade;
  const live = t.p.release.liveIntent;
  const lockOp = t.p.operations.find((o) => o.lockHeld);
  const isParty = t.has("BUYER") || t.has("SUPPLIER");
  return (
    <Section what="release" state={rel.state} outcome={rel.outcome} reload={rel.reload}>
      {(r: ReleaseView) => {
        const contractLive = r.contract.intents.find((i) => i.releaseIntentId === live?.releaseIntentId);
        const preSubmit = live !== null && PRE_SUBMIT.includes(live.state) && !lockOp;
        return (
          <>
            <section aria-labelledby="checklist-title" data-testid="release-checklist">
              <h3 id="checklist-title">Release checklist</h3>
              <IdentityList
                items={[
                  [
                    "Active revision",
                    `r${r.contract.revision} (terms digest ${tr.termsDigest.slice(0, 16)}…)`,
                  ],
                  [
                    "Destination",
                    <code key="d" className="wrap">
                      {r.contract.payoutDestination}
                    </code>,
                  ],
                  [
                    "Destination change",
                    r.contract.pendingDestinationChange ? "Pending — see Agreement" : "None pending",
                  ],
                  ["Evidence", `${t.p.evidence.status}, manifest revision ${t.p.evidence.manifestRevision}`],
                  [
                    "Attestation",
                    t.p.attestation
                      ? describeStatus("attestationStatus", t.p.attestation.status).label
                      : "None",
                  ],
                  [
                    "Inspector",
                    t.p.inspection
                      ? describeStatus("inspectionDecision", t.p.inspection.decision).label
                      : "No decision",
                  ],
                  ["HoldRecords blocking", String(t.p.holds.blocking)],
                  [
                    "Amount and profile",
                    <span key="a">
                      <Near yocto={tr.amountYocto} network={tr.network} /> direct testnet release, no fees
                    </span>,
                  ],
                  [
                    "Release intent",
                    live
                      ? `${live.releaseIntentId} (${describeStatus("releaseIntentState", live.state).label})`
                      : "None",
                  ],
                  [
                    "Value lock",
                    lockOp
                      ? `Held by operation ${lockOp.operationId} (${lockOp.state})`
                      : live
                        ? "Held by the release intent"
                        : "Not locked",
                  ],
                ]}
              />
              <h4>Missing conditions (contract and services)</h4>
              <BlockerList tradeId={t.tradeId} blockers={r.blockers} />
            </section>
            <section aria-labelledby="intents-title">
              <h3 id="intents-title">Release intents</h3>
              {r.intents.length === 0 ? <p>No release intent has been prepared for this trade.</p> : null}
              {r.intents.length ? (
                <TableScroller label="Release intents">
                  <table data-testid="intents-table">
                    <caption>Release intents (journal), with the contract's state</caption>
                    <thead>
                      <tr>
                        <th scope="col">Intent</th>
                        <th scope="col">Journal state</th>
                        <th scope="col">Contract state</th>
                        <th scope="col">Amount</th>
                        <th scope="col">Destination</th>
                        <th scope="col">Approval</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.intents.map((i) => {
                        const c = r.contract.intents.find((x) => x.releaseIntentId === i.releaseIntentId);
                        return (
                          <tr key={i.releaseIntentId}>
                            <td className="mono">{i.releaseIntentId}</td>
                            <td>
                              <StatusBadge
                                dimension="releaseIntentState"
                                value={i.state}
                                source="release journal"
                                observedAt={r.observedAt}
                                compact
                              />
                            </td>
                            <td>
                              {c ? (
                                <StatusBadge
                                  dimension="releaseIntentState"
                                  value={c.state}
                                  source="escrow contract view"
                                  observedAt={r.observedAt}
                                  compact
                                />
                              ) : (
                                "Not on the contract"
                              )}
                            </td>
                            <td>
                              <Near yocto={i.amountYocto} network={tr.network} />
                            </td>
                            <td className="mono wrap">{i.destination}</td>
                            <td>
                              {c?.approval
                                ? `Approved ${formatUtc(c.approval.approvedAt)}, expires ${formatUtc(c.approval.expiresAt)}`
                                : "None"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </TableScroller>
              ) : null}
            </section>
            {t.has("BUYER") && (live === null || live.state === "PREPARED" || t.pinned("lock")) ? (
              <SignedAction
                id="lock"
                onBusyChange={t.busy("lock")}
                title="Lock release value"
                intro={
                  <p>
                    Creates one release intent that reserves the full amount from every funder's available
                    slice.
                  </p>
                }
                consequence="Your signature locks the exact release value for this trade. It does not approve or pay anything."
                startLabel="Prepare release intent"
                signLabel="Sign release intent"
                prepare={async () => {
                  const out = await t.api.call<Prepared & { releaseIntentId: string }>(
                    "prepareReleaseIntent",
                    {
                      params: { id: t.tradeId },
                      body: { idempotencyKey: randomKey() },
                    },
                  );
                  if (out.ok) intentRef.current = out.data.releaseIntentId;
                  return out;
                }}
                record={(_payload, signature) =>
                  t.api.call("signReleaseIntent", { params: { id: intentRef.current }, body: { signature } })
                }
                onDone={() => void changed()}
              />
            ) : null}
            {t.has("BUYER") && live && (live.state === "VALUE_LOCKED" || t.pinned("approve")) ? (
              <SignedAction
                id="approve"
                onBusyChange={t.busy("approve")}
                title="Approve release"
                consequence="Your signature as the bound buyer approver authorizes a direct native testnet NEAR release of the full amount to the bound destination. Opening this page approves nothing."
                startLabel="Prepare approval"
                signLabel="Sign approval"
                facts={
                  <IdentityList
                    items={[
                      ["Amount", <Near key="a" yocto={tr.amountYocto} network={tr.network} />],
                      ["Asset", "Native NEAR"],
                      [
                        "Recipient",
                        <code key="r" className="wrap">
                          {tr.payout.destination}
                        </code>,
                      ],
                      ["Network", tr.network],
                      ["Revision", `r${tr.revision}`],
                    ]}
                  />
                }
                prepare={() =>
                  t.api.call("approvalChallenge", { params: { id: live.releaseIntentId }, body: {} })
                }
                record={(payload, signature) =>
                  t.api.call("approveRelease", {
                    params: { id: live.releaseIntentId },
                    body: { payload, signature },
                  })
                }
                onDone={() => void changed()}
              />
            ) : null}
            {t.has("BUYER") &&
            live &&
            (t.pinned("execute") || (live.state === "DIRECT_TESTNET_AUTHORIZED" && !lockOp)) ? (
              <ExecuteRelease intentId={live.releaseIntentId} onChange={() => void changed()} />
            ) : null}
            {!t.has("BUYER") ? (
              <p className="small">Release approval is available only to the trade's bound buyer approver.</p>
            ) : null}
            {isParty && live && (preSubmit || t.pinned("exits")) ? (
              <ExitFlows
                intentId={live.releaseIntentId}
                contract={contractLive}
                onChange={() => void changed()}
              />
            ) : null}
            {lockOp ? (
              <Callout
                tone="unknown"
                icon="locked"
                title="Exits are closed: value is locked by a submitted operation"
                headingLevel={3}
                testId="exits-closed"
              >
                <p>
                  Operation <code>{lockOp.operationId}</code> is{" "}
                  {describeStatus("operationState", lockOp.state).label}. Cancel and abandon are not available
                  after submission; see Payout for reconciliation.
                </p>
              </Callout>
            ) : null}
            {!isParty && live ? (
              <BlockedAction reason="Cancel and abandon are only for the trade's designated buyer approver and supplier signer." />
            ) : null}
          </>
        );
      }}
    </Section>
  );
}
