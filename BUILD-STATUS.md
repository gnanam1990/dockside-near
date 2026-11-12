# Build Status

Project: Dockside, an implementation of the v2.0.0 specification pack (`docs/spec/`, sealed).

## Claim

| Claim | State | Why |
|---|---|---|
| Product claim level | **IMPLEMENTED_UNVERIFIED** | Every module is implemented and tested on a **simulated** NEAR chain, and the escrow contract also runs with real transactions on a **local nearcore node** (near-sandbox, M16). Nothing ran on NEAR testnet, and no REAL-PRODUCT-GATE item that needs testnet, separate people or a manual review has run. |
| `WORKING_TESTNET` | **not claimed** (BLOCKED) | Needs your testnet accounts, a deployment (`scripts/testnet-deploy/run-all --network testnet`), a relayer signer with real custody and independent principals. See [docs/USER-NEXT-STEPS.md](docs/USER-NEXT-STEPS.md). |
| `DRY_COMPATIBLE` (1Click, optional) | **NOT_RUN** | M06 has interfaces and a blocked adapter only. No partner registration or credential is allowed in this build. |
| `WORKING_MAINNET_PAYOUT` | **BLOCKED** | Refused at startup (`near-mainnet`, `DOCKSIDE_FUNDED_PAYOUTS`) and by the contract's `new`. Needs separate explicit authorization. |
| Continuous integration | **defined, NOT_RUN on GitHub** | `.github/workflows/ci.yml` (M18, ADR-0020) is policy-checked in `pnpm run check` and its commands were replayed locally; nothing was pushed, so it has never run on GitHub. |
| Deployment | **NOT_RUN** | Nothing is deployed anywhere. Nothing has been pushed. |

Exact build of this status: see [the M18 status](docs/status/M18.md) for the commit, the deployable wasm's SHA-256 and
NEAR code hash (from the Linux container build, ADR-0015), and every run with its exit code and counts. Earlier
per-module evidence is in [`docs/status/`](docs/status/) and [`docs/evidence/`](docs/evidence/).

## Environment (observed)

Windows 11, Node 22.23.1, pnpm 10.34.9, Rust 1.97.1 (`x86_64-pc-windows-gnu`, plus `wasm32-unknown-unknown`), git,
Playwright 1.64.1 with its Chromium headless shell. No PostgreSQL and no C toolchain on the Windows host. Docker
Engine 29.1 runs inside the WSL 2 distribution Ubuntu-24.04: the Linux reproduction runs in `node:22-bookworm-slim`
(ADR-0015), the real-chain suites in `node:22-trixie-slim` with near-sandbox 2.14.0 and near-cli-rs 0.31.1 pinned by
SHA-256 (ADR-0019), and the account-ownership suite against nearcore 2.13.4 (ADR-0018). Nothing was installed or
changed on Windows for them. Since the vuln-0002 fix, both images are pinned by digest, Rust comes from a
rustup-init pinned by SHA-256 and the nearcore 2.13.4 binary from a SHA-256 pin with a locked npm install (ADR-0021,
[evidence](docs/status/SEC-dockside-vuln-0002.md)). Stack decision: [ADR-0001](docs/adr/0001-stack-and-monorepo-layout.md).

## REAL-PRODUCT-GATE evidence matrix

"Local" means the exact code path ran with real keys, real persistence and real processes against the compiled
contract on the **simulated** NEAR host, and, where it says **nearcore**, with real transactions on a local
near-sandbox node (not testnet). The gate counts only the last column, and only `PASS` there supports
`WORKING_TESTNET`.

