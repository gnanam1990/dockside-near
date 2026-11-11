/** Exact UTC time, e.g. "2026-11-11 21:04:26 UTC". */
export function formatUtc(ms: number): string {
  if (!Number.isFinite(ms)) return "unknown time";
  return `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/** Relative age, always paired with an exact UTC time in the UI. */
export function formatAge(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/** Relative time until a future instant. */
export function formatUntil(ms: number, now: number): string {
  const s = Math.round((ms - now) / 1000);
  if (s <= 0) return "expired";
  if (s < 60) return `in ${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `in ${m} min`;
  return `in ${Math.floor(m / 60)} h ${m % 60} min`;
}

/**
 * Integer smallest units (decimal string) to an exact decimal string. No floating point;
 * a malformed amount is reported, never coerced to zero.
 */
export function formatUnits(amount: string, decimals: number): string {
  if (!/^(0|[1-9][0-9]*)$/.test(amount)) throw new Error("amount must be a non-negative integer string");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error("invalid decimals");
  if (decimals === 0) return groupThousands(amount);
  const padded = amount.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return frac ? `${groupThousands(whole)}.${frac}` : groupThousands(whole);
}

function groupThousands(s: string): string {
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function networkLabel(network: string): string {
  if (network === "near-testnet") return "NEAR testnet";
  if (network === "near-mainnet") return "NEAR mainnet";
  return `Unsupported network "${network}"`;
}

export function capabilityLabel(c: string): string {
  return c
    .toLowerCase()
    .split("_")
    .map((w) => (w === "near" ? "NEAR" : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}
