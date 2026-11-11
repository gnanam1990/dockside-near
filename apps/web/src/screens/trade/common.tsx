import { createContext, type ReactNode, useContext } from "react";
import { Link } from "../../app/router";
import { MoneyValue } from "../../components/Data";
import type { ApiOutcome } from "../../lib/api/client";
import type { Relation, TradeApi, TradeProjection } from "../../lib/api/trade";
import type { Network } from "../../lib/api/types";
import { FailureState, LoadingState } from "../../components/States";

/** Trade workspace context: the authoritative projection, its age, and a refresh signal. */
export interface TradeCtx {
  readonly tradeId: string;
  readonly api: TradeApi;
  readonly p: TradeProjection;
  readonly receivedAt: number;
  /** Increments after every local action and periodic refresh; sections reload on it. */
  readonly tick: number;
  refresh(): void;
  has(r: Relation): boolean;
  /** Keep an in-flight signed action mounted while the state it changes refreshes underneath it. */
  pinned(id: string): boolean;
  busy(id: string): (b: boolean) => void;
}

export const TradeContext = createContext<TradeCtx | null>(null);

export function useTrade(): TradeCtx {
  const c = useContext(TradeContext);
  if (!c) throw new Error("TradeContext missing");
  return c;
}

export function Near({ yocto, network }: { yocto: string; network: string }) {
  return <MoneyValue value={{ amount: yocto, asset: "NEAR", decimals: 24, network: network as Network }} />;
}

/** Render one API section with its loading / failure states; data stays visible while refreshing. */
export function Section<T>({
  what,
  state,
  outcome,
  reload,
  children,
}: {
  what: string;
  state: string;
  outcome: ApiOutcome<T> | null;
  reload: () => void;
  children: (data: T, receivedAt: number) => ReactNode;
}) {
  if (!outcome) return <LoadingState what={what} />;
  if (!outcome.ok)
    return <FailureState failure={outcome.error} what={what} onRetry={reload} headingLevel={3} />;
  return (
    <div aria-busy={state === "refreshing" ? "true" : "false"}>
      {children(outcome.data, outcome.receivedAt)}
    </div>
  );
}

/** Server blocker codes as sentences, each linked to the tab holding its evidence. */
export const BLOCKERS: Record<string, { readonly text: string; readonly tab: string }> = {
  NOT_FULLY_FUNDED: { text: "Escrow is not fully funded by accepted deposits.", tab: "refund" },
  MANIFEST_NOT_CURRENT: {
    text: "No current ManifestAttestation covers the complete evidence manifest.",
    tab: "evidence",
  },
  STALE_MANIFEST: {
    text: "The contract's accepted manifest or inspection is not the current one.",
    tab: "evidence",
  },
  INSPECTION_NOT_PASS: {
    text: "The bound inspector has not signed PASS over the current manifest.",
    tab: "evidence",
  },
  HOLD_ACTIVE: { text: "A HoldRecord is ACTIVE or EXPIRED_UNRESOLVED.", tab: "evidence" },
  STALE_HOLDS: {
    text: "The holds view changed since approval; a fresh approval is required.",
    tab: "release",
  },
  APPROVAL_MISSING: {
    text: "The bound buyer approver has not approved the live release intent.",
    tab: "release",
  },
  APPROVAL_STALE: { text: "The buyer approval no longer matches current evidence or holds.", tab: "release" },
  APPROVAL_EXPIRED: { text: "The buyer approval expired.", tab: "release" },
  NO_RELEASE_INTENT: { text: "No release intent holds the value lock yet.", tab: "release" },
  VALUE_NOT_LOCKED: { text: "The release value is not locked by a signed intent.", tab: "release" },
  INTENT_EXPIRED: { text: "The live release intent expired before submission.", tab: "release" },
  REFUND_UNRESOLVED: { text: "A refund is unresolved; release cannot proceed.", tab: "refund" },
  TRADE_EXPIRED: { text: "The agreement expired.", tab: "agreement" },
  FUNDED_RAIL_BLOCKED: { text: "Funded payouts are blocked in this build.", tab: "payout" },
  DELAY_NOT_ELAPSED: { text: "A destination-change delay has not elapsed.", tab: "agreement" },
  STALE_REVISION: { text: "The trade revision changed; renewed authority is required.", tab: "agreement" },
};

export function BlockerList({ tradeId, blockers }: { tradeId: string; blockers: string[] }) {
  if (blockers.length === 0)
    return (
      <p data-testid="blockers-none">
        The contract and services report no missing release condition right now (source: release readiness).
      </p>
    );
  return (
    <ul className="checklist" data-testid="blockers">
      {blockers.map((b) => {
        const m = BLOCKERS[b];
        return (
          <li key={b} data-blocker={b}>
            <code>{b}</code>{" "}
            {m ? m.text : "Condition reported by the backend (no description in this client)."}{" "}
            <Link href={`/trades/${tradeId}/${m?.tab ?? "overview"}`}>See evidence</Link>
          </li>
        );
      })}
    </ul>
  );
}

export function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
}
