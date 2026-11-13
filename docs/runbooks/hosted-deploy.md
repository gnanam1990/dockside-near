# Runbook: the hosted Dockside app on Render or Fly.io (NEAR testnet)

Puts the real product — control API, worker and web app — behind one HTTPS address, so that people on their own
devices can take part in a trade on the deployed escrow `gnanam1990-dock-escrow2.testnet`. It is the testnet
runtime profile of [testnet-product.md](testnet-product.md) in one container
([ADR-0027](../adr/0027-hosted-runtime-container.md), [M55 status](../status/M55.md)). Mainnet is refused at
every layer. Everything here is done by the owner, with the owner's accounts and keys.

| In the container | Where it lives | Who can read it |
|---|---|---|
| Image: compiled product, web build, escrow manifest | built from `Dockerfile` | public (no key inside) |
| Relayer **function-call** key (escrow2 only, 1 NEAR allowance) | the host's secret store; an owner-only copy in `/run/dockside` while the container runs | the worker process |
| Service key seeds (audit export, ManifestAttestor, deterministic policy) | the volume, `/data/keys`, created on first start | the isolated signer processes |
| Database, evidence objects | the volume, `/data` | API and worker |
| Each person's device key | that person's browser, non-extractable | nobody else |

The container refuses to start (exit 78, with a reason code in the log) unless the RPC is NEAR testnet, the
escrow's on-chain code hash equals the manifest in the image, and the relayer key is a function-call key
restricted to the escrow. All commands are PowerShell, from the repository root.

## The ten steps

**1. Prove the image on your machine (about five minutes, no testnet).** Needs Docker (Docker Engine in WSL is
fine) and `.data\repro` from `pnpm run contract:reproduce`.

```powershell
pnpm install --frozen-lockfile; pnpm run build; pnpm run hosted:verify
```

It builds the image, runs it against a local nearcore sandbox and must end with every check `PASS`.

**2. Choose the host.** Render (steps marked R) or Fly.io (steps marked F). Both need a plan with a persistent
disk; the product keeps its SQLite database there and runs as exactly one instance.

**3. Give the host the code.** R: the repository must be on GitHub and connected to your Render account
(private is fine). F: install `flyctl`, then:

```powershell
fly auth login
```

**4. Put the relayer key file on the clipboard as base64.** Use the relayer's *function-call* key file from
step 0 of [testnet-product.md](testnet-product.md) — never the full-access key (the container would refuse it).

```powershell
$K = "<full path of the relayer function-call key file>"; [Convert]::ToBase64String([IO.File]::ReadAllBytes($K)) | Set-Clipboard
```

**5. Create the deployment.**

- R: Render dashboard → **New → Blueprint** → pick the repository → Render reads `render.yaml` and asks for
  `RELAYER_KEY_JSON_B64` → paste → **Apply**. (Alternative: leave it empty and add the key file itself under
  *Environment → Secret Files* with the file name `relayer-key.json`.)
- F: the app name in `fly.toml` must be free on Fly; change `app = "dockside-demo"` if it is taken. Then:

```powershell
fly apps create dockside-demo; fly volumes create dockside_data --app dockside-demo --region fra --size 1 --yes; fly secrets set "RELAYER_KEY_JSON_B64=$(Get-Clipboard)" --app dockside-demo --stage; fly deploy --ha=false
```

Afterwards clear the clipboard: `Set-Clipboard -Value " "`.

**6. Read the first start in the log** (R: *Logs* tab; F: `fly logs --app dockside-demo`). Expect, in this
order: three `hosted.key_created` lines (public keys only), the API's `"event":"listening"` with
`"chain":{"chainId":"testnet","escrow":"gnanam1990-dock-escrow2.testnet","codeHash":"7GEti5E6…"}`, the worker's
`"event":"worker.started"` with the relayer public key, then `"event":"hosted.started"` with the public origin.
If the container exits instead, the last lines say why:

| Log line | Meaning | Fix |
|---|---|---|
| `worker.blocked` … `RELAYER_SIGNER_NOT_PROVISIONED` | the secret did not arrive | repeat step 5's secret |
| `hosted.refused` … `RELAYER_SECRET_NOT_BASE64` | the secret is not the base64 of the key file | repeat step 4 |
| `worker.refused` … `FULL_ACCESS_KEY` / `WRONG_RECEIVER` / `KEY_NOT_ON_CHAIN` | not the function-call key of the relayer for escrow2 | use the right key file |
| `api failed to start` … `CODE_HASH_MISMATCH` / `CHAIN_ID_MISMATCH` | wrong escrow, manifest or RPC | check the three `DOCKSIDE_*` values |
| `hosted.refused` … `CONFIG_INVALID` with a `name` | that variable is missing, unknown or owned by the launcher | fix or remove it |

