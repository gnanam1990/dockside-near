/**
 * M52 supplier cash-out through NEAR Intents 1Click: the read-only half Dockside runs.
 *
 * The supplier's money is already in the supplier's own NEAR account when this code is reached
 * (the escrow paid it out). Moving it to another chain is the supplier's own decision and the
 * supplier's own transaction, so this module can do exactly three things against 1Click:
 * list tokens, ask for a `dry: true` quote, and read a status. It has no method that sends
 * `dry: false`, none that creates a deposit address and none that signs or sends a transaction.
 *
 * Wire shapes follow the published 1Click OpenAPI document (`/v0/tokens`, `/v0/quote`,
 * `/v0/status`). Every response is decoded strictly; anything that does not decode is `AMBIGUOUS`
 * and is never turned into a state.
 */

/* --------------------------------- wire types --------------------------------- */

export const ONE_CLICK_STATUSES = [
  "KNOWN_DEPOSIT_TX",
  "PENDING_DEPOSIT",
  "INCOMPLETE_DEPOSIT",
  "PROCESSING",
  "SUCCESS",
  "REFUNDED",
  "FAILED",
] as const;
export type OneClickStatus = (typeof ONE_CLICK_STATUSES)[number];

/** The `/v0/quote` request Dockside builds: exact input from the origin chain to another chain. */
export interface OneClickQuoteRequest {
  readonly dry: boolean;
  readonly swapType: "EXACT_INPUT";
  /** Basis points. */
  readonly slippageTolerance: number;
  readonly originAsset: string;
  readonly depositType: "ORIGIN_CHAIN";
  readonly destinationAsset: string;
  /** Integer string in the origin asset's base units. */
  readonly amount: string;
  readonly refundTo: string;
  readonly refundType: "ORIGIN_CHAIN";
  readonly recipient: string;
  readonly recipientType: "DESTINATION_CHAIN";
  /** ISO 8601 instant after which 1Click refunds an unfinished swap. */
  readonly deadline: string;
}

export interface OneClickToken {
  readonly assetId: string;
  readonly decimals: number;
  readonly blockchain: string;
  readonly symbol: string;
  readonly price: number;
  readonly priceUpdatedAt: string;
  readonly contractAddress: string | null;
}

export interface OneClickQuote {
  readonly depositAddress: string | null;
  readonly depositMemo: string | null;
  readonly amountIn: string;
  readonly amountInFormatted: string;
  readonly amountInUsd: string;
  readonly minAmountIn: string;
  readonly amountOut: string;
  readonly amountOutFormatted: string;
  readonly amountOutUsd: string;
  readonly minAmountOut: string;
  readonly deadline: string | null;
  readonly timeWhenInactive: string | null;
  /** Seconds. */
  readonly timeEstimate: number;
  readonly refundFee: string | null;
  readonly withdrawFee: string | null;
}

export interface OneClickQuoteResponse {
  readonly correlationId: string;
  readonly timestamp: string;
  readonly signature: string;
  readonly quoteRequest: OneClickQuoteRequest;
  readonly quote: OneClickQuote;
}

export interface OneClickTxRef {
  readonly hash: string;
  readonly explorerUrl: string;
}

export interface OneClickStatusResponse {
  readonly correlationId: string;
  readonly status: OneClickStatus;
  readonly updatedAt: string;
  readonly quoteRequest: OneClickQuoteRequest;
  readonly quote: OneClickQuote;
  readonly swapDetails: {
    readonly intentHashes: readonly string[];
    readonly nearTxHashes: readonly string[];
    readonly originChainTxHashes: readonly OneClickTxRef[];
    readonly destinationChainTxHashes: readonly OneClickTxRef[];
    readonly amountIn: string | null;
    readonly amountOut: string | null;
    readonly amountOutFormatted: string | null;
    readonly depositedAmount: string | null;
    readonly refundedAmount: string | null;
    readonly refundReason: string | null;
  };
}

/* ---------------------------------- decoding ---------------------------------- */

class Undecodable extends Error {}

type Obj = Record<string, unknown>;

function obj(v: unknown, at: string): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new Undecodable(`${at} is not an object`);
  return v as Obj;
}

function str(o: Obj, k: string, at: string, max = 512): string {
  const v = o[k];
  if (typeof v !== "string" || v.length === 0 || v.length > max)
    throw new Undecodable(`${at}.${k} is not a string`);
  return v;
}

