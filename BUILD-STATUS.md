# Build Status

Project: Dockside — implementation of the v2.0.0 specification pack (`docs/spec/`, sealed)
Product claim level: **IMPLEMENTED_UNVERIFIED** for the modules listed below; no `WORKING_TESTNET`,
`DRY_COMPATIBLE` or `WORKING_MAINNET_PAYOUT` claim. REAL-PRODUCT-GATE runtime evidence items 1–13: **NOT_RUN**.
Deployment: **NOT_RUN**. NEAR testnet contract: **NOT_RUN** (M02). 1Click: **NOT_RUN** (optional M06, not allowed in this build).
Funded mainnet rail: **BLOCKED**.

## Environment (observed)

Windows 11, Node 22.23.1, pnpm 10.34.9, Rust 1.97.1 (`x86_64-pc-windows-gnu`), git. No Docker/WSL/PostgreSQL.
Stack and layout decision: [docs/adr/0001](docs/adr/0001-stack-and-monorepo-layout.md).

## Module summary

| Module | Status | Owned tests | Result |
|---|---|---|---|
| M00 foundation/contracts | tests passing (IMPLEMENTED_UNVERIFIED at product level) | T-001, T-002 | T-001 PASS (unit/property/cross-language), T-002 PASS |
| M01 organization/authority | tests passing (IMPLEMENTED_UNVERIFIED at product level) | T-004, T-005, T-006 | T-004 PASS, T-005 PASS, T-006 PASS (service + HTTP boundary); INV-13 human-acceptance evidence NOT_RUN |
| M02–M09 | NOT_RUN | — | — |

## M00 — foundation/contracts

- Branch: `feat/dockside-m00-foundation-contracts`, base `80b3859` (main).
- Mapped IDs: FR-01, NFR-02, NFR-05, INV-01, INV-08, T-001, T-002.
- Implemented (real, no mocks):
  - `packages/core`: Dockside Canonical Encoding v1 (typed, length-prefixed, sorted-field, domain + version
    envelope, SHA-256) — [ADR-0002](docs/adr/0002-canonical-encoding-and-signatures.md); strict raw JSON parser
    (duplicate keys, surrogates, lossy numbers, byte/depth/string/array/key limits); NEAR account codec
    (strict vs operator-input mode, homoglyph/whitespace rejection, testnet/mainnet suffix rules, named-only);
    `ed25519:<base58>` key/signature codecs; u128 yoctoNEAR amount codec; Ed25519 sign/verify on `node:crypto`;
    NEP-413 wallet message bytes; signing-domain registry with wrong-domain detection; validity windows;
    nonce registry interface; idempotency decision; clock/ID abstractions; fail-closed env config;
    capability model, separation-of-duties rule and SECURITY.md authorization matrix as data;
    error taxonomy; versioned `TradeTerms` v1 schema (unknown fields fail, INV-13 structural independence,
    service scope checks) with revision digest and INV-01 transition rule.
  - `packages/store`: `node:sqlite` database (WAL, `synchronous=FULL`, FK on), checksummed forward-only
    migrations that fail on drift/newer schema and roll back atomically, durable nonce registry, idempotency
    store, append-only hash-chained audit log (UPDATE/DELETE triggers + chain verification).
  - `contract/crates/dockside-canonical`: Rust DCE-1 encoder; reproduces all TypeScript vectors byte-for-byte and
    verifies a TypeScript-produced Ed25519 signature (`fixtures/canonical-vectors.json`, deterministic).
- Red evidence: `docs/evidence/M00/red-run-1.txt` — T-001 suite failed (golden vectors fixture absent) before
  vectors/build existed. Honest note: T-002 passed on its first run because the M00 implementation was drafted
  alongside the tests; its assertions were not weakened afterwards.
- Simulated/mocked: none on any path. `ManualClock` isolates time in tests only.
- Not covered here (by design): integrated cross-role authority (T-003, M07); contract-side use of the encoder (M02).

### M00 commands (Windows, git-bash), exit codes and counts

