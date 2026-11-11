---
project: Dockside
version: 2.0.0
artifact_status: SPECIFICATION_ONLY
product_runtime_status: NOT_RUN
---

# Technical Design Document

## 1. Architecture objective

Dockside separates immutable trade authority, private evidence, external payout execution, and reconciliation. The NEAR contract is the non-bypassable release authority for escrowed value. The web application never upgrades a provider label or model response into contract authority. The executor is treated as fallible and potentially compromised; it receives only operation-scoped ability after contract and policy authorization.

## 2. Proposed stack

Exact versions are decisions to confirm against the implementation repository and official compatibility at intake.

| Layer | Proposed technology | Boundary |
|---|---|---|
| Contract | Rust NEAR smart contract with pinned SDK | Escrow, identities, approvals, destination revisions, release authorization |
| Service | Node.js LTS and TypeScript strict mode | API, canonicalization, policy, audit, provider adapter |
| Durable store | PostgreSQL with transactional outbox | Agreements, evidence metadata, operations, reconciliation, audit events |
| Object evidence | Encrypted S3-compatible storage or documented local equivalent | Bounded files; database stores digest and locator, never executable content |
| Optional executor | Separate TypeScript worker identity | Independent 1Click dry compatibility and separately enabled funded profile; not needed for WORKING_TESTNET |
| Web | Next.js/React with typed API client | Role-aware operations interface; no client-owned decisions |
| Tests | Rust unit/sandbox tests, TypeScript unit/property/integration, browser E2E, accessibility | Real testnet and provider dry probes remain separate evidence suites |

Do not introduce a second payout architecture. Chain Signatures may be evaluated later but are not part of this pack.

## 3. Components and trust boundaries

1. **Web client:** untrusted display/input boundary. It cannot calculate authoritative release readiness.
2. **Control API:** authenticates actors, validates schemas, derives canonical digests, and reads materialized state.
3. **Trade contract:** authoritative escrow and approval state. It verifies registered keys/accounts and prevents duplicate release.
4. **Evidence service:** streams bounded bytes through hashing and scanning; stores encrypted content and immutable metadata.
5. **Analysis worker:** deterministic checks plus optional model call. Model output can propose a finding only. An enrolled deterministic-policy capability may SET an onchain HoldRecord but can never resolve one; only a separately authenticated enrolled risk/policy signer may RESOLVE it.
6. **Executor:** obtains quotes and, only under separately enabled policy, submits an exact authorized payout operation.
7. **Reconciler:** polls/read-checks authoritative sources and advances payout facts monotonically.
8. **Audit exporter:** produces role-filtered manifests and digests from committed records.

Every network call has explicit origin allowlist, timeout, byte limit, schema, redaction, correlation, retry class, and cancellation policy. Imported content and provider text are data, never instructions.

## 4. Identity and organization model

`tradeId` is random and immutable. `tradeRevision` increments on any authorized material change. Canonical agreement serialization is versioned, length-prefixed, typed, and deterministic. Its digest covers:

- buyer and supplier account/key identities;
- escrow contract and network;
- asset, amount, milestone, fees, and refund policy;
- enrolled inspector key and attestation schema;
- bound ManifestAttestor enrollment ID, service identity, public-key version, `MANIFEST_ATTEST` capability, organization/trade/EvidencePolicy scope, and attestation schema;
- deterministic-policy setter and separate risk/policy resolver capability identities;
- payout network, recipient type, and full supplier destination;
- evidence policy, delay policy, and expiry;
- schema/profile versions.

Addresses are normalized only by a chain-specific, version-pinned codec; display formatting never changes signed bytes. Unknown material fields fail closed. A changed material field creates a new revision; prior signatures and approvals do not carry forward.

Organization bootstrap begins with a wallet proof-of-possession challenge bound to service origin, organization identity, role request, nonce, issued time, and expiry. Invitations are one-time, hashed at rest, scoped to an organization and intended capability, expire, and require the recipient to prove control of its own key in a separate authenticated session. An authorized organization administrator grants the proposed role only after that proof. Buyer approval, supplier consent, inspector attestation, deterministic-policy SET, and risk/policy resolution use distinct capabilities; one browser session cannot impersonate another capability.

