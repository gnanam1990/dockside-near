---
project: Dockside
version: 2.0.0
design_status: PROPOSED
product_runtime_status: NOT_RUN
---

# Professional UI/UX Specification

## 1. Experience principle

Dockside is an enterprise trade-operations application. It must feel calm, exact, and trustworthy under financial uncertainty. The primary screen answers: what agreement is active, where funds are, what evidence is valid, who must act, whether the destination changed, and what is proven versus still unknown.

The application is not a crypto landing page. It must not use neon gradients, glassmorphism, floating token art, animated backgrounds, confetti, oversized rounded metric cards, fake live badges, decorative charts, emoji icons, invented balances, or marketing copy inside operational workflows. Every visible number and status comes from an authenticated API projection with provenance.

## 2. Roles and navigation

Role permissions change actions, not the information architecture. Unsupported actions remain absent or visibly unavailable with a reason; the client never becomes the authority. Buyer, supplier, inspector and risk actors authenticate through separate proof-of-possession sessions. A role switch cannot impersonate another principal.

Primary navigation:

1. **Trades** — portfolio, attention queue, and create trade.
2. **Inspections** — evidence and assigned reviews.
3. **Payouts** — preparation, operations, reconciliation, and incidents.
4. **Audit** — immutable event history and exports.
5. **Organization** — people, keys, policies, integrations, and retention.

A persistent context bar shows organization, network (`NEAR testnet` or explicitly authorized mainnet), role, connection freshness, and last authoritative sync. Testnet is labelled on every money screen, not only in settings.

## 3. Information architecture and pages

### 3.1 Trades list

- Search by trade reference, supplier, milestone, or masked destination.
- Filters: needs my action, funding, inspection, hold, release-ready, payout unknown, terminal.
- Each row shows supplier, amount/asset, trade revision, contract state, next action, destination-change flag, evidence freshness, payout state, and last sync.
- Status uses icon, text, and supporting sentence; no color-only dots.
- Default ordering prioritizes unresolved financial risk, then user action, then time.
- Empty state explains how a real trade is created; it contains no seeded example transaction.
- Disconnected state freezes last data, marks exact staleness, disables mutations, and offers reconnect.

### 3.2 Create trade

A five-step form with persistent summary:

1. Parties and enrolled keys.
2. Asset, amount, milestone, refund policy.
3. Supplier payout network and exact destination.
4. Named inspector, enrolled ManifestAttestor profile, risk/policy authority, and evidence policy.
5. Review canonical agreement and collect signatures.

Every field has a visible label, format help, validation on blur, and server error. Destination entry shows network-specific normalization, checksum/display, full copyable value, and a high-salience warning that acceptance binds payment. The review screen groups material facts; it never hides them behind a generic “Terms accepted” checkbox.

Failed submit focuses a linked error summary and preserves inputs. Signing displays exact digest, actor, revision, expiry, and consequence. The UI does not sign automatically.

### 3.3 Trade workspace

Header: trade reference, supplier, amount, revision, contract address, network, state, and one context-sensitive primary action.

Tabs:

- **Overview:** next safe action, blocking conditions, funding/release ledger, participant authority, and milestone.
- **Agreement:** current canonical facts, signatures, prior revisions, diff viewer.
- **Evidence:** EvidencePolicy slots, upload, scan, provenance, manifest revisions, findings, HoldRecords and inspector attestation.
- **Release:** release intent/value lock, policy checklist, buyer approval, destination and execution profile.
- **Payout:** dry quote, funded operation if enabled, provider/source/destination facts, reconciliation.
- **Refund:** original-funder deposits, refund/cancel eligibility, timelock, conflicts and outcome.
- **Timeline:** append-only event history with table alternative.

The workspace never collapses `tradeState`, `payoutState`, `evidenceState`, `providerStatus`, and `destinationReceipt` into one badge.

### 3.4 Evidence and inspection

The page begins with the active EvidencePolicy slot checklist. Each slot states required cardinality, uploader and issuer identities/capabilities, detected MIME/content class, byte and parser-resource ceilings, original digest, required derived artifacts and source binding, issued/freshness rule, replacement/currentness rule, current item and recovery action. A ManifestAttestation panel shows exact trade/policy scope, attestor enrollment/service identity/key version/capability, manifest revision/digest, ordered per-predicate facts, expiry, signature verification, rotation and revocation state. Empty, incomplete, stale, unauthorized, resource-exceeding, over-cardinality, wrong-policy/scope/attestor/key-version and concurrent-replacement states cannot display complete.

Upload uses standard file controls and drag as an optional enhancement. It states allowed types, limits, retention, and who can view. Progress is per file and cancellable. Replacement uses compare-and-swap against the visible manifest revision; a conflict preserves work, refreshes the diff, and requires a new explicit action.

