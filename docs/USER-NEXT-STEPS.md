# What you need to do to reach WORKING_TESTNET

Dockside is **IMPLEMENTED_UNVERIFIED**. Every code path below exists and passes its tests against a simulated NEAR
chain, the escrow contract also runs with real transactions on a local nearcore node (near-sandbox), and §2–§3 are
**done**: you deployed the security-hardened escrow (commit `4ff233b`, code hash
`7GEti5E6NWcjq8kHj5Gweed5HwggY1cxPD7cfbB65h8N`) on `gnanam1990-dock-escrow2.testnet` and ran one trade to PAID there
(docs/status/M34.md). **Use `gnanam1990-dock-escrow2.testnet` for every new trade.** The first escrow,
`gnanam1990-dock-escrow.testnet`, runs the superseded pre-audit contract `5wqct3Wxavf9GXpdYJfrGWKpTZb1j95dJZQsNmAvzHuM`
(M24) without the m25–m33 security fixes; do not use it for new trades. The steps
that remain need things this build was not allowed to create or hold. Every step here is for **you** to run;
nothing in the repository runs them for you.

What remains yours, in short:

| Yours | Why it cannot be done here | Section |
|---|---|---|
| Push the repository and check the first CI run | nothing was pushed; the workflow has only been replayed locally | §1 |
| ~~Create four NEAR testnet accounts and run `scripts/testnet-deploy/run-all --network testnet`~~ | **done** (M24; hardened contract on escrow2 in M34) | §2–§3 |
| Custody of the relayer key and the worker's `TxSigner` | a signing key with real custody (keychain, HSM, KMS or an isolated signer) is yours | §4 |
| Custody of the audit-export key (HSM or KMS if you need it) | the build uses an isolated signer process | §5 |
| Separate people on separate devices for the buyer, supplier, inspector and risk/policy roles | INV-13: one operator holding every key does not count | §6–§7 |
| A manual accessibility review | automated axe checks cannot replace it | §8 |
| 1Click (optional) | needs a partner registration and a credential | §9 |

`WORKING_TESTNET` can be claimed only when every REAL-PRODUCT-GATE item (the matrix in
[BUILD-STATUS.md](../BUILD-STATUS.md)) has been produced by **one exact build**, and you have recorded that
evidence. A recording or screenshot does not replace any step.

Never commit or paste keys, seed phrases, JWTs or API credentials into the repository, an issue, a CI setting or a
`DOCKSIDE_*` variable.

## 0. Prerequisites

