# apps/web — Dockside operations UI (M08)

React + Vite single-page app implementing UI-SPEC against the typed control API, every trade workflow driven by
real backend state. Decisions: [ADR-0008](../../docs/adr/0008-web-ui-shell.md) (shell),
[ADR-0010](../../docs/adr/0010-product-ui-wiring-and-local-stack.md) (trade wiring, local stack). Status:
[docs/status/M08.md](../../docs/status/M08.md).

## Run locally

```sh
pnpm install
pnpm run build                         # backend packages (services/api/dist)
DOCKSIDE_DB_PATH=.data/dev.sqlite DOCKSIDE_ORIGIN=http://127.0.0.1:5173 DOCKSIDE_PORT=8787 pnpm run api
pnpm --filter @dockside/web run dev    # http://127.0.0.1:5173, proxies /v1, /healthz, /readyz to :8787
```

`DOCKSIDE_ORIGIN` must equal the web origin: every request proof binds it. Override the API target with
`DOCKSIDE_API_URL`. Production build: `pnpm run web:build`, served with `vite preview` (strict CSP headers).

To use the trade screens locally, run the [local stack](../../scripts/local-stack/README.md) (real API and trade
modules over a simulated NEAR chain) and set `DOCKSIDE_RELAYER_URL` so `/relay` is proxied to its relayer.

## Tests

- Unit and real-API client tests run in the root suite: `pnpm test` (`apps/web/test`).
- Browser tests (Playwright + axe, local stack + production build): `pnpm run build && pnpm run contract:build &&
  pnpm run web:e2e`. `e2e/product.spec.ts` drives the product path with four independently enrolled browser
  sessions; `e2e/shell.spec.ts` covers every route signed in and out. Ports 8791/8792/4391
  (`DOCKSIDE_E2E_API_PORT`, `DOCKSIDE_E2E_CONTROL_PORT`, `DOCKSIDE_E2E_WEB_PORT`); the locally installed Chromium
  headless shell is used when Playwright's own build is absent (`PLAYWRIGHT_CHROMIUM_PATH` overrides).

## Layout

```text
src/lib/canonical.ts      browser DCE-1 encoder (byte-identical to fixtures/canonical-vectors.json)
src/lib/keys.ts           non-extractable WebCrypto Ed25519 device keys in IndexedDB
src/lib/api/              typed client, endpoint catalog (checked against the router), trade wire types, relayer
src/lib/signing.ts        browser digest recomputation and explicit signing for every server-prepared payload
src/lib/status.ts         per-dimension status vocabulary (no derived state)
src/app/                  router, app context (session, connection freshness, mutation gate)
src/components/           shell, context bar, status badge, states, money/address, forms, dialog
src/components/SignedAction.tsx  prepare → review → sign → record → relay flow used by every signed action
src/screens/              sign-in, trades, create/countersign trade, trade workspace, inspections, payouts, audit, organization
src/screens/trade/        workspace tabs: evidence (slots, upload, attestation, holds, inspector), release (intent,
                          approval, execute, cancel, abandon) and shared helpers
e2e/                      Playwright specs
```
