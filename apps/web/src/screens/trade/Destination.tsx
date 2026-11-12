import { useState } from "react";
import { useApiData, useApp, useMutationGate } from "../../app/app-context";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { AddressDisplay, IdentityList, TableScroller } from "../../components/Data";
import { Field } from "../../components/Forms";
import { RelayPanel, SignedAction } from "../../components/SignedAction";
import { BlockedAction, Callout, FailureState } from "../../components/States";
import { StatusBadge } from "../../components/Status";
import type { ApiFailure, ApiOutcome } from "../../lib/api/client";
import type {
  DestinationChangeRecord,
  DestinationChangeView,
  FunctionCall,
  Prepared,
  ReleaseView,
} from "../../lib/api/trade";
import { formatUntil, formatUtc } from "../../lib/format";
import { describeStatus } from "../../lib/status";
import { Section, useTrade } from "./common";

/**
 * UI-SPEC §3.5 destination change. Every fact comes from GET /v1/trades/:id/destination-change
 * (contract view plus the bound revision) and the release view; the browser only signs payloads
 * the server prepared after recomputing their digest. There is no quick edit: a change is a
 * successor revision both bound parties sign, waits out the signed delay, and activates by relay.
 */

const NEAR_TESTNET = /^(?=.{2,64}$)([a-z\d]+[-_])*[a-z\d]+(\.([a-z\d]+[-_])*[a-z\d]+)*\.testnet$/;
const LOCKED = ["SUBMITTING", "EXECUTING", "PROCESSING", "UNKNOWN", "REVIEW", "RECONCILING", "ADJUDICATION"];

function refused(reason: string): ApiOutcome<Prepared> {
  return { ok: false, error: { kind: "refused-to-sign", reason }, receivedAt: Date.now() };
}

function ConsentCell({ at, label }: { at: number | null; label: string }) {
  return (
    <span data-testid={`consent-${label}`} data-consented={at === null ? "no" : "yes"}>
      {at === null ? "Not signed" : `Signed ${formatUtc(at)}`}
    </span>
  );
}

function PendingChange({ p, view }: { p: DestinationChangeRecord; view: DestinationChangeView }) {
  const app = useApp();
  const t = useTrade();
  return (
    <section aria-labelledby="dest-pending-title" data-testid="destination-pending" data-status={p.status}>
      <h4 id="dest-pending-title">
        Successor revision r{p.successorRevision}{" "}
        <StatusBadge
          dimension="destinationChange"
          value={p.status}
          source="escrow contract view"
          observedAt={t.receivedAt}
        />
      </h4>
      <IdentityList
        items={[
          ["Proposed by", p.proposedBy === "BUYER" ? "Buyer approver" : "Supplier signer"],
          ["Proposed", formatUtc(p.proposedAt)],
          ["Change", "payout.destination only (every other signed field is carried over unchanged)"],
          [
            "Diff",
            <span key="x" className="mono wrap">
              {p.fromDestination} → {p.toDestination}
            </span>,
          ],
          ["Consent window closes", formatUtc(p.consentDeadline)],
          ["Buyer approver consent", <ConsentCell key="b" at={p.buyerConsentAt} label="buyer" />],
          ["Supplier signer consent", <ConsentCell key="s" at={p.supplierConsentAt} label="supplier" />],
          [
            "Activation possible from",
            p.delayUntil === null ? (
              `Not started: the ${Math.round(view.delayMs / 60_000)}-minute delay begins at the second consent`
            ) : (
              <span key="d" data-testid="delay-until">
                {formatUtc(p.delayUntil)} ({formatUntil(p.delayUntil, app.now)})
              </span>
            ),
          ],
          [
            "Successor digest",
            <code key="g" className="wrap">
              {p.successorDigest}
            </code>,
          ],
        ]}
      />
    </section>
  );
}

function Invalidations({ release }: { release: ReleaseView | null }) {
  const t = useTrade();
  const live = t.p.release.liveIntent;
  const contractLive = release?.contract.intents.find((i) => i.releaseIntentId === live?.releaseIntentId);
  return (
    <section aria-labelledby="dest-inval-title" data-testid="destination-invalidations">
      <h4 id="dest-inval-title">What activation invalidates</h4>
      <ul className="checklist">
        <li>
          Manifest attestation:{" "}
          {t.p.attestation ? <code className="wrap">{t.p.attestation.digest}</code> : "none current"}
        </li>
        <li>
          Inspector decision:{" "}
          {t.p.inspection ? describeStatus("inspectionDecision", t.p.inspection.decision).label : "none"}
        </li>
        <li>HoldRecord view of this revision ({t.p.holds.items.length} record(s))</li>
        <li>
          Release intent:{" "}
          {live ? (
            <>
              <code>{live.releaseIntentId}</code> ({describeStatus("releaseIntentState", live.state).label})
              becomes SUPERSEDED_PRE_SUBMIT; its exact reservation transfers to one successor intent.
            </>
          ) : (
            "none live"
          )}
        </li>
        <li>
          Buyer approval:{" "}
          {contractLive?.approval
            ? `approved ${formatUtc(contractLive.approval.approvedAt)}`
            : "none recorded"}
        </li>
      </ul>
      <p className="small">
        Completion does not reactivate any of these. The new revision needs a fresh complete manifest,
        attestation, inspector PASS, release intent and buyer approval.
      </p>
    </section>
  );
}