**7. Check it from outside.** With your address (R: `https://<service>.onrender.com`, F: `https://<app>.fly.dev`):

```powershell
$U = "https://<your address>"; Invoke-RestMethod "$U/healthz"; Invoke-RestMethod "$U/readyz"; Invoke-RestMethod "$U/relay/v1/status"
```

`/readyz` must say `network near-testnet` and `fundedPayouts BLOCKED`; the relay status names the relayer and
escrow2. Open the address in a browser: the sign-in screen appears. `<address>/receipt/trd_197c633d724eeb2cddc64d6dabf55976`
shows the payment receipt of the M34 testnet trade, verified by the browser against NEAR (M54), and
`<address>/proof/` the proof page.

**8. Enrol the demo organisations.** One command, run inside the running container (R: the service's *Shell*
tab, paste the part in quotes; F: as below). It bootstraps a buyer, a supplier and an inspection organisation,
registers the `commercial-docs` evidence policy, enrols and activates the two service identities, and prints
four invitation secrets — only this once.

```powershell
fly ssh console --app dockside-demo -C "/app/deploy/entrypoint.sh seed-demo enroll"
```

Everything goes through the real API with signed requests; nothing is written to the database directly. The
three administrator keys it creates stay on the volume (`/data/demo-seed`) and can only administer those
organisations.

**9. Let people in.** Send each person one secret privately: buyer approver, risk resolver, supplier signer,
inspector. Each opens `<your address>/sign-in`, accepts the invitation and signs with their own device key.
Then grant the roles and look at the result:

```powershell
fly ssh console --app dockside-demo -C "/app/deploy/entrypoint.sh seed-demo grant"; fly ssh console --app dockside-demo -C "/app/deploy/entrypoint.sh seed-demo status"
```

`PENDING` means that person has not accepted yet; run `grant` again later. An invitation lasts three days;
`seed-demo enroll --reissue` issues new ones for roles nobody holds.

**10. Run a trade and keep the evidence.** From here the people follow steps 4 to 8 of
[testnet-product.md](testnet-product.md) in their browsers (the buyer still funds from the buyer's own wallet;
the relay refuses deposits), and section 3 there says where every transaction hash appears. The worker's log
lines (`attestor.submitted`, `relay.submitted`) are in the host's log view.

## Operating it

- **Restart or redeploy:** safe at any time. The volume keeps the database, objects and service keys; the
  journal reconciles an in-flight transaction by its original hash and never sends it twice.
- **Back up:** a snapshot of the volume (R: disk snapshots; F: `fly volumes snapshots create <volume id>`). It
  contains the service key seeds, so treat it like a key.
- **Rotate the relayer key:** add a new function-call key to the relayer account (runbook step 0), repeat
  steps 4 and 5's secret, and delete the old access key on chain.
- **Rate limit:** all visitors share one budget for unauthenticated calls (300 a minute); raise
  `DOCKSIDE_RATE_LIMIT_UNAUTH_PER_MIN` on the host if a workshop needs more.
- **Another escrow deployment:** replace `deploy/escrow-manifest.json` with that deployment's artifact record
  (the `artifact.json` of its run), set `DOCKSIDE_ESCROW_CONTRACT_ID` on the host and redeploy. The container
  refuses to start if the two do not match on chain.
- **Take it down:** R: delete the service and its disk. F: `fly apps destroy dockside-demo`. Then remove the
  relayer's function-call key on chain if it will not be used again.

## Plain `docker run` (any Linux host with your own HTTPS proxy)

```powershell
docker build -t dockside-hosted .; docker run -d --name dockside -p 127.0.0.1:8080:8080 -v dockside-data:/data -v "<relayer key file>:/etc/secrets/relayer-key.json:ro" -e DOCKSIDE_ORIGIN=https://<your host name> -e DOCKSIDE_ESCROW_CONTRACT_ID=gnanam1990-dock-escrow2.testnet -e DOCKSIDE_NEAR_RPC_URL=https://test.rpc.fastnear.com -e DOCKSIDE_RELAYER_ACCOUNT_ID=gnanam1990-dock-relayer.testnet dockside-hosted
```
