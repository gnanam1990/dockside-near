# NEAR testnet deployment: `run-all`

Status: **run on NEAR testnet by the repository owner from their own keys (M24), and validated end
to end on a local near-sandbox node (M16).** The owner's third run deployed nothing new
(`--skip-deploy`) and took one trade to PAID with the supplier receiving exactly the trade amount;
the first run had deployed and initialised the contract in one transaction and added the relayer's
function-call key. Transaction hashes and the read-only re-check: [docs/status/M24.md](../../docs/status/M24.md),
[docs/evidence/M24/](../../docs/evidence/M24/). T-007, the T-019 positive path and REAL-PRODUCT-GATE
item 2 are PASS on testnet for that build. Mainnet is refused by the script and by the contract
(`new` accepts only `near-testnet`).

The first runs on Windows found three problems, fixed in M24: near-cli-rs 0.31 asked an invisible
question while adding the relayer key, the Node helpers could not start npm's `near` shim, and a
transient "Transaction has expired" stopped the journey with a misleading message (see "Windows"
and "Retries and failures" below).

## What you run

You create the accounts. `run-all` does everything after that in one command:

| Step | What happens | Signed by |
|---|---|---|
| 1 | The wasm's SHA-256 and NEAR code hash must equal the build manifest's (`verify-artifact`) | nothing |
| 2 | Preflight: the four accounts exist; the escrow account has no code and holds enough for code storage (1 NEAR per 100 kB plus 1 NEAR); the buyer can pay the trade amount; the relayer holds 2 NEAR | nothing |
| 3 | Deploy the wasm and call `new("near-testnet", null)` **in one transaction**, so nobody can initialise the contract between the two | escrow account (keychain) |
| 4 | The on-chain code hash (`view_account`) must equal the manifest's `contract.nearCodeHash`, and `get_config` must report `near-testnet` | nothing |
| 5 | Add a function-call access key to the relayer, restricted to the escrow contract (any method, allowance `1 NEAR`). near-cli-rs generates it and saves it to `~/.near-credentials/<network>/<relayer>/ed25519_<key>.json`; the script checks the key's permission on chain | relayer account (keychain) |
| 6 | The journey (below), checking the supplier's balance rose by exactly the trade amount | buyer (funding only), relayer function-call key (everything else) |
| 7 | Write `run-record.json` | nothing |

The journey is one trade: `register_trade`, `register_evidence_policy`, `fund` (from the buyer's
own account, which makes it the recorded funder), `submit_manifest_attestation`, `submit_inspection`
(PASS), `create_release_intent`, `approve_release`, `execute_release`, then `PAID` at the bound
supplier. Its Dockside payloads (terms, policy, attestation, inspection, intent, approval) are built
and signed by `dockside-journey-mirror` (contract/integration/fixtures) with principal keys derived
from a fresh random seed for that run; they are not NEAR keys and are not stored. After every
transaction the mirror replays the call with the same `dockside-escrow-core` code at the receipt's
block time, and the contract's `get_ledger` must equal the core's.

The journey is a technical check of the deployed contract on the network, not the product flow: it
is not the INV-13 acceptance by separate people (docs/USER-NEXT-STEPS.md §6–§7), and it does not use
the API or the web app.

## Prerequisites

- Node 22, Rust 1.97 (cargo builds the payload builder; no C toolchain needed), git, a POSIX shell
  (on Windows: Git for Windows, or use `run-all.ps1`).
