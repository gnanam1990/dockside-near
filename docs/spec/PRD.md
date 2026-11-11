---
project: Dockside
version: 2.0.0
artifact_status: SPECIFICATION_ONLY
product_runtime_status: NOT_RUN
decision: CONDITIONAL_BUILD
---

# Product Requirements Document

## 1. Decision

**CONDITIONAL BUILD.** The exact working corridor is native testnet NEAR from a buyer-controlled NEAR testnet account into the Dockside contract and directly to the contract-bound supplier NEAR testnet account. A real 1Click `dry:true` quote is compatibility/readiness evidence only; it cannot satisfy release readiness or a payment claim. The only planned funded mainnet rail is contract to the exact selected 1Click deposit address to the bound supplier destination, with `refundTo` controlled by Dockside's escrow/refund authority. That rail remains `BLOCKED` until verified and separately authorized.

## 2. Problem

Small importers often separate commercial agreement, inspection evidence, supplier payout details, and payment execution across email, spreadsheets, banks, stablecoin wallets, and messaging apps. A forged bank-change request can redirect a legitimate payment. An inspection report can arrive but remain disconnected from the release decision. After a timeout, operators may not know whether money moved and may repeat an economic action.

Dockside makes the payout destination and release conditions part of one versioned agreement. It exposes the exact evidence required, enforces named human authority, and retains uncertainty until authoritative reconciliation. Pain evidence exists for supplier fraud and inspection workflows; willingness to pay for this exact product is **UNPROVEN**.

## 3. Primary user, buyer, and counterparties

- **Primary user:** an importer operations or finance manager responsible for paying one overseas supplier order.
- **Economic buyer:** the importing company bearing loss, delay, and reconciliation cost.
- **Supplier:** views the agreed destination and funding/release state, consents to destination changes, and receives payment; it cannot inspect buyer-private material.
- **Inspector:** a specifically enrolled independent party that signs a milestone result.
- **Risk/policy principal:** a separately authenticated enrolled authority that may SET and alone may RESOLVE HoldRecords under policy; a deterministic-policy service may SET only.
- **ManifestAttestor:** an isolated service principal whose exact enrollment, key version, capability and trade/policy scope are accepted in the signed trade revision; it attributes complete policy facts but is not the inspector.
- **Auditor:** read-only access to approved evidence and audit bundles.
- **Executor service:** performs only policy-authorized, idempotent provider actions; it has no UI authority to manufacture approval.

The first production-shaped corridor is one independently enrolled buyer organization, one independently enrolled supplier, one independent inspector, one separate risk/policy principal, one milestone, native testnet NEAR, and one direct contract payout. One operator controlling all party keys cannot satisfy normal product acceptance. Multi-supplier procurement, negotiation, lending, insurance, open marketplaces, Agent Market hiring, Sputnik disputes, and a second payout architecture are excluded.

## 4. Core job

“Hold the exact funds for this supplier order, prove who may release them and why, refuse a redirected destination, and tell me truthfully whether payout is merely prepared, submitted, uncertain, refunded, or received.”

## 5. Strongest alternative

The conventional alternative is a bank or stablecoin transfer governed by purchase orders, email approval, an inspection PDF, and manual callback verification. It is simpler and appropriate when counterparties trust each other and payment rails provide sufficient controls. Dockside is justified when destination redirection, cross-system evidence, or retry/reconciliation risk warrants cryptographic binding and an auditable state machine.

## 6. Product scope

### Included