function Activation({
  p,
  onChange,
  blocked,
}: {
  p: DestinationChangeRecord;
  onChange: () => void;
  blocked: string | null;
}) {
  const t = useTrade();
  const gate = useMutationGate();
  const [open, setOpen] = useState(false);
  const [call, setCall] = useState<FunctionCall | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [bound, setBound] = useState<string | null>(null);
  const live = t.p.release.liveIntent;
  const bind = async () => {
    const out = await t.api.call<{ revision: number; tradeDigest: string }>("destinationBinding", {
      params: { id: t.tradeId },
      body: {},
    });
    if (!out.ok) return setFailure(out.error);
    setFailure(null);
    setBound(
      `Revision r${out.data.revision} is bound for evidence and holds (digest ${out.data.tradeDigest}).`,
    );
    // Stay pinned (as SignedAction does for finished flows): unpinning here let the refresh below
    // unmount the section before its outcome could be read.
    onChange();
  };
  return (
    <section aria-labelledby="dest-activate-title" data-testid="destination-activation">
      <h4 id="dest-activate-title">Activate the destination revision</h4>
      <p>
        Activation is a relay the contract re-checks: both consents, the signed delay, no submitted or
        unresolved release, no live refund.
      </p>
      <button
        type="button"
        className="btn btn--primary"
        disabled={!gate.allowed || blocked !== null}
        onClick={() => setOpen(true)}
      >
        Activate destination revision
      </button>
      {blocked ? <BlockedAction reason={blocked} /> : null}
      <ConfirmDialog
        open={open}
        title="Activate destination revision"
        confirmLabel="Prepare activation"
        onCancel={() => setOpen(false)}
        onConfirm={() => {
          setOpen(false);
          t.busy("dest-activate")(true);
          void (async () => {
            const out = await t.api.call<{ relay: FunctionCall }>("destinationActivation", {
              params: { id: t.tradeId },
              body: {},
            });
            if (!out.ok) {
              t.busy("dest-activate")(false);
              return setFailure(out.error);
            }
            setFailure(null);
            setCall(out.data.relay);
          })();
        }}
      >
        <IdentityList
          items={[
            [
              "From",
              <code key="f" className="wrap">
                {p.fromDestination}
              </code>,
            ],
            [
              "To",
              <code key="t" className="wrap">
                {p.toDestination}
              </code>,
            ],
            ["Successor revision", `r${p.successorRevision}`],
          ]}
        />
        <p>
          {live
            ? `The pre-submit release intent ${live.releaseIntentId} will become SUPERSEDED_PRE_SUBMIT and its exact reservation will atomically transfer to one successor intent.`
            : "No release intent is live, so no reservation moves."}{" "}
          The manifest attestation, inspection, hold view and buyer approval of the old revision stay invalid.
          This cannot be undone.
        </p>
      </ConfirmDialog>
      {call ? (
        <RelayPanel
          call={call}
          label="Activate destination revision"
          onRelayed={(r) => {
            if (r.outcome === "FINAL_SUCCESS") void bind();
          }}
        />
      ) : null}
      <p role="status" data-testid="destination-bound">
        {bound}
      </p>
      {failure ? <FailureState failure={failure} what="Destination activation" headingLevel={3} /> : null}
    </section>
  );
}

function BindPending({ onChange }: { onChange: () => void }) {
  const t = useTrade();
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  return (
    <Callout tone="warning" icon="pending" title="Activated revision not bound yet" headingLevel={3}>
      <p>
        The contract activated a newer revision than the one evidence and holds follow. Binding reads the
        journaled successor and both consents, checks the contract digest and switches the trade to it.
      </p>
      <button
        type="button"
        className="btn"
        onClick={() =>
          void t.api.call("destinationBinding", { params: { id: t.tradeId }, body: {} }).then((out) => {
            if (!out.ok) return setFailure(out.error);
            onChange();
          })
        }
      >
        Bind the activated revision
      </button>
      {failure ? <FailureState failure={failure} what="Revision binding" headingLevel={3} /> : null}
    </Callout>
  );
}