A ManifestAttestor is an enrolled service principal, not any API process that can calculate a manifest. An organization security administrator creates an enrollment only after a domain-separated proof-of-possession challenge binds organization, service identity, public key, key version, requested `MANIFEST_ATTEST` capability, allowed EvidencePolicy IDs/revisions, optional trade scope, nonce, origin, issued time, and expiry. The private signing key stays in an isolated signer/HSM or equivalent secret boundary and never enters the browser, general API process, database, log, or export. Grant activation, rotation, revocation, and recovery are separately audited authority events.

Every signed trade revision names exactly one allowed ManifestAttestor enrollment ID, service identity, public key/version, capability, organization/trade/policy scope, and schema. Buyer and supplier signatures therefore accept that oracle identity. A key that is enrolled for another trade, policy, revision, organization, or capability is unauthorized. Rotation creates a new version but does not affect an active revision: using it requires a new dual-signed trade revision, fresh manifest attestation, inspection, release intent, and approval. Revocation immediately blocks new signatures and invalidates unconsumed attestations; previously consumed attestations remain historically verifiable. Recovery follows the same new-version and trade-revision rule and never silently substitutes an attestor.

Revocation blocks new signatures immediately but does not rewrite historical signature validity. Recovery enrolls a new versioned key under the organization's recovery policy and delay. It never silently replaces a supplier, inspector, destination, or approver inside an active trade; that requires an explicit revision and renewed authority. Normal product acceptance requires separately enrolled buyer, supplier, inspector, and risk/policy principals and sessions. A single operator controlling all test keys can exercise unit paths but cannot satisfy INV-13 or WORKING_TESTNET acceptance.

## 5. Contract model

### Contract records

- `Trade`: current revision, participants, native testnet NEAR corridor, per-funder funded/reserved/released/refunded/quarantined amounts, and state.
- `Revision`: digest, terms, signatures, created/activated times, predecessor.
- `EvidencePolicy`: required slot definitions; allowed uploader/issuer capabilities; MIME/content classes; byte and parser-resource limits; required original and derived artifacts/source bindings; cardinality; issued/freshness rules; replacement/currentness rules; schema; and the exact allowed ManifestAttestor enrollment/key version/capability/scope.
- `EvidenceCommitment`: manifest revision, slot/digest commitments and policy identity only; private bytes never go onchain and no caller completeness flag is stored as authority.
- `ManifestAttestation`: trade/revision, policy ID/revision, manifest revision/digest, ordered complete slot/item facts, expiry, bound ManifestAttestor enrollment/capability/key version, nonce and signature; the contract derives completeness.
- `HoldRecord`: trade/revision/manifest, reason, issuer capability/key, issued time, expiry, resolution status and signed resolution.
- `InspectionAttestation`: trade/revision/milestone/complete manifest digest, decision, expiry, inspector key, signature.
- `ReleaseIntent`: stable random ID, exact locked value and per-funder source-bucket slices, recipient snapshot, state and child quote/attempt references.
- `ReleaseIntentExitAuthorization`: action `CANCEL|ABANDON`, exact intent/value/state version/destination/source-bucket digest, reason or objective trigger, policy/not-before, signer capabilities/key versions, nonces, expiries, signatures and consumption state.
- `BuyerApproval`: exact release intent, amount, direct testnet recipient or funded-authorization digest, attestation, holds view, execution profile, expiry, buyer key, signature.
- `DestinationChange`: proposed destination, buyer consent, supplier consent, activation time, status.
- `FundedPayoutAuthorization`: release intent, selected quote/deposit address, final recipient, networks/assets/amount/output/fees/slippage/cap, refund authority, nonce, expiry, signer, consumption state.
- `EconomicAttempt`: release intent, operation/attempt identity, amount, destination/quote binding, state, transaction identity.
- `RefundIntent`: original funder, refundable deposit slice, exact source bucket, reason, authorities, timelock, unresolved/terminal state and transaction identity.
- `UnexpectedAssetRecovery`: separate policy/revision, asset/transaction identity, claimed sender proof, exact observed balance, risk/policy authorization, challenge deadline, recipient, state and transaction identity; never a native-NEAR refund row.

### Contract calls

