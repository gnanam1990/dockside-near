import type { AuthContext } from "@dockside/authority";
import { DocksideError, fail, type Network, type TradeTerms } from "@dockside/core";
import type { TxOutcome } from "@dockside/near";
import {
  buildQuoteRequest,
  type CashOutParams,
  checkRealQuote,
  type DepositObservation,
  depositCall,
  nep141Contract,
  type OneClickClient,
  type OneClickQuoteRequest,
  type OneClickRead,
  type OneClickToken,
  type ProviderObservation,
  quoteCost,
  reconcileCashOut,
  type WalletCall,
} from "@dockside/payout";
import { z } from "zod";
import type { AppDeps } from "./app.js";
import { type Route, route } from "./routing.js";
import { loadTrade, mods, must, relationsOf } from "./trades.js";

/**
 * M52 supplier cash-out ("Move to another chain"), ADR-0027.
 *
 * After a release the money is in the supplier's own NEAR account. These routes help the supplier
 * move it to another chain through NEAR Intents 1Click without Dockside ever holding or moving it:
 *
 * - the server asks 1Click for a `dry: true` quote and for statuses, and reads NEAR; it never asks
 *   for a real quote, never creates a deposit address and never signs or sends a transaction;
 * - the real quote is requested by the supplier's own client with the exact request shown here,
 *   and the deposit is an `ft_transfer` the supplier's own wallet signs;
 * - nothing is stored: a cash-out is identified by its 1Click deposit address, and every answer is
 *   recomputed from 1Click and the chain at the moment it is asked for.
 *
 * Only the trade's bound supplier signer may use them. The escrow, the relayer and the journal are
 * not involved, and the M06 funded rail stays BLOCKED.
 */
export interface CashOutModule {
  /** Read-only 1Click client (tokens, dry quotes, status). */
  readonly client: Pick<OneClickClient, "tokens" | "dryQuote" | "status" | "baseUrl">;
  /** NEAR network the 1Click service settles on. A deposit is offered only for trades on it. */
  readonly nearNetwork: Network;
  /** Read-only chain access used to reconcile a deposit: one transaction and one token balance. */
  readonly tx: { status(txHash: string, senderId: string): Promise<TxOutcome> };
  readonly token: (contract: string) => { balanceOf(accountId: string): Promise<bigint> };
}

/** A real quote the supplier requests is open for this long (the deadline both requests carry). */
export const CASH_OUT_DEADLINE_MS = 30 * 60_000;

const ASSET_ID = /^[A-Za-z0-9._:-]{3,160}$/;
/** Destination addresses of the supported chains use these characters; nothing that needs quoting. */
const RECIPIENT = /^[A-Za-z0-9._:-]{2,128}$/;
const DEPOSIT_ADDRESS = /^[a-z0-9._-]{2,64}$/;
const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const UINT = /^[1-9][0-9]{0,38}$/;

const quoteParams = z
  .object({
    originAsset: z.string().regex(ASSET_ID),
    destinationAsset: z.string().regex(ASSET_ID),
    amount: z.string().regex(UINT),
    recipient: z.string().regex(RECIPIENT),
    slippageBps: z.number().int().min(1).max(500),
  })
  .strict();
type QuoteParams = z.infer<typeof quoteParams>;

const depositBody = z
  .object({
    request: quoteParams.extend({ deadline: z.string().max(40) }).strict(),
    quoteResponse: z.record(z.string(), z.unknown()),
  })
  .strict();

