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
| M01 organization/authority | NOT_RUN | T-004, T-005, T-006 | — |
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

## Blocked / not run (whole project)

| Item | State | User action required |
|---|---|---|
| NEAR testnet accounts, contract deployment, funding | BLOCKED (no account creation/faucet/signing allowed in this build) | Create testnet accounts and deploy/fund yourself once M02 exists; runbook will be provided by M02. |
| 1Click dry probe (M06) | NOT_RUN (real 1Click calls not allowed) | Separately authorize and run the M06 probe. |
| Funded mainnet payout | BLOCKED | Separate explicit authorization of network, wallet, amount, cap and executor. |
| Push / PR / deploy / publish | NOT_RUN (local-only build) | Create a remote and push yourself if desired. |
