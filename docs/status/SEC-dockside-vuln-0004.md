# SEC vuln-0004 — request-limiter table exhaustion by invented session tokens

- Source: external automated scan, finding vuln-0004 (MEDIUM, CWE-770). Treated as an unverified claim and
  reproduced independently on the real code before any change.
- Verdict: **confirmed, fixed**.
- Branch: `feat/dockside-m23-limiter-table-exhaustion`, base main `2293bc5`.
- Spec: SECURITY.md requires rate limits; the sealed spec under `docs/spec/` was not edited.

## The issue

`createApp` (`services/api/src/app.ts`) charged `limiter.take(sessionKey(token), sessionLimit)` for every
authenticated route that carried a `Dockside-Session` header **before** the token was validated. Each distinct
invented token therefore allocated a fresh 60-second window in `RateLimiter`, whose table is capped at 50,000 keys
and refuses new keys when full (fail closed). The per-address counter was only charged in the `catch` after
`authority.authenticate` had already run, so every invented token also cost a session lookup and an `AUTH_DENIED`
audit row, without bound.

Consequence: one client sending about 50,000 invented tokens per minute kept the table full, and every new client
address and every new session received `RATE_LIMITED` (HTTP 429).

## Reproduction (red)

Test written first: `services/api/test/sec-vuln-0004-limiter-exhaustion.test.ts` (real `createApp`, real
authority service and SQLite store, real HTTP server on an ephemeral loopback port; a small `maxKeys` stands in
for the 50,000 default).

```
npx vitest run services/api/test/sec-vuln-0004-limiter-exhaustion.test.ts     # on main 2293bc5 code
exit 1 — Tests 3 failed (3)
  × does not allocate a limiter window per invented session token
      expected 41 to be less than or equal to 1        (40 invented tokens -> 40 session windows + 1 address)
  × keeps new clients and new sessions served while invented tokens flood in
      expected 429 to be 200                           (a real session from another address refused)
  × refuses further invented tokens before authentication once the address budget is spent
      expected 20 to be less than or equal to 3        (every invented token wrote an AUTH_DENIED row)
```

## Fix

- `RateLimiter` (`services/api/src/limits.ts`) gains `has(key)` and `check(key, limit)`: both read a live window
  and never count or allocate.
- In `createApp`, for an authenticated route with a presented token, nothing is allocated before authentication:
  - if the token's session window is live (it authenticated earlier in this window), it is checked against its
    own window, so established sessions are unaffected by their address's budget (shared NAT);
  - otherwise the request is checked against its address's budget, so an address that has spent its budget on
    failures is refused **before** the session lookup and the `AUTH_DENIED` audit write.
- A failed authentication still counts against the address (as before). A successful one then takes the session
  window, so session windows exist only for real sessions.
- Unauthenticated routes and health probes are unchanged. The fail-closed table policy is unchanged; it can now
  only be filled by distinct client addresses (one key each), not by invented tokens.

Effect: invented tokens cost at most `DOCKSIDE_RATE_LIMIT_UNAUTH_PER_MIN` authentication attempts and audit rows
per address per minute, and never a limiter key of their own.

## Verification (green)

| Command | Exit | Result |
|---|---|---|
| `npx vitest run services/api/test/sec-vuln-0004-limiter-exhaustion.test.ts services/api/test/m09-hardening.test.ts` | 0 | 7 passed (the 3 new tests and the 4 existing M09 limiter tests, unchanged in behavior) |
| `pnpm run check` (format, lint, typecheck, build, contract build, all vitest suites, secret scan) | 0 | 53 files passed, 1 skipped; 574 tests passed, 3 skipped; secret-scan clean |
| `pnpm exec vite build` (apps/web) | 0 | production build |
| `pnpm exec playwright test -c playwright.config.ts` (ports 9030–9032 via `DOCKSIDE_E2E_*_PORT`) | 0 | 51 passed |
| `pnpm exec playwright test -c playwright.assets.config.ts` (ports 9033–9035) | 0 | 3 passed |
| `pnpm exec playwright test -c playwright.reasons.config.ts` (ports 9036–9038) | 0 | 8 passed |
| `pnpm exec playwright test -c playwright.clock.config.ts` (ports 9030–9032, after the first stack stopped) | 0 | 3 passed |

## Residual

- A distributed client with many source addresses can still fill the table with one key per address; that is the
  existing, documented fail-closed choice (an upstream proxy limit remains the deployment control).
