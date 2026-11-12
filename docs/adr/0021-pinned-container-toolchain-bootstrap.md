# ADR-0021 — Pinned container images, rustup installer and nearcore sandbox

- Decision status: accepted (security fix for dockside vuln-0002)
- Date: 2026-11-12, Dockside platform team
- Affected IDs: T-043, T-045; REAL-PRODUCT-GATE item 1
- Relates to: ADR-0015 (Linux reproduction, deployable wasm), ADR-0018 (account-ownership suite on
  nearcore), ADR-0019 (near-sandbox suites), ADR-0020 (CI)

## Context

An external automated scan (finding vuln-0002, CWE-494, LOW) pointed out that the containers that build
and test the deployable escrow wasm ran code they had not verified:

- `scripts/container-reproduce.sh` and `scripts/sandbox/container-sandbox.sh` installed Rust with
  `curl -sSf https://sh.rustup.rs | sh`: the installer script and the `rustup-init` binary it fetched
  were not pinned or hashed. Only the toolchain version (1.97.1) was fixed.
- `scripts/container-reproduce.mjs`, `scripts/sandbox/run.mjs` and the M17 suite ran
  `node:22-bookworm-slim` and `node:22-trixie-slim` by tag. Those tags move (both were republished
  on 2026-11-11).
- The M17 account-ownership suite ran `npm install near-sandbox@0.3.4` in its container with no
  lockfile, so its dependency tree floated, and the package downloaded the nearcore binary at run
  time without checking a digest.

The same scripts already pinned the near-sandbox 2.14.0 and near-cli-rs 0.31.1 archives by SHA-256.
The rustup bootstrap was the inconsistent link. The wasm digest check compares builds from the same
toolchain path, so it cannot detect a compromised compiler on its own.

## Decisions

1. **Images by digest.** `IMAGES` in `scripts/lib/docker.mjs` holds
   `node:22-bookworm-slim@sha256:e9f565d3…` and `node:22-trixie-slim@sha256:68c76cfa…`. These are the
   multi-platform index digests of the tags as pulled on 2026-11-12. Both container runners take their
   image from `IMAGES`. The M17 suite (TypeScript, which does not import the `.mjs`) repeats the trixie
   reference, and a test requires one digest per tag across the repository. To bump an image, change
   the digest on purpose and re-run `contract:reproduce`, `contract:sandbox` and `test:sandbox`.
2. **rustup-init pinned by version and SHA-256, never piped to a shell.** `scripts/lib/rust-bootstrap.sh`
   is sourced by both container scripts. It downloads
   `https://static.rust-lang.org/rustup/archive/1.29.3/<triple>/rustup-init` (x86_64 and aarch64
   Linux pinned). It checks the file with `sha256sum -c` and exits 1 on a mismatch before running
   anything. Only then does it run the installer with the minimal profile and 1.97.1. The pins equal
   the `.sha256` files that rust-lang publishes beside the binaries. Amended by finding m29 (external
   security audit): no cargo or rustup home is reused. The runners mount no `dockside-cargo` or
   `dockside-rustup` volume, so each `--rm` container installs the toolchain into homes it discards,
   and the bootstrap refuses a non-empty `$CARGO_HOME` or `$RUSTUP_HOME` rather than trusting it. A
   digest match of a cached `bin/rustup`, the earlier rule, proved nothing about the env script,
   proxies, toolchain or registry cache beside it, all writable by the code a previous run tested.
   The bootstrap sets `PATH` itself and sources nothing from the homes. `rustup set auto-self-update disable`
   keeps the verified binary.
3. **Toolchain components are verified by rustup.** rustup checks each 1.97.1 component it
   downloads against the SHA-256 in the channel manifest from `static.rust-lang.org` over TLS. This
   build adds no second hash list for the components: the version is fixed and the trust root is the
   same first-party host that the pinned installer comes from.
4. **The M17 sandbox from a lockfile and a hash-pinned binary.** `scripts/near-sandbox/npm/` has
   `package.json` and a lockfile (v3, `sha512` integrity on every entry, all resolved from
   `registry.npmjs.org`) for `near-sandbox` 0.3.4 and its 46 dependencies. The container runs
   `npm ci --ignore-scripts`. `scripts/near-sandbox/fetch-sandbox.mjs` downloads the nearcore 2.13.4
   sandbox archive (the version that package defaults to) from NEAR's release bucket and refuses it
   unless its SHA-256 is `5690a463…`. `launch.mjs` then runs with `NEAR_SANDBOX_BIN_PATH` set to the
   verified binary, so the npm package downloads nothing.
5. **Enforced in `pnpm run check`.** `packages/core/test/sec-vuln-0002-toolchain-pins.test.ts` refuses
   a downloaded script piped to a shell in any of these files. It also refuses a container script
   that installs Rust other than through the bootstrap, a bootstrap that runs the installer before
   the digest check, an image reference without a digest, an `npm install` in the M17 suite and a
   lockfile entry without integrity. It feeds `fetch-sandbox.mjs` an archive with the wrong digest
   and expects exit 1 with no binary written.

## Not pinned (residual)

- **Debian packages.** `git`, `curl`, `ca-certificates`, `build-essential` (and `pkg-config` and
  `libssl-dev` in the sandbox image) come from apt at their current versions. apt verifies the signed
  Release files with the keyring inside the digest-pinned image, so a mirror alone cannot substitute
  packages. A compromise of Debian's signing would still reach the host C toolchain, which links
  build scripts and proc macros. Pinning through snapshot.debian.org was not adopted in this fix: that
  service is rate-limited, and depending on it would make every CI run slower and less reliable. Revisit this if the deployable wasm moves to a
  dedicated build image.
- **pnpm through corepack** (`pnpm@10.34.9`) and the Playwright Chromium for `--e2e` are fetched by
  their own tools at fixed versions. Corepack checks the npm registry signature of the pnpm release.
  Playwright's browser download is outside the deployable-wasm path.
- **The second build is not independent.** The trixie rebuild in `contract:sandbox` uses the same
  pinned toolchain path. With every input pinned, it now proves determinism of pinned inputs rather
  than independence. A build on another machine or toolchain distribution would be needed for
  independence (USER-NEXT-STEPS, independent security review).

## Consequences

- A moved tag, a changed `rustup-init` or a changed nearcore archive now stops the job with a named
  error instead of silently changing the build environment.
- The deployable wasm digest does not change: the Rust toolchain version, the profile and the target
  are the same as before.
- Bumping rustup, an image or nearcore is now a deliberate change with new pins and a re-run of the
  container suites.
