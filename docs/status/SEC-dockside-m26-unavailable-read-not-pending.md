# SEC m26 — unavailable contract read opened a false post-terminal incident

- Source: external security audit, confirmed finding 2 (MEDIUM). Treated as an unverified claim and reproduced
  independently on the real code before any change.
- Verdict: **confirmed, fixed**.
- Branch: `feat/dockside-m26-unavailable-read-not-pending`, base main `49fbaf7`.
- Spec: SECURITY.md freezes a trade on a "late success/refund or post-FAILED **contradiction**"; a failed read is
  not a contradiction. `packages/journal/src/sources.ts` documents that a failed read is recorded as UNAVAILABLE
  and never coerced into a positive or negative fact. The sealed spec under `docs/spec/` was not edited.

## The issue

`gatherFacts` records a failed contract view (`getRelease` / `getRefunds`) as an UNAVAILABLE observation but
returns `contract: "PENDING"` so the live decision path keeps waiting. The terminal branch of
`Reconciler.reconcileOne` passed that coerced status to `postTerminalIncident`, which treats PENDING as
contradicting evidence: `CONTRADICTION` after PAID/REFUNDED and `POST_FAILED_EVIDENCE` after FAILED/WITHDRAWN.
`openIncident` then writes an append-only `trade_freezes` row with no unfreeze path. One RPC timeout during the
post-terminal watch window therefore froze the trade permanently and wrote a false incident.

## Reproduction (red)

Test written first: `packages/journal/test/m26-unavailable-contract-read.test.ts` (real Reconciler, real
`gatherFacts`/`decide`, real Journal and migrations, the simulated chain over the real JSON-RPC client; one
escrow view call is made to throw `UPSTREAM_TIMEOUT`).

```
npx vitest run packages/journal/test/m26-unavailable-contract-read.test.ts    # on main 49fbaf7 code
exit 1 — Tests 4 failed (4)
  × PAID release: one failed release view opens no incident and no freeze     expected [ {…} ] to deeply equal []
  × FAILED release: one failed release view is not POST_FAILED_EVIDENCE       "contract PENDING after FAILED (EXPIRED_NOT_INCLUDED)"
  × REFUNDED refund: one failed refunds view opens no incident                expected [ {…} ] to deeply equal []
  × postTerminalIncident treats an unavailable contract read as no evidence   expected { kind: 'CONTRADICTION' } to be null
```

## Fix

- `GatheredFacts` gains `contractAvailable` (false when the contract read failed). `contract` keeps its
  "PENDING" (keep waiting) value for the live decision path, which is unchanged.
- `postTerminalIncident` accepts `contract: null` for an unavailable read: only the receipt history is judged
  (contradictory receipts, or a CONFIRMED receipt after FAILED, still open incidents); no contract-status rule
  fires.
- The terminal branch of `Reconciler.reconcileOne` passes `null` when `contractAvailable` is false and, as
  before, reschedules the watch check.

Authoritative evidence is unaffected: the same test file shows a real late execution after FAILED still opens
`POST_FAILED_EVIDENCE`, and an authoritative PENDING read still opens the incident.

## Verification (green)

| Command | Exit | Result |
|---|---|---|
| `npx vitest run packages/journal/test/m26-unavailable-contract-read.test.ts` | 0 | 4 passed |
| `npx vitest run packages/journal` | 0 | 7 files, 53 tests passed (existing post-FAILED incident test unchanged) |
| `pnpm run check` (format, lint, typecheck, build, contract build, all vitest suites, secret scan) | 0 | 56 files passed, 1 skipped; 590 tests passed, 3 skipped; secret-scan clean |
| `pnpm run contract:test` | 0 | 103 passed, 0 failed |

After merging main (`9d0a680`, sibling m28 asset-recovery fix) the suite was rerun: `pnpm run check` exit 0
(57 files passed, 1 skipped; 591 tests passed, 3 skipped; secret-scan clean) and `pnpm run contract:test` exit 0
(103 passed).

Web e2e and sandbox suites were not touched by this change and were not run.