| # | Gate item | Local evidence | Gate status (exact build, NEAR testnet) |
|---|---|---|---|
| 1 | Clean-checkout setup and pinned dependency evidence | **PASS on two hosts**, re-run in M18: the CI `test` job's commands replayed on the Windows host (frozen install, full check, contract host tests, the four browser stacks) and `pnpm run contract:reproduce --e2e` in a Linux container (fresh clone, frozen install, full check, contract tests, `pnpm audit --prod`, build manifest, Playwright Chromium with its system libraries, the four browser stacks). The CI workflow (M18) runs the same on `ubuntu-24.04` and `windows-2022`; it is defined and checked but has not run on GitHub | **PASS** for setup and pins (this item needs no network). The testnet half of T-043 is item 2 |
| 2 | Real NEAR testnet deployment, native testnet NEAR funding from a recorded funder, direct release to the bound supplier | **PASS on nearcore** (M16, re-run in M18): the container-built wasm deployed and initialised in one transaction, on-chain code hash equal to the manifest's, funding from two funders, release of exactly the trade amount to the bound supplier, PAID with conservation; `run-all --network sandbox` end to end with accounts made by real transactions. Simulated host: T-007, T-019, T-022, T-033, T-036 | **NOT_RUN** (BLOCKED for this build): you create four accounts and run `scripts/testnet-deploy/run-all --network testnet`. USER-NEXT-STEPS §2–§3 |
| 3 | Canonical agreement and authority flow by independently enrolled buyer, supplier, inspector and risk/policy principals in separate PoP sessions | Four separately keyed principals, each in its own browser context and session, invited and then granted by their own organisation's administrator (T-036). Keys rotated, revoked and recovered in the browser (M12), and the dual-signed key-rebinding revision that rebinds a trade to the new keys, to PAID (M14, T-006). NEAR account ownership by NEP-413 plus `view_access_key` (M17, T-004) | **NOT_RUN**: one operator drives every key in tests, which the gate disallows as acceptance (INV-13). USER-NEXT-STEPS §6 |
| 4 | Nonempty EvidencePolicy, authorized uploads filling every slot, bound ManifestAttestor signing every fact; caller booleans, wrong scope, rotated, revoked and concurrent replacement rejected | **PASS** (T-011, T-012, T-013, T-018, T-049, T-033). In the browser: wrong scope, wrong attestor and wrong key version (M12), and the STALE slot after simulated time passes its freshness deadline (M14, T-037). EvidencePolicy ownership and next-revision rule (M17) | **NOT_RUN** on testnet |
| 5 | Inspector signature verified against enrollment and the contract-accepted manifest digest | **PASS** (T-017, T-033, T-036); on nearcore a forged inspector key is refused (M16) | **NOT_RUN** on testnet |
| 6 | Onchain HoldRecord SET by policy or risk; policy resolution denied; contract/API/UI release denied; AI output cannot mutate it; buyer request separated; non-risk resolution rejected | **PASS** (T-014, T-015, T-016, T-052, T-053, T-054) | **NOT_RUN** on testnet |
| 7 | Stable releaseIntentId locking exact value; dual-signed CANCEL; objective ABANDON; destination supersession with nonce, expiry, replay and race checks; buyer release signature against current facts | **PASS** (T-019, T-022, T-023, T-046, T-047, T-035, T-042); on nearcore the intent locks exactly the trade amount, a duplicate joins, execution before approval is refused, a second execution and a forged private callback are refused (M16) | **NOT_RUN** on testnet |
| 8 | Forged or unilateral destination change denied; legitimate dual-consent delayed revision invalidates manifest, attestation, hold view, intent and approval | **PASS** at contract, service, HTTP API and in the browser (M09, M10, T-020, T-021, T-047, T-042), and on nearcore: forged and unilateral changes refused, early activation `DELAY_NOT_ELAPSED`, the old intent and manifest stop counting, the new destination receives exactly the amount (M16) | **NOT_RUN** on testnet |
| 9 | Every refund/recovery reason, exact source-bucket revocation incl. excess to QUARANTINED, original-funder receipt, unexpected assets, concurrent refund/release | **PASS** in the contract for every reason (T-008, T-009, T-010, T-050, T-057, T-041 generated). **PASS above the contract** (M15): `TRADE_EXPIRY`, `INSPECTION_FAIL` and `PERMANENT_HOLD` to REFUNDED in the API and in the browser on the contract clock, with the appeal, dispute and revocation branches; EXCESS, PARTIAL, MUTUAL_CANCEL and dispute (M10); a browser race of the release-intent lock against a mutual-cancel request in two contexts (exactly one accepted, one value movement). Unexpected NEP-141 assets: sender-only recovery with risk approval and 72-hour challenge window (M11, T-051). On nearcore: funder-only excess return, MUTUAL_CANCEL to the original funder, a real NEP-141 token recorded and never credited, then recovered to its sender (M16). NFTs and multi-tokens stay in review by design | **NOT_RUN** on testnet |
| 10 | Durable lock before an external attempt; process kills across UNKNOWN/REVIEW/reconciliation/adjudication; authoritative no-transfer failure; late and contradictory evidence; restart without duplicate | **PASS** with real OS process kills (SIGKILL/TerminateProcess) of the journal worker, the asset-recovery engine as its own process and the composed worker (outbox, reconciler and asset engine together) (T-028, T-029, T-031, T-032, T-035, T-056, T-057; M05, M15); relayer nonces sequenced across engines and processes (M15). On nearcore a release the runtime refunds settles FAILED and returns the reservation (M16, T-031). **PARTIAL**: T-030 provider refund is decision logic only (M06) | **NOT_RUN** on testnet |
| 11 | API/UI state from persisted and onchain observations: incomplete evidence, active/expired hold, REVIEW, UNKNOWN, refund, recovery | **PASS** in the browser for incomplete and STALE evidence, holds, UNKNOWN, REVIEW and PAID (T-036, T-037, T-038, T-054), refund states TIMELOCKED, REVIEW and REFUNDED counted on the contract clock (M10, M15), unexpected-asset recovery through RECOVERED (M11), key recovery with veto and key rebinding (M12, M14). **PARTIAL**: refund UNKNOWN, RECONCILING and ADJUDICATION are not reachable on this backend in the browser (covered at journal level, M05) | **NOT_RUN** on testnet |
| 12 | Checksummed audit export matching identities, manifests, holds, intent, ledgers and outcomes | **PASS** (T-033): checksummed export, seven tamper cases fail (M07); **signed** export with a dedicated export key in an isolated signer process, 14 tamper and trust cases fail with the named check, offline `verify-export` CLI, the browser's verdict equals the CLI's and a bundle downloaded in Chromium verifies offline (M17) | **NOT_RUN** on testnet; HSM/KMS custody of the export key is yours |
| 13 | Automated and manual accessibility evidence for the critical workflow | **PARTIAL**: axe (WCAG 2.2 AA tags) and no body overflow at 375/768/1024/1440 pass on every route, every trade tab and the M10–M17 screens (T-039 automated, T-040 partial) | **NOT_RUN**: manual assistive-technology review and true 200% zoom not done. USER-NEXT-STEPS §8 |

