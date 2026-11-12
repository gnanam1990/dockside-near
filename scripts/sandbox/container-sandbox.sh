#!/bin/sh
# Real-chain test suite (M16) inside an official node:22-trixie-slim container: near-sdk
# `unit-testing` host tests, near-workspaces tests on a local near-sandbox node, and the
# validation of scripts/testnet-deploy/run-all against that sandbox. Nothing here talks to
# NEAR testnet or mainnet.
#
# The escrow wasm under test is the deployable one (ADR-0015): /repro/dockside_escrow.wasm and
# /repro/build-manifest.json from scripts/container-reproduce.sh. Before any test the script
# checks the wasm's SHA-256 against the manifest and rebuilds the contract from <commit> here to
# show that this commit's source produces exactly that wasm.
#
# trixie, not bookworm: the official near-sandbox 2.14.0 binary needs glibc 2.38 or newer.
# Downloads (pinned by SHA-256, refused on mismatch): the near-sandbox node binary from NEAR's
# release bucket (the location the official near-sandbox crate installs from) and near-cli-rs
# from its official GitHub release.
#
#   docker run --rm -v <repo>:/repo:ro [-v <repo .git dir>:/gitdir:ro] -v <repro dir>:/repro:ro \
#     -v <out dir>:/out -v dockside-cargo:/root/.cargo -v dockside-rustup:/root/.rustup \
#     -e CARGO_HOME=/root/.cargo -e RUSTUP_HOME=/root/.rustup \
#     node:22-trixie-slim@sha256:<IMAGES.trixie digest> sh /repo/scripts/sandbox/container-sandbox.sh <commit>
# (`pnpm run contract:sandbox` builds this command.) Writes /out/sandbox-report.json and the
# test logs.
set -eu
REF="${1:?usage: container-sandbox.sh <commit>}"
NEAR_SANDBOX_VERSION=2.14.0
NEAR_SANDBOX_SHA256=a0ba004218b218bd74351795e7ce2eda4a2b6af5cd3e252bd5e8bfe3c8f2e691
NEAR_CLI_VERSION=0.31.1
NEAR_CLI_SHA256=8b92f4f79f324a882ad79b58d61b91dccc676dd653dc72a1f23693aa5db99e21
export DEBIAN_FRONTEND=noninteractive
# A stalled mirror connection must time out and retry, not hang the job (seen once in M18).
printf '%s\n' 'Acquire::http::Timeout "60";' 'Acquire::https::Timeout "60";' 'Acquire::Retries "5";' \
  >/etc/apt/apt.conf.d/80-dockside-network
apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends git curl ca-certificates build-essential pkg-config libssl-dev >/dev/null
# Rust 1.97.1 from the rustup installer pinned by version and SHA-256 (ADR-0021).
. /repo/scripts/lib/rust-bootstrap.sh

TOOLS=/opt/near-tools
mkdir -p "$TOOLS" && cd "$TOOLS"
curl -sSfL -o near-sandbox.tar.gz \
  "https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Linux-x86_64/$NEAR_SANDBOX_VERSION/near-sandbox.tar.gz"
echo "$NEAR_SANDBOX_SHA256  near-sandbox.tar.gz" | sha256sum -c - >/dev/null
curl -sSfL -o near-cli-rs.tar.gz \
  "https://github.com/near/near-cli-rs/releases/download/v$NEAR_CLI_VERSION/near-cli-rs-x86_64-unknown-linux-gnu.tar.gz"
echo "$NEAR_CLI_SHA256  near-cli-rs.tar.gz" | sha256sum -c - >/dev/null
tar xzf near-sandbox.tar.gz && tar xzf near-cli-rs.tar.gz
mv Linux-x86_64/near-sandbox near-sandbox && mv near-cli-rs-x86_64-unknown-linux-gnu/near near
"$TOOLS/near-sandbox" --version | head -1
"$TOOLS/near" --version 2>/dev/null | tail -1

SRC=/repo
[ -d /gitdir ] && SRC=/gitdir
git config --global --add safe.directory '*'
rm -rf /work && mkdir -p /work
git clone --quiet --no-local "$SRC" /work/src
cd /work/src
git -c advice.detachedHead=false checkout --quiet "$REF"
COMMIT=$(git rev-parse HEAD)
uname -sm

# The deployable wasm and its manifest; this commit's contract source must build to it.
WANT=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync("/repro/build-manifest.json","utf8")).contract.sha256)')
HAVE=$(sha256sum /repro/dockside_escrow.wasm | cut -d' ' -f1)
[ "$WANT" = "$HAVE" ] || { echo "/repro wasm $HAVE differs from its manifest $WANT" >&2; exit 1; }
node scripts/build-contract.mjs >/dev/null
REBUILT=$(sha256sum contract/target/wasm32-unknown-unknown/release/dockside_escrow.wasm | cut -d' ' -f1)
[ "$REBUILT" = "$WANT" ] || { echo "commit $COMMIT builds wasm $REBUILT, not the manifest's $WANT" >&2; exit 1; }

cd contract/integration
cargo build --quiet --locked -p dockside-test-token --target wasm32-unknown-unknown --release
export NEAR_SANDBOX_BIN_PATH="$TOOLS/near-sandbox"
export DOCKSIDE_ESCROW_WASM=/repro/dockside_escrow.wasm
export DOCKSIDE_ESCROW_WASM_SHA256="$WANT"
export DOCKSIDE_BUILD_MANIFEST=/repro/build-manifest.json
export DOCKSIDE_NEAR_CLI="$TOOLS/near"
set +e
cargo test --locked >/out/sandbox-tests.log 2>&1
SUITE=$?
grep -E "^(test |running|     Running)" /out/sandbox-tests.log
cargo test --locked --test run_all_on_sandbox -- --ignored >/out/run-all-validation.log 2>&1
VALIDATION=$?
grep -E "^(test |run-all: )" /out/run-all-validation.log
set -e
node -e '
const fs = require("fs");
const [commit, wasm, suite, validation, sbx, sbxSha, cli, cliSha] = process.argv.slice(1);
const results = (f) => [...fs.readFileSync(f, "utf8").matchAll(/test result: (\w+)\. (\d+) passed; (\d+) failed; (\d+) ignored/g)]
  .map((m) => ({ result: m[1], passed: +m[2], failed: +m[3], ignored: +m[4] }));
const report = {
  schema: "dockside/sandbox-report@1", commit, wasmSha256: wasm,
  tools: { nearSandbox: { version: sbx, sha256: sbxSha }, nearCliRs: { version: cli, sha256: cliSha } },
  suite: { exit: +suite, results: results("/out/sandbox-tests.log") },
  runAllValidation: { exit: +validation, results: results("/out/run-all-validation.log") },
  result: +suite === 0 && +validation === 0 ? "PASS" : "FAIL",
};
fs.writeFileSync("/out/sandbox-report.json", JSON.stringify(report, null, 2) + "\n");
console.log(`sandbox suite ${report.result}`);
' "$COMMIT" "$WANT" "$SUITE" "$VALIDATION" "$NEAR_SANDBOX_VERSION" "$NEAR_SANDBOX_SHA256" "$NEAR_CLI_VERSION" "$NEAR_CLI_SHA256"
[ "$SUITE" -eq 0 ] && [ "$VALIDATION" -eq 0 ]
