# SEC m32: hold resolver liveness and deposits bound to the agreed terms digest

- Source: external security audit, two needs-validation contract leads. They were treated as unverified
  claims and reproduced on the real code before any change.
  - (a) `dockside-escrow-core/trade/revoke_key:party-revokes-sole-hold-resolver-strands-escrow`
  - (b) `packages/near/src/escrow.ts:fundCall:no-terms-digest-binding:squatted-trade-id`
- Verdict: **both confirmed and fixed** (contract change, new deployable wasm).
- Branch: `feat/dockside-m32-hold-liveness-and-funding-binding`, base main `49fbaf7`. Main was merged in
  twice: `66cfce9`, then `39435ec`, which brought m33 contract storage bounds and ADR-0022. The final runs
  are on `f4f41ba`.
- Decision record: ADR-0023 (amends ADR-0004 decision 11). The sealed spec under `docs/spec/` was not edited.

## What the spec decides

- FR-12, TDD §8 and the SECURITY.md role matrix: only the separately enrolled risk/policy principal may
  RESOLVE a hold. Expiry never clears a hold, and an ACTIVE or EXPIRED_UNRESOLVED hold blocks release,
  cancellation and refund eligibility (INV-10, TDD §8). TDD §6 and §14: recovery of a key inside an active
  revision needs an explicit dual-signed revision.
- FR-02: funding is accepted "only for the exact trade identity, original funder, asset, amount, chain, and
  contract account".

Neither behaviour is intended by the spec. A lone party revoking the only resolver contradicts the
recovery-first design, because the revoking party can veto the dual-signed recovery and nothing remains after
expiry. A deposit that lands in a record whose terms the funder never signed is not funding of the "exact
trade identity".

## (a) A lone party could revoke the risk resolver

`TradeRecord::revoke_key` accepted `signerRole` BUYER or SUPPLIER for every non-party role, `riskResolver`
included (ADR-0004 decision 11). Afterwards `resolve_hold` fails `KEY_REVOKED`. INSPECTION_FAIL authorization
and the PERMANENT_HOLD basis need the resolver. TRADE_EXPIRY, MUTUAL_CANCEL and release approval need zero
blocking holds. A hold that is already set, or one the deterministic policy sets afterwards, therefore blocks
every exit.

Fix (`contract/crates/dockside-escrow-core/src/trade.rs`): a party signature can no longer revoke
`riskResolver` (`FORBIDDEN`). Only the resolver key itself (SELF) can revoke it. Parties keep their
revocation of the inspector, ManifestAttestor and policy-setter keys. To replace a distrusted resolver, the
parties use a non-party key rebinding, which activates at the second consent and clears the revocation mark
(ADR-0017). Refusing only while a hold is blocking was rejected: the party can revoke first and the
`inspection-fail@1` hold can follow.

## (b) A deposit was addressed by trade id alone

`register_trade` is first-come and verifies the signatures against keys inside the submitted terms. Anyone who
saw the proposal package could register the same trade id first with self-controlled keys and payout.
`fund(trade_id)` then credited the buyer's deposit to that record.

Fix: the contract method is `fund(trade_id, terms_digest)`. `TradeRecord::fund_exact`
(`contract/crates/dockside-escrow-core/src/lib.rs`) refuses a malformed digest (`VALIDATION_FAILED`) and any
digest other than the record's current `terms_digest` (`STALE_REVISION`) before the ledger changes. The
panicking call returns the attached deposit. Callers updated:
- `EscrowContract.fundCall(tradeId, termsDigest, amount)` (validates the digest shape);
- the integration mirror, `fund_args(trade_id, terms_digest)` and `dockside-journey-mirror` (testnet journey);
- the local-stack wallet simulator `/control/fund` (sends the API-bound digest);
- the web Funding callout, which now names `terms_digest` and the bound `termsDigest`;
- every TS and Rust test caller.

State layout is unchanged (no stored type changed), so the escrow can take the new code in place. The `fund`
argument set changed: an old client that omits `terms_digest` is refused and gets its deposit back.

## Reproduction (red, before the fix)

The host tests were written first: `contract/crates/dockside-escrow-core/tests/t052_hold_liveness_and_funding_binding.rs`.
On the `49fbaf7` core (with `fund_exact` calls mapped to the then-existing `fund`, because no binding API
existed):

```
cargo test --locked -p dockside-escrow-core --test <t052 copy>
exit 101 - test result: FAILED. 1 passed; 3 failed
  x a_party_alone_cannot_revoke_the_risk_resolver_under_a_hold         left: "OK" right: "FORBIDDEN" (SUPPLIER)
  x a_party_alone_cannot_revoke_the_risk_resolver_before_a_hold_either left: "OK" right: "FORBIDDEN"
  x a_deposit_binds_the_agreed_terms_digest                            left: "OK" right: "STALE_REVISION"
  ok the_risk_resolver_key_can_still_revoke_itself_and_parties_keep_other_revocations
```

