# Dockside Test Plan

All cases are specifications. Product test status is **NOT_RUN**. Every future result records command, environment, exact commit/artifact, real versus simulated dependencies, exit code, counts and redacted evidence. No mock satisfies a real-product case.

## Foundation

### T-001 — Canonical identity is stable

Status: **NOT_RUN**

Property-test canonical agreement bytes across field order, Unicode, address display forms, restart and supported platforms; material changes must change identity.

### T-002 — Schema and unknown fields fail closed

Status: **NOT_RUN**

Reject unsupported versions, duplicate keys, ambiguous addresses, unknown material fields, malformed lengths and resource-limit violations.

## Organization and authority

### T-003 — Integrated authority matrix denies cross-role action

Status: **NOT_RUN**

After every contract/service module exists, exercise buyer, supplier, inspector, risk, auditor, executor, revoked and unauthenticated actors against actual API and contract boundaries.

### T-004 — Organization bootstrap proves key possession

Status: **NOT_RUN**

Verify origin/org/role/nonce/expiry-bound challenge, actual wallet signature, replay denial and a distinct enrolled key version.

### T-005 — Invitation and role grant require separate sessions

Status: **NOT_RUN**

Use one-time hashed scoped invitation, recipient proof in its own session and later administrator grant; reject self-consumption, replay, wrong org and role escalation.

### T-006 — Revocation and recovery preserve history

Status: **NOT_RUN**

Revoke, rotate and recover human, ManifestAttestor and deterministic-policy service keys under delay; require PoP, scoped grants and isolated service custody, block new signatures, preserve historical verification and require explicit dual-signed trade revision plus downstream reauthority for active attestor changes.

## Escrow, abnormal funding and refund

### T-007 — Exact direct testnet funding is accepted

Status: **NOT_RUN**

Deploy actual NEAR testnet contract, fund native testnet NEAR from a recorded funder, read state and later release the same asset directly to the bound supplier testnet account.

### T-008 — Partial excess and unexpected assets are isolated

Status: **NOT_RUN**

Keep partial funding unavailable, quarantine excess by original funder and refuse to credit unexpected assets to the native-NEAR ledger.

### T-009 — Refund and cancellation paths bind original funder

Status: **NOT_RUN**

After M02 and M03 exist, exercise expiry, inspector fail, permanent-hold resolution, mutual cancel, buyer/supplier/inspector key loss, partial funding and excess funding against `dockside-refund-v1` revision 1; verify exact initiator, signatures, clock, delay, evidence, challenge/appeal, eligible amount, original-funder recipient, source bucket, revocation and UNKNOWN/REVIEW recovery.

### T-010 — Concurrent release and refund preserve conservation

Status: **NOT_RUN**

Race direct release, refund authorization/execution, destination activation and cancellation; exactly one economic lock wins and per-asset/per-funder conservation holds.

### T-050 — Refund policy reason matrix is enforced

Status: **NOT_RUN**

At the integrated M04 boundary, mutate every row's reason, policy revision, initiator, signer capability, clock origin/duration, evidence, appeal state, eligible amount, original-funder recipient, source bucket and revocation phase. Include inspector FAIL and permanent HoldRecord facts from M03. Against every reason row, exercise release states `SUBMITTING`, `PROCESSING`, `UNKNOWN`, `REVIEW`, `RECONCILING`, and `ADJUDICATION`; the contract rejects execution throughout challenge or any unresolved payout/refund state and accepts only the exact current policy row.

### T-051 — Unexpected assets remain outside refund state

Status: **NOT_RUN**

Send an unsupported token/asset to every reachable boundary. Prove it never increments native-NEAR funded, available, reserved, refundable or conservation fields; native refund entry points reject it, while a separate auditable `ASSET_RECOVERY_REVIEW` record exposes no unilateral withdrawal or fabricated original funder.

## Evidence, holds and inspection

### T-011 — Evidence policy requires complete fresh slots

Status: **NOT_RUN**

Test empty, missing, stale, over/under-cardinality, wrong type and complete EvidencePolicy manifests; only the complete current manifest is inspectable.

### T-012 — Unauthorized uploader or issuer is rejected

Status: **NOT_RUN**

Use wrong/revoked uploader and issuer capabilities, forged issued-at values and cross-trade items; no item fills a policy slot.

### T-013 — Evidence replacement is revisioned and concurrent-safe

Status: **NOT_RUN**

Race compare-and-swap replacements, preserve history, surface conflict and invalidate predecessor attestations/approvals.

### T-014 — Model output cannot mutate hold authority

Status: **NOT_RUN**