- Versioned trade agreement and exact participant keys/accounts.
- Real native-NEAR testnet contract deployment, original-funder ledger, and direct same-asset release to the bound supplier testnet account.
- Destination bound at agreement acceptance.
- EvidencePolicy with required slots and every uploader, issuer, MIME/content-class, byte/resource-limit, original/derived digest/source, replacement/currentness, issued/freshness and cardinality predicate, plus contract-derived completeness from the exact revision-bound ManifestAttestor; caller booleans and other enrolled attestors have no authority.
- Evidence upload with digest, provenance, limits, concurrent-safe replacement, and private storage boundary.
- Onchain HoldRecords SET by an enrolled deterministic-policy service or separate risk/policy principal, but RESOLVED only by that risk/policy principal; deterministic-policy, buyer, supplier and inspector resolution signatures fail, and AI can only propose findings.
- Actual enrolled-inspector signature over the canonical attestation.
- Stable release intent/value lock and actual buyer approval over the current release facts.
- Dual-consent, delayed destination-change workflow that invalidates prior approvals.
- Original-funder-bound refund/cancel state machine, abnormal-funding quarantine, and release/refund exclusion.
- Organization invitation, proof-of-possession, role grant, separate-session/service-custody, ManifestAttestor enrollment/scope/rotation/revocation, and recovery workflow.
- Optional, independently claimed offchain executor with a real official 1Click `dry:true` quote call and exact recipient binding; it is not required for `WORKING_TESTNET`.
- Exact post-quote FundedPayoutAuthorization for the blocked future mainnet rail.
- Durable journal, idempotency, crash/restart recovery, status polling, conservation, and audit export.
- Professional role-aware application, not a demonstration shell.

### Excluded

- Automatic legal determination that goods conform.
- AI-authorized release or AI-generated party signatures.
- Custody claims beyond the deployed contract and expressly configured executor.
- Pretending a dry quote is settlement.
- A mainnet funded run without explicit wallet, amount, signing, and exposure authorization.
- Universal cross-chain or multi-corridor claims.
- Guarantee, insurance, chargeback, credit, yield, arbitration, or regulatory-compliance claims.

## 7. User journeys

### 7.1 Create and fund a trade

The buyer creates terms, selects the exact supplier destination and inspector, and selects an already proof-of-possession-enrolled ManifestAttestor identity/key version/capability scoped to this EvidencePolicy and trade. The canonical summary exposes that oracle and the separate deterministic-policy setter/risk resolver before buyer and supplier sign. The application deploys or selects the configured testnet escrow, shows exact funding instructions, observes chain state, and moves to `FUNDED` only from authoritative contract evidence.

### 7.2 Inspect and approve release

Authorized uploaders fill every EvidencePolicy slot with current issuer-valid evidence. The system hashes bytes, records provenance, rejects unauthorized or stale items, and produces a versioned manifest. The exact revision-bound ManifestAttestor signs every current uploader/issuer/content/resource/digest/derived-source/replacement/freshness/cardinality fact; the contract recomputes completeness and rejects caller booleans, wrong scopes, rotated-unbound or revoked keys. Optional model analysis can propose a finding but cannot mutate authority. An enrolled deterministic-policy service may SET, never RESOLVE, a HoldRecord; a separately authenticated risk/policy signer may SET or RESOLVE it. The buyer can request/view resolution but cannot sign it. The independent inspector can sign only a contract-accepted complete current manifest. The buyer then creates one release intent/value lock and signs its exact release approval.

### 7.3 Reject a forged bank change

An operator enters a new destination taken from an email. The system displays that it differs from the contract-bound destination and rejects direct replacement. A legitimate change starts a new revision, requires both buyer and supplier signatures in separate sessions, and waits the policy delay. Activation atomically supersedes only a pre-submit release intent and transfers its reservation to the new revision; it is blocked after submit or while processing, unknown, review, reconciliation, or adjudication. A fresh complete manifest, inspection, release intent and approval are required. The original record remains immutable.

### 7.4 Prepare and reconcile payout

