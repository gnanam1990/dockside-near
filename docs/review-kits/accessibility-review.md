# Manual accessibility review: screen readers and true 200% zoom

A checklist for an accessibility reviewer who has not worked on Dockside. It covers every screen of the web app
(`apps/web`), maps each check to [UI-SPEC.md](../spec/UI-SPEC.md) and to the test IDs in
[TEST-PLAN.md](../spec/TEST-PLAN.md), and ends with a result template.

## 1. What is already covered and what is missing

Automated browser tests already run axe (WCAG 2.2 AA rule tags) on every route, every trade tab and the later
screens, check keyboard reachability, check for no body-level horizontal overflow at 375, 768, 1024 and 1440 CSS
px, and approximate 200% zoom with a 720 px viewport. They cannot hear a screen reader or use real browser zoom.
The gate therefore records:

| Test | Automated (this build) | Missing, and what this review produces |
|---|---|---|
| T-039 Keyboard and screen reader complete critical flow | PARTIAL: axe and keyboard pass | a manual pass with NVDA and VoiceOver through bootstrap/invite, evidence recovery, hold resolution, destination diff, approval, refund conflict, unknown reconciliation and export |
| T-040 Responsive states remain operable | PARTIAL: four widths and 720 px pass | true browser zoom at 200%, landscape on a phone, long text |
| T-034 Secrets and private evidence are redacted | PASS for DOM and storage | a listening check that no accessible name or announcement reads out a secret |
| T-037, T-038, T-054 | PASS in the browser | a listening check that the states are distinguishable without sight and without colour |

REAL-PRODUCT-GATE item 13 needs both halves for the same build.

## 2. Setup

**Build.** Review the build the owner names: record the commit SHA. Use either the testnet deployment
(USER-NEXT-STEPS §5) or the local stack, which shows the same screens over a simulated chain:

```sh
pnpm install --frozen-lockfile && pnpm run build && pnpm run contract:build
DOCKSIDE_ORIGIN=http://127.0.0.1:4391 pnpm run stack
DOCKSIDE_API_URL=http://127.0.0.1:8791 DOCKSIDE_RELAYER_URL=http://127.0.0.1:8792 \
  pnpm --filter @dockside/web exec vite preview --host 127.0.0.1 --port 4391
```

The [local stack README](../../scripts/local-stack/README.md) explains its loopback control port, which creates
invitations, funds trades and moves the simulated clock so states such as STALE evidence, holds, UNKNOWN and
REVIEW can be reached. Ask the owner for a prepared trade in each state if you do not want to drive the control
port yourself. Several screens need more than one role; use a separate browser profile per role.

**Assistive technology pairs.** At least the first two; the others if available.

| Pair | Platform | Notes |
|---|---|---|
| NVDA (current) with Firefox (current) | Windows | browse and focus mode; elements list (NVDA+F7) for headings, landmarks, links, form fields |
| VoiceOver with Safari | macOS | rotor (VO+U) for headings, landmarks, form controls |
| NVDA with Chrome or Edge | Windows | optional second browser |
| VoiceOver with Safari | iOS, portrait and landscape | optional; covers 375 px and landscape for T-040 |

**Zoom.** "True 200% zoom" means the browser's own page zoom (Ctrl/Cmd and +) set to 200% in a desktop window
about 1280 CSS px wide, so the layout sees about 640 CSS px. Also check: text-only zoom at 200% in Firefox
(View → Zoom → Zoom Text Only); 400% page zoom at 1280 px for WCAG 1.4.10 reflow (320 CSS px), as a stretch
check; a phone in landscape. Dark mode follows the operating system setting; reduced motion follows the
operating system "reduce motion" setting.

Record versions of the screen reader, browser and operating system on the result form.

## 3. Checks that apply to every screen

Run these on each screen in §4. The ID is what you write on the form.

