# SEC m28-asset-queue-poison — a failing post-settlement token view stalled the asset recovery engine

- Source: external security audit, confirmed finding 4 (LOW). Verified independently on the real code.
- Branch: `feat/dockside-m28-asset-queue-poison`, base main `49fbaf7`.
- Area: `packages/journal/src/assets.ts` (`AssetRecoveryEngine.reconcile`, RECOVERED branch; `runOnce`).

## Finding

`AssetRecoveryEngine.runOnce` walks every due asset recovery operation (all trades and organizations) and rethrows any
error other than `LEASE_LOST` / `VERSION_CONFLICT`. Once the escrow reports a recovery `RECOVERED`, `reconcile` read
`ft_balance_of` on the operation's asset contract outside any `try`. That contract is the one the unexpected-asset
sender chose. If its view fails (panic, non-u128 value, or a view that only fails once the escrow balance is zero),
the error escaped `runOnce` before any `move()` recorded a reason or backoff. The operation kept its `next_check_at`,
stayed first in `due()` (`ORDER BY next_check_at, created_at`), and every later tick aborted at it: other
operations were never submitted or reconciled, and the poisoned one stayed `SUBMITTING`.

Verified: reproduced with the compiled escrow wasm on the simulated NEAR host behind `SimChainServer`, through the
production `JsonRpcNearClient`, `EscrowContract`, `NearTxClient` and `Nep141Reader`.

## Fix

The post-settlement token read is guarded the same way as the source reads at the start of `reconcile`: on failure
the operation is moved (fenced) with reason `POST_SETTLEMENT_TOKEN_UNAVAILABLE:<code>` and an exponential-backoff
`next_check_at`; a `SUBMITTING` operation becomes `UNKNOWN`, an `UNKNOWN`/`PROCESSING` one keeps its state. It stays
open, so it is never asserted `RECOVERED` without the independent token read (REFUND-POLICY: after submit the asset
is locked, ambiguity is `UNKNOWN`, reconciliation uses the original transaction identity without blind retry). When the
view answers again, the normal `RECOVERED` / `REVIEW` decision runs unchanged. `runOnce` is unchanged: internal
faults still surface, but this untrusted external read can no longer reach it.

## Tests (red before green)

New `packages/journal/test/m28-asset-queue-poison.test.ts`: a sender-deployed token whose `ft_balance_of` panics once
the escrow holds none of it (asset 0) and an ordinary token recovery (asset 1) are both approved and queued, the
hostile one first. One `runOnce` must resolve, leave the hostile operation `UNKNOWN` with the new reason and a future
`next_check_at`, and settle the other operation `RECOVERED`. Later passes keep it open with growing backoff; once the
view answers, it settles `RECOVERED` from the original transaction hash (exactly two `execute_asset_recovery`
executions in total).

| Step | Command | Exit | Result |
|---|---|---|---|
| Before fix | `npx vitest run packages/journal/test/m28-asset-queue-poison.test.ts` | 1 | `runOnce` rejected with `DocksideError: view call failed` (`UPSTREAM_ERROR`) from `Nep141Reader.balanceOf` in `reconcile` |
| After fix | same command plus `m11-asset-recovery-journal` and `m15-asset-process-kill` | 0 | 3 files, 15 tests passed |
| Full suite (after `git merge main`) | `pnpm run check` | 0 | format, lint, typecheck; 56 test files passed, 1 skipped; 587 tests passed, 3 skipped; secret-scan clean (502 files) |
| Contract | `pnpm run contract:test` | 0 | 103 passed, 0 failed |

Browser e2e and sandbox suites were not re-run: the change is limited to the journal's asset recovery engine.
