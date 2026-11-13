# NEAR testnet deployment: `run-all`

Status: **run on NEAR testnet by the repository owner from their own keys (M24, and again in M34 for the
security-hardened contract), and validated end to end on a local near-sandbox node (M16).** The current
deployment (M34) is `gnanam1990-dock-escrow2.testnet`, running commit `4ff233b`'s contract, code hash
`7GEti5E6NWcjq8kHj5Gweed5HwggY1cxPD7cfbB65h8N`: one `run-all --network testnet` on a fresh escrow account
deployed and initialised it in one transaction, added a relayer function-call key restricted to escrow2 and took
one trade to PAID with the supplier receiving exactly the trade amount
([docs/status/M34.md](../../docs/status/M34.md), [docs/evidence/M34/](../../docs/evidence/M34/)). T-007, the
T-019 positive path and REAL-PRODUCT-GATE item 2 are PASS on testnet for that build. The first deployment
(M24, [docs/status/M24.md](../../docs/status/M24.md)) on `gnanam1990-dock-escrow.testnet` runs the superseded
pre-audit contract `5wqct3Wxavf9GXpdYJfrGWKpTZb1j95dJZQsNmAvzHuM`; do not point new runs (`--skip-deploy`) or
clients at it. Its stranded trade stays locked there. Mainnet is refused by the script and by the contract
(`new` accepts only `near-testnet`).

The first runs on Windows found three problems, fixed in M24: near-cli-rs 0.31 asked an invisible
question while adding the relayer key, the Node helpers could not start npm's `near` shim, and a
transient "Transaction has expired" stopped the journey with a misleading message (see "Windows"
and "Retries and failures" below). The M34 run on Windows needed none of the fallbacks: every
near-cli-rs command succeeded on its first attempt.