The working testnet release transfers native testnet NEAR directly from contract to supplier testnet account. Separately and optionally, the executor may request a real `dry:true` quote for the bound future final recipient and store it as non-authorizing compatibility evidence with status `NOT_RUN`, `UNKNOWN`, `INCOMPATIBLE`, or `PASS`. A future mainnet run requires a post-quote signed FundedPayoutAuthorization covering release intent, quote/deposit address, final recipient, networks/assets, amounts/output, fees/slippage/cap, refund authority, nonce and expiry. The journal commits before submit. While submission is unresolved—including REVIEW/reconciliation/adjudication—every competing action stays locked. Operators may request reads or adjudication but cannot force a terminal state. `FAILED` requires authoritative no-transfer and escrow-accounting proof before releasing the reservation; retry uses a new intent and fresh approval. `PAID` requires authoritative destination receipt, and late or contradictory results remain bound to the original intent.

### 7.5 Refund or cancel safely

Partial funding remains unavailable; excess is quarantined; unexpected assets are not credited or treated as refundable native NEAR. The signed [REFUND-POLICY.md](REFUND-POLICY.md) reason matrix defines initiator, signers, clock, duration, evidence, challenge, amount, recipient, source bucket, revocation and unknown reconciliation for expiry, inspector fail, permanent hold, mutual cancellation, key loss, partial and excess funding. Eligible native testnet NEAR returns only to the recorded original funder. Pre-submit revocation restores the exact source bucket—excess returns to `QUARANTINED`. Refund UNKNOWN/REVIEW remains locked through reconciliation/adjudication; authoritative no-transfer failure alone restores the source bucket and any retry uses a new refund intent. Refund and release race on one atomic economic lock. Future provider refunds return to the quote-bound escrow/refund authority before per-funder withdrawal.

### 7.6 Audit

An auditor follows agreement revision, funding, evidence, model holds, inspector attestation, buyer approval, destination-change history, quote, transaction, provider state, and destination receipt. Export is redacted by role and checksummed; absence or privacy limits remain visible.

## 8. Product states

Trade state: `DRAFT`, `AWAITING_SIGNATURES`, `AWAITING_FUNDING`, `PARTIALLY_FUNDED`, `FUNDED`, `EXCESS_REVIEW`, `INSPECTION_PENDING`, `HOLD`, `INSPECTION_PASSED`, `RELEASE_INTENT_LOCKED`, `BUYER_APPROVED`, `PAYOUT_READY`, `CLOSED`, `DISPUTED`, `CANCELLED`.

Payout state: `NOT_REQUESTED`, `AUTHORIZATION_REQUIRED`, `AUTHORIZED`, `SUBMITTING`, `UNKNOWN`, `PROCESSING`, `REVIEW`, `RECONCILING`, `ADJUDICATION`, `PAID`, `REFUNDED`, `FAILED`.

Release-intent pre-submit exits: dual-signed voluntary `CANCELLED_PRE_SUBMIT`, objectively expired policy-driven `ABANDONED_PRE_SUBMIT` signed only by the designated buyer approver or supplier signer, and destination-activation `SUPERSEDED_PRE_SUBMIT`. Disagreement on CANCEL leaves the lock unchanged; ABANDON cannot run before its signed policy trigger/grace, and no administrator or service principal may invoke it. Dry compatibility is an orthogonal claim fact, not a release-intent state.

Dry compatibility state: `NOT_RUN`, `UNKNOWN`, `INCOMPATIBLE`, `PASS`. Only `PASS` supports the separate optional claim `DRY_COMPATIBLE`.

Evidence state: `UPLOADING`, `SCANNING`, `AVAILABLE`, `REJECTED`, `STALE`, `SUPERSEDED`, `PRIVATE_NOT_VISIBLE`, `DELETED_BY_POLICY`.

Hold state: `ACTIVE`, `EXPIRED_UNRESOLVED`, `RESOLVED`, `SUPERSEDED`. Refund state: `NONE`, `REQUESTED`, `TIMELOCKED`, `AUTHORIZED`, `EXECUTING`, `PROCESSING`, `UNKNOWN`, `REVIEW`, `RECONCILING`, `ADJUDICATION`, `REFUNDED`, `FAILED`.

Completion is not success. A request can complete with `FAILED`, `REFUNDED`, or `REVIEW`. Provider success is not destination receipt. The UI and API preserve each axis separately.

