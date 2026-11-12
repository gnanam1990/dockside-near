# ADR-0018 — Organization settings, signed audit export and NEP-413 account ownership

- Decision status: accepted (M17)
- Date: 2026-11-12, Dockside build stage M17
- Affected IDs: FR-10, FR-15, NFR-02, NFR-06, INV-13, T-003, T-004, T-033, T-034, T-039, T-040; amends
  ADR-0009 §8 (export is now also signed), ADR-0003 "assumptions to revisit" (NEAR account binding),
  ADR-0013/0014 (wallet connector boundary exists; funder and sender wallets still hand calls over)

## Context

UI-SPEC §3.10 asks for policy, retention and integration settings with write-only secrets and a
connectivity-only connection test. ADR-0009 shipped a checksummed but unsigned audit export and named a
dedicated export key as the follow-up. ADR-0003 left NEAR account ownership (`view_access_key`) NOT_RUN
and the web build had no wallet connector, so T-004's "actual wallet signature" was only exercised with
raw keys in unit tests.

## Decisions

1. **Settings are append-only revisions with compare-and-swap.** `organization_settings` holds one row per
   revision (`settings_json`, SHA-256 digest under `dockside/organization-settings`, actor principal and key
   version, time); UPDATE and DELETE are refused by triggers. `POST /v1/organization/settings/retention`
   carries `expectedRevision`; a stale editor gets `VERSION_CONFLICT` and nothing is written. Reads need
   ORG_SECURITY_ADMIN or AUDITOR of the caller's own organisation, writes ORG_SECURITY_ADMIN; refused writes
   append `SETTINGS_CHANGE_DENIED`, changes `ORGANIZATION_SETTINGS_CHANGED` with before/after and digests.
2. **Retention is a period plus a computed preview; no deletion job.** Evidence retention is 30–3650 days
   after a trade settles (a PAID release or a REFUNDED refund and no open operation). The preview
   (`GET /v1/organization/retention-preview`, optional `asOf` for planning) is computed from the journal,
   hold and freeze records; unresolved holds, freezes and open operations always retain. Audit events,
   chain state, signatures and journal records are listed as never deleted. The deletion job that would
   remove eligible encrypted objects and write tombstones is **not built**; the API and UI say so.
3. **EvidencePolicy ownership.** The organisation whose administrator first registers a policy id owns its
   later revisions (`evidence_policy_owners`); a revision must be exactly the next one (`VERSION_CONFLICT`
   otherwise) and another organisation gets `FORBIDDEN`. An id registered without an owner (operator
   seeding, older data) cannot be extended through the API. A new revision never changes an accepted
   trade: each trade revision keeps the policy revision and digest its parties signed. The UI drafts the
   next revision from the latest (attestation lifetime, per-slot freshness) and the server validates all of
   it with the M03 policy schema.
4. **Integrations are read-only configuration plus a connectivity test.** The RPC endpoint (scheme and host
   only), escrow contract, network and funded-payout switch come from `DOCKSIDE_*` configuration and are
   labelled as such. `POST /v1/organization/integrations/rpc-test` (administrators only, audited) reads a
   final block and states that it proves connectivity only. The 1Click dry adapter state is taken from the
   wired adapter's own probe (`BlockedOneClickAdapter` → `NOT_RUN`); the partner credential is shown as
   write-only and not configured. No route accepts a credential in this build (M06 stays BLOCKED).
5. **Dedicated audit-export key.** The deployment operator creates a 32-byte Ed25519 seed with
   `export-key generate` (exclusive create, owner-only permissions; the seed is never printed). Only an
   isolated signer child process reads it (`DOCKSIDE_AUDIT_EXPORT_KEY_FILE`), allowed to sign exactly
   `AUDIT_EXPORT_KEY_ENROLLMENT` and `AUDIT_EXPORT`. Enrollment (at API start, or `export-key enroll`) signs a
   statement naming key id, public key, origin, network, custody kind, time and nonce; the API verifies it
   before storing `audit_export_keys`. A newer key retires the older one (`RETIRED`, `retired_at`); a retired
   or revoked key is never re-enrolled; `export-key revoke` marks compromise (`REVOKED`).
6. **Signed export bundle.** `GET /v1/trades/:id/signed-audit-export` runs every ADR-0009 authority check,
   builds the same checksummed export and signs a statement that binds the export schema, checksum
   algorithm and checksum, trade, exporter (principal, key version, organisation), destinations mode, audit
   head hash, origin, network, key id, public key and signing time, under the DCE-1 domain
   `dockside/audit-export`. The bundle is `{schema, export, statement, statementDigest, signature}`.
   `GET /v1/audit-export-keys` publishes the key list (`dockside/audit-export-keys@1`).
