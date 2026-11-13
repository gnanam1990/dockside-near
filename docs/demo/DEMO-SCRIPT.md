# Demo video script (2–3 minutes)

The video shows one complete moment. A buyer's 5 USDC go into the Dockside escrow on NEAR testnet and come out to
the supplier's agreed account, for exactly the trade amount, once the evidence, inspection and approval are on
chain. The viewer watches it start from one command and ends on the supplier's incoming USDC transfer in the block
explorer.

The main path uses the USDC escrow `gnanam1990-dock-escrow3.testnet` (M56), the strongest evidence in the README.
The native-NEAR escrow `gnanam1990-dock-escrow2.testnet` (M34) is the alternative at the end.

Record a terminal and a browser side by side or in turns. No slides and no architecture diagrams. Show setup only
where it is part of the moment.

## Before recording (not on camera)

- Use `gnanam1990-dock-escrow3.testnet` (USDC). Never use the superseded `gnanam1990-dock-escrow.testnet`.
- Check that the buyer `gnanam1990-dock-buyer.testnet` holds at least 5 testnet USDC (token
  `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af`; after M56 it holds exactly 5) and some testnet
  NEAR for gas, and that the relayer `gnanam1990-dock-relayer.testnet` has gas. The relayer function-call key file
  for escrow3 from the M56 run must still be in the near-cli-rs credentials folder.
- Have `.data/repro/dockside_escrow.wasm` and `.data/repro/build-manifest.json` from `pnpm run contract:reproduce`
  on the deployed contract's commit (the M50 build). run-all checks that the wasm hash equals the code on chain.
- Set the four account variables in the recording shell: `DOCKSIDE_ESCROW_ACCOUNT=gnanam1990-dock-escrow3.testnet`,
  `DOCKSIDE_BUYER_ACCOUNT=gnanam1990-dock-buyer.testnet`, `DOCKSIDE_SUPPLIER_ACCOUNT=gnanam1990-dock-supplier.testnet`,
  `DOCKSIDE_RELAYER_ACCOUNT=gnanam1990-dock-relayer.testnet`.
- Make the terminal font large, hide the prompt's path, and make sure no key file content or seed phrase can appear
  on screen. run-all never prints a private key, but do not `cat` anything under the credentials folder.
- Open https://testnet.nearblocks.io/address/gnanam1990-dock-supplier.testnet in a browser tab, on its token
  transfers, and note the USDC balance (15 USDC after M56).

Fallback if a live run is not possible: record scenes 3–4 on the existing USDC paid trade
`trd_7b76900e411a5bd8afadcf322bdf1f2f`, `execute_release`
https://testnet.nearblocks.io/txns/ANyGBfVTpUzjTdMdVZcP2RSnSewzYCRHR97A2Z51CX1B (an `ft_transfer` of exactly 5 USDC
to the supplier). Say that it is the trade recorded on 2026-11-13. `pnpm judge --only chain,usdc` re-checks it
read-only on camera in about 15 seconds.

## Scenes

| # | Time | On screen | Say (roughly) |
|---|---|---|---|
| 1 | 0:00–0:15 | The supplier's account page on nearblocks, USDC balance visible | "Trade payments are commonly lost in three ways: a last-minute change of payout details, money released before the goods are inspected, and refunds sent to the wrong party. Dockside is an escrow on NEAR that pays only the account both sides signed, and only when the agreed conditions hold." |
| 2 | 0:15–1:15 | Terminal. Run `scripts/testnet-deploy/run-all --network testnet --asset usdc --token 3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af --skip-deploy --relayer-key-file <escrow3 relayer key file> --journey paid`. On Windows: `powershell -ExecutionPolicy Bypass -File .\scripts\testnet-deploy\run-all.ps1` with the same arguments. Let the step lines scroll. Cut dead time while transactions finalise | "This registers a new trade on the deployed contract. The buyer funds it with 5 USDC from its own account, with `ft_transfer_call` naming the trade and the exact terms it signed. Then the signed evidence attestation, the inspector's PASS and the buyer's approval go on chain. Each of those is an Ed25519 signature the contract verifies against the keys in the agreement. The relayer only carries them: its function-call key works only on this contract and cannot attach money." |
| 3 | 1:15–1:45 | The last line `run-all: PASS …, journey PAID`. Open the new run's `journey.json` and show the `execute_release` step's `txHash`. Paste it into `https://testnet.nearblocks.io/txns/<hash>` and show the `ft_transfer` from escrow3 to the supplier | "PASS. Here is the release transaction on testnet: the escrow called the USDC token's `ft_transfer` for exactly 5 USDC to the supplier's bound account, and a settlement callback confirmed it before the trade was marked paid. The destination comes from the signed agreement, not from whoever called the contract." |
| 4 | 1:45–2:15 | Refresh the supplier's nearblocks page: the new incoming 5 USDC from `gnanam1990-dock-escrow3.testnet`. Then the read-only `get_ledger` call from the README for the new trade id, highlighting `"kind":"NEP141"`, `"released"` and `"conservation":true` | "The supplier received exactly the trade amount. The contract's own ledger shows the deposit fully released from the one funder, nothing left over, and conservation true." |
| 5 | 2:15–2:40 | The README's "Honest status" table | "What you saw is the contract on testnet; the hold, refusal and refund journeys ran there too, driven by scripts. The web app, API and worker run the same rules locally on a simulated chain and have not run against testnet yet. One operator held every key. The repository has the full status and a 10-minute path to try it. Built at NEAR HACKATHON." |

Optional, only if time remains (keep it under 20 seconds and label it on screen as **local, simulated chain**): the
Playwright run `pnpm --filter @dockside/web exec playwright test e2e/product.spec.ts` ending in `7 passed`.

## Alternative: native NEAR on escrow2

Same scenes with `DOCKSIDE_ESCROW_ACCOUNT=gnanam1990-dock-escrow2.testnet`, without `--asset` and `--token`, the M34
relayer key file, and a buyer holding at least 0.15 testnet NEAR. The trade is 0.05 NEAR and the release is a
native transfer. Fallback trade: `trd_197c633d724eeb2cddc64d6dabf55976`, `execute_release`
https://testnet.nearblocks.io/txns/9Wpr243gsWkQuKFbtmBrKMiGkXCPXp3MDfN8M1qrkcEn.

## What must NOT be claimed

- Not "live on mainnet", "production-ready", "audited and certified" or "secure". Say instead: deployed on NEAR
  **testnet**, claim level `IMPLEMENTED_UNVERIFIED`, security audits **run by the team itself** (not third parties)
  with every confirmed finding fixed.
- Not that separate people on separate devices ran the trade. The run-all journey signs every Dockside payload with
  keys from one operator's run (INV-13 acceptance is not done).
- Not that the web app, API or worker ran against testnet. They run locally on a simulated chain.
- Not that destination changes, CANCEL/ABANDON or asset recovery ran on testnet. They ran locally and on a local
  nearcore node only. (Holds, the six refusals and refunds did run on testnet, through run-all.)
- Not that the evidence was uploaded and attested through the product. On testnet the attestation and inspection
  came from fixture keys in the journey.
- Not a real NEAR Intents or 1Click cash-out, Chain Signatures or cross-chain settlement. 1Click ran as dry quotes
  against a local simulator only.
- Not real money or a real customer. It is testnet USDC and NEAR, and the accounts belong to the repository owner.
- Do not show or mention `gnanam1990-dock-escrow.testnet` as current. It runs the superseded pre-audit contract.