Return pass-like, hold-like, malicious, delayed and malformed model output; it can create an advisory finding only and cannot call/set/clear contract authority.

### T-015 — Active hold blocks direct contract release

Status: **NOT_RUN**

Create actual onchain HoldRecords through enrolled deterministic-policy SET and risk/policy SET capabilities, then call the release contract entry point directly and prove active or expired-unresolved holds reject release. API, UI and optional-executor denial are separate downstream tests.

### T-016 — Hold resolution and expiry fail closed

Status: **NOT_RUN**

Reject deterministic-policy, buyer, supplier, inspector and wrong/revoked risk resolver signatures plus wrong reason/revision/manifest/nonce and expired resolution; hold expiry becomes EXPIRED_UNRESOLVED until a valid signed risk/policy resolution or allowed supersession.

### T-017 — Only enrolled inspector can attest complete manifest

Status: **NOT_RUN**

Verify actual independent inspector signature against current complete manifest; reject buyer-controlled, wrong, revoked, expired and stale keys/manifests.

### T-018 — Changed evidence invalidates attestation

Status: **NOT_RUN**

Add, remove, replace or stale a required item; manifest digest changes and predecessor attestation cannot authorize release.

### T-049 — Manifest attestation cannot be forged or stale

Status: **NOT_RUN**

At the direct contract boundary, mutate each predicate independently: uploader identity/capability/key, issuer identity/capability/key, detected MIME/content class, per-item/aggregate bytes, page/pixel/decompressed-byte/ratio/parse-time resource facts and parser profile, original item digest, every derived artifact class/digest/source-original binding, replacement predecessor/currentness/version, issued/captured time, freshness deadline and min/max cardinality. Also try `complete=true`, compromised projection, missing slot/policy facts, stale policy/schema, altered manifest/manifest revision, expiry/replay, wrong-but-enrolled attestor, cross-org/trade/policy scope, rotated but unbound key, revoked key and recovered key without a new revision. Only the exact ManifestAttestor enrollment/key/capability bound into the signed active revision and policy can pass contract recomputation.

## Integrated release and destination

### T-019 — Release requires integrated complete authority

Status: **NOT_RUN**

Enumerate incomplete manifest, invalid inspection, active/expired hold, wrong approval, wrong profile/recipient and consumed value; only the exact complete conjunction releases.

### T-020 — Unilateral destination change is rejected

Status: **NOT_RUN**

Attempt change as every role, compromised UI/API, database operator and direct caller; no unilateral path alters active destination.

### T-021 — Dual-consent delayed change invalidates release facts

Status: **NOT_RUN**

Use separate buyer/supplier sessions, wait enforced delay and prove old manifest, hold view, attestation, release intent, funded authorization and approval remain invalid.

### T-022 — Stable release intent locks exact value

Status: **NOT_RUN**

Create random releaseIntentId independent of quote/revision/attempt, reserve exact value and verify child quote/attempt correlation plus duplicate joins.

### T-023 — Unresolved release intent blocks competing actions

Status: **NOT_RUN**

While `SUBMITTING`, `PROCESSING`, `UNKNOWN`, `REVIEW`, `RECONCILING`, and `ADJUDICATION`, reject quote renewal, new intent, second submit, destination activation, cancel, abandon, supersede, refund and reservation release for locked value.

### T-046 — Pre-submit intent exits release or transfer reservation

Status: **NOT_RUN**

From every pre-submit state, test CANCEL only with matching buyer-approver and supplier-signer canonical payload digests, role-bound consents, distinct request/role/revocation nonces and current expiries; one signature, disagreement, self/other-party consent revocation, every unauthorized role, wrong value/state/destination/source bucket, replay and stale/revoked signatures leave the lock unchanged. Test ABANDON only for the designated buyer release approver or supplier signer after the exact trade-bound expiry trigger and grace; reject administrator, deterministic-policy, risk, inspector, executor, ManifestAttestor, scheduler, early, subjective, wrong-policy, wrong-scope, replayed and stale/revoked-key requests. Race each exit with submit and supersession; one atomic winner restores the exact source bucket or transfers to one successor, invalidates predecessor authority, and never exposes value twice.

### T-047 — Destination activation supersedes only pre-submit intent

Status: **NOT_RUN**

Activate an authorized dual-party destination revision against each release-intent state. Only a pre-submit intent becomes `SUPERSEDED_PRE_SUBMIT` with one atomic successor/reservation transfer. `SUBMITTING`, `PROCESSING`, `UNKNOWN`, `REVIEW`, `RECONCILING`, `ADJUDICATION` and terminal states reject activation; a late receipt remains bound to the original intent and cannot enable a second payout.

