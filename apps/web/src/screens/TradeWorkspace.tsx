import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useApiData, useApp } from "../app/app-context";
import { Link, TRADE_TABS, type TradeTab } from "../app/router";
import { PageHeader } from "../components/AppShell";
import { AddressDisplay, IdentityList, TableScroller } from "../components/Data";
import { Callout, FailureState, LoadingState } from "../components/States";
import { StatusBadge } from "../components/Status";
import { isApiIdentifier } from "../lib/api/endpoints";
import { type Relation, TradeApi, type TradeProjection } from "../lib/api/trade";
import { formatAge, formatUtc } from "../lib/format";
import { describeStatus } from "../lib/status";
import { BlockerList, Near, Section, TradeContext, type TradeCtx, useTrade } from "./trade/common";
import { DestinationChange } from "./trade/Destination";
import { EvidenceTab } from "./trade/Evidence";
import { OperationDetail } from "./trade/Operation";
import { RefundTab } from "./trade/Refund";
import { ReleaseTab } from "./trade/Release";

const TAB_LABEL: Record<TradeTab, string> = {
  overview: "Overview",
  agreement: "Agreement",
  evidence: "Evidence",
  release: "Release",
  payout: "Payout",
  refund: "Refund",
  timeline: "Timeline",
};

const TAB_PROMISE: Record<TradeTab, string> = {
  overview: "Blocking conditions, funding ledger, participant authority and the separate state dimensions.",
  agreement: "Canonical facts the parties signed, revisions and destination change state.",
  evidence:
    "EvidencePolicy slots, upload, manifest revisions, attestation, advisory analysis (which cannot create or clear a hold), HoldRecords and the inspector workbench.",
  release: "Release intent and value lock, policy checklist, buyer approval, execution and pre-submit exits.",
  payout:
    "Direct testnet release, independent dry compatibility, funded authorization, execution, destination receipt and reconciliation.",
  refund:
    "Original-funder deposits, the signed refund policy, refund and cancellation eligibility, timelocks, conflicts and outcome.",
  timeline: "Append-only event history as a table, and the checksummed audit export.",
};

const RELATION_LABEL: Record<Relation, string> = {
  BUYER: "Buyer approver",
  SUPPLIER: "Supplier signer",
  INSPECTOR: "Named inspector",
  RISK_RESOLVER: "Risk/policy resolver",
  BUYER_ORG: "Buyer organization member",
  SUPPLIER_ORG: "Supplier organization member",
};

/* -------------------------------- overview -------------------------------- */

function Dimensions() {
  const t = useTrade();
  const p = t.p;
  const at = t.receivedAt;
  const live = p.release.liveIntent;
  return (
    <section aria-labelledby="dims-title" data-testid="dimensions">
      <h3 id="dims-title">State, one dimension at a time</h3>
      <IdentityList
        items={[
          [
            "Evidence",
            <StatusBadge
              key="e"
              dimension="evidenceState"
              value={p.evidence.status}
              source="evidence service"
              observedAt={at}
            />,
          ],
          [
            "Attestation",
            p.attestation ? (
              <StatusBadge
                key="a"
                dimension="attestationStatus"
                value={p.attestation.status}
                source="evidence service"
                observedAt={at}
              />
            ) : (
              "No current attestation"
            ),
          ],
          [
            "Inspection",
            p.inspection ? (
              <StatusBadge
                key="i"
                dimension="inspectionDecision"
                value={p.inspection.decision}
                source="evidence service"
                observedAt={at}
              />
            ) : (
              "No inspector decision"
            ),
          ],
          [
            "Holds",
            p.holds.items.length === 0
              ? "No HoldRecord"
              : p.holds.items.map((h) => (
                  <StatusBadge
                    key={h.holdId}
                    dimension="holdState"
                    value={h.status}
                    source="hold journal"
                    observedAt={at}
                    compact
                  />
                )),
          ],
          [
            "Release intent",
            live ? (
              <StatusBadge
                key="r"
                dimension="releaseIntentState"
                value={live.state}
                source="release journal (contract-synced)"
                observedAt={at}
              />
            ) : (
              "No live release intent"
            ),
          ],
          [
            "Payout operations",
            p.operations.length === 0
              ? "None queued"
              : p.operations.map((o) => (
                  <StatusBadge
                    key={o.operationId}
                    dimension="operationState"
                    value={o.state}
                    source="economic-operation journal"
                    observedAt={at}
                    compact
                  />
                )),
          ],
          [
            "Dry compatibility",
            "Not reported by this API build (M06 adapter BLOCKED). No funds moved; not used for testnet release.",
          ],
          [
            "Funded payouts",
            p.fundedPayouts === "BLOCKED"
              ? "BLOCKED by server configuration"
              : `Unrecognized gate "${p.fundedPayouts}"`,
          ],
          ["Trade frozen", p.frozen ? "Yes: an incident froze this trade" : "No"],
        ]}
      />
    </section>
  );
}

