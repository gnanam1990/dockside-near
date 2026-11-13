#!/bin/sh
# Entrypoint of the Dockside hosted image (M55, ADR-0027).
#
#   entrypoint.sh serve              start the product (API, worker, web) - the image's default
#   entrypoint.sh seed-demo <cmd>    demo organisations through the real API (enroll | grant | status)
#
# As root (how container hosts start it) it does three things and then drops to the unprivileged
# `dockside` user for good:
#   1. makes the persistent volume writable by that user;
#   2. copies the relayer's function-call key file from the host's secret store into a private
#      directory of the container (owner-only, never on the volume, never in the image). The secret
#      is either a file the host mounts (HOSTED_RELAYER_SECRET_FILE, default
#      /etc/secrets/relayer-key.json) or, where the host only offers variables, the base64 of that
#      file in RELAYER_KEY_JSON_B64;
#   3. removes that variable from the environment, so no Node.js process ever sees it.
# Only the PATH of the private copy is passed on (HOSTED_RELAYER_KEY_FILE), and the launcher gives
# it to the worker alone. Nothing here prints a secret.
set -eu

DATA_DIR="${HOSTED_DATA_DIR:-/data}"
SECRET_FILE="${HOSTED_RELAYER_SECRET_FILE:-/etc/secrets/relayer-key.json}"
RUN_USER=dockside

if [ "$(id -u)" = "0" ]; then
  as_user() { exec setpriv --reuid="$RUN_USER" --regid="$RUN_USER" --init-groups --inh-caps=-all "$@"; }
  RUN_DIR=/run/dockside
else
  as_user() { exec "$@"; }
  RUN_DIR="${TMPDIR:-/tmp}/dockside-run-$(id -u)"
fi

case "${1:-serve}" in
  serve)
    umask 077
    if [ "$(id -u)" = "0" ]; then
      mkdir -p "$DATA_DIR"
      # A fresh volume belongs to root; hand it over once.
      if [ "$(stat -c %U "$DATA_DIR")" != "$RUN_USER" ]; then chown -R "$RUN_USER:$RUN_USER" "$DATA_DIR"; fi
      rm -rf "$RUN_DIR"
      install -d -m 0700 -o "$RUN_USER" -g "$RUN_USER" "$RUN_DIR"
    else
      rm -rf "$RUN_DIR"
      mkdir -p -m 0700 "$RUN_DIR"
    fi
    KEY="$RUN_DIR/relayer-key.json"
    if [ -f "$SECRET_FILE" ]; then
      cat "$SECRET_FILE" > "$KEY"
    elif [ -n "${RELAYER_KEY_JSON_B64:-}" ]; then
      printf '%s' "$RELAYER_KEY_JSON_B64" | base64 -d > "$KEY" || {
        rm -f "$KEY"
        echo '{"event":"hosted.refused","code":"HOSTED_REFUSED","reason":"RELAYER_SECRET_NOT_BASE64"}'
        exit 78
      }
    fi
    unset RELAYER_KEY_JSON_B64
    if [ -f "$KEY" ]; then
      chmod 0600 "$KEY"
      if [ "$(id -u)" = "0" ]; then chown "$RUN_USER:$RUN_USER" "$KEY"; fi
      export HOSTED_RELAYER_KEY_FILE="$KEY"
    fi
    as_user node /app/services/hosted/dist/main.js
    ;;
  seed-demo)
    shift
    unset RELAYER_KEY_JSON_B64
    as_user node /app/services/hosted/dist/seed-cli.js "$@"
    ;;
  *)
    echo "usage: entrypoint.sh serve | seed-demo enroll [--reissue] | seed-demo grant | seed-demo status" >&2
    exit 2
    ;;
esac
