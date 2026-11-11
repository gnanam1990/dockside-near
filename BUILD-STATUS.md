# Build Status

Project: Dockside, an implementation of the v2.0.0 specification pack (`docs/spec/`, sealed).

## Claim

| Claim | State | Why |
|---|---|---|
| Product claim level | **IMPLEMENTED_UNVERIFIED** | Every module is implemented and tested, but only on a **simulated** NEAR chain. No REAL-PRODUCT-GATE item that needs NEAR testnet, separate people or a manual review has run. |
| `WORKING_TESTNET` | **not claimed** (BLOCKED) | Needs testnet accounts, a deployment, funding, a relayer signer with real custody and independent principals. See [docs/USER-NEXT-STEPS.md](docs/USER-NEXT-STEPS.md). |
| `DRY_COMPATIBLE` (1Click, optional) | **NOT_RUN** | M06 has interfaces and a blocked adapter only. No partner registration or credential is allowed in this build. |
| `WORKING_MAINNET_PAYOUT` | **BLOCKED** | Refused at startup (`near-mainnet`, `DOCKSIDE_FUNDED_PAYOUTS`). Needs separate explicit authorization. |
| Deployment | **NOT_RUN** | Nothing is deployed anywhere. Nothing has been pushed. |

Exact build of this status: see [the M09 status](docs/status/M09.md) for the commit, wasm SHA-256 and NEAR code hash
recorded by `scripts/build-manifest.mjs`, and for the clean-checkout reproduction.

## Environment (observed)

Windows 11, Node 22.23.1, pnpm 10.34.9, Rust 1.97.1 (`x86_64-pc-windows-gnu`, plus `wasm32-unknown-unknown`), git,
Playwright 1.64.1 with the locally installed Chromium headless shell. No Docker, WSL, PostgreSQL or C toolchain.
Stack decision: [ADR-0001](docs/adr/0001-stack-and-monorepo-layout.md).

## REAL-PRODUCT-GATE evidence matrix

"Local" means the exact code path ran with real keys, real persistence and real processes, but against the
compiled contract on a **simulated** NEAR host. The gate counts only the last column, and only `PASS` there
supports `WORKING_TESTNET`.

