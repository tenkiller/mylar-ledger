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

# Restore into a scratch file and rename it into place, so a failed or interrupted restore can
# never leave a partial database at DB_PATH. A failure aborts the boot: starting on an empty or
# stale database would let replication overwrite the good replica.
if [ "$REPLICATION" = 1 ]; then
  RESTORED="$DB_PATH.restore"
  rm -f "$RESTORED" "$RESTORED-wal" "$RESTORED-shm"
  if ! as_node litestream restore -config "$CONFIG" -if-replica-exists -o "$RESTORED" "$DB_PATH"; then
    rm -f "$RESTORED" "$RESTORED-wal" "$RESTORED-shm"
    echo "Restore from replica failed; refusing to start."
    exit 1
  fi

  if [ ! -f "$RESTORED" ]; then
    echo "No replica found."
  else
    # seq only grows, so the higher one has seen more writes (e.g. a volume rebuilt from an old
    # Fly snapshot is behind the replica).
    LOCAL_SEQ=0
    if [ -f "$DB_PATH" ]; then
      LOCAL_SEQ="$(as_node node /app/packages/api/src/db-seq.ts "$DB_PATH")"
    fi
    REPLICA_SEQ="$(as_node node /app/packages/api/src/db-seq.ts "$RESTORED")"

    if [ "$REPLICA_SEQ" -gt "$LOCAL_SEQ" ]; then
      if [ -f "$DB_PATH" ]; then
        BACKUP="$DB_PATH.stale-$(date -u +%Y%m%dT%H%M%SZ)"
        echo "Replica (seq $REPLICA_SEQ) is ahead of local (seq $LOCAL_SEQ); keeping local as $BACKUP."
        mv "$DB_PATH" "$BACKUP"
        [ ! -f "$DB_PATH-wal" ] || mv "$DB_PATH-wal" "$BACKUP-wal"
        [ ! -f "$DB_PATH-shm" ] || mv "$DB_PATH-shm" "$BACKUP-shm"
      else
        echo "Restoring from replica (seq $REPLICA_SEQ)."
      fi
      rm -f "$RESTORED-wal" "$RESTORED-shm"
      mv "$RESTORED" "$DB_PATH"
    else
      echo "Local database (seq $LOCAL_SEQ) is current; discarding replica copy (seq $REPLICA_SEQ)."
      rm -f "$RESTORED" "$RESTORED-wal" "$RESTORED-shm"
    fi
  fi
fi

# Litestream supervises the server: it forwards SIGTERM, then does a final sync. "$*" is expanded
# before `set --` replaces the arguments.
if [ "$REPLICATION" = 1 ]; then
  set -- litestream replicate -config "$CONFIG" -exec "$*"
fi
exec setpriv --reuid=node --regid=node --init-groups -- "$@"
