import { type ReactNode, useMemo, useState } from "react";
import { useApiData, useApp } from "../app/app-context";
import { Link } from "../app/router";
import { PageHeader } from "../components/AppShell";
import { MoneyValue, TableScroller } from "../components/Data";
import { Field } from "../components/Forms";
import { UiIcon } from "../components/Icon";
import { EmptyState, FailureState, LoadingState } from "../components/States";
import { StatusBadge } from "../components/Status";
import { TradeApi, type TradeListItem } from "../lib/api/trade";
import type { Network } from "../lib/api/types";
import { formatUtc } from "../lib/format";

const LOCKED = ["SUBMITTING", "PROCESSING", "UNKNOWN", "REVIEW", "RECONCILING", "ADJUDICATION"];

/** Filters select on server-supplied values only; nothing is computed locally. */
const FILTERS: ReadonlyArray<{ id: string; label: string; match: (t: TradeListItem) => boolean }> = [
  { id: "all", label: "All trades", match: () => true },
  { id: "hold", label: "Hold blocking release", match: (t) => t.holdsBlocking > 0 },
  { id: "release", label: "Release intent live", match: (t) => t.liveIntentState !== null },
  {
    id: "unknown",
    label: "Payout locked or unknown",
    match: (t) => LOCKED.includes(t.liveIntentState ?? ""),
  },
  { id: "frozen", label: "Frozen by an incident", match: (t) => t.frozen },
  {
    id: "new-revision",
    label: "Needs a new trade revision",
    match: (t) => t.requiresNewRevision === true,
  },
  { id: "mine-inspect", label: "I am the named inspector", match: (t) => t.relations.includes("INSPECTOR") },
];

/** Unresolved financial risk first (frozen, locked, holds), then live intents, then by id. */
function rank(t: TradeListItem): number {
  if (t.frozen) return 0;
  if (LOCKED.includes(t.liveIntentState ?? "")) return 1;
  if (t.holdsBlocking > 0) return 2;
  if (t.liveIntentState) return 3;
  return 4;
}

function TradeTable({ trades, receivedAt }: { trades: TradeListItem[]; receivedAt: number }) {
  return (
    <TableScroller label="Trades">
      <table data-testid="trades-table">
        <caption>Trades you are related to, unresolved financial risk first</caption>
        <thead>
          <tr>
            <th scope="col">Trade</th>
            <th scope="col">Milestone</th>
            <th scope="col">Amount</th>
            <th scope="col">Revision</th>
            <th scope="col">Your relation</th>
            <th scope="col">Holds</th>
            <th scope="col">Release intent</th>
            <th scope="col">Destination</th>
            <th scope="col">Last sync</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => (
            <tr key={t.tradeId} data-trade={t.tradeId}>
              <td>
                <Link href={`/trades/${t.tradeId}`}>{t.tradeId}</Link>
                {t.frozen ? <p className="small">Frozen by an incident</p> : null}
              </td>
              <td>{t.milestone.description}</td>
              <td>
                <MoneyValue
                  value={{
                    amount: t.amountYocto,
                    asset: "NEAR",
                    decimals: 24,
                    network: t.network as Network,
                  }}
                />
              </td>
              <td className="tabular">
                r{t.revision}
                {t.requiresNewRevision ? (
                  <p className="small" data-testid="needs-new-revision">
                    Bound key rotated, revoked or recovered: a new trade revision is required
                  </p>
                ) : null}
              </td>
              <td>{t.relations.join(", ")}</td>
              <td>{t.holdsBlocking > 0 ? `${t.holdsBlocking} blocking release` : "None blocking"}</td>
              <td>
                {t.liveIntentState ? (
                  <StatusBadge
                    dimension="releaseIntentState"
                    value={t.liveIntentState}
                    source="release journal"
                    observedAt={receivedAt}
                    compact
                  />
                ) : (
                  "None live"
                )}
              </td>
              <td className="mono wrap">{t.payout.destination}</td>
              <td className="mono">{formatUtc(receivedAt)}</td>
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
  const api = useMemo(() => new TradeApi(app.client), [app.client]);
  const { state, outcome, reload } = useApiData(signedIn ? () => api.list() : null, [
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
          <Link href="/trades/new">Create trade</Link> or{" "}
          <Link href="/trades/countersign">Countersign a proposal</Link>; nothing is shown here until the API
          records one.
        </p>
      </EmptyState>
    );
  else {
    const f = FILTERS.find((x) => x.id === filter) ?? FILTERS[0];
    const q = query.trim().toLowerCase();
    const rows = outcome.data.trades
      .filter(
        (t) =>
          (f?.match(t) ?? true) &&
          (!q ||
            t.tradeId.includes(q) ||
            t.milestone.description.toLowerCase().includes(q) ||
            t.milestone.id.includes(q) ||
            t.payout.destination.includes(q)),
      )
      .sort((a, b) => rank(a) - rank(b) || a.tradeId.localeCompare(b.tradeId));
    body = (
      <>
        <search className="filters" aria-label="Filter trades">
          <Field id="trade-search" label="Search" help="Trade ID, milestone or destination account.">
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
          <>
            <Link href="/trades/countersign" className="btn">
              Countersign a proposal
            </Link>
            <Link href="/trades/new" className="btn btn--primary">
              <UiIcon name="plus" />
              Create trade
            </Link>
          </>
        }
      />
      {body}
    </>
  );
}
