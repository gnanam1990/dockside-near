# ADR-0003 — Proof-of-possession sessions, invitations, recovery and service custody

- Decision status: accepted (M01)
- Date and authorship: 2026-11-11, Dockside build stage M01 (coding agent)
- Affected IDs: FR-10, FR-15, NFR-02, NFR-06, INV-13, T-004, T-005, T-006; consumed by M03, M04, M07

## Context

TDD §4 and SECURITY.md require wallet proof-of-possession bootstrap bound to origin, organization, role,
nonce and expiry; one-time hashed scoped invitations accepted in the recipient's own session with a later
admin grant; versioned keys with revocation, delayed recovery and historical verification; and isolated
custody for ManifestAttestor / deterministic-policy services, without silently changing the authority bound
into an active trade revision.

## Decisions

1. **Challenges.** Every PoP challenge is a DCE-1 payload under `dockside/pop-challenge` (humans) or
   `dockside/service-pop-challenge` (services) binding origin, network, organization, principal, requested
   capability, invitation/recovery/previous-key reference, public key, key version, 32-byte nonce, issued and
   expiry times. Challenges are stored, single-use (`PENDING -> CONSUMED` compare-and-swap plus a durable
   nonce), and a challenge issued under one origin is rejected by a verifier configured with another
   (`WRONG_ORIGIN`). Humans may answer with a canonical Ed25519 signature or a **NEP-413 `signMessage`**
   signature whose message embeds the canonical digest, nonce = challenge nonce and recipient = origin, so a
   real NEAR wallet key can enrol. Services answer only with the canonical scheme.
2. **Sessions are proof-of-possession, not bearer.** A session is a random 256-bit token stored as SHA-256
   plus the bound key version. Every authenticated request carries a `Dockside-Proof` signed by the session
   key over `{sessionId, origin, method, path+query, SHA-256(body), issuedAt, nonce}` (`dockside/request-proof`),
   with a bounded window and a durable per-session nonce. A stolen token without the key is useless; revoking
   or suspending the key kills its sessions immediately.
3. **Separation of duties.** A public key can be enrolled exactly once across all principals and versions.
   A principal holds at most one party capability (buyer approver, supplier signer, inspector, risk resolver);
   security admins cannot hold party capabilities; auditors hold nothing else; service capabilities
   (`MANIFEST_ATTEST`, `DETERMINISTIC_POLICY_SET`, `EXECUTOR`) are only reachable through service enrollment.
   Invitations cannot be accepted with an enrolled key or from inside an existing session, and grants must come
   from a different principal and session. `assertIndependentParties` additionally requires distinct
   enrollment sessions and different buyer/supplier organizations.
4. **Key lifecycle.** Key statuses: `PENDING_PROOF -> PENDING_ACTIVATION -> ACTIVE -> SUPERSEDED | SUSPENDED | REVOKED`.
   Rotation needs the current key session plus PoP of the new key; the old version becomes `SUPERSEDED` and
   still verifies for revisions that bound it (no silent substitution), while the new version cannot satisfy an
   old binding (`KEY_NOT_BOUND`/`SIGNATURE_INVALID`). Revocation is immediate; `verifyHistorical` keeps
   signatures made inside the activation window valid.
5. **Recovery is delayed and vetoable.** A *different* security admin starts recovery; the target's usable
   keys are suspended at once (new authority frozen); the new key must prove possession; activation only after
   `DOCKSIDE_RECOVERY_DELAY_MS`. During the delay the principal can veto by signing a cancel challenge with its
   existing key, which restores the prior keys. Service recovery follows the same delay.
6. **Service custody.** Enrollment records only the public key, version, capability, organization/trade/
   EvidencePolicy scope, and an opaque custody locator (`HSM | KMS | ISOLATED_SIGNER_PROCESS`); locators that
   look like key material are rejected. `IsolatedSigner` runs the key in a child process that never exports it
   and refuses purposes outside its allowlist. Activation is a separate admin action.
7. **Typed contracts for later modules.** `verifyTradeServiceSignature` derives the binding only from the signed
   trade revision; `verifyServiceSignature` checks capability, enrolled scope equality, scope coverage of the
   use context, exact key version/public key and status before the signature; `verifyPrincipalSignature`,
   `verifyHistorical`, `verifyTradeRevisionAcceptance` (buyer + supplier dual signature over the revision digest
   with every bound authority usable) and `bindingStatus` (`requiresNewRevision` after rotation/revocation/recovery).

## Assumptions to revisit

- Trade services must be enrolled by a trade counterparty organization (buyer or supplier); M03 may add a
  third-party attestor organization with an explicit trust grant.
- Rate limiting of unauthenticated challenge creation is not implemented yet (M07/M09 hardening).
- NEAR account ownership of an enrolled key (RPC `view_access_key`) is not checked: no network calls were made
  in this build. Principals are key-identified; account binding is NOT_RUN.

## Trust/security impact

Fail closed on every mismatch; every authority mutation and denial is appended to the hash-chained audit log in
the same transaction (denials in their own transaction). Secrets (session tokens, invitation secrets) are only
returned once and stored as SHA-256.

## Verification and flip condition

T-004/T-005/T-006 suites plus the HTTP suite (`services/api/test`). Flip the session design if the browser UI
(M08) cannot hold a non-extractable Ed25519 WebCrypto key; then use a per-session P-256 WebCrypto key enrolled
by a wallet-signed delegation, recorded as a new ADR.