| # | Gate item | Local evidence (simulated chain) | Gate status (exact build, NEAR testnet) |
|---|---|---|---|
| 1 | Clean-checkout setup and pinned dependency evidence | **PASS**: `scripts/clean-checkout.mjs` cloned the committed tree into a fresh temporary directory, installed from the frozen lockfile, ran the full check, the contract host tests, `pnpm audit --prod` and the browser suite. The fresh wasm SHA-256 and dist digest matched the working build (M09) | **PASS** for setup and pins (this item needs no network). The testnet half of T-043 is item 2 |
| 2 | Real NEAR testnet deployment, native testnet NEAR funding from a recorded funder, direct release to the bound supplier | Contract, funding, release and settlement pass on the simulated host (T-007, T-019, T-022, T-033, T-036) | **BLOCKED**: no testnet accounts, faucet, signing or deployment allowed. USER-NEXT-STEPS §2–§7 |
| 3 | Canonical agreement and authority flow by independently enrolled buyer, supplier, inspector and risk/policy principals in separate PoP sessions | Four separately keyed principals, each in its own browser context and session, invited and then granted by their own organisation's administrator (T-036). T-003/T-004/T-005/T-006 at the API | **NOT_RUN**: one operator drives every key in tests, which the gate disallows as acceptance (INV-13). USER-NEXT-STEPS §6 |
| 4 | Nonempty EvidencePolicy, authorized uploads filling every slot, bound ManifestAttestor signing every fact; caller booleans, wrong scope, rotated, revoked and concurrent replacement rejected | **PASS** (T-011, T-012, T-013, T-018, T-049, T-037 partial, T-033) | **NOT_RUN** on testnet |
| 5 | Inspector signature verified against enrollment and the contract-accepted manifest digest | **PASS** (T-017, T-033, T-036) | **NOT_RUN** on testnet |
| 6 | Onchain HoldRecord SET by policy or risk; policy resolution denied; contract/API/UI release denied; AI output cannot mutate it; buyer request separated; non-risk resolution rejected | **PASS** (T-014, T-015, T-016, T-052, T-053, T-054) | **NOT_RUN** on testnet |
| 7 | Stable releaseIntentId locking exact value; dual-signed CANCEL; objective ABANDON; destination supersession with nonce, expiry, replay and race checks; buyer release signature against current facts | **PASS** (T-019, T-022, T-023, T-046, T-047, T-035, T-042) | **NOT_RUN** on testnet |
| 8 | Forged or unilateral destination change denied; legitimate dual-consent delayed revision invalidates manifest, attestation, hold view, intent and approval | **PASS** at contract, service and HTTP API (T-020, T-021, T-047, T-042). The UI has no destination screen yet, so the UI half of T-042 is NOT_RUN | **NOT_RUN** on testnet |
| 9 | Every refund/recovery reason, exact source-bucket revocation incl. excess to QUARANTINED, original-funder receipt, unexpected assets, concurrent refund/release | **PASS** for refund rows, bucket restoration, funder-only receipts and release exclusion (T-008, T-009, T-010, T-050, T-051, T-057, T-041 generated). **PARTIAL**: unexpected assets are recorded and never credited, but an asset-recovery authorization flow does not exist (no withdrawal entry point by design) | **NOT_RUN** on testnet |
| 10 | Durable lock before an external attempt; process kills across UNKNOWN/REVIEW/reconciliation/adjudication; authoritative no-transfer failure; late and contradictory evidence; restart without duplicate | **PASS** with real OS process kills against the simulated chain server (T-028, T-029, T-031, T-032, T-035, T-056, T-057). **PARTIAL**: T-030 provider refund is decision logic only | **NOT_RUN** on testnet |
| 11 | API/UI state from persisted and onchain observations: incomplete evidence, active/expired hold, REVIEW, UNKNOWN, refund, recovery | **PASS** for incomplete evidence, holds, UNKNOWN, REVIEW and PAID in the browser (T-036, T-037, T-038, T-054). **PARTIAL**: no refund-request or recovery screens | **NOT_RUN** on testnet |
| 12 | Checksummed audit export matching identities, manifests, holds, intent, ledgers and outcomes | **PASS** (T-033: seven tamper cases fail verification). The export is checksummed, not signed (ADR-0009) | **NOT_RUN** on testnet |
| 13 | Automated and manual accessibility evidence for the critical workflow | **PARTIAL**: axe (WCAG 2.2 AA tags) and keyboard checks pass on every route and trade tab (T-039 automated, T-040 partial) | **NOT_RUN**: manual assistive-technology review and true 200% zoom not done. USER-NEXT-STEPS §8 |

Optional 1Click dry status: **NOT_RUN** (it can be `NOT_RUN`, `UNKNOWN`, `INCOMPATIBLE` or `PASS`; only `PASS`
supports `DRY_COMPATIBLE`). Separate funded-mainnet gate: **BLOCKED**.

## Module summary