Evidence rows show safely encoded filename, original and derived/source digests, uploader/issuer capabilities, detected content/resource facts, captured/issued time, scan profile/result, freshness, replacement and superseded state. Model findings appear in an “Advisory analysis” region with source references, model/version and explicit text: “This analysis cannot create or clear a payment hold.” A separate HoldRecord panel shows onchain ID, status, SET issuer (`deterministic policy` or `risk/policy`), reason, manifest/revision binding, expiry, resolver requirements and transaction. `EXPIRED_UNRESOLVED` remains blocking. Buyer, supplier and inspector may view the role-permitted record; a buyer may submit a non-authorizing `Request resolution` message. Deterministic-policy has no resolution control. Only a separately authenticated enrolled risk/policy principal sees and can sign `Resolve hold`. The request and resolution are visually distinct and the exact signed resolution is previewed.

Inspector workbench shows agreement facts, policy slot completeness, current manifest, changes since prior review, authoritative holds and canonical attestation preview. Signing stays disabled until the manifest is complete and current. Decision controls are `PASS`, `FAIL`, or `REVIEW`. A different or expired inspector key produces a blocking error, not a fallback.

### 3.5 Destination change

The screen places current and proposed destinations side by side in monospaced, wrap-safe text. It shows proposer, reason, diff, buyer consent, supplier consent, activation time, delay countdown, and approvals that will be invalidated.

There is no “quick edit.” The action is `Start destination revision`. Consent actions show the exact digest and role. Cancel and reject are visible. Countdown uses exact UTC time in addition to relative time. For a pre-submit release intent, activation confirmation states that the old intent will become `SUPERSEDED_PRE_SUBMIT` and its exact reservation will atomically transfer to one successor. Activation is blocked during `SUBMITTING`, `PROCESSING`, `UNKNOWN`, `REVIEW`, `RECONCILING`, or `ADJUDICATION`. Completion does not reactivate the old manifest, inspection, HoldRecord view, funded authorization or release approval.

### 3.6 Release review

The release page is a structured checklist populated by backend facts:

- active revision and agreement signatures;
- authoritative escrow balance;
- current destination and change-delay state;
- EvidencePolicy completeness, manifest revision and inspector signature;
- onchain HoldRecords and signed resolutions, with model findings separate;
- amount, fees, refund, execution profile, and expiry;
- stable releaseIntentId/value lock and prior economic operation/refund conflict.

Each item links to evidence. `Approve release` is available only to an authorized buyer approver but server enforcement remains authoritative. Confirmation shows the full amount, asset, recipient, network, revision, and signature consequence. No approval is inferred from opening or reviewing the page.

Before submit, the UI presents two noninterchangeable flows. `Request cancellation` previews the canonical payload and collects matching buyer-approver and supplier-signer consents; either party can revoke only its own pending consent, and disagreement or one missing/expired/revoked signature leaves the intent locked. `Abandon expired intent` appears only to the designated buyer release approver or supplier signer after the backend proves the signed policy trigger and grace; it shows the full canonical fields, trigger time, `abandonAfter`, policy revision, signer capability/key version, nonce/expiry, exact source bucket and the fact that abandonment does not cancel the trade or refund funds. Administrator, deterministic-policy, risk, inspector, executor, ManifestAttestor and scheduler sessions have no abandonment control. API/contract enforcement remains authoritative. A submit race refreshes to the winning state. After submit or in any unresolved recovery state, all exit controls disappear and the lock reason remains visible. Dry compatibility never appears inside the release-intent progress stepper.

### 3.7 Payout and reconciliation

Sections remain distinct:

1. **Direct testnet release:** native testnet NEAR, contract, original funder, bound supplier testnet account, release intent and transaction.
2. **Optional dry compatibility:** independent `NOT_RUN`, `UNKNOWN`, `INCOMPATIBLE`, or `PASS` state, request/response time when present, future final recipient, route, expiry, official client/profile, redacted digests, and “No funds moved; not used for testnet release.” `WORKING_TESTNET` remains independent.
3. **Funded authorization:** quote/deposit address, final recipient, networks/assets, amount/minimum output, fees/slippage/cap, refund authority, nonce, signer, expiry and atomic-consumption state.
4. **Execution:** release intent, operation/attempt child identity, source transaction and provider status.
5. **Destination/refund:** destination receipt or provider refund to escrow/refund authority, or reason unavailable.
6. **Reconciliation:** value-lock state, prohibited competing actions, next read, observations, contradictions and safe actions.

