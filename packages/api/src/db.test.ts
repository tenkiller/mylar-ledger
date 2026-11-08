import { describe, expect, it } from 'vitest'
import { openDb } from './db.ts'

describe('openDb', () => {
  it('waits on a locked WAL instead of failing (Litestream checkpoints hold brief locks)', () => {
    const db = openDb(':memory:')
    expect(db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 })
  })

  it('enforces foreign keys setting and applies migrations', () => {
    const db = openDb(':memory:')
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 })
  })
})
