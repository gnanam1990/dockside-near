# SEC m29-toolchain-volume-verification — reused cargo/rustup volumes bypassed the vuln-0002 toolchain pin

- Source: external security audit, confirmed finding 5 (LOW). Verified independently on the real code.
- Branch: `feat/dockside-m29-toolchain-volume-verification`, base main `49fbaf7`.
- Area: `scripts/lib/rust-bootstrap.sh`, `scripts/container-reproduce.mjs`, `scripts/sandbox/run.mjs`, the hand-run
  instructions (`README.md`, `scripts/container-reproduce.sh`, `scripts/sandbox/container-sandbox.sh`,
  `scripts/testnet-deploy/README.md`) and ADR-0021.

## Finding

`contract:reproduce` and `contract:sandbox` mounted the named Docker volumes `dockside-cargo:/root/.cargo` and
`dockside-rustup:/root/.rustup` read-write into root containers. These volumes persist between runs and refs. The
bootstrap reused them whenever the single file `$CARGO_HOME/bin/rustup` matched the pinned rustup-init digest. It then
sourced `$CARGO_HOME/env` and ran cargo/rustc from the volumes without checking them. The same containers run the
checked-out ref's own install, check and test code as root. That code could leave a modified env script, proxy,
toolchain binary or registry source in a volume, and a later reproduction of a trusted ref would build its deployable
wasm with it. The sandbox rebuild shares the volumes, so its digest comparison would agree on the substituted wasm.

The spec requires reproducible builds from pinned dependencies (CORE-CONTRACT NFR-05, SECURITY supply chain). Nothing
there allows build state to carry over between runs.

## Fix

The fix is made where the toolchain is chosen, so no cargo or rustup home is ever reused:

- Neither runner mounts a cargo or rustup volume. Each `--rm` container installs the toolchain into homes it
  discards. `CARGO_HOME=/root/.cargo` is kept, so the wasm digest is unchanged (ADR-0015).
- The bootstrap refuses a non-empty `$CARGO_HOME` or `$RUSTUP_HOME` (exit 1, `... is not empty; refusing to reuse a
  cached toolchain`). This also covers a hand run that still mounts the old volumes. It always installs through the
  pinned, digest-checked rustup-init (`--no-modify-path`). It sets `PATH` itself and sources nothing from the homes.
- The hand-run commands no longer mount the volumes. ADR-0021 point 2 is amended: its claim that a digest-matched
  cached rustup made the cache safe was wrong.

The cost is that every container run downloads the minimal 1.97.1 toolchain again from `static.rust-lang.org`. In the
runs below this took about one minute.

## Tests (red before green)

New `packages/core/test/sec-m29-toolchain-volume-verification.test.ts`:

- Neither runner mounts anything at `/root/.cargo` or `/root/.rustup`. No hand-run instruction does either.
- A copy of the bootstrap has only its two rustup-init pins replaced by the digest of a planted stub `bin/rustup`. Its
  `CARGO_HOME` holds a planted `env` script and `cargo`. It must exit 1 with the refusal, without sourcing the env
  script, running the planted cargo or calling curl. curl is a logging shim that fails, so the test makes no network
  call.
- The bootstrap sources nothing from `CARGO_HOME`.
- With empty homes, the bootstrap goes straight to the pinned installer download and refuses an installer that does
  not match the pin.

`sec-vuln-0002-toolchain-pins.test.ts` had pinned the old rule (a cached `$RUSTUP_BIN` checked against the pin). It
now asserts that no cached rustup is reused.

| Step | Command | Exit | Result |
|---|---|---|---|
| Before fix | `npx vitest run packages/core/test/sec-m29-toolchain-volume-verification.test.ts` | 1 | 4 failed, 1 passed. The runner and docs still mount the volumes. The planted `env` was sourced (log `POISONED_ENV_SOURCED`). The bootstrap still sources `$CARGO_HOME/env` |
| After fix | same command plus `sec-vuln-0002-toolchain-pins.test.ts` | 0 | 2 files, 10 tests passed |
| Container, fresh homes | `docker run --rm` node:22-bookworm-slim (pinned digest), source the bootstrap | 0 | `rustc 1.97.1 (8bab26f4f 2026-07-14)`. `/root/.cargo/bin/rustup` sha256 `b1c8cb14…6c55` (the pin). cargo is at `/root/.cargo/bin/cargo` |
| Container, existing volumes mounted `:ro` | same, with `-v dockside-cargo:/root/.cargo:ro -v dockside-rustup:/root/.rustup:ro` | 1 | `rust-bootstrap: /root/.cargo is not empty; refusing to reuse a cached toolchain (mount no cargo/rustup volume)` |
| Reproduction | `pnpm run contract:reproduce --out .data/m29-repro` (merge commit `90cc679`) | 0 | clean checkout PASS. Deployable wasm sha256 `497b15ab…2774` is identical to main's earlier reproduction at `49fbaf7`, which used the cached volumes |
| Sandbox | `pnpm run contract:sandbox --repro .data/m29-repro --out .data/m29-sandbox` | 0 | rebuild digest matches. Sandbox suite PASS (6 escrow tests, run-all journey) |
| Full suite (after `git merge main`) | `pnpm run check` | 0 | format, lint, typecheck. 63 test files passed, 1 skipped. 626 tests passed, 3 skipped. secret-scan clean (536 files) |
| Contract | `pnpm run contract:test` | 0 | 103 passed, 0 failed |

The first reproduction attempt exited 1. One hook in `packages/journal/test/m05-release-journal.test.ts` timed out
after 10 s while the host ran `pnpm run check` at the same time. The toolchain steps had passed. The re-run on an idle
host passed, as shown above. Browser e2e suites were not re-run, because the change does not touch the web app.

Existing `dockside-cargo` / `dockside-rustup` volumes on a developer machine are no longer used. They can be removed
with `docker volume rm dockside-cargo dockside-rustup`.
