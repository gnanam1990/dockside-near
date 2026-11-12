# ADR-0024 — Hold resolver liveness and deposits bound to the agreed terms digest

- Decision status: accepted (security fix for dockside m32, external security audit)
- Date: 2026-11-12, Dockside platform team
- Affected IDs: FR-02, FR-12, FR-14, INV-10; T-007, T-014, T-016
- Relates to: ADR-0004 decision 11 (bound-key revocation, amended here), ADR-0006 decision 9 (refund
  rows), ADR-0017 (key rebinding), ADR-0023 (rebinding veto)

## Context

An external security audit raised two contract leads that needed validation. Both reproduced against
the real core with host tests (`contract/crates/dockside-escrow-core/tests/t052_hold_liveness_and_funding_binding.rs`).

1. **One party could strand the escrow behind a hold.** ADR-0004 decision 11 let the buyer or the
   supplier revoke any non-party key, the risk resolver included, on its own signature. The risk/policy
   resolver is the only principal that can RESOLVE a hold (FR-12, SECURITY.md role matrix). It is also
   the only authority for an INSPECTION_FAIL authorization and a PERMANENT_HOLD basis. TRADE_EXPIRY and
   MUTUAL_CANCEL refunds and release approval all need zero blocking holds, and expiry never clears a
   hold (TDD §8, INV-10). After a lone party revocation of the resolver, a hold that is already set,
   or one the deterministic policy sets later (for example `inspection-fail@1`), can never be resolved.
   The only recovery is a key rebinding that both parties sign before `expiresAt`, so the revoking
   party can veto it. After expiry no on-chain exit is left.
2. **A deposit was addressed by trade id alone.** `register_trade` is first-come and verifies the
   party signatures against keys named in the submitted terms. Anyone who learned the trade id from
   the proposal package (the supplier, for example) could register it first with terms whose keys and
   payout it controls. `fund(trade_id)` then credited the buyer's deposit to that record, and the
   squatter's own keys could release it. FR-02 requires funding to be accepted "only for the exact
   trade identity".

## Decisions

1. **Only the risk resolver key can revoke itself.** `TradeRecord::revoke_key` refuses
   `signerRole` BUYER or SUPPLIER for `role = riskResolver` (`FORBIDDEN`). A lone party can still
   revoke the inspector, ManifestAttestor and policy-setter keys. None of those is the only exit from
   a hold: the resolver can still resolve, and refunds that need no hold remain available. To retire a
   resolver they distrust, the parties use a key rebinding that replaces the resolver key. A rebinding
   of non-party roles only activates at the second consent (ADR-0017 decision 3), and its activation
   clears the revocation mark. The resolver principal can still revoke its own key (SELF), for example
   on compromise. Recovery from that follows the spec's recovery-first rule (a dual-signed revision).
   This amends ADR-0004 decision 11.
   - Rejected: refusing a party revocation only while `blocking_holds() > 0`. That still strands the
     trade when the party revokes first and the deterministic policy sets the hold afterwards.
   - Rejected: letting TRADE_EXPIRY ignore holds once the resolver is revoked. That changes refund
     eligibility, which TDD §8 says reads the authoritative hold state.
2. **A deposit names the agreed revision digest.** The contract method is now
   `fund(trade_id, terms_digest)`. The core's `TradeRecord::fund_exact` refuses a malformed digest
   (`VALIDATION_FAILED`) and any digest other than the record's current `terms_digest`
   (`STALE_REVISION`) before the ledger changes. The failed call returns the attached deposit. A squatted
   trade id, or a revision that a destination change or key rebinding has since superseded, therefore
   cannot take value the funder meant for the agreement it signed. `EscrowContract.fundCall(tradeId,
   termsDigest, amount)` validates the digest shape client-side too. The web Funding callout shows the
   API-bound `termsDigest` that a funder's `fund` call must carry. The local-stack wallet simulator
   (`/control/fund`) sends the API-bound digest.
3. **No state layout change; the call ABI changes.** No stored type changed (`TradeRecord`, `Ledger` and
   the contract state are byte-identical), so the testnet escrow can take the new code in place, with no
   fresh account or migration. The `fund` argument set did change: a client that still calls
   `fund({trade_id})` gets a deserialization panic and its deposit back. Clients and the testnet journey
   (`dockside-journey-mirror`) send `terms_digest`.

## Consequences

- The deployable wasm changes (new sha256 and NEAR code hash in
  `docs/status/SEC-dockside-m32-hold-liveness-and-funding-binding.md`). The deployed testnet escrow
  `gnanam1990-dock-escrow.testnet` still runs code hash `5wqct3Wxavf9GXpdYJfrGWKpTZb1j95dJZQsNmAvzHuM`
  and keeps both defects until the owner redeploys it.
- Residual risk: if the resolver key is lost or self-revoked while a hold is set, recovery still needs
  both parties' consent before `expiresAt`. The refund policy has no risk-key-loss row, so changing that
  is a policy decision outside this fix.
- Residual risk: a squatter can still take a trade id (registration stays first-come). That costs the
  honest parties a fresh proposal, not funds. The API projection does not yet show a dedicated
  `TERMS_DIGEST_MISMATCH` blocker before funding.
