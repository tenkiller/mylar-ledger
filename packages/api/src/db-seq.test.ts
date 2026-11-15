import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from './db.ts'
import { readSeq } from './db-seq.ts'

let dir = ''
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('readSeq', () => {
  it('reads the global counter', () => {
    dir = mkdtempSync(join(tmpdir(), 'seq-'))
    const path = join(dir, 'a.sqlite')
    const db = openDb(path)
    db.exec('UPDATE seq_counter SET value = 42 WHERE id = 1')
    db.close()
    expect(readSeq(path)).toBe(42)
  })

  it('returns 0 for a database without the counter table', () => {
    dir = mkdtempSync(join(tmpdir(), 'seq-'))
    const path = join(dir, 'b.sqlite')
    new DatabaseSync(path).close()
    expect(readSeq(path)).toBe(0)
  })
})
