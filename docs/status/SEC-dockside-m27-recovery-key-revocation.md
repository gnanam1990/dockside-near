# SEC m27 — revoking a pending recovery key is final

- Source: external security audit, confirmed finding 3 (LOW),
  `authority/proveRecovery-unguarded-key-status-resurrects-revoked-recovery-key`. Treated as an unverified claim and
  reproduced independently on the real code before any change.
- Verdict: **confirmed, fixed**.
- Branch: `feat/dockside-m27-recovery-key-revocation`, base main `49fbaf7`.
- Spec: TDD.md (roles and keys) says key revocation blocks new authority; REFUND-POLICY.md says a key-loss recovery
  "can be cancelled before activation". The sealed spec under `docs/spec/` was not edited.

## The issue

`startRecovery` stores the administrator-supplied new key as a `PENDING_PROOF` key version and suspends the
principal's usable keys. A second administrator could revoke that pending key (`POST /v1/keys/:id/revoke`) to stop a
suspected rogue recovery. The key became `REVOKED`, but the recovery row stayed `PENDING_PROOF`. Then:

- `proveRecovery` (`packages/authority/src/service.ts`) checked only the recovery status and ran
  `UPDATE key_versions SET status = 'PENDING_ACTIVATION' ... WHERE id = ?`, with no status guard, so the
  revoked key went back into the activation path;
- after the delay, `completeRecovery` activated it (`ACTIVE`, with `revoked_at` still set), revoked the principal's
  suspended keys, and the revoked key logged in as the target with the target's capabilities.

`completeRecovery`'s own activation update was guarded, but it ignored a zero-row result and went on to revoke the
suspended keys and mark the recovery `COMPLETED`.

## Reproduction (red)

Test written first: `packages/authority/test/m27-recovery-key-revocation.test.ts` (real `AuthorityService`, real
SQLite store, manual clock).

```
npx vitest run packages/authority/test/m27-recovery-key-revocation.test.ts     # on main 49fbaf7 code
exit 1 — Tests 3 failed | 1 passed (4)
  × a revoked PENDING_PROOF recovery key cannot be proven, activated or used to log in
      expected 'PENDING_PROOF' to be 'CANCELLED'   (revoking the key left the recovery open)
  × revoking a proven (PENDING_ACTIVATION) recovery key stops completion during the delay
      expected 'WAITING' to be 'CANCELLED'
  × proveRecovery and completeRecovery fail closed when the key left its expected state
      expected 'NO_ERROR' to be 'INVALID_STATE'    (proveRecovery accepted a REVOKED key)
  ✓ an ordinary recovery still completes
```

## Fix

All in `packages/authority/src/service.ts`:

- `proveRecovery` moves the key only `WHERE id = ? AND status = 'PENDING_PROOF'` and fails `INVALID_STATE` unless
  exactly one row changed. This is the same guard that `reissueRecoveryChallenge` and `proveServiceKey` already use.
  The challenge consumption is rolled back with the transaction.
- `completeRecovery` fails `INVALID_STATE` when its guarded activation changes no row, before any suspended key is
  revoked or the recovery is marked `COMPLETED`.
- `revokeKeyTx` closes an open recovery (`PENDING_PROOF` or `WAITING`) whose new key is the one revoked. It uses the
  principal-veto semantics of `cancelRecovery`: suspended prior keys return to their recorded prior status, the
  recovery becomes `CANCELLED`, and a `RECOVERY_CANCELLED` audit event records `reason: RECOVERY_KEY_REVOKED`.
  Without this, the guarded `proveRecovery` would leave the recovery open forever. A new recovery for the principal
  would then be refused, and its keys would stay suspended.

No API, schema, contract or web change. Existing recovery behaviour is unchanged: delay, PoP, principal veto,
challenge re-issue, and separation of duties.

## Verification (green)

```
npx vitest run packages/authority/test/m27-recovery-key-revocation.test.ts     exit 0 — 4 passed (4)
npx vitest run packages/authority                                              exit 0 — 5 files, 42 passed (42)
pnpm run check            exit 0 — format, lint, typecheck, Test Files 56 passed | 1 skipped (57),
                                   Tests 590 passed | 3 skipped (593), secret-scan clean
pnpm run contract:test    exit 0 — 103 passed, 0 failed
```

Web e2e and sandbox suites were not run because no web, API route or contract code changed.
