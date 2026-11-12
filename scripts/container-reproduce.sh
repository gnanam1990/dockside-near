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
#     -v dockside-cargo:/root/.cargo -v dockside-rustup:/root/.rustup \
#     -e CARGO_HOME=/root/.cargo -e RUSTUP_HOME=/root/.rustup \
#     node:22-bookworm-slim sh /repo/scripts/container-reproduce.sh <commit> [--e2e]
# Writes /out/clean-checkout-report.json and /out/build-manifest.json. With --e2e it first installs
# the Playwright Chromium headless shell and its system libraries for the locked Playwright version.
set -eu
REF="${1:?usage: container-reproduce.sh <commit> [--e2e]}"
E2E="${2:-}"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends git curl ca-certificates build-essential >/dev/null
if [ ! -x "${CARGO_HOME:-/root/.cargo}/bin/rustup" ]; then
  curl -sSf https://sh.rustup.rs | sh -s -- -y -q --profile minimal --default-toolchain 1.97.1 >/dev/null
fi
. "${CARGO_HOME:-/root/.cargo}/env"
rustup toolchain install 1.97.1 --profile minimal >/dev/null 2>&1
rustup default 1.97.1 >/dev/null
rustup target add wasm32-unknown-unknown >/dev/null 2>&1
corepack enable
corepack prepare pnpm@10.34.9 --activate >/dev/null 2>&1
git config --global --add safe.directory '*'
rm -rf /work && mkdir -p /work
git clone --quiet --no-local /repo /work/src
cd /work/src
git -c advice.detachedHead=false checkout --quiet "$REF"
uname -sm
if [ "$E2E" = "--e2e" ]; then
  pnpm install --frozen-lockfile >/dev/null
  pnpm --filter @dockside/web exec playwright install --with-deps chromium-headless-shell >/dev/null 2>&1
fi
node scripts/clean-checkout.mjs --ref "$REF" $E2E --report /out/clean-checkout-report.json \
  --manifest /out/build-manifest.json
