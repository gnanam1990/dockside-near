import { useState } from "react";
import { useApiData, useApp, useMutationGate } from "../../app/app-context";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { AddressDisplay, IdentityList, TableScroller } from "../../components/Data";
import { Field } from "../../components/Forms";
import { SignedAction } from "../../components/SignedAction";
import { Callout, FailureState } from "../../components/States";
import { StatusBadge } from "../../components/Status";
import type { ApiFailure, ApiOutcome } from "../../lib/api/client";
import type {
  AssetRecoveryListView,
  AssetRecoveryRecord,
  FunderWalletCall,
  Prepared,
  PreparedAssetRequest,
  RefundRole,
  UnexpectedAssetRecord,
} from "../../lib/api/trade";
import { formatUntil, formatUtc } from "../../lib/format";
import { Section, useTrade } from "./common";

/**
 * UI-SPEC §3.8 "Asset recovery review" (REFUND-POLICY `UNEXPECTED_ASSET_RECOVERY`).
 *
 * Unexpected token/NFT transfers are shown in their own panel and never as refundable native NEAR.
 * Every record and state is the escrow contract's view as the API served it, plus the API's
 * journal of what it prepared, validated and submitted. The browser decides nothing: the claimed
 * sender's steps are the sender's own wallet transactions (shown as exact calls; no wallet
 * connector in this build), risk/policy approval signs the journaled read-only validation, any
 * bound party or risk/policy may challenge, and execution is queued once in the journal while the
 * contract checks its own 72-hour deadline.
 */

const ROLE_LABEL: Record<string, string> = {
  BUYER: "buyer approver",
  SUPPLIER: "supplier signer",
  RISK_RESOLVER: "risk/policy resolver",
  CLAIMANT: "another claimant (own NEAR account)",
  CLAIMED_SENDER: "claimed sender (own NEAR account)",
};
const OPEN = ["REQUESTED", "CHALLENGE_PERIOD"];

function refused(reason: string): ApiOutcome<Prepared> {
  return { ok: false, error: { kind: "refused-to-sign", reason }, receivedAt: Date.now() };
}

async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function Units({ amount, a }: { amount: string; a: UnexpectedAssetRecord }) {
  return (
    <span>
      <span className="mono">{amount}</span> smallest units of <code className="wrap">{a.assetContract}</code>
      {a.tokenId ? (
        <>
          {" "}
          token <code className="wrap">{a.tokenId}</code>
        </>
      ) : null}{" "}
      (not NEAR)
    </span>
  );
}

/** A call only the named NEAR account can submit (the contract checks the transaction signer). */
function WalletPanel({ w, what, who }: { w: FunderWalletCall; what: string; who: string }) {
  return (
    <Callout tone="warning" icon="blocked" title={`${what}: ${who}'s own wallet submits`} headingLevel={3}>
      <div data-testid="asset-wallet">
        <p>
          Only <code className="wrap">{w.signerId}</code> can submit this call; the contract checks the
          transaction signer, which is the proof of control. No Dockside session or relayer can send it in
          that account's place. This build has no wallet connector (BLOCKED): hand the exact call below to
          that account's wallet.
        </p>
        <IdentityList
          items={[
            ["Signer account", <code key="s">{w.signerId}</code>],
            ["Contract", <code key="c">{w.call.receiverId}</code>],
            ["Method", <code key="m">{w.call.methodName}</code>],
            ["Attached deposit", `${w.call.depositYocto} yoctoNEAR`],
          ]}
        />
        <h4>Exact call for that wallet</h4>
        <AddressDisplay value={JSON.stringify(w.call)} label="contract call" />
      </div>
    </Callout>
  );
}

/* ------------------------------- sender request ------------------------------- */