function unavailable<T>(what: string, r: Exclude<OneClickRead<T>, { kind: "OK" }>): never {
  switch (r.kind) {
    case "TIMEOUT":
      return fail("UPSTREAM_TIMEOUT", `1Click did not answer the ${what} in time`, { provider: "1click" });
    case "TRANSPORT_ERROR":
      return fail("UPSTREAM_ERROR", `1Click could not be reached for the ${what}`, {
        provider: "1click",
        transport: r.code,
      });
    case "AMBIGUOUS":
      return fail("UPSTREAM_INVALID", `1Click answered the ${what} in an unexpected shape`, {
        provider: "1click",
      });
    case "HTTP_ERROR":
      if (r.status >= 400 && r.status < 500 && r.status !== 401 && r.status !== 403 && r.status !== 429)
        return fail("VALIDATION_FAILED", `1Click refused the ${what}`, {
          reason: "ONE_CLICK_REFUSED",
          providerStatus: r.status,
          providerMessage: r.message,
        });
      return fail("UPSTREAM_ERROR", `1Click answered the ${what} with an error`, {
        provider: "1click",
        providerStatus: r.status,
      });
  }
}

function nearCliNetwork(n: Network): string {
  return n === "near-mainnet" ? "mainnet" : "testnet";
}

/** The same call as a near-cli-rs command line for the supplier's own keychain. */
function nearCli(call: WalletCall, signerId: string, network: Network): string {
  const args = Buffer.from(JSON.stringify(call.args), "utf8").toString("base64");
  const tgas = BigInt(call.gas) / 1_000_000_000_000n;
  return [
    "near contract call-function as-transaction",
    call.receiverId,
    call.methodName,
    "base64-args",
    args,
    "prepaid-gas",
    `'${tgas}.0 Tgas'`,
    "attached-deposit",
    `'${call.depositYocto} yoctoNEAR'`,
    "sign-as",
    signerId,
    "network-config",
    nearCliNetwork(network),
    "sign-with-keychain send",
  ].join(" ");
}

/**
 * The real quote request as commands for the supplier's own shell. Every value was validated
 * against a character set without quotes, backticks, dollars or whitespace before it reaches here.
 */