- create and accept a revision;
- receive native testnet NEAR and bind each deposit to its original funder;
- propose, consent to, cancel, and activate destination revision;
- verify/store evidence-policy manifest commitment and the exact revision-bound ManifestAttestor signature, then enrolled inspector attestation;
- SET HoldRecords through an enrolled deterministic-policy service or risk/policy principal, and RESOLVE them only through the separate enrolled risk/policy principal;
- create a release intent, approve its exact direct or funded release, and atomically cancel, abandon, or supersede it only before submit;
- execute one idempotent direct testnet release to the bound supplier testnet account;
- consume one exact funded authorization before a future mainnet transfer to the selected 1Click deposit address;
- request, authorize, execute and reconcile refunds only under the original-funder policy and economic lock;
- query authoritative state.

The final callable interface must be derived from actual NEAR SDK and token standards during intake. These are behavioral responsibilities, not invented method signatures.

## 6. Release decision

Release readiness is a deterministic conjunction:

```text
current revision active
AND escrow balance sufficient
AND destination delay complete
AND current EvidencePolicy completeness derived by the contract from every signed predicate of the exact revision-bound ManifestAttestor key version
AND inspector PASS signature valid and unexpired for that manifest
AND no applicable ACTIVE or EXPIRED_UNRESOLVED HoldRecord
AND stable release intent owns the exact value lock
AND buyer approval valid and unexpired for that release intent
AND amount, execution profile, and destination equal approval
AND funded profile additionally has one exact unconsumed FundedPayoutAuthorization
AND no prior economic operation or refund consumes the value
```

Model output is not a term in positive authorization and cannot write or clear a HoldRecord. An enrolled deterministic-policy service may convert a deterministic rule violation into a signed HoldRecord but cannot resolve it. A separately authenticated enrolled risk/policy role may SET a HoldRecord under policy and is the only role that may RESOLVE one. A buyer session may request and view resolution but its signature has no resolver capability. Absence, failure, or expiry of analysis cannot produce pass. Direct contract release executes the same hold predicate and fails while any applicable hold is active or expired-unresolved.

## 7. Destination-change protocol

1. An authorized actor proposes a new normalized destination and reason.
2. System creates a new pending revision; the current destination remains effective.
3. Buyer and supplier sign the same pending digest using separate enrolled keys.
4. A configurable minimum delay begins only after both valid consents.
5. The UI and API expose the old and new destinations, time, actors, and consequences.
6. If an intent is in a pre-submit state, activation atomically moves it to `SUPERSEDED_PRE_SUBMIT` and transfers its reservation into a new intent under the new revision; no value becomes simultaneously available.
7. Activation is forbidden while a release intent is `SUBMITTING`, `PROCESSING`, `UNKNOWN`, `REVIEW`, `RECONCILING`, or `ADJUDICATION`, and after a terminal payout/refund disposition; it cannot supersede or release that reservation.
8. At activation, prior evidence manifest, ManifestAttestation, inspector attestation, HoldRecord view, funded authorization, and buyer approval are invalid for the new revision.
9. A complete replacement manifest, new ManifestAttestation, new inspection attestation, new release intent, and buyer approval are required.
10. A conflicting proposal, revoked consent, expired signature, or changed digest fails closed.

No administrator, support role, executor, model, database flag, or UI control may bypass this protocol.

## 8. Evidence and inspection

Uploads are streamed; allowed MIME is verified from content, not extension. Limits cover per-file bytes, total bytes, pages, image pixels, decompression ratio, parse time, and count. Active content is never executed. The original digest is computed before transformation. Derived OCR/text has its own digest and provenance.

Each trade revision carries an `EvidencePolicy`. A required slot defines stable slot ID, purpose, minimum and maximum cardinality, permitted MIME/content classes, per-item and aggregate byte limits, parser-resource limits such as page/pixel/decompressed-byte/decompression-ratio/parse-time ceilings, allowed uploader capabilities, allowed issuer identities/capabilities, issued-at field rule, freshness duration, replacement/currentness rule, required original digest, required derived artifact classes and source binding, and schema/profile versions. The policy also names the one allowed ManifestAttestor enrollment ID, service identity, key version, capability, organization/trade/policy scope, signature algorithm, and attestation lifetime. The first working corridor requires exactly one current item for each configured commercial-document slot and one signed inspection-report slot; implementation intake names the concrete slot set and cannot leave it empty.