Optional 1Click dry status: **NOT_RUN** (it can be `NOT_RUN`, `UNKNOWN`, `INCOMPATIBLE` or `PASS`; only `PASS`
supports `DRY_COMPATIBLE`). Separate funded-mainnet gate: **BLOCKED**.

## Module summary

| Module | Status | Detail |
|---|---|---|
| M00 foundation/contracts | tests passing | [docs/status/M00.md](docs/status/M00.md), ADR-0001, ADR-0002 |
| M01 organization/authority | tests passing; INV-13 human acceptance NOT_RUN | [docs/status/M01.md](docs/status/M01.md), ADR-0003 |
| M02 NEAR escrow, funding, refund | tests passing on host, simulated host and local nearcore (M16); testnet NOT_RUN | [docs/status/M02.md](docs/status/M02.md), ADR-0004 |
| M03 evidence, inspection, holds | tests passing | [docs/status/M03.md](docs/status/M03.md), ADR-0005 |
| M04 release and destination | tests passing, release and destination change also on local nearcore; testnet NOT_RUN | [docs/status/M04.md](docs/status/M04.md), ADR-0006 |
| M05 journal and reconciliation | tests passing incl. process kills; testnet submission BLOCKED (relayer custody) | [docs/status/M05.md](docs/status/M05.md), ADR-0007 |
| M06 1Click adapter (optional) | BLOCKED / NOT_RUN (interfaces only) | [docs/status/M06.md](docs/status/M06.md) |
| M07 integrated API and audit | tests passing | [docs/status/M07.md](docs/status/M07.md), ADR-0009 |
| M08 professional UI | browser-tested on the simulated chain; manual a11y NOT_RUN | [docs/status/M08.md](docs/status/M08.md), ADR-0008, ADR-0010 |
| M09 hardening, e2e, delivery | tests passing; testnet items NOT_RUN | [docs/status/M09.md](docs/status/M09.md), ADR-0011 |
| M10 destination-change screen, refund routes and controls | browser-tested on the simulated chain; testnet NOT_RUN | [docs/status/M10.md](docs/status/M10.md), ADR-0013 |
| M11 unexpected-asset recovery | contract, journal, API and browser on the simulated chain; NEP-141 recovery also on nearcore (M16); testnet NOT_RUN | [docs/status/M11.md](docs/status/M11.md), ADR-0014 |
| M12 key rotation, recovery and service-enrollment screens | browser-tested on the simulated chain; the rebinding revision was built in M14 | [docs/status/M12.md](docs/status/M12.md), ADR-0012 |
| M13 status consolidation, Linux reproduction | full regression on the Windows host and in a Linux container | [docs/status/M13.md](docs/status/M13.md), ADR-0015 |
| M14 key-rebinding revisions, recovery challenge re-issue, STALE slot | contract, API and browser on the simulated chain; a revision that replaces a participant is not built | [docs/status/M14.md](docs/status/M14.md), ADR-0017 |
| M15 refund reasons above the contract, release/refund race, process kills | API and browser on the simulated chain; real OS process kills | [docs/status/M15.md](docs/status/M15.md), ADR-0016 |
| M16 escrow on local nearcore, run-all | near-sdk unit-testing and near-workspaces suites PASS on near-sandbox 2.14.0; `run-all --network sandbox` PASS; testnet NOT_RUN | [docs/status/M16.md](docs/status/M16.md), ADR-0019 |
| M17 settings, signed audit export, NEP-413 account ownership | API and browser tested; ownership verified against nearcore 2.13.4; retention deletion job not built | [docs/status/M17.md](docs/status/M17.md), ADR-0018 |
| M18 CI workflow, consolidation | workflow policy-checked and replayed locally; full regression on both hosts and nearcore; GitHub run NOT_RUN | [docs/status/M18.md](docs/status/M18.md), ADR-0020 |