function optStr(o: Obj, k: string, at: string, max = 512): string | null {
  const v = o[k];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || v.length > max) throw new Undecodable(`${at}.${k} is not a string`);
  return v;
}

const UINT = /^(0|[1-9][0-9]{0,77})$/;

function uint(o: Obj, k: string, at: string): string {
  const v = str(o, k, at, 80);
  if (!UINT.test(v)) throw new Undecodable(`${at}.${k} is not an unsigned integer string`);
  return v;
}

function optUint(o: Obj, k: string, at: string): string | null {
  const v = optStr(o, k, at, 80);
  if (v === null) return null;
  if (!UINT.test(v)) throw new Undecodable(`${at}.${k} is not an unsigned integer string`);
  return v;
}

function instant(o: Obj, k: string, at: string): string {
  const v = str(o, k, at, 64);
  if (!Number.isFinite(Date.parse(v))) throw new Undecodable(`${at}.${k} is not a timestamp`);
  return v;
}

function optInstant(o: Obj, k: string, at: string): string | null {
  const v = optStr(o, k, at, 64);
  if (v === null) return null;
  if (!Number.isFinite(Date.parse(v))) throw new Undecodable(`${at}.${k} is not a timestamp`);
  return v;
}

function literal<T extends string>(o: Obj, k: string, at: string, allowed: readonly T[]): T {
  const v = o[k];
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v))
    throw new Undecodable(`${at}.${k} is not one of ${allowed.join("|")}`);
  return v as T;
}

function decodeQuoteRequest(v: unknown, at: string): OneClickQuoteRequest {
  const o = obj(v, at);
  if (typeof o["dry"] !== "boolean") throw new Undecodable(`${at}.dry is not a boolean`);
  const slip = o["slippageTolerance"];
  if (typeof slip !== "number" || !Number.isInteger(slip) || slip < 0 || slip > 10_000)
    throw new Undecodable(`${at}.slippageTolerance is not basis points`);
  return {
    dry: o["dry"],
    swapType: literal(o, "swapType", at, ["EXACT_INPUT"] as const),
    slippageTolerance: slip,
    originAsset: str(o, "originAsset", at),
    depositType: literal(o, "depositType", at, ["ORIGIN_CHAIN"] as const),
    destinationAsset: str(o, "destinationAsset", at),
    amount: uint(o, "amount", at),
    refundTo: str(o, "refundTo", at),
    refundType: literal(o, "refundType", at, ["ORIGIN_CHAIN"] as const),
    recipient: str(o, "recipient", at),
    recipientType: literal(o, "recipientType", at, ["DESTINATION_CHAIN"] as const),
    deadline: instant(o, "deadline", at),
  };
}

function decodeQuote(v: unknown, at: string): OneClickQuote {
  const o = obj(v, at);
  const eta = o["timeEstimate"];
  if (typeof eta !== "number" || !Number.isFinite(eta) || eta < 0)
    throw new Undecodable(`${at}.timeEstimate is not a number of seconds`);
  return {
    depositAddress: optStr(o, "depositAddress", at),
    depositMemo: optStr(o, "depositMemo", at),
    amountIn: uint(o, "amountIn", at),
    amountInFormatted: str(o, "amountInFormatted", at, 80),
    amountInUsd: str(o, "amountInUsd", at, 80),
    minAmountIn: uint(o, "minAmountIn", at),
    amountOut: uint(o, "amountOut", at),
    amountOutFormatted: str(o, "amountOutFormatted", at, 80),
    amountOutUsd: str(o, "amountOutUsd", at, 80),
    minAmountOut: uint(o, "minAmountOut", at),
    deadline: optInstant(o, "deadline", at),
    timeWhenInactive: optInstant(o, "timeWhenInactive", at),
    timeEstimate: eta,
    refundFee: optUint(o, "refundFee", at),
    withdrawFee: optUint(o, "withdrawFee", at),
  };
}

/** Strict decode of a `/v0/quote` answer. Throws nothing: an undecodable value is `null` plus why. */
export function decodeQuoteResponse(
  v: unknown,
): { ok: true; value: OneClickQuoteResponse } | { ok: false; detail: string } {
  try {
    const o = obj(v, "response");
    return {
      ok: true,
      value: {
        correlationId: str(o, "correlationId", "response"),
        timestamp: instant(o, "timestamp", "response"),
        signature: str(o, "signature", "response", 1024),
        quoteRequest: decodeQuoteRequest(o["quoteRequest"], "response.quoteRequest"),
        quote: decodeQuote(o["quote"], "response.quote"),
      },
    };
  } catch (e) {
    if (e instanceof Undecodable) return { ok: false, detail: e.message };
    throw e;
  }
}

