import type { ReactNode } from "react";
import { useApiData, useApp } from "../app/app-context";
import { Link } from "../app/router";
import { PageHeader } from "../components/AppShell";
import { MoneyValue, TableScroller } from "../components/Data";
import { Callout, EmptyState, FailureState, LoadingState } from "../components/States";
import { StatusBadge } from "../components/Status";
import type { ApiOutcome } from "../lib/api/client";
import type { Network } from "../lib/api/types";
import { formatUtc } from "../lib/format";

interface InspectionRow {
  readonly tradeId: string;
  readonly assignedToViewer: boolean;
  readonly currentAttestation: { readonly digest: string; readonly manifestDigest: string } | null;
  readonly inspection: { readonly decision: string; readonly digest: string; readonly expiresAt: number } | null;
}

interface PayoutRow {
  readonly tradeId: string;
  readonly destination: string;
  readonly amountYocto: string;
  readonly operationId: string;
  readonly state: string;
  readonly lockHeld: boolean;
  readonly txHash: string | null;
}

function useSignedInData<T>(load: () => Promise<ApiOutcome<T>>) {
  const app = useApp();
  const signedIn = app.sessionGrant !== null;
  return { signedIn, ...useApiData(signedIn ? load : null, [signedIn, app.sessionGrant?.sessionId]) };
}

