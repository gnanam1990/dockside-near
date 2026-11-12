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
  FunctionCall,
  FunderWalletCall,
  LedgerView,
  Prepared,
  PreparedRefund,
  RefundCandidate,
  RefundIntentView,
  RefundPolicyRow,
  RefundRole,
  RefundView,
} from "../../lib/api/trade";
import { formatUntil, formatUtc } from "../../lib/format";
import { describeStatus } from "../../lib/status";
import { Near, Section, useTrade } from "./common";
import { OperationDetail } from "./Operation";

/**
 * UI-SPEC §3.8 refund and cancellation over `dockside-refund-v1` revision 1.
 *
 * Every number and state here is the escrow contract's view as the API served it; eligibility is
 * the API's labelled projection of the contract ledger, and the contract recomputes it at submit.
 * The browser decides nothing: it shows which signed action the bound role may start, recomputes
 * every digest before signing, and relays calls the contract re-verifies. A funder return is the
 * original funder's own transaction; no session can submit it, so the UI shows the exact call for
 * that wallet (no wallet connector in this build: BLOCKED).
 */

const FUNDER_RETURNS = ["PARTIAL_FUNDING_RETURN", "EXCESS_FUNDING_RETURN"];
const LIVE_LOCKED = ["EXECUTING", "PROCESSING", "UNKNOWN", "REVIEW", "RECONCILING", "ADJUDICATION"];

const REASON_LABEL: Record<string, string> = {
  TRADE_EXPIRY: "Trade expiry",
  INSPECTION_FAIL: "Inspection fail",
  PERMANENT_HOLD: "Permanent hold",
  MUTUAL_CANCEL: "Mutual cancellation",
  BUYER_KEY_LOSS: "Buyer key loss",
  SUPPLIER_KEY_LOSS: "Supplier key loss",
  INSPECTOR_KEY_LOSS: "Inspector key loss",
  PARTIAL_FUNDING_RETURN: "Partial funding return",
  EXCESS_FUNDING_RETURN: "Excess funding return",
};

const ROLE_LABEL: Record<string, string> = {
  BUYER: "buyer approver",
  SUPPLIER: "supplier signer",
  RISK_RESOLVER: "risk/policy resolver",
  FUNDER: "original funder (own NEAR account)",
};

const reasonLabel = (r: string) => REASON_LABEL[r] ?? r;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

function refused(reason: string): ApiOutcome<Prepared> {
  return { ok: false, error: { kind: "refused-to-sign", reason }, receivedAt: Date.now() };
}

/** SHA-256 of a statement typed in this browser; only the digest leaves the page. */
async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Which role may initiate a reason (mirrors the server; the server and contract decide). */
function mayInitiate(reason: string, role: RefundRole | null): boolean {
  if (role === null) return false;
  if (reason === "PERMANENT_HOLD") return role === "RISK_RESOLVER";
  return role === "BUYER" || role === "SUPPLIER";
}

/* --------------------------------- deposits --------------------------------- */

const BUCKETS = [
  ["partial", "Partial"],
  ["available", "Available"],
  ["reserved", "Reserved"],
  ["released", "Released"],
  ["refundLocked", "Refund-locked"],
  ["refunded", "Refunded"],
  ["quarantined", "Quarantined"],
] as const;

