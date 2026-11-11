# ADR-0006 — Release intents, pre-submit exits and destination change

- Decision status: accepted (M04)
- Date: 2026-11-11, Dockside build stage M04
- Affected IDs: FR-05, FR-06, FR-11, NFR-01, NFR-02, INV-03, INV-05, INV-06, INV-09, INV-10, INV-11, INV-12,
  INV-15, INV-16, T-009, T-010, T-015, T-019, T-020, T-021, T-022, T-023, T-046, T-047, T-050; consumed by M05
  (reconciliation), M06 (funded profile), M07 (API), M08 (UI)

## Context

M02 left the per-funder ledger with a `reserved` bucket nobody used and the INSPECTION_FAIL / PERMANENT_HOLD
refund rows disabled. M03 left contract-accepted manifests, inspector decisions and HoldRecords. TDD §5, §6, §7
and §11 describe the release conjunction, the release-intent state machine, CANCEL/ABANDON and the
destination-change protocol as behaviour, not method signatures.

## Decisions

1. **One live intent per trade owns the whole value lock.** The trade has one milestone and one amount, so a
   release intent always locks exactly `amountYocto`: every funder's AVAILABLE slice moves to `reserved` and
   the slices are recorded on the intent. A second intent while one is live is `VALUE_LOCKED`. Partial
   funding cannot back an intent (`NOT_FULLY_FUNDED`).
2. **Stable random id.** The buyer's client picks `rli_<32 hex>` (`randomIds`); the contract does not derive
   it from revision, digest, quote or attempt. The buyer signs `dockside/release-intent` over the id, amount,
   profile, destination, destination digest, source-bucket digest and `intentExpiresAt`. An exact duplicate
   (same request digest) joins and changes nothing; the same id with different material is
   `IDEMPOTENCY_CONFLICT`. Attempts are child identities derived from the intent id and ordinal.
3. **Release is recomputed at execution.** `release_blockers` enumerates every missing term in a stable order
   (trade expiry, funding, contract-accepted manifest usable and unconsumed, current inspector PASS, no ACTIVE or
   EXPIRED_UNRESOLVED hold, no live refund of accepted value, live intent, revision, intent expiry, profile,
   destination, exact reservation, approval present/unexpired/bound to the same manifest, attestation,
   inspection and holds view). `execute_release` fails with the first blocker and lists all of them; the view
   `get_release` exposes the same list. Release consumes the manifest attestation (`consumed = true`).
4. **Buyer approval binds what the buyer saw.** `dockside/buyer-approval` binds intent id and state version,
   amount, profile, destination, manifest revision/digest, attestation digest, inspection digest and a
   `dockside/holds-view` digest over every HoldRecord with its status. A hold set and resolved after approval
   changes the holds view, so the approval goes stale (`APPROVAL_STALE`) and the parties must CANCEL or wait
   for ABANDON and approve a new intent. Approval exists only from `VALUE_LOCKED`.
5. **Outcome of the direct transfer.** `execute_release` enters `SUBMITTING` and returns a native transfer to
   the revision-bound destination plus a private `on_release_transfer` callback. Success is `PAID`
   (reserved -> released). A failed transfer refunded by the runtime is the authoritative no-transfer proof
   for `FAILED` (reserved -> available, intent retired); retry needs a new intent, a fresh attestation (the old
   one was consumed) and a fresh approval. If the callback never runs the intent stays `SUBMITTING`.
   `PROCESSING`, `UNKNOWN`, `REVIEW`, `RECONCILING`, `ADJUDICATION` exist in the state machine but are entered
   only by the M05 reconciler; until it exists, host tests assign them after a real submit to prove the
   denials, and the receipt can still settle `PROCESSING`/`UNKNOWN`/`RECONCILING` but never `REVIEW` or
   `ADJUDICATION`.
6. **CANCEL.** A `dockside/cancel-release-intent` payload (exact intent, state, version, amount, destination
   digest, source-bucket digest, buyer organization, reason code, request nonce, expiry) is never signed by
   itself; each designated party signs a `dockside/cancel-consent` over its digest with its own role,
   capability, key version, role nonce and expiry. The first consent records the pending payload; the matching
   second consent executes in the same call. A different payload while a current consent is pending is
   `CANCEL_DISAGREEMENT` and changes nothing. Request, role and revocation nonces must differ and are consumed
   per domain. A party revokes only its own consent (`dockside/revoke-cancel-consent`). Expired consents and
   consents of a key revoked on chain never complete a cancel. CANCEL restores the exact slices to AVAILABLE; it
   does not cancel the trade or authorize a refund.
