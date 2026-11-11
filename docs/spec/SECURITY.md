# Security and Trust Model

Status: **SPECIFICATION_ONLY**. Threat controls: **NOT_RUN**.

## Assets

- Escrowed value and release authority.
- Organization-admin, buyer, supplier, inspector, ManifestAttestor, deterministic-policy, risk/policy, and executor keys/capabilities.
- Bound payout destination and quote identity.
- Commercial documents, prices, identities, and private evidence.
- Durable journal, audit history, destination receipt, and product truth.

## Adversaries and failures

- Forged supplier email or compromised account requests redirection.
- Buyer, supplier, inspector, administrator, ManifestAttestor, deterministic-policy, risk/policy, executor, or worker exceeds role or reuses a key outside its trade/policy scope.
- Malicious evidence exploits parsers or prompt-injects an analysis model.
- Browser/API compromise manufactures displayed readiness.
- Provider/RPC timeout hides an accepted economic action.
- Duplicate, replay, stale signature, key rotation, clock skew, or worker race.
- One operator, generic service credential, or stolen session attempts to act as buyer, supplier, inspector, ManifestAttestor and risk/policy principal.
- Incomplete/unauthorized evidence or a caller-supplied `complete=true` is presented as complete; uploader, issuer, MIME/content, byte/resource, digest/derived-source, replacement/currentness, issued/freshness or cardinality facts are omitted or altered; a wrong-but-enrolled, cross-trade/policy, rotated-unbound, expired or revoked ManifestAttestor signs it.
- Model output or expired hold is used to create, clear or bypass contract authority.
- Release, refund, destination activation or quote renewal races an unknown payout for the same value.
- A caller forges/replays/stales one CANCEL signature, treats disagreement as dual consent, abandons before the objective policy trigger, or cancels/abandons/supersedes a submitted or otherwise unresolved release intent.
- Authoritative failure is inferred from a provider error; REVIEW is unlocked; late success/refund conflicts with a successor; or refund revocation restores an excess slice outside `QUARANTINED`.
- Refund reason, clock, signatures, recipient, eligible amount, or unexpected-asset classification is altered outside the versioned policy.
- Secret leakage through logs, traces, exports, DOM, browser storage, accessibility text, or screenshots.
- Dependency, CI, deployment, DNS, origin, webhook, storage, or backup compromise.

## Mandatory controls

- Contract-side enforcement for original-funder escrow, the exact revision-bound ManifestAttestor and every EvidencePolicy predicate, onchain holds, revision, dual consent, delay, stable release-intent/value lock, versioned refund policy, exact funded authorization and one-release rules. API/projection completeness booleans have no authority.
- Exact canonical digest and domain-separated signatures; nonces, expiry, chain/contract binding, replay protection, proof-of-possession bootstrap and one-time scoped invitations.
- ManifestAttestor proof-of-possession enrollment by organization security administration, isolated key custody, least-privilege organization/trade/policy scope, active-revision key binding, rotation/revocation without silent substitution, and historical verification.
- Least-privilege per-trade roles; deterministic policy may SET but never RESOLVE a hold; separate risk resolver and executor identities; revocation and rotation with historical verification.
- HttpOnly secure same-site cookies or equivalent, CSRF/origin checks, CSP, HSTS, rate limits, session expiry, and audit.
- Evidence streaming limits, MIME/content verification, archive/image/parser budgets, malware/active-content isolation, encrypted storage, short-lived downloads.
- Model input minimization and output treated as untrusted; no ability to set or resolve HoldRecords or any other authority.
- Provider/RPC allowlists, TLS validation, bounded response size/time, schema validation, redaction, and no URL supplied by untrusted evidence.
- Transactional outbox, idempotency, fenced leases, monotonic state, stable release intent and no competing action while `SUBMITTING`, `PROCESSING`, `UNKNOWN`, `REVIEW`, `RECONCILING`, or `ADJUDICATION`. CANCEL requires matching buyer/supplier signatures; ABANDON requires an objective signed-policy expiry trigger; supersession requires destination activation; each is atomic, nonce-protected and pre-submit only.
- Terminal `FAILED` requires authoritative no-transfer plus escrow-accounting proof; late or contradictory evidence freezes the original and any successor. Manual adjudication cannot force terminal status.
- Refund authorization validates current policy ID/revision, exact reason matrix, clocks, evidence, challenge state, signatures, eligible value, original-funder recipient and source bucket. Revocation restores that bucket, including `EXCESS_FUNDING_RETURN -> QUARANTINED`. Unexpected assets remain outside the native-NEAR refund ledger and require explicit asset-recovery review.
- Secret manager/environment injection; never commit or return secret values.
- Dependency lockfiles, provenance review, vulnerability scanning, reproducible builds, migration/restore drills, and signed artifact policy when available.

