# ADR-0031 — Public proof site redesign

- Decision status: accepted (M62)
- Date: 2026-11-13, Dockside platform team (M62)
- Affected IDs: UI-SPEC §4 (design system), §5 (responsive), §6 (accessibility), §7 (motion); amends ADR-0027
  (proof page) and ADR-0029 (attack console) and ADR-0030 (receipt page) in presentation only, and the proof site's
  content security policy (`font-src 'self'`).
- Scope: the static public surface under `site/proof/` — the proof page, the attack console ("Try to steal this
  payment") and the payment receipt. No contract, API, verifier, RPC read, route or claim level changes.

## Context

The proof site is the one surface a hackathon judge or a new user opens without installing anything: a link from a
demo video or a QR code on a receipt. Its incumbent styling was a correct but plain reuse of the product tokens:
system fonts (IBM Plex was named but never shipped, so nobody saw it), no shared navigation between the three pages,
and verdicts, refusals and receipts that all looked like the same grey panel. The content and checks were right;
the hierarchy did not show the reader, in seconds, *what was proven*.

The sealed UI specification still governs this surface: light-first Minimal Swiss, flat surfaces and 1 px borders,
navy as the only brand colour, IBM Plex Sans and Mono bundled locally, status as icon + text + sentence, one SVG icon
family, 120–200 ms feedback motion only, no animated money or status loops, no fake live badges, WCAG 2.2 AA.

## Options considered

1. **Filed audit document (chosen).** A letterhead masthead with a navy rule and a navigation across the three
   pages; the verdict as a seal band carrying the block, time and request count of the read; a *check map* (one mark
   per check, grouped by section, each group a link to its numbered section); numbered register sections. The attack
   console as a case file: the payment ("vault") beside five numbered exhibits, each ending in the contract's refusal
   code shown as a stamped outcome. The receipt as a remittance document: large amount, parties, facts and QR, print
   first.
2. **Terminal transcript of RPC reads.** Rejected: reads as a hacker demo, against the "calm, exact" principle.
3. **KPI cards dashboard.** Rejected: the specification forbids oversized metric cards; it would hide the checks
   behind numbers.

## Decisions

1. **Composition** as option 1. Every number on the pages is still read from NEAR at view time or comes from the
   committed proof manifest; the check map is a picture of the counts printed beside it (hidden from assistive
   technology, the link text carries the numbers), and fail and unreadable marks differ in shape as well as colour.
2. **Fonts.** IBM Plex Sans 400/500/600 and IBM Plex Mono 400/500, latin subset, as woff2 files in
   `site/proof/fonts/` (copied from `@fontsource/ibm-plex-sans` 5.2.8 and `@fontsource/ibm-plex-mono` 5.2.7, already in
   the lockfile; SIL Open Font License 1.1, `fonts/OFL.txt`). `font-display: swap` with system fallbacks. The meta
   policy of the three pages and `PROOF_CSP` of the hosted front gain `font-src 'self'`; nothing else in the policy
   changes and the site still loads nothing from a third party. The local static server serves `.woff2`.
3. **Icons.** The geometry of Lucide (the icon family the web app already uses through `lucide-react` 1.60.0, ISC
   licence, notice kept in the file) copied as data into `site/proof/lib/icons.mjs` and built with DOM calls. Icons
   are decorative (`aria-hidden`); every status they lead is also text.
4. **Shared module.** `site/proof/lib/ui.mjs` holds the element builder, the icon-led badges and the site
   navigation for the three pages (the navigation resolves `/proof/` and `/receipt/` on the hosted app). Chain data
   is still only written as text; no markup strings.
5. **Motion.** A new reading settles with a 180 ms 4 px transform; a refusal stamp with a 180 ms scale from 0.985;
   the attempt counter's frame marks a changed count once. Transform and box-shadow only, so text contrast never
   dips mid-animation. No loops, no animated amounts. Under `prefers-reduced-motion: reduce` every duration token is
   0 and the arrival animations are not defined.
6. **Responsive.** 375–1440 px. On narrow screens the navigation and tabs stay on one row (tabs scroll inside their
   tablist), the vault comes before the exhibits, and check tables scroll inside their own labelled region instead of
   folding a hash into a column of a few characters.
7. **Unchanged on purpose.** Every route, RPC read, verifier, `data-*` hook, role, label and tested sentence; the HTML
   reference lists checked by the unit tests; the print behaviour of the receipt.

## Consequences

- Judges see the same visual language on all three pages, with the verdict and the refusal codes as the strongest
  elements; the rest stays quiet.
- 100 KB of fonts are served by the proof site itself (five woff2 files).
- New check tables or sections on the proof page should use the numbered `section()` and `badge()` helpers so the
  check map and tallies stay consistent.