| Command | Exit | Result |
|---|---|---|
| `pnpm install --frozen-lockfile` | 0 | lockfile committed |
| `pnpm exec biome format .` | 0 | 26 files, no changes |
| `pnpm exec biome lint .` | 0 | 0 errors |
| `pnpm run typecheck` | 0 | `tsc -b` + test typecheck clean |
| `pnpm exec vitest run` | 0 | 3 files, 30 tests passed (T-001: 11, T-002: 12, store foundation: 7) |
| `cargo test --manifest-path contract/Cargo.toml` | 0 | 6 passed (4 unit, 2 cross-language vector) |
| `node scripts/secret-scan.mjs` | 0 | clean |
| `pnpm audit` | 0 | no known vulnerabilities (after upgrading zod→4.6.7, vitest→4.1.12) |
| `node scripts/generate-vectors.mjs` twice | 0 | identical SHA-256 (deterministic) |

Evidence: `docs/evidence/M00/` (local paths redacted).

## M01 — organization/authority

- Branch: `feat/dockside-m01-organization-authority`, base = M00 merge on main.
- Mapped IDs: FR-10, FR-15, NFR-02, NFR-06, INV-13, T-004, T-005, T-006. Decisions: [ADR-0003](docs/adr/0003-authority-sessions-and-service-custody.md).
- Implemented (real, no mocks on any path):
  - `packages/store/migrations/0002_authority.sql`: organizations, principals, key_versions (unique public key,
    status lifecycle), role_grants (one active grant per capability), proof_challenges, invitations (secret hash only),
    sessions (token hash only), service_enrollments, recoveries.
  - `packages/authority` `AuthorityService`: PoP bootstrap (canonical Ed25519 or NEAR NEP-413 wallet signature)
    bound to origin/org/role/key/nonce/expiry; single-use challenges; PoP sessions with per-request signed proofs and
    durable request nonces; one-time hashed scoped invitations; recipient acceptance in its own session; later admin grant;
    self-consumption/self-escalation/wrong-org/role-escalation/second-party-capability denial; versioned human keys with
    rotation, revocation, historical verification, delayed recovery by a different admin with principal veto;
    ManifestAttestor and deterministic-policy service enrollment with scoped PoP, opaque custody metadata, separate
    activation, rotation, delayed recovery, revocation; typed verification contracts (`verifyServiceSignature`,
    `verifyTradeServiceSignature`, `verifyPrincipalSignature`, `verifyHistorical`, `verifyTradeRevisionAcceptance`,
    `bindingStatus`, `assertIndependentParties`); every authority event and denial in the hash-chained audit log.
  - `IsolatedSigner` + `packages/authority/signer/isolated-signer.mjs`: service key generated and used only inside a
    child process with a purpose allowlist (local stand-in for HSM/KMS custody; same request/response contract).
  - `services/api`: node:http control API for every M01 flow, strict JSON (duplicate keys/unknown fields/size limits),
    exact-origin check, session token + `Dockside-Proof` per request, security headers, typed error envelope,
    `/healthz` and migration-aware `/readyz`; entry point `services/api/dist/main.js` (`pnpm run api`).
- Red evidence: `docs/evidence/M01/red-run-1.txt` (3 suites failed: `../src/index.js` did not exist; tests were written first).
  Two test-authoring bugs were fixed during green-up (display names with `_`; a random-nonce payload signed and verified as
  two different objects); no assertion was weakened.
- Mutation sanity: removing the request-proof signature check makes T-004 and the HTTP suite fail
  (`docs/evidence/M01/mutation-check.txt`).
- Real vs simulated: all signatures are real Ed25519 (node:crypto) with freshly generated keys; NEP-413 bytes are built
  exactly as NEAR wallets do, but **no real wallet extension or NEAR account was used** (no account creation allowed).
  The four parties in tests are separately keyed principals in separate sessions, but are driven by one test process:
  this satisfies the unit/integration paths only and **does not satisfy INV-13 human acceptance** (REAL-PRODUCT-GATE item 3: NOT_RUN).