7. **ABANDON and its policy.** The trade terms schema (M00) has no abandonment-policy field, and changing it
   would change every revision digest. Decision: the signed profile `dockside-direct-testnet-v1` binds
   abandonment policy `dockside-abandon-v1` revision 1 with a 24-hour grace; the contract and the payload name
   it explicitly. Triggers are `INTENT_EXPIRED` (the signed `intentExpiresAt`) and `BUYER_APPROVAL_EXPIRED`;
   `FUNDED_AUTHORIZATION_EXPIRED` is `NOT_ELIGIBLE` in the direct profile. The contract recomputes the trigger
   time; `triggerAt` and `abandonAfter` must equal its values. One signature of the designated buyer approver
   or supplier signer suffices after `trigger + grace`; no other role has a key path. Flip condition: a terms
   schema v2 with an explicit abandonment policy.
8. **Destination change is a successor revision.** `propose_destination_change` takes the full successor terms;
   they must equal the active terms except `revision` (+1), `predecessorDigest` (= active digest) and
   `payout.destination` (`IMMUTABLE_FIELD` otherwise). The proposer's signature over the successor
   `dockside/trade-revision` digest is its consent; the other party signs the identical digest. The delay of
   the active revision starts at the second consent; consents must arrive within 7 days. Either party may
   revoke before activation. Activation is permissionless after the delay and refuses: a revoked party key,
   a released trade, an unresolved post-submit intent, any live refund, and accepted value already refunded.
   On activation the terms and digest change (so every revision-1 payload fails `check_header`), the accepted
   manifest and inspection move to history, a pre-submit intent becomes `SUPERSEDED_PRE_SUBMIT` and its exact
   reservation moves without a ledger change to one successor intent (`rli_` + digest of predecessor id and new
   revision digest) in `VALUE_LOCKED`. Unresolved holds keep blocking across revisions (fail closed); they are
   resolved with the new revision's header. Manifest revisions keep increasing across revisions.
9. **Refund rows at the release boundary.** INSPECTION_FAIL: buyer or supplier initiates with one signature
   while the current inspection is FAIL; clock = inspection recorded time + 48 h; the supplier may appeal
   before the deadline (REVIEW); authorization needs the risk/policy key (`dockside/refund-authorize`) and the
   FAIL attestation must still be current; the risk principal may revoke before execution. PERMANENT_HOLD:
   the risk principal initiates when the latest hold resolution is `RESOLVE_TO_REFUND` and no hold blocks; the
   supplier consents (at request or with `cosign_refund`); cooling = second signature + 48 h; either required
   signer revokes during cooling; a new hold blocks authorization. Every row (including partial and excess
   returns) is refused at request, authorization and execution while a release intent is unresolved, and the
   party rows need the pre-submit intent to exit first (reserved value is never refundable).
10. **CANCEL/ABANDON under a hold** are allowed: they only move value from `reserved` back to `available`,
    which is more conservative than holding it for release; refunds of that value still read the holds.
11. **Service side.** `@dockside/release` prepares every payload, verifies party signatures against the keys
    the active revision binds (`verifyPrincipalSignature`), refuses what the contract refuses, and returns
    unsigned relay calls; it never holds a party key. The journal (`release_intents`) has one live row per
    trade through a partial unique index, so two API processes racing for the lock have one winner; events,
    children and verified signatures are append-only and intent identity columns are immutable (triggers).
    `sync` mirrors contract state as observations and fails closed on contradictions with a terminal journal
    state. After activation `bindActivatedRevision` binds the successor in `EvidenceService` using both
    journaled party signatures; predecessor attestations then read `SUPERSEDED`.

## Consequences

- WORKING_TESTNET's release half has a complete local path (services -> compiled contract on the simulated
  host) but no testnet evidence: deployment, funding and signing need testnet accounts (BLOCKED). The runbook
  is `scripts/testnet-deploy/README.md` section 7.
- M05 owns the post-submit transitions and must keep every refusal listed in decision 5 and 9.
- The wasm grew to ~709 KB (storage stake ~7 NEAR on testnet); size reduction remains optional.
