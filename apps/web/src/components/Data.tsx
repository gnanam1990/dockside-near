import { type ReactNode, useState } from "react";
import type { MoneyAmount } from "../lib/api/types";
import { formatUnits, networkLabel } from "../lib/format";
import { UiIcon } from "./Icon";

/** Exact amount from integer smallest units, with asset and network; tabular figures. */
export function MoneyValue({ value }: { value: MoneyAmount }) {
  let text: string;
  try {
    text = formatUnits(value.amount, value.decimals);
  } catch {
    return <span className="status tone-unknown">Amount not representable ({value.amount})</span>;
  }
  return (
    <span className="mono tabular" data-amount={value.amount}>
      {text} {value.asset} <span className="muted">({networkLabel(value.network)})</span>
    </span>
  );
}

/** Full, wrap-safe identifier/address with a copy control and announced confirmation. */
export function AddressDisplay({
  value,
  label,
  network,
}: {
  value: string;
  label: string;
  network?: string | null;
}) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  };
  return (
    <div className="address">
      <code className="address__value">{value}</code>
      <div className="address__meta">
        {network ? <span>{networkLabel(network)}</span> : null}
        <button type="button" className="btn btn--small" onClick={() => void copy()}>
          <UiIcon name="copy" size={16} />
          Copy {label}
        </button>
        <span aria-live="polite">
          {copied === "copied"
            ? `${label} copied.`
            : copied === "failed"
              ? "Copy is not permitted here."
              : ""}
        </span>
      </div>
    </div>
  );
}

export function IdentityList({ items }: { items: ReadonlyArray<readonly [string, ReactNode]> }) {
  return (
    <dl className="identity">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Labelled, keyboard-scrollable container for wide semantic tables. */
export function TableScroller({ label, children }: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a focusable scroll region lets keyboard users scroll wide tables
    <section className="table-scroll" aria-label={label} tabIndex={0}>
      {children}
    </section>
  );
}
