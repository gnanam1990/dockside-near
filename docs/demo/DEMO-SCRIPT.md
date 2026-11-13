# Demo video script (2–3 minutes)

The video shows one complete moment. A buyer's deposit goes into the Dockside escrow on NEAR testnet and comes out to
the supplier's agreed account, for exactly the trade amount, once the evidence, inspection and approval are on
chain. The viewer watches it start from one command and ends on the supplier's incoming transfer in the block
explorer.

Record a terminal and a browser side by side or in turns. No slides and no architecture diagrams. Show setup only
where it is part of the moment.

## Before recording (not on camera)

- Use the current escrow `gnanam1990-dock-escrow2.testnet`, never the superseded `gnanam1990-dock-escrow.testnet`.
- Check that the buyer `gnanam1990-dock-buyer.testnet` holds at least 0.15 testnet NEAR and the relayer
  `gnanam1990-dock-relayer.testnet` has gas. The relayer function-call key file from the M34 run must still be in the
  near-cli-rs credentials folder.
- Have `.data/repro/dockside_escrow.wasm` and `.data/repro/build-manifest.json` from `pnpm run contract:reproduce`
  on the deployed contract's commit. run-all checks that the wasm hash equals the code on chain.
- Set the four account variables in the recording shell: `DOCKSIDE_ESCROW_ACCOUNT=gnanam1990-dock-escrow2.testnet`,
  `DOCKSIDE_BUYER_ACCOUNT=gnanam1990-dock-buyer.testnet`, `DOCKSIDE_SUPPLIER_ACCOUNT=gnanam1990-dock-supplier.testnet`,
  `DOCKSIDE_RELAYER_ACCOUNT=gnanam1990-dock-relayer.testnet`.
- Make the terminal font large, hide the prompt's path, and make sure no key file content or seed phrase can appear
  on screen. run-all never prints a private key, but do not `cat` anything under the credentials folder.
- Open https://testnet.nearblocks.io/address/gnanam1990-dock-supplier.testnet in a browser tab and note the balance.

Fallback if a live run is not possible: record scenes 3–4 on the existing paid trade, `execute_release`
https://testnet.nearblocks.io/txns/9Wpr243gsWkQuKFbtmBrKMiGkXCPXp3MDfN8M1qrkcEn and trade
`trd_197c633d724eeb2cddc64d6dabf55976`. Say that it is the trade recorded on 2026-11-13.

## Scenes

| # | Time | On screen | Say (roughly) |
|---|---|---|---|
| 1 | 0:00–0:15 | The supplier's account page on nearblocks, balance visible | "Trade payments are commonly lost in three ways: a last-minute change of payout details, money released before the goods are inspected, and refunds sent to the wrong party. Dockside is an escrow on NEAR that pays only the account both sides signed, and only when the agreed conditions hold." |
| 2 | 0:15–1:15 | Terminal. Run `scripts/testnet-deploy/run-all --network testnet --skip-deploy --relayer-key-file <relayer key file>`. On Windows: `powershell -ExecutionPolicy Bypass -File .\scripts\testnet-deploy\run-all.ps1 --network testnet --skip-deploy --relayer-key-file <file>`. Let the step lines scroll: `1/7 verify the wasm`, `4/7 verify the on-chain code hash`, `6/7 journey`. Cut dead time while transactions finalise | "This registers a new trade on the deployed contract and funds it with 0.05 NEAR from the buyer's own account. Then it submits the signed evidence attestation, the inspector's PASS and the buyer's approval. Each of those is an Ed25519 signature the contract verifies against the keys in the agreement. The relayer only carries them. It holds a function-call key that can call this one contract, and it cannot sign for a party." |
| 3 | 1:15–1:45 | The last line `run-all: PASS: deployed code hash …, journey PAID`. Open the new run's `journey.json` and show the `execute_release` step's `txHash`. Paste it into `https://testnet.nearblocks.io/txns/<hash>` | "PASS. Here is the release transaction on testnet: the contract sent exactly 0.05 NEAR to the supplier's bound account. The destination comes from the signed agreement, not from whoever called the contract." |
| 4 | 1:45–2:15 | Refresh the supplier's nearblocks page: the new incoming 0.05 NEAR from `gnanam1990-dock-escrow2.testnet`. Then the read-only `get_ledger` call from the README for the new trade id, highlighting `"released"` and `"conservation":true` | "The supplier received exactly the trade amount. The contract's own ledger shows the deposit fully released from the one funder, nothing left over, and conservation true." |
| 5 | 2:15–2:40 | The README's "Honest status" table | "What you saw is the contract on testnet. The web app, API and worker run the same rules locally on a simulated chain: holds, cancel and abandon, two-party payout changes and refunds to the original funder. Those have not run on testnet yet. The repository has the full status and a 10-minute path to try it. Built at NEAR HACKATHON." |

Optional, only if time remains (keep it under 20 seconds and label it on screen as **local, simulated chain**): the
Playwright run `pnpm --filter @dockside/web exec playwright test e2e/product.spec.ts` ending in `6 passed`.

## What must NOT be claimed

- Not "live on mainnet", "production-ready", "audited and certified" or "secure". Say instead: deployed on NEAR
  **testnet**, claim level `IMPLEMENTED_UNVERIFIED`, two external audits with every confirmed finding fixed.
- Not that separate people on separate devices ran the trade. The run-all journey signs every Dockside payload with
  keys from one operator's run (INV-13 acceptance is not done).
- Not that the web app, API or worker ran against testnet. They run locally on a simulated chain.
- Not that holds, CANCEL/ABANDON, destination changes, refunds or asset recovery ran on testnet. They ran locally
  and on a local nearcore node only.
- Not that the evidence was uploaded and attested through the product. On testnet the attestation and inspection
  came from fixture keys in the journey.
- Not NEAR Intents, 1Click, Chain Signatures or cross-chain settlement. None is used (1Click is `NOT_RUN`).
- Not real money or a real customer. It is testnet NEAR, and the accounts belong to the repository owner.
- Do not show or mention `gnanam1990-dock-escrow.testnet` as current. It runs the superseded pre-audit contract.
