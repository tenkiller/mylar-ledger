import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { openDb } from './db.ts'

describe('openDb', () => {
  it('waits on a locked WAL instead of failing (Litestream checkpoints hold brief locks)', () => {
    const db = openDb(':memory:')
    expect(db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 })
  })

  it('waits on a lock while switching to WAL, not only afterwards', () => {
    const dir = mkdtempSync(join(tmpdir(), 'db-'))
    const path = join(dir, 'locked.sqlite')
    const holder = new DatabaseSync(path)
    holder.exec('CREATE TABLE t (x); BEGIN EXCLUSIVE')
    const start = Date.now()
    try {
      expect(() => openDb(path, 300)).toThrow()
      expect(Date.now() - start).toBeGreaterThanOrEqual(250)
    } finally {
      holder.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('enforces foreign keys setting and applies migrations', () => {
    const db = openDb(':memory:')
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 })
  })
})
