# ADR-0013 — Destination-change screen, refund request routes and refund controls

- Decision status: accepted (M10 follow-up)
- Date: 2026-11-12, Dockside platform team (M10)
- Affected IDs: UI-SPEC §3.5 and §3.8, REFUND-POLICY (`dockside-refund-v1` revision 1), INV-04, INV-05, INV-09,
  INV-13, T-003, T-008, T-009, T-010, T-042, T-050
- Relates to: ADR-0004 (escrow contract), ADR-0006 (release intents, exits, destination), ADR-0007 (journal),
  ADR-0010 (product UI and local stack), ADR-0011 (hardening)

## Context

M04 put dual-consent destination change and every `dockside-refund-v1` row into the contract and the release
service; M09 served the destination-change routes over HTTP. The web app still said that no destination or refund
route existed, offered no control, and the API served no refund request route at all, so a refund could only be
driven by tests calling the contract directly. M08 and M09 listed both gaps; T-042 had no UI half.

## Decisions

1. **Refund routes are a thin, authority-checked relay over the contract** (`services/api/src/refunds.ts`). The
   contract stays the authority for the eligible amount, the source bucket, the reason row, clocks, callers and
   signatures. The API adds the same three layers as the trade routes (PoP session, capability matrix entry
   `SIGN_REFUND_REQUEST`, the trade's bound buyer approver, supplier signer or risk/policy resolver with its exact
   key version), refuses early what the contract would refuse (with the contract's own codes, including the new
   `NO_REFUND_SUBMIT` and `DISPUTE_NOT_ALLOWED`), prepares the exact canonical payload, verifies the signer
   against current authority, appends an audit event and returns the contract call. Eligibility shown to users is
   served as a labelled projection of the contract ledger, never as a verdict.
2. **Prepared requests and verified signatures are journaled append-only** (migration
   `0006_refund_requests.sql`, update/delete triggers). The second signer of `MUTUAL_CANCEL` or
   `PERMANENT_HOLD` reviews the exact payload the first signer signed, and the API refuses to serve a cosign
   payload whose digest is not the one the contract holds.
3. **Funder returns are the funder's own transaction.** `PARTIAL_FUNDING_RETURN` and `EXCESS_FUNDING_RETURN` are
   initiated and revoked by the original funder's NEAR account (the contract checks the transaction signer). A
   trade party may ask the API to prepare that call; no session can sign it and no relayer can submit it. The UI
   shows the exact call for that wallet and says the wallet connector is BLOCKED. The local stack gains a
   simulated funder-wallet route (`POST /control/funder-call`, refund methods only) for the browser tests.
4. **Authorization after a timelock is a permissionless relay; the API does not pre-judge time.** The contract
   checks its own clock, the deadline, disputes, holds and the release lock, and the UI shows its refusal
   (`DELAY_NOT_ELAPSED`) verbatim. `INSPECTION_FAIL` keeps its separate risk/policy signed authorization. Request
   payloads live 24 hours (the contract allows up to seven days); revoke, dispute and authorization payloads one
   hour. Execution goes through the M05 journal (`enqueueRefund`): one operation, one submit, same lock rules as a
   release.
5. **Destination-change screen on the Agreement tab** (`apps/web/src/screens/trade/Destination.tsx`): current and
   proposed destinations side by side, proposer, the only changed field and its diff, both consents, exact UTC
   delay and countdown, what activation invalidates (attestation, inspection, holds view, intent, approval), and
   the `SUPERSEDED_PRE_SUBMIT` statement in the activation confirmation. Activation is blocked while an operation
   holds the value lock. The revocation and activation routes now append audit events like consent and binding.
6. **The destination-change delay new proposals bind is configurable**: `DOCKSIDE_DESTINATION_CHANGE_DELAY_MS`,
   default one day, minimum one minute, maximum 30 days. The parties sign the value into `delayPolicy`; the
   contract enforces the signed value, so the setting cannot shorten an existing trade. The browser tests use the
   one-minute minimum and wait it out for real (API and contract both refuse earlier).
7. **Simulated chain time can move forward in the local stack only** (`POST /control/chain-time`). Refund rows
   have contract timelocks of at least one hour that cannot be shortened, so the browser test advances the
   simulated block time past the 1-hour `MUTUAL_CANCEL` revocation period. The API, worker and sessions keep the
   wall clock. Consequence found in testing: afterwards payloads the API issues with a one-hour lifetime read as
   expired on the chain, so the advance is used once, in the last refund test. No such control exists for a real
   network and nothing in the product calls it.
8. **In-flight signed actions stay mounted** (the M08 pin pattern) when the state they change removes their
   condition (consent, cancellation, activation, refund request, cosign, authorization, execution).

## Consequences

- `GET /v1/trades/:id/refund` now also serves the signed reason matrix, per-funder candidates and the viewer's
  refund role; the web endpoint catalog lists 13 refund routes and every destination route as implemented, and
  no endpoint is planned.
- Refund controls exist for every submit row. Browser-driven on the simulated chain: excess return, its
  revocation, a dispute into REVIEW, and mutual cancellation through REFUNDED. `TRADE_EXPIRY`, `INSPECTION_FAIL`
  and `PERMANENT_HOLD` controls render from the same code but were not driven end to end here (their contract
  rows are covered by the M02/M04 contract tests).
- Unexpected assets: the API serves no asset-recovery records, so the panel says so and offers nothing.

## Flip conditions

- A wallet connector (NEP-413 or a NEAR wallet selector) is added: replace the "hand this call to the funder's
  wallet" panel with a wallet submit, still refusing any session-signed funder return.
- An asset-recovery API is served: render its records in the separate panel with their own challenge and
  revocation, never as refundable native NEAR.
- A product requirement for per-trade delay choice: move the delay from server configuration into the proposal
  form, bounded by the same minimum.