function Funding() {
  const t = useTrade();
  const ref = useApiData(() => t.api.refund(t.tradeId), [t.tradeId, t.tick]);
  const tr = t.p.trade;
  return (
    <section aria-labelledby="fund-title" data-testid="funding">
      <h3 id="fund-title">Funding and release ledger</h3>
      <Section what="escrow ledger" state={ref.state} outcome={ref.outcome} reload={ref.reload}>
        {(r) => {
          const l = r.ledger;
          const totals = l.totals;
          return (
            <>
              <IdentityList
                items={[
                  ["Required", <Near key="q" yocto={l.required} network={tr.network} />],
                  ["Committed", <Near key="c" yocto={l.committed} network={tr.network} />],
                  ["Fully funded", l.fullyFunded ? "Yes (contract ledger)" : "No (contract ledger)"],
                  ["Available", <Near key="a" yocto={totals.available} network={tr.network} />],
                  ["Reserved", <Near key="r" yocto={totals.reserved} network={tr.network} />],
                  ["Released", <Near key="l" yocto={totals.released} network={tr.network} />],
                  ["Quarantined", <Near key="x" yocto={totals.quarantined} network={tr.network} />],
                  [
                    "Conservation",
                    l.conservation ? "Holds (contract recomputation)" : "VIOLATED — see incidents",
                  ],
                  ["Source", `${r.source}, ${formatUtc(r.observedAt)}`],
                ]}
              />
              {!l.fullyFunded ? (
                <Callout tone="neutral" icon="pending" title="How funding happens" headingLevel={3}>
                  <p>
                    A funder sends a <code>fund</code> call with an attached deposit to{" "}
                    <code>{tr.escrowContractId}</code> on {tr.network} from its own NEAR account. This build
                    has no wallet connector (BLOCKED); the contract records each deposit against the original
                    funder.
                  </p>
                </Callout>
              ) : null}
            </>
          );
        }}
      </Section>
    </section>
  );
}

function Participants() {
  const t = useTrade();
  const tr = t.p.trade;
  const me = t.p.viewer.principalId;
  const who = (id: string) => (id === me ? `${id} (you)` : id);
  return (
    <section aria-labelledby="part-title">
      <h3 id="part-title">Participant authority</h3>
      <IdentityList
        items={[
          [
            "Buyer approver",
            <code key="b" className="wrap">
              {who(tr.buyer.principalId)}
            </code>,
          ],
          [
            "Supplier signer",
            <code key="s" className="wrap">
              {who(tr.supplier.principalId)}
            </code>,
          ],
          [
            "Named inspector",
            <code key="i" className="wrap">
              {who(tr.inspector.principalId)}
            </code>,
          ],
          [
            "Risk/policy resolver",
            <code key="r" className="wrap">
              {who(tr.riskResolver.principalId)}
            </code>,
          ],
          ["Your relation", t.p.viewer.relations.map((r) => RELATION_LABEL[r]).join(", ")],
        ]}
      />
    </section>
  );
}

function OverviewTab() {
  const t = useTrade();
  return (
    <>
      <section aria-labelledby="next-title" data-testid="next-action">
        <h3 id="next-title">What blocks release</h3>
        <BlockerList tradeId={t.tradeId} blockers={t.p.release.blockers} />
      </section>
      <Dimensions />
      <Funding />
      <Participants />
    </>
  );
}

/* -------------------------------- agreement -------------------------------- */

