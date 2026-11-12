# SEC m33 — contract storage bounds for permissionless callers

- Source: external security audit, three needs-validation leads on contract storage growth. They were
  treated as unverified claims and reproduced on the real code before any change.
- Verdict: **all three confirmed and fixed**.
- Branch: `feat/dockside-m33-contract-storage-bounds`, base main `49fbaf7`.
- Decision record: ADR-0022 (`docs/adr/0022-contract-storage-bounds.md`).
- Spec: SECURITY.md, NFR-02 (fail-closed validation) and NFR-04 (resource budgets) decide intended
  behavior, and none of them asks for unbounded growth. REFUND-POLICY.md keeps an unresolved
  unexpected asset in review. Nothing under `docs/spec/` was edited.

## The issues

| Lead | Entry point | Defect |
|---|---|---|
| (a) | `ft_on_transfer`, `nft_on_transfer`, `mt_on_transfer` | Any account can call them directly, without a token transfer or deposit. Each call persists up to 32 records, paid from the escrow balance that also holds escrowed NEAR, and nothing removes them. |
| (b) | `request_asset_recovery`, `revoke_asset_recovery` (CLAIMED_SENDER), `challenge_asset_recovery` (CLAIMANT) | These steps are authenticated only by the caller's own account, yet each inserts a nonce into the governing trade's `nonces` set. A stranger that names itself as the sender of its own NEP-141 record can loop request and revoke against any trade. |
| (c) | `fund` | The call is permissionless, appends one `Deposit` per call and quarantines any excess, which can later be returned. The history is unbounded. |

## Reproduction (red)

Host probe on the unmodified code. The probe was a temporary test file and was removed after the run.
The output is in `.data/sec-m33/before-host-probe.txt`, which is not tracked.

```
cargo test --locked -p dockside-escrow-core --test zz_probe_before -- --nocapture      # exit 101
PROBE(b): 200 stranger request+revoke cycles: victim nonces=400 trade bytes 1957 -> 41757 ; asset recoveries=200 asset bytes=71570
PROBE(c): 1000 stranger minimum deposits accepted: deposits=1001 trade bytes 1957 -> 86130
```

The committed regression test `packages/near/test/m33-storage-bounds-wasm.test.ts` ran against the wasm
compiled from unmodified main. It runs the real wasm under the simulated NEAR host, which counts
persisted bytes.

```
npx vitest run packages/near/test/m33-storage-bounds-wasm.test.ts                    # exit 1
  × (a) the token receivers stop persisting records at the contract-wide cap   expected null to be 'CAPACITY_EXCEEDED'
  × (b) a stranger's recovery loop never grows the governing trade             expected null to be 'CAPACITY_EXCEEDED'
  × (c) repeated minimum deposits from a stranger stop at the per-trade cap    expected 84 to be 63
```

The test in (a) found no refusal, even for a maximal 32-entry batch of maximal records. The test in (c)
found that all 84 stranger deposits were accepted.

## Fix

The change sits at the last trusted decision point: the core authority checks in
`dockside-escrow-core`. The receivers in `dockside-escrow` call the core capacity check. There is no
borsh layout change.

- `assets::MAX_UNEXPECTED_ASSETS = 16` and `assets::ensure_capacity` are checked for the whole call by
  each receiver, so an mt batch fits whole or not at all. Past the cap the call panics with
  `CAPACITY_EXCEEDED`, and the token contract refunds the sender under its own standard.
- `assets::MAX_RECOVERIES_PER_ASSET = 4`: a fifth request fails with `CAPACITY_EXCEEDED` and the asset
  stays in review.
- The request, the CLAIMED_SENDER revoke and the CLAIMANT challenge check their nonce (`VALIDATION_FAILED`
  if malformed, `NONCE_REPLAYED` if the trade already consumed it) but do not insert it. The signed steps
  are unchanged and still consume trade nonces: risk approval and revoke, and buyer, supplier and risk
  challenges.
- `MAX_DEPOSITS_PER_TRADE = 64`. Past the cap only a deposit that completes an under-funded trade is
  accepted, for at most `MAX_COMPLETING_DEPOSITS_OVER_LIMIT = 8` more. Every other deposit fails with
  `CAPACITY_EXCEEDED`.
- The test mirror (`contract/integration/fixtures/src/mirror.rs`) applies the same capacity check to
  `ft_on_transfer` and now mirrors `revoke_asset_recovery`. `asset_sender_revoke_args` was added to the
  fixtures.

## Regression tests

- `contract/crates/dockside-escrow-core/tests/sec_storage_bounds.rs`: 10 host tests. A stranger loop
  leaves the trade byte-identical. A claimant challenge consumes no trade nonce. Signed steps still
  consume nonces. An unsigned step cannot reuse a consumed nonce. The attempt cap holds, and the batch
  capacity covers the whole batch. Worst-case unexpected-asset storage is under 100,000 bytes (73,376
  bytes measured). The deposit cap holds, a full history cannot block the completing deposit, and the
  worst-case deposit history adds under 32,000 bytes.
- `packages/near/test/m33-storage-bounds-wasm.test.ts`: the same three leads against the compiled wasm.
- `contract/integration/sandbox-tests/tests/m33_storage_bounds.rs`: the leads on a real near-sandbox
  node. It reads `storage_usage`, and it sends a real NEP-141 `ft_transfer_call` past the cap, which the
  token contract refunds to the sender.

## Verification (green)

RESULTS_PLACEHOLDER

## Deployable wasm

WASM_PLACEHOLDER

The testnet escrow `gnanam1990-dock-escrow.testnet` runs the **old** code hash
`5wqct3Wxavf9GXpdYJfrGWKpTZb1j95dJZQsNmAvzHuM` and must be redeployed by the owner. The state layout
is unchanged (ADR-0022 decision 5), so a code-only redeploy on the same account is enough, with no
migration or fresh account. This branch made no testnet or mainnet transaction.

## Residual, out of scope

A funder can loop request and revoke on its own refund rows (`PARTIAL_FUNDING_RETURN`,
`EXCESS_FUNDING_RETURN`), and each cycle still appends refund intents and nonces to that trade. The
deposit cap bounds the number of funders (at most 72), but not the number of cycles. This is
recorded for a follow-up item.
