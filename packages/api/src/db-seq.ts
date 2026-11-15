import { DatabaseSync } from 'node:sqlite'

/** Global change counter of a database file; 0 if the file has no counter yet. */
export function readSeq(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const row = db.prepare('SELECT value FROM seq_counter WHERE id = 1').get() as
      { value: number } | undefined
    return row?.value ?? 0
  } catch {
    return 0
  } finally {
    db.close()
  }
}

// Used by docker-entrypoint.sh to decide whether a restored replica is newer than the local file.
const path = process.argv[2]
if (process.argv[1]?.endsWith('db-seq.ts') && path) console.log(readSeq(path))
