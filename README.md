# Dockside

Dockside is a production-shaped trade-payment product: supplier payout details are bound into an escrow
agreement, release needs a signed inspection result and buyer approval, unauthorized redirection is
rejected, and payout evidence is reconciled. The authoritative specification is the sealed pack in
[`docs/spec/`](docs/spec/START-HERE.md) (do not edit it).

**Current truth:** see [`BUILD-STATUS.md`](BUILD-STATUS.md). Modules M00 (foundation/contracts), M01
(organization/authority) and M02 (NEAR escrow contract, per-funder funding and refunds, built and tested
locally) exist. The contract is **not deployed** anywhere (testnet deployment is BLOCKED until you run
`scripts/testnet-deploy/`), there is no release path yet (M04), no UI, and no runtime `WORKING_*` claim.

## Requirements

- Node.js 22 (`>=22.13 <23`; developed on 22.23.1) — `node:sqlite` is used and prints an
  `ExperimentalWarning` on Node 22.
- pnpm 10 (`corepack enable` or a global install; developed on 10.34.9)
- Rust stable with cargo (developed on 1.97.1) and the wasm target for `contract/`:
  `rustup target add wasm32-unknown-unknown`

## Setup

```sh
pnpm install --frozen-lockfile
pnpm run build
```

## Test and check

```sh
pnpm test                 # pretest builds TypeScript and the contract wasm, then vitest: unit, property,
                          # integration, HTTP and compiled-wasm suites (real on-disk SQLite, real Ed25519 keys,
                          # isolated signer child process, wasm under a SIMULATED NEAR host - not nearcore)
pnpm run typecheck        # tsc project build + test typecheck
pnpm run lint             # biome lint
pnpm run format:check     # biome format (check only)
pnpm run security         # repository secret scan (pnpm audit is run separately: `pnpm audit`)
pnpm run contract:build   # wasm32 release build from contract/ (--cfg near); prints the artifact sha256
pnpm run contract:test    # cargo host tests: canonical vectors + escrow-core authority logic
pnpm run check            # format + lint + typecheck + test + security
```

`pnpm run vectors` rebuilds and regenerates `fixtures/canonical-vectors.json`. Vectors are deterministic;
regeneration must produce no diff unless the canonical encoding is deliberately versioned (ADR-0002).

## Run the authority API (local)

```sh
pnpm run build
pnpm run api              # node services/api/dist/main.js, listens on DOCKSIDE_HOST:DOCKSIDE_PORT
```

Configuration is environment-only and fails closed on unknown `DOCKSIDE_*` names:

| Variable | Default | Notes |
|---|---|---|
| `DOCKSIDE_DB_PATH` | `.data/dockside.sqlite` | SQLite file (WAL). `.data/` is git-ignored. |
| `DOCKSIDE_ORIGIN` | `http://localhost:8787` | Exact origin bound into every proof-of-possession challenge. https, or http on loopback only. |
| `DOCKSIDE_HOST` / `DOCKSIDE_PORT` | `127.0.0.1` / `8787` | Listen address. |
| `DOCKSIDE_NETWORK` | `near-testnet` | `near-mainnet` is rejected (funded rail is BLOCKED). |
| `DOCKSIDE_CHALLENGE_TTL_MS` | 300000 | PoP challenge lifetime. |
| `DOCKSIDE_SESSION_TTL_MS` | 28800000 | Session lifetime. |
| `DOCKSIDE_INVITATION_TTL_MS` | 259200000 | One-time invitation lifetime. |
| `DOCKSIDE_RECOVERY_DELAY_MS` | 172800000 | Delay before a recovered key activates. |
| `DOCKSIDE_REQUEST_PROOF_SKEW_MS` | 60000 | Allowed clock skew for per-request proofs. |

Authenticated calls send `Authorization: Dockside-Session <token>` **and** `Dockside-Proof:
base64url(JSON{sessionId, issuedAt, nonce, signature})`, where `signature` is Ed25519 by the session key over
the DCE-1 `dockside/request-proof` payload `{sessionId, origin, method, path+query, SHA-256(body), issuedAt,
nonce}` (ADR-0003). Endpoints (all JSON):

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /healthz`, `GET /readyz` | no | process health; schema version, network, funded rail state |
| `POST /v1/bootstrap/challenges`, `POST /v1/bootstrap/complete` | no | organization bootstrap by key PoP (canonical or NEP-413) |
| `POST /v1/sessions/challenges`, `POST /v1/sessions/complete` | no | login: new PoP session |
| `GET /v1/me` | yes | current principal, key version, capabilities |
| `POST /v1/invitations` | admin | one-time scoped invitation (secret returned once) |
| `POST /v1/invitations/challenges`, `POST /v1/invitations/accept` | no | recipient proves its own key in its own session |
| `POST /v1/invitations/:id/grant`, `POST /v1/principals/:id/capabilities` | admin | later role grant |
| `POST /v1/keys/:id/revoke`, `POST /v1/keys/rotation/challenges`, `POST /v1/keys/rotation/complete` | yes | revoke / rotate |
| `POST /v1/recoveries`, `/prove`, `/:id/complete`, `/:id/cancel-challenges`, `/cancel` | mixed | delayed, vetoable recovery |
| `POST /v1/service-enrollments`, `/prove`, `/:id/activate`, `/:id/rotate`, `/:id/recover`, `/:id/revoke`; `GET /v1/service-enrollments/:id` | admin (prove: service PoP) | ManifestAttestor / deterministic-policy enrollment |
| `GET /v1/audit` | admin or auditor | organization audit events (hash-chained) |

## Layout

```text
packages/core       canonical encoding, codecs, schemas, signatures, roles, config      (M00)
packages/store      node:sqlite database, migrations, nonces, idempotency, audit        (M00)
packages/authority  organizations, principals, keys, sessions, invitations, services    (M01)
services/api        HTTP control API (M01 authority endpoints)                          (M01)
services/worker     reserved for workers (M03/M05)
apps/web            reserved for the UI (M08)
packages/near       NEAR JSON-RPC client, escrow contract client, signed payload builders  (M02)
contract/           Rust workspace: dockside-canonical (DCE-1), dockside-escrow-core (authority
                    logic, host-tested), dockside-escrow (near-sdk 5.30.1 wasm contract)         (M02)
scripts/testnet-deploy  runbook + read-only verify script for YOUR testnet deployment (BLOCKED here)
fixtures/           cross-language canonical vectors
docs/adr            architecture decisions;  docs/evidence: retained run output
```

## NEAR contract (local)

```sh
pnpm run contract:build
# contract/target/wasm32-unknown-unknown/release/dockside_escrow.wasm
```

Entry points: `new`, `register_trade`, payable `fund`, `set_hold`, `resolve_hold`, `revoke_bound_key`,
`request_refund`, `cosign_refund`, `revoke_refund`, `dispute_refund`, `authorize_refund`, `execute_refund`
(+ private `on_refund_transfer`), `ft_on_transfer` / `nft_on_transfer` / `mt_on_transfer` (recorded for
review only), and views `get_config`, `get_trade`, `get_ledger`, `get_refunds`, `get_holds`,
`get_unexpected_assets`. Signed arguments are typed canonical JSON built by `@dockside/near`
(see ADR-0004). Deploying to testnet is for you to do: [`scripts/testnet-deploy/README.md`](scripts/testnet-deploy/README.md).

## Safety boundaries

Nothing in this repository pushes, deploys, signs with a real wallet, funds, calls 1Click, or creates
accounts. Those steps remain `BLOCKED`/`NOT_RUN` until separately authorized; see BUILD-STATUS.md.