An evidence manifest is a versioned compare-and-swap aggregate of slot/item digests. Completeness is deterministic. Empty, missing, over-cardinality, unauthorized, superseded, concurrently replaced, or stale slots produce `INCOMPLETE` or `REVIEW`; they cannot be signed as complete or become release-ready. Replacement creates a new manifest revision, preserves history, and invalidates any attestation and approval bound to the predecessor. Concurrent replacement against a stale manifest version fails and the UI must guide the user to refresh and review the diff.

Completeness crosses the contract boundary only through a `ManifestAttestation` signed by the exact ManifestAttestor bound into the active trade revision and EvidencePolicy. Its canonical unsigned payload header contains chain/contract domain, organization, trade/revision, EvidencePolicy ID/revision/schema digest, manifest revision/digest/currentness version, attestor enrollment ID/service identity/key version/capability/scope, issued time, expiry, and nonce; the envelope adds the signature over that payload and the ordered slot/item facts below.

For every required slot, its ordered signed facts contain the slot ID and slot-policy digest, item count, replacement/currentness version, and for every item: immutable item ID; original byte digest; uploader identity/capability/key version; issuer identity/capability/key version; detected MIME/content class; actual byte length; bounded resource measurements required by that slot (page count, pixel count, decompressed bytes/ratio, parse time and parser/scanner profile); issued/captured time and computed freshness deadline; predecessor/replacement identity and current item version; and every required derived artifact's class, digest, transformation profile, and source-original digest. The manifest digest is recomputed over these ordered facts rather than accepted independently.

The contract stores or commits the current policy rules and active manifest commitment. It verifies the bound nonrevoked attestor identity/key/capability/scope and signature; exact organization/trade/revision/policy/schema; nonce and expiry; item and manifest digests; uploader and issuer rules; MIME/content classes; bytes/resource ceilings; original-to-derived source bindings; replacement/currentness; issued/freshness times; and min/max cardinality. It then derives completeness. It accepts no `complete=true`, API projection boolean, differently scoped enrolled attestor, or unbound rotated key. Revocation before consumption invalidates an unconsumed manifest attestation; historical consumed evidence remains auditable. This attestation proves attribution to the declared oracle and predicates, not independent truth of private bytes; inspector review and audit disclose that trust boundary.

The attestation canonical form contains trade ID, revision, milestone, EvidencePolicy version, complete manifest digest, decision `PASS|FAIL|REVIEW`, bounded reason codes, inspector key, schema, issued time, expiry, and nonce. The API verifies enrollment, independent inspector capability, signature, current revision, manifest completeness, replay protection, and expiry before recording.

Optional AI analysis receives only policy-approved material. It produces untrusted structured findings with model/provider/version and source references. AI output alone cannot write or clear onchain authority. An enrolled deterministic-policy service can only SET a HoldRecord from a versioned deterministic rule result; it cannot RESOLVE any HoldRecord. A separately authenticated risk/policy principal may SET or RESOLVE one under organization policy. Deterministic-policy, buyer, supplier and inspector resolution signatures fail the resolver capability check. A HoldRecord binds hold ID, trade, revision, manifest digest, reason code, issuer capability/key, issued time, expiry, nonce and signature. Resolution binds hold ID, current revision/manifest, resolver capability/key, resolution code, evidence, issued time, expiry, nonce and signature. Expiry never auto-clears: it becomes `EXPIRED_UNRESOLVED` and continues to block until valid risk/policy resolution or superseding trade revision policy.

Direct contract release, future funded authorization consumption, cancellation and refund eligibility each read the authoritative HoldRecord state. A hold cannot be bypassed by deleting an offchain finding, changing a projection, or calling the contract directly.

## 9. Payout adapter

The exact corridors are authoritative in [CORRIDOR-CONTRACT.md](CORRIDOR-CONTRACT.md). `WORKING_TESTNET` releases native testnet NEAR directly from the escrow contract to the contract-bound supplier NEAR testnet account. It never routes through 1Click. The optional 1Click adapter produces a separate compatibility claim and is not evidence for that product state.

### Dry compatibility profile