The end-to-end effect on the same code: the supplier revoked the resolver under an `inspection-fail@1` hold,
then `resolve_hold` returned `KEY_REVOKED` and `blocking_holds = 1`. A squatted record registered with
self-made keys under the same trade id accepted the buyer's 10 NEAR (`committed = 10 NEAR`, fully funded).

## After the fix

| Command | Exit | Result |
| --- | --- | --- |
| `cargo test --locked -p dockside-escrow-core --test t052_hold_liveness_and_funding_binding` | 0 | 4 passed |
| `pnpm run contract:test` (at `f4f41ba`) | 0 | 21 test binaries ok, 0 failed |
| `pnpm run check` (at `f4f41ba`) | 0 | 64 files passed, 1 skipped; 630 tests passed, 3 skipped |
| `pnpm run web:e2e` (ports 9170-9179 via `DOCKSIDE_E2E_*`) | 0 | 51 + 3 + 8 + 3 passed (main, assets, reasons, clock configs) |
| `pnpm run contract:reproduce` at `f4f41ba` (`DOCKSIDE_DOCKER="wsl.exe -d Ubuntu-24.04 -u root -- docker"`, `MSYS_NO_PATHCONV=1`) | 0 | clean checkout PASS, 630 passed |
| `pnpm run contract:sandbox` at `f4f41ba` (near-sandbox 2.14.0, that wasm) | 0 | report `PASS`; sandbox_escrow 6 passed, near-sdk unit 7 passed, m33 bounds 1 passed, run-all journey 1 passed |

New wasm-level and chain-level checks:
- `packages/near/test/m02-escrow-wasm.test.ts`: on the compiled wasm, a trade id squatted with other keys
  refuses the buyer's deposit for the agreed digest (`STALE_REVISION`). The buyer balance is unchanged and the
  ledger and contract balance stay at 0.
- `contract/integration/sandbox-tests/tests/sandbox_escrow.rs`: on near-sandbox, `fund` naming another digest
  is refused with `STALE_REVISION`.
- Updated `holds_and_keys.rs` and `t006_key_rebinding.rs`: a party revocation of `riskResolver` is `FORBIDDEN`,
  and the resolver's own (SELF) revocation still works and stays revoked unless rebound.

Runs in between: one earlier `contract:reproduce` failed with vitest hook timeouts (`Hook timed out in
10000ms`) and one e2e test timed out waiting for `state-loading`. Both ran while the other suite loaded the
host at the same time. Each passed when rerun alone. One sandbox run failed to compile `near_sdk_unit.rs`
(moved `digest`, E0382). It was fixed in `test(contract): near-sdk unit suite passes the registered digest to
fund` and passed on rerun.

## Deployable wasm

- Old deployed wasm: the testnet escrow `gnanam1990-dock-escrow.testnet` runs code hash
  `5wqct3Wxavf9GXpdYJfrGWKpTZb1j95dJZQsNmAvzHuM` and keeps both defects until redeployed.
- New wasm (reproduced at `f4f41ba`, which includes m33; `.data/repro/build-manifest.json`):
  - sha256 `f3071e6c2d32a64714cf83588874ccb50a73de2713da6cf109d804e250995d72`
  - NEAR code hash `HMgNFt6CPYzA3YDJ33RrkiGUVkr53u4diKg6RdTeT7gd`
  - Before the m33 merge, this change alone reproduced as sha256
    `16c01d84c32e483402253cbe7d1eafc88c216fa3935f6196f472bd7374f6282c` (code hash
    `2XossaAZqk1C3gJmmhtfSrxpkYGZCZh88gXtEaGz8tvw`), which is superseded.
- Owner action: redeploy the escrow with this wasm. This change needs no state migration and no fresh account,
  because it leaves the stored layout unchanged (ADR-0023 decision 3). See ADR-0022 for the m33 changes in
  the same wasm. Clients must send `terms_digest` with `fund`
  from then on. No testnet or mainnet transaction was sent from this branch.

## Residual risk

- A lost or self-revoked resolver key while a hold is set still needs both parties' consent to a rebinding
  before `expiresAt`. The refund policy defines no risk-key-loss row, so changing that is a policy decision.
- Trade id registration stays first-come. A squatter can still force a fresh proposal, but cannot take value
  from a funder who names the agreed digest. The API projection does not yet show a `TERMS_DIGEST_MISMATCH`
  blocker before funding.