- [near-cli-rs](https://github.com/near/near-cli-rs) 0.31 (`near --version`); set `NEAR_CLI` if it is
  not `near` on your `PATH`. On Windows run-all finds the real `near.exe` behind npm's shims by
  itself (see "Windows").
- The deployable wasm and its manifest from the Linux container (ADR-0015), for the commit you deploy:

  ```sh
  mkdir -p .data/repro
  docker run --rm -v "$PWD":/repo:ro -v "$PWD/.data/repro":/out \
    -v dockside-cargo:/root/.cargo -v dockside-rustup:/root/.rustup \
    -e CARGO_HOME=/root/.cargo -e RUSTUP_HOME=/root/.rustup \
    node:22-bookworm-slim sh /repo/scripts/container-reproduce.sh "$(git rev-parse HEAD)"
  ```

  This leaves `.data/repro/dockside_escrow.wasm` and `.data/repro/build-manifest.json`, the defaults
  of `--wasm` and `--manifest`. Do not deploy a wasm built on your own machine (ADR-0015).

- Four testnet accounts you control, with their full-access keys in the near-cli-rs keychain
  (`save-to-keychain` or `save-to-legacy-keychain`):

  ```sh
  near account create-account sponsor-by-faucet-service <name>.testnet autogenerate-new-keypair save-to-keychain network-config testnet create
  ```

  | Variable | Account | Needs |
  |---|---|---|
  | `DOCKSIDE_ESCROW_ACCOUNT` | holds the contract | 1 NEAR per 100 kB of wasm (about 8 NEAR for a 0.8 MB build) plus 1 NEAR; the preflight computes the exact amount; fund it with 10 |
  | `DOCKSIDE_BUYER_ACCOUNT` | buyer party and funder | the trade amount plus 0.1 NEAR |
  | `DOCKSIDE_SUPPLIER_ACCOUNT` | supplier party and payout destination | exists; it signs nothing |
  | `DOCKSIDE_RELAYER_ACCOUNT` | submits the relayed calls | 2 NEAR |

  All four must be different named `.testnet` accounts (the contract's testnet corridor accepts only
  those).

## Run

```sh
export DOCKSIDE_ESCROW_ACCOUNT=<escrow>.testnet DOCKSIDE_BUYER_ACCOUNT=<buyer>.testnet \
       DOCKSIDE_SUPPLIER_ACCOUNT=<supplier>.testnet DOCKSIDE_RELAYER_ACCOUNT=<relayer>.testnet
scripts/testnet-deploy/run-all --network testnet
```

PowerShell:

```powershell
$env:DOCKSIDE_ESCROW_ACCOUNT = "<escrow>.testnet"   # and the other three
.\scripts\testnet-deploy\run-all.ps1 --network testnet
```

Options: `--rpc-url` (default `https://rpc.testnet.near.org`; must be https and not a mainnet host),
`--fallback-rpc-urls <a,b>` (or `DOCKSIDE_FALLBACK_RPC_URLS`: further RPC URLs, checked by the same
rules, that the read-only checks use when the primary fails at transport level),
`--wasm`, `--manifest`, `--amount-yocto` (default 50000000000000000000000, 0.05 NEAR), `--out`
(default `.data/testnet-run/<network>-<UTC time>`), `--skip-deploy` (reuse an escrow that already runs
the manifest's code), `--relayer-key-file` (reuse the key file from an earlier run),
`--allowance` (default `1 NEAR`). `--network` has no default.

On success it prints `run-all: PASS` and exits 0. Any refusal exits 2 with `run-all: <CODE>: ...`
before the step that would be wrong (for example `NETWORK_REFUSED`, `WASM_MISMATCH`,
`ESCROW_NOT_EMPTY`, `CODE_HASH_MISMATCH`, `INSUFFICIENT_BALANCE`); a failed near-cli-rs command
exits 1 and leaves its output in the record directory.

### Retries and failures

Every near-cli-rs command runs with stdin closed and a complete command line. near-cli-rs is stopped
as soon as it draws an interactive question (on Windows a closed stdin alone does not stop it), and
the run fails with `stopped at "<question>"`; a total timeout (`DOCKSIDE_NEAR_CLI_TIMEOUT_MS`,
default 300000) ends any other wait. near-cli-rs's "Error: Transaction has expired." means the RPC
rejected the transaction before inclusion, so run-all signs it again (a new near-cli-rs process with a
fresh nonce and block hash), at most 3 attempts. Nothing else is retried: not a printed transaction
id, a timeout or an unavailable RPC (the transaction may still be included; check it on chain before
running again), and not a contract refusal. Failure messages carry near-cli-rs's own error lines, and
the record files (`deploy.txt`, `relayer-key.txt`) hold every attempt. near-cli-rs submits through
its own `testnet` connection (`near config edit-connection testnet` changes its RPC);
`--fallback-rpc-urls` covers only run-all's read-only checks.

A journey that stops part way leaves its trade on chain, possibly funded. Its Dockside principal keys
come from a random seed that run-all never stores, so nobody can sign an approval, cancellation or
refund for that trade afterwards: its testnet NEAR stays locked in the escrow (testnet trade
`trd_9aced7e741a0462ac88ef4de0e67ba81`, docs/status/M24.md).

### Windows

- One line, from the repository root in PowerShell:

  ```powershell
  powershell -ExecutionPolicy Bypass -File .\scripts\testnet-deploy\run-all.ps1 --network testnet
  ```

  with the four `$env:DOCKSIDE_*_ACCOUNT` variables set first. PowerShell's default execution policy
  on Windows client editions refuses unsigned scripts; `-ExecutionPolicy Bypass` (or
  `Set-ExecutionPolicy -Scope Process Bypass` for the current window only) lifts that for this run
  without changing the machine's policy.
- Interactively, call near-cli-rs as `near.cmd` (for example `near.cmd account view-account-summary
  <name>.testnet network-config testnet now`): npm also installs `near.ps1`, which the same execution
  policy blocks.
- run-all needs no `NEAR_CLI` on Windows. It resolves the real binary
  `<npm prefix>\node_modules\near-cli-rs\node_modules\.bin_real\near.exe` from `npm_config_prefix`,
  Node's own directory, `%APPDATA%\npm` or `where near`, and maps a `NEAR_CLI` that names a shim
  (`near`, `near.cmd`, `near.ps1`) to that binary. `node scripts/testnet-deploy/tool.mjs near-cli`
  prints what it will run.
- near-cli-rs 0.31 asks which signature scheme a new key pair uses; run-all passes
  `--signature-scheme ed25519` when it creates the relayer key.

To run another journey against the same deployment:

```sh
scripts/testnet-deploy/run-all --network testnet --skip-deploy \
  --relayer-key-file ~/.near-credentials/testnet/<relayer>.testnet/ed25519_<key>.json
```

## What it leaves behind

In the record directory (git-ignored under `.data/`): `artifact.json`, `preflight.json`,
`deploy.txt` and `deploy-tx.txt`, `deployment.json` (on-chain code hash, `match: true`,
`get_config`), `relayer-key.txt` and `relayer.json` (public key and permission only),
`args/` (the exact arguments of every journey call), `journey.json` (every transaction hash, block
hash and block time, the release and ledger views) and `run-record.json` (summary). No file holds a
private key; the relayer's function-call key file is the one near-cli-rs wrote in your keychain
directory.

For gate evidence keep: the commit, `build-manifest.json`, `run-record.json`, `journey.json` and
`deployment.json`. Then T-007's deploy/fund/read half and the T-019 positive path can move from
`NOT_RUN` for that build.

## How it was validated (sandbox)

`contract/integration/sandbox-tests/tests/run_all_on_sandbox.rs`, run by `pnpm run contract:sandbox`
(scripts/sandbox/container-sandbox.sh, `node:22-trixie-slim`), plays the user's part on a local
near-sandbox node: it creates the four accounts with real create-account transactions, puts their
keys in a temporary near-cli-rs keychain and a near-cli-rs connection named `sandbox`, then runs
`run-all --network sandbox` and checks the chain itself: the code hash, the relayer's two keys, the
supplier's balance delta and `PAID`. It also checks that mainnet, a non-loopback sandbox RPC and a
wrong wasm are refused before any transaction, that a second run refuses to redeploy
(`ESCROW_NOT_EMPTY`), and that `--skip-deploy --relayer-key-file` runs a second journey.

Differences you will meet on testnet: real block times (the journey needs no waiting), faucet-funded
accounts, the OS keychain instead of `~/.near-credentials`, and testnet's protocol version, which can
differ from the sandbox's (nearcore 2.14.0, protocol 88).

## Manual calls (reference)

The commands run-all issues, for single steps or other entry points (refunds, holds, destination
changes, CANCEL/ABANDON, asset recovery). Party calls come from the API as
`{relay: {receiverId, methodName, args, gas, deposit}}`; submit the `args` JSON from the relayer:

```sh
near contract call-function as-transaction <escrow>.testnet <methodName> file-args relay-args.json \
  prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' sign-as <relayer>.testnet network-config testnet \
  sign-with-access-key-file ~/.near-credentials/testnet/<relayer>.testnet/ed25519_<key>.json send
```

Funding is the one call the funder signs from its own account (it becomes the deposit's original
funder; refunds can only go back to it):

```sh
near contract call-function as-transaction <escrow>.testnet fund json-args '{"trade_id":"<trd_...>"}' \
  prepaid-gas '30.0 Tgas' attached-deposit '<amount> NEAR' sign-as <buyer>.testnet network-config testnet sign-with-keychain send
near contract call-function as-read-only <escrow>.testnet get_ledger json-args '{"trade_id":"<trd_...>"}' network-config testnet now
```

`execute_asset_recovery` needs exactly one attached yoctoNEAR, which a function-call key cannot
attach: submit it from a full-access key. `verify-deploy.mjs` remains as a read-only check of a
deployment against a locally built wasm (`DOCKSIDE_NEAR_RPC_URL=... node scripts/testnet-deploy/verify-deploy.mjs <escrow>.testnet`).
