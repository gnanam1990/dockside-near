---
project: Dockside
version: 2.0.0
artifact_status: SPECIFICATION_ONLY
runtime_status: NOT_RUN
---

# Master implementation prompt

You are implementing Dockside from a specification-only pack. Documents do not prove a repository, product, contract, test, deployment, provider integration, demand, or submission. Build a real production-shaped product; never make the central path work through mocks, seeded database success, hard-coded responses, prerecorded transitions, manual repair, or UI-only enforcement.

## Intake

Read repository instructions and every core document. Inspect the exact checkout, current branch, remotes, dirty changes, worktrees, base SHA, package manifests, lockfiles, toolchain, tests, CI, and environment variable names without printing values. Reconcile proposed stack and commands with the real repository. Verify current official NEAR and 1Click behavior at the actual integration boundary. Stop on contradiction; do not silently weaken the product.

## Governing contract

[CORE-CONTRACT.md](CORE-CONTRACT.md) is authoritative. [CORRIDOR-CONTRACT.md](CORRIDOR-CONTRACT.md) fixes the direct working corridor and blocked mainnet rail. `requirements.json` owns module/test mapping. Preserve stable IDs. Update all affected layers and add regression evidence for any accepted contract change. Never edit an assertion merely to obtain green.

## Real product floor

- Real durable persistence, auth, roles, migrations, restart, audit, and failure recovery.
- Real NEAR testnet contract holding native testnet NEAR and directly releasing the same asset to the bound supplier NEAR testnet account.
- Independently enrolled buyer, supplier and inspector identities in separate proof-of-possession sessions; one operator holding all keys cannot pass.
- Contract-derived EvidencePolicy completeness from every uploader/issuer/content/resource/digest/derived-source/replacement/freshness/cardinality fact signed by the exact revision-bound ManifestAttestor version; wrong-scope, rotated-unbound and revoked keys fail. Actual inspector signature follows that boundary.
- Deterministic policy may SET but never RESOLVE an onchain HoldRecord; only a separate risk/policy principal resolves. Dual-signed CANCEL, objective policy-triggered ABANDON and destination supersession are distinct pre-submit authorities.
- UNKNOWN/REVIEW/reconciliation/adjudication preserve locks; authoritative no-transfer FAILED, late results, contradictions, refund source-bucket restoration and fresh-new-intent rules are real persisted recovery paths.
- The 1Click `dry:true` call is an optional M06 compatibility probe, not part of the `WORKING_TESTNET` floor. Track `NOT_RUN`, `UNKNOWN`, `INCOMPATIBLE`, or `PASS`; only `PASS` permits the independent `DRY_COMPATIBLE` claim and none can establish direct release or payment.
- Durable journal/outbox must exist before callable funded submit; future funded authorization is post-quote, exact and atomically consumed once with refundTo bound to escrow/refund authority.
- Mainnet funded execution remains disabled and `BLOCKED` until separately authorized and fully reconciled.
- UI consumes real backend state and implements [UI-SPEC.md](UI-SPEC.md); no decorative or generic AI-dashboard substitute.
- [REAL-PRODUCT-GATE.md](REAL-PRODUCT-GATE.md) controls `WORKING` claims.

## TDD loop

For each module: verify dependencies; reproduce each owned failure and retain redacted red evidence; implement the smallest complete boundary; run focused and impacted regression suites; inspect persistence/restart/security/UI implications; record commands, exit codes, counts, exact commit and evidence; create a focused local commit if authorized by the invocation. If a test already passes, prove the existing behavior rather than fabricating a failure.

## Quality rules

- Strict types and boundary schema validation; no unchecked dynamic data.
- Integer smallest-unit amounts and explicit asset/network identities.
- Domain-separated canonical signatures, nonces, expiry, versioning, and idempotency.
- Transactional outbox and fenced workers before external effects.
- Missing/private/stale/contradictory/incomplete facts produce `HOLD`, `REVIEW`, or `UNKNOWN`, retain affected locks, and cannot be manually promoted to terminal status; AI output alone never creates or clears an onchain hold.
- Buyers may request and view hold resolution, but only a separately authenticated enrolled risk/policy principal may sign a resolution; buyer, supplier, and inspector signatures fail that capability check.
- Secrets never appear in code, logs, DOM, browser storage, exports, screenshots, or evidence.
- Semantic HTML, WCAG 2.2 AA, responsive verification, and status not color-only.
- No arbitrary command execution, remote URL fetching, or active-content rendering from imported evidence.

## External authority

Implementation inside the explicitly selected local repository does not authorize remote creation, push, PR opening, merge, deployment, wallet signing, funding, paid/provider calls, key/account creation, terms acceptance, visibility changes, publication, social posting, or event submission. Ask for the exact action when its gate is reached. CI green does not authorize merge; deadline does not authorize spending or publication.

## Definition of done

A module is done only when its owned IDs are implemented and genuinely tested, dependency/regression suites remain green, migrations and docs match, threat implications are reviewed, actual-boundary evidence exists, and the handoff is reproducible. The product is working only after M09 proves the real gate from a clean checkout and installed artifact. An event demo is then recorded from that build.
