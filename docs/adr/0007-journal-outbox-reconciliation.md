# ADR-0007 — Durable economic-operation journal, outbox and reconciliation

- Decision status: accepted (M05)
- Date: 2026-11-11, Dockside build stage M05
- Affected IDs: FR-08, NFR-01, NFR-06, INV-02, INV-06, INV-07, INV-08, INV-09, INV-12, T-028, T-029, T-030,
  T-031, T-032, T-056, T-057; consumed by M06 (funded profile), M07 (API), M08 (UI)

## Context

M04 left the escrow contract as the authority for release and refund: `execute_release` / `execute_refund`
enter SUBMITTING / EXECUTING and settle in a private callback (PAID / REFUNDED on a successful native
transfer, FAILED with exact restoration when the runtime returns the transfer). Nothing persisted the
service side of the economic operation, nothing survived a crash between "decided to submit" and "know the
outcome", and the post-submit states PROCESSING, UNKNOWN, REVIEW, RECONCILING and ADJUDICATION were only
reached in host tests by assignment. TDD sections 10-14 ask for operations plus outbox, fenced leases,
monotonic observations and a reconciler that never retries blindly.

## Decisions

1. **One economic-operation row per external effect** (`economic_operations`, migration 0005). Kinds
   `RELEASE` (direct testnet release of a release intent) and `REFUND` (escrow refund to the original
   funder). Each row binds the subject id, an operation digest over the exact material (trade, revision,
   intent/refund id, amount, asset, recipient, per-funder slices and source bucket, the exact contract call),
   the per-funder ledger snapshot at enqueue and the exact call. Identity columns are immutable (trigger).
   One non-withdrawn operation per subject, and one lock-holding release operation per trade (partial unique
   indexes). Exact duplicates join; changed material under the same subject is `IDEMPOTENCY_CONFLICT`.
2. **The state machine is data and is enforced by the database.** `operation_transition_rules` holds the
   TDD release and refund tables plus the journal's pre-submit states `QUEUED` and `WITHDRAWN`; a trigger
   refuses any other transition, any terminal state without an `operation_dispositions` row naming the
   evidence and the ledger after it, any lock release outside a terminal state, any second submit
   (`submit_count` 0/1, only from QUEUED), and any version step other than +1. A unit test proves the
   service table equals the database table. No code path, operator or ad-hoc `UPDATE` can promote REVIEW
   or ADJUDICATION to PAID/REFUNDED/FAILED.
3. **Transactional outbox.** `JournalService.enqueueRelease` re-checks the full release conjunction through
   `ReleaseService.prepareExecution`, then writes operation, first transition and outbox row in one
   transaction. `enqueueRefund` requires the contract refund to be AUTHORIZED and no release lock.
4. **Write-ahead submit, at most once.** The outbox worker takes the per-operation fenced lease
   `op:<id>`, re-reads the subject on the contract, signs exactly one transaction (`TxSigner`), and in one
   transaction persists the signed bytes, hash, reference block height, the SUBMITTING/EXECUTING transition
   and the outbox completion. Only then does it broadcast. Nothing ever re-reads the outbox for an operation
   that left QUEUED, so a crash anywhere afterwards resumes as reconciliation of the original hash.
5. **Fenced leases.** `worker_leases` (name, holder, epoch, expiry). A takeover after expiry increments the
   epoch; every worker mutation re-checks holder, epoch and expiry inside its transaction (`LEASE_LOST`
   otherwise); epochs are monotonic (trigger). Two worker processes racing one row produce one submit.
6. **Evidence sources and observations.** Each reconciliation reads, independently: the contract's subject
   state and attempt ids, the escrow ledger for the operation's funders, the original transaction by hash
   (`EXPERIMENTAL_tx_status`) and that transaction's receipts as destination (or original-funder) evidence.
   Each read is an append-only observation with source, subject, observed/recorded time, freshness,
   confidence (`AUTHORITATIVE` / `ATTRIBUTED` / `UNAVAILABLE`), revision, correlation id and a digest of the
   normalized fact; an identical fact from the same source joins (duplicate delivery). Runtime refund
   receipts (predecessor `system`) are not value movements.
7. **Deterministic decision** (`decide`, pure). PAID needs contract PAID, a final transaction, a final receipt
   crediting the revision-bound destination with the exact native amount and the exact ledger move
   reserved -> released per funder. REFUNDED needs the same for the original funder and
   refundLocked -> refunded. FAILED needs a final transaction plus contract and ledger proof that the value
   never left: `TRANSFER_RETURNED` (receipt FAILURE, contract FAILED, exact restoration to the source bucket),
   `REJECTED_BEFORE_EFFECT` (final transaction failure, no contract attempt, nothing released) or
   `EXPIRED_NOT_INCLUDED` (hash unknown after the transaction's validity window, no attempt, nothing
   released). A lost or unreadable outcome is UNKNOWN; a pending settlement is PROCESSING; missing, private,
   mismatched (recipient, amount, token asset) or contradictory evidence is REVIEW; past the reconciliation
   deadline the operation goes to REVIEW, never to FAILED. Paths between states are the shortest legal path
   through PROCESSING/RECONCILING only.
