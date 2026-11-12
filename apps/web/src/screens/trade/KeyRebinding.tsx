import { useRef, useState } from "react";
import { useApiData, useApp, useMutationGate } from "../../app/app-context";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { IdentityList, TableScroller } from "../../components/Data";
import { RelayPanel, SignedAction } from "../../components/SignedAction";
import { BlockedAction, Callout, FailureState } from "../../components/States";
import { StatusBadge } from "../../components/Status";
import type { ApiFailure, ApiOutcome } from "../../lib/api/client";
import type {
  FunctionCall,
  KeyRebindingRecord,
  KeyRebindingView,
  Prepared,
  RebindingPlanRole,
} from "../../lib/api/trade";
import { formatUntil, formatUtc } from "../../lib/format";
import { ROLE_LABEL } from "./Authority";
import { Invalidations } from "./Destination";
import { Section, useTrade } from "./common";

/**
 * Key-rebinding revision (M14, ADR-0017). When a key this revision binds was rotated, revoked or
 * recovered, the authority's rebinding plan names each affected role's current key. Both bound
 * parties sign one successor revision that changes only those key versions (a party whose own key
 * changed signs with its new key; the other party's bound key anchors it), a signed delay applies
 * when a party key changes, and activation is a relay the contract re-checks. Every fact here comes
 * from GET /v1/trades/:id/key-rebinding; the browser only signs payloads it re-digested.
 */

const LOCKED = ["SUBMITTING", "EXECUTING", "PROCESSING", "UNKNOWN", "REVIEW", "RECONCILING", "ADJUDICATION"];

const BLOCK_TEXT: Record<string, string> = {
  NO_ACTIVE_KEY:
    "no current key to rebind to yet (a recovery may still be waiting for proof or for its delay)",
  CAPABILITY_MISSING: "the principal no longer holds the capability; that needs another participant",
  SCOPE_MISMATCH: "the enrollment no longer covers this trade; that needs another service",
  ENROLLMENT_REVOKED: "the enrollment is revoked; that needs another service",
};

function refused(reason: string): ApiOutcome<Prepared> {
  return { ok: false, error: { kind: "refused-to-sign", reason }, receivedAt: Date.now() };
}

const keyLabel = (k: { keyVersion: number | null; keyVersionId?: string | null }) =>
  k.keyVersion === null ? (k.keyVersionId ?? "unknown version") : `v${k.keyVersion}`;

function PlanTable({ v }: { v: KeyRebindingView }) {
  const t = useTrade();
  const rows = v.plan.roles.filter((r) => r.issues.length > 0 || r.to !== null);
  const next = (r: RebindingPlanRole) => {
    if (r.blockedBy) return `Not rebindable: ${BLOCK_TEXT[r.blockedBy] ?? r.blockedBy}.`;
    if (v.plan.deferred.includes(r.role))
      return "Rebound by the next key-rebinding revision (one party key per revision).";
    if (v.plan.rebind.includes(r.role)) return `Rebound to ${r.to ? keyLabel(r.to) : "?"} by this revision.`;
    return "Current";
  };
  return (
    <TableScroller label="Key-rebinding plan">
      <table data-testid="rebinding-plan">
        <caption>Roles whose bound key is no longer the current key (authority rebinding plan)</caption>
        <thead>
          <tr>
            <th scope="col">Role</th>
            <th scope="col">Bound by r{v.boundRevision}</th>
            <th scope="col">Current key</th>
            <th scope="col">Next step</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.role} data-role={r.role} data-blocked={r.blockedBy ?? "no"}>
              <th scope="row">{ROLE_LABEL[r.role] ?? r.role}</th>
              <td>
                <span className="mono">{keyLabel(r.from)}</span>{" "}
                {r.issues.map((i) => (
                  <StatusBadge
                    key={i}
                    dimension="bindingIssue"
                    value={i}
                    source="authority rebinding plan"
                    observedAt={t.receivedAt}
                    compact
                  />
                ))}
              </td>
              <td className="mono wrap">{r.to ? `${keyLabel(r.to)} ${r.to.publicKey}` : "none"}</td>
              <td className="small">{next(r)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroller>
  );
}

