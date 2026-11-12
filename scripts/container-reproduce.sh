#!/bin/sh
# Linux clean-checkout reproduction (T-043, T-045) inside an official node:22-bookworm-slim container.
# It installs git, a C toolchain and Rust 1.97.1 with the wasm target, enables pnpm 10.34.9 through
# corepack, clones the mounted repository and runs scripts/clean-checkout.mjs for the given ref.
# The contract wasm built here is the deployable artifact (ADR-0015): with CARGO_HOME fixed at
# /root/.cargo its digest does not depend on the host or the checkout path.
#
# Run from the host (Docker Engine, for example inside WSL 2), with the repository mounted read-only
# at /repo and a writable directory for the reports at /out:
#   docker run --rm -v <repo>:/repo:ro -v <out dir>:/out \
#     -e CARGO_HOME=/root/.cargo -e RUSTUP_HOME=/root/.rustup \
#     node:22-bookworm-slim@sha256:<IMAGES.bookworm digest> sh /repo/scripts/container-reproduce.sh <commit> [--e2e]
# (`pnpm run contract:reproduce [--e2e]` builds this command, and also mounts the shared git
# directory at /gitdir so a git worktree can be reproduced: a worktree's .git is only a file.)
# Writes /out/clean-checkout-report.json, /out/build-manifest.json and /out/dockside_escrow.wasm (the
# deployable artifact, rebuilt from the same commit in this container and checked against the
# manifest's SHA-256). With --e2e it first installs the Playwright Chromium headless shell and its
# system libraries for the locked Playwright version.
set -eu
REF="${1:?usage: container-reproduce.sh <commit> [--e2e]}"
E2E="${2:-}"
export DEBIAN_FRONTEND=noninteractive
# A stalled mirror connection must time out and retry, not hang the job (seen once in M18); the
# setting also covers the apt-get runs of `playwright install --with-deps`.
printf '%s\n' 'Acquire::http::Timeout "60";' 'Acquire::https::Timeout "60";' 'Acquire::Retries "5";' \
  >/etc/apt/apt.conf.d/80-dockside-network
apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends git curl ca-certificates build-essential >/dev/null
# Rust 1.97.1 from the rustup installer pinned by version and SHA-256 (ADR-0021).
. /repo/scripts/lib/rust-bootstrap.sh
corepack enable
corepack prepare pnpm@10.34.9 --activate >/dev/null 2>&1
git config --global --add safe.directory '*'
SRC=/repo
[ -d /gitdir ] && SRC=/gitdir
rm -rf /work && mkdir -p /work
git clone --quiet --no-local "$SRC" /work/src
cd /work/src
git -c advice.detachedHead=false checkout --quiet "$REF"
uname -sm
if [ "$E2E" = "--e2e" ]; then
  pnpm install --frozen-lockfile >/dev/null
  pnpm --filter @dockside/web exec playwright install --with-deps chromium-headless-shell >/dev/null 2>&1
fi
node scripts/clean-checkout.mjs --ref "$REF" $E2E --report /out/clean-checkout-report.json \
  --manifest /out/build-manifest.json
# Export the deployable wasm: rebuild it here (same container, same CARGO_HOME) and refuse to copy
# it unless its digest equals the one the clean checkout recorded.
pnpm run contract:build >/dev/null
WASM=contract/target/wasm32-unknown-unknown/release/dockside_escrow.wasm
WANT=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync("/out/build-manifest.json","utf8")).contract.sha256)')
HAVE=$(sha256sum "$WASM" | cut -d' ' -f1)
if [ "$WANT" != "$HAVE" ]; then
  echo "wasm digest $HAVE differs from the clean checkout's $WANT" >&2
  exit 1
fi
cp "$WASM" /out/dockside_escrow.wasm
echo "deployable wasm: /out/dockside_escrow.wasm sha256 $HAVE"