## Authorization matrix

| Action | Org security admin | Buyer | Supplier | Inspector | ManifestAttestor | Deterministic policy | Risk/policy | Auditor | Executor |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Enroll/grant/rotate/revoke service key | scoped admin | no | no | no | PoP only | PoP only | PoP only | no | no |
| Accept trade revision including service identities | no | yes | yes | no | no | no | no | no | no |
| Propose/consent destination revision | no | yes | yes | no | no | no | no | no | no |
| Fill evidence slot | no | scoped | scoped | scoped | no | no | no | no | no |
| Sign ManifestAttestation | no | no | no | no | exact bound scope | no | no | no | no |
| Attest inspection | no | no | no | yes | no | no | no | no | no |
| Request/view hold resolution | no | request/view | view | view | no | view | view | scoped view | no |
| SET HoldRecord | no | no | no | no | no | scoped signed | scoped signed | no | no |
| RESOLVE HoldRecord | no | no | no | no | no | no | scoped signed | no | no |
| Sign CANCEL release intent | no | designated buyer | designated supplier | no | no | no | no | no | no |
| Sign policy-triggered ABANDON after objective expiry | no | designated buyer | designated supplier | no | no | no | no | no | no |
| Approve release or funded authorization | no | designated buyer | no | no | no | no | no | no | no |
| Execute exact authorized operation | no | no | no | no | no | no | no | no | scoped worker |
| Request reconciliation/adjudication | scoped | scoped | scoped | scoped | no | scoped | scoped | scoped | scoped |
| Force PAID/REFUNDED/FAILED or release a lock | no | no | no | no | no | no | no | no | no |
| Read private evidence | scoped policy | policy | policy | assigned | signed facts only | rule inputs only | scoped | scoped | no |
| Export audit | scoped | scoped | scoped | scoped | no | no | scoped | yes | no |

Two labels saying “yes” never mean one actor can satisfy both roles unless the policy explicitly permits it and the risk review approves the resulting separation loss.

## Privacy and retention

Collect only evidence required for the named milestone. Keep raw documents offchain. Onchain records contain digests and minimum authority facts. Default exports exclude raw evidence and full destinations unless the requesting role and purpose permit them. Deletion removes eligible encrypted objects and records a tombstone; immutable chain/audit facts remain and are disclosed before collection.

## Incident behavior

- Suspected key compromise: freeze new authority, show affected trades, rotate through the explicit revision/recovery policy, reconcile existing operations.
- Provider/RPC ambiguity: enter `UNKNOWN` or locked `REVIEW`, preserve facts, stop repeat execution, reconcile; adjudication cannot assert a terminal outcome.
- Late success/refund or post-FAILED contradiction: freeze affected value and any successor, quarantine unexpected return, open a conservation incident, and reconcile by original identity.
- Conservation failure: block releases and open high-severity incident.
- Evidence/parser/model failure: quarantine item; never infer pass.
- Database/object mismatch: hold affected trade, rebuild projections, verify digests.

Security review must test actual contract, service, packaged worker, and deployed headers. A checklist alone is not evidence.