function PendingRebinding({ p, v }: { p: KeyRebindingRecord; v: KeyRebindingView }) {
  const app = useApp();
  const t = useTrade();
  return (
    <section aria-labelledby="rebind-pending-title" data-testid="rebinding-pending" data-status={p.status}>
      <h4 id="rebind-pending-title">
        Successor revision r{p.successorRevision}{" "}
        <StatusBadge
          dimension="keyRebinding"
          value={p.status}
          source="escrow contract view"
          observedAt={t.receivedAt}
        />
      </h4>
      <IdentityList
        items={[
          ["Proposed by", p.proposedBy === "BUYER" ? "Buyer approver" : "Supplier signer"],
          ["Proposed", formatUtc(p.proposedAt)],
          [
            "Change",
            `bound keys only: ${p.roles.map((r) => ROLE_LABEL[r] ?? r).join(", ")} (every other signed field is carried over unchanged)`,
          ],
          ["Consent window closes", formatUtc(p.consentDeadline)],
          [
            "Buyer approver consent",
            <span key="b" data-testid="rebind-consent-buyer" data-consented={p.buyerConsentAt ? "yes" : "no"}>
              {p.buyerConsentAt ? `Signed ${formatUtc(p.buyerConsentAt)}` : "Not signed"}
            </span>,
          ],
          [
            "Supplier signer consent",
            <span
              key="s"
              data-testid="rebind-consent-supplier"
              data-consented={p.supplierConsentAt ? "yes" : "no"}
            >
              {p.supplierConsentAt ? `Signed ${formatUtc(p.supplierConsentAt)}` : "Not signed"}
            </span>,
          ],
          [
            "Activation possible from",
            p.delayUntil === null ? (
              p.rebindsParty ? (
                `Not started: the ${Math.round(v.delayMs / 60_000)}-minute delay begins at the second consent (a party key changes)`
              ) : (
                "At the second consent (no party key changes, so no delay)"
              )
            ) : (
              <span key="d" data-testid="rebind-delay-until">
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

function Activation({
  p,
  blocked,
  onChange,
}: {
  p: KeyRebindingRecord;
  blocked: string | null;
  onChange: () => void;
}) {
  const t = useTrade();
  const gate = useMutationGate();
  const [open, setOpen] = useState(false);
  const [call, setCall] = useState<FunctionCall | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [bound, setBound] = useState<string | null>(null);
  const live = t.p.release.liveIntent;
  const bind = async () => {
    const out = await t.api.call<{ revision: number; tradeDigest: string }>("keyRebindingBinding", {
      params: { id: t.tradeId },
      body: {},
    });
    if (!out.ok) return setFailure(out.error);
    setFailure(null);
    setBound(`Revision r${out.data.revision} binds the current keys (digest ${out.data.tradeDigest}).`);
    onChange();
  };
  return (
    <section aria-labelledby="rebind-activate-title" data-testid="rebinding-activation">
      <h4 id="rebind-activate-title">Activate the key-rebinding revision</h4>
      <p>
        Activation is a relay the contract re-checks: both consents, the signed delay when a party key
        changes, the anchoring party key not revoked, no submitted or unresolved release, no live refund.
      </p>
      <button
        type="button"
        className="btn btn--primary"
        disabled={!gate.allowed || blocked !== null}
        onClick={() => setOpen(true)}
      >
        Activate key-rebinding revision
      </button>
      {blocked ? <BlockedAction reason={blocked} /> : null}
      <ConfirmDialog
        open={open}
        title="Activate key-rebinding revision"
        confirmLabel="Prepare activation"
        onCancel={() => setOpen(false)}
        onConfirm={() => {
          setOpen(false);
          t.busy("rebind-activate")(true);
          void (async () => {
            const out = await t.api.call<{ relay: FunctionCall }>("keyRebindingActivation", {
              params: { id: t.tradeId },
              body: {},
            });
            if (!out.ok) {
              t.busy("rebind-activate")(false);
              return setFailure(out.error);
            }
            setFailure(null);
            setCall(out.data.relay);
          })();
        }}
      >
        <IdentityList
          items={[
            ["Successor revision", `r${p.successorRevision}`],
            ["Rebound roles", p.roles.map((r) => ROLE_LABEL[r] ?? r).join(", ")],
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
          label="Activate key-rebinding revision"
          onRelayed={(r) => {
            if (r.outcome === "FINAL_SUCCESS") void bind();
          }}
        />
      ) : null}
      <p role="status" data-testid="rebinding-bound">
        {bound}
      </p>
      {failure ? <FailureState failure={failure} what="Key-rebinding activation" headingLevel={3} /> : null}
    </section>
  );
}

function BindPending({ onChange }: { onChange: () => void }) {
  const t = useTrade();
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  return (
    <Callout tone="warning" icon="pending" title="Activated key rebinding not bound yet" headingLevel={3}>
      <p>
        The contract activated the key-rebinding revision. Binding reads the journaled successor and both
        consents, checks the contract digest and switches evidence, holds and release to it.
      </p>
      <button
        type="button"
        className="btn"
        onClick={() =>
          void t.api.call("keyRebindingBinding", { params: { id: t.tradeId }, body: {} }).then((out) => {
            if (!out.ok) return setFailure(out.error);
            onChange();
          })
        }
      >
        Bind the activated key rebinding
      </button>
      {failure ? <FailureState failure={failure} what="Key-rebinding binding" headingLevel={3} /> : null}
    </Callout>
  );
}

export function KeyRebinding() {
  const t = useTrade();
  const app = useApp();
  const kv = useApiData(() => t.api.keyRebinding(t.tradeId), [t.tradeId, t.tick]);
  const rel = useApiData(() => t.api.release(t.tradeId), [t.tradeId, t.tick]);
  const digest = useRef<string | null>(null);
  const isParty = t.has("BUYER") || t.has("SUPPLIER");
  const myRole = t.has("BUYER") ? "BUYER" : t.has("SUPPLIER") ? "SUPPLIER" : null;
  const changed = async () => {
    await t.api.sync(t.tradeId);
    t.refresh();
  };
  const lockOp = t.p.operations.find((o) => o.lockHeld || LOCKED.includes(o.state));
  return (
    <section aria-labelledby="rebind-title" data-testid="key-rebinding" id="key-rebinding">
      <h3 id="rebind-title">Key-rebinding revision</h3>
      <Section what="key rebinding" state={kv.state} outcome={kv.outcome} reload={kv.reload}>
        {(v: KeyRebindingView) => {
          const p = v.pending;
          const act =
            p ??
            (t.pinned("rebind-activate")
              ? ([...v.history]
                  .filter((h) => h.status === "ACTIVATED")
                  .sort((a, b) => b.successorRevision - a.successorRevision)[0] ?? null)
              : null);
          const open = p !== null && (p.status === "PROPOSED" || p.status === "CONSENTED");
          const mine = p && myRole ? (myRole === "BUYER" ? p.buyerConsentAt : p.supplierConsentAt) : null;
          const needed = v.plan.requiresNewRevision && !open && !v.bindingRequired;
          const activationBlocked = lockOp
            ? `Activation is blocked while operation ${lockOp.operationId} is ${lockOp.state}.`
            : null;
          const startBlocked =
            v.successor === null
              ? v.successorError === "NOT_ELIGIBLE"
                ? "No affected role has a current key to rebind to yet; see the plan above."
                : v.destinationChangePending
                  ? "A destination revision is pending; it must be cancelled or activated first."
                  : `No key-rebinding successor can be prepared now (${v.successorError ?? "not needed"}).`
              : null;
          return (
            <>
              {!v.plan.requiresNewRevision && !open && !v.bindingRequired ? (
                <p data-testid="rebinding-not-needed">
                  Every key revision r{v.boundRevision} binds is still its current usable key; no
                  key-rebinding revision is needed.
                </p>
              ) : null}
              {v.plan.requiresNewRevision ? <PlanTable v={v} /> : null}
              {v.plan.deferred.length ? (
                <p className="small" data-testid="rebinding-deferred">
                  Both party keys changed. The contract accepts at most one party key change per revision,
                  anchored by the other party's bound key, so the{" "}
                  {v.plan.deferred.map((r) => ROLE_LABEL[r] ?? r).join(", ")} key is rebound by the next
                  revision.
                </p>
              ) : null}
              {open && p ? <PendingRebinding p={p} v={v} /> : null}
              {v.bindingRequired && isParty ? <BindPending onChange={() => void changed()} /> : null}
              {(needed || open) && !v.bindingRequired ? (
                <Invalidations release={rel.outcome?.ok ? rel.outcome.data : null} prefix="rebind" />
              ) : null}
              {!isParty && (needed || open) ? (
                <BlockedAction reason="Only the trade's bound buyer approver or supplier signer can sign, cancel or activate a key-rebinding revision." />
              ) : null}
              {isParty &&
              (needed ||
                (open && p?.status === "PROPOSED" && mine === null) ||
                t.pinned("rebind-consent")) ? (
                <SignedAction
                  id="rebind-consent"
                  onBusyChange={t.busy("rebind-consent")}
                  title={open ? "Consent to the key-rebinding revision" : "Start key-rebinding revision"}
                  disabledReason={open ? null : startBlocked}
                  intro={
                    <p>
                      {open && p
                        ? `The ${p.proposedBy === "BUYER" ? "buyer approver" : "supplier signer"} signed a successor that rebinds ${p.roles.map((r) => ROLE_LABEL[r] ?? r).join(", ")}. Check the new keys with the other party out of band before signing.`
                        : "Your signature is the first consent to a successor revision that changes only the bound keys listed above. It never activates without the other party's signature over the same digest."}
                    </p>
                  }
                  consequence={`Your signature (${myRole === "BUYER" ? "buyer approver" : "supplier signer"}) accepts revision r${v.boundRevision + 1}, which binds the current keys. If your own key is rebound you sign with your new key; otherwise with the key revision r${v.boundRevision} binds. Activation then invalidates the manifest attestation, inspection, hold view, release intent and approval of r${v.boundRevision}.`}
                  startLabel={open ? "Review the successor revision" : "Prepare key-rebinding revision"}
                  signLabel="Sign my consent"
                  prepare={async () => {
                    const out = await t.api.call<
                      Prepared & { signerKeyVersionId?: string; roles?: string[] }
                    >("keyRebindingChallenge", { params: { id: t.tradeId }, body: {} });
                    if (!out.ok) return out;
                    if (p && open && out.data.digest !== p.successorDigest)
                      return refused(
                        "the prepared successor does not match the digest pending on the contract; nothing was signed",
                      );
                    const s = app.client.getSession();
                    if (
                      s &&
                      out.data.signerKeyVersionId &&
                      s.grant.keyVersionId !== out.data.signerKeyVersionId
                    )
                      return refused(
                        `this rebinding must be signed with key ${out.data.signerKeyVersionId}; this session holds ${s.grant.keyVersionId}`,
                      );
                    digest.current = out.data.digest ?? null;
                    return out;
                  }}
                  record={(_payload, signature) =>
                    t.api.call("keyRebindingConsent", {
                      params: { id: t.tradeId },
                      body: { successorDigest: digest.current ?? "", signature },
                    })
                  }
                  onDone={() => void changed()}
                />
              ) : null}
              {isParty && (open || t.pinned("rebind-revoke")) ? (
                <SignedAction
                  id="rebind-revoke"
                  onBusyChange={t.busy("rebind-revoke")}
                  title={
                    mine === null && p?.status === "PROPOSED"
                      ? "Reject this key-rebinding revision"
                      : "Cancel key-rebinding revision"
                  }
                  consequence="Your signature revokes the pending key-rebinding revision before activation. The bound keys stay unchanged, so the trade still requires a new revision."
                  startLabel="Prepare cancellation"
                  signLabel="Sign cancellation"
                  prepare={() =>
                    t.api.call<Prepared>("keyRebindingRevocationChallenge", {
                      params: { id: t.tradeId },
                      body: {},
                    })
                  }
                  record={(payload, signature) =>
                    t.api.call("keyRebindingRevocation", {
                      params: { id: t.tradeId },
                      body: { payload, signature },
                    })
                  }
                  onDone={() => void changed()}
                />
              ) : null}
              {isParty && act && (act.status === "CONSENTED" || t.pinned("rebind-activate")) ? (
                <>
                  {act.delayUntil !== null && act.delayUntil > app.now ? (
                    <p data-testid="rebind-delay-countdown">
                      The delay ends {formatUtc(act.delayUntil)} ({formatUntil(act.delayUntil, app.now)}). The
                      server and the contract refuse activation before then.
                    </p>
                  ) : null}
                  <Activation p={act} blocked={activationBlocked} onChange={() => void changed()} />
                </>
              ) : null}
              {v.history.length ? (
                <section aria-labelledby="rebind-history-title">
                  <h4 id="rebind-history-title">Key-rebinding history</h4>
                  <TableScroller label="Key-rebinding history">
                    <table data-testid="rebinding-history">
                      <caption>Key-rebinding revisions (escrow contract view)</caption>
                      <thead>
                        <tr>
                          <th scope="col">Revision</th>
                          <th scope="col">Rebound roles</th>
                          <th scope="col">Status</th>
                          <th scope="col">Closed</th>
                        </tr>
                      </thead>
                      <tbody>
                        {v.history.map((h) => (
                          <tr key={h.successorDigest}>
                            <td className="tabular">r{h.successorRevision}</td>
                            <td>{h.roles.map((r) => ROLE_LABEL[r] ?? r).join(", ")}</td>
                            <td>
                              <StatusBadge
                                dimension="keyRebinding"
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
                </section>
              ) : null}
            </>
          );
        }}
      </Section>
    </section>
  );
}
