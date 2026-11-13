# ADR-0026 — Visual design system and UI polish

- Decision status: accepted
- Date: 2026-11-13, Dockside platform team
- Affected IDs: UI-SPEC §4 (design system), §5 (responsive), §6 (accessibility), §7 (motion)
- Relates to: ADR-0008 (web UI shell), ADR-0010 (product UI wiring)

## Context

The web app already followed UI-SPEC structurally (semantic tokens, IBM Plex, lucide icons, AA-checked pairs), but
it read as an unstyled prototype: the mobile menu toggle rendered on desktop (`.btn` overrode `.nav-toggle`), the
context bar wrapped into a second ragged row at 1440 px, sections inside a panel ran into each other with no
rhythm, tables broke amounts mid-word, every status had the same visual weight, and callouts were white boxes with
a coloured edge. Judges and first-time operators see this before they read a single fact.

We checked the direction against the open-source UI UX Pro Max guideline dataset (product, style, colour and
typography tables plus its pre-delivery checklist). Its rows for B2B service, banking/traditional finance,
e-signature/document workflow and legal case management all recommend **Minimalism & Swiss Style + Accessible &
Ethical**, a navy trust colour (`#1E3A5F` appears verbatim) and the **IBM Plex Sans "Financial Trust"** pairing. Its
generic Fintech/Crypto row recommends glassmorphism, dark OLED and vibrant accents; UI-SPEC §1 forbids exactly that,
and the spec wins.

## Decisions

1. **Direction: light-first Minimal Swiss operations.** Flat surfaces, 1 px borders, one restrained elevation step
   for panels and one for overlays, 4/8 px spacing, radius 4/8/10 px (spec maximum 12). No gradients, blur, glow,
   decorative art or emoji. Navy is the only brand colour; status colours appear only on status.
2. **Tokens, all in `tokens.css`** (raw colour literals stay banned elsewhere by `test/tokens.test.ts`):
   - colour: the spec's palette unchanged, plus `surface-hover`, `surface-selected`, `border-subtle` and quiet
     status tints (`tint-positive|warning|negative|unknown|neutral`) for callouts and compact badges, each with a
     dark-scheme value;
   - type scale 12/13/14/16/18/20/28 px with weights 400/500/600 (500 added from the bundled Plex package);
   - spacing `space-1…6` (+ `space-1-5` = 12 px), radius, `shadow-panel|control|overlay`, z-index layers
     (`z-sticky`, `z-nav`, `z-overlay`, `z-skip`), motion (`duration`, `duration-fast`, `ease-out`) and control
     heights (44 px on coarse pointers, 40/32 px on precise pointers; WCAG 2.2 minimum is 24 px).
   The contrast test now also checks every status, body and link colour on every tint, and text on the hover and
   selected surfaces, in both schemes (≥ 4.5:1).
3. **Fonts stay self-hosted** through `@fontsource` because the preview server sends `font-src 'self'`; no font CDN.
   Mono is used only for identifiers, digests, amounts and timestamps, with tabular figures.
4. **Shell.** Brand row (mark tile, product name, session action) above a full-width context strip with overline
   labels (organization, network, role, API status, last sync). The strip never competes with actions for width and
   becomes a two-column grid on phones. Side navigation: muted items, selected item on `surface-selected` with a
   3 px navy rule; bottom navigation keeps five destinations on phones.
5. **Content rhythm.** A heading that follows content opens a block (`space-4`); sections inside one panel are
   divided by hairlines instead of nested boxes; labelled facts use a reflowing grid with 13 px labels.
6. **Data display.** Tables: subtle header band, 13 px header labels, row hover, amounts never wrap inside a
   scrolling table. Compact statuses (icon + label, no sentence) render as a quiet tinted badge; full statuses keep
   icon, label, sentence, source and time. Colour never carries meaning alone.
7. **States.** Callouts carry a tone tint and 3 px rule; the error summary uses the negative tint; skeletons are
   static shapes (no shimmer loops, UI-SPEC §7).
8. **Motion.** Only colour/opacity transitions of 120–160 ms; dialogs appear without animation so their content is never measured or read mid-fade. Every duration is a token that
   `prefers-reduced-motion` sets to 0.
9. **Behaviour is untouched.** Only `tokens.css`, `app.css` and one font-weight import changed; no route, text,
   role, label or test id moved.

## Pre-delivery checklist (from the guideline set, web-adapted)

- Icons: one family (lucide), one stroke, decorative icons `aria-hidden`; no emoji.
- Contrast: every token pair ≥ 4.5:1 (text) or ≥ 3:1 (controls, focus) in light and dark, verified by unit test and
  axe in the browser suites (including the dark-scheme suite).
- Focus: 2 px ring with 2 px offset on every control; skip link first; sticky elements do not cover focus.
- Targets: 44 px on touch, 40 px on precise pointers; 8 px minimum gap between adjacent controls.
- Layout: 375/390, 720 (200 % zoom), 768, 1024, 1440 px checked; no body-level horizontal scroll; prose ≤ 72ch.
- Motion: reduced-motion removes all transitions (asserted by the shell suite).

## Consequences

Before/after screenshots of every main screen at 1440 and 390 px were reviewed against the checklist. Future
components must use the tokens above; adding a colour means adding a token and its contrast checks.