function txRefs(v: unknown, at: string): OneClickTxRef[] {
  if (!Array.isArray(v) || v.length > 64) throw new Undecodable(`${at} is not a list`);
  return v.map((x, i) => {
    const o = obj(x, `${at}[${i}]`);
    return { hash: str(o, "hash", at, 256), explorerUrl: optStr(o, "explorerUrl", at, 512) ?? "" };
  });
}

function strings(v: unknown, at: string): string[] {
  if (!Array.isArray(v) || v.length > 64 || v.some((x) => typeof x !== "string" || x.length > 256))
    throw new Undecodable(`${at} is not a list of strings`);
  return v as string[];
}

function decodeStatus(v: unknown): OneClickStatusResponse {
  const o = obj(v, "response");
  const q = obj(o["quoteResponse"], "response.quoteResponse");
  const d = obj(o["swapDetails"], "response.swapDetails");
  return {
    correlationId: str(o, "correlationId", "response"),
    status: literal(o, "status", "response", ONE_CLICK_STATUSES),
    updatedAt: instant(o, "updatedAt", "response"),
    quoteRequest: decodeQuoteRequest(q["quoteRequest"], "response.quoteResponse.quoteRequest"),
    quote: decodeQuote(q["quote"], "response.quoteResponse.quote"),
    swapDetails: {
      intentHashes: strings(d["intentHashes"], "swapDetails.intentHashes"),
      nearTxHashes: strings(d["nearTxHashes"], "swapDetails.nearTxHashes"),
      originChainTxHashes: txRefs(d["originChainTxHashes"], "swapDetails.originChainTxHashes"),
      destinationChainTxHashes: txRefs(d["destinationChainTxHashes"], "swapDetails.destinationChainTxHashes"),
      amountIn: optUint(d, "amountIn", "swapDetails"),
      amountOut: optUint(d, "amountOut", "swapDetails"),
      amountOutFormatted: optStr(d, "amountOutFormatted", "swapDetails", 80),
      depositedAmount: optUint(d, "depositedAmount", "swapDetails"),
      refundedAmount: optUint(d, "refundedAmount", "swapDetails"),
      refundReason: optStr(d, "refundReason", "swapDetails", 256),
    },
  };
}

function decodeTokens(v: unknown): OneClickToken[] {
  if (!Array.isArray(v) || v.length > 5_000) throw new Undecodable("token list is not a list");
  return v.map((x, i) => {
    const at = `tokens[${i}]`;
    const o = obj(x, at);
    const decimals = o["decimals"];
    if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 36)
      throw new Undecodable(`${at}.decimals is not a small integer`);
    const price = o["price"];
    if (typeof price !== "number" || !Number.isFinite(price) || price < 0)
      throw new Undecodable(`${at}.price is not a number`);
    return {
      assetId: str(o, "assetId", at),
      decimals,
      blockchain: str(o, "blockchain", at, 32),
      symbol: str(o, "symbol", at, 32),
      price,
      priceUpdatedAt: str(o, "priceUpdatedAt", at, 64),
      contractAddress: optStr(o, "contractAddress", at),
    };
  });
}

/* ----------------------------------- client ----------------------------------- */

/** What a read of 1Click produced. Only `OK` carries data; nothing else is ever read as a state. */
export type OneClickRead<T> =
  | { readonly kind: "OK"; readonly value: T }
  | { readonly kind: "TIMEOUT" }
  | { readonly kind: "TRANSPORT_ERROR"; readonly code: string }
  | { readonly kind: "HTTP_ERROR"; readonly status: number; readonly message: string }
  | { readonly kind: "AMBIGUOUS"; readonly detail: string };

export interface OneClickClientOptions {
  /** Base URL of the 1Click service, without a path (`https://host` or a loopback simulator). */
  readonly baseUrl: string;
  /** Optional partner token, sent as `Authorization: Bearer`. Never logged, never returned. */
  readonly bearer?: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly fetch?: typeof fetch;
}

/** Parameters of a dry quote: a quote request without the `dry` flag, which this client owns. */
export type DryQuoteParams = Omit<OneClickQuoteRequest, "dry">;

