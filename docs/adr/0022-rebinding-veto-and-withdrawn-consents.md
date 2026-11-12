# ADR-0022 — Old-key veto of a party rebinding and durable withdrawal of successor consents

- Decision status: accepted (security fix, dockside m31-rebinding-consent-integrity)
- Date: 2026-11-12, Dockside platform team
- Amends: [ADR-0017](0017-key-rebinding-revisions.md) decisions 2 and 3. Every other ADR-0017 decision stands.
- Affected IDs: TDD §4 (recovery never silently replaces an approver), TDD §7 steps 3, 4 and 10, T-006,
  T-020, T-021; REAL-PRODUCT-GATE item 8
- Relates to: ADR-0006 (destination supersession), ADR-0015 (deployable wasm)

## Context

An external security audit raised two contract issues, both reproduced with host tests
(`contract/crates/dockside-escrow-core/tests/sec_m31_rebinding_consent_integrity.rs`):

1. **Counterparty takeover through key rebinding.** ADR-0017 decision 2 lets the rebound party sign with
   its **new** key, which comes from successor terms the proposer writes. A supplier could generate a key
   K', write a successor that sets `buyer.publicKey = K'` (and replaces every non-party key), propose as
   BUYER signed with K' and consent with its own real key. The real buyer's bound key could not revoke the
   rebinding (revocations were checked against K'), so after the delay the supplier held the buyer, inspector,
   attestor, policy and resolver roles. With a signed delay of zero there was not even a delay. TDD §4
   forbids silently replacing an approver inside an active trade.
2. **Replay of revoked consents.** Successor-revision consents are signatures over the successor
   `dockside/trade-revision` digest. They carry no nonce, and the successor bytes stay valid until another
   revision activates. After a party revoked a destination change or rebinding it had consented to, anyone
   could resubmit the earlier public signatures and restore a CONSENTED change. TDD §7 step 10 says a revoked
   consent fails closed.

## Decisions

1. **The rebound party's old key keeps a veto.** `revoke_key_rebinding` accepts, for the role being
   rebound, a signature by the key the active revision binds, as long as that key is not revoked on chain
   (`KEY_REVOKED` otherwise). The new key can still revoke too. The old key still cannot propose or consent
   for the rebound party (ADR-0017 decision 2 is unchanged there).
2. **Retiring the old key gives up the veto.** A SELF revocation of the old key (compromise) removes its
   veto, and the recovery rebinding proceeds as before. A lost key cannot veto, so the lost-key recovery path
   of ADR-0017 is unchanged.
3. **No zero-window party rebinding while the old key is live.** If the trade's signed
   `destinationChangeDelayMs` is 0, `activate_key_rebinding` refuses a party rebinding (`INVALID_STATE`) until
   the rebound party's old key is revoked on chain. Non-party rebindings and trades with a nonzero delay are
   unchanged. The product never signs a delay below one minute (`DOCKSIDE_DESTINATION_CHANGE_DELAY_MS` ≥ 60 s).
4. **Withdrawn consents are durable.** When a party revokes a destination change or key rebinding **that it
   had consented to**, the contract records `(successor digest, party)` as withdrawn. Proposals and consents
   by that party over that digest are refused afterwards (`NONCE_REPLAYED`). A party that rejects a proposal
   it never signed is not marked, so the product's reject-then-agree flow (T-042 browser suite) still works.
   For an old-key veto of a rebinding, the rebound party's consent (made with the new key) is the one withdrawn.
5. **No state layout change.** The withdrawal marks live in the trade's existing replay set
   (`TradeRecord.nonces`) under a key prefix of their own (`dockside/trade-revision|withdrawn|<party>|<digest>`)
   that no signed nonce can collide with (nonces are 16 to 32 bytes of lowercase hex, and they are stored
   under their own signing domain). No borsh struct changed, so existing state deserializes unchanged.

## Consequences

- The deployable wasm changes and the code hash moves (recorded in
  `docs/status/SEC-dockside-m31-rebinding-consent-integrity.md`). Because the layout did not change, the owner
  can redeploy the testnet escrow in place (same account, no migration). Until then the testnet escrow runs
  the old code and still has both issues.
- A party that consented and then revoked cannot later consent to the **identical** successor at the same
  revision. The successor terms have no free field, so the same change is reachable again only after some
  other revision activates. That is the fail-closed reading of TDD §7 step 10.
- The veto window of a party rebinding is the trade's signed delay. A counterparty can keep proposing new
  attacker keys, so the rebound party must veto each one inside its window. This is the same model as
  destination-change revocation.
- The API and browser still prepare a rebinding revocation only for the key the successor binds for the
  party, and only for successors the API journaled. A rebinding written directly against the contract with
  attacker-chosen keys is vetoed by relaying `revoke_key_rebinding`, signed by the old key, to the contract.
  Offering that veto in the browser is follow-up work.
