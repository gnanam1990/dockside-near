# ADR-0031 — Web app redesign: the trade-document visual system

- Decision status: accepted
- Date: 2026-11-13, Dockside platform team
- Affected IDs: UI-SPEC §1 (experience principle), §4 (design system), §5 (responsive), §6 (accessibility), §7 (motion)
- Relates to: ADR-0008 (web UI shell), ADR-0026 (visual design system), which this extends and does not reverse

## Context

ADR-0026 made the web app correct and calm, but it still looked like any tidy admin template: white boxes, a white
side navigation, facts as loose label/value pairs, and a long sentence of identifiers under each trade title. A
judge watching a demo, or a buyer opening a trade for the first time, could not tell from the screen that this is a
product about trade documents and money held in escrow. UI-SPEC still wins: light-first Minimal Swiss, navy as the
only brand colour, flat surfaces, 1 px borders, radius at most 12 px, no gradients, glass, glow, decorative charts,
fake data or marketing copy inside workflows, and motion limited to 120-200 ms opacity/colour feedback.

The design workflow compared three compositions:

1. **Operations console, dark-first** — dense, monospaced, dark canvas. Rejected: UI-SPEC §4 is light-first and
   forbids treating dark mode as the brand.
2. **Card dashboard** — KPI tiles over the trade list. Rejected: UI-SPEC §1 forbids oversized metric cards and any
   number not served by the API; there is no honest aggregate to show.
3. **Trade document** — the screen reads like the paperwork the product protects (bill of lading, commercial
   invoice): ruled field boxes, a document head, an index of sections. Chosen: it is specific to the subject, uses
   only typography, rules and the existing palette, and makes dense facts easier to scan rather than harder.

The open-source UI UX Pro Max dataset (product, style and typography tables) again points B2B service, banking and
logistics products to Minimal Swiss with a navy trust colour and the IBM Plex "Financial Trust" pairing, which
matches the spec. Its generic fintech/crypto row (glassmorphism, dark OLED, vibrant accents) is the style UI-SPEC
§1 forbids. The Motion library was evaluated for screen transitions and not adopted (see Motion below).

## Decisions

1. **Navy harbour rail.** Primary navigation sits on a navy rail (`--rail-*` tokens) in both schemes; the current
   destination is the selected fill plus a 3 px light-navy rule and a semibold label (never colour alone). On phones
   and tablets the same navy forms the header band; the five-destination bottom navigation is unchanged. The brand
   is a drawn mark (two containers on the quay, a third lifted) in the icon family's 1.75 px stroke, plus the word
   "Dockside" and the tag "Trade escrow".
2. **Manifest strip.** The context bar (organization, network, role, API, last sync) is a strip of ruled cells,
   label above value. 1366 px and wider: one header row (brand, strip, session). 1024-1365 px: the brand cell spans
   two rows and the strip sits under the session action. Below 1024 px: the strip is a two-column grid under the
   navy band.
3. **Document head.** Every screen title closes with a 3 px double rule in document ink (`--ink-rule`). A trade's
   identifiers move out of the run-on description into an identity strip of ruled cells (trade reference, amount,
   revision, escrow contract, release intent, synced) with the milestone as the description.
4. **Ledger boxes.** Labelled facts (`dl.identity`, used on every screen) render as ruled boxes, label in small caps
   above the value; signed payloads render as a ruled two-column ledger. Table heads use small caps over an ink
   rule. Panels gain a 2 px navy top rule; signing blocks (`.action`) a 3 px navy left rule; advisory analysis a
   dashed border, so "this needs your key" and "this cannot move money" look different at a glance.
5. **Index tabs.** Trade and organization section navigation are index tabs joined to the sheet below them.
6. **Inspection stamps.** Compact statuses keep icon + label + tint and gain a thin rule in the status colour
   (`color-mix`, no new literals). Full statuses are unchanged (icon, label, sentence, source, time).
7. **Sign-in.** The two first actions (create an organization, accept an invitation) lead in the wider column; the
   other column opens with "What the escrow enforces": three factual rules from the spec (fixed payout account and
   destination-change revision/consent/delay, no release before attested evidence and inspector PASS, refunds to the
   original funder from the exact source bucket). No claims, numbers or testimonials.
8. **Trades on phones.** Below 768 px each trade row restyles as a labelled record card. The table keeps explicit
   `table/rowgroup/row/columnheader/cell` roles so the relationships survive the display change in every browser.
9. **Motion.** CSS only. A screen settles in with an 180 ms opacity step on navigation (alternating identical
   keyframes, so the screen is not remounted and no state is lost); hover, current-tab and navigation changes use the
   existing 120-160 ms colour transitions. No movement, no height/width animation, no loops. Every duration is a
   token that `prefers-reduced-motion` sets to 0, and the enter animation is removed there. The Motion library
   (MIT) was not added: the spec allows only opacity/colour feedback, which CSS covers with no bundle cost.
10. **Tokens.** New tokens live in `tokens.css` only, each with a dark value: `--rail-bg|hover|selected|border|text|
    text-muted|accent|focus`, `--ink-rule`, `--text-3xl` (30 px desktop title), `--duration-enter`,
    `--header-height`; panel radius 8 px. `test/tokens.test.ts` now also checks rail text on every rail fill
    (>= 4.5:1), rail focus and accent (>= 3:1) and the ink rule on canvas and panel (>= 3:1), in both schemes.
11. **Behaviour untouched.** No route, API call, label, role, test id or asserted text changed. No dependency was
    added; fonts and icons stay self-hosted (`font-src 'self'`).

## Consequences

Every main screen was rendered with the real local stack (a trade created, funded, evidenced, inspected and approved
through the UI) at 1440 and 390 px in light and dark, reviewed, and adjusted twice (header cell sizing between 1024
and 1440 px, brand lock-up, phone card layout, section spacing). `pnpm run check` and every web Playwright suite
(axe WCAG 2.2 AA tags, body-overflow checks at 375/768/1024/1440 and 720 px, dark scheme, reduced motion) pass.
Future components use the ledger box, stamp and rail treatments above instead of new box styles.
