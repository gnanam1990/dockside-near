# SEC m31 — counterparty key-rebinding takeover and replay of revoked successor consents

- Source: external security audit, two needs-validation contract leads. Both were treated as unverified claims
  and reproduced on the real code before any change:
  - (a) `dockside-escrow-core:rebinding_signer:counterparty-chosen-key-seizes-party-role`: a counterparty
    rebinds the other party's key to a key it chose, and the victim cannot revoke the rebinding
    (`contract/crates/dockside-escrow-core/src/rebinding.rs`, `rebinding_signer`).
  - (b) `dockside-escrow-core:successor-revision-consent-replay-after-revoke`: revoked destination-change and
    key-rebinding consents can be replayed to restore a CONSENTED change.
- Verdict: **both confirmed, fixed** (contract change, new wasm and code hash, no state layout change).
- Branch: `feat/dockside-m31-rebinding-consent-integrity`, base main `49fbaf7`, main merged in four times
  (last at `39435ec`, which brought the m33 contract storage bounds). Decision record: [ADR-0023](../adr/0023-rebinding-veto-and-withdrawn-consents.md).
- Spec: TDD §4 ("never silently replaces a supplier, inspector, destination, or approver inside an active
  trade") and TDD §7 step 10 ("a conflicting proposal, revoked consent, expired signature, or changed digest
  fails closed"). The sealed spec under `docs/spec/` was not edited.

## The issues

**(a)** ADR-0017 has the rebound party sign a key rebinding with its **new** key, and that key comes from
successor terms the proposer writes. A supplier could set `buyer.publicKey = K'` (and replace every non-party
key in the same revision), propose as BUYER signed with K', and consent as SUPPLIER with its real key.
`revoke_key_rebinding` checked a BUYER revocation against K', so the real buyer's bound key was refused
(`SIGNATURE_INVALID`). A party cannot revoke the other party's key, and a SELF revocation of a rebound role is
cleared at activation. After the delay, permissionless activation gave the supplier the buyer, inspector,
attestor, policy and resolver roles. With a signed delay of 0 it could activate straight after the consent.

**(b)** Successor consents are signatures over the successor `dockside/trade-revision` digest, with no nonce.
`revoke_destination_change` and `revoke_key_rebinding` only moved the pending change to history. The successor
stays valid (revision + 1, predecessor = active digest) until another revision activates, so anyone could
resubmit the public proposal and consent arguments and restore a CONSENTED change that a party had withdrawn.

## Reproduction (red)

Tests written first: `contract/crates/dockside-escrow-core/tests/sec_m31_rebinding_consent_integrity.rs`,
run on the unchanged contract (base main `49fbaf7` code).

```
cargo test --manifest-path contract/Cargo.toml --locked -p dockside-escrow-core --test sec_m31_rebinding_consent_integrity
exit 101 — 2 passed; 4 failed
  FAILED m31a_the_rebound_partys_live_old_key_vetoes_a_counterparty_rebinding
         revoke_key_rebinding signed by the real buyer key: left "SIGNATURE_INVALID", right "OK"
  FAILED m31a_zero_signed_delay_cannot_rebind_a_party_whose_old_key_is_live
         activation straight after the counterparty's consent: left "OK", right "INVALID_STATE"
  FAILED m31b_a_revoked_destination_consent_cannot_be_replayed
         replayed buyer consent after the buyer revoked: left "OK", right "NONCE_REPLAYED"
  FAILED m31b_a_revoked_rebinding_consent_cannot_be_replayed
         replayed buyer consent after the buyer revoked: left "OK", right "NONCE_REPLAYED"
  ok     m31a_an_old_key_revoked_on_chain_no_longer_vetoes_and_the_recovery_rebinding_activates  (control)
  ok     m31b_rejecting_an_unconsented_proposal_keeps_a_later_genuine_consent_possible           (control)
```

The existing assertion in `t006_key_rebinding.rs` that the rebound buyer's old key cannot revoke encoded
issue (a). It now checks that a key bound to no buyer cannot revoke.

## Fix (smallest change at the contract's decision points)

- `rebinding.rs` `revoke_key_rebinding`: for the role being rebound, a revocation signed by the key the
  active revision binds is accepted while that key is not revoked on chain (`verify_role`, so a revoked old key
  gets `KEY_REVOKED`). The new key can still revoke. The old key still cannot propose or consent.
- `rebinding.rs` `activate_key_rebinding`: when the trade's signed `destinationChangeDelayMs` is 0, a party
  rebinding activates only once the rebound party's old key is revoked on chain (`INVALID_STATE` otherwise).
- `destination.rs` and `rebinding.rs`: a revocation by a party **that had consented** records
  `(successor digest, party)` as withdrawn. Proposals and consents by that party over that digest are refused
  with `NONCE_REPLAYED`. Rejecting a proposal the party never signed records nothing, so the browser's
  reject-then-agree flow (T-042, `destination.spec.ts`) still works.
- `trade.rs`: `withdraw_consent` and `ensure_consent_live` keep the marks in the existing replay set
  `TradeRecord.nonces`, under the prefix `dockside/trade-revision|withdrawn|<party>|<digest>`. No signed nonce
  can take that form. **No borsh struct changed.**

Unchanged: lost-key and compromised-key recovery rebindings (with an old key revoked on chain), non-party
rebindings, the one-pending-revision rule, anchoring-party revocation, activation blockers, and every API
and browser flow.

## Verification (green)

| Step                              | Command                                                                                                      | Exit                             | Result                                                                                                                                                                                                                                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| New host tests                    | `cargo test ... --test sec_m31_rebinding_consent_integrity`                                                  | 0                                | 6 passed                                                                                                                                                                                                                                                                                                                             |
| Contract host tests               | `pnpm run contract:test` (after every merge of main)                                                         | 0                                | 119 tests ok after the m33 merge (109 before it), 0 failed                                                                                                                                                                                                                                                                           |
| Full check                        | `pnpm run check` (after the last merge of main)                                                              | 0                                | format, lint, typecheck, vitest 64 files / 629 passed / 3 skipped, secret scan clean (one earlier run under machine load timed out in RPC and API hook tests; rerun green)                                                                                                                                                           |
| Browser suites                    | `pnpm run web:e2e`, ports 9160–9168                                                                          | 1, then 0; 0 after the m33 merge | first run: main 51 passed (including T-042 destination and key-rebinding), assets 3 passed, reasons failed once at an evidence-upload status wait in `completeEvidence` (`flows.ts:101`), which is not on the changed path; rerun reasons 8 passed, clock 3 passed. On the merged tree: main 51, assets 3, reasons 8, clock 3 passed |
| Linux clean-checkout reproduction | `DOCKSIDE_DOCKER="wsl.exe -d Ubuntu-24.04 -u root -- docker" MSYS_NO_PATHCONV=1 pnpm run contract:reproduce` | 0                                | report `PASS` at `31f69d1` (this fix alone), `6500861` (identical wasm after the m29 toolchain change) and `00d282c` (merged with m33)                                                                                                                                                                                               |
| near-sandbox suites               | same `DOCKSIDE_DOCKER`, `pnpm run contract:sandbox`                                                          | 0                                | on `31f69d1` and again on `00d282c`: every chain test passed, including the new `m31_a_revoked_destination_consent_cannot_be_replayed_from_public_arguments`, m33 storage bounds and T-045 (deployed code hash equals the manifest); run-all journey passed                                                                          |

The new sandbox test resubmits the public proposal and consent arguments after the buyer's revocation, as real
transactions on nearcore. The proposal is accepted again, the withdrawn consent is refused with `NONCE_REPLAYED`,
activation is refused, and the destination and revision are unchanged. Its fixture support is a mirror arm for
`revoke_destination_change` and a `revoke_destination_args` builder.

## Deployable wasm

|                                                                                  | sha256                                                             | NEAR code hash                                 |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------- |
| Before (testnet escrow `gnanam1990-dock-escrow.testnet`)                         | —                                                                  | `5wqct3Wxavf9GXpdYJfrGWKpTZb1j95dJZQsNmAvzHuM` |
| This fix alone (commit `31f69d1`, 810467 bytes)                                  | `5cbe83d387c68ee14bcb63a8c33200afb9955cefa2a1a6622a51a9364a8e240b` | `7F312wsCkcZpGvQw4aiStUgDPd4SdFoUk3wddyLA6rNn` |
| **Deployable after merging main (commit `00d282c`, 811485 bytes, includes m33)** | `9ac71106fb399c672c318d6fc3058ac62629438f16965e8e5ff37a10b1765751` | `BRBqmkPp2FyYM1PArmKL4gv8PuuFsJZkooroPHrUx49n` |

Later commits on this branch change only documentation, so the deployable wasm is the `00d282c` one.

**Owner action required.** The testnet escrow `gnanam1990-dock-escrow.testnet` still runs the old code hash
`5wqct3Wxavf9GXpdYJfrGWKpTZb1j95dJZQsNmAvzHuM` and has both issues until the owner redeploys it. The state
layout did not change (ADR-0023 decision 5, and ADR-0022 decision 5 for m33), so a code-only redeploy of the
`00d282c` wasm to the same account works without a migration or a fresh account. No testnet or mainnet
transaction was made here. If a later security fix changes the layout before the redeploy, follow its ADR for the
redeploy target.

## Residual

- A party's veto window is the trade's signed delay. The product never signs less than 60 s
  (`DOCKSIDE_DESTINATION_CHANGE_DELAY_MS`), and a zero delay now needs the old key revoked on chain. A
  counterparty can keep proposing fresh attacker keys, and the rebound party must veto each one inside its window.
- A party that consented and then revoked cannot consent again to the **identical** successor at the same
  revision (fail closed, TDD §7 step 10).
- The API and browser offer a rebinding revocation only for journaled successors and the successor-bound key.
  A rebinding written directly against the contract is vetoed by relaying `revoke_key_rebinding`, signed by the
  old key, to the contract. A browser control for that is follow-up work.
