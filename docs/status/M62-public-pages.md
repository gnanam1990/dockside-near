# M62 — Public proof site redesign

- Status: **implemented, tested, merged locally. Not published**: nothing was pushed; the pages go live with the
  next GitHub Pages publish of `site/proof` (M46 owner step) and the next hosted deploy (M55 owner step).
- Branch: `feat/dockside-m62-public-pages-redesign`, base main `74cafa5`, main `098717a` (M60) merged in before the
  final runs. Decision record: [ADR-0031](../adr/0031-public-proof-site-redesign.md). `docs/spec/` is unchanged.
- **No transaction was sent** and no account, key or credential was used. Browser runs answered RPC from the
  committed recordings (`fixtures/proof/`, `fixtures/attack/`). The contract, verifiers, RPC reads, routes and the
  product claim level are unchanged.

## What changed

| Piece | Where | Change |
|---|---|---|
| Proof page | `site/proof/index.html`, `app.mjs` | Letterhead masthead with site navigation; hero with the attack console as the primary action; verdict seal band (icon, title, block/time/request sentence, "Read again"); check map (one mark per check, grouped by section, each a link); numbered sections with pass tallies; journeys as step lists; receipt links as buttons. |
| Attack console | `site/proof/attack/index.html`, `attack.mjs`, `attack.css` | The payment as a vault (verdict, amount held and attempt counter read from NEAR, facts, demo-start vs now ledger) beside five numbered exhibits; each attempt ends in a stamped outcome with the contract's own code; live or replay mode with its icon. |
| Receipt | `site/proof/receipt.html`, `receipt.mjs` | Same verdict band with Print and Verify again; the receipt as a document: header strip, large amount, facts grid, QR; receipt index as a list of trade links. Print output unchanged in content. |
| Shared | `site/proof/lib/ui.mjs`, `lib/icons.mjs`, `proof.css` | Element builder, icon-led badges, site navigation; one icon family (Lucide geometry, ISC); tokens per UI-SPEC with dark mode; motion tokens. |
| Fonts | `site/proof/fonts/` | IBM Plex Sans 400/500/600 and Mono 400/500, latin, woff2 (SIL OFL 1.1, `OFL.txt`), about 100 KB. |
| Policy | three pages' meta CSP, `services/hosted/src/front.ts` `PROOF_CSP`, `scripts/proof/serve.mjs` | `font-src 'self'` added; the static server types `.woff2`. Nothing else in the policy changed. |

Unchanged: every `data-*` hook, role, label and sentence the suites assert; the HTML reference lists the unit tests
pin; the receipt's print behaviour.

## Commands and results

Windows host, Node 22.23.1, pnpm 10.34.9. Ports 9311–9319 only.

| Command | Exit | Result |
|---|---|---|
| `pnpm run check` (final tree) | 0 | format, lint, typecheck, 892 tests passed (14 skipped), secret scan clean |
| `pnpm run proof:e2e --workers=1` with `DOCKSIDE_E2E_*_PORT` 9311–9315 | 0 | 22 of 22, including axe WCAG 2.2 AA and no body overflow at 375/768/1024/1440, light and dark |
| Rendered review (Playwright, device scale 2, 1440 and 390, light and dark), four iterations | — | fixes: exhibit layout, wrapped link icons, single-row tabs, refusal header, table column widths, receipt list, two narrow-screen overflows |
| Collector audit at 1440/768/390/320, normal and reduced motion, four pages | — | no failures on the final tree |
| Reduced-motion check | — | normal: 180 ms arrival and stamp transforms, 120 ms colour feedback, nothing running after settle; reduced: no animations |

Two earlier full `check` runs each had one API suite (`m07-t003` and `m09-t045`, both untouched) time out while
the machine was under parallel browser load; both pass alone and the final full run was green.

## Limits

- The collector audits the initial reading state of each page; the rendered results were reviewed from the
  harness screenshots and by the browser suite.
- The proof page's all-pass state needs the contract download, which the recording does not hold; screenshots of
  the proof page therefore show the recorded run with that one row unreadable (as the suite does).
- The attack console screenshots use the recorded sandbox run; the committed testnet demo config is still
  `NOT_SET_UP`, so the published page shows "The demo trade has not been created yet" until the operator creates it.
- Automated accessibility checks only; no manual screen-reader pass in this module.
