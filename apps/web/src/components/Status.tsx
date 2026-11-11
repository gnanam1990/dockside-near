import { formatUtc, networkLabel } from "../lib/format";
import { type Dimension, describeStatus } from "../lib/status";
import { StatusIcon, UiIcon } from "./Icon";

/**
 * Evidence-bound status: icon + text label + supporting sentence + source + timestamp.
 * Colour only reinforces the text; it never carries meaning alone.
 */
export function StatusBadge({
  dimension,
  value,
  source,
  observedAt,
  reason,
  compact = false,
}: {
  dimension: Dimension;
  value: string;
  /** Where the value came from (API projection, contract read, ...). Required. */
  source: string;
  observedAt: number | null;
  reason?: string;
  compact?: boolean;
}) {
  const m = describeStatus(dimension, value);
  return (
    <span className={`status tone-${m.tone}`} data-dimension={dimension} data-value={value}>
      <StatusIcon name={m.icon} className="status__icon" />
      <span className="status__label">{m.label}</span>
      {compact ? null : (
        <span className="status__meta">
          {reason ?? m.sentence} Source: {source}
          {observedAt === null ? "; time not reported." : `, ${formatUtc(observedAt)}.`}
        </span>
      )}
    </span>
  );
}

export function NetworkLabel({ network }: { network: string | null | undefined }) {
  if (!network) {
    return (
      <span className="network-label" data-network="unknown">
        <UiIcon name="network" />
        Network not reported
      </span>
    );
  }
  return (
    <span className="network-label" data-network={network}>
      <UiIcon name="network" />
      {networkLabel(network)}
    </span>
  );
}