| ID | Check | UI-SPEC | Test |
|---|---|---|---|
| G-1 | The first Tab reaches **Skip to main content**, and it moves focus to the main region | §6 skip link | T-039 |
| G-2 | Landmarks are announced: banner, navigation (**Primary**, and **Primary (compact)** on narrow screens), main; the context bar (**Session context**) is reachable | §6 landmarks, §2 context bar | T-039 |
| G-3 | Headings are sequential (one h1 per screen, no skipped level) and the heading list alone tells you where you are | §6 sequential headings | T-039 |
| G-4 | Tab order follows the visual order; nothing focusable is invisible; nothing is unreachable by keyboard | §6 logical tab order, native controls | T-039 |
| G-5 | The focus indicator is visible on every control, and a sticky header or action bar never hides the focused element | §6 visible focus | T-039, T-040 |
| G-6 | After a navigation (link or route change) focus lands at the new screen's heading or main, and the screen reader says the new page | §6 logical tab order | T-039 |
| G-7 | Every form field has a persistent visible label that is also its accessible name; help text and the inline error are announced with the field | §6 forms, §3.2 | T-039 |
| G-8 | After a failed submit, focus moves to an error summary whose links move to the fields; input is preserved | §3.2, §6 forms | T-039, T-037 |
| G-9 | Every status is announced as text (label plus reason), never only as a colour, icon or position; decorative icons are silent; icon-only controls have a name | §4 status badge, §6 colour, §4 components | T-038 |
| G-10 | Status changes that matter are announced once as a complete phrase through a live region, without a stream of repeated announcements during the 4-second refresh | §6 live regions | T-039 |
| G-11 | Tables have header cells and a caption or label; contained scrollers (**TableScroller**) are reachable and named; timelines have the table equivalent | §6 timelines, §5 tables | T-039 |
| G-12 | Addresses, hashes and IDs are read as full text (not only the masked display); copy buttons confirm the copy in an announcement | §4 address display | T-039 |
| G-13 | Dialogs: focus moves into the dialog, is trapped there, Escape or **Cancel** closes it before any signature, and focus returns to the control that opened it | §6 dialogs | T-039 |
| G-14 | No secret is ever read out: no session token, invitation secret after it was first shown, private key, custody locator or private evidence locator in any accessible name or announcement | §9 no secret in accessibility tree | T-034 |
| G-15 | At 200% page zoom: no horizontal page scroll (only a long address field or a named table scroller may scroll), nothing essential is clipped or truncated, controls do not overlap, sticky regions leave room to work | §5 | T-040 |
| G-16 | At 200% text-only zoom: text is not cut off inside buttons, badges or table cells | §6 text scaling | T-040 |
| G-17 | With reduce motion on, no animation is visible; with it off, only short opacity or colour transitions | §7, §6 | T-040 |
| G-18 | Dark mode: text, borders and focus remain readable (spot-check with a contrast tool on status colours) | §4 tokens | T-040 |
| G-19 | Disconnected or stale data is announced as stale with its age, and mutations are visibly unavailable with a reason (stop the API briefly to see it) | §3.1, §9 freshness | T-038 |

## 4. Screens

Each row lists the route, how to reach it, and checks beyond G-1 to G-19. "Critical" marks the T-039 critical
flow; do those first with both screen readers.

### 4.1 Signed out

| Screen | Route | Specific checks | Critical |
|---|---|---|---|
| Sign in | `/sign-in` | Five panels are separate headed sections: **Create an organization**, **Sign in with a stored device key**, **Lost or suspended key**, **Accept an invitation**, **NEAR wallet signature (NEP-413)**. The **Device key** select names each key by label and public-key prefix. The invitation secret field accepts paste and is not read back after submit. The signature review heading takes focus and reads the exact digest, actor and consequence before **Sign with this device key**. (UI-SPEC §3.10, §6 authentication) | yes: bootstrap/invite |
| Recovery | `/recovery` | Steps **1. Generate a recovery key on this device** and **2. Prove the recovery key** are announced in order; the veto panel (**Veto a recovery you did not ask for**) is distinct; the stored-keys table is named. (§3.10) | |
| Not found | any unknown path, for example `/nowhere` | The screen says the page does not exist and offers a working link back. | |

### 4.2 Signed in: trades

| Screen | Route | Specific checks | Critical |
|---|---|---|---|
| Home | `/` | Lands on the trade list or a clear next step; focus and title are correct. | |
| Trades list | `/trades` | **Filter trades** and **Search** are labelled; the result count changes are announced; each row's status reads as words with a supporting sentence; the empty state explains how a real trade is created (no example rows); **Countersign a proposal** is a link. (§3.1) | |
| Create trade | `/trades/new` | **Trade creation steps** announces "Step n of 5" and the current step (`aria-current`). **Continue** with an empty required field moves focus to the error summary (G-8). The destination warning **Acceptance binds payment to this destination** is announced with the field. The review step reads every material fact; **Request canonical agreement** then **Sign as buyer approver** reads the digest and consequence. (§3.2) | yes |
| Countersign | `/trades/countersign` | **Proposal package from the buyer** accepts paste; **Review proposal** reads the facts; **Sign as supplier signer and submit** is disabled with an announced reason until the review is done. (§3.2) | yes |

### 4.3 Trade workspace (`/trades/<id>/<tab>`)

The header reads reference, supplier, amount, revision, contract, network and state. **Trade sections** is a
navigation landmark; the current tab is announced (`aria-current`). Check that `tradeState`, `payoutState`,
`evidenceState`, provider status and destination receipt are announced as separate items, never one badge (§3.3).

