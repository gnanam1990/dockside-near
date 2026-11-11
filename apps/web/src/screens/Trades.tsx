import { type ReactNode, useState } from "react";
import { useApiData, useApp } from "../app/app-context";
import { Link } from "../app/router";
import { PageHeader } from "../components/AppShell";
import { MoneyValue, TableScroller } from "../components/Data";
import { Field } from "../components/Forms";
import { UiIcon } from "../components/Icon";
import { EmptyState, FailureState, LoadingState } from "../components/States";
import { StatusBadge } from "../components/Status";
import type { TradeSummary } from "../lib/api/types";
import { formatUtc } from "../lib/format";

/** Filters select on server-supplied state values only; nothing is computed locally. */
const FILTERS: ReadonlyArray<{ id: string; label: string; match: (t: TradeSummary) => boolean }> = [
  { id: "all", label: "All trades", match: () => true },
  { id: "action", label: "Needs my action", match: (t) => t.nextAction !== null },
  { id: "funding", label: "Funding", match: (t) => t.tradeState === "FUNDING" },
  { id: "inspection", label: "Inspection", match: (t) => t.tradeState === "INSPECTION" },
  { id: "hold", label: "Hold", match: (t) => t.tradeState === "HOLD" },
  { id: "release", label: "Release-ready", match: (t) => t.tradeState === "RELEASE_READY" },
  { id: "unknown", label: "Payout unknown", match: (t) => t.payoutState === "UNKNOWN" },
  { id: "terminal", label: "Terminal", match: (t) => ["PAID", "REFUNDED", "CLOSED"].includes(t.tradeState) },
];

function TradeTable({ trades, receivedAt }: { trades: TradeSummary[]; receivedAt: number }) {
  return (
    <TableScroller label="Trades">
      <table>
        <caption>Trades ordered by the server (unresolved financial risk first)</caption>
        <thead>
          <tr>
            <th scope="col">Trade</th>
            <th scope="col">Supplier</th>
            <th scope="col">Amount</th>
            <th scope="col">Revision</th>
            <th scope="col">Trade state</th>
            <th scope="col">Next action</th>
            <th scope="col">Destination change</th>
            <th scope="col">Evidence</th>
            <th scope="col">Payout</th>
            <th scope="col">Last sync</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => (
            <tr key={t.tradeId}>
              <td>
                <Link href={`/trades/${t.tradeId}`}>{t.reference}</Link>
              </td>
              <td>{t.supplierName}</td>
              <td>
                <MoneyValue value={t.amount} />
              </td>
              <td className="tabular">r{t.revision}</td>
              <td>{t.tradeState}</td>
              <td>{t.nextAction ?? "None for you"}</td>
              <td>{t.destinationChangePending ? "Change pending" : "No change"}</td>
              <td>
                <StatusBadge
                  dimension="evidenceState"
                  value={t.evidenceState}
                  source={t.provenance.source}
                  observedAt={t.provenance.observedAt}
                  compact
                />
              </td>
              <td>
                <StatusBadge
                  dimension="payoutState"
                  value={t.payoutState}
                  source={t.provenance.source}
                  observedAt={t.provenance.observedAt}
                  compact
                />
              </td>
              <td className="mono">{formatUtc(t.provenance.recordedAt || receivedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroller>
  );
}

export function TradesScreen() {
  const app = useApp();
  const signedIn = app.sessionGrant !== null;
  const { state, outcome, reload } = useApiData(signedIn ? () => app.client.listTrades() : null, [
    signedIn,
    app.sessionGrant?.sessionId,
  ]);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");

  let body: ReactNode;
  if (!signedIn) body = <FailureState failure={{ kind: "no-session" }} what="Trades" />;
  else if (state === "loading" || !outcome) body = <LoadingState what="trades" />;
  else if (!outcome.ok) body = <FailureState failure={outcome.error} what="Trades" onRetry={reload} />;
  else if (outcome.data.trades.length === 0)
    body = (
      <EmptyState title="No trades yet">
        <p>
          A trade exists only after a buyer and supplier sign the same canonical agreement. Start with{" "}
          <Link href="/trades/new">Create trade</Link>; nothing is shown here until the API records one.
        </p>
      </EmptyState>
    );
  else {
    const f = FILTERS.find((x) => x.id === filter) ?? FILTERS[0];
    const q = query.trim().toLowerCase();
    const rows = outcome.data.trades.filter(
      (t) =>
        (f?.match(t) ?? true) &&
        (!q || t.reference.toLowerCase().includes(q) || t.supplierName.toLowerCase().includes(q)),
    );
    body = (
      <>
        <search className="filters" aria-label="Filter trades">
          <Field id="trade-search" label="Search" help="Trade reference or supplier.">
            {(aria) => (
              <input {...aria} type="search" value={query} onChange={(e) => setQuery(e.target.value)} />
            )}
          </Field>
          <Field id="trade-filter" label="Show">
            {(aria) => (
              <select {...aria} value={filter} onChange={(e) => setFilter(e.target.value)}>
                {FILTERS.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </search>
        <p role="status">
          Showing {rows.length} of {outcome.data.trades.length} trades.
        </p>
        <TradeTable trades={rows} receivedAt={outcome.receivedAt} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Trades"
        description="Portfolio and attention queue. Every value comes from the API with its source and time."
        network={app.ready?.network ?? null}
        actions={
          <Link href="/trades/new" className="btn btn--primary">
            <UiIcon name="plus" />
            Create trade
          </Link>
        }
      />
      {body}
    </>
  );
}
