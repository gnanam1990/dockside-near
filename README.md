# Dockside

Dockside is a production-shaped trade-payment product: supplier payout details are bound into an escrow
agreement, release needs a signed inspection result and buyer approval, unauthorized redirection is
rejected, and payout evidence is reconciled. The authoritative specification is the sealed pack in
[`docs/spec/`](docs/spec/START-HERE.md) (do not edit it).

**Current truth:** see [`BUILD-STATUS.md`](BUILD-STATUS.md). Only module M00 (foundation/contracts) exists. There is no NEAR contract deployment, no escrow, no UI, and no
runtime `WORKING_*` claim of any kind.

## Requirements

- Node.js 22 (`>=22.13 <23`; developed on 22.23.1) — `node:sqlite` is used and prints an
  `ExperimentalWarning` on Node 22.
- pnpm 10 (`corepack enable` or a global install; developed on 10.34.9)
- Rust stable with cargo (developed on 1.97.1) for `contract/`

## Setup

```sh
pnpm install --frozen-lockfile
pnpm run build
```

## Test and check

```sh
pnpm test                 # vitest: unit, property and integration suites (real on-disk SQLite, real Ed25519)
pnpm run typecheck        # tsc project build + test typecheck
pnpm run lint             # biome lint
pnpm run format:check     # biome format (check only)
pnpm run security         # repository secret scan (pnpm audit is run separately: `pnpm audit`)
pnpm run contract:test    # cargo test for contract/ (canonical encoding cross-language vectors)
pnpm run check            # format + lint + typecheck + test + security
```

`pnpm run vectors` rebuilds and regenerates `fixtures/canonical-vectors.json`. Vectors are deterministic;
regeneration must produce no diff unless the canonical encoding is deliberately versioned (ADR-0002).

## Configuration

`loadConfig` (packages/core) reads `DOCKSIDE_*` environment variables and fails closed on unknown names
or invalid values; `DOCKSIDE_NETWORK=near-mainnet` is rejected because the funded rail is BLOCKED.

## Layout

```text
packages/core       canonical encoding, codecs, schemas, signatures, roles, config      (M00)
packages/store      node:sqlite database, migrations, nonces, idempotency, audit        (M00)
services/worker     reserved for workers (M03/M05)
apps/web            reserved for the UI (M08)
contract/           Rust workspace: dockside-canonical crate; NEAR escrow contract in M02
fixtures/           cross-language canonical vectors
docs/adr            architecture decisions;  docs/evidence: retained run output
```

## Safety boundaries

Nothing in this repository pushes, deploys, signs with a real wallet, funds, calls 1Click, or creates
accounts. Those steps remain `BLOCKED`/`NOT_RUN` until separately authorized; see BUILD-STATUS.md.