export function InspectionsScreen() {
  const app = useApp();
  const { signedIn, state, outcome, reload } = useSignedInData(() => app.client.listInspections());
  let body: ReactNode;
  if (!signedIn) body = <FailureState failure={{ kind: "no-session" }} what="Inspections" />;
  else if (state === "loading" || !outcome) body = <LoadingState what="inspections" />;
  else if (!outcome.ok) body = <FailureState failure={outcome.error} what="Inspections" onRetry={reload} />;
  else if (outcome.data.inspections.length === 0)
    body = (
      <EmptyState title="No inspections assigned">
        <p>Inspections appear when a trade names you as its inspector and evidence is submitted.</p>
      </EmptyState>
    );
  else {
    const rows = outcome.data.inspections as InspectionRow[];
    body = (
      <TableScroller label="Inspections">
        <table data-testid="inspections-table">
          <caption>Trades you can see, with their current attestation and inspector decision ({formatUtc(outcome.receivedAt)})</caption>
          <thead>
            <tr>
              <th scope="col">Trade</th>
              <th scope="col">Assigned to you</th>
              <th scope="col">Attested manifest</th>
              <th scope="col">Decision</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.tradeId}>
                <td>
                  <Link href={`/trades/${r.tradeId}/evidence`}>{r.tradeId}</Link>
                </td>
                <td>{r.assignedToViewer ? "Yes: you are the named inspector" : "No"}</td>
                <td className="mono wrap">{r.currentAttestation ? r.currentAttestation.manifestDigest : "No current attestation"}</td>
                <td>
                  {r.inspection ? (
                    <StatusBadge dimension="inspectionDecision" value={r.inspection.decision} source="evidence service" observedAt={outcome.receivedAt} compact />
                  ) : (
                    "No decision"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroller>
    );
  }
  return (
    <>
      <PageHeader
        title="Inspections"
        description="Evidence policy checklists and assigned reviews. Attestation stays disabled until the manifest is complete and current."
      />
      {body}
    </>
  );
}

const PAYOUT_SECTIONS: ReadonlyArray<{ id: string; title: string; text: string }> = [
  {
    id: "direct",
    title: "1. Direct testnet release",
    text: "Native testnet NEAR from the escrow contract to the contract-bound supplier testnet account, with release intent and transaction.",
  },
  {
    id: "dry",
    title: "2. Optional dry compatibility",
    text: "Independent NOT_RUN, UNKNOWN, INCOMPATIBLE or PASS state. No funds moved; not used for testnet release.",
  },
  {
    id: "funded",
    title: "3. Funded authorization",
    text: "Quote, deposit address, recipient, amounts, fees, refund authority, nonce, signer, expiry and consumption state.",
  },
  {
    id: "execution",
    title: "4. Execution",
    text: "Release intent, operation and attempt identity, source transaction and provider status.",
  },
  {
    id: "destination",
    title: "5. Destination and refund",
    text: "Destination receipt, or provider refund to the escrow/refund authority, or the reason it is unavailable.",
  },
  {
    id: "reconciliation",
    title: "6. Reconciliation",
    text: "Value-lock state, prohibited competing actions, next authoritative read, contradictions and safe actions.",
  },
];

export function PayoutsScreen() {
  const app = useApp();
  const { signedIn, state, outcome, reload } = useSignedInData(() => app.client.listPayouts());
  let body: ReactNode;
  if (!signedIn) body = <FailureState failure={{ kind: "no-session" }} what="Payouts" />;
  else if (state === "loading" || !outcome) body = <LoadingState what="payouts" />;
  else if (!outcome.ok) body = <FailureState failure={outcome.error} what="Payouts" onRetry={reload} />;
  else if (outcome.data.payouts.length === 0)
    body = (
      <EmptyState title="No payout operations">
        <p>
          A payout operation exists only after a buyer approves a locked release intent. See{" "}
          <Link href="/trades">Trades</Link>.
        </p>
      </EmptyState>
    );
  else {
    const rows = outcome.data.payouts as PayoutRow[];
    const net = (app.ready?.network ?? "near-testnet") as Network;
    body = (
      <TableScroller label="Payout operations">
        <table data-testid="payouts-table">
          <caption>Release operations (economic-operation journal, {formatUtc(outcome.receivedAt)})</caption>
          <thead>
            <tr>
              <th scope="col">Trade</th>
              <th scope="col">Operation</th>
              <th scope="col">State</th>
              <th scope="col">Amount</th>
              <th scope="col">Destination</th>
              <th scope="col">Transaction</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.operationId}>
                <td>
                  <Link href={`/trades/${r.tradeId}/payout`}>{r.tradeId}</Link>
                </td>
                <td className="mono">{r.operationId}</td>
                <td>
                  <StatusBadge dimension="operationState" value={r.state} source="economic-operation journal" observedAt={outcome.receivedAt} compact />
                </td>
                <td>
                  <MoneyValue value={{ amount: r.amountYocto, asset: "NEAR", decimals: 24, network: net }} />
                </td>
                <td className="mono wrap">{r.destination}</td>
                <td className="mono wrap">{r.txHash ?? "Not broadcast"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroller>
    );
  }
  const funded = app.ready?.fundedPayouts;
  return (
    <>
      <PageHeader
        title="Payouts"
        description="Preparation, operations, reconciliation and incidents. Each section is a separate fact; none implies another."
        network={app.ready?.network ?? null}
      />
      {body}
      <section className="panel" aria-labelledby="payout-config-title">
        <h2 id="payout-config-title">Deployment gates</h2>
        {!app.ready ? (
          <p className="muted">Waiting for the server's readiness report.</p>
        ) : funded === "BLOCKED" ? (
          <StatusBadge
            dimension="productGate"
            value="BLOCKED"
            source="GET /readyz"
            observedAt={app.connection.lastOkAt}
            reason="Funded payouts are disabled by server configuration. No funded or mainnet control is rendered."
          />
        ) : (
          <Callout tone="unknown" icon="unknown" title="Unrecognized funded payout gate" headingLevel={3}>
            <p>
              The server reported <code>{String(funded)}</code>, which this web build does not recognize.
              Funded controls stay hidden; nothing is inferred.
            </p>
          </Callout>
        )}
      </section>
      <div className="panel-grid">
        {PAYOUT_SECTIONS.map((s) => (
          <section className="panel" key={s.id} aria-labelledby={`payout-${s.id}`}>
            <h2 id={`payout-${s.id}`}>{s.title}</h2>
            <p className="muted">{s.text}</p>
            <p>Shown per operation on each trade's Payout tab.</p>
          </section>
        ))}
      </div>
    </>
  );
}

export function NotFoundScreen({ path }: { path: string }) {
  return (
    <>
      <PageHeader title="Page not found" />
      <Callout tone="neutral" icon="not-run" title="No page at this address">
        <p>
          There is no Dockside page at <code>{path}</code>. Go to <Link href="/trades">Trades</Link>.
        </p>
      </Callout>
    </>
  );
}
