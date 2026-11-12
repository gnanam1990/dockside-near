# SEC m30: masked audit export destination leak and invitation secret in the idempotency store

- Source: external security audit. One confirmed finding (low) and one needs-validation lead. Both were
  treated as unverified claims and reproduced on the real code before any change.
- Branch: `feat/dockside-m30-export-masking-and-idempotency-secret`, base main `49fbaf7`.
- Spec: SECURITY.md (secret leakage through exports or storage; one-time scoped invitations), ADR-0003
  (invitation secrets are returned once and stored only as SHA-256), ADR-0009 items 7 (Idempotency-Key)
  and 9 (masked exports). The sealed spec under `docs/spec/` was not edited.

| Item | Verdict |
| --- | --- |
| Finding 6: masked audit export leaks proposed, revoked and unbound payout destinations | confirmed, fixed |
| Lead: plaintext invitation secret persisted in `idempotency_keys` | confirmed, fixed |

## 1. Masked audit export leaked destination-change targets

### The issue

`GET /v1/trades/:id/audit-export` and `/signed-audit-export` default to `destinations=MASKED`: party, funder
and payout-destination account ids are replaced by `acct_<sha256 prefix>`, and only the trade's parties and
their organisations' security admins may ask for full ids. `buildAuditExport` (`services/api/src/export.ts`)
built the mask set only from API-side records (bound revision terms, operations, ledger funders, intent
slices). The embedded contract release view (`chain.release`) also names
`pendingDestinationChange.toDestination` and `destinationHistory[].toDestination`. A destination that was
proposed, consented, revoked, expired or activated but not yet bound (`POST /destination-binding`) exists in
no API-side record, so it went out in clear to auditors and third-organisation inspectors, including in the
signed export whose statement attests `destinations=MASKED`.

### Fix

`buildAuditExport` now also adds every account named by the embedded contract views to the mask set
(`chainAccounts`): trade view buyer, supplier and payout destination; release view payout destination,
intent destinations and slice funders, and `fromDestination`/`toDestination` of the pending change and every
historical change; ledger funders and deposit funders; refund funders. The escrow contract id stays
unmasked as before. FULL exports are unchanged.

## 2. Invitation secret stored in the Idempotency-Key replay store

### The issue

`POST /v1/invitations` returns the one-time invitation secret; the authority service stores only its
SHA-256. When the caller sends the optional `Idempotency-Key` header, `idempotent()`
(`services/api/src/app.ts`) wrote the whole handler result, secret included, to
`idempotency_keys.response_json`, and completed rows are never deleted. Anyone able to read the database,
WAL, a replica or a backup could take a still-PENDING secret and accept the invitation.

### Fix

`Route` gains `oneTimeFields` (`services/api/src/routing.ts`); `POST /v1/invitations` declares
`["secret"]`. `idempotent()` returns the full result to the first caller but stores the result without those
fields. An exact replay still returns `Idempotent-Replay: true` with the same `invitationId` and creates no
second invitation, but carries no secret: it is returned once (ADR-0003). Reservation, conflict and
failure behaviour (ADR-0009 item 7) is unchanged, and every other route replays its full stored response.
No other authenticated POST returns a secret; sessions are issued only by unauthenticated routes, which never
reach `idempotent()`.

Residual for existing deployments (owner action): rows written before this fix may still hold a secret.
Count them with `SELECT count(*) FROM idempotency_keys WHERE scope LIKE 'api:%:POST /v1/invitations'` (do not
print `response_json`) and delete them or revoke the listed invitations. Retention for completed idempotency
rows in general is not added here.

## Reproduction (red, before the fix)

Tests written first, over the real HTTP API (`createApp`, PoP sessions, real authority and SQLite store, the
compiled escrow wasm on the simulated NEAR host):
`services/api/test/sec-m30-export-masking.test.ts`, `services/api/test/sec-m30-idempotency-secret.test.ts`.

```
npx vitest run services/api/test/sec-m30-export-masking.test.ts services/api/test/sec-m30-idempotency-secret.test.ts
# on the 49fbaf7 source
exit 1 - Tests 3 failed | 1 passed (4)
  x a proposed and then revoked unilateral destination is masked
      expected '{"schema":"dockside/audit-export@1",...' not to contain 'harbor-redirect.testnet'
  x an activated but not yet bound destination is masked; full export for a party keeps it
      (cascade: the first test stopped before revoking, so the next proposal is DESTINATION_CHANGE_PENDING)
  x an idempotent invitation returns the secret once, stores none, and a replay creates nothing
      expected [ 'idempotency_keys' ] to deeply equal []
  ok other idempotent POSTs still replay their full stored response
```

## After the fix (green)

```
npx vitest run services/api/test/sec-m30-export-masking.test.ts services/api/test/sec-m30-idempotency-secret.test.ts
exit 0 - Tests 4 passed (4)
```

## Full suite

Before merging main (branch on `49fbaf7`):

```
pnpm run check           exit 0 - Test Files 57 passed | 1 skipped (58); Tests 590 passed | 3 skipped (593); secret-scan clean
pnpm run contract:test   exit 0 - 103 passed, 0 failed
```

After `git merge main` (main at `628c845`, merge `30ab2c6`, no conflicts):

```
pnpm run check           exit 0 - Test Files 60 passed | 1 skipped (61); Tests 598 passed | 3 skipped (601); secret-scan clean
pnpm run contract:test   exit 0 - 103 passed, 0 failed
```

Web e2e and sandbox suites were not run: no web, contract or sandbox code was touched. No ADR was added.
