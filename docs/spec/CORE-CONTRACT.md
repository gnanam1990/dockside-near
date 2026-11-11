# Dockside Core Contract

Status: **SPECIFICATION_ONLY**. Product runtime: **NOT_RUN**.

This file is authoritative. Other documents may add detail but cannot weaken these definitions.

## Functional requirements

### FR-01 — Bound trade agreement

Create one trade agreement with immutable buyer, supplier, asset, amount, milestone, evidence policy, inspector, payout network, and supplier destination identities.

### FR-02 — Escrow funding

Accept and reconcile escrow funding only for the exact trade identity, original funder, asset, amount, chain, and contract account.

### FR-03 — Evidence intake and analysis

Ingest bounded evidence under the active EvidencePolicy, preserve provenance, and keep deterministic or model-assisted analysis separate from release authority.

### FR-04 — Inspector attestation

Accept a pass, fail, or review attestation only from the enrolled inspector and bind it to the exact trade, revision, milestone, complete evidence manifest, schema, and expiry.

### FR-05 — Buyer release approval

Require an authenticated buyer approval bound to the current trade revision, valid inspector pass, release intent, amount, direct testnet destination or funded authorization, and execution profile before value release.

### FR-06 — Destination change control

Reject unilateral payout-destination changes and require buyer and supplier consent, a new revision, a visible delay, and renewed evidence, inspection, release intent, and approval.

### FR-07 — Payout preparation and execution

When the optional compatibility module is run, prepare a 1Click quote for the exact bound final recipient, keep its NOT_RUN, UNKNOWN, INCOMPATIBLE, or PASS result distinct from release and funded execution, and prevent stale or altered quote facts from receiving funds.

### FR-08 — Durable reconciliation

Persist every external economic operation before submission; keep UNKNOWN, REVIEW, RECONCILING, and ADJUDICATION value-locked; reconcile late or contradictory outcomes without blind retry; and apply PAID, REFUNDED, or authoritative no-transfer FAILED only with exact ledger disposition.

### FR-09 — Evidence and audit export

Produce a redacted, checksummed audit bundle linking agreement, authorities, holds, manifests, attestations, release intent, approvals, quote, transactions, receipts, refunds, and unresolved evidence.

### FR-10 — Role and authority enforcement

Enforce distinct buyer, supplier, inspector, risk, auditor, and executor authorities at contract, API, worker, and interface boundaries.

### FR-11 — Stable release intent and value lock

Create one stable releaseIntentId per economic release, lock its value independently of quote, revision, and attempt identifiers, and prevent competing payout, destination, cancel, or refund actions while unresolved.

### FR-12 — Onchain hold control

Allow an enrolled deterministic-policy service or risk/policy principal to SET a contract-consumed HoldRecord, but allow only a separately authenticated enrolled risk/policy principal to RESOLVE it; bind every mutation to exact trade, revision, evidence, reason, nonce, signature, and expiry, and reject deterministic-policy, buyer, supplier, and inspector resolution signatures.

### FR-13 — Evidence policy completeness

Bind an allowed ManifestAttestor identity, key version, capability, and scope into the signed trade revision and EvidencePolicy; derive completeness on contract from its signed uploader, issuer, content-class, resource-limit, digest, derived-source, replacement/currentness, issued/freshness, and cardinality facts before inspection or release readiness.

### FR-14 — Escrow refund and cancellation

Govern partial, excess, expiry, inspection-fail, permanent-hold, mutual-cancel, and key-loss paths under a versioned refund/recovery policy: eligible native-NEAR refunds are original-funder-bound, timelocked, and mutually exclusive; key loss is recovery-first; unexpected assets remain in a separate asset-recovery policy and never enter native-NEAR refund accounting.

### FR-15 — Organization and key lifecycle

Bootstrap organizations, counterparties, ManifestAttestors, and policy services through proof of possession, scoped grants, separate sessions or isolated service custody, rotation, revocation, and recovery without silently transferring active-trade authority.

### FR-16 — Funded payout authorization

After quote selection, require an exact signed FundedPayoutAuthorization and atomically consume it once before any mainnet transfer to the quote deposit address.

## Nonfunctional requirements

### NFR-01 — Crash-safe durability

Acknowledged state transitions must survive process restart, duplicate delivery, worker loss, and database recovery without double release, double refund, or lost uncertainty.

### NFR-02 — Security and privacy

Use least privilege, secret isolation, content limits, redaction, encryption, dependency pinning, and fail-closed validation at every trust boundary.

