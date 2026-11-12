# What you need to do to reach WORKING_TESTNET

Dockside is **IMPLEMENTED_UNVERIFIED**. All of the code paths below exist and pass their tests against a
simulated NEAR chain. The steps that remain need things this build was not allowed to create or hold: NEAR
testnet accounts, testnet NEAR, a deployed contract, signing keys with real custody, separate people on
separate devices, and (optionally) 1Click partner credentials. Every step here is for **you** to run. Nothing in
the repository runs them for you.

`WORKING_TESTNET` can be claimed only when every REAL-PRODUCT-GATE item (see the matrix in
[BUILD-STATUS.md](../BUILD-STATUS.md)) has been produced by **one exact build**, and you have recorded that
evidence. A recording or screenshot does not replace any step.

Never commit or paste keys, seed phrases, JWTs or API credentials into the repository, an issue or a
`DOCKSIDE_*` variable.

## 0. Prerequisites

- Windows, macOS or Linux with Node 22 (`>=22.13 <23`), pnpm 10, Rust stable with `wasm32-unknown-unknown`, git.
- A Docker Engine (on Windows, inside WSL 2) to build the deployable wasm in the pinned Linux container.
- [near-cli-rs](https://github.com/near/near-cli-rs) for account creation, deployment and submitting relayed calls.
- A NEAR testnet wallet you control for each funding account.
- Four people with their own devices and browsers for the buyer approver, supplier signer, inspector and risk/policy
  resolver (INV-13). Two more people (or the same people in a separate admin role) act as each organisation's
  security administrator. One person holding every key can run the flow, but that does **not** satisfy the gate.

## 1. Freeze and reproduce the build you will deploy

```sh
git clone <your copy of this repository> dockside && cd dockside
git checkout <the commit you intend to deploy>
node scripts/clean-checkout.mjs --e2e --report clean-checkout.json      # your own machine
mkdir -p .data/repro
docker run --rm -v "$PWD":/repo:ro -v "$PWD/.data/repro":/out \
  -v dockside-cargo:/root/.cargo -v dockside-rustup:/root/.rustup \
  -e CARGO_HOME=/root/.cargo -e RUSTUP_HOME=/root/.rustup \
  node:22-bookworm-slim sh /repo/scripts/container-reproduce.sh "$(git rev-parse HEAD)" --e2e
```

Both `clean-checkout.json` and `.data/repro/clean-checkout-report.json` must say `"result": "PASS"`. Keep
`.data/repro/build-manifest.json` and deploy `.data/repro/dockside_escrow.wasm`, the wasm the container built (the
script copies it only when its SHA-256 equals the manifest's). The manifest's `contract.nearCodeHash` is the code hash
your deployed account must report. Do not deploy a wasm built on your own machine: it embeds that machine's cargo-home path
(including your user name), and its digest differs from every other machine's (ADR-0015). Every later step uses this
one commit and this one wasm.

For the build recorded in [docs/status/M13.md](status/M13.md), the container wasm is 769 515 bytes; check its SHA-256
and NEAR code hash there.

## 2. Create testnet accounts

Create these with near-cli-rs (faucet-sponsored creation works on testnet). Use names you own:

| Account | Purpose |
|---|---|
| `<escrow>.testnet` | holds the contract; needs about 7.7 testnet NEAR of storage staking for the code (the container-built wasm is 769 515 bytes; 1 NEAR per 100 kB) plus state, so fund it with 10 |
| `<buyer>.testnet` | buyer party account and the recorded funder of the trade |
| `<treasury>.testnet` (optional) | a second funder, to see per-funder ledgers and refunds |
| `<supplier>.testnet` | supplier party account and the bound payout destination |
| `<supplier-alt>.testnet` | a second supplier-owned account, for the destination-change check |
| `<relayer>.testnet` | submits relayed calls and the worker's release transaction; give it a FunctionCall access key restricted to `<escrow>.testnet` |
| `<sender>.testnet` (optional) | holds an existing testnet NEP-141 token and sends a small amount to the escrow by mistake, for the unexpected-asset recovery check |

```sh
near account create-account sponsor-by-faucet-service <name>.testnet autogenerate-new-keypair save-to-keychain network-config testnet create
```

## 3. Deploy, initialise and verify the contract

Follow [scripts/testnet-deploy/README.md](../scripts/testnet-deploy/README.md) sections 1–3 with the wasm from
step 1. Then check the deployed code is the tested artifact:

```sh
DOCKSIDE_NEAR_RPC_URL=https://rpc.testnet.near.org node scripts/testnet-deploy/verify-deploy.mjs <escrow>.testnet
```

`onChainCodeHash` must equal `contract.nearCodeHash` in your manifest and `match` must be `true`. Write
`<escrow>.testnet` and the on-chain hash into the manifest's `deployment` section and keep the deploy and init
transaction hashes.

## 4. Provision the relayer signer (code plus custody, both yours)

The worker (`services/worker`) exits with code 78 and `RELAYER_SIGNER_NOT_PROVISIONED` until it has a signer. To
provide one:

1. Pin an official NEAR transaction library (for example a specific `near-api-js` version) and review it.
2. Implement the `TxSigner` interface from `@dockside/near` (`packages/near/src/tx.ts`):
   `sign(call, { nonce, blockHash })` must build the NEAR transaction for that function call, sign it with the
   relayer's FunctionCall key and return the serialized signed transaction and its hash (`SignedTx`).
3. Keep that key in an OS keychain, HSM, KMS or an isolated signer process, never in the repository, the database or
   a `DOCKSIDE_*` variable. Load it only in the worker process.
4. Change `services/worker/src/main.ts` to build `WorkerLoop` with that signer, `JsonRpcNearClient` pointed at
   `https://rpc.testnet.near.org` and `txValidityBlocks: 86400`.
5. Add a test that the worker still refuses to start when the signer is absent.

Party calls (trade registration, evidence policy, attestations, inspections, holds, intents, approvals, consents)
come back from the API as `{relay: {receiverId, methodName, args, gas, deposit}}`. On testnet someone must submit
each one. Either submit the `args` JSON with near-cli-rs from `<relayer>.testnet`:

```sh
near contract call-function as-transaction <escrow>.testnet <methodName> file-args relay-args.json \
  prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' sign-as <relayer>.testnet network-config testnet sign-with-keychain send
```

or build a relay endpoint around your `TxSigner` that accepts exactly these calls. The local stack's `/relay` works
only against the simulated chain. Funding is the one call the funder signs and sends from its own account.

## 5. Run the API and web app against testnet

Run on a machine you control, behind HTTPS for anything other than loopback:

```sh
pnpm run build
DOCKSIDE_DB_PATH=<private dir>/dockside.sqlite \
DOCKSIDE_OBJECT_STORE_DIR=<private dir>/objects \
DOCKSIDE_ORIGIN=https://<your web origin> \
DOCKSIDE_ESCROW_CONTRACT_ID=<escrow>.testnet \
DOCKSIDE_NEAR_RPC_URL=https://rpc.testnet.near.org \
DOCKSIDE_RATE_LIMIT_UNAUTH_PER_MIN=60 \
pnpm run api
```

Serve `apps/web` (`pnpm run web:build`) from the same origin, proxying `/v1`, `/healthz` and `/readyz` to the API
(apps/web/README.md). Check `/readyz` reports `network: near-testnet` and `fundedPayouts: BLOCKED`.

The ManifestAttestor and deterministic-policy services must run as their own processes with their own keys, ideally
on another host. `packages/authority/signer/isolated-signer.mjs` is the local reference; for testnet, enrol them
through `POST /v1/service-enrollments` and keep their keys out of the API process.

## 6. Enrol independent principals

Each person uses their own device and browser:

1. Each organisation's security administrator bootstraps the organisation in the web app (key proof of possession).
2. The buyer administrator invites the buyer approver, inspector and risk/policy resolver; the supplier administrator
   invites the supplier signer. Each invitee accepts in their own browser, proving their own key, and the
   administrator grants the role afterwards.
3. The buyer administrator enrols the ManifestAttestor and deterministic-policy services for the evidence policy.

The administrators enrol services under **Organization → Service identities** (the custody operator creates the
key and signs the proof; the locator is never shown) and manage keys under **Organization → Keys**. A person who
lost a key generates a recovery key under `/recovery` on the new device.

Not built, and worth knowing before you start: no NEP-413 wallet connector in the browser (Dockside keys are
WebCrypto keys in each browser), no check that a principal controls the NEAR account named in the terms (RPC
`view_access_key`), and no way to create the trade revision that rebinds a rotated, revoked or recovered key. A
trade bound to such a key says "new trade revision required" and can no longer be released with that key, so rotate
or recover keys before you create the testnet trade, not during it.

## 7. Run the trade on testnet and keep the evidence

Use the web app throughout and submit every relay from step 4. Keep each transaction hash and receipt.

1. The buyer creates the trade proposal, the supplier countersigns, then `register_trade` and
   `register_evidence_policy`.
2. `<buyer>.testnet` funds the exact amount with `fund` (README section 5). Optionally fund an excess from
   `<treasury>.testnet` and run the EXCESS_FUNDING_RETURN refund back to it.
3. The supplier and inspector upload every slot. The ManifestAttestor attests and the inspector signs PASS.
4. The deterministic-policy service SETs a hold. A deterministic-policy resolution must be refused. The buyer files a
   review request (no effect), and the risk/policy resolver RESOLVEs. Show that release is refused while the hold is
   ACTIVE and after it expires unresolved.
5. The buyer locks the release intent and approves it. Exercise a dual-signed CANCEL on one intent, and an ABANDON
   after expiry plus grace on another, before the final one.
6. Destination change on the Agreement tab: a forged and a unilateral change must be refused. A dual-consent change
   to `<supplier-alt>.testnet` waits out the delay (`DOCKSIDE_DESTINATION_CHANGE_DELAY_MS`, default one day, at
   least one minute), is activated and bound, and the old approval, manifest and inspection stop counting. Renew
   them before releasing.
7. The buyer executes. The worker submits once and the reconciler reaches PAID only with the final receipt to the
   bound destination. Stop the worker mid-flight once and restart it: there must be no second submission.
8. Refunds on the Refund tab, on a second testnet trade: the treasury's excess return is prepared in the web app and
   submitted from `<treasury>.testnet` itself with the exact call the page shows (no session or relayer can submit
   it); revoke one to see QUARANTINED restored exactly; run a mutual cancellation from request and cosignature
   through authorization after the period to REFUNDED at the original funder. Also run, at least once each,
   `TRADE_EXPIRY`, `INSPECTION_FAIL` and `PERMANENT_HOLD`, which this build drove only to their refusals above the
   contract.
9. Optional, unexpected assets: `<sender>.testnet` sends a small NEP-141 amount to the escrow with `ft_transfer_call`.
   It appears only in the "Asset recovery review" panel. The sender submits the request from its own account, the
   risk/policy resolver approves, the 72-hour window passes, and execution returns the exact amount to the sender.
10. Export the audit record (`GET /v1/trades/:id/audit-export`) and verify its checksum.
11. Record: commit, manifest, deploy/init/register/fund/release/refund transaction hashes, receipts, `get_ledger` with
   `conservation: true`, the supplier and funder balance deltas, the audit export and its checksum.

## 8. Accessibility evidence

- T-039: a manual keyboard-only and screen-reader pass (for example NVDA with Firefox, VoiceOver with Safari) through
  the critical flow. Record the problems you find and fix them.
- T-040: true browser zoom at 200%, landscape on a phone, and long translated strings.

## 9. Optional: 1Click dry compatibility (M06)

Not needed for `WORKING_TESTNET`. Register as a 1Click partner, keep the credential in a secret manager, pin the
official client and implement `OneClickAdapter` (`packages/payout`) against the **dry** quote endpoint only. Then
run T-024 and T-048 with redacted evidence. Only `PASS` supports `DRY_COMPATIBLE`.

## 10. Funded mainnet: separately authorized only

`DOCKSIDE_NETWORK=near-mainnet` and any `DOCKSIDE_FUNDED_PAYOUTS` value other than `BLOCKED` are refused at startup.
A funded corridor first needs a contract entry point that consumes a FundedPayoutAuthorization atomically, a verified
corridor, an exposure cap and your explicit authorization of network, wallet, amount, signer and executor
(REAL-PRODUCT-GATE "Separate funded-mainnet gate").

## When you are done

Update BUILD-STATUS.md item by item with the evidence from steps 1–8. Promote the claim to `WORKING_TESTNET` only if
every required item is `PASS` for the same commit and wasm.