export function DestinationChange() {
  const t = useTrade();
  const app = useApp();
  const dv = useApiData(() => t.api.destination(t.tradeId), [t.tradeId, t.tick]);
  const rel = useApiData(() => t.api.release(t.tradeId), [t.tradeId, t.tick]);
  const [next, setNext] = useState("");
  const [nextError, setNextError] = useState<string | undefined>(undefined);
  const isParty = t.has("BUYER") || t.has("SUPPLIER");
  const myRole = t.has("BUYER") ? "BUYER" : t.has("SUPPLIER") ? "SUPPLIER" : null;
  const changed = async () => {
    await t.api.sync(t.tradeId);
    t.refresh();
  };
  const lockOp = t.p.operations.find((o) => o.lockHeld || LOCKED.includes(o.state));
  return (
    <section aria-labelledby="dest-title" data-testid="destination-change">
      <h3 id="dest-title">Destination change</h3>
      <Section what="destination change" state={dv.state} outcome={dv.outcome} reload={dv.reload}>
        {(v: DestinationChangeView) => {
          const p = v.pending;
          // An activation in flight stays mounted after the contract closes the pending record.
          const act =
            p ??
            (t.pinned("dest-activate")
              ? ([...v.history]
                  .filter((h) => h.status === "ACTIVATED")
                  .sort((a, b) => b.successorRevision - a.successorRevision)[0] ?? null)
              : null);
          const open = p !== null && (p.status === "PROPOSED" || p.status === "CONSENTED");
          const mine = p && myRole ? (myRole === "BUYER" ? p.buyerConsentAt : p.supplierConsentAt) : null;
          const delayLeft = p?.delayUntil != null && p.delayUntil > app.now;
          const activationBlocked = lockOp
            ? `Activation is blocked while operation ${lockOp.operationId} is ${lockOp.state}.`
            : null;
          return (
            <>
              <div className="panel-grid" data-testid="destination-compare">
                <section aria-labelledby="dest-current-title">
                  <h4 id="dest-current-title">Current destination (revision r{v.boundRevision})</h4>
                  <AddressDisplay
                    value={v.activeDestination}
                    label="current destination"
                    network={t.p.trade.network}
                  />
                </section>
                <section aria-labelledby="dest-proposed-title">
                  <h4 id="dest-proposed-title">Proposed destination</h4>
                  {open && p ? (
                    <AddressDisplay
                      value={p.toDestination}
                      label="proposed destination"
                      network={t.p.trade.network}
                    />
                  ) : (
                    <p data-testid="no-proposal">
                      None. A change is a successor revision that both bound parties sign; there is no quick
                      edit.
                    </p>
                  )}
                </section>
              </div>
              <p className="small">
                Signed delay for this trade: {Math.round(v.delayMs / 60_000)} minute(s) after the second
                consent. Contract revision r{v.contractRevision}. Source: escrow contract view,{" "}
                {formatUtc(t.receivedAt)}.
              </p>
              {open && p ? <PendingChange p={p} view={v} /> : null}
              {v.bindingRequired && isParty ? <BindPending onChange={() => void changed()} /> : null}
              {open || !p ? <Invalidations release={rel.outcome?.ok ? rel.outcome.data : null} /> : null}
              {!isParty ? (
                <BlockedAction reason="Only the trade's bound buyer approver or supplier signer can start, consent to, cancel or activate a destination revision." />
              ) : null}
              {(isParty && !open && !v.bindingRequired) || t.pinned("dest-start") ? (
                <SignedAction
                  id="dest-start"
                  onBusyChange={t.busy("dest-start")}
                  title="Start destination revision"
                  intro={
                    <p>
                      Your signature is the first consent to a successor revision that changes only the payout
                      destination. It never activates without the other party's signature over the same digest
                      and the signed delay.
                    </p>
                  }
                  consequence={`Your signature (${myRole === "BUYER" ? "buyer approver" : "supplier signer"}) consents to revision r${v.boundRevision + 1} paying ${next || "the new destination"} instead of ${v.activeDestination}. The other party must sign the same digest; activation waits for the delay.`}
                  startLabel="Prepare destination revision"
                  signLabel="Sign my consent"
                  facts={
                    <IdentityList
                      items={[
                        [
                          "From",
                          <code key="f" className="wrap">
                            {v.activeDestination}
                          </code>,
                        ],
                        [
                          "To",
                          <code key="t" className="wrap">
                            {next}
                          </code>,
                        ],
                      ]}
                    />
                  }
                  prepare={async () => {
                    if (!NEAR_TESTNET.test(next)) {
                      setNextError("Enter a NEAR testnet account such as name.testnet.");
                      return refused(
                        "the new destination is not a NEAR testnet account; nothing was prepared",
                      );
                    }
                    return t.api.call<Prepared>("destinationChangeChallenge", {
                      params: { id: t.tradeId },
                      body: { destination: next },
                    });
                  }}
                  record={(_payload, signature) =>
                    t.api.call("destinationConsent", {
                      params: { id: t.tradeId },
                      body: { destination: next, signature },
                    })
                  }
                  onDone={() => void changed()}
                >
                  <Field
                    id="dest-new"
                    label="New payout destination (NEAR testnet account)"
                    help="Exact account id. Acceptance binds payment to this destination; check it with the other party out of band."
                    error={nextError}
                  >
                    {(aria) => (
                      <input
                        {...aria}
                        className="mono"
                        autoComplete="off"
                        spellCheck={false}
                        value={next}
                        onChange={(e) => {
                          setNext(e.target.value.trim());
                          setNextError(undefined);
                        }}
                      />
                    )}
                  </Field>
                </SignedAction>
              ) : null}
              {isParty &&
              p &&
              ((open && mine === null && p.status === "PROPOSED") || t.pinned("dest-consent")) ? (
                <SignedAction
                  id="dest-consent"
                  onBusyChange={t.busy("dest-consent")}
                  title="Consent to this destination revision"
                  intro={
                    <p>
                      The {p.proposedBy === "BUYER" ? "buyer approver" : "supplier signer"} proposed paying{" "}
                      <code className="wrap">{p.toDestination}</code>. Confirm the account with them through a
                      channel you trust before signing.
                    </p>
                  }
                  consequence={`Your signature completes dual consent to revision r${p.successorRevision}. The ${Math.round(v.delayMs / 60_000)}-minute delay then starts; activation supersedes the current release facts.`}
                  startLabel="Review the successor revision"
                  signLabel="Sign my consent"
                  prepare={async () => {
                    const out = await t.api.call<Prepared>("destinationChangeChallenge", {
                      params: { id: t.tradeId },
                      body: { destination: p.toDestination },
                    });
                    if (out.ok && out.data.digest !== p.successorDigest)
                      return refused(
                        "the prepared successor does not match the digest pending on the contract; nothing was signed",
                      );
                    return out;
                  }}
                  record={(_payload, signature) =>
                    t.api.call("destinationConsent", {
                      params: { id: t.tradeId },
                      body: { destination: p.toDestination, signature },
                    })
                  }
                  onDone={() => void changed()}
                />
              ) : null}
              {isParty && (open || t.pinned("dest-revoke")) ? (
                <SignedAction
                  id="dest-revoke"
                  onBusyChange={t.busy("dest-revoke")}
                  title={
                    mine === null && p?.status === "PROPOSED"
                      ? "Reject this destination revision"
                      : "Cancel destination revision"
                  }
                  consequence="Your signature revokes the pending successor revision before activation. The bound destination stays unchanged."
                  startLabel="Prepare cancellation"
                  signLabel="Sign cancellation"
                  prepare={() =>
                    t.api.call<Prepared>("destinationRevocationChallenge", {
                      params: { id: t.tradeId },
                      body: {},
                    })
                  }
                  record={(payload, signature) =>
                    t.api.call("destinationRevocation", {
                      params: { id: t.tradeId },
                      body: { payload, signature },
                    })
                  }
                  onDone={() => void changed()}
                />
              ) : null}
              {isParty && act && (act.status === "CONSENTED" || t.pinned("dest-activate")) ? (
                <>
                  {delayLeft && act.delayUntil !== null ? (
                    <p data-testid="delay-countdown">
                      The delay ends {formatUtc(act.delayUntil)} ({formatUntil(act.delayUntil, app.now)}). The
                      server and the contract refuse activation before then.
                    </p>
                  ) : null}
                  <Activation p={act} onChange={() => void changed()} blocked={activationBlocked} />
                </>
              ) : null}
              <section aria-labelledby="dest-history-title">
                <h4 id="dest-history-title">Destination change history</h4>
                {v.history.length === 0 ? (
                  <p>No destination change has been proposed for this trade.</p>
                ) : (
                  <TableScroller label="Destination change history">
                    <table data-testid="destination-history">
                      <caption>Destination changes (escrow contract view)</caption>
                      <thead>
                        <tr>
                          <th scope="col">Revision</th>
                          <th scope="col">From</th>
                          <th scope="col">To</th>
                          <th scope="col">Status</th>
                          <th scope="col">Closed</th>
                        </tr>
                      </thead>
                      <tbody>
                        {v.history.map((h) => (
                          <tr key={h.successorDigest}>
                            <td className="tabular">r{h.successorRevision}</td>
                            <td className="mono wrap">{h.fromDestination}</td>
                            <td className="mono wrap">{h.toDestination}</td>
                            <td>
                              <StatusBadge
                                dimension="destinationChange"
                                value={h.status}
                                source="escrow contract view"
                                observedAt={t.receivedAt}
                                compact
                              />
                            </td>
                            <td className="mono">{h.closedAt === null ? "Open" : formatUtc(h.closedAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableScroller>
                )}
              </section>
            </>
          );
        }}
      </Section>
    </section>
  );
}
