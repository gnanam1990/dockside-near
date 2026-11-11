---
project: Dockside
version: 2.0.0
artifact_status: SPECIFICATION_ONLY
product_runtime_status: NOT_RUN
---

# Start here

Dockside is a production-shaped trade-payment product: it binds supplier payout details into an escrow agreement, requires a signed inspection result and buyer approval, rejects unauthorized redirection, and reconciles payout evidence. It is not a demo generator, a generic procurement dashboard, or an autonomous AI payer.

## Reading order

1. [PRD.md](PRD.md) — product boundary and acceptance.
2. [CORE-CONTRACT.md](CORE-CONTRACT.md) — authoritative requirements and invariants.
3. [CORRIDOR-CONTRACT.md](CORRIDOR-CONTRACT.md) — exact direct testnet corridor and blocked funded rail.
4. [REFUND-POLICY.md](REFUND-POLICY.md) — authoritative versioned native refund and separate unexpected-asset recovery matrix.
5. [TDD.md](TDD.md) — architecture and state model.
6. [SECURITY.md](SECURITY.md) — threats and trust boundaries.
7. [UI-SPEC.md](UI-SPEC.md) — professional product experience.
8. [TEST-PLAN.md](TEST-PLAN.md) — all tests start `NOT_RUN`.
9. [REAL-PRODUCT-GATE.md](REAL-PRODUCT-GATE.md) — runtime evidence required before any working claim.
10. [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md), then the prompts in `prompts/`.
11. [DELIVERY.md](DELIVERY.md) — evidence, Git, CI, publication, and authorization gates.

## Current truth

- Documents exist; the product does not yet exist.
- No repository, deployment, test result, provider call, contract, wallet, funded transaction, public post, or submission is established by this pack.
- Real native testnet NEAR escrow-to-bound-supplier release, independent buyer/supplier/inspector/risk identities, a revision-bound isolated ManifestAttestor whose signature covers every EvidencePolicy predicate, deterministic-policy SET-only holds, risk/policy-only resolution, dual-signed CANCEL versus objective policy ABANDON, stable release intent, original-funder/source-bucket refund safety, locked UNKNOWN/REVIEW recovery, persistence/restart, and evidence export are mandatory `WORKING_TESTNET` acceptance paths.
- A real 1Click `dry:true` probe is optional compatibility evidence with independent state `NOT_RUN`, `UNKNOWN`, `INCOMPATIBLE`, or `PASS`. Only `PASS` supports `DRY_COMPATIBLE`; none of those states raises or lowers `WORKING_TESTNET`.
- A funded 1Click settlement is a separate mainnet capability. It remains blocked until explicitly authorized, executed with capped exposure, and reconciled to destination receipt. The product must show `BLOCKED` or `NOT_RUN`, never a simulated success.

## One-shot coding-agent start

Read every core document and repository instruction before modifying files. Verify the checkout, dirty tree, toolchain, supported NEAR environment, and exact official 1Click client behavior. Implement modules in dependency order from `requirements.json`. Use TDD: retain failing evidence, implement the smallest complete behavior, then run focused and impacted suites. Record exact commands, exit codes, counts, commit identity, real-versus-simulated boundaries, and remaining gates in `BUILD-STATUS.md`. Do not push, open or merge a PR, deploy, sign, fund, publish, or submit without separate authorization.

## Stop conditions

Stop and report evidence if the intended NEAR path, full-predicate/revision-bound ManifestAttestor, inspector signature, SET/RESOLVE separation, CANCEL/ABANDON authority, refund source-bucket policy, authoritative failure predicate, or destination reconciliation cannot satisfy [CORE-CONTRACT.md](CORE-CONTRACT.md). If optional M06 is attempted, also stop on unverified 1Click recipient/refund binding or quote-expiry behavior and leave `DRY_COMPATIBLE` non-passing. Do not silently substitute manual terminal decisions, database edits, hard-coded states, a mock provider, or an AI approval.