| Module | Status | Detail |
|---|---|---|
| M00 foundation/contracts | tests passing | [docs/status/M00.md](docs/status/M00.md), ADR-0001, ADR-0002 |
| M01 organization/authority | tests passing; INV-13 human acceptance NOT_RUN | [docs/status/M01.md](docs/status/M01.md), ADR-0003 |
| M02 NEAR escrow, funding, refund | tests passing on host and simulated host; testnet BLOCKED | [docs/status/M02.md](docs/status/M02.md), ADR-0004 |
| M03 evidence, inspection, holds | tests passing | [docs/status/M03.md](docs/status/M03.md), ADR-0005 |
| M04 release and destination | tests passing; testnet release BLOCKED | [docs/status/M04.md](docs/status/M04.md), ADR-0006 |
| M05 journal and reconciliation | tests passing incl. process kills; testnet submission BLOCKED | [docs/status/M05.md](docs/status/M05.md), ADR-0007 |
| M06 1Click adapter (optional) | BLOCKED / NOT_RUN (interfaces only) | [docs/status/M06.md](docs/status/M06.md) |
| M07 integrated API and audit | tests passing | [docs/status/M07.md](docs/status/M07.md), ADR-0009 |
| M08 professional UI | browser-tested on the simulated chain; manual a11y NOT_RUN | [docs/status/M08.md](docs/status/M08.md), ADR-0008, ADR-0010 |
| M09 hardening, e2e, delivery | tests passing; testnet items BLOCKED | [docs/status/M09.md](docs/status/M09.md), ADR-0011 |

## Test IDs

"Local" as above. "Testnet" is the real-network result; `—` means the test has no testnet half.

| Test | Owner | Local | Testnet / real | Notes |
|---|---|---|---|---|
| T-001 | M00 | PASS | — | cross-language vectors byte-identical (TS, Rust, browser) |
| T-002 | M00 | PASS | — | strict JSON, unknown fields, fail-closed config |
| T-003 | M07 | PASS | NOT_RUN | >200 denied cross-role calls over HTTP, state fingerprint unchanged |
| T-004 | M01 | PASS | NOT_RUN | real wallet NEP-413 PoP NOT_RUN (no wallet signing) |
| T-005 | M01 | PASS | NOT_RUN | separate people on separate devices NOT_RUN |
| T-006 | M01 | PASS | — | |
| T-007 | M02 | PASS (lower layer) | BLOCKED | deploy, fund and read on testnet; release half NOT_RUN |
| T-008 | M02 | PASS | NOT_RUN | |
| T-009 | M04 | PASS | NOT_RUN | |
| T-010 | M04 | PASS | NOT_RUN | |
| T-050 | M04 | PASS | NOT_RUN | |
| T-051 | M02 | PASS | NOT_RUN | |
| T-011 | M03 | PASS | NOT_RUN | |
| T-012 | M03 | PASS | NOT_RUN | |
| T-013 | M03 | PASS | — | two connections race; one wins |
| T-014 | M03 | PASS | — | |
| T-015 | M04 | PASS | NOT_RUN | |
| T-016 | M03 | PASS | NOT_RUN | |
| T-017 | M03 | PASS | NOT_RUN | |
| T-018 | M03 | PASS | NOT_RUN | |
| T-049 | M03 | PASS | NOT_RUN | |
| T-019 | M04 | PASS | NOT_RUN | testnet positive path per runbook §7 |
| T-020 | M04 | PASS | NOT_RUN | |
| T-021 | M04 | PASS | NOT_RUN | |
| T-022 | M04 | PASS | NOT_RUN | |
| T-023 | M04 | PASS | NOT_RUN | |
| T-046 | M04 | PASS | NOT_RUN | |
| T-047 | M04 | PASS | NOT_RUN | |
| T-024 | M06 | NOT_RUN | BLOCKED | needs 1Click partner credential |
| T-025 | M06 | NOT_RUN | BLOCKED | |
| T-026 | M06 | NOT_RUN | BLOCKED | needs contract consume entry point and authorization |
| T-027 | M06 | NOT_RUN | BLOCKED | |
| T-048 | M06 | NOT_RUN | BLOCKED | only the `classifyDryProbe` decision logic is unit-tested |
| T-055 | M06 | NOT_RUN | BLOCKED | |
| T-028 | M05 | PASS | NOT_RUN | |
| T-029 | M05 | PASS | NOT_RUN | real SIGKILL/TerminateProcess at named boundaries |
| T-030 | M05 | PARTIAL | BLOCKED | provider refund decision logic only |
| T-031 | M05 | PASS | NOT_RUN | |
| T-032 | M05 | PASS | NOT_RUN | |
| T-056 | M05 | PASS | NOT_RUN | |
| T-057 | M05 | PASS | NOT_RUN | |
| T-033 | M07 | PASS | NOT_RUN | checksummed, not signed |
| T-034 | M07/M08 | PASS (server and client) | — | manual screenshot review NOT_RUN |
| T-035 | M07 | PASS | NOT_RUN | |
| T-052 | M07 | PASS | NOT_RUN | |
| T-053 | M07 | PASS | NOT_RUN | |
| T-036 | M08 | PASS | NOT_RUN | four browser sessions, simulated chain; NEP-413 wallet connector BLOCKED |
| T-037 | M08 | PARTIAL | NOT_RUN | STALE slot and wrong scope/attestor/key version not driven in the UI |
| T-038 | M08 | PARTIAL | NOT_RUN | UNKNOWN, REVIEW, PAID real; other states vocabulary-tested only |
| T-054 | M08 | PASS | NOT_RUN | |
| T-039 | M08 | PARTIAL | NOT_RUN | automated axe and keyboard PASS; manual screen-reader review NOT_RUN |
| T-040 | M08 | PARTIAL | NOT_RUN | 4 widths and 720 px PASS; true 200% zoom, landscape, long translations NOT_RUN |
| T-041 | M09 | PARTIAL | — | contract core: 600 generated sequences × 70 steps, shadow ledger and exact bucket moves, 2/2 ledger mutants killed; journal-level generated sequences NOT_RUN |
| T-042 | M09 | PARTIAL | NOT_RUN | API, service and contract PASS end to end to PAID at the new destination; UI destination screen not built |
| T-043 | M09 | PARTIAL | BLOCKED | clean clone, install, build, full check, contract tests, browser suite PASS; testnet corridor BLOCKED |
| T-044 | M09 | PASS | NOT_RUN | built API/worker entry points as processes, wasm, production web build (browser suite); no container or package format exists |
| T-045 | M09 | PARTIAL | BLOCKED | build manifest and verifier PASS; on-chain code hash and account BLOCKED; recording NOT_RUN |

