# Runbook: the attack console on NEAR testnet ("Try to steal this payment", M53)

The console is a page with one real funded demo trade and five attack buttons. Design and limits:
[ADR-0029](../adr/0029-attack-console.md). Everything below that sends a transaction is the owner's to run;
the build itself sent none. All commands are PowerShell from the repository root, testnet only.

## What you need

| Thing | Where it comes from |
|---|---|
| The four accounts of the testnet journeys (escrow2, buyer, supplier, relayer) and the relayer's function-call key file | as for `run-all --journey refusal` (scripts/testnet-deploy/README.md) |
| A fifth account, the attacker: `gnanam1990-dock-attacker.testnet` | step 1 |
| The attacker's function-call key for escrow2 (0.5 NEAR allowance) | step 2 |
| The buyer's 0.02 NEAR for the demo trade, plus fees | the buyer account |

## Steps

**1. Create the attacker account** (faucet-funded; its full-access key goes to your keychain):

```powershell
near.cmd account create-account sponsor-by-faucet-service gnanam1990-dock-attacker.testnet autogenerate-new-keypair save-to-keychain network-config testnet create
```

**2. Give it a function-call key for the escrow only.** near-cli-rs saves it as
`%USERPROFILE%\.near-credentials\testnet\gnanam1990-dock-attacker.testnet\ed25519_<key>.json`; that path is
`<attacker key file>` below.

```powershell
near.cmd account add-key gnanam1990-dock-attacker.testnet grant-function-call-access --allowance '0.5 NEAR' --contract-account-id gnanam1990-dock-escrow2.testnet --function-names '' autogenerate-new-keypair --signature-scheme ed25519 save-to-legacy-keychain network-config testnet sign-with-keychain send
```

Optional, so the account itself holds little more than gas: send most of the faucet balance back to the buyer.

```powershell
near.cmd tokens gnanam1990-dock-attacker.testnet send-near gnanam1990-dock-buyer.testnet '9 NEAR' network-config testnet sign-with-keychain send
```

**3. Create the demo trade** (about a minute; 8 transactions; the buyer funds 0.02 NEAR, which stays held).
`<relayer key file>` is the same file as for the other journeys. It ends with
`run-all: PASS: ... attack-demo journey demo trade FUNDED, APPROVED and HELD` and prints the run directory.

```powershell
$env:DOCKSIDE_ESCROW_ACCOUNT="gnanam1990-dock-escrow2.testnet"; $env:DOCKSIDE_BUYER_ACCOUNT="gnanam1990-dock-buyer.testnet"; $env:DOCKSIDE_SUPPLIER_ACCOUNT="gnanam1990-dock-supplier.testnet"; $env:DOCKSIDE_RELAYER_ACCOUNT="gnanam1990-dock-relayer.testnet"; powershell -ExecutionPolicy Bypass -File .\scripts\testnet-deploy\run-all.ps1 --network testnet --rpc-url https://test.rpc.fastnear.com --skip-deploy --relayer-key-file "<relayer key file>" --journey attack-demo --amount-yocto 20000000000000000000000
```

**4. Write the page's demo config** (read-only: checks the key on chain, that the demo is armed, and that the
stored approval bytes are the approval transaction's; records the key's nonce as the counter's baseline).
`<run dir>` is the directory step 3 printed. Leave `--relay` out if there is no hosted deployment yet.

```powershell
pnpm run build; pnpm run attack-console config --journey "<run dir>\journey.json" --attacker gnanam1990-dock-attacker.testnet --key-file "<attacker key file>" --rpc https://test.rpc.fastnear.com --relay https://<hosted host>/proof/attack/api
```

**5. Send the five attacks once and record them** (5 refused transactions, gas only, from the allowance).
These are what the GitHub Pages copy replays when no relay answers.

```powershell
pnpm run attack-console send --config site\proof\attack\attack-demo.json --key-file "<attacker key file>" --rpc https://test.rpc.fastnear.com --attack all --record
```

Each line must read `REFUSED <CODE>` and the command must exit 0. Exit 1 means an attempt was not refused:
stop and keep the output.

**6. Keep the evidence.** Copy `<run dir>\run-record.json` and `<run dir>\journey.json` to
`docs/evidence/M53/testnet/` (not `journey-seed.json`), and commit them with
`site/proof/attack/attack-demo.json`.

**7. Turn the relay on in the hosted app** (optional; without it the page replays). Put the attacker key file
on the clipboard as base64, then add it as the secret `ATTACK_KEY_JSON_B64` (Render: *Environment*; Fly:
the command below). `HOSTED_ATTACK_ALLOWED_ORIGINS` is already in `render.yaml` and `fly.toml`.

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("<attacker key file>")) | Set-Clipboard
```

```powershell
fly secrets set "ATTACK_KEY_JSON_B64=$(Get-Clipboard)" --app dockside-demo
```

After the next deploy the log shows `attack.armed` with the attacker account, and
`https://<hosted host>/proof/attack/api/status` answers `"enabled":true,"armed":true`.

## Checking an attempt yourself

Any attempt can be read back by anyone; the answer must contain `"Failure"` and `DOCKSIDE:<CODE>`:

```powershell
curl.exe -s https://test.rpc.fastnear.com -H "content-type: application/json" -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"EXPERIMENTAL_tx_status\",\"params\":{\"tx_hash\":\"<hash>\",\"sender_account_id\":\"gnanam1990-dock-attacker.testnet\",\"wait_until\":\"FINAL\"}}'
```

## What the codes look like later

The journey signs the approval and the evidence attestation for 24 hours. After that, a replayed approval is
refused as `EXPIRED` and a release lists `MANIFEST_NOT_CURRENT` first, with `HOLD_ACTIVE` still among the
blockers. The other three keep their codes. To show the first-day codes again, run step 3 again (a new trade)
and steps 4 and 5.

## Stopping it

Remove `ATTACK_KEY_JSON_B64` from the host (the relay answers `RELAY_OFF`, the page replays), or delete the
function-call key on chain:

```powershell
near.cmd account delete-keys gnanam1990-dock-attacker.testnet public-keys <ed25519 public key> network-config testnet sign-with-keychain send
```