function realQuoteCommands(baseUrl: string, request: OneClickQuoteRequest) {
  const json = JSON.stringify(request);
  if (/['`$\s\\]/.test(json)) fail("INTERNAL", "quote request is not shell-safe");
  const url = `${baseUrl}/v0/quote`;
  return {
    url,
    request,
    powershell: `Invoke-RestMethod -Method Post -Uri '${url}' -ContentType 'application/json' -Body '${json}' | ConvertTo-Json -Depth 8`,
    curl: `curl -sS -X POST '${url}' -H 'content-type: application/json' -d '${json}'`,
  };
}

function originAssets(tokens: readonly OneClickToken[]) {
  return tokens
    .filter((t) => t.blockchain === "near" && nep141Contract(t.assetId) !== null)
    .map((t) => ({
      assetId: t.assetId,
      symbol: t.symbol,
      decimals: t.decimals,
      contract: nep141Contract(t.assetId) as string,
    }));
}

function formatUnits(v: string, decimals: number): string {
  const s = v.padStart(decimals + 1, "0");
  const frac = decimals === 0 ? "" : s.slice(s.length - decimals).replace(/0+$/, "");
  return `${s.slice(0, s.length - decimals)}${frac ? `.${frac}` : ""}`;
}

/**
 * The receipt of this transaction that carries exactly the quoted `ft_transfer` from the supplier,
 * as its own execution status; ABSENT when there is none, null when the node returned no receipts.
 */
function quotedTransfer(
  o: Extract<TxOutcome, { receipts: unknown }>,
  supplier: string,
  token: string,
  depositAddress: string,
  amount: string,
): "SUCCESS" | "FAILURE" | "PENDING" | "ABSENT" | null {
  if (o.receipts === null) return null;
  const hit = o.receipts.find(
    (rc) =>
      rc.predecessorId === supplier &&
      rc.receiverId === token &&
      rc.calls.some((c) => {
        if (c.method !== "ft_transfer") return false;
        try {
          const a = JSON.parse(c.args) as Record<string, unknown>;
          return a["receiver_id"] === depositAddress && a["amount"] === amount;
        } catch {
          return false;
        }
      }),
  );
  return hit ? hit.status : "ABSENT";
}

/**
 * Two independent chain reads about the deposit: the transaction the supplier named, and the
 * token balance of the deposit address. Either one being unreadable is reported as unreadable;
 * "may send" is reached only when the balance reads zero.
 */
async function observeDeposit(
  co: CashOutModule,
  supplier: string,
  token: string,
  depositAddress: string,
  amount: string,
  txHash: string | null,
): Promise<{ observation: DepositObservation; balance: string | null }> {
  let balance: bigint | null = null;
  let balanceError = "";
  try {
    balance = await co.token(token).balanceOf(depositAddress);
  } catch (e) {
    balanceError = e instanceof DocksideError ? e.code : "READ_FAILED";
  }
  const bal = balance === null ? null : balance.toString(10);
  const obs = (observation: DepositObservation) => ({ observation, balance: bal });
  let tx: TxOutcome | null = null;
  if (txHash !== null) {
    try {
      tx = await co.tx.status(txHash, supplier);
    } catch (e) {
      return obs({
        kind: "UNREADABLE",
        why: `transaction read: ${e instanceof DocksideError ? e.code : "READ_FAILED"}`,
      });
    }
    if (tx.kind === "NOT_FOUND") return obs({ kind: "NOT_FOUND" });
    if (tx.kind === "EXECUTING") return obs({ kind: "EXECUTING" });
    const quoted = quotedTransfer(tx, supplier, token, depositAddress, amount);
    if (quoted === null)
      return obs({ kind: "UNREADABLE", why: "the node returned no receipts for the transaction" });
    if (quoted === "ABSENT") return obs({ kind: "DIFFERENT_TRANSACTION" });
    if (quoted === "PENDING") return obs({ kind: "EXECUTING" });
    if (quoted === "SUCCESS")
      return obs(
        tx.kind === "FINAL_SUCCESS"
          ? { kind: "CONFIRMED" }
          : { kind: "UNREADABLE", why: "the transaction failed but its transfer receipt reads successful" },
      );
    // The transfer receipt itself failed: nothing moved in it. The balance read below still decides.
  }
  // From here a deposit could be allowed (nothing named, or the named transfer failed), so the
  // deposit address itself must be read and must hold none of the token.
  if (balance === null) return obs({ kind: "UNREADABLE", why: `deposit address balance: ${balanceError}` });
  if (balance > 0n) return obs({ kind: "FUNDS_AT_ADDRESS" });
  return obs(tx === null ? { kind: "NOT_PROVIDED" } : { kind: "FAILED_NO_TRANSFER" });
}

export function cashOutRoutes(d: AppDeps): Route[] {
  const r = route;
  /** The bound supplier signer of the trade, and nobody else. */
  const entry = (ctx: AuthContext | null, params: Record<string, string>) => {
    const c = must(ctx);
    const m = mods(d);
    const t: TradeTerms = loadTrade(m, c, params["id"] as string);
    if (!relationsOf(c, t).includes("SUPPLIER"))
      fail("FORBIDDEN", "only the trade's supplier signer can cash out", { reason: "NOT_SUPPLIER" });
    return { c, t, supplier: t.payout.destination };
  };
  const module = (): CashOutModule => {
    if (!d.cashOut)
      fail("INVALID_STATE", "cash-out is not configured", { reason: "CASH_OUT_NOT_CONFIGURED" });
    return d.cashOut;
  };
  const tokensOr = async (co: CashOutModule): Promise<OneClickToken[]> => {
    const read = await co.client.tokens();
    if (read.kind !== "OK") return unavailable("token list", read);
    return read.value;
  };
  /** Both assets must be ones 1Click lists; the origin must be a NEP-141 token on NEAR. */
  const assetsOf = (tokens: readonly OneClickToken[], p: QuoteParams) => {
    const origin = originAssets(tokens).find((a) => a.assetId === p.originAsset);
    if (!origin)
      fail("VALIDATION_FAILED", "origin asset is not a NEAR token 1Click lists", { reason: "ORIGIN_ASSET" });
    const destination = tokens.find((t) => t.assetId === p.destinationAsset);
    if (!destination || destination.assetId === origin.assetId)
      fail("VALIDATION_FAILED", "destination asset is not one 1Click lists", {
        reason: "DESTINATION_ASSET",
      });
    return { origin, destination };
  };
  const paramsOf = (p: QuoteParams, supplier: string, deadlineMs: number): CashOutParams => ({
    supplierAccountId: supplier,
    originAsset: p.originAsset,
    destinationAsset: p.destinationAsset,
    amount: p.amount,
    recipient: p.recipient,
    slippageBps: p.slippageBps,
    deadlineMs,
  });

  return [
    /** What the supplier can choose from, and whether a deposit can be offered for this trade. */
    r("GET", "/v1/trades/:id/cash-out", true, undefined, async ({ ctx, params }) => {
      const { t, supplier } = entry(ctx, params);
      const base = { tradeId: t.tradeId, supplierAccountId: supplier, tradeNetwork: t.network };
      const co = d.cashOut;
      if (!co)
        return {
          ...base,
          status: "NOT_CONFIGURED",
          reason: "This deployment has no 1Click endpoint configured (DOCKSIDE_ONE_CLICK_URL).",
          observedAt: d.clock.now(),
        };
      const read = await co.client.tokens();
      const common = {
        ...base,
        providerUrl: co.client.baseUrl,
        providerNetwork: co.nearNetwork,
        depositEnabled: co.nearNetwork === t.network,
        observedAt: d.clock.now(),
      };
      if (read.kind !== "OK")
        return {
          ...common,
          status: "PROVIDER_UNAVAILABLE",
          reason: `The 1Click token list could not be read (${read.kind}). Nothing was requested or sent.`,
        };
      return {
        ...common,
        status: "READY",
        originAssets: originAssets(read.value),
        destinationAssets: read.value.map((x) => ({
          assetId: x.assetId,
          symbol: x.symbol,
          decimals: x.decimals,
          blockchain: x.blockchain,
        })),
      };
    }),

    /** A `dry: true` quote. Nothing is committed: no deposit address exists after this call. */
    r("POST", "/v1/trades/:id/cash-out/dry-quotes", true, quoteParams, async ({ ctx, params, body }) => {
      const { t, supplier } = entry(ctx, params);
      const co = module();
      const p = body as QuoteParams;
      const { origin, destination } = assetsOf(await tokensOr(co), p);
      const now = d.clock.now();
      const cp = paramsOf(p, supplier, now + CASH_OUT_DEADLINE_MS);
      const { dry: _dry, ...dryParams } = buildQuoteRequest(cp, true);
      const read = await co.client.dryQuote(dryParams);
      if (read.kind !== "OK") return unavailable("dry quote", read);
      const q = read.value.quote;
      const depositEnabled = co.nearNetwork === t.network;
      return {
        tradeId: t.tradeId,
        dry: true,
        committed: "NOTHING",
        source: "1Click dry quote",
        observedAt: now,
        origin: { ...origin, signerId: supplier },
        destination: {
          assetId: destination.assetId,
          symbol: destination.symbol,
          decimals: destination.decimals,
          blockchain: destination.blockchain,
          recipient: p.recipient,
        },
        quote: {
          amountIn: q.amountIn,
          amountInFormatted: q.amountInFormatted,
          amountInUsd: q.amountInUsd,
          amountOut: q.amountOut,
          amountOutFormatted: q.amountOutFormatted,
          amountOutUsd: q.amountOutUsd,
          minAmountOut: q.minAmountOut,
          minAmountOutFormatted: formatUnits(q.minAmountOut, destination.decimals),
          cost: quoteCost(q),
          withdrawFee: q.withdrawFee,
          refundFee: q.refundFee,
          timeEstimateSeconds: q.timeEstimate,
          slippageBps: p.slippageBps,
          deadline: cp.deadlineMs,
          correlationId: read.value.correlationId,
        },
        depositEnabled,
        // The request the supplier's own client sends: the same request with `dry: false`.
        realQuote: depositEnabled ? realQuoteCommands(co.client.baseUrl, buildQuoteRequest(cp, false)) : null,
        depositDisabledReason: depositEnabled
          ? null
          : `1Click settles on ${co.nearNetwork}; this trade is on ${t.network}. The quote is a preview only and no deposit call is offered.`,
      };
    }),

    /**
     * The supplier pastes the real quote their own request returned. It is checked against the
     * previewed request and against 1Click itself (the deposit address must be one 1Click knows,
     * for the same request, still waiting for a deposit), and the answer is the exact
     * `ft_transfer` for the supplier's wallet. Dockside sends nothing.
     */
    r("POST", "/v1/trades/:id/cash-out/deposit-calls", true, depositBody, async ({ ctx, params, body }) => {
      const { t, supplier } = entry(ctx, params);
      const co = module();
      if (co.nearNetwork !== t.network)
        fail("INVALID_STATE", "1Click does not settle on this trade's network", {
          reason: "CASH_OUT_WRONG_NETWORK",
          providerNetwork: co.nearNetwork,
          tradeNetwork: t.network,
        });
      const b = body as z.infer<typeof depositBody>;
      const deadlineMs = Date.parse(b.request.deadline);
      if (!Number.isFinite(deadlineMs)) fail("VALIDATION_FAILED", "request deadline is not a timestamp");
      const { origin } = assetsOf(await tokensOr(co), b.request);
      const expected = buildQuoteRequest(paramsOf(b.request, supplier, deadlineMs), false);
      const now = d.clock.now();
      const checked = checkRealQuote(expected, b.quoteResponse, now);
      if (!checked.ok)
        fail("VALIDATION_FAILED", "the quote does not match the previewed request", {
          reason: "QUOTE_MISMATCH",
          fields: checked.mismatches.join(",").slice(0, 400),
        });
      const q = checked.quote;
      // The pasted answer is not trusted on its own: 1Click must know this deposit address.
      const st = await co.client.status(q.depositAddress);
      if (st.kind === "HTTP_ERROR" && st.status === 404)
        fail("VALIDATION_FAILED", "1Click does not know this deposit address", {
          reason: "DEPOSIT_ADDRESS_UNKNOWN",
        });
      if (st.kind !== "OK") return unavailable("status of the deposit address", st);
      const same = checkRealQuote(
        expected,
        {
          correlationId: st.value.correlationId,
          timestamp: st.value.updatedAt,
          signature: "status",
          quoteRequest: st.value.quoteRequest,
          quote: st.value.quote,
        },
        now,
      );
      if (!same.ok || same.quote.depositAddress !== q.depositAddress)
        fail("VALIDATION_FAILED", "1Click holds a different quote for this deposit address", {
          reason: "QUOTE_MISMATCH",
          fields: same.ok ? "depositAddress" : same.mismatches.join(",").slice(0, 400),
        });
      if (st.value.status !== "PENDING_DEPOSIT")
        fail("INVALID_STATE", "this deposit address is no longer waiting for a deposit", {
          reason: "CASH_OUT_NOT_PENDING",
          providerStatus: st.value.status,
        });
      const call = depositCall(origin.contract, q.depositAddress, q.amountIn);
      return {
        tradeId: t.tradeId,
        signerId: supplier,
        depositAddress: q.depositAddress,
        depositBefore: q.depositBeforeMs,
        amountIn: q.amountIn,
        amountOut: q.amountOut,
        minAmountOut: q.minAmountOut,
        amountOutFormatted: q.amountOutFormatted,
        call,
        nearCli: nearCli(call, supplier, co.nearNetwork),
        network: co.nearNetwork,
        sentByDockside: false,
        observedAt: now,
      };
    }),

    /**
     * Reconciled state of one cash-out, recomputed from 1Click and from NEAR on every call. A
     * deposit call is included only when the reconciliation allows a deposit.
     */
    r("GET", "/v1/trades/:id/cash-out/status", true, undefined, async ({ ctx, params, query }) => {
      const { t, supplier } = entry(ctx, params);
      const co = module();
      const depositAddress = query.get("depositAddress") ?? "";
      if (!DEPOSIT_ADDRESS.test(depositAddress))
        fail("VALIDATION_FAILED", "depositAddress must be a NEAR account id");
      const txHash = query.get("txHash");
      if (txHash !== null && !TX_HASH.test(txHash))
        fail("VALIDATION_FAILED", "txHash must be a NEAR transaction hash");
      const now = d.clock.now();
      const base = { tradeId: t.tradeId, depositAddress, txHash, observedAt: now };
      const st = await co.client.status(depositAddress);
      if (st.kind !== "OK") {
        const provider: ProviderObservation =
          st.kind === "HTTP_ERROR" && st.status === 404
            ? { kind: "UNKNOWN_ADDRESS" }
            : { kind: "UNREADABLE", why: st.kind === "HTTP_ERROR" ? `HTTP ${st.status}` : st.kind };
        return {
          ...base,
          ...reconcileCashOut({
            provider,
            deposit: { kind: "NOT_PROVIDED" },
            nowMs: now,
            depositBeforeMs: null,
          }),
          provider: { read: provider.kind, status: null },
          deposit: { read: "NOT_READ", balance: null },
          depositCall: null,
        };
      }
      const s = st.value;
      // Only the supplier's own cash-out: the quote must refund to this trade's supplier account.
      if (s.quoteRequest.refundTo !== supplier || s.quote.depositAddress !== depositAddress)
        fail("NOT_FOUND", "no cash-out of this trade's supplier at that deposit address");
      const token = nep141Contract(s.quoteRequest.originAsset);
      if (token === null) fail("UPSTREAM_INVALID", "the quoted origin asset is not a NEAR token");
      const before = Math.min(
        Date.parse(s.quoteRequest.deadline),
        s.quote.deadline === null ? Number.POSITIVE_INFINITY : Date.parse(s.quote.deadline),
        s.quote.timeWhenInactive === null ? Number.POSITIVE_INFINITY : Date.parse(s.quote.timeWhenInactive),
      );
      // The chain is read only while 1Click still waits for the deposit.
      const dep =
        s.status === "PENDING_DEPOSIT"
          ? await observeDeposit(co, supplier, token, depositAddress, s.quote.amountIn, txHash)
          : { observation: { kind: "NOT_PROVIDED" } as DepositObservation, balance: null };
      const rec = reconcileCashOut({
        provider: { kind: "STATUS", status: s.status },
        deposit: dep.observation,
        nowMs: now,
        depositBeforeMs: before,
      });
      const call = rec.maySendDeposit ? depositCall(token, depositAddress, s.quote.amountIn) : null;
      return {
        ...base,
        ...rec,
        provider: {
          read: "STATUS",
          status: s.status,
          updatedAt: s.updatedAt,
          originAsset: s.quoteRequest.originAsset,
          destinationAsset: s.quoteRequest.destinationAsset,
          recipient: s.quoteRequest.recipient,
          amountIn: s.quote.amountIn,
          minAmountOut: s.quote.minAmountOut,
          amountOut: s.swapDetails.amountOut,
          amountOutFormatted: s.swapDetails.amountOutFormatted,
          depositedAmount: s.swapDetails.depositedAmount,
          refundedAmount: s.swapDetails.refundedAmount,
          refundReason: s.swapDetails.refundReason,
          originChainTxHashes: s.swapDetails.originChainTxHashes.map((x) => x.hash),
          destinationChainTxHashes: s.swapDetails.destinationChainTxHashes.map((x) => x.hash),
          depositBefore: before,
        },
        deposit: {
          read: s.status === "PENDING_DEPOSIT" ? dep.observation.kind : "NOT_READ",
          balance: dep.balance,
        },
        depositCall: call
          ? { signerId: supplier, call, nearCli: nearCli(call, supplier, co.nearNetwork) }
          : null,
      };
    }),
  ];
}
