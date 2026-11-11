# apps/web — Dockside operations UI (M08a shell)

React + Vite single-page app implementing the UI-SPEC shell against the typed control API.
Decisions: [ADR-0008](../../docs/adr/0008-web-ui-shell.md). Status and remaining wiring: [docs/status/M08.md](../../docs/status/M08.md).

## Run locally

```sh
pnpm install
pnpm run build                         # backend packages (services/api/dist)
DOCKSIDE_DB_PATH=.data/dev.sqlite DOCKSIDE_ORIGIN=http://127.0.0.1:5173 DOCKSIDE_PORT=8787 pnpm run api
pnpm --filter @dockside/web run dev    # http://127.0.0.1:5173, proxies /v1, /healthz, /readyz to :8787
```

`DOCKSIDE_ORIGIN` must equal the web origin: every request proof binds it. Override the API target with
`DOCKSIDE_API_URL`. Production build: `pnpm run web:build`, served with `vite preview` (strict CSP headers).

## Tests

- Unit and real-API client tests run in the root suite: `pnpm test` (`apps/web/test`).
- Browser tests (Playwright + axe, real API + production build): `pnpm run web:e2e`.
  Uses ports 8791/4391 (`DOCKSIDE_E2E_API_PORT`, `DOCKSIDE_E2E_WEB_PORT`) and the locally installed Chromium
  headless shell when Playwright's own build is absent (`PLAYWRIGHT_CHROMIUM_PATH` overrides).

## Layout

```text
src/lib/canonical.ts      browser DCE-1 encoder (byte-identical to fixtures/canonical-vectors.json)
src/lib/keys.ts           non-extractable WebCrypto Ed25519 device keys in IndexedDB
src/lib/api/              typed client, endpoint catalog (implemented vs planned), wire types
src/lib/status.ts         per-dimension status vocabulary (no derived state)
src/app/                  router, app context (session, connection freshness, mutation gate)
src/components/           shell, context bar, status badge, states, money/address, forms, dialog
src/screens/              sign-in, trades, create trade, trade workspace, inspections, payouts, audit, organization
e2e/                      Playwright specs
```
