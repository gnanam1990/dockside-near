# ADR-0020 — Continuous integration workflow and the M18 consolidation

- Decision status: accepted (M18)
- Date: 2026-11-12, Dockside platform team (M18)
- Affected IDs: T-043, T-044, T-045; REAL-PRODUCT-GATE item 1
- Relates to: ADR-0011 (delivery), ADR-0015 (Linux reproduction, deployable wasm), ADR-0019
  (near-sandbox suites and run-all)

## Context

Every regression so far was run by hand on one Windows host and, through
`scripts/container-reproduce.sh`, in a Linux container. The repository had no CI definition, so a
pull request could not show that the frozen install, the full check, the contract host tests, the
four browser stacks, the Linux reproduction and the real-chain suites still pass. M18 adds a GitHub
Actions workflow. Nothing was pushed in this build, so the workflow has never run on GitHub; it was
validated by parsing it, by a policy check and by replaying its commands locally.

## Decisions

1. **Two jobs.** `test` runs on a matrix of `ubuntu-24.04` and `windows-2022`: frozen pnpm install,
   Rust 1.97.1 with `wasm32-unknown-unknown`, `pnpm run check`, `pnpm run contract:test`,
   `pnpm --filter @dockside/web exec playwright install --with-deps chromium` (the package that pins
   Playwright 1.64.1) and `pnpm run web:e2e` (four stacks, default ports; a runner is not shared).
   `chain` runs on `ubuntu-24.04`, which has a Docker Engine: `pnpm run contract:reproduce` (the
   clean-checkout reproduction in `node:22-bookworm-slim` that exports the deployable wasm and its
   manifest, ADR-0015), `pnpm run contract:sandbox` (near-sdk `unit-testing`, near-workspaces on
   near-sandbox 2.14.0 and the run-all validation, ADR-0019) and `pnpm run test:sandbox` (NEAR
   account ownership against nearcore, ADR-0018). The chain job uploads the reports, the manifest
   and the deployable wasm as a 14-day artifact, so the wasm a user deploys can come from CI.
2. **Read-only by construction, enforced in `pnpm run check`.** Triggers are `push` to `main` and
   `pull_request` only (never `pull_request_target` or `workflow_run`); `permissions: contents:
   read` at workflow level and nothing wider in a job; no secrets and no `GITHUB_TOKEN`; checkout
   with `persist-credentials: false`; every action pinned to a full 40-character commit SHA with its
   version in a comment; only the expressions `matrix.os`, `github.workflow` and `github.ref`, and
   none inside a run script (no script injection from pull-request titles or branch names);
   per-ref concurrency with `cancel-in-progress: true`; a timeout of at most 60 minutes on every
   job; only the two pinned runner images; `bash` as the shell. `scripts/ci/workflow-policy.mjs`
   checks all of this plus the required commands in order and that every `pnpm run <name>` exists;
   `packages/core/test/m18-ci-workflow.test.ts` runs it on the committed file and on copies that
   break one rule each.
3. **As few actions as possible.** Only `actions/checkout` v4.2.2
   (`11bd71901bbe5b1630ceea73d27597364c9af683`), `actions/setup-node` v4.1.0
   (`39370e3970a6d050c480ffad4ff0ed4d3fdee5af`, Node 22.23.1) and `actions/upload-artifact` v4.4.3
   (`b4b15b8c7c6ac21ea08fcf65892d2ee8f75cf882`). pnpm comes from corepack and the root
   `packageManager` field (10.34.9); Rust from the rustup that the hosted images already carry
   (`rustup toolchain install 1.97.1 --profile minimal --target wasm32-unknown-unknown`, then
   `rustup default 1.97.1`). No cache action: a cache restored into pull-request runs is one more
   way to feed a job untrusted state, and the cold start is affordable. The SHAs are the published
   commits of those release tags as recorded by the team and cross-checked against an independently
   pinned workflow; this build could not look them up on GitHub (no remote operations), so the owner
   should confirm them once with `git ls-remote https://github.com/actions/checkout refs/tags/v4.2.2`
   (and the same for the other two) before relying on the workflow.
4. **The toolchain is chosen with `rustup default`, not `RUSTUP_TOOLCHAIN`.** The first local replay
   failed: with `RUSTUP_TOOLCHAIN=1.97.1` in the workflow env and the setup step skipped, rustup
   resolved the name for the host's default triple (msvc on this windows-gnu machine), which has no
   wasm32 target. The policy now refuses `RUSTUP_TOOLCHAIN` anywhere in the workflow (rule
   TOOLCHAIN). On `windows-2022` the default host is msvc, so CI runs the contract host tests with
   msvc while this machine used gnu; the wasm digest is per host in any case, and the deployable wasm
   is the Linux container build (ADR-0015).
5. **Local replay instead of a GitHub run.** `scripts/ci/local-run.mjs --list` prints every job,
   step and command without running anything; `--job <id>` runs the job's run steps in order with
   `bash -eo pipefail` and the workflow's env, stopping at the first failure, after the policy check.
   `uses:` steps are provided by the runner and skipped; steps whose id starts with `setup-`
   (corepack, the Rust toolchain) would change the developer's installed tools and run only with
   `--with-setup`. Port variables and `DOCKSIDE_DOCKER` pass through, so the replay can use
   restricted ports and Docker inside WSL. The `test` job was replayed on the Windows host; the
   Linux half of the `test` job is what `pnpm run contract:reproduce --e2e` runs in the container
   (frozen install, check, contract tests, the Playwright Chromium with its system libraries, the four
   browser stacks); the `chain` job was replayed on the Windows host against Docker in WSL 2.
6. **`pnpm run contract:reproduce`.** A node wrapper around `scripts/container-reproduce.sh` with the
   same `DOCKSIDE_DOCKER` handling as `contract:sandbox` (shared in `scripts/lib/docker.mjs`). It
   mounts the shared git directory at `/gitdir`, which the script now clones from when present, so a
   git worktree can be reproduced (a worktree's `.git` is a file). The nearcore account-ownership
   suite takes `DOCKSIDE_DOCKER` too and defaults to `docker` off Windows, so it runs on a Linux
   runner.
7. **Timeouts.** The `test` job's 60 minutes cover the four browser stacks (about 12 minutes on this
   host) with room for slower hosted runners. The `chain` job builds the contract twice and the
   near-workspaces test crates from a cold cargo cache; its 60-minute limit is above what this build
   measured, but a hosted-runner timing does not exist until the workflow runs on GitHub (see the
   M18 status).

## Consequences

- A pull request gets the whole local regression, both hosts, the deployable wasm and the
  real-chain suites, without any credential. Nothing in CI reaches NEAR testnet or mainnet.
- The workflow has not run on GitHub: first-run surprises on hosted images (for example a
  Playwright system-library change or Windows path length) are possible and are the owner's to see
  on the first push.
- `yaml` 2.9.0 is a new pinned dev dependency (the policy needs a YAML parser that rejects duplicate
  keys).
- BUILD-STATUS, README and USER-NEXT-STEPS were consolidated in this module from the M14–M17 status
  files and the M18 regression.
