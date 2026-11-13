# Dockside

Dockside is a trade-payment escrow on NEAR. A buyer and a supplier sign one agreement that fixes where the supplier
is paid, what evidence the trade needs and who inspects it. A NEAR contract holds the buyer's deposit and pays it out
only to that agreed account, and only when the evidence, an inspector PASS and the buyer's approval all hold at once.

Built during NEAR HACKATHON (November 2026). License: [MIT](LICENSE).

## 30-second summary

- **Problem.** Trade payments are lost in three ordinary ways: the payout account is changed at the last moment (a
  "new bank details" message), money is released before the goods are inspected, and refunds go to whoever asks for
  them instead of to the party that paid.
- **What Dockside does.** The buyer and supplier sign one canonical agreement that binds the supplier's payout
  account, the evidence policy, the inspector, a separate risk/policy resolver and the escrow contract. The contract
  releases value only to the bound account, and only when attested evidence is current, the inspector has signed
  PASS, no hold is active or expired-unresolved, and the buyer approved that exact state. Changing the payout account
  needs both parties' signatures and a delay. Refunds go only to the original funder, from the bucket its money came
  from. The product shows PAID, REFUNDED or FAILED only after it has read the chain receipts.
- **What is in the repository.** A Rust escrow contract (near-sdk), a TypeScript API, journal worker and reconciler,
  and a React web app, with 630 automated tests plus browser and contract suites.