## Test IDs

"Local" as above. "Testnet" is the real-network result; `—` means the test has no testnet half.

| Test | Owner | Local | Testnet / real | Notes |
|---|---|---|---|---|
| T-001 | M00 | PASS | — | cross-language vectors byte-identical (TS, Rust, browser) |
| T-002 | M00 | PASS | — | strict JSON, unknown fields, fail-closed config; u64 block timestamps from a real node (M15, M17) |
| T-003 | M07 | PASS | NOT_RUN | >200 denied cross-role calls over HTTP, state fingerprint unchanged; refund, asset-recovery, key-rebinding, settings, export and NEAR-link routes add their own denials (M10, M11, M14, M17) |
| T-004 | M01 | PASS | NOT_RUN | NEP-413 signatures from a test wallet key verified by the server and in the browser; `view_access_key` FullAccess checked on the simulated chain and on a local nearcore node (M17). A third-party wallet product was not exercised |
| T-005 | M01 | PASS | NOT_RUN | separate people on separate devices NOT_RUN |
| T-006 | M01 | PASS | — | dual-signed key-rebinding revision at contract, API and browser, to PAID with the new key (M14) |
| T-007 | M02 | PASS (simulated and nearcore) | NOT_RUN (BLOCKED for this build) | on nearcore: deploy and init in one transaction, code hash, funding, views (M16); testnet: `run-all --network testnet` is yours |
| T-008 | M02 | PASS (simulated and nearcore) | NOT_RUN | native excess return and revocation in the UI (M10); funder-only excess return on nearcore (M16); unexpected NEP-141 and NFT records never credited (M11, M16) |
| T-009 | M04 | PASS (contract, API, browser; nearcore for EXCESS and MUTUAL_CANCEL) | NOT_RUN | all reasons to REFUNDED above the contract, with appeal, dispute and revocation branches, on the contract clock (M10, M15); refund UNKNOWN/RECONCILING/ADJUDICATION not reachable in the browser |
| T-010 | M04 | PASS | NOT_RUN | `VALUE_LOCKED` both lock orders at the API; browser race of the release-intent lock against a mutual-cancel request in two contexts, exactly one value movement; destination activation refused during and after a refund (M15) |
| T-050 | M04 | PASS | NOT_RUN | full mutation matrix in the contract tests; API boundary roles, key-loss rows and 3 API mutants (M10) |
| T-051 | M02 | PASS (simulated and nearcore) | NOT_RUN | recovery protocol with a simulated token (M11, 7 mutants killed) and with a real NEP-141 contract on nearcore (M16) |
| T-011 | M03 | PASS | NOT_RUN | |
| T-012 | M03 | PASS | NOT_RUN | |
| T-013 | M03 | PASS | — | two connections race; one wins |
| T-014 | M03 | PASS | — | |
| T-015 | M04 | PASS | NOT_RUN | |
| T-016 | M03 | PASS | NOT_RUN | |
| T-017 | M03 | PASS | NOT_RUN | forged inspector key refused on nearcore (M16) |
| T-018 | M03 | PASS | NOT_RUN | |
| T-049 | M03 | PASS | NOT_RUN | |
| T-019 | M04 | PASS (simulated and nearcore) | NOT_RUN | release of exactly the trade amount to the bound supplier on nearcore (M16); the run-all journey is the testnet positive path |
| T-020 | M04 | PASS (simulated and nearcore) | NOT_RUN | |
| T-021 | M04 | PASS (simulated and nearcore) | NOT_RUN | |
| T-022 | M04 | PASS (simulated and nearcore) | NOT_RUN | |
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
| T-029 | M05 | PASS | NOT_RUN | real SIGKILL/TerminateProcess at named boundaries of the worker, the asset engine and the composed worker (M05, M15) |
| T-030 | M05 | PARTIAL | BLOCKED | provider refund decision logic only |
| T-031 | M05 | PASS (simulated and nearcore) | NOT_RUN | a release the runtime refunds settles FAILED and the reservation returns (M16) |
| T-032 | M05 | PASS | NOT_RUN | |
| T-056 | M05 | PASS | NOT_RUN | |
| T-057 | M05 | PASS | NOT_RUN | relayer nonce lease across engines and processes (M15) |
| T-033 | M07 | PASS | NOT_RUN | checksummed (M07) and signed with a dedicated export key, offline verifier (M17) |
| T-034 | M07/M08 | PASS (server and client) | — | manual screenshot review NOT_RUN |
| T-035 | M07 | PASS | NOT_RUN | |
| T-052 | M07 | PASS | NOT_RUN | |
| T-053 | M07 | PASS | NOT_RUN | |
| T-036 | M08 | PASS | NOT_RUN | four browser sessions, simulated chain; the NEP-413 wallet-connector boundary exists (M17), no third-party wallet bundled |
| T-037 | M08 | PASS | NOT_RUN | missing, wrong scope, wrong attestor, wrong key version (M12) and STALE (M14) in the UI; replacing a stale item under simulated time is covered at service level only |
| T-038 | M08 | PARTIAL | NOT_RUN | UNKNOWN, REVIEW, PAID real; refund UNKNOWN/RECONCILING/ADJUDICATION vocabulary-tested only |
| T-054 | M08 | PASS | NOT_RUN | |
| T-039 | M08 | PARTIAL | NOT_RUN | automated axe and keyboard PASS, including the M10–M17 screens; manual screen-reader review NOT_RUN |
| T-040 | M08 | PARTIAL | NOT_RUN | 4 widths and 720 px PASS; true 200% zoom, landscape, long translations NOT_RUN |
| T-041 | M09 | PARTIAL | — | contract core: 600 generated sequences × 70 steps, shadow ledger and exact bucket moves, 2/2 ledger mutants killed; journal-level generated sequences NOT_RUN |
| T-042 | M09 | PASS (simulated and nearcore) | NOT_RUN | API, service, contract, browser (M09, M10) and nearcore (M16) |
| T-043 | M09 | PARTIAL | NOT_RUN | clean clone, install, check, contract tests and the browser stacks PASS on the Windows host and in a Linux container (M13, re-run M18); the CI workflow runs them on both runner images but has not run on GitHub (M18); `run-all` validated on nearcore (M16); testnet corridor NOT_RUN |
| T-044 | M09 | PASS | NOT_RUN | built API/worker entry points as processes, wasm, production web build; the CI chain job uploads the deployable wasm and manifest as an artifact (M18); no container image or package format exists |
| T-045 | M09 | PARTIAL | NOT_RUN | build manifests on both hosts; the on-chain code hash equals the manifest's on nearcore (M16); testnet account and code hash NOT_RUN; recording NOT_RUN |

