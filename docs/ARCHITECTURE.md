# Dockside architecture and developer reference

The judge-facing overview, on-chain proof and quick start are in the [README](../README.md). This page holds the
detail behind them: how the pieces fit, requirements, every build and test command, configuration, the module and
ADR map and the repository layout.

## How it works

A buyer and a supplier sign one canonical agreement that binds the supplier's payout destination, the evidence the
trade needs, the inspector, a separate risk/policy resolver and the NEAR escrow contract. The contract releases the
escrowed value only to the bound destination, and only when every condition holds at once: current attested
evidence, a current inspector PASS, no active or expired-unresolved hold, and the buyer's approval of that exact
state. A payout redirect needs both parties' signatures and a delay. Refunds return value only to the original
funder, from the bucket it came from. Outcomes are reconciled from chain receipts before the product shows PAID,
REFUNDED or FAILED.

The authoritative specification is the sealed pack in [`docs/spec/`](spec/START-HERE.md). Do not edit it.

## Requirements

- Node.js 22 (`>=22.13 <23`; developed on 22.23.1). `node:sqlite` is used and prints an `ExperimentalWarning`.
- pnpm 10 (developed on 10.34.9)
- Rust stable with cargo (developed on 1.97.1) and the wasm target: `rustup target add wasm32-unknown-unknown`
- For browser tests: a Playwright Chromium build (see apps/web/README.md)
- For the Linux reproduction, the deployable wasm and the local nearcore suites: a Docker Engine (for example inside
  WSL 2); nothing else is installed on the host