function Deposits({ ledger, observedAt }: { ledger: LedgerView; observedAt: number }) {
  const t = useTrade();
  const net = t.p.trade.network;
  return (
    <section aria-labelledby="dep-title" data-testid="deposits">
      <h3 id="dep-title">Accepted deposits by original funder</h3>
      <TableScroller label="Funder buckets">
        <table data-testid="funder-buckets">
          <caption>Per-funder buckets (escrow contract view, {formatUtc(observedAt)})</caption>
          <thead>
            <tr>
              <th scope="col">Original funder</th>
              {BUCKETS.map(([k, label]) => (
                <th key={k} scope="col">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Object.entries(ledger.funders).map(([f, b]) => (
              <tr key={f} data-funder={f}>
                <th scope="row" className="mono wrap">
                  {f}
                </th>
                {BUCKETS.map(([k]) => (
                  <td key={k} data-bucket={k} data-yocto={b[k]}>
                    <Near yocto={b[k]} network={net} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroller>
      <TableScroller label="Deposits">
        <table>
          <caption>Deposits in contract order ({ledger.deposits.length})</caption>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Funder</th>
              <th scope="col">Sent</th>
              <th scope="col">Accepted</th>
              <th scope="col">Quarantined</th>
              <th scope="col">Recorded</th>
            </tr>
          </thead>
          <tbody>
            {ledger.deposits.map((d) => (
              <tr key={d.index}>
                <td className="tabular">{d.index}</td>
                <td className="mono wrap">{d.funder}</td>
                <td>
                  <Near yocto={d.amount} network={net} />
                </td>
                <td>
                  <Near yocto={d.accepted} network={net} />
                </td>
                <td>
                  <Near yocto={d.quarantined} network={net} />
                </td>
                <td className="mono">{formatUtc(d.atMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroller>
      <p className="small">
        Required <Near yocto={ledger.required} network={net} />, fully funded:{" "}
        {ledger.fullyFunded ? "yes" : "no"}. Partial funding stays unavailable for release; excess above the
        required amount is QUARANTINED for its own funder and never refundable as release value. Conservation:{" "}
        {ledger.conservation ? "holds (contract recomputation)" : "VIOLATED — see incidents"}.
      </p>
    </section>
  );
}

/* ---------------------------------- policy ---------------------------------- */

function PolicyMatrix({ policy }: { policy: RefundView["policy"] }) {
  return (
    <section aria-labelledby="policy-title" data-testid="refund-policy">
      <h3 id="policy-title">
        Signed refund policy: <code>{policy.id}</code> revision {policy.revision}
      </h3>
      <p className="small">
        Both parties signed this policy with the trade; the contract enforces each row. Text served by the
        API.
      </p>
      <div className="stack-list">
        {policy.rows.map((r: RefundPolicyRow) => (
          <details key={r.reason} data-testid={`policy-row-${r.reason}`}>
            <summary>
              {reasonLabel(r.reason)} <code>{r.reason}</code>
              {r.submit ? null : " — recovery-first, no automatic refund"}
            </summary>
            <IdentityList
              items={[
                ["Initiator", r.initiator],
                ["Signers", r.signers],
                ["Clock origin and duration", r.clock],
                ["Evidence", r.evidence],
                ["Challenge or appeal", r.challenge],
                ["Eligible amount and recipient", r.eligible],
                ["Source bucket", r.sourceBucket],
                ["Revocation", r.revocation],
                [
                  "Unknown submit outcome",
                  "Stays UNKNOWN with the slice locked until the reconciler proves the outcome",
                ],
              ]}
            />
          </details>
        ))}
      </div>
    </section>
  );
}

/* --------------------------------- funder wallet --------------------------------- */

function FunderWalletPanel({ w, what }: { w: FunderWalletCall; what: string }) {
  return (
    <Callout
      tone="warning"
      icon="blocked"
      title={`${what}: the funder's own wallet submits`}
      headingLevel={3}
    >
      <div data-testid="funder-wallet">
        <p>
          Only <code className="wrap">{w.signerId}</code> can submit this call; the contract checks the
          transaction signer, so no Dockside session or relayer can send it in the funder's place. This build
          has no wallet connector (BLOCKED): hand the exact call below to that account's wallet.
        </p>
        <IdentityList
          items={[
            ["Signer account", <code key="s">{w.signerId}</code>],
            ["Contract", <code key="c">{w.call.receiverId}</code>],
            ["Method", <code key="m">{w.call.methodName}</code>],
            ["Attached deposit", `${w.call.depositYocto} yoctoNEAR`],
          ]}
        />
        <h4>Exact call for the funder's wallet</h4>
        <AddressDisplay value={JSON.stringify(w.call)} label="contract call" />
      </div>
    </Callout>
  );
}

function FunderReturnStart({ c, onChange }: { c: RefundCandidate; onChange: () => void }) {
  const t = useTrade();
  const gate = useMutationGate();
  const [prepared, setPrepared] = useState<PreparedRefund | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const id = `refund-${slug(c.reason)}-${slug(c.funder)}`;
  return (
    <section className="action" aria-labelledby={`${id}-title`} data-testid={`action-${id}`}>
      <h3 id={`${id}-title`}>
        {reasonLabel(c.reason)} for <code className="wrap">{c.funder}</code>
      </h3>
      <p>
        Locks exactly <Near yocto={c.amountYocto ?? "0"} network={t.p.trade.network} /> from the{" "}
        <code>{c.sourceBucket}</code> bucket for its original funder, with a 1-hour cooling period. The
        recipient can only be that funder.
      </p>
      <button
        type="button"
        className="btn"
        disabled={!gate.allowed}
        onClick={() =>
          void (async () => {
            t.busy(id)(true);
            const out = await t.api.call<PreparedRefund>("refundChallenge", {
              params: { id: t.tradeId },
              body: { reason: c.reason, funder: c.funder },
            });
            if (!out.ok) {
              t.busy(id)(false);
              return setFailure(out.error);
            }
            setFailure(null);
            setPrepared(out.data);
            onChange();
          })()
        }
      >
        Prepare funder return call
      </button>
      {prepared?.funderWallet ? (
        <>
          <p role="status" data-testid={`prepared-${id}`}>
            Prepared refund intent <code>{prepared.refundIntentId}</code> (digest{" "}
            <code className="wrap">{prepared.digest}</code>).
          </p>
          <FunderWalletPanel w={prepared.funderWallet} what={reasonLabel(c.reason)} />
        </>
      ) : null}
      {failure ? <FailureState failure={failure} what={reasonLabel(c.reason)} headingLevel={3} /> : null}
    </section>
  );
}

/* --------------------------------- start a request --------------------------------- */

function PartyRequestStart({
  c,
  role,
  onChange,
}: {
  c: RefundCandidate;
  role: RefundRole;
  onChange: () => void;
}) {
  const t = useTrade();
  const id = `refund-${slug(c.reason)}-${slug(c.funder)}`;
  const [rid, setRid] = useState<string | null>(null);
  const second =
    c.reason === "MUTUAL_CANCEL"
      ? `the ${role === "BUYER" ? "supplier signer" : "buyer approver"} must sign the identical digest, then a 1-hour revocation period runs`
      : c.reason === "PERMANENT_HOLD"
        ? "the supplier signer must also sign, then a 48-hour cooling period runs"
        : c.reason === "INSPECTION_FAIL"
          ? "the supplier may appeal for 48 hours; then the risk/policy resolver authorizes separately"
          : "buyer or supplier may dispute for 24 hours before authorization";
  return (
    <SignedAction
      id={id}
      onBusyChange={t.busy(id)}
      title={`${reasonLabel(c.reason)} refund to ${c.funder}`}
      intro={
        <p>
          Locks exactly <Near yocto={c.amountYocto ?? "0"} network={t.p.trade.network} /> from the{" "}
          <code>{c.sourceBucket}</code> bucket, returned only to the original funder{" "}
          <code className="wrap">{c.funder}</code>.
        </p>
      }
      consequence={`Your signature as ${ROLE_LABEL[role]} requests a ${c.reason} refund of this exact slice to its original funder; ${second}. The contract recomputes the slice and refuses a stale request.`}
      startLabel="Prepare refund request"
      signLabel="Sign refund request"
      prepare={async () => {
        const out = await t.api.call<PreparedRefund>("refundChallenge", {
          params: { id: t.tradeId },
          body: { reason: c.reason, funder: c.funder },
        });
        if (out.ok) setRid(out.data.refundIntentId);
        return out;
      }}
      record={(_payload, signature) =>
        rid === null
          ? Promise.resolve(refused("no prepared refund intent") as never)
          : t.api.call<{ relay: FunctionCall }>("refundRequestSignature", {
              params: { id: t.tradeId, rid },
              body: { signature },
            })
      }
      onDone={onChange}
    />
  );
}

function Candidates({ v, onChange }: { v: RefundView; onChange: () => void }) {
  const t = useTrade();
  const net = t.p.trade.network;
  const starts = v.candidates.filter(
    (c) =>
      (c.blockedBy === null && mayInitiate(c.reason, v.viewerRole)) ||
      t.pinned(`refund-${slug(c.reason)}-${slug(c.funder)}`),
  );
  return (
    <section aria-labelledby="cand-title" data-testid="refund-candidates">
      <h3 id="cand-title">Refund and cancellation eligibility</h3>
      <p className="small">
        {v.candidateSource}. Observed {formatUtc(v.observedAt)}.
      </p>
      <TableScroller label="Refund eligibility">
        <table data-testid="candidate-table">
          <caption>Per funder and reason row</caption>
          <thead>
            <tr>
              <th scope="col">Funder</th>
              <th scope="col">Reason</th>
              <th scope="col">Source bucket</th>
              <th scope="col">Eligible amount</th>
              <th scope="col">Why not</th>
            </tr>
          </thead>
          <tbody>
            {v.candidates.map((c) => (
              <tr
                key={`${c.funder}|${c.reason}`}
                data-testid="candidate"
                data-funder={c.funder}
                data-reason={c.reason}
                data-blocked={c.blockedBy ?? ""}
              >
                <td className="mono wrap">{c.funder}</td>
                <td>{reasonLabel(c.reason)}</td>
                <td className="mono">{c.sourceBucket ?? "—"}</td>
                <td>{c.amountYocto ? <Near yocto={c.amountYocto} network={net} /> : "—"}</td>
                <td>
                  {c.blockedBy ? (
                    <>
                      <code>{c.blockedBy}</code> {c.blockedReason}
                    </>
                  ) : (
                    "Eligible now (projection)"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroller>
      {v.viewerRole === null ? (
        <BlockedAction reason="Only the trade's bound buyer approver, supplier signer or risk/policy resolver acts on refunds." />
      ) : starts.length === 0 ? (
        <p data-testid="no-refund-start">
          Nothing you may start right now. A refund cannot be offered while release value is held by a release
          intent or an unresolved operation, or while a live refund already locks the slice.
        </p>
      ) : (
        starts.map((c) =>
          FUNDER_RETURNS.includes(c.reason) ? (
            <FunderReturnStart key={`${c.funder}|${c.reason}`} c={c} onChange={onChange} />
          ) : (
            <PartyRequestStart
              key={`${c.funder}|${c.reason}`}
              c={c}
              role={v.viewerRole as RefundRole}
              onChange={onChange}
            />
          ),
        )
      )}
    </section>
  );
}

/* --------------------------------- intent actions --------------------------------- */

function cosignerFor(r: RefundIntentView, role: RefundRole | null): boolean {
  if (r.state !== "REQUESTED" || role === null) return false;
  if (r.reason === "MUTUAL_CANCEL")
    return (role === "BUYER" && !r.buyerSigned) || (role === "SUPPLIER" && !r.supplierSigned);
  if (r.reason === "PERMANENT_HOLD") return role === "SUPPLIER" && !r.supplierSigned;
  return false;
}

function mayRevoke(r: RefundIntentView, role: RefundRole | null): boolean {
  if (role === null) return false;
  const before = ["REQUESTED", "TIMELOCKED"].includes(r.state);
  switch (r.reason) {
    case "PARTIAL_FUNDING_RETURN":
    case "EXCESS_FUNDING_RETURN":
      return (role === "BUYER" || role === "SUPPLIER") && (before || r.state === "AUTHORIZED");
    case "TRADE_EXPIRY":
      return role === r.initiatorRole && before;
    case "MUTUAL_CANCEL":
      return (role === "BUYER" || role === "SUPPLIER") && before;
    case "INSPECTION_FAIL":
      return role === "RISK_RESOLVER" && (before || r.state === "AUTHORIZED" || r.state === "REVIEW");
    case "PERMANENT_HOLD":
      return (role === "RISK_RESOLVER" || role === "SUPPLIER") && before;
    default:
      return false;
  }
}

const DISPUTERS: Record<string, readonly RefundRole[]> = {
  TRADE_EXPIRY: ["BUYER", "SUPPLIER"],
  INSPECTION_FAIL: ["SUPPLIER"],
  PARTIAL_FUNDING_RETURN: ["BUYER", "SUPPLIER"],
  EXCESS_FUNDING_RETURN: ["BUYER", "RISK_RESOLVER"],
};

function Cosign({ r, id, onChange }: { r: RefundIntentView; id: string; onChange: () => void }) {
  const t = useTrade();
  return (
    <SignedAction
      id={id}
      onBusyChange={t.busy(id)}
      title="Review and cosign this refund request"
      intro={
        <p>
          The {ROLE_LABEL[r.initiatorRole] ?? r.initiatorRole} signed request digest{" "}
          <code className="wrap">{r.requestDigest}</code>. You sign the identical payload or nothing.
        </p>
      }
      consequence={`Your signature is the second consent to a ${r.reason} refund of this exact slice to ${r.funder}. The contract then starts the policy clock; either signer may still revoke before the deadline.`}
      startLabel="Review the exact request"
      signLabel="Sign the identical request"
      prepare={async () => {
        const out = await t.api.call<Prepared>("refundCosignChallenge", {
          params: { id: t.tradeId, rid: r.refundIntentId },
          body: {},
        });
        if (out.ok && out.data.digest !== r.requestDigest)
          return refused("the payload served is not the digest the contract holds; nothing was signed");
        return out;
      }}
      record={(_payload, signature) =>
        t.api.call("refundCosignature", {
          params: { id: t.tradeId, rid: r.refundIntentId },
          body: { signature },
        })
      }
      onDone={onChange}
    />
  );
}

function Revoke({ r, id, onChange }: { r: RefundIntentView; id: string; onChange: () => void }) {
  const t = useTrade();
  const gate = useMutationGate();
  const [w, setW] = useState<FunderWalletCall | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  if (r.funderWalletRequired)
    return (
      <section className="action" aria-labelledby={`${id}-title`} data-testid={`action-${id}`}>
        <h3 id={`${id}-title`}>Revoke this funder return</h3>
        <p>
          Revocation returns the slice to <code>{r.sourceBucket}</code>
          {r.sourceBucket === "QUARANTINED" ? " (excess stays quarantined for its funder)" : ""}. Only the
          funder's own account submits it.
        </p>
        <button
          type="button"
          className="btn"
          disabled={!gate.allowed}
          onClick={() =>
            void (async () => {
              t.busy(id)(true);
              const out = await t.api.call<Prepared & { funderWallet?: FunderWalletCall }>(
                "refundRevocationChallenge",
                { params: { id: t.tradeId, rid: r.refundIntentId }, body: {} },
              );
              if (!out.ok) {
                t.busy(id)(false);
                return setFailure(out.error);
              }
              setFailure(null);
              setW(out.data.funderWallet ?? null);
            })()
          }
        >
          Prepare funder revocation call
        </button>
        {w ? <FunderWalletPanel w={w} what="Revocation" /> : null}
        {failure ? <FailureState failure={failure} what="Revocation" headingLevel={3} /> : null}
      </section>
    );
  return (
    <SignedAction
      id={id}
      onBusyChange={t.busy(id)}
      title="Revoke this refund request"
      consequence={`Your signature revokes refund intent ${r.refundIntentId} before authorization. The slice returns to its recorded ${r.sourceBucket} bucket.`}
      startLabel="Prepare revocation"
      signLabel="Sign revocation"
      prepare={() =>
        t.api.call<Prepared>("refundRevocationChallenge", {
          params: { id: t.tradeId, rid: r.refundIntentId },
          body: {},
        })
      }
      record={(payload, signature) =>
        t.api.call("refundRevocation", {
          params: { id: t.tradeId, rid: r.refundIntentId },
          body: { payload, signature },
        })
      }
      onDone={onChange}
    />
  );
}

function Dispute({ r, id, onChange }: { r: RefundIntentView; id: string; onChange: () => void }) {
  const t = useTrade();
  const [code, setCode] = useState("ACCOUNTING_DISPUTE");
  const [statement, setStatement] = useState("");
  const [err, setErr] = useState<string | undefined>(undefined);
  return (
    <SignedAction
      id={id}
      onBusyChange={t.busy(id)}
      title={r.reason === "INSPECTION_FAIL" ? "Appeal this refund" : "Dispute this refund"}
      consequence="Your signature records a dispute before execution. The contract pauses the refund in REVIEW; the slice stays locked until it is resolved."
      startLabel="Prepare dispute"
      signLabel="Sign dispute"
      prepare={async () => {
        if (!/^[A-Z0-9_]{1,64}$/.test(code)) {
          setErr("Use capital letters, digits and underscores only.");
          return refused("the reason code is not a valid code; nothing was prepared");
        }
        if (statement.trim() === "") {
          setErr("Describe the dispute; only its SHA-256 digest is sent.");
          return refused("no dispute statement; nothing was prepared");
        }
        return t.api.call<Prepared>("refundDisputeChallenge", {
          params: { id: t.tradeId, rid: r.refundIntentId },
          body: { reasonCode: code, evidenceDigest: await sha256Hex(statement) },
        });
      }}
      record={(payload, signature) =>
        t.api.call("refundDispute", {
          params: { id: t.tradeId, rid: r.refundIntentId },
          body: { payload, signature },
        })
      }
      onDone={onChange}
    >
      <Field id={`${id}-code`} label="Dispute reason code" error={err}>
        {(aria) => (
          <input
            {...aria}
            className="mono"
            value={code}
            onChange={(e) => {
              setCode(e.target.value.trim().toUpperCase());
              setErr(undefined);
            }}
          />
        )}
      </Field>
      <Field
        id={`${id}-statement`}
        label="Dispute statement"
        help="Stays in this browser; the signed payload carries only its SHA-256 digest."
      >
        {(aria) => (
          <textarea
            {...aria}
            rows={3}
            value={statement}
            onChange={(e) => {
              setStatement(e.target.value);
              setErr(undefined);
            }}
          />
        )}
      </Field>
    </SignedAction>
  );
}

function Authorize({ r, id, onChange }: { r: RefundIntentView; id: string; onChange: () => void }) {
  const t = useTrade();
  const app = useApp();
  const gate = useMutationGate();
  const [call, setCall] = useState<FunctionCall | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  return (
    <section className="action" aria-labelledby={`${id}-title`} data-testid={`action-${id}`}>
      <h3 id={`${id}-title`}>Authorize after the deadline</h3>
      <p>
        Authorization is a relay anyone may send; the contract checks its own clock against the deadline
        {r.deadline !== null ? ` ${formatUtc(r.deadline)} (${formatUntil(r.deadline, app.now)})` : ""},
        disputes, holds and the release lock. Before the deadline it refuses.
      </p>
      <button
        type="button"
        className="btn"
        disabled={!gate.allowed}
        onClick={() =>
          void (async () => {
            t.busy(id)(true);
            setRefusal(null);
            setCall(null);
            const out = await t.api.call<{ relay: FunctionCall }>("refundAuthorization", {
              params: { id: t.tradeId, rid: r.refundIntentId },
              body: {},
            });
            if (!out.ok) {
              t.busy(id)(false);
              return setFailure(out.error);
            }
            setFailure(null);
            setCall(out.data.relay);
          })()
        }
      >
        Prepare authorization
      </button>
      {call ? (
        <RelayPanel
          key={JSON.stringify(call.args) + String(refusal)}
          call={call}
          label="Authorize refund"
          onRelayed={(res) => {
            if (res.outcome === "FINAL_SUCCESS") onChange();
            else setRefusal(res.error ?? res.outcome);
          }}
        />
      ) : null}
      {refusal ? (
        <p role="alert" data-testid={`refusal-${id}`}>
          The contract refused authorization: <code>{refusal}</code>. Nothing changed; the slice stays locked.
        </p>
      ) : null}
      {failure ? <FailureState failure={failure} what="Refund authorization" headingLevel={3} /> : null}
    </section>
  );
}

function SignedAuthorize({ r, id, onChange }: { r: RefundIntentView; id: string; onChange: () => void }) {
  const t = useTrade();
  return (
    <SignedAction
      id={id}
      onBusyChange={t.busy(id)}
      title="Authorize the inspection-fail refund"
      consequence="Your risk/policy signature authorizes this refund after the appeal window. Execution then returns the slice to its original funder."
      startLabel="Prepare authorization"
      signLabel="Sign authorization"
      prepare={() =>
        t.api.call<Prepared>("refundAuthorizationChallenge", {
          params: { id: t.tradeId, rid: r.refundIntentId },
          body: {},
        })
      }
      record={(payload, signature) =>
        t.api.call("refundAuthorizationSignature", {
          params: { id: t.tradeId, rid: r.refundIntentId },
          body: { payload, signature },
        })
      }
      onDone={onChange}
    />
  );
}

function Execute({ r, id, onChange }: { r: RefundIntentView; id: string; onChange: () => void }) {
  const t = useTrade();
  const gate = useMutationGate();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  return (
    <section className="action" aria-labelledby={`${id}-title`} data-testid={`action-${id}`}>
      <h3 id={`${id}-title`}>Execute the authorized refund</h3>
      <button
        type="button"
        className="btn btn--primary"
        disabled={!gate.allowed}
        onClick={() => setOpen(true)}
      >
        Execute refund
      </button>
      <ConfirmDialog
        open={open}
        title="Execute refund"
        confirmLabel="Queue refund"
        onCancel={() => setOpen(false)}
        onConfirm={() => {
          setOpen(false);
          t.busy(id)(true);
          void (async () => {
            const out = await t.api.call<{ operationId: string; state: string }>("refundExecute", {
              params: { id: t.tradeId, rid: r.refundIntentId },
              body: {},
            });
            if (!out.ok) {
              t.busy(id)(false);
              return setFailure(out.error);
            }
            setFailure(null);
            setResult(`Operation ${out.data.operationId} is ${out.data.state}.`);
            onChange();
          })();
        }}
      >
        <IdentityList
          items={[
            ["Refund intent", <code key="i">{r.refundIntentId}</code>],
            ["Reason", r.reason],
            ["Amount", <Near key="a" yocto={r.amount} network={t.p.trade.network} />],
            [
              "Recipient (original funder)",
              <code key="f" className="wrap">
                {r.funder}
              </code>,
            ],
            ["Source bucket", r.sourceBucket],
          ]}
        />
        <p>
          The economic-operation journal submits it once. If the outcome is not proven, the slice stays locked
          for reconciliation; there is no retry button.
        </p>
      </ConfirmDialog>
      <p role="status" data-testid={`execute-status-${id}`}>
        {result}
      </p>
      {failure ? <FailureState failure={failure} what="Execute refund" headingLevel={3} /> : null}
    </section>
  );
}

function IntentCard({ r, v, onChange }: { r: RefundIntentView; v: RefundView; onChange: () => void }) {
  const t = useTrade();
  const app = useApp();
  const role = v.viewerRole;
  const key = slug(r.refundIntentId);
  const pin = (k: string) => t.pinned(`${k}-${key}`);
  const locked = LIVE_LOCKED.includes(r.state);
  const disputers = DISPUTERS[r.reason] ?? [];
  const canDispute =
    role !== null && disputers.includes(role) && ["TIMELOCKED", "AUTHORIZED"].includes(r.state) && !r.dispute;
  const consent = (signed: boolean) => (signed ? "Signed" : "Not signed");
  return (
    <article
      className="operation"
      data-testid="refund-intent"
      data-state={r.state}
      data-reason={r.reason}
      data-id={r.refundIntentId}
      aria-labelledby={`rf-${key}`}
    >
      <h4 id={`rf-${key}`}>
        {reasonLabel(r.reason)} <code>{r.refundIntentId}</code>
      </h4>
      <StatusBadge
        dimension="refundState"
        value={r.state}
        source="escrow contract view"
        observedAt={v.observedAt}
      />
      <IdentityList
        items={[
          [
            "Original funder (recipient)",
            <code key="f" className="wrap">
              {r.funder}
            </code>,
          ],
          ["Amount", <Near key="a" yocto={r.amount} network={t.p.trade.network} />],
          ["Source bucket", <code key="b">{r.sourceBucket}</code>],
          ["Initiator", ROLE_LABEL[r.initiatorRole] ?? r.initiatorRole],
          [
            "Consents",
            r.reason === "MUTUAL_CANCEL"
              ? `Buyer approver: ${consent(r.buyerSigned)}; supplier signer: ${consent(r.supplierSigned)}`
              : r.reason === "PERMANENT_HOLD"
                ? `Risk/policy: ${consent(r.riskSigned)}; supplier signer: ${consent(r.supplierSigned)}`
                : FUNDER_RETURNS.includes(r.reason)
                  ? "The funder's own transaction"
                  : `Initiator signature recorded${r.riskSigned ? "; risk/policy authorization signed" : ""}`,
          ],
          ["Clock origin", r.clockOrigin === null ? "Not started" : formatUtc(r.clockOrigin)],
          [
            "Deadline",
            r.deadline === null ? (
              "Not started"
            ) : (
              <span key="d" data-testid="refund-deadline">
                {formatUtc(r.deadline)} ({formatUntil(r.deadline, app.now)})
              </span>
            ),
          ],
          [
            "Dispute",
            r.dispute
              ? `${r.dispute.role} at ${formatUtc(r.dispute.at)} (digest ${r.dispute.digest})`
              : "None",
          ],
          [
            "Request digest",
            <code key="g" className="wrap">
              {r.requestDigest}
            </code>,
          ],
          [
            "Payload",
            r.payloadJournaled
              ? "Journaled by this API (the exact signed payload is reviewable)"
              : "Not journaled by this API",
          ],
        ]}
      />
      <details>
        <summary>Contract history ({r.history.length})</summary>
        <ol className="small">
          {r.history.map(([s, at]) => (
            <li key={`${s}-${at}`}>
              {describeStatus("refundState", s).label} — {formatUtc(at)}
            </li>
          ))}
        </ol>
      </details>
      {locked ? (
        <Callout
          tone="unknown"
          icon="locked"
          title="Refund locked until reconciled"
          headingLevel={3}
          testId="refund-locked"
        >
          <p>
            While {r.state}, the slice stays locked: no new refund, release, retry or terminal override.{" "}
            {r.dispute && r.state === "REVIEW"
              ? `A ${r.dispute.role} dispute paused it before execution; it stays in REVIEW until the policy row's allowed signer revokes it. Authorization and execution are refused.`
              : "Only the risk/policy resolver may request reconciliation or adjudication from REVIEW or ADJUDICATION, on the refund operation below."}
          </p>
        </Callout>
      ) : null}
      {r.state === "FAILED" ? (
        <p>
          Authoritative no-transfer evidence restored the exact <code>{r.sourceBucket}</code> bucket. Another
          attempt needs a new refund intent.
        </p>
      ) : null}
      {cosignerFor(r, role) || pin(`cosign`) ? (
        <Cosign r={r} id={`cosign-${key}`} onChange={onChange} />
      ) : null}
      {mayRevoke(r, role) || pin("revoke") ? <Revoke r={r} id={`revoke-${key}`} onChange={onChange} /> : null}
      {canDispute || pin("dispute") ? <Dispute r={r} id={`dispute-${key}`} onChange={onChange} /> : null}
      {(r.state === "TIMELOCKED" && !r.dispute && r.reason !== "INSPECTION_FAIL" && role !== null) ||
      pin("authorize") ? (
        <Authorize r={r} id={`authorize-${key}`} onChange={onChange} />
      ) : null}
      {(r.state === "TIMELOCKED" && r.reason === "INSPECTION_FAIL" && role === "RISK_RESOLVER") ||
      pin("sauthorize") ? (
        <SignedAuthorize r={r} id={`sauthorize-${key}`} onChange={onChange} />
      ) : null}
      {(r.state === "AUTHORIZED" && role !== null) || pin("execute") ? (
        <Execute r={r} id={`execute-${key}`} onChange={onChange} />
      ) : null}
    </article>
  );
}

/* ---------------------------------- tab ---------------------------------- */

export function RefundTab() {
  const t = useTrade();
  const ref = useApiData(() => t.api.refund(t.tradeId), [t.tradeId, t.tick]);
  const changed = async () => {
    await t.api.sync(t.tradeId);
    t.refresh();
  };
  return (
    <Section what="refund" state={ref.state} outcome={ref.outcome} reload={ref.reload}>
      {(v: RefundView) => (
        <>
          <Deposits ledger={v.ledger} observedAt={v.observedAt} />
          <Candidates v={v} onChange={() => void changed()} />
          <section aria-labelledby="refunds-title" data-testid="refund-rows">
            <h3 id="refunds-title">Refund intents</h3>
            {v.refunds.length === 0 ? <p>No refund intent exists (escrow contract view).</p> : null}
            {v.refunds.map((r) => (
              <IntentCard key={r.refundIntentId} r={r} v={v} onChange={() => void changed()} />
            ))}
          </section>
          {v.operations.length ? (
            <section aria-labelledby="rop-title" data-testid="refund-operations">
              <h3 id="rop-title">Refund operations (economic-operation journal)</h3>
              {v.operations.map((o) => (
                <OperationDetail key={o.operationId} operationId={o.operationId} />
              ))}
            </section>
          ) : null}
          <PolicyMatrix policy={v.policy} />
          <section aria-labelledby="assets-title">
            <h3 id="assets-title">Asset recovery review</h3>
            <p>
              Unexpected assets are reviewed separately and never appear as refundable native NEAR. This API
              build serves no asset-recovery records, so none are shown.
            </p>
          </section>
        </>
      )}
    </Section>
  );
}
