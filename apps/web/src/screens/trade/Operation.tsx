import { useState } from "react";
import { useApiData } from "../../app/app-context";
import { IdentityList, TableScroller } from "../../components/Data";
import { Callout } from "../../components/States";
import { StatusBadge } from "../../components/Status";
import type { OperationView } from "../../lib/api/trade";
import { formatUtc } from "../../lib/format";
import { Section, useTrade } from "./common";

/** Economic-operation journal states in which the value lock is held and only reconciliation applies. */
export const LOCKED_OPS = [
  "SUBMITTING",
  "EXECUTING",
  "PROCESSING",
  "UNKNOWN",
  "REVIEW",
  "RECONCILING",
  "ADJUDICATION",
];

export function OperationDetail({ operationId }: { operationId: string }) {
  const t = useTrade();
  const op = useApiData(() => t.api.operation(operationId), [operationId, t.tick]);
  const [msg, setMsg] = useState<string | null>(null);
  const isRisk = t.has("RISK_RESOLVER");
  return (
    <Section what="operation" state={op.state} outcome={op.outcome} reload={op.reload}>
      {(o: OperationView) => {
        const locked = LOCKED_OPS.includes(o.state);
        return (
          <article
            className="operation"
            data-testid="operation"
            data-state={o.state}
            aria-labelledby={`op-${o.operationId}`}
          >
            <h4 id={`op-${o.operationId}`}>
              Operation <code>{o.operationId}</code>
            </h4>
            <StatusBadge
              dimension="operationState"
              value={o.state}
              source="economic-operation journal"
              observedAt={t.receivedAt}
            />
            <IdentityList
              items={[
                ["Kind", o.kind],
                ["Value lock", o.lockHeld ? "Held: the reservation stays in place" : "Released"],
                ["Submissions", String(o.submitCount)],
                [
                  "Source transaction",
                  o.txHash ? (
                    <code key="h" className="wrap">
                      {o.txHash}
                    </code>
                  ) : (
                    "Not broadcast"
                  ),
                ],
                [
                  "Disposition",
                  o.disposition ? (
                    <code key="d" className="wrap small">
                      {JSON.stringify(o.disposition)}
                    </code>
                  ) : (
                    "None yet (no terminal evidence)"
                  ),
                ],
              ]}
            />
            {locked ? (
              <Callout
                tone="unknown"
                icon="locked"
                title="Locked until reconciled"
                headingLevel={3}
                testId="op-locked"
              >
                <p>
                  Prohibited while {o.state}: retrying payment, cancelling, abandoning, refunding and any
                  terminal override. The reconciler reads the contract, the original transaction and its
                  receipts next.
                </p>
                {isRisk && (o.state === "REVIEW" || o.state === "ADJUDICATION") ? (
                  <div className="btn-row">
                    <button
                      type="button"
                      className="btn"
                      onClick={() =>
                        void t.api
                          .call<{ state: string }>("requestReconciliation", {
                            params: { id: o.operationId },
                            body: {},
                          })
                          .then((r) => {
                            setMsg(
                              r.ok
                                ? `Reconciliation requested; operation is ${r.data.state}.`
                                : `Request refused: ${r.error.kind === "http" ? r.error.message : r.error.kind}.`,
                            );
                            t.refresh();
                          })
                      }
                    >
                      Request reconciliation
                    </button>
                    {o.state === "REVIEW" ? (
                      <button
                        type="button"
                        className="btn"
                        onClick={() =>
                          void t.api
                            .call<{ state: string }>("requestAdjudication", {
                              params: { id: o.operationId },
                              body: { note: "Opened from the payout workspace" },
                            })
                            .then((r) => {
                              setMsg(
                                r.ok
                                  ? `Adjudication opened; operation is ${r.data.state}.`
                                  : `Request refused: ${r.error.kind === "http" ? r.error.message : r.error.kind}.`,
                              );
                              t.refresh();
                            })
                        }
                      >
                        Open adjudication
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {isRisk && o.state !== "REVIEW" && o.state !== "ADJUDICATION" ? (
                  <p className="small" data-testid="op-own-schedule">
                    While {o.state}, the reconciler keeps reading the chain on its own schedule; operator
                    requests open only from REVIEW or ADJUDICATION.
                  </p>
                ) : null}
                {!isRisk ? (
                  <p className="small">
                    Only the trade's risk/policy resolver may request reconciliation or adjudication.
                  </p>
                ) : null}
                <p role="status">{msg}</p>
              </Callout>
            ) : null}
            <h5>Observations ({o.observations.length})</h5>
            <TableScroller label="Observations">
              <table>
                <caption>Facts the reconciler observed, with provenance</caption>
                <thead>
                  <tr>
                    <th scope="col">Source</th>
                    <th scope="col">Subject</th>
                    <th scope="col">Confidence</th>
                    <th scope="col">Observed</th>
                  </tr>
                </thead>
                <tbody>
                  {o.observations.map((x, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: append-only observations
                    <tr key={i}>
                      <td>{x.source}</td>
                      <td className="mono wrap">{x.subject}</td>
                      <td>{x.confidence}</td>
                      <td className="mono">{formatUtc(x.observedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroller>
            {o.incidents.length ? (
              <Callout
                tone="negative"
                icon="blocked"
                title="Frozen-value incident"
                headingLevel={3}
                role="alert"
              >
                <p>{o.incidents.length} incident(s) froze this trade; value is held until risk review.</p>
              </Callout>
            ) : null}
          </article>
        );
      }}
    </Section>
  );
}