## 9. Requirements

[CORE-CONTRACT.md](CORE-CONTRACT.md) defines `FR-01`–`FR-16`, `NFR-01`–`NFR-07`, and `INV-01`–`INV-16`. [CORRIDOR-CONTRACT.md](CORRIDOR-CONTRACT.md) fixes the working and blocked settlement boundaries. [REFUND-POLICY.md](REFUND-POLICY.md) is authoritative for native refund/recovery reasons. Acceptance may add evidence but may not weaken them.

## 10. Product acceptance

Dockside is a working product only when a clean checkout proves all of the following without seeded central states, hard-coded success, prerecorded transitions, or manual database repair:

1. Independently enrolled buyer, supplier, inspector, and risk/policy principals prove possession in separate sessions and perform only their capabilities; one operator holding all keys does not qualify.
2. A real NEAR testnet contract accepts native testnet NEAR from a recorded funder and directly releases the same asset to the bound supplier testnet account.
3. EvidencePolicy rejects every missing or altered uploader, issuer, content/resource, digest/derived-source, replacement/currentness, freshness and cardinality predicate; only the exact trade/policy-bound ManifestAttestor version can establish completeness, and wrong-scope, rotated-unbound and revoked keys fail.
4. A real onchain HoldRecord blocks direct contract release; AI output alone cannot create or clear it; deterministic policy may SET only; the buyer may request/view resolution but only the separate risk/policy principal signs it.
5. An unauthorized destination replacement is rejected; a legitimate change requires dual consent, delay and renewed manifest, inspection, release intent and approval.
6. One stable releaseIntentId locks exact value; dual-signed CANCEL, objective policy-triggered ABANDON and destination supersession are distinct pre-submit authorities with nonce/replay/race enforcement; every unresolved post-submit state remains locked, and authoritative failure alone releases value for a new intent and fresh approval.
7. Every versioned refund/recovery reason, abnormal funding, original-funder return, unexpected-asset isolation and concurrent release/refund path obeys the authoritative policy and conserves value.
8. Injected timeout/restart, REVIEW/reconciliation/adjudication, authoritative no-transfer failure, late success/refund and contradiction exercise exact reservation/source-bucket disposition without duplicate release, blind retry or reservation leak.
9. Audit export verifies the same identities, manifests, holds, locks, refunds and outcomes as contract and database observations.
10. The professional UI completes normal and recovery workflows with keyboard and screen-reader evidence at required widths.

`DRY_COMPATIBLE` is a separate optional claim. If M06 is not run or cannot reach/validate the official service, its state remains `NOT_RUN`, `UNKNOWN`, or `INCOMPATIBLE` without lowering `WORKING_TESTNET`. The blocked funded rail has an exact post-quote authorization contract but cannot be claimed working without a separately authorized real run and destination reconciliation.

Funded mainnet payout acceptance is separate: capped authorization, real deposit, provider terminal status, source transaction, and destination receipt must reconcile. Until then the capability is `NOT_RUN` or `BLOCKED`.

## 11. Launch and validation gates

- Current official event rules and repository/publication requirements refreshed.
- Contract, worker, API, and UI threat review closed for the tested revision.
- Inspector and ManifestAttestor enrollment, scope, key custody, rotation, revocation, and recovery procedures proven.
- Operational ownership for UNKNOWN/REVIEW reconciliation and non-authoritative adjudication assigned.
- At least three importer interviews, one inspector workflow review, and one design partner before treating market demand as positive.
- Qualified legal review before holding customer funds, representing escrow rights, automating cross-border payments, or marketing compliance.

## 12. Recommendation flip

Stop or reframe Dockside if supplier destination binding cannot survive the chosen payout architecture, the contract cannot enforce release independently of the UI, the inspector relationship is unavailable, or operators prefer existing escrow/bank controls and reject the integration burden. Do not compensate by adding more chains, agents, dashboards, or prize tracks.