`PAID` requires the backend terminal evidence predicate. `UNKNOWN`, `REVIEW`, `RECONCILING`, and `ADJUDICATION` show the retained reservation, contradictions, next authoritative read, and every prohibited action; they offer `Request reconciliation` or `Open adjudication`, never `Try payment again` or a terminal override. `FAILED` displays the authoritative no-transfer evidence, exact `reserved -> available` disposition, invalidated intent/approval, and requirement for a new intent/fresh approval. Late success/refund and post-failure contradiction show a high-severity frozen-value incident. Mainnet controls do not render when blocked; the page states the gate rather than providing a demo toggle.

### 3.8 Refund and cancellation

Show each accepted deposit with original funder, native testnet NEAR amount, reserved/released/refundable/quarantined portions and contract observation. Render the signed refund-policy ID/revision and exact reason matrix fields: initiator, signers, clock origin, duration, evidence, challenge/appeal, eligible amount, original-funder recipient, exact source bucket, revocation and unknown reconciliation. Partial funding and excess use their own rows; excess revocation explicitly returns to `QUARANTINED`. Buyer/supplier/inspector key loss show recovery-first with no automatic refund. Unexpected assets appear in a separate `Asset recovery review` panel with its own claimed sender, proof, risk/policy authorization, 72-hour challenge, exact asset/amount/recipient, revocation and `UNKNOWN` reconciliation; they never appear as refundable native NEAR. The page cannot offer refund while release value is unresolved, and a refund in `EXECUTING`, `PROCESSING`, `UNKNOWN`, `REVIEW`, `RECONCILING`, or `ADJUDICATION` offers reconciliation/adjudication only. Authoritative no-transfer failure shows exact source-bucket restoration and a new-intent requirement. Provider refund is a separate row returning to escrow/refund authority before original-funder withdrawal.

### 3.9 Audit

Timeline and table show sequence, actor, authority, action, object/revision, observed and recorded time, source, evidence class, digest, and result. Filters never remove a visible hidden-count summary. Export preview lists included/redacted categories and manifest digest. Export generation and product verdict are separate states.

### 3.10 Organization and integrations

Bootstrap organizations through wallet proof-of-possession. Invitation screens show intended organization/capability, expiry and one-time consumption; acceptance occurs in the recipient's separate session and role grant is a later administrator action. A ManifestAttestor administration surface is restricted to organization security administrators and shows service identity, PoP challenge result, public key/version, `MANIFEST_ATTEST` capability, organization/trade/policy scope, isolated-custody status (never the secret), active revision bindings, rotation/revocation impact and audit history. Rotation or recovery cannot silently affect active trades; the UI requires a new trade revision and renewed evidence/inspection/release authority. Manage deterministic-policy SET and separate risk/policy RESOLVE identities, inspector identities, revocation/recovery delays, evidence policies, retention, RPC/provider endpoints, refund authority and dry adapter state. Secrets are write-only. Test connection proves connectivity only.

## 4. Design system

### Visual direction

Light-first Minimal Swiss enterprise operations. Dark mode is supported but not treated as a neon variant. Use flat surfaces, 1 px borders, restrained elevation, 8 px layout rhythm, and square-to-moderate radii. Maximum card/dialog radius is 12 px; controls are 8 px unless platform semantics require otherwise.

### Typography

- Primary UI: IBM Plex Sans, locally bundled or privacy-preserving hosted with system fallback.
- IDs, addresses, hashes, amounts, and timestamps: IBM Plex Mono or a metrically compatible monospace.
- Body: 16 px / 1.5 minimum. Metadata: 13–14 px only with verified contrast. Amounts use tabular figures.
- Headings use weight and spacing, not excessive size; screen title 28–32 px desktop and 24–28 px mobile.

### Semantic tokens

Components consume semantic variables; raw hex values are prohibited in component files.

```text
surface-canvas        #F8FAFC
surface-panel         #FFFFFF
surface-subtle        #E9EEF5
text-primary          #0F172A
text-secondary        #475569
border-default        #CBD5E1
action-primary        #1E3A5F
action-secondary      #2563EB
status-positive       #15803D
status-warning        #A16207
status-negative       #B91C1C
status-unknown        #6D28D9
focus-ring            #1E3A5F
```

Implementation must verify every foreground/background pair at WCAG 2.2 AA. Green never means “paid” without the text and evidence icon. Purple identifies unknown/private evidence, not branding.

### Components

- App shell, context bar, breadcrumb, page header.
- Evidence-bound status badge with icon, label, reason, source, and timestamp.
- Money value with asset/network and tabular figures.
- Address display with network, full accessible text, masked visual option, copy confirmation.
- Identity/revision strip.
- Authority checklist.
- Event timeline plus semantic table.
- Diff viewer for agreement/destination revisions.
- Reconciliation panel.
- Error summary, inline field error, empty state, stale-data banner, blocked-action callout.
- Confirmation dialog with scope, reversibility, exact identity, and signature/fund consequence.

