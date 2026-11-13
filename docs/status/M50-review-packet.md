# M50 review packet — NEP-141 rail and capped mainnet label

For the independent reviewer and the owner. This branch changes a contract that is meant to hold real money. It is
**not merged and not deployed**; it waits for an audit of this diff and the owner's approval.

- Branch `feat/dockside-m50-usdc-rail`, contract and tooling final at commit `e335eda0135064f9693f5e6ebb274dcf4f600726` (the
  independent audit's fix on top of `8fa5288`, the merge of main `ae53b8a`); later commits are documentation and
  evidence records. The audit and its findings are in [Independent audit](#independent-audit-2026-11-13) below.
- Diff to review: `git diff main...feat/dockside-m50-usdc-rail -- contract/crates` (the deployable code), then
  `contract/integration` (mirror, harness, tests) and `scripts/testnet-deploy` (run-all).
- Decision record: [ADR-0028](../adr/0028-nep141-rail-and-mainnet-guard.md). Status and commands:
  [M50.md](M50.md).
- Nothing was sent to NEAR testnet or mainnet. Every test ran on the host or on a local nearcore node.

## Reproduced artifact

| | |
|---|---|
| Source commit | `e335eda0135064f9693f5e6ebb274dcf4f600726` |
| Build | `pnpm run contract:reproduce`: clean clone in `node:22-bookworm-slim` (image pinned by digest in `scripts/lib/docker.mjs`), Rust 1.97.1 from a pinned rustup-init, `--locked`, `CARGO_HOME=/root/.cargo` |
| File | `dockside_escrow.wasm`, 862018 bytes |
| SHA-256 | `025af34e970c4e7942c31fdad79b175e0f7322bccc2fdbd61d78653cd0237770` |
| NEAR code hash (base58 of the SHA-256) | `ACFe6Us2mTm8ms2VYgC1PTG4VrMmMHzNhT99tcxk2sq` |
| Superseded | the pre-audit build of `8fa5288` (`46f982e4…e99e`, code hash `5n4D4NSN…hFZ7`) must not be deployed |
| Second build of the same commit | in the same container run (the export step rebuilds and compares) and in the `node:22-trixie-slim` sandbox container (`container-sandbox.sh` refuses to run unless its own rebuild has this SHA-256): both matched ([docs/evidence/M50/sandbox-report.json](../evidence/M50/sandbox-report.json), `wasmSha256`) |

To reproduce: check out the commit and run `pnpm run contract:reproduce`; `.data/repro/build-manifest.json` must
carry the SHA-256 above. A build on a developer machine gives a different digest (host paths end up in the binary);
only the container build is deployable.

## Changed contract files

`contract/crates/dockside-escrow-core/src/` (authority logic, no NEAR SDK, host-tested):

| File | Change |
|---|---|
| `terms.rs` | `Asset` (`NearNative`, `Nep141 {token_account_id, decimals}`) and `Terms.asset`. `parse_asset`: exact field set per kind, token id valid for the network and not the escrow itself, decimals 0 to 24. The signed terms profile depends on the network (`dockside-direct-testnet-v1`, `dockside-direct-mainnet-v1`). |
| `trade.rs` | `Limits` (caps per asset, pinned token) with `configure` (the `new` guard: network label, mainnet defaults, zero refused) and `check_terms` (registration: token pin, amount within cap). `Ctx.limits`. `TradeRecord.payee_storage` with `payee_check_target`, `record_payee_storage`, `require_payee_storage`. `register` calls `check_terms`. |
| `lib.rs` | `funding_message` (what an `ft_transfer_call` `msg` asks for). `fund` and `fund_exact` now refuse a token trade. New `fund_token`: the predecessor must be the trade's token, the digest the active revision's. The shared `accept_deposit` adds the cap on the value a trade holds. |
| `ledger.rs` | `held()`: deposits minus released and refunded. No bucket rule changed. |
| `release.rs` | `direct_profile(network)` (`DIRECT_TESTNET`, `DIRECT_MAINNET`) replaces the constant in the three places that used it. `create_release_intent` calls `require_payee_storage` before reserving. |
| `destination.rs` | `activate_destination_change` calls `require_payee_storage` for the new destination and afterwards keeps only the active destination's confirmation. |
| `views.rs` | `asset` in `get_ledger` and `get_trade`, `payeeStorage` in `get_trade`, `limits` for `get_config`. The native ledger view is byte for byte what it was. |

`contract/crates/dockside-escrow/src/lib.rs` (the near-sdk wrapper):

- State: `min_deposit_nep141`, `max_native`, `max_nep141`, `nep141_token`, set once by `new`.
- `new` takes `max_trade_amount`, `nep141_token`, `min_deposit_nep141` after the two existing arguments (all
  optional, so existing callers still decode).
- `ft_on_transfer`: funding path (accept and return 0, or store nothing and return the whole amount with a
  `nep141_funding_returned` log) and the unchanged unexpected-asset path.
- `check_payee_storage` (public) and `on_payee_storage` (`#[private]`).
- `execute_release` and `execute_refund` schedule the transfer through `pay`: native transfer, or `ft_transfer` on
  the trade's token with one yoctoNEAR and 20 Tgas, then the existing settlement callback.
- `transfer_succeeded()`: the three settlement callbacks (release, refund, asset recovery) now treat only a
  **failed** promise as "not transferred". Before, a successful promise whose return value was longer than 64
  bytes was also treated as not transferred. A native transfer returns nothing, so this could not happen before
  M50; with token contracts it would have rolled the ledger back after the tokens had moved.
- `get_config` reports `minDepositNep141`, `maxTradeAmount`, `nep141Token`.

No method was removed. No method became payable. No admin, owner, pause or upgrade method exists or was added.

## New invariants

Each is enforced by the contract and asserted by at least one test, named in brackets.

1. **Asset binding.** A trade's asset is in its signed terms and never changes: every successor revision is
   compared as a whole `Terms` value. (`a_successor_revision_can_never_change_the_asset`.)
2. **Only the named token credits a trade.** `fund_token` requires `predecessor == terms.asset.token` and the
   active revision digest. Any other caller, including an account calling `ft_on_transfer` directly, credits
   nothing. (`only_the_named_token_contract_credits_the_trade`; sandbox paid test, wrong token and forged call.)
3. **Asset kinds do not mix.** Native NEAR cannot fund a token trade and a token cannot fund a native trade
   (`ASSET_MISMATCH`). A trade's ledger is paid out only by `pay(asset of that trade)`.
4. **A refused funding stores nothing and returns everything.** The trade record is written only after the core
   accepted the deposit and conservation was rechecked. (`ft_on_transfer_funds_the_named_trade_and_returns_every_refused_amount`;
   the sandbox harness also checks the token's own `ft_resolve_transfer` result and the sender's balance.)
5. **Token backing.** On the local node, after every step: the escrow's balance in the trade token equals the sum
   of `held()` over the trades in that token plus the unrecovered unexpected-asset records of that token
   (`Dock::assert_token_backing`, called by the harness after every call).
6. **Exact rollback.** A failed `ft_transfer` restores the exact reserved slices (release) or the exact source
   bucket (refund); nothing leaves the escrow. A succeeded transfer is never rolled back.
   (`m50_a_failed_token_transfer_rolls_the_ledger_back_exactly`,
   `a_transfer_that_succeeded_with_a_long_return_value_is_settled_as_paid_not_rolled_back`.)
7. **Payee registered before the lock.** A token trade's value cannot be reserved for a destination the token has
   not reported as registered, at intent creation and at destination activation. Only the token's answer is
   recorded; a failed view changes nothing. (`release_cannot_lock_value_for_an_unregistered_payee`,
   `destination_change_needs_the_new_payee_registered_before_the_lock_moves`,
   `a_failed_storage_view_changes_nothing_about_the_payee`.)
8. **Caps.** With a cap, no registration names more than it and no deposit takes `held()` above it; an over-cap
   deposit is refused whole. (`cap_bounds_the_trade_amount_and_the_value_a_trade_holds`, sandbox cap test.)
9. **Mainnet guard.** `new("near-mainnet")` never yields a zero cap; mainnet accepts a token trade only for the
   pinned token; terms and intents signed for one network label are invalid under the other.
   (`network_guard_accepts_mainnet_only_with_non_zero_caps`, `mainnet_terms_use_their_own_profile_token_pin_and_caps`,
   sandbox mainnet-label test.)
10. **Unexpected assets stay unexpected.** A token transfer without a funding message is recorded and never
    credited, also for a trade's own token, and its recovery pays exactly the recorded amount once.
    (`m50_the_trade_token_without_a_funding_message_is_recorded_never_credited_and_recoverable`.)
11. **Unchanged native behaviour.** The 123 core host tests that existed before M50 pass with one assertion
    changed in `t007_t008_funding.rs` (see M50.md) and the shared test context given the limits field; the native
    sandbox tests pass with one init assertion changed.

## Test list

Core host tests (`pnpm run contract:test`, 141 passed; 3 of them added by the audit in `tests/m50_funder_return_bound.rs`), new file `tests/m50_nep141_rail.rs`:
`nep141_asset_is_part_of_the_signed_terms`, `asset_schema_is_exact_per_kind_and_fails_closed`,
`only_the_named_token_contract_credits_the_trade`, `funding_message_decides_between_funding_and_an_unexpected_asset`,
`token_buckets_follow_the_native_rules`, `release_cannot_lock_value_for_an_unregistered_payee`,
`token_release_settles_or_rolls_back_exactly`, `hold_blocks_a_token_release_until_the_risk_principal_resolves_it`,
`token_refunds_return_to_the_original_funder_and_a_failed_transfer_rolls_back`,
`a_successor_revision_can_never_change_the_asset`,
`destination_change_needs_the_new_payee_registered_before_the_lock_moves`,
`cap_bounds_the_trade_amount_and_the_value_a_trade_holds`,
`a_pinned_token_is_the_only_nep141_asset_a_deployment_accepts`,
`network_guard_accepts_mainnet_only_with_non_zero_caps`, `mainnet_terms_use_their_own_profile_token_pin_and_caps`.

near-sdk unit tests (`near_sdk_unit.rs`, in the sandbox container): `new_refuses_an_unknown_network`,
`new_refuses_mainnet_with_a_zero_cap`, `new_refuses_a_zero_minimum_token_deposit`,
`new_accepts_mainnet_with_default_caps_and_a_pinned_token`,
`ft_on_transfer_funds_the_named_trade_and_returns_every_refused_amount`, `native_near_cannot_fund_a_token_trade`,
`a_trade_above_the_cap_does_not_register`, `a_trade_naming_another_token_than_the_pinned_one_does_not_register`,
`a_token_release_checks_the_payee_then_schedules_ft_transfer_with_one_yocto`,
`a_token_release_intent_is_refused_until_the_payee_is_confirmed`,
`the_payee_check_cannot_be_pointed_at_another_account`, `a_failed_token_refund_restores_the_exact_bucket`,
`a_transfer_that_succeeded_with_a_long_return_value_is_settled_as_paid_not_rolled_back`,
`a_failed_token_release_restores_the_reservation`, `a_failed_storage_view_changes_nothing_about_the_payee`,
`a_storage_answer_that_is_neither_a_balance_nor_null_changes_nothing`.

near-workspaces tests on nearcore with a real NEP-141 contract (`sandbox-tests/tests/m50_nep141_rail.rs`):
`m50_paid_in_the_trade_token_and_every_wrong_funding_is_returned`, `m50_hold_then_paid_in_the_trade_token`,
`m50_mutual_cancel_refund_and_excess_return_in_the_trade_token`,
`m50_a_failed_token_transfer_rolls_the_ledger_back_exactly`,
`m50_cap_and_pinned_token_bound_what_a_trade_can_hold`,
`m50_a_squatted_trade_id_cannot_take_the_honest_funding`,
`m50_the_trade_token_without_a_funding_message_is_recorded_never_credited_and_recoverable`,
`m50_mainnet_label_needs_caps_and_runs_the_token_trade_under_its_own_profile`.

The acceptance list of the build plan, and where each item is tested on nearcore:

| Item | Test |
|---|---|
| paid | `m50_paid_…` |
| hold then paid | `m50_hold_then_paid_…` |
| mutual cancel refund, excess return | `m50_mutual_cancel_refund_and_excess_return_…` |
| failed transfer rollback | `m50_a_failed_token_transfer_rolls_the_ledger_back_exactly` (release: the payee unregistered after the check; refund: the funder left the token) |
| unregistered payee | `m50_paid_…` (refused before and after a check that answers "not registered") |
| wrong token | `m50_paid_…` (a second real token contract names the right trade and digest; returned) |
| cap exceeded | `m50_cap_and_pinned_token_…`, `m50_mainnet_label_…` |
| replay | `m50_paid_…` (approval, release, settlement callback, new intent after PAID), `m50_mutual_cancel_…` (settled refund) |
| squatted trade id | `m50_a_squatted_trade_id_…` |
| mirror equals contract after every step, both assets | the harness (`Dock::call`, `Dock::ft_send`) for every call of every sandbox test |

run-all on nearcore: `run_all_runs_the_usdc_journeys_and_the_mainnet_label_on_sandbox`. run-all guards:
`packages/near/test/m50-run-all-usdc-mainnet.test.ts` (13 tests).

## What was checked by reading, with the result

- **Callers of `ft_on_transfer`.** Anyone can call it. Crediting requires the predecessor to be the trade's token.
  An unexpected-asset record stores the predecessor as the asset contract, so its recovery calls `ft_transfer` on
  the contract that created the record, never on another token.
- **Cross-trade and cross-asset payout.** `pay` reads the asset from the trade being paid. There is one ledger per
  trade and no pooled balance in the contract's own state.
- **A contract that lies.** On a testnet deployment without a pinned token, a trade can name a contract that
  reports deposits it never received or "succeeds" without moving anything. It can only affect trades whose signed
  terms name it. On mainnet no such trade registers.
- **Re-entrancy.** State is written before every promise is scheduled; the settlement callbacks are `#[private]`
  and check the intent or refund state and, for a release, the attempt id.
- **Callback outcome.** Decision 5 of ADR-0028 (the `TooLong` case). The payee callback fails closed for anything
  that is not a storage balance or `null`.
- **Arithmetic.** `held() + amount` uses `checked_add`; the release profile keeps `overflow-checks = true`.
- **Message parsing.** `funding_message` uses `serde_json` on the `msg` string; a message with `tradeId` and
  anything unexpected is refused, not recorded.

## What merging this changes for the deployed escrow

- The deployed `gnanam1990-dock-escrow2.testnet` keeps running the earlier build (`7GEti5E6…5h8N`). Nothing here
  can change it.
- After a merge, the repository's source builds to `ACFe6Us2…k2sq`, not to the code on escrow2. Records that
  describe the deployment (`deploy/escrow-manifest.json`, the proof page data, the M24/M34/M44 evidence) stay
  correct because they describe escrow2, not the source. A fresh `pnpm run contract:reproduce` no longer
  reproduces escrow2's wasm; that needs a checkout of commit `4ff233b` or any commit before this merge.
- Anything that points the API or worker preflight (`DOCKSIDE_ESCROW_MANIFEST`) at a freshly built manifest while
  `DOCKSIDE_ESCROW_CONTRACT_ID` is still escrow2 will be refused with a code hash mismatch. Keep using the
  deployment's own record for escrow2, or move to the new escrow account once it exists.
- The M50 build cannot be deployed over escrow2 (run-all refuses an account with code, and the state layout
  differs). escrow3 is a new account.
- One opt-in test pinned escrow2's code hash as the hash of "the wasm this test deploys"
  (`services/worker/test/m43-relayer-sandbox.test.ts`); it now reads the manifest. It is not part of
  `pnpm run check`, so it would have failed silently after a merge.

## Open questions for the reviewer

1. **Gas on Circle's USDC.** `ft_transfer` gets 20 Tgas and `storage_balance_of` 10 Tgas, the settlement callback
   15 Tgas static plus the unused remainder. This was measured only against the near-contract-standards token.
   Circle's contract has blocklist and pause checks. If its `ft_transfer` needs more than 20 Tgas the release fails
   and rolls back (no loss), but the trade cannot be paid. Is a testnet run enough before mainnet, or should the
   allowance be raised now?
2. **A settlement callback that runs out of gas.** As before M50, if a settlement callback itself fails, the intent
   stays SUBMITTING (or the refund EXECUTING) and nothing in the contract resolves it. With tokens the callback does
   the same work as for native NEAR. Is the 15 Tgas static allowance acceptable for the largest trade record
   ADR-0022 allows?
3. **Blocklisting and pausing.** If the token contract blocks the escrow, a payee or a funder, or pauses, transfers
   fail and roll back indefinitely. The value is not lost and not reachable. Accepted for a 25 USDC cap?
4. **Per-trade cap, no deployment-wide cap.** The cap bounds one trade. Anyone can register many trades, so the
   contract's total holdings are not bounded by the contract. The mainnet plan (D2) relies on the owner funding
   only its own journeys. Should a deployment-wide cap be added before mainnet?
5. **Decimals are declared, not verified on chain.** The contract cannot read `ft_metadata` synchronously. run-all
   compares the declared decimals with the token's metadata before deploying; a deployment made by hand could pin
   wrong decimals. They are informational for the contract (all amounts are base units).
6. **Minimum token deposit.** Default 10000 base units (0.01 USDC). A token deposit attaches no NEAR, so deposit
   records (at most 72 per trade, ADR-0022) are paid from the escrow account's balance, and so is one yoctoNEAR
   per `ft_transfer`. Registration of trades was already free. Is the liveness risk (the account running low on
   NEAR for storage) acceptable, and should run-all check the escrow's free balance?
7. **Returning instead of failing.** A refused token funding is a successful call that returns the amount, so
   explorers show a green transaction. The reason is in the `nep141_funding_returned` log. Preferable to a panic
   (which also returns the tokens but hides the escrow's reason behind the token's resolve), or not?
8. **`check_payee_storage` is permissionless and separate from the intent.** A payee can unregister between the
   check and the release (then the release fails and rolls back). Is a separate step acceptable, or should intent
   creation itself wait on the token's answer?
9. **Plain `ft_transfer` to the escrow** leaves tokens the contract has no record of and cannot return (unchanged
   from before M50; with a real token on mainnet it matters more).
10. **Escrow account keys.** A full-access key on the escrow account can redeploy the contract or move its NEAR and
    tokens directly. Should the mainnet run delete the full-access key after deployment (then nothing can ever be
    recovered or upgraded), or keep it under the owner's custody for a 25 USDC exposure?
11. **Mainnet beyond the specification.** The sealed specification keeps mainnet blocked. ADR-0028 records the
    owner's instruction. The reviewer should confirm that the direct mainnet path adds no way around the checks
    the testnet path has (it is the same code with a different label, profile names and mandatory caps).
12. **The token id.** The mainnet USDC id in the documents
    (`17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`) was checked only by reading its
    `ft_metadata` over a public RPC. Confirm it against Circle's documentation before any real-funds run.

## Independent audit, 2026-11-13

Scope: `git diff main...feat/dockside-m50-usdc-rail` for `contract/crates` (deployable code), the near-sdk
wrapper's callers in `contract/integration` and run-all (`scripts/testnet-deploy`). Classes checked: NEP-141 receiver
and callback ordering, promise failure and rollback, re-entrancy across callbacks, `ft_on_transfer` return values,
storage registration of the payee, token-id confusion, decimals, caps and the network guard, rounding, ledger
conservation under failure, replay and nonces, private callbacks, init races, gas in callbacks, unexpected assets.
Every candidate was checked with a host test or on a local nearcore node (near-sandbox 2.14.0 in a container).

### Fixed (commit `e335eda`)

1. **A stranger could grow another party's trade record without bound** (medium). Any account becomes a funder of
   any trade with one minimum deposit (0.01 USDC). A funder-initiated return (`PARTIAL_FUNDING_RETURN`,
   `EXCESS_FUNDING_RETURN`) that ends REVOKED, or FAILED because the transfer failed (for a token trade the funder
   can cause that itself by leaving the token's storage registration), stays in the record for good, so a
   request/revoke loop grew the victim's record by 546 bytes per cycle (host test: 2229 bytes, then 56829 after
   100 cycles), paid from the escrow's own NEAR as storage stake, and made every later call on that trade more
   expensive. ADR-0022 had recorded this loop as an open follow-up. Fix: at most `MAX_ENDED_FUNDER_RETURNS` (4)
   such returns per funder per trade; the next return request from that funder is `CAPACITY_EXCEEDED`. Nobody
   else's refunds are affected, and a return that paid does not count.
   Tests: `tests/m50_funder_return_bound.rs` (3, host) and
   `m50_a_stranger_cannot_bloat_a_trade_and_a_minimum_gas_relay_still_settles` (nearcore), both failing before the fix.
2. **The settlement callbacks had a fixed 15 Tgas while rewriting a record of unbounded size** (medium). Anyone may
   relay `execute_release` or `execute_refund` and may attach only as much gas as the call accepts; the callback
   then gets about its static 15 Tgas. On nearcore, after 120 stranger cycles on a token trade the release callback
   of a minimum-gas relay burnt 13.9 Tgas (3.9 Tgas for a normal record); a few more cycles would leave it without
   gas after the token transfer had gone out, the intent would stay SUBMITTING, and with it any excess or failed
   value of that trade, since nothing in the contract resolves a SUBMITTING intent or EXECUTING refund. Fix: the
   release and refund callbacks get 15 Tgas plus 300 Mgas per byte of the trade record (measured about 170 Mgas per
   byte), so a relay that attaches less fails before anything is transferred or recorded. Test:
   `the_settlement_callback_is_funded_for_the_size_of_the_record` (near-sdk unit), failing before the fix.

Suites after the fix: `pnpm run contract:test` 141 passed; `pnpm run contract:sandbox` `sandbox suite PASS`
(42 tests: 2 fixtures, 1 storage bounds, 9 M50 on nearcore, 23 near-sdk unit, 7 native on nearcore; then the 3
run-all validations); `pnpm run check` 814 passed, secret scan clean; `pnpm run contract:reproduce` gives the
digest at the top of this packet ([docs/evidence/M50/](../evidence/M50/)).

### Open, for the owner

- **Free storage at the escrow's cost** (low). `register_trade` needs no deposit: on nearcore a stranger's
  registration added 1893 bytes (0.019 NEAR of the escrow's balance locked as storage stake) for 0.00055 NEAR of
  gas, about 34 times. Token deposits attach no NEAR either (64 deposits added 5671 bytes). Pre-existing for
  registration; on mainnet the escrow's balance is real NEAR. Effect: the escrow's free NEAR can be locked into
  storage and new registrations, fundings and executions then fail until it is topped up; no trade value can be
  taken. The release callback adds a history entry and drops the live-intent id, so it does not grow the record
  and a paid release still settles; the refund callback grows it by about 20 bytes. Mitigation without a code
  change: keep only a small NEAR balance on the escrow, and top up in the same transaction as the call that needs
  it. A real fix (a storage deposit on registration, or a storage budget per trade) changes who pays and how the
  relayer signs, so it is an owner decision.
- **Very large records need more gas than the product attaches** (low). After fix 2 a record of about 150 KB (64
  funders each with 4 ended returns) needs about 110 Tgas for `execute_release`; the product and run-all attach 100
  Tgas. Such an execution fails whole and can be repeated with more gas; nothing is lost.
- **Circle's `ft_transfer` within 20 Tgas** (needs validation). The test token used 1.76 Tgas. Circle's contract
  was not run here. The testnet run measures it; if it ever needed more, transfers fail and roll back, and the
  value cannot be paid out by this deployment.
- Questions 3, 4, 9, 10 and 12 above stand as written (pausing and blocklisting, no deployment-wide cap, plain
  `ft_transfer` to the escrow, escrow key custody, the mainnet token id). `new` is callable by anyone until the
  contract is initialised; run-all deploys and initialises in one transaction, and a manual deployment must too.

Checked and not a finding: a forged `ft_on_transfer` (credits nothing, returns the amount); a second token naming
the trade and digest (returned, `ASSET_MISMATCH`); the unexpected-asset record of a forged call names the forging
account as the asset contract, so its recovery can only call that account; the private callbacks; a payee check
whose destination changed before the answer (refused, nothing changes); replays of approvals, executions and
settlements; the cap counting excess; the mainnet label with zero caps, an unpinned token or testnet-signed terms.