- **What has run on NEAR testnet.** The security-hardened contract is deployed on `gnanam1990-dock-escrow2.testnet`.
  One real trade ran there from funding to PAID: the buyer deposited 0.05 NEAR and the supplier received exactly
  0.05 NEAR. The API, worker and web app have run only locally, against a simulated NEAR chain.
  Claim level: `IMPLEMENTED_UNVERIFIED` (see [Honest status](#honest-status)).

## See the real paid trade on testnet (nothing to install)

Trade `trd_197c633d724eeb2cddc64d6dabf55976` on the deployed escrow, eight transactions, all final and successful:

| What | Link | What you should see |
|---|---|---|
| Escrow contract account | [gnanam1990-dock-escrow2.testnet](https://testnet.nearblocks.io/address/gnanam1990-dock-escrow2.testnet) | the deploy, the trade's calls and one outgoing transfer |
| Deploy and `new` in one transaction | [7TZqFwwK…akkA](https://testnet.nearblocks.io/txns/7TZqFwwKH9NKohDRS5RBfudep8hmwxeJoiNE18WdakkA) | `DeployContract` and `new` in the same transaction, signed by the escrow account |
| Buyer funds the trade | [74Mm1z1U…tAszAv](https://testnet.nearblocks.io/txns/74Mm1z1UZdJvgKfYUCjWF9FWzQhSYYzZ5yYk7LtAszAv) | `fund` with a 0.05 NEAR deposit from `gnanam1990-dock-buyer.testnet` |
| **Release to the supplier** | [9Wpr243g…qrkcEn](https://testnet.nearblocks.io/txns/9Wpr243gsWkQuKFbtmBrKMiGkXCPXp3MDfN8M1qrkcEn) | `execute_release` from the relayer, then a transfer of exactly 0.05 NEAR from the escrow to `gnanam1990-dock-supplier.testnet`; returns `true` |
| Supplier account | [gnanam1990-dock-supplier.testnet](https://testnet.nearblocks.io/address/gnanam1990-dock-supplier.testnet) | the incoming 0.05 NEAR from the escrow |

Read the trade's ledger straight from the contract (read-only, no account needed). The `args_base64` value is
`{"trade_id":"trd_197c633d724eeb2cddc64d6dabf55976"}`:

```sh
curl -s https://rpc.testnet.near.org -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":"1","method":"query","params":{"request_type":"call_function","finality":"final","account_id":"gnanam1990-dock-escrow2.testnet","method_name":"get_ledger","args_base64":"eyJ0cmFkZV9pZCI6InRyZF8xOTdjNjMzZDcyNGVlYjJjZGRjNjRkNmRhYmY1NTk3NiJ9"}}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(Buffer.from(JSON.parse(s).result.result).toString()))'
```

```powershell
$body = '{"jsonrpc":"2.0","id":"1","method":"query","params":{"request_type":"call_function","finality":"final","account_id":"gnanam1990-dock-escrow2.testnet","method_name":"get_ledger","args_base64":"eyJ0cmFkZV9pZCI6InRyZF8xOTdjNjMzZDcyNGVlYjJjZGRjNjRkNmRhYmY1NTk3NiJ9"}}'
$r = Invoke-RestMethod -Method Post -Uri https://rpc.testnet.near.org -ContentType 'application/json' -Body $body
[Text.Encoding]::UTF8.GetString([byte[]]$r.result.result)
```

You should see `"funded":"50000000000000000000000"` and `"released":"50000000000000000000000"` (0.05 NEAR in
yoctoNEAR) from the one funder `gnanam1990-dock-buyer.testnet`, every other bucket `"0"`, and `"conservation":true`.
The full run record, the on-chain code hash check and every transaction hash are in
[docs/status/M34.md](docs/status/M34.md) and [docs/evidence/M34/](docs/evidence/M34/).

## Try it in 10 minutes

Needs Node 22 (`>=22.13 <23`), pnpm 10, git, and Rust stable with the wasm target
(`rustup target add wasm32-unknown-unknown`). Every command below was run from a fresh clone of `main` on Windows 11
(Git Bash and PowerShell) for this README. On Linux the same commands run in the repository's container
reproduction (`pnpm run contract:reproduce`, [docs/status/M18.md](docs/status/M18.md)). macOS has not been tested.

1. **Clone and install.**

   ```sh
   git clone https://github.com/gnanam1990/dockside-near.git
   cd dockside-near
   pnpm install --frozen-lockfile
   ```

   You see `Done in …`. pnpm may also print `Ignored build scripts: esbuild`. That notice is harmless: nothing
   below needs the script.

2. **Run the test suite** (builds the TypeScript packages and the contract wasm first; about 2 minutes).

   ```sh
   pnpm test
   ```

   You see `Test Files  64 passed | 1 skipped (65)` and `Tests  630 passed | 3 skipped (633)`. These tests use real
   SQLite files, real Ed25519 keys, isolated signer processes and the compiled contract wasm on a simulated NEAR host.

3. **Watch the whole product path run in a browser** (four separately enrolled users, simulated chain; about 3
   minutes). The first command downloads Playwright's Chromium (on Linux add `--with-deps` if system libraries are
   missing).

   ```sh
   pnpm --filter @dockside/web exec playwright install chromium
   pnpm run web:build
   pnpm --filter @dockside/web exec playwright test e2e/product.spec.ts
   ```

   You see `6 passed`. In order, the tests have the buyer propose a trade and the supplier countersign it in another
   session, then fill the evidence slots (bad content is refused). Next, a policy hold is SET and only the risk
   session can RESOLVE it. Finally, the buyer locks and approves the release: a lost outcome stays locked and never
   shows as paid, and then the trade reaches PAID. They also check that no session token, invitation secret or
   evidence bytes reach the page, and run accessibility checks at four widths.

4. **Open the app yourself** (optional; simulated chain, loopback only). Use two terminals.

   ```sh
   # terminal 1
   DOCKSIDE_ORIGIN=http://127.0.0.1:4391 pnpm run stack
   # terminal 2
   DOCKSIDE_API_URL=http://127.0.0.1:8791 DOCKSIDE_RELAYER_URL=http://127.0.0.1:8792 \
     pnpm --filter @dockside/web exec vite preview --host 127.0.0.1 --port 4391
   ```

   ```powershell
   # terminal 1
   $env:DOCKSIDE_ORIGIN="http://127.0.0.1:4391"; pnpm run stack
   # terminal 2
   $env:DOCKSIDE_API_URL="http://127.0.0.1:8791"; $env:DOCKSIDE_RELAYER_URL="http://127.0.0.1:8792"
   pnpm --filter @dockside/web exec vite preview --host 127.0.0.1 --port 4391
   ```

   Terminal 1 prints `{"event":"stack.listening",…,"chain":"SIMULATED"}`. Open http://127.0.0.1:4391 and you see
   the Trades page with a "NEAR testnet" badge and "Sign in required". http://127.0.0.1:4391/readyz returns
   `{"ready":true,"schemaVersion":10,"network":"near-testnet","fundedPayouts":"BLOCKED"}`. To drive a trade by hand,
   create the administrator invitations through the stack's control port
   ([scripts/local-stack/README.md](scripts/local-stack/README.md)). Step 3 does exactly this for you.

5. **Contract tests** (optional; about 2 minutes): `pnpm run contract:test` prints `test result: ok` for every
   cargo test binary.

### Run the real testnet trade on your own accounts

This is the command that produced the paid trade above. It needs Docker for the reproducible contract build,
[near-cli-rs](https://github.com/near/near-cli-rs) 0.31 and four testnet accounts you create. The accounts are an
empty escrow account (10 NEAR), a buyer (at least 0.15 NEAR), a supplier and a relayer (2 NEAR). Their full-access
keys go in the near-cli-rs keychain.

```sh
pnpm run contract:reproduce        # builds the deployable wasm and manifest in a Linux container (.data/repro/)
export DOCKSIDE_ESCROW_ACCOUNT=<escrow>.testnet DOCKSIDE_BUYER_ACCOUNT=<buyer>.testnet \
       DOCKSIDE_SUPPLIER_ACCOUNT=<supplier>.testnet DOCKSIDE_RELAYER_ACCOUNT=<relayer>.testnet
scripts/testnet-deploy/run-all --network testnet
# Windows PowerShell: set the same four variables with $env:..., then
# powershell -ExecutionPolicy Bypass -File .\scripts\testnet-deploy\run-all.ps1 --network testnet
```

The script deploys and initialises the contract in one transaction and checks the on-chain code hash against the
build manifest. It then adds a relayer function-call key restricted to the escrow and runs one trade from `fund` to
`execute_release`. It prints `run-all: PASS`, writes `run-record.json`, and the supplier's balance rises by exactly
the trade amount. `--network` has no default and mainnet is refused. Details:
[scripts/testnet-deploy/README.md](scripts/testnet-deploy/README.md). The repository owner ran this on testnet
(M24, then M34 for the hardened contract). It was not re-run for this README.

## NEAR integration

What Dockside uses on NEAR, exactly:

- **Its own escrow smart contract** in Rust with `near-sdk` 5.30.1 (`contract/crates/dockside-escrow`), deployed on
  NEAR testnet at `gnanam1990-dock-escrow2.testnet` (code hash `7GEti5E6NWcjq8kHj5Gweed5HwggY1cxPD7cfbB65h8N`).
- **Native NEAR deposits and transfers.** `fund` is payable and records each funder. `execute_release` and
  `execute_refund` send value with `Promise::transfer` and settle in a callback (`on_release_transfer`,
  `on_refund_transfer`), so a refunded transfer is detected and returned to the reservation.
- **Signature checks on chain.** Every party and service payload (terms, evidence attestation, inspection, holds,
  approvals, destination changes, refunds) is an Ed25519 signature that the contract verifies with
  `env::ed25519_verify` against the keys bound in the agreement. Whoever submits the transaction cannot stand in for
  a party.
- **Function-call access keys.** The relayer submits party calls with a function-call key restricted to the escrow
  contract. Funding is the one call the funder signs from its own account.
- **Token standards.** Incoming NEP-141 (`ft_on_transfer`), NEP-171 (`nft_on_transfer`) and NEP-245
  (`mt_on_transfer`) deposits are recorded and never credited to a trade. A NEP-141 amount can be recovered to its
  proven sender after a 72-hour challenge window.
- **NEP-413** signed messages plus a `view_access_key` full-access check to link a NEAR account to a user (a link
  grants no capability).
- **NEAR JSON-RPC** through the repository's own client (`packages/near`): views, `view_account`,
  `view_access_key`, transaction status and receipts, which the reconciler reads before it shows any outcome.
- **Tooling:** near-cli-rs 0.31 drives the testnet deployment. `near-workspaces` and near-sandbox 2.14.0 run the
  contract on a local nearcore node in the test suites.

Not used: NEAR Intents / 1Click (only an interface and a blocked adapter exist, `NOT_RUN`), Chain Signatures, meta
transactions, and mainnet (refused at startup and by the contract's `new`).

## Honest status

**Claim level: `IMPLEMENTED_UNVERIFIED`.** Item-by-item evidence and every test ID: [BUILD-STATUS.md](BUILD-STATUS.md).

| | State |
|---|---|
| Whole product (contract, API, worker, web app) on a simulated NEAR chain | runs and is tested locally (steps 2–4 above) |
| Contract on a local nearcore node (near-sandbox) | real transactions: deploy, funding, release, refunds, destination change, a runtime-refunded transfer, NEP-141 recovery (M16) |
| Contract on NEAR testnet | **deployed** (`gnanam1990-dock-escrow2.testnet`, commit `4ff233b`); **one trade funded and released to PAID** with real transactions (M34) |
| Holds, cancel/abandon, destination change, refunds, recovery on testnet | not run |
| API, worker and web app against testnet | not run; the worker needs a relayer signer with real key custody and exits with code 78 until one is provided |
| Separate people on separate devices for the four roles | not run; the testnet trade was signed by one operator's run-all journey |
| Manual accessibility review | not run (automated axe checks pass) |
| CI on GitHub | workflow defined and replayed locally, not yet run on GitHub |
| 1Click (optional), funded mainnet payouts | `NOT_RUN`, `BLOCKED` |

The older escrow `gnanam1990-dock-escrow.testnet` runs the pre-audit contract and must not be used for new trades
([docs/status/M24.md](docs/status/M24.md)). What remains to reach `WORKING_TESTNET`:
[docs/USER-NEXT-STEPS.md](docs/USER-NEXT-STEPS.md). Per-module detail: [`docs/status/`](docs/status/); decisions:
[`docs/adr/`](docs/adr/); retained run output: [`docs/evidence/`](docs/evidence/).

## Security

The code went through two external audits. Each finding was treated as an unverified claim, reproduced on the real
code, and then fixed with tests. **Every confirmed finding is fixed**, and the deployed testnet contract includes
the contract fixes.

- **Automated penetration-test scan:** four findings, all confirmed and fixed:
  [vuln-0001](docs/status/SEC-dockside-vuln-0001.md) (argument injection in the build-manifest verifier),
  [vuln-0002](docs/status/SEC-dockside-vuln-0002.md) (unpinned toolchain bootstrap),
  [vuln-0003](docs/status/SEC-dockside-vuln-0003.md) (PDF filter hidden by a nested dictionary),
  [vuln-0004](docs/status/SEC-dockside-vuln-0004.md) (rate-limiter table exhaustion).
- **Audit following Cloudflare's open-source security-audit methodology:** findings and leads fixed in
  [m25](docs/status/SEC-dockside-m25-pdf-regex-redos.md) (PDF regex ReDoS),
  [m26](docs/status/SEC-dockside-m26-unavailable-read-not-pending.md) (unavailable read opened a false incident),
  [m27](docs/status/SEC-dockside-m27-recovery-key-revocation.md) (revoked recovery key resurrected),
  [m28](docs/status/SEC-dockside-m28-asset-queue-poison.md) (asset recovery queue poisoning),
  [m29](docs/status/SEC-dockside-m29-toolchain-volume-verification.md) (reused toolchain volumes),
  [m30](docs/status/SEC-dockside-m30-export-masking-and-idempotency-secret.md) (export masking, stored invitation
  secret), [m31](docs/status/SEC-dockside-m31-rebinding-consent-integrity.md) (key-rebinding takeover, consent
  replay), [m32](docs/status/SEC-dockside-m32-hold-liveness-and-funding-binding.md) (hold resolver liveness,
  deposits bound to the agreed terms) and [m33](docs/status/SEC-dockside-m33-contract-storage-bounds.md) (contract
  storage bounds).

Reviewer kit for an independent review: [docs/review-kits/security-review.md](docs/review-kits/security-review.md).

## Hackathon notes

- **Built during NEAR HACKATHON, November 2026.** Every commit in this repository is from 2026-11-11 or later. The
  first commit imports the project's specification pack ([`docs/spec/`](docs/spec/START-HERE.md), design documents,
  no code).
- **Sibling project.** The same author also submits **RouteSpec**
  ([github.com/gnanam1990/routespec-near](https://github.com/gnanam1990/routespec-near)), an independent project with
  its own repository, codebase, state, deployment, demo and submission.
- **Third-party libraries** (all pinned in `pnpm-lock.yaml` and `contract/Cargo.lock`): near-sdk, React, Vite,
  Vitest, Playwright with axe-core, Biome, fast-check and lucide-react, plus Node's built-in `node:sqlite`.
  near-cli-rs, near-sandbox and near-workspaces are used for deployment and tests.
- **Demo video script:** [docs/demo/DEMO-SCRIPT.md](docs/demo/DEMO-SCRIPT.md).

## How it works, in more detail

A buyer and a supplier sign one canonical agreement that binds the supplier's payout destination, the evidence the
trade needs, the inspector, a separate risk/policy resolver and the NEAR escrow contract. The contract releases the
escrowed value only to the bound destination, and only when every condition holds at once: current attested
evidence, a current inspector PASS, no active or expired-unresolved hold, and the buyer's approval of that exact
state. A payout redirect needs both parties' signatures and a delay. Refunds return value only to the original
funder, from the bucket it came from. Outcomes are reconciled from chain receipts before the product shows PAID,
REFUNDED or FAILED.

The authoritative specification is the sealed pack in [`docs/spec/`](docs/spec/START-HERE.md). Do not edit it.

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
`test:sandbox` and keeps the reports and the deployable wasm as an artifact. The workflow has been policy-checked and
replayed locally, never run on GitHub.

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

See [scripts/local-stack/README.md](scripts/local-stack/README.md) and [apps/web/README.md](apps/web/README.md).

The API on its own (`pnpm run api`, i.e. `node services/api/dist/main.js`) serves the authority routes. It adds the
trade routes only when `DOCKSIDE_ESCROW_CONTRACT_ID` and `DOCKSIDE_NEAR_RPC_URL` are both set. The worker
(`services/worker`) exits with code 78 (`RELAYER_SIGNER_NOT_PROVISIONED`) until a relayer signer with real custody
is provisioned.

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
are yours to run (docs/USER-NEXT-STEPS.md). Mainnet and the funded payout profile are refused at startup and by the
contract until separately authorized.