| Tab | Route suffix | Specific checks | Critical |
|---|---|---|---|
| Overview | `/overview` | **State, one dimension at a time** lists each state separately; the next-action panel and blockers link to the exact evidence within four actions (§9); **How funding happens** callout; funding ledger table named. (§3.3) | |
| Agreement | `/agreement` | Facts, **Trade revisions** table. Destination change: current and proposed destinations are read in full and in order, the diff is understandable without sight, consents and the delay countdown read the UTC time as well as relative time, **Invalidations** lists what will stop counting; **Activate destination revision** dialog states the consequence. Key rebinding panel (**Key-rebinding plan**, **Key-rebinding history**) with the same checks. (§3.5) | yes: destination diff |
| Evidence | `/evidence` | Each slot is a headed group with its predicate and recovery action; STALE, missing, wrong scope, wrong attestor and wrong key version are announced as text and never as complete. Upload with the keyboard only: the file input has a name (**File for &lt;slot&gt;**), **Upload to &lt;slot&gt;** reports per-file progress and the result. A replacement conflict announces itself and keeps the user's work. The **Advisory analysis** region reads "This analysis cannot create or clear a payment hold." Hold panel: issuer, reason, expiry; **Request resolution** (buyer) and **Prepare resolution** (risk/policy only) are distinct and announced differently. Inspector: **Prepare inspection** stays disabled with a reason until the manifest is complete; the PASS/FAIL/REVIEW choice is a labelled group. (§3.4) | yes: evidence recovery, hold resolution |
| Release | `/release` | The checklist reads every item with its state and link. **Prepare release intent**, **Prepare approval** and **Sign approval** read the full amount, asset, recipient, network and consequence. **Request cancellation** and **Abandon expired intent** are clearly different flows; after submit, "Exits are closed: value is locked by a submitted operation" is announced and the exit controls are gone. **Execute direct release** opens a dialog (G-13) with **Queue release**. (§3.6) | yes: approval |
| Payout | `/payout` | Sections **Direct testnet release**, optional dry compatibility, funded authorization, execution, destination/refund and reconciliation are separate headed regions. UNKNOWN, REVIEW, RECONCILING and ADJUDICATION read the retained reservation and the prohibited actions; **Request reconciliation** and **Open adjudication** are present, and no "try again" control exists. `PAID` is announced with its evidence, not by colour. Dry status reads "No funds moved; not used for testnet release." (§3.7) | yes: unknown reconciliation |
| Refund | `/refund` | **Deposits**, **Funder buckets**, **Refund policy** and **Refund eligibility** tables are named and readable; a refund blocked by an unresolved release says why; **Authorize refund** and **Execute refund** dialogs state recipient and source bucket. The **Asset recovery review** panel is separate from native refunds and reads the 72-hour challenge time in UTC. (§3.8) | yes: refund conflict |
| Timeline | `/timeline` | **Trade timeline** table has headers; filters announce the hidden-count summary; **Prepare export preview** lists included and redacted categories; **Prepare signed export** and **Save signed export** announce completion; the verdict is separate from generation. (§3.9) | yes: export |

### 4.4 Other top-level screens

| Screen | Route | Specific checks | Critical |
|---|---|---|---|
| Inspections | `/inspections` | The **Inspections** table lists assigned reviews with readable states and links. (§3.4) | |
| Payouts | `/payouts` | **Deployment gates** reads testnet and the blocked mainnet gate as text; **Payout operations** table named; no demo toggle. (§3.7) | |
| Audit | `/audit` | **Filter audit events** labelled; **Actor principal contains** field; **Audit events** table; export section. (§3.9) | |

### 4.5 Organization

| Screen | Route | Specific checks | Critical |
|---|---|---|---|
| Organization | `/organization` | **Organization sections** navigation. **Invite a principal**: the one-time secret panel is announced as shown once, and is not reachable again after leaving. **Grant an accepted invitation** dialog. **Your principal and session** reads capability and expiry. **Device keys in this browser** table. (§3.10) | yes: invite |
| Keys | `/organization/keys` | **Your keys** and **People and their keys** tables; rotation (**Prepare key rotation**, **Sign rotation with the new key**), revocation and recovery dialogs read the impact (**Effect on in-flight trades**). (§3.10) | |
| Service identities | `/organization/services` | **Enroll a service identity** form: **Custody locator (write-only)** never reads back a value; **Enrolled services** table; rotation and revocation impact. (§3.10) | |
| Policies | `/organization/policies` | Each evidence policy is a headed section; registering a new revision opens a confirmation dialog. | |
| Retention | `/organization/retention` | **Evidence retention**, **Authority delays**, **Eligibility under the current period** and **Change history** read correctly; **Change evidence retention?** dialog. | |
| Integrations | `/organization/integrations` | **NEAR network and RPC**, **1Click dry adapter and funded payouts**, **Audit export signing keys**; **Test connection** result is announced and says it proves connectivity only. | |
| NEAR accounts | `/organization/near-accounts` | **Link a NEAR account**: the wallet choice is labelled; the NEP-413 review reads the message; **Your linked accounts** and **Accounts linked in your organization** tables. | |