## Blocked or not run (whole project)

| Item | State | User action |
|---|---|---|
| NEAR testnet accounts, deployment, funding, direct release | BLOCKED for this build | create four testnet accounts, then `scripts/testnet-deploy/run-all --network testnet` ([USER-NEXT-STEPS](docs/USER-NEXT-STEPS.md) §2–§3; [scripts/testnet-deploy/README.md](scripts/testnet-deploy/README.md)) |
| Relayer `TxSigner` with real key custody (worker exits 78) | BLOCKED | USER-NEXT-STEPS §4 |
| INV-13 acceptance by separate people on separate devices | NOT_RUN | USER-NEXT-STEPS §6–§7 |
| Manual accessibility review; true 200% zoom, landscape, long translations | NOT_RUN | USER-NEXT-STEPS §8 |
| 1Click dry probe (M06) | NOT_RUN | USER-NEXT-STEPS §9 |
| Funded mainnet payout | BLOCKED | separate explicit authorization (USER-NEXT-STEPS §10) |
| CI workflow on GitHub | NOT_RUN (nothing pushed; the three action SHAs were not looked up on GitHub, ADR-0020 §3) | push a branch, confirm the SHAs, check both jobs (USER-NEXT-STEPS §1) |
| HSM/KMS custody of the audit-export key | not provisioned (isolated signer process, ADR-0018) | yours, behind the same `ExportKeySigner` seam |
| A third-party wallet product (for example wallet-selector) in the browser | NOT_RUN (the connector boundary and NEP-413 checks exist; no wallet bundled, ADR-0018 §9) | follow-up |
| A trade revision that replaces a participant or service (lost capability, revoked or descoped enrollment) | not built (ADR-0017) | follow-up; until then such a trade cannot be rebound |
| Replacing a STALE evidence item under simulated time in the browser | NOT_RUN (the browser stamps items with its wall clock; covered at service level, T-011/T-012/T-018) | follow-up |
| Payload windows of release, holds, inspection and destination prepared on the contract clock | follow-up (refunds use it since M15, ADR-0016) | follow-up |
| Refund UNKNOWN, RECONCILING, ADJUDICATION in the browser | NOT_RUN (not reachable on this backend; journal-level M05) | follow-up |
| Retention deletion job and tombstones | not built (period and preview only, ADR-0018 §2) | follow-up |
| NFT and multi-token recovery adapters; recovery of assets not tied to a trade | not built by decision (ADR-0014 §6) | follow-up |
| Provider refund (T-030), journal-level generated sequences (T-041) | PARTIAL / NOT_RUN | follow-up |
| A deployable wasm built outside the Linux container | do not deploy one: it embeds the builder's home path and its digest differs per machine (ADR-0015) | `pnpm run contract:reproduce` or the CI artifact (USER-NEXT-STEPS §1) |
| Push, PR, deploy, publish | NOT_RUN | yours to do |

Closed since M13 (now covered above): near-workspaces / near-sandbox tests and near-sdk `unit-testing` host tests
(M16); NEP-413 wallet-connector boundary and `view_access_key` ownership check (M17); key-rebinding revision and
recovery challenge re-issue (M14); policy, retention and integration settings screens (M17); real OS process kills
for the asset-recovery engine (M15); `TRADE_EXPIRY`, `INSPECTION_FAIL`, `PERMANENT_HOLD` above the contract and the
browser race of release against refund (M15); the STALE slot in the UI (M14); the signed audit export (M17).
