# Runbook: the Dockside product on NEAR testnet (escrow2)

Runs the real product — API, worker and web app — against the deployed, security-hardened escrow
`gnanam1990-dock-escrow2.testnet` (code hash `7GEti5E6NWcjq8kHj5Gweed5HwggY1cxPD7cfbB65h8N`, commit `4ff233b`, M34).
The contract is not redeployed or changed. Everything here sends real **testnet** transactions; only you run it,
with your own keys. Mainnet is refused at every layer (configuration, RPC host, `status.chain_id`, contract
`get_config`).

The same profile was validated end to end in a browser against a local nearcore sandbox running the same wasm
(`pnpm run web:e2e:sandbox`, [M43 status](../status/M43.md)); only the RPC URL, the chain id and the account names
differ here.

## What runs where

| Process | Holds | Talks to |
|---|---|---|
| API (`pnpm run api`) | the database, the audit-export key (isolated signer child) | testnet RPC, read-only views |
| Worker (`pnpm run worker`) | the relayer's **function-call** key (loaded from its near-cli-rs key file, never logged or sent anywhere), the ManifestAttestor and deterministic-policy keys (each in its own isolated signer child) | testnet RPC: release/refund outbox, reconciler, party relay on loopback, attestor and policy services |
| Web (`vite preview`) | nothing | proxies `/v1` to the API and `/relay` to the worker's loopback relay |
| Each person's browser | that person's own device key (non-extractable) | the web origin only |
| The buyer's near-cli-rs keychain | the buyer's full-access key | sends the one `fund` deposit itself |

Startup is fail-closed. The API and the worker both run a **preflight**: the RPC must report `chain_id`
`testnet`, the escrow's on-chain code hash must equal the manifest's, and the contract must say `near-testnet`.
The worker then checks the relayer key file (regular file, not a symlink, at most 4 KiB, outside any git
checkout, readable by you only — on Windows no `Everyone`, `Users` or `Authenticated Users` ACL entry) and asks the
chain that the key is a function-call key whose receiver is escrow2. A full-access key is refused. Any refusal exits
78 with a reason code (`CODE_HASH_MISMATCH`, `CHAIN_ID_MISMATCH`, `MAINNET_REFUSED`, `PERMISSIONS_TOO_OPEN`,
`FULL_ACCESS_KEY`, `WRONG_RECEIVER`, …).

## 0. Prerequisites (once)

All commands are PowerShell, from the repository root on a machine you control.

```powershell
pnpm install --frozen-lockfile; pnpm run build; pnpm run web:build
```

Pick a private directory **outside** the repository for runtime files and keys:

```powershell
$D = "$HOME\dockside-testnet"; New-Item -ItemType Directory -Force $D | Out-Null
```

