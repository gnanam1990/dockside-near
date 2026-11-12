# ADR-0016 — Refund reasons on the contract clock, relayer key sequencing and real process kills

- Decision status: accepted (M15 follow-up)
- Date: 2026-11-12, Dockside platform team (M15)
- Affected IDs: REFUND-POLICY (`dockside-refund-v1` revision 1: TRADE_EXPIRY, INSPECTION_FAIL,
  PERMANENT_HOLD), INV-04, INV-06, INV-07, INV-09, T-009, T-010, T-029, T-035, T-050, T-051, T-057,
  REAL-PRODUCT-GATE items 9, 10 and 11
- Relates to: ADR-0004 (escrow contract), ADR-0007 (journal), ADR-0013 (refund surfaces),
  ADR-0014 (unexpected-asset recovery)

## Context

M10 served every refund route but drove `TRADE_EXPIRY`, `INSPECTION_FAIL` and `PERMANENT_HOLD` only
to their refusals; no browser test raced a release against a refund or activated a destination
during a live refund; and the asset-recovery engine had only in-process crash injection. Driving
those paths end to end exposed five defects that a happy-path run never touched:

1. The refund routes prepared payload windows and pre-checked `tradeExpiresAt` on the API's wall
   clock, while the contract judges them on its own clock (the final block time). Whenever the two
   differ, the API either refuses an expired trade as "not expired" or issues payloads the
   contract already reads as `EXPIRED` (ADR-0013 §7 had to use the chain clock control only once,
   in the last test, for this reason).
2. A real NEAR node sends the block header `timestamp` as a JSON number in nanoseconds, far past
   2^53. The strict JSON parser refused the whole envelope, so `NearTxClient.latestBlock()`, which
   every worker submit calls, would have failed against a real node.
3. The inspection route bounds an inspection by its manifest attestation (one day in the default
   policy). The contract re-checks that the FAIL inspection is still current when risk/policy
   authorizes after the 48-hour appeal window, so under a one-day lifetime such a refund can never
   be authorized, yet the API locked the funder's slice for it.
4. The release/refund outbox worker and the asset-recovery engine sign with one relayer access key,
   possibly in several worker processes. Each read the chain's access-key nonce and added one, so
   two concurrent submitters signed the same nonce; the chain rejected one transaction, the refund
   journal waited in UNKNOWN and the asset engine re-sent the rejected bytes on every tick. The
   local stack's attestor and policy loops also relayed with the worker's key.
5. The asset-recovery engine exposed only two named boundaries, so a process could not be stopped
   (and killed) at claim, observation or state-transition points.

## Decisions

1. **Contract-checked windows and time predicates use the contract's clock.** `TradeModules` gains
   a required `chain: ChainClock` (`blockTimeMs()`, the final block's `header.timestamp_nanosec`);
   the API, the local stack and the API test world wire `NearTxClient`. The refund routes anchor
   every request, revocation, dispute and authorization window to it, pre-check `TRADE_EXPIRY`
   against it and compare a journaled request's expiry with it. `GET /v1/trades/:id/refund` serves
   `chainTimeMs`; the refund screen shows the contract clock and counts deadlines down on it. On a
   real network the two clocks agree to within block time, so nothing changes there; on the
   simulated chain the refund flows keep working after the chain clock moves ahead. Other modules
   (release, holds, inspection, destination) still use the wall clock: a follow-up.
2. **The RPC envelope keeps u64 numbers exactly.** `parseStrictJson` gains an opt-in
   `unsafeIntegers: "decimal-string"`; only the NEAR RPC envelope uses it, so such numbers arrive as
   exact decimal strings and code that expects a number fails closed. Contract view results are
   still parsed with the default (rejecting) limits.
3. **An INSPECTION_FAIL request that could never be authorized is refused up front**
   (`NOT_ELIGIBLE`, with the inspection expiry and the window close in the message), reading the
   contract's evidence view. Deployments that want this row reachable need an evidence policy whose
   attestation lifetime exceeds the 48-hour appeal window plus authorization latency. The local
   stack keeps one day by default; `DOCKSIDE_STACK_ATTESTATION_LIFETIME_MS` (local stack only)
   sets four days for the refund-reasons browser suite.
4. **One submitter per relayer access key, with durable nonces.** `withRelayerKey`
   (`packages/journal/src/relayer.ts`) holds a fenced `relayer-key:<signer>:<public key>` lease
   while signing, persisting and broadcasting, and allocates the nonce in the new
   `relayer_nonces` table above both the chain's nonce and every nonce already handed out
   (forward-only and delete-proof triggers). A transaction persisted by a process that died before
   broadcasting therefore never shares its nonce with a later one; when another submitter holds the
   key nothing is signed and the operation waits for the next tick. Both journaled engines use it.
   The local stack's attestor and policy services relay with their own account
   (`service-relayer.testnet`).
5. **Process kills cover the asset engine and the composed worker.** The asset engine reports
   `asset.claimed`, `asset.reconcile.observed` and `asset.transition.<STATE>` besides the two
   submit boundaries. `fixtures/asset-worker.mjs` runs the compiled engine alone;
   `services/worker/test/fixtures/worker-process.mjs` runs the compiled `WorkerLoop` with the
   outbox worker, reconciler and asset engine in one process, as the stack composes them (only the
   relayer signer is a stand-in: no custody is provisioned). Tests kill them with SIGKILL /
   TerminateProcess at those boundaries and restart from the SQLite file.
6. **The refund-reason and race browser tests run on their own stack**
   (`playwright.reasons.config.ts`), so moving the simulated chain clock (+25 h, then +24 h) never
   affects the main suite. Every non-refund payload of that suite is signed before the first
   advance. `GET /control/balances` (local stack only) returns the simulated chain's native
   balances so the tests count value movements on the chain itself.

## Consequences

- `TRADE_EXPIRY`, `INSPECTION_FAIL` and `PERMANENT_HOLD` reach REFUNDED through the API and the
  browser, with their dispute, appeal and revocation branches; a release-versus-refund race and a
  destination activation during a live refund are driven from separate browser contexts.
- A new migration (`relayer_nonces`) is required; databases from earlier builds migrate forward.
- The worker submits at most one transaction per relayer key at a time. Throughput is bounded by
  that key; more throughput needs more relayer keys (each its own lease and nonce row).

## Flip conditions

- A relayer `TxSigner` with real custody is provisioned: keep `withRelayerKey` in front of it; if
  the custody service sequences nonces itself, the allocator still only moves forward.
- The other modules adopt the contract clock for their payload windows: remove the "sign before
  the first advance" ordering from the reasons suite.
- A product decision lets an inspection outlive its manifest attestation: revisit decision 3.