## Payout readiness and funded authorization

### T-024 — Dry quote uses exact bound final recipient

Status: **NOT_RUN**

Run pinned official client against real 1Click dry endpoint; verify future final recipient, networks/assets, amount and refundTo escrow authority, with redacted evidence.

### T-025 — Dry quote never becomes release or paid evidence

Status: **NOT_RUN**

Across contract, API, database, UI and export, dry success cannot satisfy direct release, submitted, processing, paid or destination-received.

### T-026 — Funded authorization binds every economic field

Status: **NOT_RUN**

Canonicalize/sign release intent, quote/digest, deposit address, final recipient, networks/assets, input/min output, fees, slippage, cap, refund authority, nonce and expiry; mutate each field and reject.

### T-027 — Funded authorization and refund authority consume atomically

Status: **NOT_RUN**

Race duplicate consumption and changed quote; exactly one atomic consume can transfer to deposit address and provider refund must target escrow/refund authority, never executor.

### T-048 — Dry compatibility claim is orthogonal

Status: **NOT_RUN**

Exercise `NOT_RUN`, timeout/schema ambiguity as `UNKNOWN`, verified incompatibility as `INCOMPATIBLE`, and a valid live probe as `PASS`. Only `PASS` may expose `DRY_COMPATIBLE`; no state changes release-intent state, direct testnet readiness, escrow value, `WORKING_TESTNET`, funded authorization, processing, paid or destination receipt.

### T-055 — Optional executor cannot bypass hold

Status: **NOT_RUN**

When M06 exists, attempt dry preparation, funded authorization consumption and callable submit under active or expired-unresolved HoldRecords, including stale API projections and direct worker messages. Dry may record compatibility only; no authorization or economic submit bypasses the contract hold predicate. If M06 is not implemented, this test remains honestly `NOT_RUN` and is not part of `WORKING_TESTNET`.

## Journal and reconciliation

### T-028 — Accepted then lost response remains unknown

Status: **NOT_RUN**

Lose response after possible external acceptance; keep original release intent/value lock UNKNOWN and infer neither failure nor retry.

### T-029 — Restart resumes reconciliation without resubmit

Status: **NOT_RUN**

Kill processes at intent/outbox/submit/observation/UNKNOWN/REVIEW/reconciliation/adjudication and refund boundaries; restart from real persistence with the same locks, source buckets and identities and without a second economic submit.

### T-030 — Late provider refund reconciles conservation

Status: **NOT_RUN**

Reconcile duplicate/late/short provider refund to quote-bound escrow/refund authority, then original funder ledger, idempotently; short or contradictory value remains locked/quarantined in REVIEW.

### T-031 — Paid requires authoritative destination evidence

Status: **NOT_RUN**

Provider success, source transaction, wrong recipient/asset, missing/private receipt, contradictory refund and valid finalized destination receipt remain distinct; only complete evidence yields PAID, while contradictions retain the lock in REVIEW.

### T-032 — Late receipt cannot authorize a second payout

Status: **NOT_RUN**

Deliver success/refund after UNKNOWN/REVIEW and contradictory evidence after authoritative FAILED; bind everything to the original intent, freeze any successor on post-FAILED contradiction, retain or quarantine value exactly, and prove no second payout becomes authorized.

### T-056 — Post-submit failure and review preserve value lock

Status: **NOT_RUN**

Across restart and worker races, prove REVIEW/RECONCILING/ADJUDICATION retain the reservation and cannot be manually promoted. Accept FAILED only with final non-acceptance plus escrow no-transfer proof, atomically restore original per-funder available amounts, invalidate the old intent/approval, deny old-attempt resubmit and require a new intent/fresh approval. Provider error after transfer remains unresolved.

### T-057 — Refund uncertainty and revocation restore exact bucket

Status: **NOT_RUN**

Revoke each refund before execution and restore its recorded sourceBucket, including excess strictly to QUARANTINED. Kill/restart at refund submit and reconciliation boundaries; exercise `UNKNOWN -> RECONCILING|PROCESSING|REFUNDED|FAILED|REVIEW` plus REVIEW/reconciliation/adjudication outgoing transitions, authoritative non-transfer FAILED and fresh-new-intent requirement, late original-funder receipt, and contradictory success/failure without blind retry or bucket drift.

## Integrated API and audit

### T-033 — Audit export binds all revisions and authorities

Status: **NOT_RUN**

Verify checksummed export links org/key versions, manifests, holds/resolutions, release intent, approvals, quote/auth, attempts, refunds and receipt with honest exclusions.