**Relayer key.** Use the function-call key `run-all` added to `gnanam1990-dock-relayer.testnet` in M34
(`ed25519:4X66DAChHBbMuG7rvTzFx5NcBMQuT8gkZp4UUPr8QaZf`, receiver escrow2, 1 NEAR allowance). near-cli-rs saved it
as a key file `<relayer>.testnet\ed25519_<public key>.json` in your legacy keychain (`$HOME\.near-credentials\testnet\`).
Point the worker at that file; do not copy it into the repository. If you prefer a fresh key:

```powershell
near account add-key gnanam1990-dock-relayer.testnet grant-function-call-access --allowance '1 NEAR' --contract-account-id gnanam1990-dock-escrow2.testnet --function-names '' autogenerate-new-keypair save-to-legacy-keychain network-config testnet sign-with-keychain send
```

Check (and if needed tighten) its ACL — the worker refuses a file other local users can read:

```powershell
$K = "<full path of the relayer key file>"; icacls $K
icacls $K /inheritance:r /grant:r "${env:USERNAME}:(R)"   # only if icacls listed Everyone/Users
```

**Service and audit-export keys** (ManifestAttestor, deterministic policy, signed audit export):

```powershell
pnpm run service-key generate --capability MANIFEST_ATTEST --out "$D\manifest-attestor.seed"
pnpm run service-key generate --capability DETERMINISTIC_POLICY_SET --out "$D\deterministic-policy.seed"
pnpm run export-key generate --out "$D\audit-export.seed"
```

Each prints a public key; keep the two service public keys for step 2.

**Manifest.** The committed M34 artifact record carries the deployed code hash:
`docs\evidence\M34\run-testnet-20261113T022714Z\artifact.json`. (`.data\repro\build-manifest.json` from
`pnpm run contract:reproduce` works too.)

## 1. Start the product (three terminals)

The shared profile (run it at the top of each terminal):

```powershell
$D = "$HOME\dockside-testnet"; $env:DOCKSIDE_DB_PATH="$D\dockside.sqlite"; $env:DOCKSIDE_OBJECT_STORE_DIR="$D\objects"; $env:DOCKSIDE_ORIGIN="http://127.0.0.1:4391"; $env:DOCKSIDE_NETWORK="near-testnet"; $env:DOCKSIDE_ESCROW_CONTRACT_ID="gnanam1990-dock-escrow2.testnet"; $env:DOCKSIDE_NEAR_RPC_URL="https://rpc.testnet.near.org"; $env:DOCKSIDE_NEAR_CHAIN_ID="testnet"; $env:DOCKSIDE_ESCROW_MANIFEST="docs\evidence\M34\run-testnet-20261113T022714Z\artifact.json"
```

Terminal 1, API (port 8787):

```powershell
$env:DOCKSIDE_PORT="8787"; $env:DOCKSIDE_AUDIT_EXPORT_KEY_FILE="$D\audit-export.seed"; $env:DOCKSIDE_RATE_LIMIT_UNAUTH_PER_MIN="60"; pnpm run api
```

Expect a `"listening"` line with `"chain":{"chainId":"testnet","escrow":"gnanam1990-dock-escrow2.testnet","codeHash":"7GEti5E6…"}`.

Terminal 2, worker (relay on loopback port 8788):

```powershell
$env:DOCKSIDE_RELAYER_ACCOUNT_ID="gnanam1990-dock-relayer.testnet"; $env:DOCKSIDE_RELAYER_KEY_FILE="<full path of the relayer key file>"; $env:DOCKSIDE_RELAY_PORT="8788"; $env:DOCKSIDE_MANIFEST_ATTESTOR_KEY_FILE="$D\manifest-attestor.seed"; $env:DOCKSIDE_POLICY_SERVICE_KEY_FILE="$D\deterministic-policy.seed"; pnpm run worker | Tee-Object -FilePath "$D\worker.log"
```

Expect `"event":"worker.started"` with `chainId` `testnet`, the escrow, the code hash and the relayer public key
`ed25519:4X66…QaZf`. The worker signs nothing before this line.

Terminal 3, web (port 4391):

```powershell
$env:DOCKSIDE_API_URL="http://127.0.0.1:8787"; $env:DOCKSIDE_RELAYER_URL="http://127.0.0.1:8788"; pnpm --filter @dockside/web exec vite preview --host 127.0.0.1 --port 4391
```

Open `http://127.0.0.1:4391`. `http://127.0.0.1:4391/readyz` must report `"network":"near-testnet"` and
`"fundedPayouts":"BLOCKED"`. For people on other devices serve it behind HTTPS and set `DOCKSIDE_ORIGIN` to that
origin (loopback is the only plain-HTTP origin accepted).

## 2. Who does what

Each person uses their own browser profile or device; nobody shares a device key.

1. **Three organisation administrators** (buyer org, supplier org, inspector org) each open `/sign-in`, enter the
   organisation name and **Request bootstrap challenge → Sign with this device key**.
2. **Buyer org administrator:**
   - Organization → Policies → **Register a new evidence policy** → *Use the commercial documents template* →
     **Review new policy → Register policy** (`commercial-docs` revision 1).
   - Organization → Service identities → enrol `manifest-attestor` (MANIFEST_ATTEST) and `deterministic-policy`
     (DETERMINISTIC_POLICY_SET) for `commercial-docs` revision 1 with the public keys from step 0, custody kind
     *Isolated signer process*, locator e.g. `signer://manifest-attestor/v1`. For each, save the
     "Challenge for the custody operator" JSON to a file and sign it:

     ```powershell
     pnpm run service-key sign-challenge --capability MANIFEST_ATTEST --key-file "$D\manifest-attestor.seed" --challenge-file "$D\attestor-challenge.json"
     ```

     paste the printed `signature`, **Submit custody proof**, then **Activate v1**.
   - Organization → invite **Buyer approver** and **Risk/policy resolver**; after each person accepted, grant.
3. **Supplier org administrator** invites the **Supplier signer**; **inspector org administrator** the **Inspector**.
   Each invitee opens `/sign-in`, pastes the invitation secret, signs with their own device key, and waits for the
   grant.
4. **Buyer approver:** Trades → New trade: supplier signer principal, amount (e.g. `0.05`), milestone, supplier
   account `gnanam1990-dock-supplier.testnet`, funding account `gnanam1990-dock-buyer.testnet`, inspector and
   risk/policy resolver principals, policy `commercial-docs` → **Request canonical agreement → Sign as buyer
   approver**, and send the proposal package to the supplier.
5. **Supplier signer:** Trades → Countersign → paste the package → **Review proposal** (the buyer signature must
   verify) → **Sign as supplier signer and submit** → **Submit to the escrow contract** twice
   (`register_trade`, `register_evidence_policy`, paid by the relayer).
6. **Buyer (funder), from the buyer's own keychain:** the trade's Overview shows **Deposit from the buyer's own
   wallet** with the exact `fund` call and the near-cli-rs command line. Run that command as shown (it is
   `near contract call-function as-transaction gnanam1990-dock-escrow2.testnet fund base64-args … attached-deposit '<exact> yoctoNEAR' sign-as gnanam1990-dock-buyer.testnet network-config testnet sign-with-keychain send`).
   Overview then reads *Fully funded: Yes (contract ledger)*. The relay refuses deposits; Dockside never funds.
7. **Supplier signer** uploads the commercial invoice; **inspector** uploads the report and photos. The worker's
   ManifestAttestor attests and relays (`submit_manifest_attestation`); the Evidence tab reads *Attestation
   current*. The **inspector** selects PASS, reason code, **Prepare inspection → Sign inspection → Submit**.
8. **Buyer approver:** Release tab → **Prepare release intent → Sign → Submit**, then **Prepare approval → Sign
   approval → Submit**, then **Execute direct release → Queue release**. The worker signs `execute_release` with the
   relayer key; the Payout tab shows the operation go to **PAID** with its *Source transaction*.

## 3. Capture the evidence for the README

Every hash is visible where it happened; keep them in one file as you go:

| Step | Where the hash is | Signer |
|---|---|---|
| `register_trade`, `register_evidence_policy`, `submit_inspection`, `create_release_intent`, `approve_release` | the relay panel's status line: "Contract accepted *method* (transaction *hash*)" | relayer |
| `fund` | near-cli-rs prints `Transaction ID: <hash>` | buyer |
| `submit_manifest_attestation` (and any `set_hold`) | `Select-String -Path "$D\worker.log" -Pattern 'attestor.submitted|policy.hold_set'` (`txHash` field) | relayer |
| `execute_release` | Payout tab → operation → *Source transaction* | relayer |

Then confirm on chain, read-only:

```powershell
near contract call-function as-read-only gnanam1990-dock-escrow2.testnet get_ledger json-args '{\"trade_id\":\"<trd_...>\"}' network-config testnet now
near contract call-function as-read-only gnanam1990-dock-escrow2.testnet get_release json-args '{\"trade_id\":\"<trd_...>\"}' network-config testnet now
```

and open `https://testnet.nearblocks.io/txns/<hash>` for each hash (the `execute_release` one shows exactly the
trade amount transferred from escrow2 to `gnanam1990-dock-supplier.testnet`). Also keep the worker's
`worker.started` line and the API's `listening` line (they carry the preflight result), and the Timeline tab's
signed audit export (**Prepare signed export**, verified offline with `pnpm run verify-export`).

What to paste into the README: the trade id, the table above with explorer links, the code hash from the
`worker.started` line, and one sentence that every party acted in its own browser session and that the worker
released with a function-call key restricted to escrow2.

## 4. Stop, restart and troubleshooting

- Ctrl+C in each terminal. Restarting is safe: the journal never re-sends an operation that left QUEUED; it
  reconciles the original transaction by its hash.
- `worker.refused` with `PERMISSIONS_TOO_OPEN`: fix the ACL as in step 0. `FULL_ACCESS_KEY`: you pointed at the
  relayer's full-access key; use the function-call key. `KEY_NOT_ON_CHAIN`: the key file is not an access key of
  the relayer account. `CODE_HASH_MISMATCH`: wrong escrow or manifest.
- A relay answer `UNKNOWN` carries the transaction hash: look it up on nearblocks before trying again (a
  re-submission is a new transaction).
- The relayer key's allowance (1 NEAR) pays gas; top it up by adding a new function-call key if it runs low.
- Only the buyer's `fund` (and funder-only refund calls) need a personal wallet; every other call is relayed.
