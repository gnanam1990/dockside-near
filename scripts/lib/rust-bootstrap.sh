# Sourced (not executed) by scripts/container-reproduce.sh and scripts/sandbox/container-sandbox.sh:
# installs Rust 1.97.1 with the wasm32 target from a rustup-init binary pinned by version and
# SHA-256, refused on mismatch, in the same style as the near-sandbox and near-cli-rs pins
# (ADR-0021). No installer script is piped to a shell.
#
# rustup-init copies itself to $CARGO_HOME/bin/rustup, so a rustup already in the cargo volume is
# kept only when its digest equals the pinned rustup-init's; anything else (an older install, a
# self-update, a changed file) is replaced by the verified installer.
#
# The toolchain components that rustup then downloads are checked by rustup itself against the
# SHA-256 values in the release channel manifest for 1.97.1 from static.rust-lang.org.
RUSTUP_VERSION=1.29.3
RUSTUP_INIT_SHA256_X86_64=b1c8cb14e30889e7e2999e6b69e62d9e9b9ffc0f4df8180564d306d9680e6c55
RUSTUP_INIT_SHA256_AARCH64=9f608c142e0e38a78957d0661ba1dfaf0b6fb37184cfaa4b9a0aa57af6184282
RUST_TOOLCHAIN=1.97.1

case "$(uname -m)" in
  x86_64 | amd64) RUSTUP_TRIPLE=x86_64-unknown-linux-gnu RUSTUP_INIT_SHA256=$RUSTUP_INIT_SHA256_X86_64 ;;
  aarch64 | arm64) RUSTUP_TRIPLE=aarch64-unknown-linux-gnu RUSTUP_INIT_SHA256=$RUSTUP_INIT_SHA256_AARCH64 ;;
  *)
    echo "rust-bootstrap: no pinned rustup-init for $(uname -m)" >&2
    exit 1
    ;;
esac

RUSTUP_BIN="${CARGO_HOME:-/root/.cargo}/bin/rustup"
if [ ! -x "$RUSTUP_BIN" ] || ! echo "$RUSTUP_INIT_SHA256  $RUSTUP_BIN" | sha256sum -c - >/dev/null 2>&1; then
  # rustup-init picks its mode from its file name, so it keeps that name in a private directory.
  RUSTUP_INIT_DIR=$(mktemp -d)
  RUSTUP_INIT="$RUSTUP_INIT_DIR/rustup-init"
  curl -sSf --proto '=https' --tlsv1.2 -o "$RUSTUP_INIT" \
    "https://static.rust-lang.org/rustup/archive/$RUSTUP_VERSION/$RUSTUP_TRIPLE/rustup-init"
  if ! echo "$RUSTUP_INIT_SHA256  $RUSTUP_INIT" | sha256sum -c - >/dev/null 2>&1; then
    echo "rust-bootstrap: rustup-init $RUSTUP_VERSION ($RUSTUP_TRIPLE) does not match its pinned SHA-256; refusing to run it" >&2
    rm -rf "$RUSTUP_INIT_DIR"
    exit 1
  fi
  chmod +x "$RUSTUP_INIT"
  "$RUSTUP_INIT" -y -q --profile minimal --default-toolchain "$RUST_TOOLCHAIN" >/dev/null
  rm -rf "$RUSTUP_INIT_DIR"
fi
. "${CARGO_HOME:-/root/.cargo}/env"
# Keep the verified rustup binary: no self-update to an unpinned release.
rustup set auto-self-update disable >/dev/null 2>&1
rustup toolchain install "$RUST_TOOLCHAIN" --profile minimal >/dev/null 2>&1
rustup default "$RUST_TOOLCHAIN" >/dev/null
rustup target add wasm32-unknown-unknown >/dev/null 2>&1