### T-034 — Secrets and private evidence are redacted

Status: **NOT_RUN**

Inject canary secrets through all boundaries and assert absence from logs, traces, API history, DOM/storage, accessible names, screenshots and default exports.

### T-035 — Concurrent workers cannot duplicate authority

Status: **NOT_RUN**

Race outbox/reconciliation leases, role/key actions, hold resolution, release/refund and export; fencing/optimistic versions permit one mutation and idempotent joins.

### T-052 — Only risk or policy principal resolves hold

Status: **NOT_RUN**

The buyer may create and view a non-authorizing resolution request. Against API and direct contract boundaries, reject resolution signatures from deterministic-policy service, buyer, supplier, inspector, ManifestAttestor, auditor, executor, revoked risk key and a risk principal reusing another session. Accept only a current separately authenticated enrolled risk/policy resolver whose exact reason, hold, trade/revision, manifest, nonce and expiry verify.

### T-053 — Integrated API denies release under hold

Status: **NOT_RUN**

With M03/M04/M05 present, call every API release path as each role while a HoldRecord is active or expired-unresolved. Typed API, authority projection and direct fallback all preserve the contract denial; no feature flag, stale cache, admin or idempotency replay submits an operation.

## Professional interface

### T-036 — Fresh user completes real product workflow

Status: **NOT_RUN**

With independent buyer, supplier, inspector and risk/policy sessions plus isolated revision-bound ManifestAttestor/deterministic-policy identities and actual backend, bootstrap, sign, fund and complete every policy predicate; deterministic policy SETS but cannot RESOLVE a hold, the buyer requests/views resolution, risk/policy resolves, inspector attests, and buyer locks/approves before direct native testnet NEAR release.

### T-037 — Evidence policy recovery is understandable

Status: **NOT_RUN**

At all widths, missing/stale/unauthorized/resource-exceeding/wrong-scope-attestor-key/concurrent slots show exact predicate, attestor lifecycle impact and recovery, preserve work and never look complete.

### T-038 — Unknown review and dry cannot look paid

Status: **NOT_RUN**

Semantic and visual assertions distinguish `WORKING_TESTNET`, all independent dry states, funded auth, processing, unknown, locked review/reconciliation/adjudication, authoritative failed/no-transfer disposition, paid, provider refund and destination receipt without color-only meaning.

### T-054 — UI preserves hold denial and resolver separation

Status: **NOT_RUN**

Actual-backend browser tests show active and expired-unresolved holds blocking release. Buyer may request/view, deterministic-policy may SET only, and only the separate risk/policy session receives resolution signing UI. Disabled/absent controls, API denial and accessible status remain coherent at every required viewport.

### T-039 — Keyboard and screen reader complete critical flow

Status: **NOT_RUN**

Manually verify supported assistive pairs for bootstrap/invite, evidence recovery, hold resolution, destination diff, approval, refund conflict, unknown reconciliation and export.

### T-040 — Responsive states remain operable

Status: **NOT_RUN**

Verify 375, 768, 1024, 1440 CSS px, 200% zoom, reduced motion, long addresses, all loading/error/blocked states and no body overflow.

## Real product and delivery

### T-041 — Conservation property survives generated sequences

Status: **NOT_RUN**

Generate funding/quarantine/reservation/release/refund/fee/unknown/review/reconciliation/adjudication/authoritative-failure/late/contradictory events per asset and funder; enforce source-bucket restoration, successor freeze, updated conservation and economic locks.

### T-042 — Adversarial redirection path is reproducible

Status: **NOT_RUN**

On actual build, deny forged change through UI/API/contract, then complete legitimate independent dual consent/delay and renewed full authority.

### T-043 — Clean checkout reproduces testnet corridor

Status: **NOT_RUN**

Fresh supported machine builds, migrates, deploys, uses independent buyer/supplier/inspector/risk principals plus isolated bound ManifestAttestor/deterministic-policy identities, completes every predicate and CANCEL/ABANDON/recovery denial, and completes the direct native testnet NEAR corridor without repair. M06/dry may remain `NOT_RUN`, `UNKNOWN`, or `INCOMPATIBLE` and cannot fail this core claim.

### T-044 — Installed artifact preserves safety controls

Status: **NOT_RUN**

Test packaged service/worker/web/contract artifacts, network allowlists, secrets, migrations, restart and funded profile blocked by default.

### T-045 — Submission evidence matches exact build

Status: **NOT_RUN**

Repository SHA, artifact digest, contract code hash/account, documented commands and recording refer to the same tested build and exact capability labels.