The adapter uses the exact official client/profile pinned at intake. It requests `dry:true` with immutable origin/destination asset and networks, amount, final recipient, recipient/refund types and addresses, slippage, fees, deadline, and supported configuration. `refundTo` must be the escrow/refund authority, never the executor. The adapter records a redacted canonical request digest, response digest, quote/deposit-address facts, provider identity, timestamps, expiry, route facts, and compatibility outcome. `DryCompatibilityStatus` is an orthogonal child fact with values `NOT_RUN`, `UNKNOWN`, `INCOMPATIBLE`, or `PASS`; `PASS` supports the optional `DRY_COMPATIBLE` claim only. It does not acquire authority to transfer funds, satisfy direct testnet release readiness, or set a payment state.

### Funded profile

This profile is `BLOCKED` by default and cannot be enabled by a browser flag. Activation requires verified corridor support, deployed configuration, operation-scoped credentials/signing authority, exposure cap, exact mainnet network, refund authority, and separate user authorization. The durable journal/outbox from M05 must exist before any callable funded submit is introduced.

The contract cannot call REST. The executor obtains a quote, then the buyer signs a post-quote `FundedPayoutAuthorization` containing releaseIntentId, trade/revision, quote ID/digest, deposit address, final recipient, origin/destination networks and assets, input amount, minimum output, fees, slippage, exposure cap, refundTo/refund authority, nonce, expiry, signer and signature. At consumption the contract rechecks active revision, release intent/value lock, complete authority, quote expiry, exposure cap, exact deposit address and unconsumed nonce, then atomically marks the authorization consumed and transfers the exact origin value to the quote deposit address. A timeout becomes `UNKNOWN`; no quote renewal, refund, destination activation, new release intent or second deposit is allowed while unresolved. If these semantics cannot be verified, funded mainnet remains blocked.

## 10. Persistence model

Core tables or equivalent aggregates:

- `organizations`, `invitations`, `actors`, `key_versions`, `role_grants`, `proof_challenges`, `sessions`, `manifest_attestor_enrollments`, `service_key_versions`;
- `trades`, `trade_revisions`, `signatures`, `funding_deposits`, `funder_ledgers`, `contract_observations`;
- `evidence_policies`, `evidence_slots`, `evidence_objects`, `evidence_manifests`, `manifest_attestations`, `analysis_findings`, `hold_records`, `hold_resolution_requests`;
- `inspector_attestations`, `release_intents`, `release_intent_exit_authorizations`, `buyer_approvals`, `destination_changes`, `refund_intents`, `unexpected_asset_recoveries`;
- `payout_quotes`, `funded_payout_authorizations`, `payout_operations`, `payout_attempts`, `provider_observations`, `destination_receipts`;
- `outbox`, `worker_leases`, `audit_events`, `export_manifests`.

Rows carry stable ID, schema version, created/observed/recorded time, actor or worker identity, revision, and optimistic concurrency version. Append-only facts are never overwritten. Derived projections can rebuild from authoritative records.

## 11. Release intent, journal and idempotency

`releaseIntentId` is a stable random identity created once when exact escrow value is reserved for one release. It is independent of quote, revision number, transport request and attempt IDs, while binding a snapshot of trade/revision, asset, amount, final recipient and execution profile. Quotes and attempts are children. Before any submit boundary, an expired quote can be replaced under the same release intent only when no funded authorization exists and all bound trade facts remain unchanged.

An `operationDigest` covers release intent, release authorization, amount/asset, bound recipient, selected quote/profile identity, and operation type. The first accepted request atomically writes operation plus outbox. Exact repeats return existing identity. Reuse with changed material fails with conflict. Workers acquire fenced leases; only the current epoch may mutate worker-owned state.

`CANCEL` and `ABANDON` are different authorities, not UI synonyms:

