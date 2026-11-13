/**
 * Browser-side helpers of the supplier cash-out panel (M52). Pure functions: exact decimal entry
 * to base units, parsing of the quote answer the supplier pastes, and the per-trade note of which
 * deposit address is being tracked. The note is a convenience only: the API recomputes every state
 * from 1Click and NEAR, and a cash-out can always be tracked again from its deposit address.
 */

/** Exact decimal string to integer base units. No floating point; refuses instead of rounding. */
export function toBaseUnits(
  input: string,
  decimals: number,
): { ok: true; value: string } | { ok: false; reason: string } {
  const s = input.trim().replace(/,/g, "");
  if (!/^(0|[1-9][0-9]{0,30})(\.[0-9]+)?$/.test(s))
    return { ok: false, reason: "Enter a plain number, for example 2 or 2.5." };
  const [whole = "0", frac = ""] = s.split(".");
  if (frac.length > decimals)
    return { ok: false, reason: `This token has ${decimals} decimal places; enter at most that many.` };
  const value = (
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(frac.padEnd(decimals, "0") || "0")
  ).toString();
  if (value === "0") return { ok: false, reason: "The amount must be greater than zero." };
  return { ok: true, value };
}

/** The pasted 1Click answer as an object; shell output is accepted as long as it is one JSON object. */
export function parsePastedQuote(
  text: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  const t = text.trim();
  if (t === "") return { ok: false, reason: "Paste the answer your own request returned." };
  if (t.length > 20_000) return { ok: false, reason: "That is too long to be a 1Click quote answer." };
  let v: unknown;
  try {
    v = JSON.parse(t);
  } catch {
    return { ok: false, reason: "That is not JSON. Paste the whole answer, from the first { to the last }." };
  }
  if (typeof v !== "object" || v === null || Array.isArray(v))
    return { ok: false, reason: "The answer must be one JSON object." };
  return { ok: true, value: v as Record<string, unknown> };
}

export const NEAR_ACCOUNT_ID = /^[a-z0-9._-]{2,64}$/;
export const NEAR_TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
export const DESTINATION_ADDRESS = /^[A-Za-z0-9._:-]{2,128}$/;

export interface TrackedCashOut {
  readonly depositAddress: string;
  readonly txHash: string;
}

const key = (tradeId: string) => `dockside.cash-out.${tradeId}`;

export function loadTracked(tradeId: string): TrackedCashOut | null {
  try {
    const raw = window.localStorage.getItem(key(tradeId));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<TrackedCashOut>;
    if (typeof v.depositAddress !== "string" || !NEAR_ACCOUNT_ID.test(v.depositAddress)) return null;
    const txHash = typeof v.txHash === "string" && NEAR_TX_HASH.test(v.txHash) ? v.txHash : "";
    return { depositAddress: v.depositAddress, txHash };
  } catch {
    return null;
  }
}

export function saveTracked(tradeId: string, t: TrackedCashOut): void {
  try {
    window.localStorage.setItem(key(tradeId), JSON.stringify(t));
  } catch {
    // Storage may be unavailable; tracking still works from the deposit address.
  }
}
