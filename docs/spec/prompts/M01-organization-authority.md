# M01 — Organization and authority lifecycle

Artifact status: **SPECIFICATION_ONLY**. Module status: **NOT_RUN**. Dependency: M00.

Mapped IDs: FR-10, FR-15, NFR-02, NFR-06, INV-13, T-004, T-005, T-006.

Implement wallet proof-of-possession bootstrap, domain/org/role/nonce/expiry challenges, one-time hashed scoped invitations, recipient acceptance in a separate session, later administrator role grant, versioned keys, revocation, recovery delay and historical verification. Add organization-security-admin enrollment for ManifestAttestor and deterministic-policy service principals: domain-separated PoP, public key/version, capability, organization/trade/EvidencePolicy scope, isolated custody metadata, activation, rotation, revocation, recovery and audit. Buyer, supplier, inspector, risk resolver, ManifestAttestor and deterministic-policy capabilities must remain distinct; service rotation never changes an active trade revision silently.

Drive replay, wrong-origin/org/key/scope, expired invite, self-escalation, wrong-but-enrolled service, rotated-unbound key, revoked signature and active-trade recovery tests first. Persist every authority event and expose typed contracts for later modules. Record actual commands/evidence; perform no remote account creation or wallet action without authorization.