- **CANCEL** is a voluntary retirement of an otherwise live pre-submit release intent. A domain-separated `CancelReleaseIntent` payload contains chain/contract, organization, trade/revision, releaseIntentId, expected state/version, asset/amount, destination snapshot digest, reservation source-bucket digest, bounded reason code, request nonce, issued time, and expiry. The designated buyer release approver and supplier signer each attach a `CancelConsent` over that identical payload digest plus their signer role, capability, key version, distinct role nonce, consent issued time, and consent expiry. Either party may sign a domain-separated `RevokeCancelConsent` over the payload digest, its own consent nonce, revocation nonce, issued time, and expiry before atomic execution. Without both current, nonrevoked consent signatures over one payload, disagreement leaves the intent and reservation unchanged; CANCEL does not cancel the trade or authorize refund.
- **ABANDON** retires an objectively stale pre-submit intent under the abandonment policy already signed into the trade revision. Only the designated buyer release approver or supplier signer may sign `AbandonReleaseIntent`; there is no administrator, deterministic-policy, risk, inspector, executor, ManifestAttestor, or scheduler authority. The canonical payload contains chain/contract, organization, trade/revision, releaseIntentId, expected state/version, asset/amount, destination snapshot digest, reservation source-bucket digest, exact objective trigger (`INTENT_EXPIRED`, `BUYER_APPROVAL_EXPIRED`, or `FUNDED_AUTHORIZATION_EXPIRED`), stored trigger time, abandonment policy ID/revision, `abandonAfter`, signer role/capability/key version, issued time, expiry, and nonce. The contract recomputes the trigger and grace period from authoritative state. No subjective reason or single-party early request can satisfy it. An objection before the objective deadline changes nothing; parties may use dual-party CANCEL. Once the pre-agreed trigger is true, one current designated party signature is sufficient; no second ad hoc consent is required.

Both paths exist only in `VALUE_LOCKED`, `DIRECT_TESTNET_AUTHORIZED`, `FUNDED_AUTHORIZATION_REQUIRED`, or `FUNDED_AUTHORIZED`, consume nonces, invalidate all unconsumed predecessor approvals/authorizations, and atomically restore the exact reservation to its recorded source bucket. API projection, administrator, inspector, risk/policy, auditor, executor, ManifestAttestor, or deterministic-policy service cannot bypass the contract predicate. A race with submit has one atomic winner.

Release-intent state progression is monotonic except for explicit pre-submit exits:

```text
RELEASE_INTENT_CREATED -> VALUE_LOCKED
VALUE_LOCKED -> DIRECT_TESTNET_AUTHORIZED -> SUBMITTING
VALUE_LOCKED -> FUNDED_AUTHORIZATION_REQUIRED -> FUNDED_AUTHORIZED -> SUBMITTING
VALUE_LOCKED | DIRECT_TESTNET_AUTHORIZED | FUNDED_AUTHORIZATION_REQUIRED | FUNDED_AUTHORIZED
  -> CANCELLED_PRE_SUBMIT | ABANDONED_PRE_SUBMIT | SUPERSEDED_PRE_SUBMIT
SUBMITTING -> PROCESSING | UNKNOWN | FAILED
UNKNOWN -> PROCESSING | PAID | REFUNDED | FAILED | REVIEW | RECONCILING
PROCESSING -> PAID | REFUNDED | FAILED | REVIEW
REVIEW -> RECONCILING | ADJUDICATION
RECONCILING -> PROCESSING | PAID | REFUNDED | FAILED | REVIEW
ADJUDICATION -> RECONCILING | REVIEW
```

`CANCELLED_PRE_SUBMIT` and `ABANDONED_PRE_SUBMIT` apply the authority above and restore the exact source bucket. `SUPERSEDED_PRE_SUBMIT` atomically transfers that reservation to one newly created replacement intent, invalidates the predecessor's unconsumed approvals/authorizations, and records predecessor/successor; no moment exposes the value to two intents. Destination activation can atomically supersede only one of the four pre-submit states above and creates the new revision before its new intent can be approved. Dry compatibility is not a release-intent state.

`SUBMITTING`, `PROCESSING`, `UNKNOWN`, `REVIEW`, `RECONCILING`, and `ADJUDICATION` retain the exact value lock and forbid cancel, abandon, supersede, reservation release, quote renewal, second operation, destination activation, refund, or second intent. Manual adjudication may identify evidence sources, freeze the trade, or request reconciliation; no human or database flag can assert `PAID`, `REFUNDED`, or `FAILED`.

`FAILED` is authoritative only when a final contract receipt or equivalent rejection proves the exact operation was not accepted, escrow accounting proves the value never left, and no source transfer, provider deposit, destination receipt, or refund remains possible or pending. A provider error after any source/deposit transfer is `UNKNOWN` or `REVIEW`, never `FAILED`. On authoritative no-transfer failure, the contract atomically moves `reserved -> available` in original per-funder proportions and invalidates the old release intent and approval. Retry requires a new releaseIntentId and fresh buyer approval; the old attempt is never resubmitted.

