# ADR-0027 — Supplier cash-out through NEAR Intents 1Click

- Decision status: accepted (M52)
- Date: 2026-11-13, Dockside build stage M52
- Affected IDs: none of the sealed specification's test IDs. This decision goes **beyond the specification
  pack** (`docs/spec/`, unchanged): the pack describes 1Click only as the optional M06 compatibility probe and
  the BLOCKED funded rail. T-024..T-027, T-048 and T-055 stay NOT_RUN and M06 stays BLOCKED.

## Context

A release pays the supplier's bound NEAR account. A supplier who wants the money on another chain then has to
leave the product. NEAR Intents 1Click does that move: a quote names a deposit address on NEAR, the sender
transfers the token to it, and 1Click delivers on the destination chain or refunds.

The pack forbids the escrow, the relayer or an executor from paying through 1Click until a funded corridor is
separately authorized (CORRIDOR-CONTRACT, REAL-PRODUCT-GATE). That rule is about escrowed value. Once the
contract has paid, the money belongs to the supplier, in the supplier's own account, and what the supplier does
with it is outside the escrow.

## Decisions

1. **The cash-out starts where the escrow ends.** It is a panel on the payout screen ("Move to another chain")
   for the trade's bound supplier signer only. It reads no escrow state and changes none; no release intent,
   reservation, journal operation or claim level depends on it. The funded rail stays `FUNDED_RAIL_BLOCKED`.
2. **The server previews and reads; it never commits.** `@dockside/payout` has a 1Click client with three
   methods: token list, `dry: true` quote, status. `dryQuote` sets `dry: true` itself, and an answer that names
   a deposit address is refused as ambiguous. There is no method that sends `dry: false`, none that calls
   `/v0/deposit/submit`, and the API has no signer for the supplier's account.
3. **The real quote and the deposit are the supplier's.** The dry request and the real request are one object
   built by one function and differ in `dry` only; `refundTo` is always the trade's supplier account. The panel
   shows the real request as JSON and as a PowerShell and a curl command. The supplier runs it and pastes
   1Click's answer back. The deposit is shown as one exact `ft_transfer` (token contract, deposit address,
   amount, one yoctoNEAR) and as a near-cli-rs command, the same pattern as the M43 funding panel.
4. **A pasted answer is checked twice.** Field by field against the previewed request (assets, amount,
   recipient, refund account, slippage, deadline, `dry: false`, exact `amountIn`, a plausible NEAR deposit
   address, no memo, a positive minimum, at least one minute left). Then against 1Click itself: the deposit
   address must be one 1Click knows, for the same request, in `PENDING_DEPOSIT`. If 1Click cannot be asked, no
   call is shown. 1Click publishes no key for the `signature` field of a quote, so this status read is the
   authenticity check.
5. **Reconciliation, never a blind resend.** A status read combines 1Click's status with two NEAR reads (the
   transaction the supplier names, and the token balance of the deposit address). The rule: a missing, late or
   unreadable answer is never evidence that a deposit did not happen. A deposit may be sent in exactly two
   cases, both while 1Click says `PENDING_DEPOSIT`, the deposit address holds none of the token and the quote is
   still open: nothing was sent yet, or the named transaction is exactly the quoted transfer and is final and
   failed. Everything else is `UNKNOWN`, `IN_PROGRESS` or a terminal state, and no call is shown.
6. **Nothing is stored.** A cash-out is identified by its 1Click deposit address; every answer is recomputed.
   The browser remembers the tracked deposit address per trade as a convenience only. No migration, no journal
   row, no audit event of a movement Dockside did not make.
7. **Network match.** The public 1Click service settles on NEAR mainnet. The deposit step is offered only when
   the trade's network equals the network the configured 1Click service settles on
   (`DOCKSIDE_ONE_CLICK_NEAR_NETWORK`, default `near-mainnet`; another value is accepted only with a loopback
   `DOCKSIDE_ONE_CLICK_URL`, which is how the tests run a simulator). On a testnet deployment pointed at the
   public service the panel is a preview: dry quotes only.
8. **Configuration.** `DOCKSIDE_ONE_CLICK_URL` (https, or http on loopback; unset means the panel says
   NOT_CONFIGURED). `DOCKSIDE_ONE_CLICK_TOKEN_FILE` is the path of a file holding an optional partner token;
   the token is never a configuration value, is read once at startup and is never logged or returned.

## Consequences

- The supplier pays 1Click's cost and bears 1Click's execution; the panel shows the quote's minimum as the
  guaranteed figure and the difference of the two USD valuations as the cost.
- Running the real quote is a manual step in a shell. A browser wallet connector could replace both manual
  steps later without changing the server.
- Assumptions about the public service that only a real run can confirm are listed in
  [docs/status/M52.md](../status/M52.md) ("Not verified against the real service").
