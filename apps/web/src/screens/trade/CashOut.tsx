import { useEffect, useMemo, useState } from "react";
import { useApiData, useMutationGate } from "../../app/app-context";
import { AddressDisplay, IdentityList } from "../../components/Data";
import { Field } from "../../components/Forms";
import { Callout, FailureState } from "../../components/States";
import type { ApiFailure } from "../../lib/api/client";
import type {
  CashOutDepositCall,
  CashOutDryQuote,
  CashOutQuoteInput,
  CashOutStatus,
  CashOutView,
  FunctionCall,
} from "../../lib/api/trade";
import {
  DESTINATION_ADDRESS,
  loadTracked,
  NEAR_ACCOUNT_ID,
  NEAR_TX_HASH,
  parsePastedQuote,
  saveTracked,
  toBaseUnits,
} from "../../lib/cash-out";
import { formatUnits, formatUntil, formatUtc, networkLabel } from "../../lib/format";
import type { IconName } from "../../lib/status";
import { Section, useTrade } from "./common";

/**
 * "Move to another chain" (M52): the supplier moves money that is already in the supplier's own
 * NEAR account to another chain through NEAR Intents 1Click. The API only previews (a dry quote)
 * and reads statuses; the real quote and the deposit come from the supplier's own client and
 * wallet, shown here as exact calls the same way the funding panel shows the buyer's deposit.
 */
export function CashOut() {
  const t = useTrade();
  if (!t.has("SUPPLIER"))
    return (
      <section aria-labelledby="cash-out-title" data-testid="cash-out">
        <h3 id="cash-out-title">7. Move to another chain</h3>
        <p data-testid="cash-out-not-supplier">
          Shown to the supplier signer only. After a release the money is in the supplier's own NEAR account;
          from there the supplier can move it to another chain through NEAR Intents (1Click). The escrow and
          the relayer are not involved.
        </p>
      </section>
    );
  return <SupplierCashOut />;
}

function SupplierCashOut() {
  const t = useTrade();
  // Loaded once per trade, not on every periodic refresh: it asks 1Click for its token list.
  const cfg = useApiData(() => t.api.cashOut(t.tradeId), [t.tradeId]);
  return (
    <section aria-labelledby="cash-out-title" data-testid="cash-out">
      <h3 id="cash-out-title">7. Move to another chain</h3>
      <p>
        After a release the money is in your own NEAR account. Here you can move it to another chain through
        NEAR Intents (1Click). Dockside only asks 1Click for a preview and reads the status. The real quote
        and the deposit are yours: your own client requests the quote, and your own wallet signs one transfer.
        The escrow and the relayer never touch this money.
      </p>
      <Section what="cash-out options" state={cfg.state} outcome={cfg.outcome} reload={cfg.reload}>
        {(c) => <Configured c={c} reload={cfg.reload} />}
      </Section>
    </section>
  );
}

function Configured({ c, reload }: { c: CashOutView; reload: () => void }) {
  if (c.status === "NOT_CONFIGURED")
    return (
      <Callout
        tone="neutral"
        icon="not-run"
        title="Not available on this deployment"
        headingLevel={3}
        testId="cash-out-not-configured"
      >
        <p>{c.reason} Nothing was requested from 1Click.</p>
      </Callout>
    );
  if (c.status === "PROVIDER_UNAVAILABLE")
    return (
      <Callout
        tone="unknown"
        icon="unknown"
        title="1Click could not be reached"
        headingLevel={3}
        testId="cash-out-unavailable"
      >
        <p>{c.reason}</p>
        <p>
          <button type="button" className="btn" onClick={reload}>
            Try again
          </button>
        </p>
      </Callout>
    );
  return <Flow c={c} />;
}

