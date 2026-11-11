# M03 — EvidencePolicy, inspection and HoldRecord

Artifact status: **SPECIFICATION_ONLY**. Module status: **NOT_RUN**. Dependencies: M00, M01.

Mapped IDs: FR-03, FR-04, FR-12, FR-13, NFR-02, NFR-06, INV-04, INV-08, INV-10, INV-11, INV-13, INV-16, T-011, T-012, T-013, T-014, T-016, T-017, T-018, T-049.

Implement every versioned EvidencePolicy predicate: uploader and issuer identities/capabilities/keys, MIME/content class, item/aggregate bytes and parser-resource limits, original digest, required derived artifact/digest/source binding, replacement/currentness, issued/freshness and cardinality. Consume the ManifestAttestor enrollment lifecycle from M01, bind one enrollment/service/key version/capability/scope into the signed trade revision/policy, and canonicalize every fact plus policy/schema/manifest revisions, nonce and expiry. Contract recomputation rejects `complete=true`, wrong-but-enrolled/cross-scope attestors, rotated-unbound/revoked keys and every mutated predicate. Implement independent inspector signature only over a contract-accepted current manifest. Deterministic policy may SET but never RESOLVE a HoldRecord; a separate risk/policy principal may SET or RESOLVE. Model output is advisory and cannot call either mutation.

Begin with per-predicate direct-contract mutations, empty/stale/unauthorized/concurrent manifests, forged completeness booleans, wrong-but-enrolled/cross-trade/policy/rotated/revoked ManifestAttestors, malicious files, prompt injection, wrong inspector, deterministic-policy resolution and other invalid resolver paths. Preserve history and invalidate downstream authority on replacement. The integrated direct-contract release-under-hold test belongs to M04 after the release primitive exists.
