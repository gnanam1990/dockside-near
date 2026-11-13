# M62 — web app redesign (trade-document visual system)

- Status: **implemented; `pnpm run check` and every web Playwright suite green on this branch** (see Validation).
- Branch: `feat/dockside-m62-web-redesign`. Decision record: ADR-0032 (extends ADR-0026).
- Surface: `apps/web` only. `docs/spec/` is unchanged; README is not touched by this milestone.
- No route, API call, label, role, `data-testid` or asserted text changed. No dependency added; fonts and icons stay
  self-hosted under the existing content security policy. No transaction was sent to testnet or mainnet.

## What changed

| Area | Before | After |
|---|---|---|
| Navigation | white side list | navy harbour rail (both schemes); navy header band on phones/tablets |
| Brand | generic ship icon | drawn mark (containers on the quay) + "Trade escrow" tag |
| Context bar | one wrapping line | manifest strip of ruled cells; one row from 1366 px, two rows 1024-1365 px, 2-column grid on phones |
| Screen titles | heading + paragraph | document head closed by a double ink rule |
| Trade header | run-on sentence of identifiers | milestone description + ruled identity strip (reference, amount, revision, contract, release intent, synced) |
| Labelled facts | loose label/value pairs | ruled ledger boxes, small-caps labels |
| Sections | underline tabs | index tabs joined to their sheet (trade and organization) |
| Compact statuses | tinted chip | tinted stamp with a thin status-colour rule |
| Signing blocks / advisory | same box as everything | navy left rule for key use; dashed border for advisory analysis |
| Sign-in | five equal cards | lead column (create organization, accept invitation) + aside opening with "What the escrow enforces" |
| Trades on phones | horizontally scrolled table | labelled record cards with explicit table roles |
| Motion | colour transitions | + 180 ms opacity settle on navigation; all durations 0 under reduced motion |

Files: `apps/web/src/styles/tokens.css`, `apps/web/src/styles/app.css`, `apps/web/src/components/AppShell.tsx`
(brand, enter phase, `PageHeader` `facts`), `apps/web/src/components/Icon.tsx` (`BrandMark`),
`apps/web/src/screens/SignIn.tsx` (layout + enforcement panel), `apps/web/src/screens/Trades.tsx` (card roles and
labels), `apps/web/src/screens/TradeWorkspace.tsx` (identity strip), `apps/web/test/tokens.test.ts` (rail and ink
contrast checks).

## Validation

- `pnpm run check` (format, lint, typecheck, 896 unit tests including the token contrast suite, secret scan): pass.
- `pnpm run web:e2e` — default, asset-recovery, refund-reasons, clock and cash-out Playwright configs, run against the
  real local stack (simulated chain): pass. These include axe with WCAG 2.2 AA tags on every route signed out and
  signed in at 375/768/1024/1440 px, body-overflow checks at the same widths and at 720 px (200 % zoom), the dark
  scheme suite, reduced motion (transitions 0 s) and the keyboard skip link.
- Rendered review: every main screen captured with a real trade driven through the UI (created, countersigned,
  funded, evidenced, attested, inspected PASS, release approved) at 1440 and 390 px, light and dark, device scale
  factor 2. Two rounds of fixes came from inspecting those captures (header cells crowding between 1024 and 1440 px
  and the network label overflowing its cell; brand tag clipped in the 240 px rail; phone record cards with ragged
  rules and a squeezed caption; missing space between a tab's promise line and its first section and after tables;
  phone identity strip stacking six rows).

## Not covered

- Manual screen-reader passes (NVDA, VoiceOver) were not run for this milestone; automated axe checks only.
- Safari/WebKit was not run; the suites are Chromium-only, as before.