function Flow({ c }: { c: CashOutView }) {
  const t = useTrade();
  const gate = useMutationGate();
  const origins = c.originAssets ?? [];
  const destinations = c.destinationAssets ?? [];
  const chains = useMemo(() => [...new Set(destinations.map((d) => d.blockchain))].sort(), [destinations]);
  const [originId, setOriginId] = useState(origins[0]?.assetId ?? "");
  const [amount, setAmount] = useState("");
  const [chain, setChain] = useState("");
  const [destId, setDestId] = useState("");
  const [recipient, setRecipient] = useState("");
  const [slippage, setSlippage] = useState("100");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [quote, setQuote] = useState<{ input: CashOutQuoteInput; q: CashOutDryQuote } | null>(null);
  const [deposit, setDeposit] = useState<CashOutDepositCall | null>(null);
  const [tracked, setTracked] = useState(() => loadTracked(t.tradeId)?.depositAddress ?? "");

  const origin = origins.find((o) => o.assetId === originId);
  const inChain = destinations.filter((d) => d.blockchain === chain && d.assetId !== originId);

  const getQuote = async () => {
    const errs: Record<string, string> = {};
    if (!origin) errs["origin"] = "Choose the token to send.";
    const units = origin ? toBaseUnits(amount, origin.decimals) : null;
    if (units && !units.ok) errs["amount"] = units.reason;
    if (chain === "") errs["chain"] = "Choose the destination chain.";
    if (destId === "") errs["dest"] = "Choose the token to receive.";
    if (!DESTINATION_ADDRESS.test(recipient))
      errs["recipient"] = "Enter the destination address exactly, without spaces.";
    setErrors(errs);
    if (Object.keys(errs).length > 0 || !origin || !units?.ok) return;
    const input: CashOutQuoteInput = {
      originAsset: origin.assetId,
      destinationAsset: destId,
      amount: units.value,
      recipient,
      slippageBps: Number(slippage),
    };
    setBusy(true);
    setFailure(null);
    setQuote(null);
    setDeposit(null);
    const out = await t.api.cashOutDryQuote(t.tradeId, input);
    setBusy(false);
    if (out.ok) setQuote({ input, q: out.data });
    else setFailure(out.error);
  };

  return (
    <>
      <IdentityList
        items={[
          [
            "Your NEAR account (pays the deposit, receives any refund)",
            <code key="a" className="wrap">
              {c.supplierAccountId}
            </code>,
          ],
          ["1Click settles on", networkLabel(c.providerNetwork ?? "")],
          ["This trade is on", networkLabel(c.tradeNetwork)],
        ]}
      />
      {c.depositEnabled ? null : (
        <Callout
          tone="warning"
          icon="blocked"
          title="Preview only on this deployment"
          headingLevel={3}
          testId="cash-out-preview-only"
        >
          <p>
            1Click settles on {networkLabel(c.providerNetwork ?? "")} and this trade is on{" "}
            {networkLabel(c.tradeNetwork)}. You can ask for a dry quote to see the route and its cost; no
            deposit call is offered.
          </p>
        </Callout>
      )}
      <form
        className="action"
        data-testid="cash-out-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void getQuote();
        }}
      >
        <h4>Step 1. Destination and amount</h4>
        <Field id="co-origin" label="Token to send" error={errors["origin"]}>
          {(aria) => (
            <select {...aria} value={originId} onChange={(e) => setOriginId(e.target.value)}>
              {origins.map((o) => (
                <option key={o.assetId} value={o.assetId}>
                  {o.symbol} ({o.contract})
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field
          id="co-amount"
          label={`Amount to send${origin ? ` (${origin.symbol})` : ""}`}
          help="Exactly this amount leaves your account; the quote says what arrives."
          error={errors["amount"]}
        >
          {(aria) => (
            <input {...aria} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          )}
        </Field>
        <Field id="co-chain" label="Destination chain" error={errors["chain"]}>
          {(aria) => (
            <select
              {...aria}
              value={chain}
              onChange={(e) => {
                setChain(e.target.value);
                setDestId("");
              }}
            >
              <option value="">Choose a chain</option>
              {chains.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field id="co-dest" label="Token to receive" error={errors["dest"]}>
          {(aria) => (
            <select {...aria} value={destId} onChange={(e) => setDestId(e.target.value)}>
              <option value="">Choose a token</option>
              {inChain.map((d) => (
                <option key={d.assetId} value={d.assetId}>
                  {d.symbol} ({d.assetId})
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field
          id="co-recipient"
          label="Destination address"
          help="Your address on the destination chain. It is sent to 1Click exactly as typed; a wrong address cannot be corrected later."
          error={errors["recipient"]}
        >
          {(aria) => (
            <input
              {...aria}
              className="mono"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value.trim())}
            />
          )}
        </Field>
        <Field
          id="co-slippage"
          label="Slippage tolerance"
          help="How far below the quoted amount the delivery may fall before 1Click refunds instead."
        >
          {(aria) => (
            <select {...aria} value={slippage} onChange={(e) => setSlippage(e.target.value)}>
              <option value="50">0.5%</option>
              <option value="100">1%</option>
              <option value="200">2%</option>
            </select>
          )}
        </Field>
        <button type="submit" className="btn" disabled={busy || !gate.allowed}>
          {busy ? "Asking 1Click…" : "Get a dry quote"}
        </button>
        <p className="muted">
          A dry quote commits nothing: no deposit address is created and nothing is sent.
        </p>
      </form>
      {failure ? <FailureState failure={failure} what="Dry quote" headingLevel={3} /> : null}
      {quote ? <QuotePanel q={quote.q} /> : null}
      {quote?.q.realQuote && !deposit ? (
        <RealQuoteStep
          input={quote.input}
          q={quote.q}
          onDeposit={(d) => {
            setDeposit(d);
            setTracked(d.depositAddress);
            saveTracked(t.tradeId, { depositAddress: d.depositAddress, txHash: "" });
          }}
        />
      ) : null}
      {deposit ? <DepositPanel d={deposit} /> : null}
      {c.depositEnabled ? <Tracking key={tracked} initialAddress={tracked} /> : null}
    </>
  );
}

function QuotePanel({ q }: { q: CashOutDryQuote }) {
  const x = q.quote;
  const cost =
    x.cost.usd === null
      ? "Not reported by 1Click for this route"
      : `${x.cost.usd} USD${x.cost.bps === null ? "" : ` (${(x.cost.bps / 100).toFixed(2)}% of the amount sent)`}`;
  return (
    <section className="card" aria-labelledby="co-quote-title" data-testid="cash-out-quote">
      <h4 id="co-quote-title">Dry quote from 1Click</h4>
      <IdentityList
        items={[
          ["You send", `${x.amountInFormatted} ${q.origin.symbol} (about ${x.amountInUsd} USD)`],
          [
            "You receive (quoted)",
            `${x.amountOutFormatted} ${q.destination.symbol} on ${q.destination.blockchain} (about ${x.amountOutUsd} USD)`,
          ],
          [
            "You receive at least",
            `${x.minAmountOutFormatted} ${q.destination.symbol} (${(x.slippageBps / 100).toFixed(2)}% slippage); below that 1Click refunds`,
          ],
          ["Fee: cost of the route", cost],
          [
            "Of which destination withdrawal fee",
            x.withdrawFee === null
              ? "Not itemised by 1Click"
              : `${formatUnits(x.withdrawFee, q.destination.decimals)} ${q.destination.symbol}`,
          ],
          ["Estimated time", `${x.timeEstimateSeconds} seconds after the deposit`],
          [
            "Deadline",
            `${formatUtc(x.deadline)}: a real quote made now must be deposited before this, and an unfinished swap is refunded after it`,
          ],
          [
            "Destination address",
            <code key="r" className="wrap">
              {q.destination.recipient}
            </code>,
          ],
          ["Source", `${q.source}, ${formatUtc(q.observedAt)}. Committed: nothing.`],
        ]}
      />
      <p className="muted">
        The cost is 1Click's own valuation of both sides at quote time (amount sent minus amount received, in
        USD). The guaranteed figure is the minimum received.
      </p>
      {q.depositDisabledReason ? (
        <p data-testid="cash-out-deposit-disabled">{q.depositDisabledReason}</p>
      ) : null}
    </section>
  );
}

function RealQuoteStep({
  input,
  q,
  onDeposit,
}: {
  input: CashOutQuoteInput;
  q: CashOutDryQuote;
  onDeposit: (d: CashOutDepositCall) => void;
}) {
  const t = useTrade();
  const gate = useMutationGate();
  const real = q.realQuote;
  const [pasted, setPasted] = useState("");
  const [err, setErr] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  if (!real) return null;
  const check = async () => {
    const parsed = parsePastedQuote(pasted);
    if (!parsed.ok) {
      setErr(parsed.reason);
      return;
    }
    setErr(undefined);
    setBusy(true);
    setFailure(null);
    const out = await t.api.cashOutDepositCall(
      t.tradeId,
      { ...input, deadline: real.request.deadline },
      parsed.value,
    );
    setBusy(false);
    if (out.ok) onDeposit(out.data);
    else setFailure(out.error);
  };
  return (
    <section className="action" aria-labelledby="co-real-title" data-testid="cash-out-real-quote">
      <h4 id="co-real-title">Step 2. Request the real quote from your own client</h4>
      <p>
        A real quote creates a deposit address at 1Click. Dockside does not request it: you send the request
        below (the previewed request with <code>dry</code> set to <code>false</code>) and paste 1Click's
        answer here. It refunds to <code className="wrap">{real.request.refundTo}</code>.
      </p>
      <h4>Exact request</h4>
      <AddressDisplay value={JSON.stringify(real.request)} label="quote request" />
      <h4>The same request in PowerShell</h4>
      <AddressDisplay value={real.powershell} label="PowerShell command" />
      <h4>The same request with curl</h4>
      <AddressDisplay value={real.curl} label="curl command" />
      <Field
        id="co-pasted"
        label="1Click's answer to your request"
        help="Paste the whole JSON answer. It is checked field by field against the request above and against 1Click before any call is shown."
        error={err}
      >
        {(aria) => (
          <textarea
            {...aria}
            className="mono"
            rows={6}
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
          />
        )}
      </Field>
      <button type="button" className="btn" disabled={busy || !gate.allowed} onClick={() => void check()}>
        {busy ? "Checking…" : "Check the quote and build the deposit call"}
      </button>
      {failure ? <QuoteRefusal failure={failure} /> : null}
    </section>
  );
}

function QuoteRefusal({ failure }: { failure: ApiFailure }) {
  if (failure.kind === "http" && failure.details["reason"] === "QUOTE_MISMATCH")
    return (
      <Callout
        tone="negative"
        icon="blocked"
        title="This is not the quote you previewed"
        headingLevel={3}
        role="alert"
        testId="cash-out-quote-mismatch"
      >
        <p>
          These fields differ from the request shown above: <code>{String(failure.details["fields"])}</code>.
          No deposit call is shown. Do not send anything to the deposit address in that answer.
        </p>
      </Callout>
    );
  if (failure.kind === "http" && failure.details["reason"] === "DEPOSIT_ADDRESS_UNKNOWN")
    return (
      <Callout
        tone="negative"
        icon="blocked"
        title="1Click does not know this deposit address"
        headingLevel={3}
        role="alert"
        testId="cash-out-address-unknown"
      >
        <p>No deposit call is shown. Do not send anything to the deposit address in that answer.</p>
      </Callout>
    );
  return <FailureState failure={failure} what="Deposit call" headingLevel={3} />;
}

function WalletCallView({
  signerId,
  call,
  nearCli,
}: {
  signerId: string;
  call: FunctionCall;
  nearCli: string;
}) {
  return (
    <>
      <IdentityList
        items={[
          ["Signer account", <code key="s">{signerId}</code>],
          ["Token contract", <code key="c">{call.receiverId}</code>],
          ["Method", <code key="m">{call.methodName}</code>],
          [
            "Receiver (1Click deposit address)",
            <code key="r" className="wrap">
              {String(call.args["receiver_id"])}
            </code>,
          ],
          ["Exact amount (base units)", String(call.args["amount"])],
          ["Attached deposit", `${call.depositYocto} yoctoNEAR`],
        ]}
      />
      <h4>Exact call for your wallet</h4>
      <AddressDisplay value={JSON.stringify(call)} label="deposit call" />
      <h4>Same call with near-cli-rs (your keychain signs)</h4>
      <AddressDisplay value={nearCli} label="near-cli-rs command" />
    </>
  );
}

function DepositPanel({ d }: { d: CashOutDepositCall }) {
  return (
    <section className="action" aria-labelledby="co-deposit-title" data-testid="cash-out-deposit">
      <h4 id="co-deposit-title">Step 3. Deposit from your own wallet</h4>
      <p>
        Only <code className="wrap">{d.signerId}</code> sends this transfer, from its own NEAR wallet or
        keychain on {networkLabel(d.network)}. Dockside does not send it and holds no key that could. Send it
        once, before {formatUtc(d.depositBefore)}. You receive at least {d.minAmountOut} base units of the
        destination token, or 1Click refunds this account.
      </p>
      <WalletCallView signerId={d.signerId} call={d.call} nearCli={d.nearCli} />
    </section>
  );
}

const STATE_VIEW: Record<
  string,
  { tone: "neutral" | "warning" | "negative" | "unknown"; icon: IconName; title: string }
> = {
  AWAITING_DEPOSIT: { tone: "neutral", icon: "not-run", title: "Waiting for your deposit" },
  QUOTE_EXPIRED: { tone: "warning", icon: "expired", title: "The quote is no longer open" },
  DEPOSIT_FAILED_NO_TRANSFER: {
    tone: "warning",
    icon: "failed",
    title: "The deposit transaction failed on NEAR; nothing moved",
  },
  DEPOSIT_SENT_WAITING_FOR_PROVIDER: {
    tone: "neutral",
    icon: "processing",
    title: "Deposit is on NEAR; waiting for 1Click to pick it up",
  },
  IN_PROGRESS: { tone: "neutral", icon: "processing", title: "1Click is executing the swap" },
  DELIVERED: { tone: "neutral", icon: "paid", title: "Delivered on the destination chain" },
  REFUNDED: { tone: "neutral", icon: "refunded", title: "Refunded to your NEAR account" },
  INCOMPLETE_DEPOSIT: {
    tone: "warning",
    icon: "incomplete",
    title: "1Click received less than the quoted amount",
  },
  FAILED: { tone: "negative", icon: "failed", title: "1Click reports the swap failed" },
  UNKNOWN: { tone: "unknown", icon: "unknown", title: "State unknown: do not send the deposit again" },
};

function Tracking({ initialAddress }: { initialAddress: string }) {
  const t = useTrade();
  const [address, setAddress] = useState(initialAddress);
  const [hash, setHash] = useState(() => {
    const saved = loadTracked(t.tradeId);
    return saved && saved.depositAddress === initialAddress ? saved.txHash : "";
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<CashOutStatus | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const i = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(i);
  }, []);

  const read = async () => {
    const errs: Record<string, string> = {};
    if (!NEAR_ACCOUNT_ID.test(address)) errs["address"] = "Enter the deposit address from your 1Click quote.";
    if (hash !== "" && !NEAR_TX_HASH.test(hash))
      errs["hash"] = "A NEAR transaction hash is 43 or 44 base58 characters.";
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setBusy(true);
    setFailure(null);
    const out = await t.api.cashOutStatus(t.tradeId, address, hash === "" ? null : hash);
    setBusy(false);
    if (out.ok) {
      setStatus(out.data);
      saveTracked(t.tradeId, { depositAddress: address, txHash: hash });
    } else {
      setStatus(null);
      setFailure(out.error);
    }
  };

  const view = status ? (STATE_VIEW[status.state] ?? STATE_VIEW["UNKNOWN"]) : null;
  return (
    <section className="action" aria-labelledby="co-track-title" data-testid="cash-out-tracking">
      <h4 id="co-track-title">Step 4. Track the cash-out</h4>
      <p>
        The state is recomputed from 1Click and from NEAR every time you read it. If an answer is missing or
        unclear, the state is UNKNOWN and the deposit must not be sent again: a late answer is not a failed
        deposit.
      </p>
      <Field
        id="co-track-address"
        label="1Click deposit address"
        help="Filled in from the deposit call above. To pick up an earlier cash-out, enter its deposit address."
        error={errors["address"]}
      >
        {(aria) => (
          <input
            {...aria}
            className="mono"
            value={address}
            onChange={(e) => setAddress(e.target.value.trim())}
          />
        )}
      </Field>
      <Field
        id="co-track-hash"
        label="Your deposit transaction hash (after you sent it)"
        help="Lets the chain confirm the transfer, or prove that a failed attempt moved nothing."
        error={errors["hash"]}
      >
        {(aria) => (
          <input {...aria} className="mono" value={hash} onChange={(e) => setHash(e.target.value.trim())} />
        )}
      </Field>
      <button type="button" className="btn" disabled={busy} onClick={() => void read()}>
        {busy ? "Reading…" : "Read status"}
      </button>
      {failure ? <FailureState failure={failure} what="Cash-out status" headingLevel={3} /> : null}
      {status && view ? (
        <div data-testid="cash-out-status" data-state={status.state}>
          <Callout tone={view.tone} icon={view.icon} title={view.title} headingLevel={3} role="status">
            <p data-testid="cash-out-reason">{status.reason}</p>
          </Callout>
          <IdentityList
            items={[
              ["State", <code key="s">{status.state}</code>],
              ["May the deposit be sent now", status.maySendDeposit ? "Yes, once (the call is below)" : "No"],
              ["1Click status", status.provider.status ?? `Not read (${status.provider.read})`],
              ["NEAR reading", depositReading(status)],
              ...(status.provider.depositBefore !== undefined && !status.terminal
                ? ([
                    [
                      "Deposit window",
                      `${formatUtc(status.provider.depositBefore)} (${formatUntil(status.provider.depositBefore, now)})`,
                    ],
                  ] as const)
                : []),
              ...(status.provider.depositedAmount
                ? ([["Deposited (base units)", status.provider.depositedAmount]] as const)
                : []),
              ...(status.provider.amountOut
                ? ([
                    [
                      "Delivered",
                      `${status.provider.amountOutFormatted ?? status.provider.amountOut} to ${status.provider.recipient ?? ""}`,
                    ],
                  ] as const)
                : []),
              ...(status.provider.destinationChainTxHashes?.length
                ? ([
                    [
                      "Destination transaction",
                      <code key="d" className="wrap">
                        {status.provider.destinationChainTxHashes.join(", ")}
                      </code>,
                    ],
                  ] as const)
                : []),
              ...(status.provider.refundedAmount
                ? ([
                    [
                      "Refunded (base units)",
                      `${status.provider.refundedAmount}${status.provider.refundReason ? ` (${status.provider.refundReason})` : ""}`,
                    ],
                  ] as const)
                : []),
              ["Read at", formatUtc(status.observedAt)],
            ]}
          />
          {status.depositCall ? (
            <div data-testid="cash-out-status-call">
              <WalletCallView
                signerId={status.depositCall.signerId}
                call={status.depositCall.call}
                nearCli={status.depositCall.nearCli}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function depositReading(s: CashOutStatus): string {
  const bal = s.deposit.balance === null ? "" : `; deposit address holds ${s.deposit.balance} base units`;
  switch (s.deposit.read) {
    case "NOT_READ":
      return "Not read (1Click already reports past the deposit, or could not be read)";
    case "NOT_PROVIDED":
      return `No transaction hash given${bal}`;
    case "CONFIRMED":
      return `The transfer is final and matches the quote${bal}`;
    case "FUNDS_AT_ADDRESS":
      return `The deposit address already holds the token${bal}`;
    case "FAILED_NO_TRANSFER":
      return `The transaction failed; nothing moved${bal}`;
    case "EXECUTING":
      return "The transaction is still executing";
    case "NOT_FOUND":
      return "The node does not know this transaction hash";
    case "DIFFERENT_TRANSACTION":
      return "That transaction is not the quoted transfer";
    default:
      return `Could not be read (${s.deposit.read})`;
  }
}