- Windows, macOS or Linux with Node 22 (`>=22.13 <23`), pnpm 10, Rust stable with `wasm32-unknown-unknown`, git.
- A Docker Engine (on Windows, inside WSL 2) for the deployable wasm and the local nearcore suites.
- [near-cli-rs](https://github.com/near/near-cli-rs) 0.31 for account creation; `run-all` drives it for the rest.
- A NEAR testnet wallet you control for each funding account.
- Four people with their own devices and browsers for the buyer approver, supplier signer, inspector and risk/policy
  resolver (INV-13), plus each organisation's security administrator.

## 1. Freeze, reproduce and check CI for the build you will deploy

```sh
git clone <your copy of this repository> dockside && cd dockside
git checkout <the commit you intend to deploy>
pnpm install --frozen-lockfile
node scripts/clean-checkout.mjs --e2e --report clean-checkout.json   # your own machine
pnpm run contract:reproduce --e2e        # Linux container; on Windows set
                                         # DOCKSIDE_DOCKER="wsl.exe -d <distro> -u root -- docker"
pnpm run contract:sandbox                # optional: the contract on a local nearcore node
```

`clean-checkout.json` and `.data/repro/clean-checkout-report.json` must both say `"result": "PASS"`. Keep
`.data/repro/build-manifest.json` and deploy `.data/repro/dockside_escrow.wasm`, the wasm the container built (it is
copied only when its SHA-256 equals the manifest's). Do not deploy a wasm built on your own machine: it embeds that
machine's cargo-home path and its digest differs from every other machine's (ADR-0015). Every later step uses this
one commit and this one wasm. The digest and NEAR code hash of the build recorded in this repository are in
[docs/status/M18.md](status/M18.md).

CI (`.github/workflows/ci.yml`, ADR-0020) runs the same on GitHub's `ubuntu-24.04` and `windows-2022` runners with
read-only permissions and no secrets. It has never run, because nothing was pushed. When you push:

1. Confirm the three pinned action SHAs once, for example
   `git ls-remote https://github.com/actions/checkout refs/tags/v4.2.2` must print
   `11bd71901bbe5b1630ceea73d27597364c9af683` (likewise `actions/setup-node` v4.1.0 and
   `actions/upload-artifact` v4.4.3, ADR-0020 §3).
2. Check that both `test` legs and the `chain` job pass. The `chain` job's artifact `dockside-linux-reproduction`
   holds the reports, the build manifest and the deployable wasm; you can deploy that wasm instead of a local
   container build, as long as its SHA-256 equals the manifest's.
3. To replay CI on your machine: `pnpm run ci:local --list`, then `pnpm run ci:local --job test` (or
   `--job chain` with Docker).

## 2. Create the testnet accounts — done

Done (M24): `gnanam1990-dock-escrow`, `-buyer`, `-supplier` and `-relayer` `.testnet`, 10 NEAR each; for the
hardened contract (M34) a fresh escrow account `gnanam1990-dock-escrow2.testnet` (10 NEAR). Kept below for
reference; the extra accounts for §7 are still yours to create if you have not.

Create these with near-cli-rs (faucet-sponsored creation works on testnet), with names you own, and keep their
full-access keys in the near-cli-rs keychain:

```sh
near account create-account sponsor-by-faucet-service <name>.testnet autogenerate-new-keypair save-to-keychain network-config testnet create
```

| Account | Variable | Needs |
|---|---|---|
| `<escrow>.testnet` | `DOCKSIDE_ESCROW_ACCOUNT` | holds the contract: 1 NEAR per 100 kB of wasm plus 1 NEAR (about 9 NEAR for the 0.8 MB build; the preflight computes it); fund it with 12 |
| `<buyer>.testnet` | `DOCKSIDE_BUYER_ACCOUNT` | buyer party and the recorded funder: the trade amount plus 0.1 NEAR |
| `<supplier>.testnet` | `DOCKSIDE_SUPPLIER_ACCOUNT` | supplier party and the bound payout destination; signs nothing |
| `<relayer>.testnet` | `DOCKSIDE_RELAYER_ACCOUNT` | submits relayed calls: 2 NEAR |

For the full product run (§7) also create `<supplier-alt>.testnet` (destination change), optionally
`<treasury>.testnet` (a second funder) and `<sender>.testnet` holding a testnet NEP-141 token (unexpected-asset
recovery).

## 3. Deploy, verify and run one trade: one command — done

**Done for the hardened contract (M34)**, one run on 2026-11-13 from Windows, record `testnet-20261113T022714Z`:
`run-all --network testnet` deployed and initialised commit `4ff233b`'s wasm (SHA-256 `5d0d8a77…a3fb`) on the fresh
account `gnanam1990-dock-escrow2.testnet` in one transaction (`7TZqFwwKH9NKohDRS5RBfudep8hmwxeJoiNE18WdakkA`, code hash
`7GEti5E6NWcjq8kHj5Gweed5HwggY1cxPD7cfbB65h8N`, equal to the manifest's), added the relayer key
`ed25519:4X66DAChHBbMuG7rvTzFx5NcBMQuT8gkZp4UUPr8QaZf` restricted to escrow2, and took trade
`trd_197c633d724eeb2cddc64d6dabf55976` to PAID with the supplier receiving exactly 0.05 NEAR (`execute_release`
`9Wpr243gsWkQuKFbtmBrKMiGkXCPXp3MDfN8M1qrkcEn`). Re-verified read-only on chain; evidence: docs/evidence/M34/. A
further journey against this deployment: `run-all --network testnet --skip-deploy --relayer-key-file <that run's
relayer key file>` with `DOCKSIDE_ESCROW_ACCOUNT=gnanam1990-dock-escrow2.testnet`.

**Superseded (M24)**, three runs on 2026-11-12 from Windows against `gnanam1990-dock-escrow.testnet`, which now runs
the superseded pre-audit contract and must not be used for new trades: run 1 deployed and initialised the escrow in one transaction
(`7KExSVdWHAVXXDjjAme1m1zQBW4hBSgXgsMEQt2K9dyY`, code hash `5wqct3Wxavf9GXpdYJfrGWKpTZb1j95dJZQsNmAvzHuM`, equal to
commit `49fbaf7`'s manifest) and added the relayer key `ed25519:J9RvmdzWNiXQZeyJPmhobxH56MwzzyekCdngQg43aidN`; run 3
(`--skip-deploy --relayer-key-file`) took trade `trd_563c174f39144ac1543b9e3e61eb4d21` to PAID with the supplier
receiving exactly 0.05 NEAR. Evidence: docs/evidence/M24/. The Windows problems those runs hit (an invisible key-scheme
question, npm's `near` shim, a transient "Transaction has expired") are fixed in M24; on Windows use
`powershell -ExecutionPolicy Bypass -File .\scripts\testnet-deploy\run-all.ps1 --network testnet`
(scripts/testnet-deploy/README.md, "Windows"). Still to do from this section: write the escrow account
`gnanam1990-dock-escrow2.testnet` and on-chain code hash `7GEti5E6NWcjq8kHj5Gweed5HwggY1cxPD7cfbB65h8N` into the
manifest's `deployment` section. Optionally delete the old relayer function-call key
`ed25519:J9RvmdzWNiXQZeyJPmhobxH56MwzzyekCdngQg43aidN`, which can only call the superseded escrow.

**Stranded trade.** Run 2 stopped at `approve_release` (expired transaction, never included) and left trade
`trd_9aced7e741a0462ac88ef4de0e67ba81` funded with 0.05 testnet NEAR from `gnanam1990-dock-buyer.testnet`, all of it
reserved by release intent `rli_7781d4f0bb0b6aa6461935a154614c02` (`VALUE_LOCKED`, no approval). **It cannot be
refunded in §7.8**: every way out (approval, dual-signed CANCEL, ABANDON after expiry, and every refund row, which also
needs the intent's reservation released first) needs a Dockside principal signature, and that trade's principal keys
came from a random seed run-all does not keep. Its 0.05 testnet NEAR stays locked in the superseded escrow
`gnanam1990-dock-escrow.testnet` (re-checked in M34: still reserved, conservation `true`); it has no value and the
contract's conservation holds. Run the §7.8 refunds on new trades whose principals are enrolled with kept keys.

```sh
export DOCKSIDE_ESCROW_ACCOUNT=<escrow>.testnet DOCKSIDE_BUYER_ACCOUNT=<buyer>.testnet \
       DOCKSIDE_SUPPLIER_ACCOUNT=<supplier>.testnet DOCKSIDE_RELAYER_ACCOUNT=<relayer>.testnet
scripts/testnet-deploy/run-all --network testnet
# PowerShell: .\scripts\testnet-deploy\run-all.ps1 --network testnet
```

`run-all` (ADR-0019, [scripts/testnet-deploy/README.md](../scripts/testnet-deploy/README.md)) checks the wasm against
the manifest, checks the four accounts and their balances, deploys and initialises the contract in one transaction,
checks the on-chain code hash and config, adds a relayer function-call key restricted to the escrow and checks it on
chain, runs one trade to PAID with the supplier's balance delta and a ledger replay after every transaction, and
writes `run-record.json`. `--network` has no default and mainnet is refused. It prints `run-all: PASS` and exits 0;
any refusal exits 2 with a code (for example `WASM_MISMATCH`, `ESCROW_NOT_EMPTY`, `CODE_HASH_MISMATCH`) before the
step that would be wrong. It was validated end to end on a local near-sandbox node and has run on testnet (above).

Keep the commit, `build-manifest.json`, `run-record.json`, `journey.json` and `deployment.json`. Write the escrow
account and on-chain code hash into the manifest's `deployment` section. A second journey against the same
deployment: `run-all --network testnet --skip-deploy --relayer-key-file <the key file from the first run>`.

The run-all journey is a technical check of the deployed contract. It is not the product flow by separate people
(§6–§7) and does not use the API or the web app.

## 4. Provision the relayer signer (code plus custody, both yours)

**Code done (M43).** The production `KeyFileTxSigner`, the worker runtime, the party relay and the chain preflight
are implemented ([ADR-0025](adr/0025-relayer-signer-custody-and-testnet-runtime.md)). What remains yours is custody
and running it: follow [runbooks/testnet-product.md](runbooks/testnet-product.md), which also replaces §5's
commands. The original steps are kept below for reference.

The worker (`services/worker`) exits with code 78 and `RELAYER_SIGNER_NOT_PROVISIONED` until it has a signer:

1. Pin an official NEAR transaction library (for example a specific `near-api-js` version) and review it.
2. Implement the `TxSigner` interface from `@dockside/near` (`packages/near/src/tx.ts`):
   `sign(call, { nonce, blockHash })` builds the NEAR transaction for that function call, signs it with the
   relayer's function-call key and returns the serialized signed transaction and its hash (`SignedTx`).
3. Keep that key in an OS keychain, HSM, KMS or an isolated signer process, never in the repository, the database or
   a `DOCKSIDE_*` variable. Load it only in the worker process. The function-call key `run-all` created is a
   near-cli-rs key file; move it into your custody or create a new one.
4. Change `services/worker/src/main.ts` to build `WorkerLoop` with that signer, `JsonRpcNearClient` pointed at
   `https://test.rpc.fastnear.com` and `txValidityBlocks: 86400`.
5. Add a test that the worker still refuses to start when the signer is absent.

One relayer key serves the outbox and asset-recovery engines through the `withRelayerKey` lease (M15); more
throughput needs more keys. Party calls come back from the API as `{relay: {receiverId, methodName, args, gas,
deposit}}`; submit each `args` JSON from the relayer (the commands are in the runbook's "Manual calls") or build a
relay endpoint around your `TxSigner`. The local stack's `/relay` works only against the simulated chain. Funding is
the one call the funder signs and sends from its own account.

## 5. Run the API and web app against testnet

Run on a machine you control, behind HTTPS for anything other than loopback:

```sh
pnpm run build
pnpm run export-key generate --out <private dir>/audit-export.seed   # dedicated audit-export key (M17)
DOCKSIDE_DB_PATH=<private dir>/dockside.sqlite \
DOCKSIDE_OBJECT_STORE_DIR=<private dir>/objects \
DOCKSIDE_AUDIT_EXPORT_KEY_FILE=<private dir>/audit-export.seed \
DOCKSIDE_ORIGIN=https://<your web origin> \
DOCKSIDE_ESCROW_CONTRACT_ID=<escrow>.testnet \
DOCKSIDE_NEAR_RPC_URL=https://test.rpc.fastnear.com \
DOCKSIDE_RATE_LIMIT_UNAUTH_PER_MIN=60 \
pnpm run api
```

Serve `apps/web` (`pnpm run web:build`) from the same origin, proxying `/v1`, `/healthz` and `/readyz` to the API
(apps/web/README.md). Check `/readyz` reports `network: near-testnet` and `fundedPayouts: BLOCKED`. The export key
file is read only by an isolated signer child process; for HSM or KMS custody implement the same `ExportKeySigner`
seam (ADR-0018).

The ManifestAttestor and deterministic-policy services must run as their own processes with their own keys, ideally
on another host. `packages/authority/signer/isolated-signer.mjs` is the local reference; for testnet, enrol them
through `POST /v1/service-enrollments` and keep their keys out of the API process.

## 6. Enrol independent principals

Each person uses their own device and browser:

1. Each organisation's security administrator bootstraps the organisation in the web app (key proof of possession).
2. The buyer administrator invites the buyer approver, inspector and risk/policy resolver; the supplier administrator
   invites the supplier signer. Each invitee accepts in their own browser, proving their own key, and the
   administrator grants the role afterwards.
3. The buyer administrator enrols the ManifestAttestor and deterministic-policy services under **Organization →
   Service identities** and sets the evidence policy, retention and integrations under **Organization → Policies,
   Retention, Integrations**.
4. Each person who signs as a NEAR account links it under **Organization → NEAR accounts** with a wallet that
   announces itself on the page (NEP-413 signature, then `view_access_key` must report a full-access key). No
   wallet product is bundled: connect one that implements the `near-wallet:announce` discovery (ADR-0018 §9). A
   link grants no capability.

Keys are managed under **Organization → Keys**; a person who lost a key generates a recovery key under `/recovery`
on the new device, and an expired recovery challenge can be re-issued there. A trade bound to a rotated, revoked or
recovered key is rebound with the dual-signed key-rebinding revision on its Agreement tab (M14). A revision that
replaces a participant or service is not built: if a role lost its capability or its enrollment was revoked, start a
new trade.

Reviewer kit for §6–§7 with separate people: [review-kits/inv13-acceptance.md](review-kits/inv13-acceptance.md).

## 7. Run the trade on testnet and keep the evidence

Use the web app throughout and submit every relay from §4. Keep each transaction hash and receipt. Run every
trade against the current escrow `gnanam1990-dock-escrow2.testnet` (hardened contract, M34), never the superseded
`gnanam1990-dock-escrow.testnet`; in §5 `<escrow>` is `gnanam1990-dock-escrow2`.

1. The buyer creates the trade proposal, the supplier countersigns, then `register_trade` and
   `register_evidence_policy`.
2. `<buyer>.testnet` funds the exact amount with `fund`. Optionally fund an excess from `<treasury>.testnet` and run
   the EXCESS_FUNDING_RETURN refund back to it.
3. The supplier and inspector upload every slot. The ManifestAttestor attests and the inspector signs PASS.
4. The deterministic-policy service SETs a hold. A deterministic-policy resolution must be refused. The buyer files a
   review request (no effect), and the risk/policy resolver RESOLVEs. Show that release is refused while the hold is
   ACTIVE and after it expires unresolved.
5. The buyer locks the release intent and approves it. Exercise a dual-signed CANCEL on one intent, and an ABANDON
   after expiry plus grace on another, before the final one.
6. Destination change on the Agreement tab: a forged and a unilateral change must be refused. A dual-consent change
   to `<supplier-alt>.testnet` waits out the delay (`DOCKSIDE_DESTINATION_CHANGE_DELAY_MS`, default one day), is
   activated and bound, and the old approval, manifest and inspection stop counting. Renew them before releasing.
7. The buyer executes. The worker submits once and the reconciler reaches PAID only with the final receipt to the
   bound destination. Stop the worker mid-flight once and restart it: there must be no second submission.
8. Refunds on the Refund tab, on further testnet trades: the treasury's excess return submitted from
   `<treasury>.testnet` itself with the exact call the page shows; a revocation that restores QUARANTINED exactly; a
   mutual cancellation to REFUNDED at the original funder; and at least once each `TRADE_EXPIRY`, `INSPECTION_FAIL`
   and `PERMANENT_HOLD`, which ran locally in the API and the browser (M15) but never on a real network. These wait
   on the contract clock (24 to 48 hours).
9. Optional, unexpected assets: `<sender>.testnet` sends a small NEP-141 amount to the escrow with
   `ft_transfer_call`. It appears only in the "Asset recovery review" panel. The sender requests from its own
   account, the risk/policy resolver approves, the 72-hour window passes, and execution (a full-access key attaching
   one yoctoNEAR) returns the exact amount to the sender.
10. On the Timeline tab prepare the signed audit export, download it and verify it offline:
    `pnpm run verify-export <bundle.json> --trusted-keys <keys.json>` must exit 0, where `<keys.json>` is the
    published key list (`GET /v1/audit-export-keys` or `pnpm run export-key list`) obtained out of band.
11. Record: commit, manifest, deploy/init/register/fund/release/refund transaction hashes, receipts, `get_ledger`
    with `conservation: true`, the supplier and funder balance deltas, the signed audit export and its verification.

## 8. Accessibility evidence

- T-039: a manual keyboard-only and screen-reader pass (for example NVDA with Firefox, VoiceOver with Safari) through
  the critical flow. Record the problems you find and fix them.
- T-040: true browser zoom at 200%, landscape on a phone, and long translated strings.
- Reviewer kit: [review-kits/accessibility-review.md](review-kits/accessibility-review.md).

## 9. Optional: 1Click dry compatibility (M06)

Not needed for `WORKING_TESTNET`. Register as a 1Click partner, keep the credential in a secret manager, pin the
official client and implement `OneClickAdapter` (`packages/payout`) against the **dry** quote endpoint only. Then
run T-024 and T-048 with redacted evidence. Only `PASS` supports `DRY_COMPATIBLE`.

## 10. Funded mainnet: separately authorized only

`DOCKSIDE_NETWORK=near-mainnet` and any `DOCKSIDE_FUNDED_PAYOUTS` value other than `BLOCKED` are refused at startup,
and the contract's `new` accepts only `near-testnet`. A funded corridor first needs a contract entry point that
consumes a FundedPayoutAuthorization atomically, a verified corridor, an exposure cap and your explicit authorization
of network, wallet, amount, signer and executor (REAL-PRODUCT-GATE "Separate funded-mainnet gate").

## Independent security review

Reviewer kit: [review-kits/security-review.md](review-kits/security-review.md) (index of all kits: [review-kits/README.md](review-kits/README.md)).

## When you are done

Update BUILD-STATUS.md item by item with the evidence from §1–§8. Promote the claim to `WORKING_TESTNET` only if
every required item is `PASS` for the same commit and wasm.
