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

Exact build of this status: see [the M13 status](docs/status/M13.md) for the commit, the wasm SHA-256 and NEAR code
hash recorded by `scripts/build-manifest.mjs` on both reproduction hosts, and the clean-checkout runs. The deployable
wasm is the one built in the Linux container ([ADR-0015](docs/adr/0015-status-consolidation-and-linux-reproduction.md)).

## Environment (observed)

Windows 11, Node 22.23.1, pnpm 10.34.9, Rust 1.97.1 (`x86_64-pc-windows-gnu`, plus `wasm32-unknown-unknown`), git,
Playwright 1.64.1 with the locally installed Chromium headless shell. No PostgreSQL and no C toolchain on the Windows
host. Docker Engine 29.1 runs inside the WSL 2 distribution Ubuntu-24.04; M13 used it for a second, Linux x86_64
reproduction in `node:22-bookworm-slim` (Node 22.23.5, Rust 1.97.1, pnpm 10.34.9, Playwright's own Chromium headless
shell). Nothing was installed or changed on Windows for it. Stack decision:
[ADR-0001](docs/adr/0001-stack-and-monorepo-layout.md).

## REAL-PRODUCT-GATE evidence matrix

"Local" means the exact code path ran with real keys, real persistence and real processes, but against the
compiled contract on a **simulated** NEAR host. The gate counts only the last column, and only `PASS` there
supports `WORKING_TESTNET`.

| # | Gate item | Local evidence (simulated chain) | Gate status (exact build, NEAR testnet) |
|---|---|---|---|
| 1 | Clean-checkout setup and pinned dependency evidence | **PASS on two hosts** (M13): `scripts/clean-checkout.mjs --e2e` on the Windows host and, through `scripts/container-reproduce.sh`, in a Linux container: fresh clone, frozen install, full check, contract host tests, `pnpm audit --prod`, build manifest and both browser suites. The TypeScript dist digest is identical on both hosts. The wasm digest is per host: the Windows build embeds the builder's cargo-home path, so the deployable artifact is the Linux container build (two container builds at different paths match exactly; ADR-0015) | **PASS** for setup and pins (this item needs no network). The testnet half of T-043 is item 2 |
| 2 | Real NEAR testnet deployment, native testnet NEAR funding from a recorded funder, direct release to the bound supplier | Contract, funding, release and settlement pass on the simulated host (T-007, T-019, T-022, T-033, T-036) | **BLOCKED**: no testnet accounts, faucet, signing or deployment allowed. USER-NEXT-STEPS §2–§7 |
| 3 | Canonical agreement and authority flow by independently enrolled buyer, supplier, inspector and risk/policy principals in separate PoP sessions | Four separately keyed principals, each in its own browser context and session, invited and then granted by their own organisation's administrator (T-036). Organisations bootstrapped, services enrolled through custody and keys rotated, revoked and recovered in the browser (M12). T-003/T-004/T-005/T-006 at the API | **NOT_RUN**: one operator drives every key in tests, which the gate disallows as acceptance (INV-13). USER-NEXT-STEPS §6 |
| 4 | Nonempty EvidencePolicy, authorized uploads filling every slot, bound ManifestAttestor signing every fact; caller booleans, wrong scope, rotated, revoked and concurrent replacement rejected | **PASS** (T-011, T-012, T-013, T-018, T-049, T-033). In the browser (M12): wrong scope, wrong attestor and wrong key version after a rotation are shown and never look bound; the trade then requires a new revision. T-037 stays PARTIAL: the STALE slot is not driven in the UI | **NOT_RUN** on testnet |
| 5 | Inspector signature verified against enrollment and the contract-accepted manifest digest | **PASS** (T-017, T-033, T-036) | **NOT_RUN** on testnet |
| 6 | Onchain HoldRecord SET by policy or risk; policy resolution denied; contract/API/UI release denied; AI output cannot mutate it; buyer request separated; non-risk resolution rejected | **PASS** (T-014, T-015, T-016, T-052, T-053, T-054) | **NOT_RUN** on testnet |
| 7 | Stable releaseIntentId locking exact value; dual-signed CANCEL; objective ABANDON; destination supersession with nonce, expiry, replay and race checks; buyer release signature against current facts | **PASS** (T-019, T-022, T-023, T-046, T-047, T-035, T-042) | **NOT_RUN** on testnet |
| 8 | Forged or unilateral destination change denied; legitimate dual-consent delayed revision invalidates manifest, attestation, hold view, intent and approval | **PASS** at contract, service, HTTP API (T-020, T-021, T-047, T-042; M09) and in the browser (M10: four sessions; a non-party sees no control, a unilateral proposal stays PROPOSED, early activation is refused with `DELAY_NOT_ELAPSED`, the real signed delay is waited out, r2 is bound, the old manifest, inspection and approval stop counting, PAID at the new destination) | **NOT_RUN** on testnet |
| 9 | Every refund/recovery reason, exact source-bucket revocation incl. excess to QUARANTINED, original-funder receipt, unexpected assets, concurrent refund/release | **PASS** in the contract for every refund reason, bucket restoration, funder-only receipts and release exclusion (T-008, T-009, T-010, T-050, T-057, T-041 generated). **PASS** for unexpected assets (M11, T-051): sender-only NEP-141 recovery with risk approval, 72-hour challenge window, challenge and revocation, journaled execution, API and browser to RECOVERED; NFTs and multi-tokens stay in review by design. The refund API and screens (M10) drive excess return and revocation, a dispute into REVIEW and a mutual cancellation to REFUNDED. **PARTIAL above the contract**: `TRADE_EXPIRY`, `INSPECTION_FAIL` and `PERMANENT_HOLD` are driven only to their refusals in API and UI; no browser race of release against refund | **NOT_RUN** on testnet |
| 10 | Durable lock before an external attempt; process kills across UNKNOWN/REVIEW/reconciliation/adjudication; authoritative no-transfer failure; late and contradictory evidence; restart without duplicate | **PASS** with real OS process kills against the simulated chain server (T-028, T-029, T-031, T-032, T-035, T-056, T-057). Asset-recovery execution (M11): transaction persisted before broadcast, crash after persist, lost response, early refusal, revert and contradiction pass with in-process crash injection. **PARTIAL**: no real OS process kills for the asset engine; T-030 provider refund is decision logic only | **NOT_RUN** on testnet |
| 11 | API/UI state from persisted and onchain observations: incomplete evidence, active/expired hold, REVIEW, UNKNOWN, refund, recovery | **PASS** in the browser for incomplete evidence, holds, UNKNOWN, REVIEW and PAID (T-036, T-037, T-038, T-054), refund states TIMELOCKED, REVIEW and REFUNDED with locked-value callouts (M10), unexpected-asset recovery through review, challenge, revocation and RECOVERED (M11), and key recovery with veto (M12). **PARTIAL**: refund UNKNOWN, RECONCILING and ADJUDICATION are not reachable on this backend; the STALE evidence slot is not driven | **NOT_RUN** on testnet |
| 12 | Checksummed audit export matching identities, manifests, holds, intent, ledgers and outcomes | **PASS** (T-033: seven tamper cases fail verification). The export is checksummed, not signed (ADR-0009) | **NOT_RUN** on testnet |
| 13 | Automated and manual accessibility evidence for the critical workflow | **PARTIAL**: axe (WCAG 2.2 AA tags) and no body overflow at 375/768/1024/1440 pass on every route, every trade tab and the M10–M12 screens (T-039 automated, T-040 partial) | **NOT_RUN**: manual assistive-technology review and true 200% zoom not done. USER-NEXT-STEPS §8 |

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
| M10 destination-change screen, refund routes and controls | browser-tested on the simulated chain; testnet NOT_RUN | [docs/status/M10.md](docs/status/M10.md), ADR-0013 |
| M11 unexpected-asset recovery | contract, journal, API and browser tested on the simulated chain and token; testnet NOT_RUN | [docs/status/M11.md](docs/status/M11.md), ADR-0014 |
| M12 key rotation, recovery and service-enrollment screens | browser-tested on the simulated chain; rebinding revision not built | [docs/status/M12.md](docs/status/M12.md), ADR-0012 |
| M13 status consolidation, Linux reproduction | full regression on the Windows host and in a Linux container | [docs/status/M13.md](docs/status/M13.md), ADR-0015 |

