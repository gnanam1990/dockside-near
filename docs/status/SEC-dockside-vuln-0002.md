# SEC vuln-0002 — unverified rustup bootstrap, mutable base images and an unlocked near-sandbox install

- Source: external automated scan, finding vuln-0002 (LOW, CWE-494). Verified independently on the real code.
- Branch: `feat/dockside-m21-pinned-toolchain-bootstrap`, base main `2293bc5`, merged with main `a5d7c04` before
  the regression.
- Area: the container build of the deployable wasm and the real-chain suites (T-043, T-045); decision record
  [ADR-0021](../adr/0021-pinned-container-toolchain-bootstrap.md).

## Finding (confirmed)

- `scripts/container-reproduce.sh` and `scripts/sandbox/container-sandbox.sh` ran
  `curl -sSf https://sh.rustup.rs | sh -s -- -y ... --default-toolchain 1.97.1`. Neither the installer
  script nor the `rustup-init` it fetches was pinned or hashed.
- `scripts/container-reproduce.mjs`, `scripts/sandbox/run.mjs` and `services/api/test/m17-near-sandbox.test.ts`
  used `node:22-bookworm-slim` / `node:22-trixie-slim` by tag. Both tags were republished on 2026-11-11, so the
  build environment had changed between runs without any commit.
- The M17 container ran `npm install near-sandbox@0.3.4` with no lockfile. The package downloads nearcore at run
  time without checking a digest. The package has no install script; the scan's "postinstall" reading was
  inexact, but the download was unverified all the same.

The near-sandbox 2.14.0 and near-cli-rs downloads were already pinned by SHA-256. The wasm digest check compares
builds made from the same toolchain path, so it could not detect a substituted installer.

## Fix

- `scripts/lib/rust-bootstrap.sh`, sourced by both container scripts, downloads `rustup-init` 1.29.3 from
  `static.rust-lang.org/rustup/archive/` and checks it with `sha256sum -c` against pins for x86_64 and aarch64
  Linux (`b1c8cb14…6c55`, `9f608c14…4282`, equal to rust-lang's published `.sha256` files). It exits 1 before
  running anything on a mismatch. A cached `$CARGO_HOME/bin/rustup` is reused only if its digest equals the pin.
  Auto self-update is disabled.
- `IMAGES` in `scripts/lib/docker.mjs` pins `node:22-bookworm-slim@sha256:e9f565d3…21ee` and
  `node:22-trixie-slim@sha256:68c76cfa…2b64`. Both runners and the M17 suite use these digests.
- The M17 container runs `npm ci --ignore-scripts` from `scripts/near-sandbox/npm/package-lock.json`, which has
  integrity on all 47 entries. `scripts/near-sandbox/fetch-sandbox.mjs` downloads nearcore 2.13.4 and refuses
  it unless its SHA-256 is `5690a463…163f`. `launch.mjs` gets the binary through `NEAR_SANDBOX_BIN_PATH`.
- Residual items (apt package versions, corepack pnpm, Playwright browser, the second build not being
  independent) are recorded in ADR-0021.

## Tests (red before green)

`packages/core/test/sec-vuln-0002-toolchain-pins.test.ts` has 5 cases: no download piped to a shell; Rust only
through the bootstrap, with fetch, then digest check, then run; every image by digest, one digest per tag; M17 on
`npm ci --ignore-scripts` with a fully integrity-locked lockfile; `fetch-sandbox.mjs` refuses an archive with the
wrong digest (exit 1, no binary written).

| Step | Command | Exit | Result |
|---|---|---|---|
| Before fix | `npx vitest run packages/core/test/sec-vuln-0002-toolchain-pins.test.ts` | 1 | 5 failed (`not to match /sh\.rustup\.rs/`, `'node:22-bookworm-slim' to match ...@sha256...`, `to match /npm ci --ignore-scripts/`, ...) |
| After fix | same command | 0 | 5 passed |

## Bootstrap in a real container (`node:22-bookworm-slim@sha256:e9f565d3…`, Docker 29 in WSL 2, throwaway volumes)

| Step | Exit | Result |
|---|---|---|
| Fresh cargo/rustup volumes, source `scripts/lib/rust-bootstrap.sh` | 0 | `rustc 1.97.1 (8bab26f4f 2026-07-14)`, `rustup 1.29.3`, targets `wasm32-unknown-unknown`, `x86_64-unknown-linux-gnu`; `$CARGO_HOME/bin/rustup` sha256 `b1c8cb14…6c55` (the pin) |
| Same volumes again (cached rustup) | 0 | reused, same versions and digest, no reinstall |
| Fresh volumes, bootstrap copy with the x86_64 pin set to 64 zeros | 1 | `rust-bootstrap: rustup-init 1.29.3 (x86_64-unknown-linux-gnu) does not match its pinned SHA-256; refusing to run it`; cargo volume left empty (0 entries) |

The first attempt saved `rustup-init` under a `mktemp` name and failed with `unknown proxy name: 'tmp'`, because
rustup-init picks its mode from its file name. The bootstrap now keeps the name `rustup-init` inside a private
temporary directory.

## Regression (worktree after `git merge main`, commit `9a6c750`)

| Suite | Command | Exit | Result |
|---|---|---|---|
| Full check | `pnpm run check` | 0 | format, lint, typecheck; 54 test files passed, 1 skipped; 583 tests passed, 3 skipped; secret-scan clean (498 files) |
| Linux clean-checkout reproduction (pinned bookworm image, verified rustup) | `DOCKSIDE_DOCKER="wsl.exe -d Ubuntu-24.04 -u root -- docker" pnpm run contract:reproduce` | 0 | report `PASS` (in-container check 583 passed / 3 skipped, contract host tests); deployable wasm sha256 `497b15ab60c9e23933afbe16f9c18054806adec06a46abfc8e30b3b9fd202774`, **unchanged** from M18 |
| Real-chain suites (pinned trixie image, verified rustup) | `pnpm run contract:sandbox` (same `DOCKSIDE_DOCKER`) | 0 | `sandbox suite PASS`: rebuild equals the manifest; near-workspaces 7 + 6 passed; run-all validation 1 passed; neard 2.14.0 |
| Account ownership on nearcore (lockfile + SHA-256-checked nearcore 2.13.4) | `DOCKSIDE_NEAR_SANDBOX_PORT=9011 pnpm run test:sandbox` | 0 | 3 passed |

The browser e2e stacks were not re-run separately. The change touches no product, API or web code. The `--e2e`
path changes only the Rust bootstrap and image it shares with the reproduction above.

## Remaining

The items left unpinned (Debian package versions, corepack-fetched pnpm, the Playwright browser, and the second
build sharing the same pinned toolchain path) are described in ADR-0021 with the reasons.