### NFR-03 — Accessible professional interface

The interface must meet WCAG 2.2 AA, support keyboard and screen-reader workflows, and communicate every material state without relying on color alone.

### NFR-04 — Bounded performance

Interactive reads must remain responsive under declared evidence and event limits, with pagination, virtualization, cancellation, and resource budgets.

### NFR-05 — Reproducible portability

A clean supported environment must reproduce the documented local and testnet workflow from pinned dependencies without author-machine paths or hidden manual repair.

### NFR-06 — Observable provenance

Every decision and displayed status must expose source, subject, observation time, freshness, confidence, revision identity, and correlation identifiers.

### NFR-07 — External-action safety

Push, deployment, funded execution, signing, account changes, publication, and submission must remain separately authorized and auditable.

## Invariants

### INV-01 — Immutable trade identity

An accepted trade revision never changes buyer, supplier, asset, amount, milestone, evidence policy, inspector, payout network, or destination in place.

### INV-02 — Value conservation

For each asset, funded equals reserved plus released plus refunded plus fees plus available plus quarantined, with no unexplained positive loss or duplicated value.

### INV-03 — Complete release authority

No value release occurs without contract-derived completeness for the exact current manifest, inspector pass, absent active hold, buyer approval, unexpired policy checks, release intent, and destination binding required by the execution profile.

### INV-04 — AI cannot change authority

Model output may explain or propose a hold but can never create or clear a HoldRecord, evidence slot, inspector attestation, buyer approval, release intent, signature, refund, or payout authorization.

### INV-05 — No silent redirection

A destination change creates a new revision and cannot become effective without dual consent, delay completion, renewed evidence and inspection, a new release intent, and explicit reapproval.

### INV-06 — Exactly one economic operation

One release intent may authorize at most one direct release or funded payout; exact duplicates join existing state and conflicting reuse fails closed.

### INV-07 — Truthful payout status

Dry validation, funded authorization, submitted deposit, provider status, source-chain settlement, refund, and destination receipt remain separate; PAID requires the configured authoritative evidence set.

### INV-08 — Unknown fails closed

Missing, stale, private, contradictory, unsupported, incomplete, or unverifiable required evidence yields HOLD, REVIEW, or UNKNOWN, preserves every affected lock, and cannot be manually promoted to release-ready, refundable-by-bypass, failed, refunded, or paid.

### INV-09 — Economic value lock

While a release intent is SUBMITTING, PROCESSING, UNKNOWN, REVIEW, RECONCILING, or ADJUDICATION, its value cannot back quote renewal, a new release intent, destination activation, cancellation, abandonment, supersession, refund, reservation release, or second submit.

### INV-10 — Authoritative hold

Any applicable active or expired-unresolved onchain HoldRecord blocks direct and executor-mediated release until an authorized signed resolution is consumed.

### INV-11 — Complete evidence manifest

An inspector pass and release approval require one current authorized item for every required EvidencePolicy slot and no unresolved replacement, freshness, issuer, or cardinality violation.

### INV-12 — Release and refund exclusion

The same escrow value cannot be simultaneously releasable, in payout, and refundable; one atomic economic lock and per-funder source-bucket ledger serialize every unresolved outcome, terminal disposition, and refund revocation.

### INV-13 — Independent party authority

Buyer, supplier, inspector, and risk/policy authority must be established through separate enrolled identities and proof-of-possession sessions; one operator controlling all test keys cannot satisfy normal product acceptance.

### INV-14 — Exact funded authorization

A FundedPayoutAuthorization binds one release intent, quote and deposit address, final recipient, networks, assets, amounts, minimum output, fees, slippage, exposure cap, refund authority, nonce, expiry, and signer, and is consumed atomically once.

### INV-15 — Pre-submit intent supersession

Only a pre-submit release intent may exit: CANCEL requires matching buyer and supplier signatures, ABANDON requires a designated buyer approver or supplier signer plus a policy-bound objective expiry trigger, and supersession requires authorized destination activation; each atomically releases or transfers its reservation and invalidates predecessor authority, while SUBMITTING, PROCESSING, UNKNOWN, REVIEW, RECONCILING, and ADJUDICATION intents cannot exit.

### INV-16 — Contract-derived manifest completeness

The signed trade revision and EvidencePolicy bind one allowed ManifestAttestor identity, key version, capability, and scope; the contract derives completeness from all of that attestor's signed policy facts, and no caller-provided completeness boolean or different enrolled attestor has authority.