## Blocked or not run (whole project)

| Item | State | User action |
|---|---|---|
| NEAR testnet accounts, deployment, funding, direct release | BLOCKED | [USER-NEXT-STEPS](docs/USER-NEXT-STEPS.md) §2–§3, §7; [scripts/testnet-deploy/README.md](scripts/testnet-deploy/README.md) |
| Relayer `TxSigner` with real key custody (worker exits 78) | BLOCKED | USER-NEXT-STEPS §4 |
| INV-13 acceptance by separate people on separate devices | NOT_RUN | USER-NEXT-STEPS §6 |
| NEP-413 wallet connector in the browser; NEAR account ownership check (`view_access_key`) | NOT_RUN (not built) | follow-up; USER-NEXT-STEPS §6 |
| Destination-change and refund-request screens; key rotation, recovery and service-enrollment screens | not built (API routes exist) | follow-up |
| Unexpected-asset recovery authorization | not built (assets recorded, never credited) | follow-up |
| Manual accessibility review; true 200% zoom | NOT_RUN | USER-NEXT-STEPS §8 |
| near-workspaces / near-sandbox tests | BLOCKED (no Windows sandbox binary) | run on Linux x86_64 or macOS arm64 |
| near-sdk `unit-testing` host tests | BLOCKED (needs a C toolchain on windows-gnu) | MinGW-w64 or Linux/macOS |
| 1Click dry probe (M06) | NOT_RUN | USER-NEXT-STEPS §9 |
| Funded mainnet payout | BLOCKED | separate explicit authorization (USER-NEXT-STEPS §10) |
| Signed audit export (dedicated export key) | not built | follow-up (ADR-0009) |
| Push, PR, deploy, publish | NOT_RUN | yours to do |