8. **REVIEW and ADJUDICATION.** REVIEW leaves only on genuinely new evidence (a new observation since entry)
   while no incident freezes the operation, or on an operator `REQUEST_RECONCILIATION`. Operators (the
   risk/policy capability) can request reconciliation, open adjudication (REVIEW -> ADJUDICATION), name an
   evidence source or freeze a trade; there is no request kind that asserts an outcome, and requests are
   append-only and audited.
9. **Incidents and freezes.** Contradictory authoritative observations, destination mismatch, a conservation
   failure, and any evidence after a terminal disposition that contradicts it (e.g. the contract shows the
   intent executed after the journal's FAILED) open an append-only incident, freeze the trade and list the
   subject and every later intent. A frozen trade gets no new intent, approval, submit, destination
   activation or refund operation (`TRADE_FROZEN`). `escalateIncident` turns the freeze into contract
   authority: the deterministic-policy service SETs a HoldRecord under the versioned rule
   `reconciliation-incident@1`, which the contract's release predicate enforces for any successor.
   Terminal states never change; terminal operations stay watched for `watchMs` (default 24 h).
10. **ReleaseService integration** (extends M04 rather than writing journal states into `release_intents`).
    While any operation holds the trade's value lock, intents, approvals, executions, exits and activation
    are `VALUE_LOCKED`; an intent that has an operation (queued, unresolved or FAILED) can never be approved
    or executed again (`INVALID_STATE`), so a retry needs a new intent and fresh buyer approval (and, after
    `TRANSFER_RETURNED`, a fresh attestation because the old one was consumed). CANCEL/ABANDON remain
    allowed once the operation is terminal, which is how the parties restore a reservation that
    `REJECTED_BEFORE_EFFECT` / `EXPIRED_NOT_INCLUDED` left with a pre-submit intent.
11. **Provider refunds (funded corridor).** `reconcileProviderRefund` counts final receipts at the quote-bound
    refund authority in the origin asset once per receipt id, adds late ones, keeps a short amount locked,
    quarantines excess, refuses other targets/assets and re-delivered receipts with different facts, and
    allocates proportionally to the funders' reserved slices with a deterministic remainder. It is not
    wired to any operation because the funded profile stays `FUNDED_RAIL_BLOCKED` (M06).
12. **NEAR transaction boundary.** `@dockside/near` gains `NearTxClient` (`block`, access-key nonce,
    `send_tx`, `EXPERIMENTAL_tx_status`, receipt parsing) and the `TxSigner` interface. A relayer signer for
    testnet needs a relayer account and key: BLOCKED in this build. Tests use a simulated chain server
    (decision 13).
13. **Simulated chain server for tests.** `packages/journal/test/sim-chain.ts` serves the M02 simulated host
    (real compiled wasm) over HTTP JSON-RPC with blocks, nonces, a validity window, idempotent re-broadcast,
    receipts (including runtime refunds) and fault controls (lost responses, dropped requests, status
    outage, deferred callbacks, hidden and contradicting receipts). Its transactions are an unsigned JSON
    envelope, not borsh. Workers in separate processes reach it only through the production clients.

## Consequences and limits

- `REJECTED_BEFORE_EFFECT` and `EXPIRED_NOT_INCLUDED` are authoritative non-transfer for the operation, but
  the contract's pre-submit intent (or AUTHORIZED refund) still holds the value: `execute_release` is
  permissionless on the contract, so another relayer could still execute it. The journal treats such later
  evidence as a conservation incident (freeze + hold escalation) rather than a normal transition, and the
  parties restore the reservation with CANCEL/ABANDON (or funder revocation for returns). A contract-side
  retirement entry point for this case is a possible later upgrade.
- A contract stuck in SUBMITTING/EXECUTING (callback never ran) keeps every lock forever; no human can
  resolve it to a terminal state. That is the fail-closed reading of INV-08; a resolution needs verifiable
  receipt proof on chain, which NEAR does not offer to contracts.
- One relayer key per worker deployment is assumed; concurrent workers sharing one key would need a nonce
  allocator under its own lease.
- Real NEAR testnet submission, receipts and finality are NOT_RUN (no relayer account or key may be used).
