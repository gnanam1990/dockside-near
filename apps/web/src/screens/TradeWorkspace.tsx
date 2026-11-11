import type { ReactNode } from "react";
import { useApiData, useApp } from "../app/app-context";
import { Link, TRADE_TABS, type TradeTab } from "../app/router";
import { PageHeader } from "../components/AppShell";
import { AddressDisplay, IdentityList, MoneyValue } from "../components/Data";
import { Callout, FailureState, LoadingState } from "../components/States";
import { StatusBadge } from "../components/Status";
import { isApiIdentifier } from "../lib/api/endpoints";
import type { TradeDetail } from "../lib/api/types";

const TAB_LABEL: Record<TradeTab, string> = {
  overview: "Overview",
  agreement: "Agreement",
  evidence: "Evidence",
  release: "Release",
  payout: "Payout",
  refund: "Refund",
  timeline: "Timeline",
};

/** Which projection each tab reads. Overview and Agreement use the trade itself. */
const TAB_SECTION = {
  evidence: "tradeEvidence",
  release: "tradeRelease",
  payout: "tradePayout",
  refund: "tradeRefund",
  timeline: "tradeTimeline",
} as const;

const TAB_PROMISE: Record<TradeTab, string> = {
  overview: "Next safe action, blocking conditions, funding and release ledger, participant authority.",
  agreement: "Canonical facts, signatures, prior revisions and the revision diff.",
  evidence:
    "EvidencePolicy slots, manifest revisions, attestation, advisory analysis (which cannot create or clear a hold) and HoldRecords.",
  release:
    "Release intent and value lock, policy checklist, buyer approval, destination and execution profile.",
  payout:
    "Direct testnet release, independent dry compatibility, funded authorization, execution, reconciliation.",
  refund: "Original-funder deposits, refund eligibility, timelock, conflicts and outcome.",
  timeline: "Append-only event history with a table alternative.",
};

/** The orthogonal facts stay separate; none is collapsed into one badge. */
function OrthogonalFacts({ t }: { t: TradeDetail }) {
  const src = t.provenance.source;
  const at = t.provenance.observedAt;
  return (
    <IdentityList
      items={[
        ["Trade state", <span key="ts">{t.tradeState}</span>],
        [
          "Evidence",
          <StatusBadge
            key="e"
            dimension="evidenceState"
            value={t.evidenceState}
            source={src}
            observedAt={at}
          />,
        ],
        ...(t.holdState
          ? [
              [
                "Hold",
                <StatusBadge
                  key="h"
                  dimension="holdState"
                  value={t.holdState}
                  source={src}
                  observedAt={at}
                />,
              ] as const,
            ]
          : []),
        [
          "Payout",
          <StatusBadge key="p" dimension="payoutState" value={t.payoutState} source={src} observedAt={at} />,
        ],
        [
          "Dry compatibility",
          <StatusBadge
            key="d"
            dimension="dryCompatibility"
            value={t.dryCompatibility}
            source={src}
            observedAt={at}
          />,
        ],
        ["Provider status", t.providerStatus ?? "No provider involved"],
        [
          "Destination receipt",
          t.destinationReceipt ? (
            <StatusBadge
              key="r"
              dimension="destinationReceipt"
              value={t.destinationReceipt}
              source={src}
              observedAt={at}
            />
          ) : (
            "Not observed"
          ),
        ],
      ]}
    />
  );
}

function SectionBody({ tradeId, tab }: { tradeId: string; tab: keyof typeof TAB_SECTION }) {
  const app = useApp();
  const { state, outcome, reload } = useApiData(
    () => app.client.tradeSection(TAB_SECTION[tab], tradeId),
    [tradeId, tab],
  );
  if (state === "loading" || !outcome) return <LoadingState what={TAB_LABEL[tab].toLowerCase()} />;
  if (!outcome.ok)
    return <FailureState failure={outcome.error} what={TAB_LABEL[tab]} onRetry={reload} headingLevel={3} />;
  return (
    <Callout tone="unknown" icon="unknown" title="Projection received but not yet rendered" headingLevel={3}>
      <p>
        The API returned a {TAB_LABEL[tab].toLowerCase()} projection that this web build does not render yet.
        Nothing is inferred from it.
      </p>
    </Callout>
  );
}

export function TradeWorkspaceScreen({ tradeId, tab }: { tradeId: string; tab: string }) {
  const app = useApp();
  const signedIn = app.sessionGrant !== null;
  const valid = isApiIdentifier(tradeId);
  const { state, outcome, reload } = useApiData(
    signedIn && valid ? () => app.client.getTrade(tradeId) : null,
    [signedIn, tradeId],
  );
  const t = tab as TradeTab;

  let header: ReactNode = (
    <PageHeader
      title={`Trade ${tradeId}`}
      network={app.ready?.network ?? null}
      description="Trade workspace."
    />
  );
  let trade: TradeDetail | null = null;
  let status: ReactNode = null;
  if (!signedIn) status = <FailureState failure={{ kind: "no-session" }} what="Trade" />;
  else if (!valid)
    status = (
      <Callout tone="warning" icon="blocked" title="Not a trade identifier">
        <p>
          <code>{tradeId}</code> is not a valid trade ID, so nothing was requested.{" "}
          <Link href="/trades">Back to trades</Link>.
        </p>
      </Callout>
    );
  else if (state === "loading" || !outcome) status = <LoadingState what="the trade" />;
  else if (!outcome.ok) status = <FailureState failure={outcome.error} what="Trade" onRetry={reload} />;
  else {
    trade = outcome.data;
    header = (
      <PageHeader
        title={`Trade ${trade.reference}`}
        network={trade.amount.network}
        description={
          <>
            {trade.supplierName} · <MoneyValue value={trade.amount} /> · revision r{trade.revision}
          </>
        }
      />
    );
  }

  return (
    <>
      {header}
      <nav className="tabnav" aria-label="Trade sections">
        <ul>
          {TRADE_TABS.map((x) => (
            <li key={x}>
              <Link href={`/trades/${encodeURIComponent(tradeId)}/${x}`} current={x === t}>
                {TAB_LABEL[x]}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <section className="panel" aria-labelledby="tab-title">
        <h2 id="tab-title">{TAB_LABEL[t]}</h2>
        <p className="muted">{TAB_PROMISE[t]}</p>
        {status}
        {trade && (t === "overview" || t === "agreement") ? (
          <>
            <OrthogonalFacts t={trade} />
            {trade.contractId ? (
              <>
                <h3>Escrow contract</h3>
                <AddressDisplay value={trade.contractId} label="contract ID" network={trade.amount.network} />
              </>
            ) : null}
          </>
        ) : null}
        {trade && t in TAB_SECTION ? (
          <SectionBody tradeId={tradeId} tab={t as keyof typeof TAB_SECTION} />
        ) : null}
      </section>
    </>
  );
}