function RequestStart({ a, onChange }: { a: UnexpectedAssetRecord; onChange: () => void }) {
  const t = useTrade();
  const gate = useMutationGate();
  const [hash, setHash] = useState("");
  const [err, setErr] = useState<string | undefined>(undefined);
  const [prepared, setPrepared] = useState<PreparedAssetRequest | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const id = `asset-request-${a.index}`;
  return (
    <section className="action" aria-labelledby={`${id}-title`} data-testid={`action-${id}`}>
      <h4 id={`${id}-title`}>Prepare the claimed sender's recovery request</h4>
      <p>
        The recipient can only be the claimed sender <code className="wrap">{a.claimedSender}</code>, proven
        by that account submitting the request itself. The amount is exactly the observed{" "}
        <Units amount={a.observedAmount} a={a} />.
      </p>
      <Field
        id={`${id}-hash`}
        label="Sender's transfer transaction hash (optional)"
        help="When given, the API looks the transaction up and binds it as evidence only if it delivered this exact record."
        error={err}
      >
        {(aria) => (
          <input
            {...aria}
            className="mono"
            value={hash}
            onChange={(e) => {
              setHash(e.target.value.trim());
              setErr(undefined);
            }}
          />
        )}
      </Field>
      <button
        type="button"
        className="btn"
        disabled={!gate.allowed}
        onClick={() =>
          void (async () => {
            if (hash !== "" && !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(hash)) {
              setErr("A NEAR transaction hash is 32 to 64 base58 characters.");
              return;
            }
            t.busy(id)(true);
            const out = await t.api.call<PreparedAssetRequest>("assetRecoveryRequest", {
              params: { id: t.tradeId },
              body: { assetIndex: a.index, ...(hash ? { transferTxHash: hash } : {}) },
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
        Prepare sender's request call
      </button>
      {prepared ? (
        <>
          <p role="status" data-testid={`prepared-${id}`}>
            Prepared recovery <code>{prepared.recoveryId}</code> (digest{" "}
            <code className="wrap">{prepared.digest}</code>
            ). Transfer evidence{" "}
            {prepared.evidence["transferVerified"]
              ? "verified against the transaction"
              : "is the contract record only"}
            .
          </p>
          <WalletPanel w={prepared.senderWallet} what="Recovery request" who="the claimed sender" />
        </>
      ) : null}
      {failure ? <FailureState failure={failure} what="Recovery request" headingLevel={3} /> : null}
    </section>
  );
}

/* ------------------------------- risk approval ------------------------------- */

function Approve({
  a,
  r,
  onChange,
}: {
  a: UnexpectedAssetRecord;
  r: AssetRecoveryRecord;
  onChange: () => void;
}) {
  const t = useTrade();
  const [report, setReport] = useState<Record<string, unknown> | null>(null);
  const id = `asset-approve-${a.index}`;
  const checks = (report?.["checks"] ?? {}) as Record<string, boolean>;
  return (
    <SignedAction
      id={id}
      onBusyChange={t.busy(id)}
      title="Approve this recovery (risk/policy)"
      consequence={`Your signature approves recovery ${r.recoveryId} of exactly ${r.amount} units to ${r.recipient} over the read-only validation shown, and starts the contract's 72-hour challenge window.`}
      startLabel="Run read-only validation and prepare approval"
      signLabel="Sign approval"
      prepare={async () => {
        const out = await t.api.call<
          Prepared & { validation: { report: Record<string, unknown>; digest: string } }
        >("assetRecoveryApprovalChallenge", { params: { id: t.tradeId, rid: r.recoveryId }, body: {} });
        if (out.ok) setReport(out.data.validation.report);
        else onChange();
        return out;
      }}
      record={(payload, signature) =>
        t.api.call("assetRecoveryApproval", {
          params: { id: t.tradeId, rid: r.recoveryId },
          body: { payload, signature },
        })
      }
      facts={
        report ? (
          <div data-testid={`validation-${a.index}`}>
            <h5>Read-only validation (journaled)</h5>
            <IdentityList
              items={[
                ["Verdict", String(report["verdict"])],
                [
                  "Escrow token balance",
                  <span key="b" className="mono">
                    {String(report["escrowTokenBalance"])}
                  </span>,
                ],
                [
                  "Outstanding observed total",
                  <span key="o" className="mono">
                    {String(report["outstandingObservedTotal"])}
                  </span>,
                ],
                ["Recipient registered on the token", checks["recipientRegistered"] ? "yes" : "no"],
                ["Compiled adapter", String(report["recoveryCapability"])],
              ]}
            />
          </div>
        ) : null
      }
      onDone={onChange}
    />
  );
}

/* ------------------------------- challenge ------------------------------- */

function Challenge({
  a,
  r,
  role,
  onChange,
}: {
  a: UnexpectedAssetRecord;
  r: AssetRecoveryRecord;
  role: RefundRole;
  onChange: () => void;
}) {
  const t = useTrade();
  const [code, setCode] = useState("OWNERSHIP_DISPUTED");
  const [statement, setStatement] = useState("");
  const [err, setErr] = useState<string | undefined>(undefined);
  const id = `asset-challenge-${a.index}`;
  return (
    <SignedAction
      id={id}
      onBusyChange={t.busy(id)}
      title={`Challenge this recovery as ${ROLE_LABEL[role]}`}
      consequence="Your signature records a challenge before the window closes. The contract ends this recovery and the asset returns to review; ownership stays unresolved."
      startLabel="Prepare challenge"
      signLabel="Sign challenge"
      prepare={async () => {
        if (!/^[A-Z0-9_]{1,64}$/.test(code)) {
          setErr("Use capital letters, digits and underscores only.");
          return refused("the reason code is not a valid code; nothing was prepared");
        }
        if (statement.trim() === "") {
          setErr("Describe the challenge; only its SHA-256 digest is sent.");
          return refused("no challenge statement; nothing was prepared");
        }
        return t.api.call<Prepared>("assetRecoveryChallengePayload", {
          params: { id: t.tradeId, rid: r.recoveryId },
          body: { reasonCode: code, evidenceDigest: await sha256Hex(statement) },
        });
      }}
      record={(payload, signature) =>
        t.api.call("assetRecoveryChallenge", {
          params: { id: t.tradeId, rid: r.recoveryId },
          body: { payload, signature },
        })
      }
      onDone={onChange}
    >
      <Field id={`${id}-code`} label="Challenge reason code" error={err}>
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
        label="Challenge statement"
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

function ClaimantChallenge({
  a,
  r,
  onChange,
}: {
  a: UnexpectedAssetRecord;
  r: AssetRecoveryRecord;
  onChange: () => void;
}) {
  const t = useTrade();
  const gate = useMutationGate();
  const [account, setAccount] = useState("");
  const [statement, setStatement] = useState("");
  const [err, setErr] = useState<string | undefined>(undefined);
  const [w, setW] = useState<FunderWalletCall | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const id = `asset-claimant-${a.index}`;
  return (
    <section className="action" aria-labelledby={`${id}-title`} data-testid={`action-${id}`}>
      <h4 id={`${id}-title`}>Prepare another claimant's challenge</h4>
      <p>
        Another account that says it owns this asset challenges from its own wallet; no signature from this
        session is involved.
      </p>
      <Field id={`${id}-account`} label="Claimant NEAR account" error={err}>
        {(aria) => (
          <input
            {...aria}
            className="mono"
            value={account}
            onChange={(e) => {
              setAccount(e.target.value.trim());
              setErr(undefined);
            }}
          />
        )}
      </Field>
      <Field id={`${id}-statement`} label="Claimant statement" help="Only its SHA-256 digest is sent.">
        {(aria) => (
          <textarea {...aria} rows={2} value={statement} onChange={(e) => setStatement(e.target.value)} />
        )}
      </Field>
      <button
        type="button"
        className="btn"
        disabled={!gate.allowed}
        onClick={() =>
          void (async () => {
            if (!/^[a-z0-9._-]{2,64}$/.test(account)) return setErr("Enter the claimant's NEAR account id.");
            if (statement.trim() === "") return setErr("Describe the claim; only its digest is sent.");
            t.busy(id)(true);
            const out = await t.api.call<Prepared & { claimantWallet: FunderWalletCall }>(
              "assetRecoveryChallengePayload",
              {
                params: { id: t.tradeId, rid: r.recoveryId },
                body: {
                  reasonCode: "ANOTHER_OWNER",
                  evidenceDigest: await sha256Hex(statement),
                  claimantAccount: account,
                },
              },
            );
            if (!out.ok) {
              t.busy(id)(false);
              return setFailure(out.error);
            }
            setFailure(null);
            setW(out.data.claimantWallet);
            onChange();
          })()
        }
      >
        Prepare claimant's challenge call
      </button>
      {w ? <WalletPanel w={w} what="Claimant challenge" who="the claimant" /> : null}
      {failure ? <FailureState failure={failure} what="Claimant challenge" headingLevel={3} /> : null}
    </section>
  );
}

/* ------------------------------- revocation ------------------------------- */

function Revoke({
  a,
  r,
  role,
  onChange,
}: {
  a: UnexpectedAssetRecord;
  r: AssetRecoveryRecord;
  role: RefundRole;
  onChange: () => void;
}) {
  const t = useTrade();
  const gate = useMutationGate();
  const [w, setW] = useState<FunderWalletCall | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const id = `asset-revoke-${a.index}`;
  if (role === "RISK_RESOLVER")
    return (
      <SignedAction
        id={id}
        onBusyChange={t.busy(id)}
        title="Revoke this recovery (risk/policy)"
        consequence={`Your signature revokes recovery ${r.recoveryId} before execution; the asset returns to review.`}
        startLabel="Prepare revocation"
        signLabel="Sign revocation"
        prepare={() =>
          t.api.call<Prepared>("assetRecoveryRevocationChallenge", {
            params: { id: t.tradeId, rid: r.recoveryId },
            body: {},
          })
        }
        record={(payload, signature) =>
          t.api.call("assetRecoveryRevocation", {
            params: { id: t.tradeId, rid: r.recoveryId },
            body: { payload, signature },
          })
        }
        onDone={onChange}
      />
    );
  return (
    <section className="action" aria-labelledby={`${id}-title`} data-testid={`action-${id}`}>
      <h4 id={`${id}-title`}>Prepare the claimed sender's revocation</h4>
      <p>The claimed sender may withdraw its own request before execution, from its own account.</p>
      <button
        type="button"
        className="btn"
        disabled={!gate.allowed}
        onClick={() =>
          void (async () => {
            t.busy(id)(true);
            const out = await t.api.call<Prepared & { senderWallet?: FunderWalletCall }>(
              "assetRecoveryRevocationChallenge",
              { params: { id: t.tradeId, rid: r.recoveryId }, body: {} },
            );
            if (!out.ok) {
              t.busy(id)(false);
              return setFailure(out.error);
            }
            setFailure(null);
            setW(out.data.senderWallet ?? null);
          })()
        }
      >
        Prepare sender's revocation call
      </button>
      {w ? <WalletPanel w={w} what="Revocation" who="the claimed sender" /> : null}
      {failure ? <FailureState failure={failure} what="Revocation" headingLevel={3} /> : null}
    </section>
  );
}

/* ------------------------------- execution ------------------------------- */

function Execute({
  a,
  r,
  onChange,
}: {
  a: UnexpectedAssetRecord;
  r: AssetRecoveryRecord;
  onChange: () => void;
}) {
  const t = useTrade();
  const app = useApp();
  const gate = useMutationGate();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const id = `asset-execute-${a.index}`;
  return (
    <section className="action" aria-labelledby={`${id}-title`} data-testid={`action-${id}`}>
      <h4 id={`${id}-title`}>Execute the recovery</h4>
      <p>
        The contract checks its own clock against the deadline
        {r.deadline
          ? ` ${formatUtc(r.deadline)} (${formatUntil(r.deadline, app.now)} on this device's clock)`
          : ""}
        . Before it, the contract refuses and the attempt is recorded as not submitted.
      </p>
      <button
        type="button"
        className="btn btn--primary"
        disabled={!gate.allowed}
        onClick={() => setOpen(true)}
      >
        Execute recovery
      </button>
      <ConfirmDialog
        open={open}
        title="Execute asset recovery"
        confirmLabel="Queue recovery"
        onCancel={() => setOpen(false)}
        onConfirm={() => {
          setOpen(false);
          t.busy(id)(true);
          void (async () => {
            const out = await t.api.call<{ operationId: string; state: string; joined: boolean }>(
              "assetRecoveryExecute",
              {
                params: { id: t.tradeId, rid: r.recoveryId },
                body: {},
              },
            );
            if (!out.ok) {
              t.busy(id)(false);
              return setFailure(out.error);
            }
            setFailure(null);
            setResult(
              `Operation ${out.data.operationId} is ${out.data.state}${out.data.joined ? " (joined the existing one)" : ""}.`,
            );
            onChange();
          })();
        }}
      >
        <IdentityList
          items={[
            ["Recovery", <code key="r">{r.recoveryId}</code>],
            ["Asset record", `#${a.index} ${a.standard}`],
            ["Amount", <Units key="a" amount={r.amount ?? a.observedAmount} a={a} />],
            [
              "Recipient (proven sender)",
              <code key="p" className="wrap">
                {r.recipient}
              </code>,
            ],
            ["Adapter", `${r.recoveryCapability} (ft_transfer, 1 yoctoNEAR from the relayer)`],
          ]}
        />
        <p>
          The asset-recovery journal stores the signed transaction before sending it once. If the outcome is
          not proven, the asset stays locked for reconciliation of that transaction; there is no retry button.
        </p>
      </ConfirmDialog>
      <p role="status" data-testid={`execute-status-${id}`}>
        {result}
      </p>
      {failure ? <FailureState failure={failure} what="Execute recovery" headingLevel={3} /> : null}
    </section>
  );
}

/* ------------------------------- recovery card ------------------------------- */

function RecoveryCard({
  a,
  r,
  v,
  onChange,
}: {
  a: UnexpectedAssetRecord;
  r: AssetRecoveryRecord;
  v: AssetRecoveryListView;
  onChange: () => void;
}) {
  const t = useTrade();
  const app = useApp();
  const role = v.viewerRole;
  // An action in flight stays mounted while the state it changed refreshes, on the latest recovery only.
  const latest = a.recoveries.at(-1)?.recoveryId === r.recoveryId;
  const pin = (k: string) => latest && t.pinned(`asset-${k}-${a.index}`);
  if (!r.governedHere)
    return (
      <li data-testid={`recovery-${r.recoveryId}`}>
        Recovery <code>{r.recoveryId}</code> is governed by another trade:{" "}
        <StatusBadge
          dimension="assetRecovery"
          value={r.displayState}
          source="escrow contract view"
          observedAt={v.observedAt}
          compact
        />
      </li>
    );
  const open = OPEN.includes(r.state);
  const locked = ["SUBMITTING", "UNKNOWN", "SUBMITTED", "REVIEW"].includes(r.displayState);
  return (
    <li>
      <article
        className="card"
        data-testid={`recovery-${r.recoveryId}`}
        aria-labelledby={`rec-${r.recoveryId}`}
      >
        <h4 id={`rec-${r.recoveryId}`}>
          Recovery <code>{r.recoveryId}</code>
        </h4>
        <StatusBadge
          dimension="assetRecovery"
          value={r.displayState}
          source="escrow contract view and asset-recovery journal"
          observedAt={v.observedAt}
        />
        <IdentityList
          items={[
            [
              "Recipient (proven sender)",
              <code key="r" className="wrap">
                {r.recipient}
              </code>,
            ],
            ["Amount", <Units key="a" amount={r.amount ?? a.observedAmount} a={a} />],
            ["Recovery capability", r.recoveryCapability ?? "none"],
            [
              "Request digest",
              <code key="d" className="wrap">
                {r.requestDigest}
              </code>,
            ],
            [
              "Transfer evidence",
              r.evidence
                ? r.evidence["transferVerified"]
                  ? "sender's transaction verified by the API"
                  : "contract record only"
                : "not journaled by this API",
            ],
            ["Requested", r.requestedAt ? formatUtc(r.requestedAt) : "—"],
            ["Approved (final authorization)", r.approvedAt ? formatUtc(r.approvedAt) : "not yet"],
            [
              "Challenge deadline (contract clock)",
              r.deadline
                ? `${formatUtc(r.deadline)} (${formatUntil(r.deadline, app.now)} on this device's clock)`
                : "starts at approval",
            ],
            [
              "Validation",
              r.validation ? `${r.validation.verdict} at ${formatUtc(r.validation.observedAt)}` : "none yet",
            ],
          ]}
        />
        {r.challenge ? (
          <p data-testid={`challenge-${a.index}`}>
            Challenged by {ROLE_LABEL[r.challenge.role] ?? r.challenge.role}
            {r.challenge.account ? (
              <>
                {" "}
                <code className="wrap">{r.challenge.account}</code>
              </>
            ) : null}{" "}
            with <code>{r.challenge.reasonCode}</code> at {formatUtc(r.challenge.at)}. Ownership stays
            unresolved in review.
          </p>
        ) : null}
        {r.revokedBy ? <p>Revoked by {ROLE_LABEL[r.revokedBy] ?? r.revokedBy}.</p> : null}
        {locked ? (
          <Callout tone="unknown" icon="locked" title="Asset locked: outcome reconciling" headingLevel={3}>
            <p>
              The execution was submitted once. The asset stays locked while the journal reconciles the
              original transaction; no retry, exit or override exists.
            </p>
          </Callout>
        ) : null}
        {r.state === "FAILED" ? (
          <p>
            The token contract reverted the transfer; nothing moved. A new request by the sender is required.
          </p>
        ) : null}
        {r.operations?.length ? (
          <TableScroller label={`Execution journal for ${r.recoveryId}`}>
            <table>
              <caption>Execution journal (asset-recovery operations)</caption>
              <thead>
                <tr>
                  <th scope="col">Operation</th>
                  <th scope="col">State</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Transaction</th>
                </tr>
              </thead>
              <tbody>
                {r.operations.map((o) => (
                  <tr key={o.operationId} data-testid={`asset-op-${o.operationId}`}>
                    <td className="mono">{o.operationId}</td>
                    <td>
                      <StatusBadge
                        dimension="assetOperation"
                        value={o.state}
                        source="asset-recovery journal"
                        observedAt={o.updatedAt}
                        compact
                      />
                    </td>
                    <td className="mono">{o.reason ?? "—"}</td>
                    <td className="mono wrap">{o.txHash ?? "not signed"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroller>
        ) : null}
        {(r.state === "REQUESTED" && role === "RISK_RESOLVER") || pin("approve") ? (
          <Approve a={a} r={r} onChange={onChange} />
        ) : null}
        {(open && role !== null) || pin("challenge") ? (
          role ? (
            <Challenge a={a} r={r} role={role} onChange={onChange} />
          ) : null
        ) : null}
        {(open && (role === "BUYER" || role === "SUPPLIER")) || pin("claimant") ? (
          <ClaimantChallenge a={a} r={r} onChange={onChange} />
        ) : null}
        {(open && role !== null) || pin("revoke") ? (
          role ? (
            <Revoke a={a} r={r} role={role} onChange={onChange} />
          ) : null
        ) : null}
        {(r.state === "CHALLENGE_PERIOD" && !r.challenge && role !== null && !locked) || pin("execute") ? (
          <Execute a={a} r={r} onChange={onChange} />
        ) : null}
      </article>
    </li>
  );
}

function AssetCard({
  a,
  v,
  onChange,
}: {
  a: UnexpectedAssetRecord;
  v: AssetRecoveryListView;
  onChange: () => void;
}) {
  const t = useTrade();
  const role = v.viewerRole;
  const mayRequest = a.state === "ASSET_RECOVERY_REVIEW" && (role === "BUYER" || role === "SUPPLIER");
  return (
    <article className="card" data-testid={`asset-${a.index}`} aria-labelledby={`asset-${a.index}-title`}>
      <h4 id={`asset-${a.index}-title`}>
        Asset record #{a.index}: {a.standard}
      </h4>
      <StatusBadge
        dimension="assetRecord"
        value={a.state}
        source="escrow contract view"
        observedAt={v.observedAt}
      />
      <IdentityList
        items={[
          [
            "Asset contract (as observed)",
            <code key="c" className="wrap">
              {a.assetContract}
            </code>,
          ],
          ["Observed amount", <Units key="u" amount={a.observedAmount} a={a} />],
          [
            "Claimed sender (not proven)",
            <code key="s" className="wrap">
              {a.claimedSender}
            </code>,
          ],
          ["Original funder", "none: unexpected assets have no native-NEAR funder"],
          ["Observed", formatUtc(a.observedAt)],
          [
            "Untrusted message digest",
            <code key="m" className="wrap">
              {a.msgDigest}
            </code>,
          ],
          ["Recovery capability", a.recoveryCapability ?? "none in this build"],
        ]}
      />
      {a.recoveryCapability === null ? (
        <p data-testid={`no-adapter-${a.index}`}>
          This contract has no safe recovery adapter for {a.standard}. The asset stays recorded in review and
          no recovery action exists; nothing is swept to any party.
        </p>
      ) : null}
      {mayRequest || t.pinned(`asset-request-${a.index}`) ? <RequestStart a={a} onChange={onChange} /> : null}
      {a.recoveries.length ? (
        <ol className="plain">
          {a.recoveries.map((r) => (
            <RecoveryCard key={r.recoveryId} a={a} r={r} v={v} onChange={onChange} />
          ))}
        </ol>
      ) : (
        <p>No recovery has been requested for this record.</p>
      )}
    </article>
  );
}

/** The separate "Asset recovery review" panel of the Refund tab. */
export function AssetRecoveryPanel() {
  const t = useTrade();
  const data = useApiData(() => t.api.assetRecoveries(t.tradeId), [t.tradeId, t.tick]);
  return (
    <section aria-labelledby="assets-title" data-testid="asset-recovery">
      <h3 id="assets-title">Asset recovery review</h3>
      <p>
        Unexpected token and NFT transfers are not native-NEAR funding: they never appear in the deposits, the
        refund candidates or the conservation total above, and no refund action reaches them.
      </p>
      <Section what="asset recovery" state={data.state} outcome={data.outcome} reload={data.reload}>
        {(v: AssetRecoveryListView) => (
          <>
            <details>
              <summary>
                Signed policy row: {v.policy.row["reason"]} ({v.policy.id} revision {v.policy.revision})
              </summary>
              <IdentityList
                items={[
                  ["Initiator", v.policy.row["initiator"] ?? ""],
                  ["Required signers and authority", v.policy.row["signers"] ?? ""],
                  ["Clock", v.policy.row["clock"] ?? ""],
                  ["Evidence", v.policy.row["evidence"] ?? ""],
                  ["Challenge", v.policy.row["challenge"] ?? ""],
                  ["Eligible amount and recipient", v.policy.row["eligible"] ?? ""],
                  ["Revocation and UNKNOWN", v.policy.row["revocation"] ?? ""],
                  [
                    "Adapters in this contract",
                    v.adapters.map((x) => `${x.standard}: ${x.safe ? x.method : "none"}`).join("; "),
                  ],
                ]}
              />
            </details>
            {v.assets.length === 0 ? (
              <p data-testid="no-assets">
                The escrow contract has recorded no unexpected asset (escrow contract view).
              </p>
            ) : (
              v.assets.map((a) => <AssetCard key={a.index} a={a} v={v} onChange={() => t.refresh()} />)
            )}
          </>
        )}
      </Section>
    </section>
  );
}