/**
 * Read-only 1Click client. `dryQuote` always sends `dry: true`, and treats an answer that names a
 * deposit address as AMBIGUOUS, because a dry quote must not create one.
 */
export class OneClickClient {
  readonly baseUrl: string;
  private readonly bearer: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly fetchImpl: typeof fetch;

  constructor(o: OneClickClientOptions) {
    const u = new URL(o.baseUrl);
    if (u.pathname !== "/" || u.search !== "" || u.hash !== "" || u.username !== "" || u.password !== "")
      throw new Error("1Click base URL must be an origin without path, query or credentials");
    this.baseUrl = u.origin;
    this.bearer = o.bearer;
    this.timeoutMs = o.timeoutMs ?? 10_000;
    this.maxBytes = o.maxResponseBytes ?? 4 * 1024 * 1024;
    this.fetchImpl = o.fetch ?? fetch;
  }

  tokens(): Promise<OneClickRead<OneClickToken[]>> {
    return this.read("GET", "/v0/tokens", undefined, decodeTokens);
  }

  dryQuote(p: DryQuoteParams): Promise<OneClickRead<OneClickQuoteResponse>> {
    const body: OneClickQuoteRequest = { ...p, dry: true };
    return this.read("POST", "/v0/quote", body, (v) => {
      const r = decodeQuoteResponse(v);
      if (!r.ok) throw new Undecodable(r.detail);
      if (r.value.quoteRequest.dry !== true) throw new Undecodable("the answer is not for a dry request");
      if (r.value.quote.depositAddress !== null)
        throw new Undecodable("a dry quote answered with a deposit address");
      return r.value;
    });
  }

  status(depositAddress: string, depositMemo?: string): Promise<OneClickRead<OneClickStatusResponse>> {
    const q = new URLSearchParams({ depositAddress });
    if (depositMemo !== undefined) q.set("depositMemo", depositMemo);
    return this.read("GET", `/v0/status?${q.toString()}`, undefined, decodeStatus);
  }