`PAID` moves `reserved -> released`. A future-provider `REFUNDED` outcome retains the lock until value reaches the quote-bound escrow/refund authority and reconciles into per-funder ledgers; then the proven returned amount moves `reserved -> available`, with fees separately accounted. A short or contradictory refund leaves the unmatched amount locked or quarantined in `REVIEW`. Late success or refund from `UNKNOWN`, `REVIEW`, `RECONCILING`, or `ADJUDICATION` binds the original intent. Mutually contradictory authoritative observations freeze the trade in `REVIEW`, quarantine unexpected returned value, and never authorize a second payout. Evidence arriving after `FAILED` is a conservation incident: freeze affected value and any successor intent rather than treating it as a normal transition.

## 12. Escrow refund and cancellation

The authoritative reason matrix is [REFUND-POLICY.md](REFUND-POLICY.md), policy `dockside-refund-v1` revision `1`. Escrow refund is separate from a provider refund. Each accepted native testnet NEAR deposit records original funder and amount. Partial funding remains unavailable for release. Excess is quarantined and can be returned only to its original funder under the excess policy. Unexpected token transfers are not credited to native-NEAR funding and use the policy's separate `UNEXPECTED_ASSET_RECOVERY` matrix, not the refund state machine or native-NEAR conservation equation.

Every `RefundIntent` records the exact per-funder deposit slice and `sourceBucket`. The signed policy defines initiator, signers, clock origin, duration, evidence, challenge/appeal, eligible slice, original-funder recipient, revocation and UNKNOWN reconciliation for trade expiry, inspector fail, permanent hold, mutual cancel, buyer/supplier/inspector key loss, partial funding and excess funding. Key-loss rows are recovery-first and authorize no automatic refund. No administrative database flag or caller-provided eligibility boolean can authorize refund.

```text
NONE -> REQUESTED -> TIMELOCKED -> AUTHORIZED -> EXECUTING
EXECUTING -> PROCESSING | UNKNOWN | REFUNDED | FAILED | REVIEW
UNKNOWN -> PROCESSING | REFUNDED | FAILED | REVIEW | RECONCILING
PROCESSING -> REFUNDED | FAILED | REVIEW
REVIEW -> RECONCILING | ADJUDICATION
RECONCILING -> PROCESSING | REFUNDED | FAILED | REVIEW
ADJUDICATION -> RECONCILING | REVIEW
```

Pre-execution revocation atomically restores the exact slice to `sourceBucket`: an `EXCESS_FUNDING_RETURN` goes back to `QUARANTINED`; partial and ordinary eligible deposits return to their recorded pre-intent bucket, never a generic available/reserved choice. `EXECUTING`, `PROCESSING`, `UNKNOWN`, `REVIEW`, `RECONCILING`, and `ADJUDICATION` retain the refund lock. Reconciliation uses the original refund transaction identity/nonce and the original-funder receipt; no blind retry exists.

Refund `FAILED` requires authoritative atomic non-transfer proof plus escrow accounting. It restores the exact `sourceBucket`; a new refund requires a new refundIntentId and fresh current authorization. A late original-funder receipt from any unresolved state becomes `REFUNDED`; contradictory success/failure remains locked in `REVIEW`. Provider refunds remain release-intent reconciliation, not a direct escrow-refund reason.

The release-intent economic lock and contract state serialize refund versus release. Refund returns only the eligible per-funder deposit slice to the recorded original funder. A provider refund in the future mainnet corridor returns to quote-bound refundTo controlled by the escrow/refund authority and must reconcile into the original release-intent and funder ledgers before withdrawal.

## 13. Reconciliation and evidence hierarchy

Provider responses are facts attributed to the provider, not independent truth. Contract/RPC observations identify source-chain events. Destination receipt must use the configured authoritative chain/event or balance-delta evidence with subject, finality policy, and operation binding. Missing or private destination evidence yields `REVIEW` or `UNKNOWN`.

The reconciler:

1. selects due operations using a durable schedule and fenced lease;
2. reads contract, provider, source chain, and destination evidence independently where configured;
3. validates identity, freshness, schema, and monotonicity;
4. applies deterministic transition in one transaction;
5. records the raw digest and normalized fact;
6. schedules bounded backoff or opens an incident.

