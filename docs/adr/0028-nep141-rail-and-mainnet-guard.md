# ADR-0028 — NEP-141 trade asset and the capped mainnet label

- Decision status: **proposed on branch `feat/dockside-m50-usdc-rail`; not merged.** The contract change is
  shown to the owner with an independent audit before it can be merged or deployed
  ([docs/status/M50-review-packet.md](../status/M50-review-packet.md)).
- Date: 2026-11-13, Dockside platform team
- Affected IDs: FR-02, FR-05, FR-14, INV-02, INV-12, T-007, T-008, T-009, T-019, T-031, T-043, T-051
- Relates to: ADR-0004 (escrow contract, native funding identity), ADR-0006 (release intents, destination change),
  ADR-0014 (unexpected-asset recovery), ADR-0019 (sandbox suites and run-all), ADR-0022 (storage bounds),
  ADR-0024 (funding bound to the terms digest)

## Context

Until M50 the escrow held one asset, native NEAR, on one network label: `new` refused everything but `near-testnet`
(ADR-0004), and a NEP-141 transfer to the escrow was an unexpected asset, recorded and never credited (ADR-0014).

**This decision goes beyond the sealed specification, on the repository owner's instruction.** `docs/spec/`
describes one working corridor (native testnet NEAR) and keeps funded mainnet `BLOCKED` until it is separately
authorized (CORRIDOR-CONTRACT "Blocked mainnet one-rail corridor", REAL-PRODUCT-GATE "Separate funded-mainnet
gate"). The owner asked for a USDC rail and for a mainnet deployment with a small exposure cap. `docs/spec/` is not
edited. What follows supersedes the testnet-only guard of the escrow initialiser (M02, ADR-0004) for the escrow contract only.

What stays as the specification has it: the funded 1Click payout profile (`FUNDED_1CLICK`) is still refused with
`FUNDED_RAIL_BLOCKED`; the API, worker and web app still refuse `DOCKSIDE_NETWORK=near-mainnet` and still build
native-NEAR terms only; no `WORKING_MAINNET_PAYOUT` or `WORKING_TESTNET` claim is made by this change.

## Decisions

1. **The asset is part of the signed terms.** `terms.asset` is `{kind: "NEAR_NATIVE", network}` or
   `{kind: "NEP141", network, tokenAccountId, decimals}`, with an exact field set per kind. Both parties sign it with
   the rest of the revision. `amountYocto` keeps its schema-v1 name and means base units of the asset. Destination
   changes and key rebindings compare the whole terms value, so a successor revision can never change the asset.
2. **Token funding is the funder's own `ft_transfer_call`.** `msg` is `{"tradeId", "termsDigest"}` and nothing
   else. `ft_on_transfer` credits a trade only when the calling contract is the token that trade's terms name and
   the digest is the active revision's; the deposit is recorded against the `sender_id` the token reports, with the
   same buckets as native NEAR (partial, available, excess quarantined for the same funder).
3. **A refused funding is returned, not kept.** Unknown trade, wrong token, wrong digest, a native trade, an amount
   over the cap, dust, an expired or frozen trade, a malformed funding message: nothing is stored, the receiver
   returns the whole amount (the token contract then moves it back to the sender) and logs
   `nep141_funding_returned` with the refusal code. The call does not fail, so the reason is in the log, not in a
   panic.
4. **Unexpected-asset recovery is unchanged.** A `msg` that is not a funding message (it has no `tradeId`) is not a
   funding request: the tokens are kept, recorded against the token contract that delivered them and never
   credited, also when the token is some trade's asset. Recovery returns exactly the recorded amount to the proven
   sender.
5. **Release and refund are one `ft_transfer` with a private settlement callback**, the same shape as the native
   transfer. Only a failed promise is a no-transfer proof: the callback then restores the exact reservation or
   refund bucket. A promise that succeeded has moved the value whatever it returned, so a successful call with a
   return value longer than the callback reads is settled as transferred (before M50 the callback treated that as a
   failure; a native transfer returns nothing, so the old behaviour could not be triggered).
6. **The payee's token registration is confirmed before the value is locked.** `check_payee_storage(trade_id,
   account_id)` asks the trade's token `storage_balance_of` for the active payout destination (or the destination
   of a pending change) and records the answer. `create_release_intent` on a token trade is refused with
   `PAYEE_NOT_REGISTERED` until the destination is confirmed, and a destination change cannot be activated before
   its new destination is. Anyone may call the check; only the token's answer is recorded, `null` withdraws a
   confirmation, and a failed view changes nothing. If the payee unregisters after the check, the transfer fails
   and decision 5 rolls the ledger back.
7. **Network guard: `near-mainnet` only with non-zero caps.** `new(network, min_deposit_yocto, max_trade_amount,
   nep141_token, min_deposit_nep141)`. `network` is `near-testnet` or `near-mainnet`; anything else is still
   `FUNDED_RAIL_BLOCKED`. On mainnet an omitted cap takes its default (5 NEAR; 25000000 token base units, which is
   25 USDC) and an explicit zero is refused (`CAP_REQUIRED`). A cap bounds the amount a registration may name and
   the value one trade may hold at any time (deposits minus what was released or refunded), so excess deposits
   count. Mainnet terms use their own signed profile (`dockside-direct-mainnet-v1`, execution profile
   `DIRECT_MAINNET`), so nothing signed for testnet is valid on mainnet or the reverse.
8. **One pinned token.** `nep141_token` names the only NEP-141 contract (and decimals) a trade may name. On mainnet
   a deployment without it accepts no NEP-141 trade at all. On testnet it is optional. The contract cannot read a
   token's decimals synchronously; run-all checks the pinned decimals against the token's `ft_metadata` before
   deploying.
9. **Nothing is configurable after `new`.** There is no owner, no admin method and no setter: caps, token and
   minimum deposits are fixed for the life of the deployment. A different cap is a new deployment on a new account.
10. **State layout changed.** `Terms` gained `asset`, `TradeRecord` gained `payee_storage`, the contract state
    gained the limits. The M50 build cannot be deployed over an escrow that holds records of the earlier build;
    run-all only deploys to an account without code (`ESCROW_NOT_EMPTY`).
11. **run-all.** `--asset usdc --token <id>` runs all four journeys in the token. `--network mainnet` runs only with
    `--i-understand-real-funds`; the preflight then checks the chain id, the caps and the exposure of the run and
    prints every amount before anything is sent; `--dry-run` stops there. The flag is never stored, so a resumed
    run needs it again.

## Consequences

- A token trade costs the escrow account NEAR that nobody attaches: one yoctoNEAR per `ft_transfer`, and the storage
  of deposit records (bounded per trade by ADR-0022). The account must stay funded; this is a liveness concern, not a
  path for value to leave.
- The escrow trusts the pinned token contract for the amounts and senders it reports and for the atomicity of
  `ft_transfer`. On a testnet deployment without a pinned token, a trade can name any contract; that contract can
  only affect trades that name it, and the ledger of each trade is paid out only in its own asset.
- A token sent with a plain `ft_transfer` (no call) produces no record and no receipt on the escrow. As before M50,
  nothing in the contract can return it.
- Whoever holds a full-access key of the escrow account can redeploy code or move the account's NEAR and tokens
  directly. Key custody of the escrow account is outside this contract (build plan D9).
- The product (API, worker, web app) is unchanged and native-only. A token trade exists only through run-all and
  direct contract calls until a later module adds it to the product.

## Verification

Host tests (`contract/crates/dockside-escrow-core/tests/m50_nep141_rail.rs`), near-sdk unit tests and
near-workspaces tests against a real NEP-141 contract on a local nearcore node
(`contract/integration/sandbox-tests/tests/`), and run-all end to end on that node for both assets and both labels.
Counts, commands and the wasm digest are in [docs/status/M50.md](../status/M50.md). Nothing was sent to NEAR testnet
or mainnet.