function AgreementTab() {
  const t = useTrade();
  const tr = t.p.trade;
  const rel = useApiData(() => t.api.release(t.tradeId), [t.tradeId, t.tick]);
  return (
    <>
      <section aria-labelledby="facts-title" data-testid="agreement-facts">
        <h3 id="facts-title">Canonical facts (revision r{tr.revision})</h3>
        <IdentityList
          items={[
            ["Trade", <code key="t">{tr.tradeId}</code>],
            [
              "Terms digest",
              <code key="d" className="wrap">
                {tr.termsDigest}
              </code>,
            ],
            ["Network", tr.network],
            ["Escrow contract", <code key="c">{tr.escrowContractId}</code>],
            ["Asset", `${tr.asset.kind} on ${tr.asset.network}`],
            ["Amount", <Near key="a" yocto={tr.amountYocto} network={tr.network} />],
            ["Milestone", `${tr.milestone.id}: ${tr.milestone.description}`],
            [
              "Evidence policy",
              `${tr.evidencePolicy.id} r${tr.evidencePolicy.revision} (${tr.evidencePolicy.digest.slice(0, 16)}…)`,
            ],
            ["Expires", formatUtc(tr.expiresAt)],
            [
              "Signatures",
              "Buyer approver and supplier signer over this digest, verified by the contract at registration",
            ],
          ]}
        />
        <h4>Payout destination</h4>
        <AddressDisplay value={tr.payout.destination} label="destination" network={tr.payout.network} />
      </section>
      <Section what="revisions" state={rel.state} outcome={rel.outcome} reload={rel.reload}>
        {(r) => (
          <section aria-labelledby="rev-title">
            <h3 id="rev-title">Activated revisions</h3>
            <TableScroller label="Trade revisions">
              <table>
                <caption>Activated revisions (escrow contract view)</caption>
                <thead>
                  <tr>
                    <th scope="col">Revision</th>
                    <th scope="col">Digest</th>
                    <th scope="col">Activated</th>
                  </tr>
                </thead>
                <tbody>
                  {r.contract.revisions.map((v) => (
                    <tr key={v.revision}>
                      <td className="tabular">r{v.revision}</td>
                      <td className="mono wrap">{v.digest}</td>
                      <td className="mono">{formatUtc(v.activatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroller>
          </section>
        )}
      </Section>
      <DestinationChange />
    </>
  );
}

/* ---------------------------------- payout ---------------------------------- */

function PayoutTab() {
  const t = useTrade();
  const pay = useApiData(() => t.api.payout(t.tradeId), [t.tradeId, t.tick]);
  return (
    <Section what="payout" state={pay.state} outcome={pay.outcome} reload={pay.reload}>
      {(p) => (
        <>
          <section aria-labelledby="direct-title" data-testid="payout-direct">
            <h3 id="direct-title">1. Direct testnet release</h3>
            <IdentityList
              items={[
                ["Profile", p.profile],
                ["Asset", "Native NEAR on NEAR testnet"],
                ["Contract", <code key="c">{t.p.trade.escrowContractId}</code>],
                [
                  "Recipient (bound supplier account)",
                  <code key="r" className="wrap">
                    {p.destination}
                  </code>,
                ],
                ["Amount", <Near key="a" yocto={p.amountYocto} network={t.p.trade.network} />],
                ["Release intent", t.p.release.liveIntent?.releaseIntentId ?? "None live"],
              ]}
            />
          </section>
          <section aria-labelledby="dry-title" data-testid="payout-dry">
            <h3 id="dry-title">2. Optional dry compatibility</h3>
            <p>
              Not reported by this API build: the 1Click adapter is BLOCKED (no pinned official client or
              credential). No funds moved; not used for testnet release.
            </p>
          </section>
          <section aria-labelledby="funded-title" data-testid="payout-funded">
            <h3 id="funded-title">3. Funded authorization</h3>
            <p>
              {p.fundedPayout.status}: {p.fundedPayout.reason}. No funded controls are rendered; there is no
              demo toggle.
            </p>
          </section>
          <section aria-labelledby="exec-title" data-testid="payout-execution">
            <h3 id="exec-title">4. Execution</h3>
            {p.operations.length === 0 ? (
              <p>No release operation has been queued.</p>
            ) : (
              p.operations.map((o) => <OperationDetail key={o.operationId} operationId={o.operationId} />)
            )}
          </section>
          <section aria-labelledby="receipt-title">
            <h3 id="receipt-title">5. Destination receipt or refund</h3>
            <p>
              {p.operations.some((o) => o.state === "PAID")
                ? "The journal's PAID disposition includes the final receipt to the bound recipient for the exact amount (see the disposition above)."
                : "No destination receipt observed. Provider refunds do not apply to the direct testnet profile."}
            </p>
          </section>
          <section aria-labelledby="recon-title">
            <h3 id="recon-title">6. Reconciliation</h3>
            <p>
              Locked operations show the retained reservation, the next authoritative read and the only safe
              actions (request reconciliation, open adjudication). Source: economic-operation journal,{" "}
              {formatUtc(p.observedAt)}.
            </p>
          </section>
        </>
      )}
    </Section>
  );
}

/* --------------------------------- timeline --------------------------------- */

function ExportPanel() {
  const t = useTrade();
  const [state, setState] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [href, setHref] = useState<string | null>(null);
  useEffect(() => () => (href ? URL.revokeObjectURL(href) : undefined), [href]);
  const sections = (data?.["sections"] ?? {}) as Record<string, unknown>;
  const exclusions = (data?.["exclusions"] ?? []) as unknown[];
  return (
    <section aria-labelledby="export-title" data-testid="audit-export">
      <h3 id="export-title">Audit export</h3>
      <p>
        A checksummed export of every append-only record for this trade plus one fresh contract observation.
        Party and destination accounts are masked by default. Export generation is separate from any product
        verdict.
      </p>
      <button
        type="button"
        className="btn"
        onClick={() =>
          void (async () => {
            setState("loading");
            const out = await t.api.auditExport(t.tradeId);
            if (!out.ok) {
              setError(
                out.error.kind === "http" ? `${out.error.code}: ${out.error.message}` : out.error.kind,
              );
              return setState("failed");
            }
            setData(out.data);
            setHref(
              URL.createObjectURL(
                new Blob([JSON.stringify(out.data, null, 2)], { type: "application/json" }),
              ),
            );
            setState("ready");
          })()
        }
      >
        Prepare export preview
      </button>
      <p role="status">{state === "loading" ? "Building the export from the API…" : null}</p>
      {state === "failed" ? (
        <Callout tone="warning" icon="blocked" title="Export not available" headingLevel={3}>
          <p>{error}</p>
        </Callout>
      ) : null}
      {state === "ready" && data ? (
        <div data-testid="export-preview">
          <IdentityList
            items={[
              [
                "Checksum (SHA-256 over stable JSON)",
                <code key="c" className="wrap">
                  {String(data["checksum"] ?? "")}
                </code>,
              ],
              ["Included sections", Object.keys(sections).join(", ")],
              [
                "Excluded or redacted",
                exclusions.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("; "),
              ],
              ["Destinations", String(data["destinations"] ?? "MASKED")],
            ]}
          />
          {href ? (
            <a className="btn" href={href} download={`dockside-audit-${t.tradeId}.json`}>
              Save export file
            </a>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function TimelineTab() {
  const t = useTrade();
  const tl = useApiData(() => t.api.timeline(t.tradeId), [t.tradeId, t.tick]);
  return (
    <>
      <Section what="timeline" state={tl.state} outcome={tl.outcome} reload={tl.reload}>
        {(x) => (
          <TableScroller label="Trade timeline">
            <table data-testid="timeline-table">
              <caption>Append-only events for this trade ({x.events.length})</caption>
              <thead>
                <tr>
                  <th scope="col">Seq</th>
                  <th scope="col">Event</th>
                  <th scope="col">Subject</th>
                  <th scope="col">Actor</th>
                  <th scope="col">Source</th>
                  <th scope="col">Recorded</th>
                </tr>
              </thead>
              <tbody>
                {x.events.map((e) => (
                  <tr key={e.seq}>
                    <td className="tabular">{e.seq}</td>
                    <td>{e.eventType}</td>
                    <td className="mono wrap">
                      {e.subjectType} {e.subjectId}
                    </td>
                    <td className="mono wrap">{e.actorPrincipalId ?? "service"}</td>
                    <td>{e.source}</td>
                    <td className="mono">{formatUtc(e.recordedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroller>
        )}
      </Section>
      <ExportPanel />
    </>
  );
}

/* ------------------------------- workspace ------------------------------- */

function TabBody({ tab }: { tab: TradeTab }) {
  switch (tab) {
    case "overview":
      return <OverviewTab />;
    case "agreement":
      return <AgreementTab />;
    case "evidence":
      return <EvidenceTab />;
    case "release":
      return <ReleaseTab />;
    case "payout":
      return <PayoutTab />;
    case "refund":
      return <RefundTab />;
    case "timeline":
      return <TimelineTab />;
  }
}

const REFRESH_MS = 4000;

export function TradeWorkspaceScreen({ tradeId, tab }: { tradeId: string; tab: string }) {
  const app = useApp();
  const signedIn = app.sessionGrant !== null;
  const valid = isApiIdentifier(tradeId);
  const api = useMemo(() => new TradeApi(app.client), [app.client]);
  const [tick, setTick] = useState(0);
  const [pins, setPins] = useState<ReadonlySet<string>>(new Set());
  const busy = useCallback(
    (id: string) => (b: boolean) =>
      setPins((prev) => {
        if (b === prev.has(id)) return prev;
        const next = new Set(prev);
        if (b) next.add(id);
        else next.delete(id);
        return next;
      }),
    [],
  );
  const refresh = useCallback(() => setTick((x) => x + 1), []);
  useEffect(() => {
    const id = window.setInterval(refresh, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [refresh]);
  const { outcome, reload } = useApiData(signedIn && valid ? () => api.get(tradeId) : null, [
    signedIn,
    tradeId,
    tick,
  ]);
  const tb = tab as TradeTab;

  let status: ReactNode = null;
  let ctx: TradeCtx | null = null;
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
  else if (!outcome) status = <LoadingState what="the trade" />;
  else if (!outcome.ok) status = <FailureState failure={outcome.error} what="Trade" onRetry={reload} />;
  else {
    const p: TradeProjection = outcome.data;
    ctx = {
      tradeId,
      api,
      p,
      receivedAt: outcome.receivedAt,
      tick,
      refresh,
      has: (r) => p.viewer.relations.includes(r),
      pinned: (id) => pins.has(id),
      busy,
    };
  }
  const p = ctx?.p;
  return (
    <>
      <PageHeader
        title={p ? `Trade ${p.trade.milestone.id}` : `Trade ${tradeId}`}
        network={p?.trade.network ?? app.ready?.network ?? null}
        description={
          p ? (
            <>
              <code>{p.trade.tradeId}</code> · <Near yocto={p.trade.amountYocto} network={p.trade.network} />{" "}
              · revision r{p.trade.revision} · contract <code>{p.trade.escrowContractId}</code> · release
              intent{" "}
              {p.release.liveIntent
                ? describeStatus("releaseIntentState", p.release.liveIntent.state).label
                : "none"}{" "}
              · synced {formatUtc(ctx?.receivedAt ?? 0)} ({formatAge(ctx?.receivedAt ?? 0, app.now)})
            </>
          ) : (
            "Trade workspace."
          )
        }
      />
      <nav className="tabnav" aria-label="Trade sections">
        <ul>
          {TRADE_TABS.map((x) => (
            <li key={x}>
              <Link href={`/trades/${encodeURIComponent(tradeId)}/${x}`} current={x === tb}>
                {TAB_LABEL[x]}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <section className="panel" aria-labelledby="tab-title">
        <h2 id="tab-title">{TAB_LABEL[tb]}</h2>
        <p className="muted">{TAB_PROMISE[tb]}</p>
        {status}
        {ctx ? (
          <TradeContext.Provider value={ctx}>
            {ctx.p.frozen ? (
              <Callout tone="negative" icon="blocked" title="Trade frozen by an incident" role="alert">
                <p>Value is held; every economic action is refused until risk review closes the incident.</p>
              </Callout>
            ) : null}
            <TabBody tab={tb} />
          </TradeContext.Provider>
        ) : null}
      </section>
    </>
  );
}