  private async read<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    decode: (v: unknown) => T,
  ): Promise<OneClickRead<T>> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (body !== undefined) headers["content-type"] = "application/json";
      if (this.bearer !== undefined) headers["authorization"] = `Bearer ${this.bearer}`;
      const res = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers,
        redirect: "error",
        signal: ac.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > this.maxBytes) return { kind: "AMBIGUOUS", detail: "response too large" };
      const text = new TextDecoder().decode(buf);
      if (!res.ok) return { kind: "HTTP_ERROR", status: res.status, message: errorMessage(text) };
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return { kind: "AMBIGUOUS", detail: "response is not JSON" };
      }
      try {
        return { kind: "OK", value: decode(json) };
      } catch (e) {
        if (e instanceof Undecodable) return { kind: "AMBIGUOUS", detail: e.message };
        throw e;
      }
    } catch (e) {
      if (ac.signal.aborted) return { kind: "TIMEOUT" };
      const cause = (e as { cause?: { code?: unknown } }).cause;
      const code = typeof cause?.code === "string" ? cause.code : (e as Error).name || "FETCH_FAILED";
      return { kind: "TRANSPORT_ERROR", code: String(code).slice(0, 64) };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The provider's own `message`, cut short and stripped to printable ASCII; never the raw body. */
function errorMessage(text: string): string {
  let m = "";
  try {
    const j = JSON.parse(text) as { message?: unknown };
    if (typeof j?.message === "string") m = j.message;
  } catch {
    m = "";
  }
  return m.replace(/[^\x20-\x7e]/g, " ").slice(0, 200);
}

/* ------------------------------- request building ------------------------------- */

export interface CashOutParams {
  /** The supplier's own NEAR account: it pays the deposit and receives any refund. */
  readonly supplierAccountId: string;
  readonly originAsset: string;
  readonly destinationAsset: string;
  /** Base units of the origin asset. */
  readonly amount: string;
  /** Address on the destination chain, exactly as the supplier typed it. */
  readonly recipient: string;
  readonly slippageBps: number;
  /** Milliseconds since the epoch. */
  readonly deadlineMs: number;
}

/**
 * The one request shape of a cash-out. The dry request the server sends and the real request the
 * supplier sends are this same object and differ in `dry` only, so what was previewed is what is
 * asked for.
 */
export function buildQuoteRequest(p: CashOutParams, dry: boolean): OneClickQuoteRequest {
  return {
    dry,
    swapType: "EXACT_INPUT",
    slippageTolerance: p.slippageBps,
    originAsset: p.originAsset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: p.destinationAsset,
    amount: p.amount,
    refundTo: p.supplierAccountId,
    refundType: "ORIGIN_CHAIN",
    recipient: p.recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(p.deadlineMs).toISOString(),
  };
}

/** NEP-141 contract of a 1Click NEAR asset id (`nep141:<account>`), or null for any other id. */
export function nep141Contract(assetId: string): string | null {
  const m = /^nep141:([a-z0-9._-]{2,64})$/.exec(assetId);
  if (!m?.[1]) return null;
  return /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(m[1]) ? m[1] : null;
}

/* ------------------------------ amounts and the fee ------------------------------ */

const DECIMAL = /^(0|[1-9][0-9]{0,30})(\.[0-9]{1,18})?$/;

function scaled(dec: string): bigint | null {
  if (!DECIMAL.test(dec)) return null;
  const [whole = "0", frac = ""] = dec.split(".");
  return BigInt(whole) * 10n ** 18n + BigInt(frac.padEnd(18, "0"));
}

function unscaled(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const frac = (a % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${a / 10n ** 18n}${frac ? `.${frac}` : ""}`;
}

export interface QuoteCost {
  /** `amountInUsd - amountOutUsd` as 1Click priced both sides; null if either is not a decimal. */
  readonly usd: string | null;
  /** The same cost in basis points of the amount in; null when it cannot be computed. */
  readonly bps: number | null;
}

/**
 * What the route costs the supplier, from the quote's own USD valuations: everything between the
 * amount in and the amount out (solver spread, 1Click fee, destination withdrawal fee). It is the
 * provider's valuation at quote time, not a guarantee; `minAmountOut` is the guarantee.
 */
export function quoteCost(q: Pick<OneClickQuote, "amountInUsd" | "amountOutUsd">): QuoteCost {
  const a = scaled(q.amountInUsd);
  const b = scaled(q.amountOutUsd);
  if (a === null || b === null) return { usd: null, bps: null };
  const diff = a - b;
  return { usd: unscaled(diff), bps: a === 0n ? null : Number((diff * 10_000n) / a) };
}

/* --------------------------- checking the supplier's quote --------------------------- */

/** A NEAR account a deposit can be sent to: a 64-hex implicit account or a named account. */
const NEAR_ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export interface CheckedQuote {
  readonly depositAddress: string;
  readonly amountIn: string;
  readonly amountOut: string;
  readonly minAmountOut: string;
  readonly amountOutFormatted: string;
  /** The earlier of the request deadline and the quote's own deadline, in milliseconds. */
  readonly depositBeforeMs: number;
  readonly correlationId: string;
}

/** A quote must leave at least this long to send the deposit. */
export const MIN_DEPOSIT_WINDOW_MS = 60_000;

/**
 * Check the real (`dry: false`) quote the supplier obtained against the request Dockside showed.
 * Fail closed: every field the supplier previewed must come back unchanged, the answer must name
 * exactly one NEAR deposit address and no memo, the amount in must be the exact amount asked for,
 * and there must still be time to deposit. Nothing here proves 1Click issued the answer (the
 * response signature has no published verification key); the supplier pastes what their own
 * request returned, and it is the supplier's own money that follows it.
 */
export function checkRealQuote(
  expected: OneClickQuoteRequest,
  pasted: unknown,
  nowMs: number,
): { ok: true; quote: CheckedQuote } | { ok: false; mismatches: string[] } {
  const d = decodeQuoteResponse(pasted);
  if (!d.ok) return { ok: false, mismatches: [`undecodable: ${d.detail}`] };
  const { quoteRequest: r, quote: q } = d.value;
  const bad: string[] = [];
  if (expected.dry !== false) bad.push("expected.dry");
  if (r.dry !== false) bad.push("dry");
  for (const k of ["originAsset", "destinationAsset", "amount", "refundTo", "recipient"] as const)
    if (r[k] !== expected[k]) bad.push(k);
  if (r.slippageTolerance !== expected.slippageTolerance) bad.push("slippageTolerance");
  if (Date.parse(r.deadline) !== Date.parse(expected.deadline)) bad.push("deadline");
  if (q.amountIn !== expected.amount) bad.push("amountIn");
  if (BigInt(q.minAmountOut) <= 0n || BigInt(q.amountOut) < BigInt(q.minAmountOut)) bad.push("minAmountOut");
  const addr = q.depositAddress;
  if (addr === null || addr.length < 2 || addr.length > 64 || !NEAR_ACCOUNT.test(addr))
    bad.push("depositAddress");
  else if (addr === expected.refundTo) bad.push("depositAddress");
  if (q.depositMemo !== null) bad.push("depositMemo");
  const before = Math.min(
    Date.parse(expected.deadline),
    q.deadline === null ? Number.POSITIVE_INFINITY : Date.parse(q.deadline),
    q.timeWhenInactive === null ? Number.POSITIVE_INFINITY : Date.parse(q.timeWhenInactive),
  );
  if (!(before - nowMs >= MIN_DEPOSIT_WINDOW_MS)) bad.push("deadline_passed");
  if (bad.length > 0 || addr === null) return { ok: false, mismatches: bad };
  return {
    ok: true,
    quote: {
      depositAddress: addr,
      amountIn: q.amountIn,
      amountOut: q.amountOut,
      minAmountOut: q.minAmountOut,
      amountOutFormatted: q.amountOutFormatted,
      depositBeforeMs: before,
      correlationId: d.value.correlationId,
    },
  };
}

/* --------------------------------- the deposit call --------------------------------- */

/** Same shape as the escrow relay calls, so the web panel renders it the same way. */
export interface WalletCall {
  readonly receiverId: string;
  readonly methodName: string;
  readonly args: Record<string, unknown>;
  readonly gas: string;
  readonly depositYocto: string;
}

/** `ft_transfer` of the exact amount to the deposit address, with the one yoctoNEAR NEP-141 requires. */
export function depositCall(tokenContract: string, depositAddress: string, amount: string): WalletCall {
  return {
    receiverId: tokenContract,
    methodName: "ft_transfer",
    args: { receiver_id: depositAddress, amount },
    gas: "30000000000000",
    depositYocto: "1",
  };
}

/* ---------------------------------- reconciliation ---------------------------------- */

/** What 1Click said about a deposit address. */
export type ProviderObservation =
  | { readonly kind: "STATUS"; readonly status: OneClickStatus }
  | { readonly kind: "UNKNOWN_ADDRESS" }
  | { readonly kind: "UNREADABLE"; readonly why: string };

/** What the NEAR node said about the deposit transaction the supplier named. */
export type DepositObservation =
  | { readonly kind: "NOT_PROVIDED" }
  /** Final, successful, and exactly the expected `ft_transfer` to the deposit address. */
  | { readonly kind: "CONFIRMED" }
  /** No usable transaction hash, but the deposit address already holds the token on NEAR. */
  | { readonly kind: "FUNDS_AT_ADDRESS" }
  /** Final and failed: the chain proves nothing moved. */
  | { readonly kind: "FAILED_NO_TRANSFER" }
  | { readonly kind: "EXECUTING" }
  | { readonly kind: "NOT_FOUND" }
  /** Final and successful, but not the expected transfer (other token, receiver or amount). */
  | { readonly kind: "DIFFERENT_TRANSACTION" }
  | { readonly kind: "UNREADABLE"; readonly why: string };

export const CASH_OUT_STATES = [
  "AWAITING_DEPOSIT",
  "QUOTE_EXPIRED",
  "DEPOSIT_FAILED_NO_TRANSFER",
  "DEPOSIT_SENT_WAITING_FOR_PROVIDER",
  "IN_PROGRESS",
  "DELIVERED",
  "REFUNDED",
  "INCOMPLETE_DEPOSIT",
  "FAILED",
  "UNKNOWN",
] as const;
export type CashOutState = (typeof CASH_OUT_STATES)[number];

export interface CashOutReconciliation {
  readonly state: CashOutState;
  /**
   * Whether sending the deposit is safe right now. True only when nothing has been sent yet and
   * the quote is still open, or when the chain itself proves the earlier attempt moved nothing.
   */
  readonly maySendDeposit: boolean;
  readonly terminal: boolean;
  readonly reason: string;
}

const WAIT = "Do not send the deposit again.";

/**
 * Decide what a cash-out's state is from two independent reads, and whether a deposit may be sent.
 * The rule this encodes: a missing, late or unreadable answer is never evidence that a deposit did
 * not happen. Only the chain saying "this transaction failed" or nothing having been sent at all
 * allows a deposit; every other doubt is UNKNOWN and waits for the next read.
 */
export function reconcileCashOut(i: {
  readonly provider: ProviderObservation;
  readonly deposit: DepositObservation;
  readonly nowMs: number;
  /** Deposit cut-off of the quote, in milliseconds; null when no readable status supplied one. */
  readonly depositBeforeMs: number | null;
}): CashOutReconciliation {
  const out = (state: CashOutState, maySendDeposit: boolean, terminal: boolean, reason: string) => ({
    state,
    maySendDeposit,
    terminal,
    reason,
  });
  const p = i.provider;
  if (p.kind === "UNREADABLE")
    return out(
      "UNKNOWN",
      false,
      false,
      `The 1Click status could not be read (${p.why}). That says nothing about the deposit. ${WAIT} Read the status again.`,
    );
  if (p.kind === "UNKNOWN_ADDRESS")
    return out(
      "UNKNOWN",
      false,
      false,
      "1Click does not know this deposit address. Do not send anything to it; check the address against the quote you received.",
    );
  switch (p.status) {
    case "SUCCESS":
      return out("DELIVERED", false, true, "1Click reports the swap delivered to the recipient.");
    case "REFUNDED":
      return out(
        "REFUNDED",
        false,
        true,
        "1Click refunded the deposit to the refund account. A new cash-out needs a new quote.",
      );
    case "FAILED":
      return out(
        "FAILED",
        false,
        true,
        `1Click reports the swap failed. ${WAIT} Any return of funds is reported by 1Click on this deposit address.`,
      );
    case "INCOMPLETE_DEPOSIT":
      return out(
        "INCOMPLETE_DEPOSIT",
        false,
        false,
        `1Click received less than the quoted amount. ${WAIT} It refunds an incomplete deposit after the deadline.`,
      );
    case "PROCESSING":
    case "KNOWN_DEPOSIT_TX":
      return out("IN_PROGRESS", false, false, `1Click has the deposit and is executing the swap. ${WAIT}`);
    case "PENDING_DEPOSIT":
      break;
  }
  const d = i.deposit;
  const open = i.depositBeforeMs !== null && i.depositBeforeMs - i.nowMs >= MIN_DEPOSIT_WINDOW_MS;
  switch (d.kind) {
    case "CONFIRMED":
      return out(
        "DEPOSIT_SENT_WAITING_FOR_PROVIDER",
        false,
        false,
        `The deposit transfer is final on NEAR; 1Click has not reported it yet. ${WAIT}`,
      );
    case "FUNDS_AT_ADDRESS":
      return out(
        "DEPOSIT_SENT_WAITING_FOR_PROVIDER",
        false,
        false,
        `The deposit address already holds the token on NEAR; 1Click has not reported it yet. ${WAIT}`,
      );
    case "EXECUTING":
      return out("UNKNOWN", false, false, `The deposit transaction is still executing. ${WAIT}`);
    case "NOT_FOUND":
      return out(
        "UNKNOWN",
        false,
        false,
        `The NEAR node does not know this transaction hash yet. That is not proof it failed. ${WAIT} Check the hash and read again.`,
      );
    case "UNREADABLE":
      return out("UNKNOWN", false, false, `The deposit transaction could not be read (${d.why}). ${WAIT}`);
    case "DIFFERENT_TRANSACTION":
      return out(
        "UNKNOWN",
        false,
        false,
        `That transaction is not the quoted transfer to this deposit address. ${WAIT} Enter the hash of the deposit you sent.`,
      );
    case "FAILED_NO_TRANSFER":
      return open
        ? out(
            "DEPOSIT_FAILED_NO_TRANSFER",
            true,
            false,
            "The deposit transaction failed on NEAR, so nothing moved. The quote is still open: the deposit can be sent again.",
          )
        : out(
            "QUOTE_EXPIRED",
            false,
            true,
            "The deposit transaction failed on NEAR, so nothing moved, and the quote is no longer open. Start again with a new quote.",
          );
    case "NOT_PROVIDED":
      return open
        ? out(
            "AWAITING_DEPOSIT",
            true,
            false,
            "1Click is waiting for the deposit. Send it once; if you already sent it, enter its transaction hash instead of sending again.",
          )
        : out(
            "QUOTE_EXPIRED",
            false,
            false,
            "The quote is no longer open for a deposit. Do not send to this address; if you already sent, enter the transaction hash.",
          );
  }
}