7. **Offline verification.** `verify-export <bundle> --trusted-keys <list>` (services/api/dist/cli) reads
   two files, makes no network or database access and prints every check: bundle shape, export checksum,
   statement fields and binding, statement digest, Ed25519 signature, key in the trusted list, origin, not
   revoked, and signing time inside the key's validity window. Exit 0 / 1 / 2 (valid / any check fails /
   usage). The trust anchor is the operator's published list obtained out of band; a list fetched from the
   same server only shows consistency. RETIRED keys verify signatures made before `retired_at`; because a
   holder of the key could backdate `signedAt`, compromise is handled by revocation, not retirement. The
   browser repeats the same checks before it offers the file for download.
8. **NEP-413 account ownership.** A signed-in principal requests `POST /v1/me/near-accounts/challenges`
   (one-time, 5 minutes, bound to principal, session key version, organisation, account, origin and a
   32-byte nonce; the message embeds the digest). The answer `{challengeId, accountId, publicKey,
   signature}` (wallet base64 or `ed25519:` form) is verified as NEP-413 (Borsh tag 2^31+413, message,
   nonce, recipient = origin, no callback), then the chain adapter's `view_access_key(accountId, publicKey)`
   must report **FullAccess**: a missing key is `ACCESS_KEY_NOT_FOUND`, a function-call key
   `ACCESS_KEY_NOT_FULL_ACCESS` (both new error codes, 403). Only then is the challenge consumed and the link
   stored with the observed block height; every observation (link, re-check) is appended to
   `near_account_checks` and audited. The link is an identity fact: it grants no capability, no trade
   authority and changes no binding.
9. **Wallet connector boundary; no wallet-selector dependency.** `apps/web/src/lib/wallet.ts` defines
   `WalletConnector.signMessage({message, nonce, recipient}) → {accountId, publicKey, signature}`, the same
   contract as NEAR wallets and `@near-wallet-selector/core`, with discovery by window events
   (`near-wallet:request` / `near-wallet:announce`) and `connectorFromWallet` to wrap any wallet-selector
   wallet structurally. `@near-wallet-selector/core` 10.1.4 (published 2025-12-04) qualifies by age, but it is
   **not pinned**: its core ships no wallet (every wallet is a further module that redirects to a hosted
   wallet or extension, none runnable in this offline build), it brings the `@near-js` provider and
   transaction stack plus rxjs into a web bundle that has five runtime dependencies today (React, React DOM, the icon set and two font packages), and wallet modules
   construct network RPC providers on setup. The browser re-verifies every wallet answer with WebCrypto
   before sending it. Browser tests use a page-announced test wallet whose key and Borsh encoding live in
   the test process.
10. **Chain adapter wiring.** `AppDeps.chain` (`viewAccessKey`, `latestBlock`) is wired from
    `DOCKSIDE_NEAR_RPC_URL` in `main.ts` and the local stack. Without it the routes answer "no such
    endpoint" with `CHAIN_NOT_CONFIGURED`. The simulated chain gained an access-key registry (`addAccessKey`,
    `deleteAccessKey`; the stack's `POST /control/access-keys`) standing in for AddKey/DeleteKey.
11. **A real nearcore node in the loop.** `pnpm run test:sandbox` starts the NEAR sandbox (nearcore 2.13.4
    sandbox build via the `near-sandbox` 0.3.4 npm package, in `node:22-trixie-slim` because the binary needs
    glibc 2.38+) in Docker inside WSL, with a genesis account whose only full-access key is generated by the
    test. It found two adapter defects the simulated chain could not: the `block` header timestamp is a u64
    above 2^53 (the strict parser rejected every real block; RPC responses now keep such integers as exact
    decimal strings, every other boundary still rejects them; M15 landed the same parser change on main in
    parallel and the merge keeps its version), and a missing access key is a result carrying an `error`
    string, not a JSON-RPC error (now `NOT_FOUND` with cause `UNKNOWN_ACCESS_KEY`, fixed here). The simulated
    chain now answers a missing key the same way.

## Consequences

- T-004's wallet half runs: real NEP-413 signatures from a wallet key, verified by the server and checked
  against nearcore's `view_access_key` (sandbox) and the simulated chain (API and browser). Testnet stays
  NOT_RUN; enrolling a principal's Dockside key *as* a wallet key is still not possible from a browser,
  because a wallet cannot sign per-request proofs (ADR-0003 flip condition unchanged).
- T-033 gains a signed form; the checksummed export is unchanged, so existing consumers keep working.
- Funder and sender wallets (ADR-0013, ADR-0014) still receive prepared calls; a wallet that can sign
  transactions would plug in behind the same connector boundary.

## Flip conditions

- Pin `@near-wallet-selector/core` (and specific wallet modules) when a wallet the users actually run is
  chosen and its module can be exercised locally; keep the connector interface as the seam.
- Move the export key to an HSM/KMS behind the same `ExportKeySigner` contract when one is provisioned.
- Build the deletion job (encrypted-object removal plus tombstones) before any production retention claim.