## Test IDs

"Local" as above. "Testnet" is the real-network result; `—` means the test has no testnet half.

| Test | Owner | Local | Testnet / real | Notes |
|---|---|---|---|---|
| T-001 | M00 | PASS | — | cross-language vectors byte-identical (TS, Rust, browser) |
| T-002 | M00 | PASS | — | strict JSON, unknown fields, fail-closed config |
| T-003 | M07 | PASS | NOT_RUN | >200 denied cross-role calls over HTTP, state fingerprint unchanged; the M10 refund and M11 asset-recovery routes add their own denials; the endpoint catalog lists no planned route |
| T-004 | M01 | PASS | NOT_RUN | real wallet NEP-413 PoP NOT_RUN (no wallet signing) |
| T-005 | M01 | PASS | NOT_RUN | separate people on separate devices NOT_RUN |
| T-006 | M01 | PASS | — | |
| T-007 | M02 | PASS (lower layer) | BLOCKED | deploy, fund and read on testnet; release half NOT_RUN |
| T-008 | M02 | PASS | NOT_RUN | native excess return and revocation in the UI (M10); unexpected NEP-141 and NFT records never credited and shown only in the asset-recovery panel (M11) |
| T-009 | M04 | PASS (contract); PARTIAL above it | NOT_RUN | API and UI drive EXCESS, PARTIAL, MUTUAL_CANCEL and dispute; `TRADE_EXPIRY`, `INSPECTION_FAIL`, `PERMANENT_HOLD` only to their refusals; refund UNKNOWN/RECONCILING/ADJUDICATION not reachable (M10) |
| T-010 | M04 | PASS (contract, journal); PARTIAL in UI | NOT_RUN | `VALUE_LOCKED` and the refund slice lock API-tested (M10); no browser race of release against refund |
| T-050 | M04 | PASS | NOT_RUN | full mutation matrix in the contract tests; API boundary roles, key-loss rows and 3 API mutants (M10) |
| T-051 | M02 | PASS | NOT_RUN | recovery protocol on the simulated host and chain with a simulated NEP-141 token: proof of control, risk approval, 72 h challenge window, challenge, revocation, journaled execution (M11); 7 mutants killed |
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
| T-037 | M08 | PARTIAL | NOT_RUN | wrong scope, wrong attestor and wrong key version PASS in the UI (M12); the STALE slot is not driven in the UI |
| T-038 | M08 | PARTIAL | NOT_RUN | UNKNOWN, REVIEW, PAID real; other states vocabulary-tested only; the reconciliation-request step no longer races the reconciler (M13) |
| T-054 | M08 | PASS | NOT_RUN | |
| T-039 | M08 | PARTIAL | NOT_RUN | automated axe and keyboard PASS, including the M10–M12 screens; manual screen-reader review NOT_RUN |
| T-040 | M08 | PARTIAL | NOT_RUN | 4 widths and 720 px PASS; true 200% zoom, landscape, long translations NOT_RUN |
| T-041 | M09 | PARTIAL | — | contract core: 600 generated sequences × 70 steps, shadow ledger and exact bucket moves, 2/2 ledger mutants killed; journal-level generated sequences NOT_RUN |
| T-042 | M09 | PASS | NOT_RUN | API, service and contract (M09) and the browser destination screen (M10), end to end to PAID at the new destination |
| T-043 | M09 | PARTIAL | BLOCKED | clean clone, install, build, full check, contract tests and both browser suites PASS on the Windows host and in a Linux container (M13); testnet corridor BLOCKED |
| T-044 | M09 | PASS | NOT_RUN | built API/worker entry points as processes, wasm, production web build (browser suite); no container or package format exists |
| T-045 | M09 | PARTIAL | BLOCKED | build manifests on both hosts (M13); the deployable wasm and NEAR code hash are the Linux container build's; on-chain code hash and account BLOCKED; recording NOT_RUN |