Retry budgets and deadlines are explicit. Operators can request reconciliation or open adjudication but cannot force a terminal success/failure, release a lock, create a successor intent, or rewrite ledger disposition.

## 14. Conservation

For each asset and trade:

```text
funded = reserved + released + refunded + fees + available + quarantined
```

Amounts use integer smallest units. Asset identities never net across assets. A bridge or provider fee in another asset forms a separate ledger. Any proven unexplained loss fails. Missing facts hold `REVIEW`; they do not get coerced to zero.

## 15. API and authorization

The UI consumes a versioned typed API. Mutations require authenticated session, CSRF/origin controls where applicable, exact role, optimistic version, idempotency key, and current identity digest. High-risk responses return a preview of canonical facts and a challenge to sign; the server independently revalidates when consuming the signature.

Roles are scoped per organization and trade. Bootstrap, invitation acceptance, proof of possession, role grant, ManifestAttestor enroll/prove/grant/rotate/revoke/status, approval, consent, inspection, release-intent CANCEL/ABANDON request/sign/consume, buyer hold-resolution request, deterministic-policy SET, risk/policy SET/RESOLVE, reconciliation/adjudication request, and executor action are separate typed endpoints and audit events. Buyer admin enrollment does not imply release approval or risk resolution; organization security admin, buyer approver, inspector, supplier signer, ManifestAttestor, deterministic policy setter, risk resolver, auditor, and executor are distinct capabilities and sessions/service identities. Key revocation blocks new authority but preserves historical verification. Recovery cannot silently replace a counterparty, attestor, or policy key inside an active revision. Integrated API authorization tests run only after the contract, organization, evidence, release and journal boundaries exist; optional M06 endpoints are included only when that module is implemented.

## 16. Security and privacy

See [SECURITY.md](SECURITY.md). Secrets stay in server/worker secret stores and never enter browser storage, logs, exports, screenshots, or accessibility names. Evidence locators are opaque. Downloads require authorization at access time and short-lived capability. Content Security Policy, secure cookies, origin checks, rate limits, audit logging, dependency verification, and backup/restore tests are required.

## 17. Observability

Structured logs use redacted IDs, operation digest prefix, component, state transition, attempt, lease epoch, latency, and result. Metrics include unknown-age, reconciliation lag, denied redirection, signature failures, outbox lag, duplicate joins, evidence scan rejection, contract/provider/RPC errors, and conservation violations. Traces never carry raw documents, destinations beyond role-safe masking, secrets, or signatures.

## 18. Deployment

Local development uses explicit services and real local persistence. Testnet deployment separates contract, API, worker, database, object store, and web identities. Health means process availability; readiness includes database migration and required dependency reachability but never claims product correctness. Migrations are forward-safe with backup/restore and rollback procedure. Exact artifact digest and contract code hash are recorded.

Mainnet executor configuration, secret linkage, wallet signing, contract deployment, and funding are separately authorized. Event deadlines never weaken this boundary.

## 19. Architecture decisions

- **ADR-001:** one payout architecture; 1Click adapter only.
- **ADR-002:** contract is escrow authority; UI/API projections are not.
- **ADR-003:** WORKING_TESTNET is direct native testnet NEAR from escrow contract to bound supplier testnet account.
- **ADR-004:** AI has no onchain authority; only enrolled policy/risk capabilities write or resolve holds.
- **ADR-005:** EvidencePolicy completeness precedes inspector pass and release readiness.
- **ADR-006:** destination change creates a new revision and invalidates evidence, release intent and approvals.
- **ADR-007:** stable release intent locks value independently of quotes and attempts.
- **ADR-008:** provider dry compatibility is separate from direct release and funded settlement.
- **ADR-009:** post-quote funded authorization is exact and atomically consumed once.
- **ADR-010:** durable journal/outbox and reconciliation precede any callable funded submit.
- **ADR-011:** release and original-funder refund share one mutually exclusive economic lock.
- **ADR-012:** light-first enterprise UI exposes evidence and uncertainty rather than decorative crypto metrics.

Changing an ADR requires a recorded decision, threat review, requirement/test update, and new evidence; it cannot be changed merely to make a failing test green.
