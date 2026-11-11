# NEAR testnet deployment runbook (M02) — BLOCKED until you run it

Status: **BLOCKED**. This build was not allowed to create accounts, use the faucet, sign transactions or
move testnet NEAR. Nothing below has been run. Every step is for **you** to run with your own accounts.
Mainnet is out of scope: the contract `new` refuses any network other than `near-testnet`.

T-007 (real testnet deploy, fund from a recorded funder, read state) and REAL-PRODUCT-GATE item 2 stay
`NOT_RUN` until these steps produce real transaction hashes. Direct release to the supplier is M04.

## 0. What you need

- [near-cli-rs](https://github.com/near/near-cli-rs) (`near --version`), Node 22, pnpm 10, Rust with
  `wasm32-unknown-unknown`.
- Three testnet accounts you control: escrow (contract), buyer (funder), supplier (payout destination).
- About 6 testnet NEAR on the escrow account for storage staking (the wasm is ~450 KB: about 4.5 NEAR at
  1 NEAR per 100 KB, plus state), and whatever you fund the trade with on the buyer account.

## 1. Build and record the artifact digest

```sh
pnpm install --frozen-lockfile
pnpm run contract:build        # prints: dockside_escrow.wasm <bytes> bytes sha256 <hex>
```

Write the sha256 into your evidence. Optional, recommended before any real use: build again with
`cargo near build` (it applies `--cfg near` itself) and compare. WASM feature compatibility with the current
nearcore protocol was **not** verified on this host (no sandbox); the deploy step below is that check.

## 2. Create accounts (you)

```sh
near account create-account sponsor-by-faucet-service <escrow>.testnet autogenerate-new-keypair save-to-keychain network-config testnet create
near account create-account sponsor-by-faucet-service <buyer>.testnet  autogenerate-new-keypair save-to-keychain network-config testnet create
near account create-account sponsor-by-faucet-service <supplier>.testnet autogenerate-new-keypair save-to-keychain network-config testnet create
```

## 3. Deploy and initialise

```sh
near contract deploy <escrow>.testnet use-file contract/target/wasm32-unknown-unknown/release/dockside_escrow.wasm \
  with-init-call new json-args '{"network":"near-testnet","min_deposit_yocto":null}' \
  prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send
```

Record the transaction hash. Then verify the deployed code is the artifact you built (read-only):

```sh
DOCKSIDE_NEAR_RPC_URL=https://rpc.testnet.near.org node scripts/testnet-deploy/verify-deploy.mjs <escrow>.testnet
```

`verify-deploy.mjs` compares the on-chain `code_hash` with base58(sha256(local wasm)) and prints `get_config`.

## 4. Register a trade

The trade terms must name `<escrow>.testnet` as `escrowContractId`, `<buyer>.testnet` / `<supplier>.testnet`
as party accounts and the supplier as `payout.destination`. Buyer and supplier sign the trade-revision digest
with their **enrolled Dockside keys** (M01 principals), not with the NEAR account key; any account may relay
the call. `EscrowContract.registerTradeCall(termsArg(terms), buyerSig, supplierSig)` in `@dockside/near`
produces the exact arguments. Submit them with:

```sh
near contract call-function as-transaction <escrow>.testnet register_trade file-args register.json \
  prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' sign-as <any-account>.testnet network-config testnet sign-with-keychain send
```

## 5. Fund from the recorded funder

The NEAR account that signs this transaction becomes the deposit's original funder; refunds can only go back
to it.

```sh
near contract call-function as-transaction <escrow>.testnet fund json-args '{"trade_id":"<trd_...>"}' \
  prepaid-gas '30.0 Tgas' attached-deposit '<amount> NEAR' sign-as <buyer>.testnet network-config testnet sign-with-keychain send
near contract call-function as-read-only <escrow>.testnet get_ledger json-args '{"trade_id":"<trd_...>"}' network-config testnet now
```

Check `fullyFunded`, `funders.<buyer>.available` and `conservation: true`. Fund less than the amount to see
`partial`, or more to see `quarantined` for the same funder.

## 6. Evidence to keep

Commit sha, wasm sha256, deploy/init/register/fund transaction hashes, `get_config`/`get_ledger` output and
the `verify-deploy.mjs` output. Only then can T-007's deployment/funding half move from `NOT_RUN`.

## 7. Direct release on testnet (M04, BLOCKED until steps 1-5 exist)

The release path needs the evidence of M03 on chain first: `register_evidence_policy`,
`submit_manifest_attestation` (signed by the isolated ManifestAttestor process) and `submit_inspection`
(signed by the enrolled inspector). Then, with every payload produced by `@dockside/release`
`ReleaseService` and signed by the acting principal's own enrolled key:

1. Buyer approver: `prepareIntent` -> sign `RELEASE_INTENT` -> `recordIntentSignature` returns the
   `create_release_intent` call. Submit it from any account:

   ```sh
   near contract call-function as-transaction <escrow>.testnet create_release_intent file-args intent.json \
     prepaid-gas '50.0 Tgas' attached-deposit '0 NEAR' sign-as <any-account>.testnet network-config testnet sign-with-keychain send
   ```

2. Buyer approver: `prepareApproval` -> sign `BUYER_APPROVAL` -> `recordApproval` returns `approve_release`.
3. Anyone: `prepareExecution` returns `execute_release` (100 Tgas). The contract recomputes the whole
   conjunction, transfers the exact amount to the revision-bound `payout.destination` and settles in
   `on_release_transfer`.
4. Read back `get_release`, `get_ledger` and the supplier account balance:

   ```sh
   near contract call-function as-read-only <escrow>.testnet get_release json-args '{"trade_id":"<trd_...>"}' network-config testnet now
   ```

Evidence to keep: the create/approve/execute transaction hashes, the callback receipt outcome, `get_release`
showing `PAID`, `get_ledger` showing `released` per funder and `conservation: true`, and the supplier's
balance delta. Only then can T-007's release half and the T-019 testnet positive path move from `NOT_RUN`.
Destination change (`propose_destination_change`, `consent_destination_change`, `activate_destination_change`)
and CANCEL/ABANDON follow the same pattern; activation needs the trade's real `destinationChangeDelayMs` to
pass on chain.
