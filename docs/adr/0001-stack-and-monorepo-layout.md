# ADR-0001 — Stack and monorepo layout

- Decision status: accepted (M00)
- Date and authorship: 2026-11-11, Dockside build stage M00/M01 (coding agent)
- Affected IDs: M00, M01, NFR-02, NFR-05; constrains every later module
- Supersedes: nothing. Relates to TDD.md §2 "Proposed stack".

## Context and observed evidence

TDD.md proposes Rust NEAR contract, Node.js LTS + strict TypeScript service, PostgreSQL with outbox,
S3-compatible evidence store, Next.js web and Rust/TS/browser tests. Observed toolchain on the build
machine (Windows 11): Node 22.23.1, npm 10, pnpm 10.34.9, Rust 1.97.1 (`x86_64-pc-windows-gnu`),
Python 3.15, git, gh, Playwright Chromium. **No Docker, no WSL, no PostgreSQL server.** Installing
system services or WSL is out of scope for this build.

## Options considered

1. PostgreSQL via a local install — not present; installing a system service is a system change.
2. `better-sqlite3` — native module needing a C/C++ toolchain on Windows-gnu; avoid.
3. **Node built-in `node:sqlite` (`DatabaseSync`)** — available in Node 22.13+, no native build,
   real file-backed SQLite with WAL, transactions, triggers, STRICT tables.
4. Framework choices for HTTP: Fastify/Express vs `node:http`.

## Decision and rationale

| Layer | Decision | Pinned |
|---|---|---|
| Workspace | pnpm workspace monorepo | pnpm 10.34.9 |
| Language | TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), ESM, NodeNext | typescript 5.9.3 |
| Runtime | Node.js 22 LTS (`>=22.13 <23`) | — |
| Boundary schemas | zod (strict objects) behind a custom strict raw JSON parser | zod 4.6.7 |
| Durable store | `node:sqlite`, WAL + `synchronous=FULL`, forward-only checksummed SQL migrations | built-in |
| Crypto | `node:crypto` Ed25519 + SHA-256; NEAR textual key form `ed25519:<base58>`; NEP-413 wallet message support | built-in |
| HTTP | `node:http` with a small typed router (no framework dependency) | built-in |
| Tests | vitest + fast-check (property tests); Rust `cargo test` | vitest 4.1.12, fast-check 4.10.2 |
| Lint/format | Biome | 2.5.15 |
| Contract | Rust workspace `contract/`; `dockside-canonical` crate now, NEAR escrow contract (near-sdk, wasm32) in M02 | sha2 =0.10.9 |

Exact versions are pinned (`save-exact`), the lockfile is committed, and each npm version was chosen
at least two weeks before this decision. Initial pins (zod 3.25.76, vitest 3.2.7) were replaced after
`pnpm audit` reported a high zod advisory (GHSA-mrhx-c7xc-m3w5) and critical tinypool advisories;
`pnpm audit` now reports no known vulnerabilities.

Directory layout:

```text
packages/core       @dockside/core      canonical encoding, codecs, schemas, signatures, roles, config (M00)
packages/store      @dockside/store     node:sqlite database, migrations, nonces, idempotency, audit (M00)
packages/authority  @dockside/authority organization/principal/key/session/invitation/service lifecycle (M01)
services/api        @dockside/api       HTTP control API (M01 endpoints now; M07 integrated API later)
services/worker     reserved            outbox/reconciler/analysis workers (M03/M05)
apps/web            reserved            professional UI (M08)
contract/           Rust workspace      dockside-canonical crate; NEAR escrow contract (M02)
fixtures/           shared cross-language test vectors
docs/adr, docs/evidence                 decisions and retained run evidence
```

## Trust/security/privacy impact

SQLite is single-host; durability relies on WAL + `synchronous=FULL` and on the file being on a local
disk. All authority checks are done in the service and (later) the contract, never in the store.
`node:sqlite` is flagged experimental by Node 22 and prints an `ExperimentalWarning`; its API surface used
here (`DatabaseSync`, `prepare`, `exec`) is small and is wrapped by `packages/store/src/db.ts`.

## Migration and rollback

SQL is written in portable form (no SQLite-only syntax beyond `STRICT` and `AUTOINCREMENT`) so a
PostgreSQL adapter can replace `Database` behind the same repository interfaces. Migrations are
forward-only; rollback is restore-from-backup (`node:sqlite` exposes `backup`).

## Verification and recommendation-flip condition

Verified by `pnpm run typecheck`, `pnpm test` and `pnpm run contract:test` (see BUILD-STATUS.md).
Flip to PostgreSQL when a multi-process deployment, testnet hosting, or concurrent worker fleet (M05)
needs multiple writers across hosts, or when Docker/PostgreSQL becomes available in the build environment.
