#!/bin/sh
# Starts as root only to make the data volume writable (Fly mounts volumes root-owned), then
# drops to the unprivileged `node` user before running the server.
set -eu

if [ "$(id -u)" != 0 ]; then
  exec "$@"
fi

DATA_DIR="$(dirname "${DB_PATH:-/data/mylar.sqlite}")"
mkdir -p "$DATA_DIR"
if [ "$(stat -c %u "$DATA_DIR")" != "$(id -u node)" ]; then
  chown -R node:node "$DATA_DIR"
fi
exec setpriv --reuid=node --regid=node --init-groups -- "$@"
