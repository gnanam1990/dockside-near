# Dockside

Dockside is a trade-payment escrow on NEAR. A buyer and a supplier sign one agreement that fixes where the supplier
is paid, what evidence the trade needs and who inspects it. A NEAR contract holds the buyer's deposit and pays it out
only to that agreed account, and only when the evidence, an inspector PASS and the buyer's approval all hold at once.

Built during NEAR HACKATHON (November 2026). License: [MIT](LICENSE). Architecture and developer reference:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

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

Demo video: <added after recording>

## On-chain proof (NEAR testnet, nothing to install)

Trade `trd_197c633d724eeb2cddc64d6dabf55976` on the security-hardened escrow
[`gnanam1990-dock-escrow2.testnet`](https://testnet.nearblocks.io/address/gnanam1990-dock-escrow2.testnet)
(code hash `7GEti5E6NWcjq8kHj5Gweed5HwggY1cxPD7cfbB65h8N`, commit `4ff233b`). Every transaction below is final and
successful, and value leaves the escrow only in step 8.

| # | Call | Signer | Transaction |
|---|---|---|---|
| – | deploy + `new("near-testnet")` in one transaction | escrow account | [7TZqFwwK…akkA](https://testnet.nearblocks.io/txns/7TZqFwwKH9NKohDRS5RBfudep8hmwxeJoiNE18WdakkA) |
| – | add the relayer function-call key (receiver: escrow2 only) | relayer account | [G2vmxhNA…DnZH](https://testnet.nearblocks.io/txns/G2vmxhNAfpwhHuLmkqwh3R8VQFyR7c7AWK77akjDDnZH) |
| 1 | `register_trade` | relayer | [8r9pyqMW…YjDh](https://testnet.nearblocks.io/txns/8r9pyqMWiXXga3wfs4PyYG5YrLRsJw2upiayYHi9YjDh) |
| 2 | `register_evidence_policy` | relayer | [FHkeJzD1…64h2](https://testnet.nearblocks.io/txns/FHkeJzD1UYoE7E7XJbEQK8bSCbVqTv9y2yqGeKuZ64h2) |
| 3 | `fund` 0.05 NEAR, bound to the agreed terms digest | buyer (its own key) | [74Mm1z1U…AszAv](https://testnet.nearblocks.io/txns/74Mm1z1UZdJvgKfYUCjWF9FWzQhSYYzZ5yYk7LtAszAv) |
| 4 | `submit_manifest_attestation` | relayer | [EZFkdWWR…y7Bn](https://testnet.nearblocks.io/txns/EZFkdWWRKCgRAfuEufKcMSwT1PB5txjZ6zB1jy3My7Bn) |
| 5 | `submit_inspection` (PASS) | relayer | [WQadd3x4…pNpz](https://testnet.nearblocks.io/txns/WQadd3x4Rx6a1mKzTfezVD7YT95fziFWmB9bkqeSNpz) |
| 6 | `create_release_intent` | relayer | [6U4pecMg…p2is](https://testnet.nearblocks.io/txns/6U4pecMg5VrfTk8Bnrax55TN3WcTA93qx4UhE5U8p2is) |
| 7 | `approve_release` | relayer | [oGPmEVG8…s6p](https://testnet.nearblocks.io/txns/oGPmEVG8q2nGDQxj4hHDoUeCNm1BHZJdQdkKiVVTs6p) |
| 8 | **`execute_release`**: transfer of exactly 0.05 NEAR to the supplier, returns `true` | relayer | [9Wpr243g…kcEn](https://testnet.nearblocks.io/txns/9Wpr243gsWkQuKFbtmBrKMiGkXCPXp3MDfN8M1qrkcEn) |

The relayer only submits each party's signed payload: the contract verifies every party signature itself
(`env::ed25519_verify`), so the submitter cannot stand in for a party. The supplier account
[`gnanam1990-dock-supplier.testnet`](https://testnet.nearblocks.io/address/gnanam1990-dock-supplier.testnet) shows
the incoming 0.05 NEAR.

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

## Try it (about 10 minutes)

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
   Repeated `ExperimentalWarning: SQLite is an experimental feature` lines are expected and harmless: Node 22
   flags its built-in `node:sqlite` module as experimental, and many test processes load it.

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
   The hold test runs for about a minute without printing anything while it moves the simulated clocks; that is
   expected.

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
| CI on GitHub | **runs and is green on `main`**: [run 43353700412](https://github.com/gnanam1990/dockside-near/actions/runs/43353700412) at commit `cf52cc5`, all three jobs passed (`ubuntu-24.04`, `windows-2022`, Linux container reproduction with the near-sandbox suites) |
| 1Click (optional), funded mainnet payouts | `NOT_RUN`, `BLOCKED` |

The older escrow `gnanam1990-dock-escrow.testnet` runs the pre-audit contract and must not be used for new trades
([docs/status/M24.md](docs/status/M24.md)). What remains to reach `WORKING_TESTNET`:
[docs/USER-NEXT-STEPS.md](docs/USER-NEXT-STEPS.md). Per-module detail: [`docs/status/`](docs/status/); decisions:
[`docs/adr/`](docs/adr/); retained run output: [`docs/evidence/`](docs/evidence/).

## Security

The team ran two security audits against the code. Both were **self-run by the team, not third-party audits**.
Every finding was treated as an unverified claim: it was first reproduced on the real code with a failing test, then
fixed, and that test now passes. **Every confirmed finding is fixed**, and the deployed testnet contract includes the
contract fixes.

- **[Strix](https://github.com/usestrix/strix) 1.7.0**, an open-source automated penetration-testing agent, run by
  the team against the repository. Four findings, all confirmed and fixed:
  [vuln-0001](docs/status/SEC-dockside-vuln-0001.md) (argument injection in the build-manifest verifier),
  [vuln-0002](docs/status/SEC-dockside-vuln-0002.md) (unpinned toolchain bootstrap),
  [vuln-0003](docs/status/SEC-dockside-vuln-0003.md) (PDF filter hidden by a nested dictionary),
  [vuln-0004](docs/status/SEC-dockside-vuln-0004.md) (rate-limiter table exhaustion).
- **Cloudflare's open-source security-audit skill methodology**
  ([github.com/cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill)), applied by the
  team. Findings and leads fixed in
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

Each `docs/status/SEC-*.md` file names the failing test, the fix and the commands that ran. Nothing in the
repository pushes, deploys, funds or signs with a real wallet, CI holds no secrets, and mainnet and funded payouts
are refused at startup and by the contract. Reviewer kit for an independent review:
[docs/review-kits/security-review.md](docs/review-kits/security-review.md).

## Hackathon notes

- **Built during NEAR HACKATHON, November 2026.** Every commit in this repository is from 2026-11-11 or later. The
  first commit imports the project's specification pack ([`docs/spec/`](docs/spec/START-HERE.md), design documents,
  no code).
- **Sibling project.** The same author also submits **RouteSpec**
  ([github.com/gnanam1990/routespec-near](https://github.com/gnanam1990/routespec-near)), an independent project with
  its own repository, codebase, state, deployment, demo and submission.
- **Demo video script:** [docs/demo/DEMO-SCRIPT.md](docs/demo/DEMO-SCRIPT.md).
- **Architecture, every build and test command, configuration and the module/ADR map:**
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Libraries

All pinned in `pnpm-lock.yaml` and `contract/Cargo.lock`: near-sdk, React, Vite, Vitest, Playwright with axe-core,
Biome, fast-check and lucide-react, plus Node's built-in `node:sqlite`. near-cli-rs, near-sandbox and near-workspaces
are used for deployment and tests.

## License

[MIT](LICENSE).
