# ADR-0005 — Evidence, manifest attestation, inspection and holds

- Decision status: accepted (M03)
- Date: 2026-11-11, Dockside build stage M03
- Affected IDs: FR-03, FR-04, FR-12, FR-13, NFR-02, NFR-06, INV-04, INV-08, INV-10, INV-11, INV-13, INV-16,
  T-011, T-012, T-013, T-014, T-016, T-017, T-018, T-049; consumed by M04 (release), M05 (journal), M07 (API)

## Context

M03 must make evidence completeness something the escrow contract recomputes, not something a service
asserts. The contract crate already carried the EvidencePolicy / ManifestAttestation / InspectionAttestation
recomputation and HoldRecord SET/RESOLVE (ADR-0004). The service side had to produce exactly the facts the
contract verifies, from real uploads, with keys held outside the service process.

## Decisions

1. **One shape, two verifiers.** `@dockside/evidence` builds every signed payload (`issuancePayload`,
   `manifestAttestationPayload`, `inspectionPayload`, hold SET/RESOLVE via `@dockside/near`) with the exact field
   sets the contract decodes. The service verifies each payload with the same rules the contract applies and
   the same error codes (added to `@dockside/core` `ERROR_CODES`: `INCOMPLETE`, `OVER_CARDINALITY`,
   `STALE_ITEM`, `STALE_MANIFEST`, `STALE_REVISION`, `MANIFEST_NOT_CURRENT`, `UNSUPPORTED_CONTENT`,
   `MALICIOUS_CONTENT`, `POLICY_MISMATCH`, `DIGEST_MISMATCH`, `SOURCE_MISMATCH`, `WRONG_CONTRACT`,
   `WRONG_NETWORK`). A compiled-wasm suite submits service output to the contract to prove the digests agree.
2. **EvidencePolicy.** Strict schema `dockside/evidence-policy@1` with per-slot `dockside/evidence-slot-policy@1`.
   The service is stricter than the contract: only content `dockside-sniff@1` can classify (PDF, plain text,
   PNG, JPEG) and only the derived artifacts it can produce (`TEXT_EXTRACT/dockside-text@1`,
   `IMAGE_METADATA/dockside-image-meta@1`) are accepted. Policy revisions are immutable rows; a trade binds
   one `(policyId, revision, digest)` at `bindTrade`, after `verifyTradeRevisionAcceptance`.
3. **Uploads.** The uploader must hold a capability the slot allows. A party capability
   (BUYER_APPROVER / SUPPLIER_SIGNER / INSPECTOR) counts only for the principal and key version the revision
   binds; `EVIDENCE_UPLOADER` counts only for a member of the buyer or supplier organization. Bytes are read
   with a hard byte cap, hashed (SHA-256 original digest), classified from bytes (declared MIME must match),
   bounded for pages, pixels, decompressed bytes, decompression ratio and parse time before any inflate
   buffer is allocated, and refused for active PDF content or polyglot trailers. Content rejections are
   written to an append-only quarantine table. The issuer is always a bound party allowed by the slot and
   signs `dockside/evidence-issuance` over trade, slot, original digest, issued-at and its own identity.
4. **Manifests are revisions.** Every add, replace or remove writes a new `evidence_manifests` row keyed
   `(trade_id, revision)` with the full slot facts, after a compare-and-swap on `expectedManifestRevision`
   inside `BEGIN IMMEDIATE`; the primary key is the final guard between separate connections. Items,
   manifests, attestations, inspections, holds and findings are append-only (database triggers). A
   replacement is `version + 1` naming its predecessor; slot `currentnessVersion` is the manifest revision at
   which the slot last changed (monotonic, as the contract requires).
5. **Attestation.** `attest()` requires a derived `COMPLETE` evaluation, the bound ManifestAttestor binding
   still current (`bindingStatus`: a rotated, revoked or recovered key requires a new trade revision), and a
   signer whose public key is the bound one. The isolated signer process signs; the service then verifies the
   result through `verifyTradeServiceSignature` and records it. `expiresAt` is the earlier of the policy
   attestation lifetime and the earliest item freshness deadline. An attestation is CURRENT only while it
   covers the current revision, is unexpired, the manifest is still complete and the binding is current;
   otherwise SUPERSEDED / EXPIRED / STALE / INVALIDATED.
6. **Accepted-manifest digest mirrors the contract.** `currentAcceptedManifestDigest` is the latest recorded
   attestation's digest while the attestor binding is current, which is what the contract treats as current
   until a newer attestation arrives. Holds and resolutions bind this value.
7. **Inspection.** Accepted only from the bound inspector key, for the current manifest revision and digest
   (`STALE_MANIFEST` otherwise) with a CURRENT attestation (`MANIFEST_NOT_CURRENT` otherwise). A decision stops
   counting when its attestation stops being CURRENT, it expires, or the inspector key is revoked.
8. **Holds.** SET from the deterministic-policy service (must name a versioned `ruleId`; the rules in
   `DETERMINISTIC_RULES` are pure functions of evidence facts) or the risk/policy principal. RESOLVE only from
   the risk/policy principal; the deterministic-policy signer process is not even allowed the `HOLD_RESOLVE`
   purpose. Expiry yields `EXPIRED_UNRESOLVED`, which still blocks. A buyer may file a resolution request,
   which carries no authority. Supersession of a hold by a new trade revision is not implemented in M03.
9. **Model output is advisory.** `AdvisoryFindings` gives a reviewer frozen data (document text in an
   `untrustedContent` field), parses its reply against a strict schema and stores a finding whose `authority`
   column can only be `ADVISORY_ONLY`. It holds no signer and no reference to the hold or attestation
   services; deterministic rules do not read findings.
10. **Object storage.** Local content-addressed store (atomic rename, never overwritten, re-hashed on read).
    An S3-compatible store can sit behind the same `ObjectStore` interface later.

## Consequences

- The contract and the service fail the same forged inputs with the same codes, and a service-produced
  attestation is accepted by the compiled contract unchanged.
- M04 must consume an attestation (`ManifestRecord.consumed`) on release and must check holds via
  `blocking`/the contract view; the release-under-hold test (T-015) belongs there.
- `dockside-sniff@1` is deliberately small (no JavaScript-capable PDF renderer, no image decode beyond PNG
  inflate). JPEG decoded size is an estimate from the frame header. New content types need a new parser
  profile and policy revision.