## 5. The critical flow in one pass (T-039)

With each screen reader, keyboard only, run this end to end on one trade, and note every point where you had to
guess, look at the screen or ask for help:

1. Accept an invitation and sign in (`/sign-in`).
2. Create a trade and sign; countersign in the supplier profile.
3. On **Evidence**, upload to a slot, meet one refusal (wrong type or too large) and recover from it; replace an
   item.
4. As the buyer, request hold resolution; as the risk/policy profile, resolve it.
5. On **Agreement**, review a destination change diff and consent.
6. On **Release**, lock an intent, approve and queue the release.
7. On **Refund**, read a refund that is blocked by the locked release value.
8. On **Payout**, read an UNKNOWN or REVIEW operation and request reconciliation.
9. On **Timeline**, prepare and save the signed export.

## 6. Severity

| Severity | Meaning |
|---|---|
| Blocker | A user of that pair cannot complete a critical step, or a secret is read out |
| Serious | The step can be completed only by guessing or with sighted help, or a status is misleading |
| Moderate | Extra effort or confusing wording, with a workaround |
| Minor | Polish |

The review **passes** for T-039 if no Blocker or Serious finding remains on the critical flow for each required
pair, and for T-040 if G-15 and G-16 hold on every screen at true 200% zoom and in landscape.

## 7. Result template

Copy into a new file (for example `docs/evidence/a11y-<date>.md`).

```text
Manual accessibility review
Reviewer:                     Date (UTC):
Commit SHA:                   Environment: [ ] testnet deployment  [ ] local stack (simulated chain)
Pairs used (name and version of screen reader, browser, OS):
  1.
  2.
Zoom method: page zoom 200% at ____ px window   text-only 200% [ ] yes [ ] no   400% reflow [ ] yes [ ] no
Landscape device:
Dark mode checked [ ]   Reduced motion checked [ ]

Per screen (write the G-IDs that failed, or "all pass")
| Screen / route                 | NVDA+Firefox | VoiceOver+Safari | 200% zoom | Notes |
|--------------------------------|--------------|------------------|-----------|-------|
| Sign in /sign-in               |              |                  |           |       |
| Recovery /recovery             |              |                  |           |       |
| Not found                      |              |                  |           |       |
| Home /                         |              |                  |           |       |
| Trades /trades                 |              |                  |           |       |
| Create trade /trades/new       |              |                  |           |       |
| Countersign                    |              |                  |           |       |
| Trade: Overview                |              |                  |           |       |
| Trade: Agreement (+ destination, key rebinding) |  |               |           |       |
| Trade: Evidence (+ holds, inspector)            |  |               |           |       |
| Trade: Release                 |              |                  |           |       |
| Trade: Payout                  |              |                  |           |       |
| Trade: Refund (+ asset recovery)|             |                  |           |       |
| Trade: Timeline (+ export)     |              |                  |           |       |
| Inspections                    |              |                  |           |       |
| Payouts                        |              |                  |           |       |
| Audit                          |              |                  |           |       |
| Organization                   |              |                  |           |       |
| Keys                           |              |                  |           |       |
| Service identities             |              |                  |           |       |
| Policies                       |              |                  |           |       |
| Retention                      |              |                  |           |       |
| Integrations                   |              |                  |           |       |
| NEAR accounts                  |              |                  |           |       |

Critical flow (section 5), per pair: steps completed without help ___/9; where help was needed:

Findings
| ID   | Severity | Screen / route | Check (G-n or row) | Pair or zoom | What happened | Expected (UI-SPEC section) | Steps to reproduce |
|------|----------|----------------|--------------------|--------------|---------------|----------------------------|--------------------|
| A-01 |          |                |                    |              |               |                            |                    |

Verdict:  T-039 [ ] PASS [ ] FAIL     T-040 [ ] PASS [ ] FAIL
```

The owner fixes the findings, re-runs the affected checks on the new build, and records the result in the T-039
and T-040 rows and in REAL-PRODUCT-GATE item 13 of [BUILD-STATUS.md](../../BUILD-STATUS.md).
