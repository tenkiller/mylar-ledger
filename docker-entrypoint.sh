#!/bin/sh
# Starts as root only to make the data volume writable (Fly mounts volumes root-owned), then
# drops to the unprivileged `node` user before running the server.
set -eu

if [ "$(id -u)" != 0 ]; then
  exec "$@"
fi

DATA_DIR="$(dirname "$DB_PATH")"
mkdir -p "$DATA_DIR"

if [ "$(stat -c %u "$DATA_DIR")" != "$(id -u node)" ]; then
  chown -R node:node "$DATA_DIR"
fi

REPLICATION=0

if [ -n "${BUCKET_NAME:-}" ]; then
  REPLICATION=1
elif [ -n "${FLY_APP_NAME:-}" ]; then
  echo "Replication BUCKET_NAME not set."
  exit 1
fi

CONFIG="${LITESTREAM_CONFIG:-/etc/litestream.yml}"

if [ -f "$DB_PATH" ]; then
  echo "Database exists, skipping restore."
elif [ "$REPLICATION" = 1 ]; then
  echo "Database not found, restoring from replica if it exists."
  setpriv --reuid=node --regid=node --init-groups -- litestream restore -config "$CONFIG" -if-db-not-exists -if-replica-exists "$DB_PATH"
fi

# Litestream supervises the server: it forwards SIGTERM, then does a final sync. "$*" is expanded
# before `set --` replaces the arguments.
if [ "$REPLICATION" = 1 ]; then
  set -- litestream replicate -config "$CONFIG" -exec "$*"
fi
exec setpriv --reuid=node --regid=node --init-groups -- "$@"
