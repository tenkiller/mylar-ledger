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

as_node() {
  setpriv --reuid=node --regid=node --init-groups -- "$@"
}

# Restore only when there is no local database. Restore into a scratch file and rename it into
# place, so a failed or interrupted restore can never leave a partial database at DB_PATH. A
# failure aborts the boot: starting on an empty database would let replication overwrite the good
# replica.
if [ -f "$DB_PATH" ]; then
  echo "Database exists, skipping restore."
elif [ "$REPLICATION" = 1 ]; then
  RESTORED="$DB_PATH.restore"
  rm -f "$RESTORED" "$RESTORED-wal" "$RESTORED-shm"
  if ! as_node litestream restore -config "$CONFIG" -if-replica-exists -o "$RESTORED" "$DB_PATH"; then
    rm -f "$RESTORED" "$RESTORED-wal" "$RESTORED-shm"
    echo "Restore from replica failed; refusing to start."
    exit 1
  fi

  if [ -f "$RESTORED" ]; then
    echo "Restored from replica."
    rm -f "$RESTORED-wal" "$RESTORED-shm"
    mv "$RESTORED" "$DB_PATH"
  else
    echo "No replica found."
  fi
fi

# Litestream supervises the server: it forwards SIGTERM, then does a final sync. "$*" is expanded
# before `set --` replaces the arguments.
if [ "$REPLICATION" = 1 ]; then
  set -- litestream replicate -config "$CONFIG" -exec "$*"
fi
exec setpriv --reuid=node --regid=node --init-groups -- "$@"
