# Exact Corridor and Settlement Contract

Status: **SPECIFICATION_ONLY**. Runtime evidence: **NOT_RUN**.

## Working testnet corridor

`WORKING_TESTNET` has one exact economic path:

```text
buyer-controlled NEAR testnet account
  -> native testnet NEAR in yoctoNEAR
  -> Dockside NEAR testnet escrow contract
  -> contract-bound supplier NEAR testnet account
```

- The funded asset and released asset are the same native testnet NEAR asset.
- The original funder account is recorded per deposit.
- The supplier destination is a named NEAR testnet account bound into the active trade revision.
- The contract transfers directly to that account only after it derives current EvidencePolicy completeness from enrolled ManifestAttestor facts, verifies no active or expired-unresolved HoldRecord, and consumes the independent inspector pass, buyer approval, and release-intent lock.
- A 1Click dry quote is optional compatibility/readiness evidence and cannot satisfy a testnet release predicate, move testnet escrow value, or support a payment claim. Its independent state is `NOT_RUN`, `UNKNOWN`, `INCOMPATIBLE`, or `PASS`; only `PASS` supports `DRY_COMPATIBLE`.
- `WORKING_TESTNET` means this direct path passed with real testnet transactions and separate buyer, supplier, inspector, and risk/policy authorities. It does not mean cross-chain settlement works.

## Blocked mainnet one-rail corridor

The only planned funded cross-chain path is:

```text
Dockside NEAR mainnet escrow holding the configured origin asset
  -> exact active 1Click quote deposit address on the origin network
  -> 1Click route
  -> contract-bound supplier final destination on the destination network
```

The quote must include the exact origin and destination assets/networks, input amount, output constraint, final recipient, recipient type, deposit address, deadline, slippage, fees, and a `refundTo` controlled by the escrow/refund authority on the required origin domain. The executor can request and observe; it cannot rewrite these facts.

A post-quote `FundedPayoutAuthorization` binds every fact above plus releaseIntentId, quote ID/digest, exposure cap, nonce, expiry, signer, and refund authority. The contract consumes it atomically once when transferring the exact origin value to the quote deposit address.

Funded mainnet remains `BLOCKED` until all of the following are verified and separately authorized: actual supported asset/corridor, quote authenticity and consumption design, escrow-to-deposit transfer, refundTo semantics, operation-scoped signing, exposure cap, provider status reconciliation, source-chain finality, and destination receipt. A dry quote cannot open this gate.

## Release intent and child records

`releaseIntentId` is random, stable, and created when a specific escrow value is locked for one economic release. It is not derived from trade revision, quote, deposit address, or attempt, although those records bind back to it.

- Quotes are children of the release intent.
- A quote may be replaced only before funded authorization or any submit boundary, while the release intent remains value-locked and the active trade facts are unchanged.
- `FundedPayoutAuthorization` selects one quote and freezes quote renewal.
- Attempts are children of the release intent and selected authorization.
- `VALUE_LOCKED`, `DIRECT_TESTNET_AUTHORIZED`, `FUNDED_AUTHORIZATION_REQUIRED`, and `FUNDED_AUTHORIZED` may exit before submit only through dual-signed buyer/supplier CANCEL, objectively expired policy-triggered ABANDON signed by the designated buyer approver or supplier signer, or destination-activation SUPERSEDE. Administrators and service principals have no CANCEL or ABANDON authority. Canonical nonces/expiries and contract predicates are mandatory. Cancel/abandon atomically restore the recorded source bucket; supersede transfers it to one successor.
- Destination activation may perform only that atomic pre-submit supersession. It cannot supersede an intent after the submit boundary.
- While `SUBMITTING`, `PROCESSING`, `UNKNOWN`, `REVIEW`, `RECONCILING`, or `ADJUDICATION`, the value cannot fund another release intent, quote renewal, destination activation, refund, cancel, abandon, supersession, reservation release, or second submit.
- A late provider result, destination receipt or refund always reconciles to the original release intent. Authoritative no-transfer FAILED alone restores per-funder availability and requires a new intent/fresh approval; contradiction after failure freezes any successor.
- Dry compatibility is not a release-intent state and never owns or releases a reservation.

## Refund authority

Direct testnet escrow refunds return native testnet NEAR to the recorded original funder for the refundable deposit portion. Provider refunds in the future mainnet corridor must return to the `refundTo` escrow/refund authority, then reconcile into the original release-intent and per-funder ledgers before any withdrawal. The executor's own account is never the refund beneficiary.