A new contract build goes to a fresh, empty escrow account, as in M34: run-all refuses an escrow that already
has code (`ESCROW_NOT_EMPTY`) and never redeploys in place. After such a move, set
`DOCKSIDE_ESCROW_ACCOUNT` (and the API's `DOCKSIDE_ESCROW_CONTRACT_ID`) to the new account everywhere; the
relayer key run-all adds is restricted to the escrow it was created for.

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

The default journey (`--journey paid`) is one trade: `register_trade`, `register_evidence_policy`,
`fund` (from the buyer's own account, which makes it the recorded funder), `submit_manifest_attestation`,
`submit_inspection` (PASS), `create_release_intent`, `approve_release`, `execute_release`, then `PAID`
at the bound supplier. Two more journeys cover the other on-chain outcomes (see "Hold and refund
journeys" under "Run"): `--journey hold` (a deterministic-policy hold SET and RESOLVED, then `PAID`) and
`--journey refund` (`MUTUAL_CANCEL` plus `EXCESS_FUNDING_RETURN`, then `REFUNDED` with every
yoctoNEAR back with the buyer). A fourth, `--journey refusal` (M47, see "Refusal journey"), sends six
calls the contract must reject, checks that each fails with its expected code and changes nothing,
and then completes the trade to `PAID`. The Dockside payloads (terms, policy, attestation, inspection,
holds, refund requests, intent, approval) are built and signed by `dockside-journey-mirror`
(contract/integration/fixtures) with principal keys derived from a fresh random seed for that run;
they are not NEAR keys. The seed is kept in the run directory (`journey-seed.json`, mode 0600) so an
interrupted journey can be finished with `--resume`. After every transaction the mirror replays the
call with the same `dockside-escrow-core` code at the receipt's block time, and the contract's
`get_ledger` and `get_refunds` must equal the core's.

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
  | `DOCKSIDE_BUYER_ACCOUNT` | buyer party and funder | the trade amount plus 0.1 NEAR (refund journey: plus the excess, default 0.01 NEAR) |
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

Options: `--rpc-url` (default `https://test.rpc.fastnear.com` since M44: NEAR deprecated
`https://rpc.testnet.near.org`, which now answers HTTP 429; any explicit https, non-mainnet URL is
still accepted),
`--fallback-rpc-urls <a,b>` (or `DOCKSIDE_FALLBACK_RPC_URLS`: further RPC URLs, checked by the same
rules, that the read-only checks use when the primary fails at transport level),
`--wasm`, `--manifest`, `--amount-yocto` (default 50000000000000000000000, 0.05 NEAR), `--out`
(default `.data/testnet-run/<network>-<UTC time>`), `--skip-deploy` (reuse an escrow that already runs
the manifest's code), `--relayer-key-file` (reuse the key file from an earlier run),
`--allowance` (default `1 NEAR`), `--journey <paid|hold|refund|refusal|attack-demo>` (default `paid`), `--excess-yocto`
(refund journey, default 10000000000000000000000, 0.01 NEAR), `--no-wait` (refund journey: pause
instead of waiting out the cooling period), `--stop-after <n>` (pause once the journey has n
transactions on chain), `--resume <run dir>` and `--pending-tx <hash|none>` (see "Finishing a
stopped journey"). `--network` has no default.

On success it prints `run-all: PASS` and exits 0. Any refusal exits 2 with `run-all: <CODE>: ...`
before the step that would be wrong (for example `NETWORK_REFUSED`, `WASM_MISMATCH`,
`ESCROW_NOT_EMPTY`, `CODE_HASH_MISMATCH`, `INSUFFICIENT_BALANCE`); a failed near-cli-rs command
exits 1 and leaves its output in the record directory. A journey paused on purpose (`--no-wait`,
`--stop-after`) exits 3 with `run-all: PAUSED: ...` and the `--resume` command that finishes it.

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
its own `testnet` connection (`near config edit-connection testnet` changes its RPC; if that
connection still names `rpc.testnet.near.org`, point it at `https://test.rpc.fastnear.com`);
`--fallback-rpc-urls` covers only run-all's read-only checks.

A journey that stops part way leaves its trade on chain, possibly funded. Since M42 run-all keeps
the journey's Dockside key seed in the run directory, so such a trade can be finished with
`--resume` (next section). Runs from before M42 stored no seed: nobody can sign an approval,
cancellation or refund for their trades, and their testnet NEAR stays locked in the escrow (testnet
trade `trd_9aced7e741a0462ac88ef4de0e67ba81`, docs/status/M24.md).

### Finishing a stopped journey (`--resume`)

Before its first transaction a journey writes three files to its run directory:

- `run-params.json`: network, RPC URL, journey, trade amount, wasm, manifest and relayer key file
  path (no secret);
- `journey-seed.json` (mode 0600): the random seed every Dockside principal key, id and nonce of
  that trade is derived from. These are test keys of that one trade, not NEAR keys, but whoever
  holds the file can sign for every role of the trade: keep it private and do not commit it (the
  default run directory is under the git-ignored `.data/`);
- `journey-state.json`: every completed step (transaction hash, block time, the exact mirror
  replay of it) and the call in flight, if any.

`run-all --resume <run dir>` (with the same four account variables) reads them back: it verifies
the wasm, the on-chain code hash and the relayer key again (read-only), replays the completed
steps on the mirror, requires the chain's `get_ledger` and `get_refunds` to equal the replay, and
continues with the next step. It takes no other settings (`--network`, `--journey`, `--out` and the
like are refused) except `--no-wait`, `--stop-after`, `--fallback-rpc-urls`, `--pending-tx` and
`--rpc-url`. `--rpc-url` on a resumed run replaces only the recorded RPC endpoint (for example a run
recorded with the deprecated `https://rpc.testnet.near.org`); it must pass the same rules for the
run's recorded network, run-all prints both URLs, and `run-params.json` keeps the recorded one.
A call whose transaction id was printed is settled from the chain (included: recorded; refused or
never included: built and sent again). If the run stopped while near-cli-rs was still sending, so
the id is unknown, run-all refuses with `PENDING_UNKNOWN`; look the transaction up for the named
signer in the explorer and pass `--pending-tx <hash>`, or `--pending-tx none` if it never reached
the escrow. run-all never starts a second journey in a directory that holds one (`RUN_EXISTS`).

### Hold and refund journeys

`--journey hold` runs the paid journey with a hold in the middle: after the inspection, the
enrolled deterministic-policy service (`POLICY_SETTER`, rule `doc-mismatch@1`, signed with the
trade's `policySetter` key) SETs a `DOC_MISMATCH` hold bound to the current manifest; the release
intent is created while the hold is ACTIVE and run-all records that `get_holds` reports it ACTIVE
and `get_release` lists `HOLD_ACTIVE` among the blockers; then the separate risk/policy principal
RESOLVEs it with `RELEASE_HOLD`, the buyer approves (over the resolved holds view) and the release
executes: `PAID`, the supplier receives exactly the trade amount. Ten transactions, all from the
relayer key except `fund`.

`--journey refund` uses the two refund rows that need nothing but the journey's own keys and one
hour of chain time (no trade expiry, no inspection FAIL, no 48-hour hold cooling):

| Step | Call | Signed by | Ledger (buyer) |
|---|---|---|---|
| fund | `fund` with the trade amount plus the excess | buyer (keychain) | amount AVAILABLE, excess QUARANTINED |
| `MUTUAL_CANCEL` | `request_refund` with the buyer's and the supplier's signatures over one request, so the one-hour cooling period starts at once | relayer key | AVAILABLE locked for refund |
| `EXCESS_FUNDING_RETURN` | `request_refund` from the funder's own account (the contract requires it); cooling runs from the overfunding | buyer (keychain) | QUARANTINED locked for refund |
| wait | until chain time passes both deadlines (about one hour) | nothing | |
| authorize, execute | `authorize_refund` and `execute_refund` for each | relayer key | REFUNDED |

The checks: both intents `REFUNDED`; the buyer's balance rises by exactly each refund amount across
its `execute_refund` (the relayer pays those fees); the buyer's ledger shows `funded` = `refunded` =
amount plus excess and every other bucket 0; nothing released; the supplier's balance unchanged;
conservation holds. By default run-all waits the hour and prints the minutes left every five
minutes; with `--no-wait` it pauses (exit 3) after the requests and `--resume` finishes later.

### Refusal journey

`--journey refusal` (M47) shows what the contract refuses. It is the hold journey with the trade
amount paid in two deposits, and six calls placed where exactly one thing is wrong with each. Every
one is a real transaction that reaches the escrow and fails there; none is simulated or skipped.

| # | Refused call | What is wrong, and only that | Signed by | Expected failure |
|---|---|---|---|---|
| 1 | `fund` with half the trade amount attached | the deposit names the digest of the same terms with the payout moved to the relayer account, not the registered revision's digest | buyer (keychain) | `STALE_REVISION` |
| 2 | `request_refund` `PARTIAL_FUNDING_RETURN` | the request is the one the funder could send from its own account at that moment (its whole PARTIAL value, initiator `FUNDER`); the relayer sends it | relayer key | `FORBIDDEN` |
| 3 | `submit_inspection` | the inspection attestation the contract has just accepted, byte for byte: its nonce is consumed | relayer key | `NONCE_REPLAYED` |
| 4 | `create_release_intent` | signed with the bound buyer key, but the destination (and its digest) is the relayer account, not the supplier the terms bind | relayer key | `DESTINATION_MISMATCH` |
| 5 | `execute_release` of the real intent | the deterministic-policy hold is ACTIVE (no approval exists yet either; the contract reports the hold first: `HOLD_ACTIVE,APPROVAL_MISSING`) | relayer key | `HOLD_ACTIVE` |
| 6 | `approve_release` | the approval the buyer would sign at that moment, signed with a run key the terms do not bind | relayer key | `SIGNATURE_INVALID` |

Order on chain (17 transactions, 11 accepted and 6 refused): `register_trade`,
`register_evidence_policy`, **1**, `fund` (first half), **2**, `fund` (second half: fully funded),
`submit_manifest_attestation`, `submit_inspection`, **3**, `set_hold`, **4**, `create_release_intent`,
**5**, `resolve_hold`, **6**, `approve_release`, `execute_release`: `PAID`.

For each refused call run-all:

1. asks the core (the mirror, on a copy of its state) before sending: it must refuse with the
   expected code, otherwise nothing is sent (`REFUSAL_NOT_EXPECTED`);
2. sends the transaction with near-cli-rs, which exits 1 and prints the transaction id of the
   failed transaction;
3. reads the transaction from the RPC: the receipt on the escrow must be a `Failure` whose panic text
   is `DOCKSIDE:<expected code>: ...` (`REFUSAL_ACCEPTED` if it succeeded, `REFUSAL_MISMATCH` for
   another code), and the core, given the same call at that receipt's block time, must answer with
   the same code and the same message (`MIRROR_MISMATCH` otherwise);
4. compares `get_trade`, `get_ledger`, `get_refunds`, `get_evidence`, `get_holds` and `get_release`
   with their values from before the call, and with the core's views of a state that never saw the
   call (`REFUSAL_CHANGED_STATE` if neither holds);
5. records the transaction hash, block, expected and actual code, the full panic text and the
   signer's balance before and after in `journey.json`, and `refused: <CODE>` on the transaction in
   `run-record.json`.

The final checks add: all six refused in order with the expected codes
(`allRefusedWithExpectedCode`), `refusalsChangedNothing`, the deposit attached to the refused
funding call is back with the buyer (`refusedDepositReturned`: the buyer paid only the fee), the
relayer account, which calls 1 and 4 tried to pay, received nothing (`relayerReceivedNothing`), the
supplier's balance rose by exactly the trade amount over the whole run, the buyer's ledger shows
funded = released = the trade amount, and the hold and release checks of the hold journey.

Half of `--amount-yocto` must be at least the contract's minimum deposit (0.001 NEAR by default);
run-all refuses a smaller amount before the first call. `--stop-after` counts refused transactions
too, and `--resume` settles a refused call that was in flight from the chain (it must be the failed
transaction with the expected code) instead of sending it twice. Like the hold journey, the trade
must reach `approve_release` within the manifest attestation's one-hour validity.

What it does not show: the refusals are the six above, sent by one operator with seed-derived keys;
a refusal is evidence about the deployed contract, not about the API, the UI or separately enrolled
people. More rejection cases run in the host and sandbox suites (docs/status/M47.md lists where).

Cost on testnet: the buyer pays the trade amount (returned by the refund journey, paid to the
supplier by the others) plus fees; each relayed call draws about 0.01 NEAR (100 Tgas at testnet's
minimum gas price) from the relayer key's 1 NEAR allowance (paid 7 calls, hold 9, refund 6,
refusal 14, of which 5 fail and cost less).

#### Owner commands (PowerShell, testnet escrow2)

From the repository root, against the M34 deployment `gnanam1990-dock-escrow2.testnet` and the
relayer function-call key M34 added (public key `ed25519:4X66DAChHBbMuG7rvTzFx5NcBMQuT8gkZp4UUPr8QaZf`,
docs/evidence/M34/run-testnet-20261113T022714Z/relayer.json), one line each.

Hold journey:

```powershell
$env:DOCKSIDE_ESCROW_ACCOUNT="gnanam1990-dock-escrow2.testnet"; $env:DOCKSIDE_BUYER_ACCOUNT="gnanam1990-dock-buyer.testnet"; $env:DOCKSIDE_SUPPLIER_ACCOUNT="gnanam1990-dock-supplier.testnet"; $env:DOCKSIDE_RELAYER_ACCOUNT="gnanam1990-dock-relayer.testnet"; powershell -ExecutionPolicy Bypass -File .\scripts\testnet-deploy\run-all.ps1 --network testnet --skip-deploy --relayer-key-file "$HOME\.near-credentials\testnet\gnanam1990-dock-relayer.testnet\ed25519_4X66DAChHBbMuG7rvTzFx5NcBMQuT8gkZp4UUPr8QaZf.json" --journey hold
```

Refund journey (waits about one hour for the cooling period):

```powershell
$env:DOCKSIDE_ESCROW_ACCOUNT="gnanam1990-dock-escrow2.testnet"; $env:DOCKSIDE_BUYER_ACCOUNT="gnanam1990-dock-buyer.testnet"; $env:DOCKSIDE_SUPPLIER_ACCOUNT="gnanam1990-dock-supplier.testnet"; $env:DOCKSIDE_RELAYER_ACCOUNT="gnanam1990-dock-relayer.testnet"; powershell -ExecutionPolicy Bypass -File .\scripts\testnet-deploy\run-all.ps1 --network testnet --skip-deploy --relayer-key-file "$HOME\.near-credentials\testnet\gnanam1990-dock-relayer.testnet\ed25519_4X66DAChHBbMuG7rvTzFx5NcBMQuT8gkZp4UUPr8QaZf.json" --journey refund
```

Refusal journey (about two minutes; the relayer key file argument is the one in the two commands above):

```powershell
$env:DOCKSIDE_ESCROW_ACCOUNT="gnanam1990-dock-escrow2.testnet"; $env:DOCKSIDE_BUYER_ACCOUNT="gnanam1990-dock-buyer.testnet"; $env:DOCKSIDE_SUPPLIER_ACCOUNT="gnanam1990-dock-supplier.testnet"; $env:DOCKSIDE_RELAYER_ACCOUNT="gnanam1990-dock-relayer.testnet"; powershell -ExecutionPolicy Bypass -File .\scripts\testnet-deploy\run-all.ps1 --network testnet --rpc-url https://test.rpc.fastnear.com --skip-deploy --relayer-key-file "<relayer key file>" --journey refusal
```

Add `--no-wait` to stop after the two requests instead; then, an hour or more later (or after any
interruption of either journey), finish it from the run directory the first command printed:

```powershell
$env:DOCKSIDE_ESCROW_ACCOUNT="gnanam1990-dock-escrow2.testnet"; $env:DOCKSIDE_BUYER_ACCOUNT="gnanam1990-dock-buyer.testnet"; $env:DOCKSIDE_SUPPLIER_ACCOUNT="gnanam1990-dock-supplier.testnet"; $env:DOCKSIDE_RELAYER_ACCOUNT="gnanam1990-dock-relayer.testnet"; powershell -ExecutionPolicy Bypass -File .\scripts\testnet-deploy\run-all.ps1 --resume .data/testnet-run/testnet-<UTC time>
```

If the key file is not at that path, `near.cmd account list-keys gnanam1990-dock-relayer.testnet
network-config testnet now` shows the relayer's keys; the file is the one near-cli-rs saved when M34
added the key (`relayer-key.txt` in that run's local record directory names it). Each run's `run-record.json`, `journey.json`
and `deployment.json` are the evidence to keep, as for the paid journey.

### Attack demo journey (M53)

`--journey attack-demo` creates the attack console's demo trade and stops on purpose: register, policy,
fund, attestation, inspection, release intent, the buyer's approval, then a deterministic-policy hold with
a 28-day lifetime (8 transactions, all accepted). The amount stays reserved for the bound supplier and the
release stays blocked; nothing is resolved, released or refunded. Its checks: one ACTIVE policy hold that
blocks the release, the approval recorded, the intent paying the bound supplier, funded = reserved = the
amount, nothing released or refunded, conservation. The PASS line ends
`attack-demo journey demo trade FUNDED, APPROVED and HELD`. What to do with the run afterwards (the page's
config, the five attacks, the hosted relay): [docs/runbooks/attack-console.md](../../docs/runbooks/attack-console.md).
Validated on a local nearcore node by `services/hosted/test/m53-attack-sandbox.test.ts`.

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
  Node's own directory or `where near` (npm's per-user prefix is on PATH), and maps a `NEAR_CLI` that names a shim
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
hash and block time, the release, ledger, holds and refunds views and the checks),
`run-record.json` (summary), and for `--resume` `run-params.json`, `journey-state.json` and
`journey-seed.json` (mode 0600). No file holds a NEAR private key; the relayer's function-call key
file is the one near-cli-rs wrote in your keychain directory. `journey-seed.json` holds the seed of
that trade's Dockside principal keys: keep it private, and delete it once the journey has passed if
nothing about that trade needs signing again.

For gate evidence keep: the commit, `build-manifest.json`, `run-record.json`, `journey.json` and
`deployment.json`. Then T-007's deploy/fund/read half and the T-019 positive path can move from
`NOT_RUN` for that build.

## How it was validated (sandbox)

The hold and refund journeys and `--resume` (M42) are validated in the same test, after the paid
runs described next: `--journey hold --stop-after 6` pauses with exit 3 while the hold is ACTIVE
on chain (`journey-seed.json` mode 0600; a resume with an extra setting is refused) and `--resume`
finishes it to `PAID` with the hold RESOLVED; `--journey refund --no-wait` pauses with both refund
intents TIMELOCKED, the test moves the sandbox clock one hour on (on testnet the refund journey
waits one real hour instead) and `--resume` finishes it: both `REFUNDED`, the buyer's ledger
`funded` = `refunded`, every other bucket 0, the supplier's balance unchanged; a second journey
in the same directory is refused (`RUN_EXISTS`).

The refusal journey (M47) has its own test in the same file, on its own node and accounts: one
`run-all --network sandbox --journey refusal` deploys, adds the relayer key and runs the journey;
the test then reads all 17 transactions back from the node with `EXPERIMENTAL_tx_status` (curl, not
run-all's reader) and requires the six refused ones to be failed transactions whose escrow receipt
panicked with the expected `DOCKSIDE:<CODE>:`, the replayed inspection to carry the same argument
bytes as the accepted one, the refused intent to name the relayer and the accepted one the
supplier, no refund intent, no intent naming the relayer, the supplier's balance up by exactly the
trade amount and the buyer out the trade amount plus fees only. A second refusal journey is stopped
after its fifth transaction (`--stop-after 5`, trade half funded) and finished with `--resume`; an
amount too small for two deposits is refused before any call. The same sequence also runs on the
host core without a chain in `contract/integration/fixtures/tests/m47_refusal_journey.rs`.

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