- Known gaps (later modules): no rate limiting on unauthenticated challenge creation (M07/M09); NEAR account ↔ key ownership
  via RPC `view_access_key` not checked (NOT_RUN, no network); trade services assumed to be enrolled by a counterparty org;
  browser-held session keys (M08) undecided (ADR-0003 flip condition); integrated cross-role matrix T-003 belongs to M07.

### M01 commands, exit codes and counts (Windows, git-bash)

| Command | Exit | Result |
|---|---|---|
| `pnpm install --frozen-lockfile` | 0 | lockfile up to date |
| `pnpm exec biome check .` (format + lint) | 0 | 38 files, no diagnostics requiring fixes |
| `pnpm run typecheck` | 0 | `tsc -b` (core, store, authority, api) + test typecheck clean |
| `pnpm test --reporter=verbose` (runs `pnpm run build` first) | 0 | 7 files, **71 tests passed**: T-001 11, T-002 12, store 7, T-004 12, T-005 9, T-006 13, HTTP 7 |
| `cargo test --manifest-path contract/Cargo.toml` | 0 | 6 passed (4 unit + 2 cross-language vectors) |
| `node scripts/secret-scan.mjs` | 0 | 84 files clean |
| `pnpm audit` | 0 | no known vulnerabilities |
| `node <scratch>/smoke.mjs services/api/dist/main.js <db>` | 0 | built server: `/healthz` 200, `/readyz` 200 schemaVersion 2, malformed key 400 `INVALID_KEY`, typo env var exits 1 |

Evidence: `docs/evidence/M01/` (local paths redacted).

## Handoff for M02/M03 (next stages)

- Canonical bytes: use `digestFor`/`signFor`/`requireSignature` with a registered `SIGNING_DOMAINS` entry; add new
  domains there (and to the Rust crate vectors) rather than ad-hoc hashing. Contract-side encoding is
  `contract/crates/dockside-canonical` (add the NEAR contract as a new workspace member that depends on it).
- Trade terms: `parseTradeTerms`/`tradeTermsFromJson`, `tradeRevisionDigest`, `assertRevisionTransition` (INV-01).
- Authority: accept a revision with `verifyTradeRevisionAcceptance`; verify ManifestAttestor / policy-setter
  signatures only through `verifyTradeServiceSignature(terms, role, purpose, payload, sig)`; human party signatures via
  `verifyPrincipalSignature`; use `bindingStatus(terms).requiresNewRevision` after rotation/revocation/recovery.
- Persistence: add migrations as `packages/store/migrations/0003_*.sql` (contiguous numbering; never edit applied files).
- Run `pnpm test` (builds first: the isolated signer and fresh-process tests import `dist/`).

## Blocked / not run (whole project)

| Item | State | User action required |
|---|---|---|
| NEAR testnet accounts, contract deployment, funding | BLOCKED (no account creation/faucet/signing allowed in this build) | Create testnet accounts and deploy/fund yourself once M02 exists; runbook will be provided by M02. |
| 1Click dry probe (M06) | NOT_RUN (real 1Click calls not allowed) | Separately authorize and run the M06 probe. |
| Funded mainnet payout | BLOCKED | Separate explicit authorization of network, wallet, amount, cap and executor. |
| Push / PR / deploy / publish | NOT_RUN (local-only build) | Create a remote and push yourself if desired. |
| Real NEAR wallet PoP (e.g. a wallet `signMessage` against `POST /v1/bootstrap/challenges`) | NOT_RUN (no wallet signing allowed) | Run `pnpm run build && pnpm run api`, request a challenge, sign `nep413.message` with your testnet wallet (nonce = `nep413.nonceHex`, recipient = `DOCKSIDE_ORIGIN`), and post it to `/v1/bootstrap/complete` with `scheme: "nep413"`. |
| INV-13 human acceptance (four people, four devices) | NOT_RUN | Have four separate people enrol buyer, supplier, inspector and risk resolver through invitations on their own machines. |