Build primitives from semantic HTML and an accessible component foundation; do not assemble custom `div` controls. Use one SVG icon family with consistent stroke. Decorative icons are hidden from assistive technology; icon-only controls have names and tooltips.

## 5. Responsive behavior

Verify 375, 768, 1024, and 1440 CSS px, 200% zoom, landscape, and long translations/addresses.

- **375:** single column; maximum five bottom/compact navigation destinations; sticky action region reserves safe space; tables become labelled cards only when relationships remain explicit, otherwise use a labelled contained scroller.
- **768:** collapsible side navigation; form summary becomes an accordion; trade tabs remain horizontally accessible with menu fallback.
- **1024:** persistent navigation; two-column workspace; evidence drawer overlays only when focus management is correct.
- **1440:** maximum content width with three-column review layouts where useful; prose stays 60–75 characters wide.

No body-level horizontal scrolling. Long addresses use `overflow-wrap:anywhere` only in their own field. Browser zoom stays enabled. Touch targets are at least 44×44 CSS px for touch contexts and WCAG 2.2 pointer minimum elsewhere.

## 6. Accessibility

- Skip link, semantic landmarks, sequential headings, logical tab order.
- Visible 2–4 px focus with at least 3:1 state contrast; sticky elements never obscure focus.
- Native buttons/inputs/links; full keyboard path for upload, evidence review, signing, and reconciliation.
- Dialog focus is trapped and restored. Escape/cancel is available before an irreversible signature prompt.
- Forms use persistent labels, helper text, inline errors, and a focusable linked error summary after submit.
- Live regions announce complete contextual status phrases but do not announce every streamed event.
- Timelines and visual summaries include table/text equivalents.
- Status never relies on color, position, or animation alone.
- `prefers-reduced-motion` removes nonessential motion. Text scaling does not truncate essential information.
- Authentication permits password managers and paste; signature flows provide non-cognitive instructions.

## 7. Motion and performance

Use 120–200 ms opacity/color transitions for local feedback only. No scroll reveal is required inside the product. Do not animate height/width, money movement, status loops, or background decoration. Reduced-motion users receive instant final state.

Reserve layout for asynchronous data. Paginate or virtualize event lists above measured thresholds while keeping semantic table behavior. Input feedback appears within 100 ms. Profile before optimization; targets and budgets must be recorded from the implemented stack.

## 8. Required states

Every data-bearing component defines and tests:

- initial loading and refresh loading;
- empty/unconfigured;
- valid/current;
- validation error and permission denied;
- partial evidence and `REVIEW`;
- stale and disconnected;
- retry scheduled with bounded attempt/time;
- `UNKNOWN` external effect;
- locked `REVIEW`, `RECONCILING`, and `ADJUDICATION` with no terminal override;
- unsupported schema/network/profile;
- privacy-hidden evidence;
- resource limit exceeded;
- `NOT_RUN` and `BLOCKED`;
- terminal paid, refunded, failed, cancelled, or closed where applicable.

Skeletons reserve shape but contain no invented values. Toasts may confirm a completed local action but cannot be the only error, approval, or financial-status communication.

## 9. Acceptance checks

- Independently authenticated buyer, supplier, inspector and risk/policy sessions plus isolated ManifestAttestor and deterministic-policy service identities complete only their own product steps; one role switch or generic service key cannot simulate them.
- A first-time buyer can create, sign, fund, complete policy-bound evidence, request and view hold resolution, lock a release intent, approve, and directly release native testnet NEAR without raw logs; a separately authenticated enrolled inspector attests and a separately authenticated enrolled risk/policy principal alone signs hold resolution.
- Empty, stale, unauthorized, resource-exceeding, wrong-scope/attestor/key-version and concurrently replaced evidence slots show the exact recovery action and cannot appear complete.
- Partial/excess/unexpected funding, refund/cancel timelock and release/refund conflict remain understandable and operable.
- A forged destination change is visibly denied and cannot be bypassed through API or contract.
- A user can reach the exact evidence behind any blocking fact in at most four navigation actions.
- `WORKING_TESTNET`, each independent dry state, `FUNDED_AUTHORIZED`, `PROCESSING`, `UNKNOWN`, locked `REVIEW`/`RECONCILING`/`ADJUDICATION`, authoritative no-transfer `FAILED`, `PAID`, provider refund and destination receipt are visually and semantically distinct at every viewport.
- No UI page or accessibility tree contains a provider secret or private evidence locator.
- Keyboard-only and screen-reader users complete the central product path.
- Every displayed status identifies source and freshness; disconnected data cannot look live.
- The UI contains no fake KPI, seeded trade, hard-coded status, demo toggle, or prerecorded path.
- Automated accessibility, contrast, browser, responsive, and manual assistive-technology results are tied to the exact build.
