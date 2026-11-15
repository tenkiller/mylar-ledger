import { DatabaseSync } from 'node:sqlite'

// Cross-table references (series_id, issue_id, ...) are indexed but deliberately not FOREIGN KEYs:
// offline clients can push a child before its parent, and tombstones keep parents around anyway.
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE server_meta (id INTEGER PRIMARY KEY CHECK (id = 1), instance_id TEXT NOT NULL);
   INSERT INTO server_meta (id, instance_id) VALUES (1, lower(hex(randomblob(16))));

   CREATE TABLE seq_counter (
    user_id TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );

   CREATE TABLE series (
     id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     deleted_at TEXT,
     seq INTEGER NOT NULL,
     title TEXT NOT NULL,
     publisher TEXT,
     start_year INTEGER,
     comicvine_id INTEGER,
     PRIMARY KEY (user_id, id)
   );
   CREATE TABLE issue (
     id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     deleted_at TEXT,
     seq INTEGER NOT NULL,
     series_id TEXT NOT NULL,
     number TEXT NOT NULL,
     cover_date TEXT,
     variant TEXT,
     barcode TEXT,
     cover_url TEXT,
     comicvine_id INTEGER,
     metadata_status TEXT NOT NULL,
     PRIMARY KEY (user_id, id)
   );
   CREATE TABLE copy (
     id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     deleted_at TEXT,
     seq INTEGER NOT NULL,
     issue_id TEXT NOT NULL,
     condition_grade TEXT,
     numeric_grade REAL,
     graded_by TEXT,
     slab_cert TEXT,
     purchase_price_cents INTEGER,
     purchase_date TEXT,
     location TEXT,
     notes TEXT,
     PRIMARY KEY (user_id, id)
   );
   CREATE TABLE price_snapshot (
     id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     deleted_at TEXT,
     seq INTEGER NOT NULL,
     issue_id TEXT NOT NULL,
     copy_id TEXT,
     grade TEXT,
     value_cents INTEGER NOT NULL,
     source TEXT NOT NULL,
     observed_at TEXT NOT NULL,
     note TEXT,
     PRIMARY KEY (user_id, id)
   );

   CREATE TABLE session (
     id_hash TEXT PRIMARY KEY,
     created_at TEXT NOT NULL,
     last_seen_at TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     password_fp TEXT NOT NULL
   );

   CREATE TABLE login_failure (ip TEXT NOT NULL, at TEXT NOT NULL);
   CREATE INDEX login_failure_ip ON login_failure (ip, at);
   CREATE INDEX login_failure_at ON login_failure (at);

   CREATE UNIQUE INDEX series_seq ON series (user_id, seq);
   CREATE UNIQUE INDEX issue_seq ON issue (user_id, seq);
   CREATE UNIQUE INDEX copy_seq ON copy (user_id, seq);
   CREATE UNIQUE INDEX price_snapshot_seq ON price_snapshot (user_id, seq);
   CREATE INDEX issue_series ON issue (series_id);
   CREATE INDEX issue_barcode ON issue (barcode);
   CREATE INDEX copy_issue ON copy (issue_id);
   CREATE INDEX price_snapshot_issue ON price_snapshot (issue_id, observed_at);`,
]

export function openDb(path: string, busyTimeoutMs = 5000): DatabaseSync {
  const db = new DatabaseSync(path)
  // busy_timeout: Litestream's checkpoints briefly lock the WAL, so writers must wait, not fail.
  // It is set first so the journal_mode switch below, which also takes a lock, waits too.
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`)
  migrate(db)
  return db
}

export function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined
  const current = row?.user_version ?? 0
  if (current > MIGRATIONS.length) {
    throw new Error(
      `database schema version ${current} is newer than this build supports (${MIGRATIONS.length}); refusing to start`,
    )
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    const sql = MIGRATIONS[v]
    if (sql === undefined) throw new Error(`missing migration ${v}`)
    db.exec('BEGIN')
    try {
      db.exec(sql)
      // user_version cannot be bound as a parameter; v is an integer we control.
      db.exec(`PRAGMA user_version = ${v + 1}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
}
