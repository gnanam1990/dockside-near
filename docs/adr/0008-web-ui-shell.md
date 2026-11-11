# ADR-0008 — Web UI shell: Vite + React SPA, browser-held PoP keys, typed client on the real API

- Decision status: accepted (M08a, UI shell prepared ahead of M04–M07)
- Date and authorship: 2026-11-11, Dockside web team (M08a)
- Affected IDs: M08, UI-SPEC §2–§9, NFR-03, NFR-04, NFR-06, INV-13; prepares T-036, T-037, T-038, T-039, T-040, T-054
- Supersedes: nothing. Relates to TDD.md §2 (proposed Next.js web), ADR-0001 (stack), ADR-0003 (PoP sessions; its flip condition for the browser).

## Context and observed evidence

UI-SPEC requires an enterprise operations UI that only renders authenticated API projections with provenance, never
browser-computed status or seeded data. The running control API (services/api, M01) serves bootstrap, sessions,
invitations, grants, keys, recovery, service enrollment and audit. Trade, evidence, release, payout, refund and
timeline read projections arrive with M03–M07 and are not served yet (`no such endpoint`). Every authenticated
request must carry a `Dockside-Proof` signed by the session key over a DCE-1 `dockside/request-proof` payload
(ADR-0003). Build machine: Windows 11, Node 22.23, Playwright Chromium build 1254 installed, no Docker.

## Options considered

1. **Next.js** (TDD §2 proposal): server components and a Node server add a second runtime between browser and
   API, and server-side rendering would need the session key on the server, which ADR-0003 forbids.
2. **Vite + React SPA**, static build, served from its own origin with a proxy for the API paths.
3. Server-rendered HTML from services/api: mixes UI into the authority process.

## Decision

- **Stack:** React 19.2.9 + Vite 8.3.5 (`@vitejs/plugin-react` 6.1.2), TypeScript strict (same flags as the
  backend, `moduleResolution: bundler`), lucide-react 1.60.0 as the single stroke icon family, IBM Plex Sans/Mono
  bundled locally through `@fontsource` (no third-party font host). All versions pinned exactly and at least two
  weeks old. Small in-house History API router; no state library.
- **Origin model:** the web build is served from its own origin; `/v1`, `/healthz` and `/readyz` are proxied to the
  API, so `DOCKSIDE_ORIGIN` equals the page origin and is bound into every proof. `vite preview` sends a strict CSP
  (`default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'`), no inline
  script/style and no data: assets (`assetsInlineLimit: 0`).
- **Keys (ADR-0003 flip condition resolved):** Chromium's WebCrypto Ed25519 generates a **non-extractable** private
  key (verified by `generates non-extractable device keys` and in the browser). The CryptoKey handle is kept in
  IndexedDB for this origin; the public key is exported in NEAR `ed25519:<base58>` form. No P-256 delegation is
  needed. The session token lives in `sessionStorage` (tab scope) and is useless without the key.
- **Signing safety:** before any challenge signature the browser recomputes the DCE-1 `dockside/pop-challenge`
  digest from the server's typed payload (`apps/web/src/lib/canonical.ts`, byte-identical to
  `fixtures/canonical-vectors.json`) and refuses to sign when digest, origin, purpose, key or subject differ, or the
  challenge expired. Signing always needs an explicit user action after a review of the exact facts.
- **Typed client:** `apps/web/src/lib/api/endpoints.ts` lists every route. `implemented` entries are checked against
  the live router on every test run (`endpoints.test.ts`); `planned` entries (trades, evidence, holds, release,
  payout, refund, timeline, inspections, payouts) are called for real and the backend's `no such endpoint` answer is
  rendered as an explicit "not available in this backend build" state. When a module serves one of them, that test
  fails until the entry flips to `implemented` and the screen renders the real projection.
- **No client authority:** capability lists from `/v1/me` only hide or explain controls; the server decides. Status
  vocabulary tables translate backend values into words and icons per orthogonal dimension; unknown values render as
  "unsupported schema". The client never derives trade, payout, evidence or hold state.
- **Browser tests:** `@playwright/test` 1.64.1 + `@axe-core/playwright` 4.14.0. Playwright 1.64.1 expects Chromium
  build 1248; the config uses the locally installed headless shell (build 1254) when its own build is absent
  (`PLAYWRIGHT_CHROMIUM_PATH` overrides). Tests start the real built API with a fresh SQLite file and the production
  web build.

## Trust/security/privacy impact

Private keys never leave WebCrypto; no secret is logged or persisted except the one-time invitation secret, which is
displayed once to the issuing administrator (as returned by the API) and never stored. Clearing site data loses the
device key; recovery is the administrator-driven delayed recovery of ADR-0003. A malicious page script on the same
origin could ask the key to sign; the CSP and the absence of third-party script keep that surface to this build.

## Migration and rollback

The web app is a separate package (`apps/web`); removing it does not affect the API. Moving to Next.js later only
replaces the shell; the client, canonical encoder, key store and components are framework-agnostic React/TS.

## Verification and flip condition

`pnpm run check` (includes web typecheck and unit tests), `pnpm run web:e2e` (16 browser tests), see
`docs/status/M08.md`. Flip the key decision if a target browser lacks non-extractable Ed25519 WebCrypto (then use a
P-256 session key enrolled by a wallet-signed delegation); flip the proxy model if the API moves to a different
origin (then CORS with an exact allow-list and the API origin bound in proofs).