- For the testnet run: [near-cli-rs](https://github.com/near/near-cli-rs) 0.31 and your own testnet accounts

## Setup, build and test

```sh
pnpm install --frozen-lockfile
pnpm test                 # builds TypeScript and the contract wasm, then runs every vitest suite
pnpm run check            # format + lint + typecheck (incl. web) + test + secret scan
pnpm run contract:test    # cargo host tests of the contract core (incl. the T-041 generated sequences)
pnpm run web:e2e          # production web build + the four Playwright suites, each on its own local stack
node scripts/clean-checkout.mjs [--e2e]     # fresh clone into a temp dir, install, build, full test (T-043)
node scripts/build-manifest.mjs --out m.json  # exact-build identities incl. the NEAR code hash (T-045)
node scripts/build-manifest.mjs --verify m.json
pnpm run contract:reproduce [--e2e]   # Linux container clean checkout; exports the deployable wasm to .data/repro
pnpm run contract:sandbox             # near-sdk unit-testing + near-workspaces on near-sandbox + run-all validation
pnpm run build && pnpm run test:sandbox   # NEAR account ownership against a local nearcore node
pnpm run ci:policy                    # check .github/workflows/ci.yml against the CI rules (also in `check`)
pnpm run ci:local --list              # every CI job, step and command; `--job test|chain` replays one
```

`pnpm run web:e2e` runs four Playwright configurations in turn, each with its own stack because some move the
simulated clocks: `apps/web/playwright.config.ts` (ports 8791, 8792, 4391; `DOCKSIDE_E2E_API_PORT`,
`DOCKSIDE_E2E_CONTROL_PORT`, `DOCKSIDE_E2E_WEB_PORT`), `playwright.assets.config.ts` (chain clock +73 h; 8795, 8796,
4393; `DOCKSIDE_E2E_ASSETS_*_PORT`), `playwright.reasons.config.ts` (refund reasons and the release/refund race,
chain clock +25 h and +24 h; 8797, 8798, 4395; `DOCKSIDE_E2E_REASONS_*_PORT`) and `playwright.clock.config.ts`
(STALE evidence, trade and chain clocks +7 days; 8799, 8800, 4396; `DOCKSIDE_E2E_CLOCK_*_PORT`).

Linux reproduction in an official container (ADR-0015). The wasm built there is the deployable artifact: a wasm built
on a developer machine embeds that machine's cargo-home path, so its digest differs per machine.
`pnpm run contract:reproduce` runs `scripts/container-reproduce.sh` in `node:22-bookworm-slim`; set
`DOCKSIDE_DOCKER="wsl.exe -d <distro> -u root -- docker"` on Windows when the Docker Engine runs in WSL. The same
script can be run by hand:

```sh
docker run --rm -v "$PWD":/repo:ro -v "$PWD/.data/repro":/out \
  -e CARGO_HOME=/root/.cargo -e RUSTUP_HOME=/root/.rustup \
  node:22-bookworm-slim sh /repo/scripts/container-reproduce.sh "$(git rev-parse HEAD)" --e2e
```

`pnpm run contract:sandbox` (ADR-0019) takes that wasm and manifest, checks the wasm against the manifest, rebuilds it
from the commit in `node:22-trixie-slim` and requires the same digest, then runs the escrow on a local near-sandbox
2.14.0 node with real transactions (binaries pinned by SHA-256). Nothing in either container talks to testnet or
mainnet.

### Continuous integration

`.github/workflows/ci.yml` (ADR-0020) runs on pushes to `main` and on pull requests, with `contents: read`, no
secrets, actions pinned to full commit SHAs and per-ref cancellation. The `test` job runs on `ubuntu-24.04` and
`windows-2022`: frozen install, Rust 1.97.1 with wasm32, `pnpm run check`, `pnpm run contract:test`, the pinned
Playwright Chromium and `pnpm run web:e2e`. The `chain` job (Linux) runs `contract:reproduce`, `contract:sandbox` and
`test:sandbox` and keeps the reports and the deployable wasm as an artifact. The workflow is also policy-checked in `pnpm run check`.
It runs on GitHub and is green on `main`: [run 43353700412](https://github.com/gnanam1990/dockside-near/actions/runs/43353700412)
(commit `cf52cc5`, all three jobs passed: `ubuntu-24.04`, `windows-2022`, and the Linux container reproduction
with the near-sandbox suites).

`pnpm run contract:build` builds `contract/target/wasm32-unknown-unknown/release/dockside_escrow.wasm` and prints its
SHA-256. `pnpm run vectors` regenerates the cross-language canonical vectors; regeneration must produce no diff.

What the suites use: real on-disk SQLite, real Ed25519 keys, isolated signer child processes, real OS process kills,
the production JSON-RPC clients over HTTP, and the compiled wasm on a **simulated** NEAR host (not nearcore: no gas,
storage staking or transaction signature checks). The opt-in container suites add nearcore itself: real receipts,
promises, gas, access keys, block time and a NEP-141 token contract on a single local node.

## Run it locally

Everything on one machine over the simulated chain (ADR-0010):

```sh
pnpm run build && pnpm run contract:build
DOCKSIDE_ORIGIN=http://127.0.0.1:4391 pnpm run stack      # API :8791, control/relayer :8792 (loopback only)
DOCKSIDE_API_URL=http://127.0.0.1:8791 DOCKSIDE_RELAYER_URL=http://127.0.0.1:8792 \
  pnpm --filter @dockside/web exec vite preview --host 127.0.0.1 --port 4391
```

See [scripts/local-stack/README.md](../scripts/local-stack/README.md) and [apps/web/README.md](../apps/web/README.md).

The API on its own (`pnpm run api`, i.e. `node services/api/dist/main.js`) serves the authority routes. It adds the
trade routes only when `DOCKSIDE_ESCROW_CONTRACT_ID` and `DOCKSIDE_NEAR_RPC_URL` are both set. The worker
(`services/worker`) exits with code 78 (`RELAYER_SIGNER_NOT_PROVISIONED`) until a relayer key file is configured;
with one it signs with the relayer's function-call key after a chain preflight and custody checks (M43,
[ADR-0025](adr/0025-relayer-signer-custody-and-testnet-runtime.md), [runbook](runbooks/testnet-product.md)).

### Configuration (environment only, fails closed on unknown `DOCKSIDE_*` names; values are never echoed)

| Variable | Default | Notes |
|---|---|---|
| `DOCKSIDE_DB_PATH` | `.data/dockside.sqlite` | SQLite file (WAL, `synchronous=FULL`). `.data/` is git-ignored. |
| `DOCKSIDE_ORIGIN` | `http://localhost:8787` | Exact web origin bound into every proof; https, or http on loopback only. |
| `DOCKSIDE_HOST` / `DOCKSIDE_PORT` | `127.0.0.1` / `8787` | Listen address. |
| `DOCKSIDE_NETWORK` | `near-testnet` | `near-mainnet` is refused (funded rail BLOCKED). |
| `DOCKSIDE_ESCROW_CONTRACT_ID` | unset | Escrow account; with the RPC URL enables trade routes. |
| `DOCKSIDE_NEAR_RPC_URL` | unset | https (or loopback http) NEAR JSON-RPC; its host is the only allowed host. |
| `DOCKSIDE_OBJECT_STORE_DIR` | `.data/objects` | Content-addressed evidence objects (private directory). |
| `DOCKSIDE_CHALLENGE_TTL_MS` / `DOCKSIDE_SESSION_TTL_MS` / `DOCKSIDE_INVITATION_TTL_MS` | 5 min / 8 h / 3 d | Proof-of-possession lifetimes. |
| `DOCKSIDE_RECOVERY_DELAY_MS` | 48 h | Delay before a recovered key activates. |
| `DOCKSIDE_RECOVERY_CHALLENGE_TTL_MS` | the challenge lifetime | Lifetime of a key-recovery challenge (10 s–24 h); an expired one is re-issued by a security administrator (M14). |
| `DOCKSIDE_AUDIT_EXPORT_KEY_FILE` | unset | Seed file of the dedicated audit-export key (`pnpm run export-key generate --out <file>`); read only by an isolated signer process and enrolled at startup (M17). Without it the signed export answers `EXPORT_KEY_NOT_CONFIGURED`; the checksummed export still works. |
| `DOCKSIDE_DESTINATION_CHANGE_DELAY_MS` | 1 day | Delay new destination-change proposals bind (minimum 1 minute); the contract enforces the signed value. |
| `DOCKSIDE_REQUEST_PROOF_SKEW_MS` | 60 s | Allowed clock skew of per-request proofs. |
| `DOCKSIDE_RATE_LIMIT_UNAUTH_PER_MIN` | 300 | Unauthenticated requests per client address per minute (M09). |
| `DOCKSIDE_RATE_LIMIT_SESSION_PER_MIN` | 3000 | Authenticated requests per session per minute (M09). |
| `DOCKSIDE_FUNDED_PAYOUTS` | `BLOCKED` | The only accepted value. |
| `DOCKSIDE_LOG_LEVEL` | `info` | |

Authenticated calls send `Authorization: Dockside-Session <token>` and a `Dockside-Proof` header: an Ed25519
signature by the session key over the DCE-1 `dockside/request-proof` payload (origin, method, path and query, body
digest, time, nonce) (ADR-0003). There is no CORS. Exact `Origin` and `Sec-Fetch-Site` are checked, and every
response carries CSP, nosniff, frame-deny and no-store headers.

## What is built

| Area | Where | Module / ADR |
|---|---|---|
| Canonical encoding (DCE-1), codecs, schemas, signatures, roles, config | `packages/core`, `contract/crates/dockside-canonical` | M00, ADR-0001/0002 |
| SQLite store, checksummed forward-only migrations, nonces, idempotency, hash-chained audit log | `packages/store` | M00 |
| Organizations, principals, versioned keys, PoP sessions, invitations, service enrollment, rotation/recovery | `packages/authority` | M01, ADR-0003 |
| NEAR escrow contract: registration, per-funder ledger, refund rows, holds, evidence, release, exits, destination change | `contract/crates/dockside-escrow-core`, `dockside-escrow` (near-sdk 5.30.1) | M02–M04, ADR-0004–0006 |
| NEAR JSON-RPC client, escrow client, payload builders, transaction client | `packages/near` | M02–M05 |
| EvidencePolicy, uploads, manifests, ManifestAttestor, inspection, HoldRecords, advisory findings | `packages/evidence` | M03, ADR-0005 |
| Release intents, approvals, CANCEL/ABANDON, destination change, release journal | `packages/release` | M04, ADR-0006 |
| Economic-operation journal, transactional outbox, fenced workers, reconciler | `packages/journal`, `services/worker` | M05, ADR-0007 |
| 1Click dry-compatibility interfaces (blocked adapter only) | `packages/payout` | M06 (optional, NOT_RUN) |
| Integrated HTTP API, authority layers, idempotency, checksummed audit export, destination-change routes, rate limits | `services/api` | M07, M09, ADR-0009/0011 |
| Refund request routes over `dockside-refund-v1`, append-only refund journal (migration 0006) | `services/api/src/refunds.ts`, `packages/store` | M10, ADR-0013 |
| Unexpected-asset recovery: contract protocol, journaled execution (migration 0007), nine API routes | `contract/crates/dockside-escrow-core/src/assets.rs`, `packages/journal/src/assets.ts`, `services/api/src/assets.ts` | M11, ADR-0014 |
| Web UI (React + Vite), WebCrypto device keys, browser digest recomputation | `apps/web` | M08, ADR-0008/0010 |
| Destination-change screen (Agreement tab), Refund tab, asset-recovery review panel | `apps/web/src/screens/trade/` | M10, M11 |
| Key screens: own key rotation, directory, revocation, delayed recovery with veto, service enrollment through custody, trade impact | `apps/web/src/screens/org/`, `apps/web/src/screens/Recovery.tsx` | M12, ADR-0012 |
| Key-rebinding revision (contract module, six API routes, Agreement-tab control; migration 0009), recovery challenge re-issue, STALE slot under simulated time | `contract/crates/dockside-escrow-core/src/rebinding.rs`, `services/api`, `apps/web/src/screens/trade/KeyRebinding.tsx` | M14, ADR-0017 |
| Refunds on the contract clock, relayer nonce lease (migration 0008), process-kill boundaries of the asset engine and composed worker | `services/api/src/refunds.ts`, `packages/journal/src/relayer.ts` | M15, ADR-0016 |
| Real-chain suites (near-sdk unit-testing, near-workspaces on near-sandbox, NEP-141 test token, contract mirror) and the one-command testnet run | `contract/integration/`, `scripts/sandbox/`, `scripts/testnet-deploy/run-all` | M16, ADR-0019 |
| Policy, retention and integration settings; signed audit export with a dedicated export key and offline verifier; NEP-413 NEAR account ownership with a wallet-connector boundary (migration 0010) | `services/api/src/`, `services/api/src/cli/`, `apps/web/src/lib/wallet.ts`, `apps/web/src/screens/org/` | M17, ADR-0018 |
| Local stack, testnet runbook, clean-checkout, container reproduction and build-manifest scripts | `scripts/` | M08, M09, M13 |
| CI workflow, its policy check and local replay, `contract:reproduce` | `.github/workflows/ci.yml`, `scripts/ci/`, `scripts/container-reproduce.mjs` | M18, ADR-0020 |

Contract entry points: `new` (testnet only), `register_trade`, payable `fund`, `register_evidence_policy`,
`submit_manifest_attestation`, `submit_inspection`, `set_hold`, `resolve_hold`, `revoke_bound_key`,
`create_release_intent`, `approve_release`, `execute_release` (+ `on_release_transfer`), `submit_cancel_consent`,
`revoke_cancel_consent`, `abandon_release_intent`, `propose_/consent_/revoke_/activate_destination_change`,
`request_refund`, `cosign_refund`, `revoke_refund`, `dispute_refund`, `authorize_refund`,
`authorize_refund_signed`, `execute_refund` (+ `on_refund_transfer`), `ft_/nft_/mt_on_transfer` (recorded, never
credited), `request_/approve_/challenge_/revoke_/execute_asset_recovery` (+ `on_asset_recovery_transfer`; NEP-141
only, back to the proven sender after a 72-hour challenge window),
`propose_/consent_/revoke_/activate_key_rebinding` (key-only successor revisions, M14). There is no withdraw or sweep
entry point. Views:
`get_config`, `get_trade`, `get_ledger`, `get_refunds`, `get_holds`, `get_evidence`, `get_release`,
`get_unexpected_assets`, `get_unexpected_asset`.

### Destination change, refunds, asset recovery, keys and settings (M10–M17)

- The Agreement tab carries the dual-consent destination change: proposal by either bound party, consent by the
  other over the same TRADE_REVISION digest, the signed delay, activation and binding of the new revision, after
  which evidence, inspection and approval must be renewed.
- The Refund tab shows per-funder buckets and the signed reason matrix, and offers request, cosign, revoke, dispute,
  authorize and execute by bound role and contract state, with deadlines counted on the contract clock (M15). Every
  signed reason is driven above the contract: `EXCESS_FUNDING_RETURN`, `PARTIAL_FUNDING_RETURN`, `MUTUAL_CANCEL` and
  disputes (M10), and `TRADE_EXPIRY`, `INSPECTION_FAIL` and `PERMANENT_HOLD` to REFUNDED in the API and the browser
  (M15). Funder returns are submitted by the funder's own wallet transaction, so the page shows the exact call
  instead of a submit button.
- The "Asset recovery review" panel in the Refund tab lists unexpected token deposits. Only the sender's own
  transaction can request a recovery; the trade's risk/policy key approves a read-only validation; buyer, supplier,
  risk/policy or another claimant can challenge; execution is journaled like a payout.
- `/organization/keys`, `/organization/services` and `/recovery` cover key rotation in the browser, revocation,
  delayed recovery with veto (an expired recovery challenge can be re-issued) and service enrollment through a
  custody operator. A trade bound to a rotated, revoked or recovered key shows "new trade revision required" and
  links to the dual-signed key-rebinding control on the Agreement tab (M14). A revision that replaces a participant
  or service is not built.
- `/organization/policies`, `/organization/retention` and `/organization/integrations` hold the settings (readable by
  security administrators and auditors, writable by security administrators, every change audited); retention is a
  period and a preview, and no deletion job exists. `/organization/near-accounts` links a NEAR account by a NEP-413
  signature from a wallet that announces itself on the page, then requires `view_access_key` to report a full-access
  key; a link grants no capability. The Timeline tab prepares the signed audit export, re-verifies it in the browser
  and downloads it for `pnpm run verify-export` (M17).
- Browser tests: `apps/web/e2e/destination.spec.ts`, `refund.spec.ts`, `refund-reasons.spec.ts`, `keys.spec.ts`,
  `rebinding.spec.ts`, `evidence-stale.spec.ts`, `asset-recovery.spec.ts`, `settings.spec.ts` and `wallet.spec.ts`.

## Layout

```text
packages/core  store  authority  near  evidence  release  journal  payout
services/api   services/worker   apps/web
contract/      Rust workspace (canonical encoder, escrow core, near-sdk wasm contract);
               contract/integration/ is a separate workspace for the real-chain suites
scripts/       build-contract, build-manifest, clean-checkout, container-reproduce, secret-scan, ci/, lib/,
               local-stack/, near-sandbox/, sandbox/, testnet-deploy/
.github/       workflows/ci.yml
fixtures/      cross-language canonical vectors
docs/          adr/, status/, evidence/, USER-NEXT-STEPS.md, spec/ (sealed)
```

## Safety boundaries

Nothing in this repository pushes, deploys, signs with a real wallet, funds, calls 1Click or creates accounts. The
container suites run a local nearcore node only, and CI holds no secrets and only reads the repository. Testnet
deployment (`scripts/testnet-deploy/run-all --network testnet`, with accounts you create) and everything after it
are yours to run ([USER-NEXT-STEPS.md](USER-NEXT-STEPS.md)). Mainnet and the funded payout profile are refused at startup and by the
contract until separately authorized.