## Blocked or not run (whole project)

| Item | State | User action |
|---|---|---|
| NEAR testnet accounts, deployment, funding, direct release | BLOCKED | [USER-NEXT-STEPS](docs/USER-NEXT-STEPS.md) §2–§3, §7; [scripts/testnet-deploy/README.md](scripts/testnet-deploy/README.md) |
| Relayer `TxSigner` with real key custody (worker exits 78) | BLOCKED | USER-NEXT-STEPS §4 |
| INV-13 acceptance by separate people on separate devices | NOT_RUN | USER-NEXT-STEPS §6 |
| NEP-413 wallet connector in the browser; NEAR account ownership check (`view_access_key`) | NOT_RUN (not built) | follow-up; USER-NEXT-STEPS §6 |
| Trade revision that rebinds rotated, revoked or recovered keys | not built (no API route; the UI says a new revision is required and offers no control, ADR-0012) | follow-up |
| Re-issuing an expired key-recovery challenge | not built | follow-up |
| Policy, retention and integration settings screens | not built | follow-up |
| NFT and multi-token recovery adapters; recovery of assets not tied to a trade | not built by decision (ADR-0014 §6) | follow-up |
| Real OS process kills for the asset-recovery engine | NOT_RUN (in-process crash injection only) | follow-up |
| Refund `TRADE_EXPIRY`, `INSPECTION_FAIL`, `PERMANENT_HOLD` end to end above the contract; browser race of release against refund | NOT_RUN | follow-up |
| STALE evidence slot driven in the UI (T-037) | NOT_RUN (needs clock travel past freshness) | follow-up |
| Manual accessibility review; true 200% zoom | NOT_RUN | USER-NEXT-STEPS §8 |
| near-workspaces / near-sandbox tests | NOT_RUN (none written; the Linux container removes the platform blocker, ADR-0015) | follow-up, in the container |
| near-sdk `unit-testing` host tests | NOT_RUN (none written; the container has a C toolchain) | follow-up |
| A deployable wasm built outside the Linux container | do not deploy one: it embeds the builder's home path and its digest differs per machine (ADR-0015) | build with `scripts/container-reproduce.sh` (USER-NEXT-STEPS §1) |
| 1Click dry probe (M06) | NOT_RUN | USER-NEXT-STEPS §9 |
| Funded mainnet payout | BLOCKED | separate explicit authorization (USER-NEXT-STEPS §10) |
| Signed audit export (dedicated export key) | not built | follow-up (ADR-0009) |
| Push, PR, deploy, publish | NOT_RUN | yours to do |
