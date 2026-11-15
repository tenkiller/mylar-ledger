import { describe, expect, it } from 'vitest'
import { uuidv7, type Mutation } from '@mylar/shared'
import { SINGLE_USER_ID as userId } from './app.ts'
import { openDb } from './db.ts'
import { applyMutations, COLUMNS, pullChanges } from './sync.ts'
import { tableNames } from '@mylar/shared'

const base = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' }
const seriesId = uuidv7()
const issueId = uuidv7()

const full: Mutation[] = [
  {
    table: 'series',
    record: {
      ...base,
      id: seriesId,
      title: 'Saga',
      publisher: 'Image',
      startYear: 2012,
      comicvineId: 49104,
    },
  },
  {
    table: 'issue',
    record: {
      ...base,
      id: issueId,
      seriesId,
      number: '1',
      coverDate: '2012-03-01',
      variant: 'B',
      barcode: '70985301176000111',
      coverUrl: 'https://example.com/c.jpg',
      comicvineId: 1,
      metadataStatus: 'resolved',
    },
  },
  {
    table: 'copy',
    record: {
      ...base,
      id: uuidv7(),
      issueId,
      conditionGrade: 'NM',
      numericGrade: 9.4,
      gradedBy: 'CGC',
      slabCert: '123',
      purchasePriceCents: 1999,
      purchaseDate: '2020-01-02',
      location: 'Box 3',
      notes: 'signed',
    },
  },
  {
    table: 'price_snapshot',
    record: {
      ...base,
      id: uuidv7(),
      issueId,
      copyId: uuidv7(),
      grade: 'NM',
      valueCents: 4500,
      source: 'manual',
      observedAt: '2026-03-01T00:00:00.000Z',
      note: 'ebay avg',
    },
  },
]

const minimal: Mutation[] = [
  { table: 'series', record: { ...base, id: uuidv7(), title: 'Bare' } },
  {
    table: 'issue',
    record: { ...base, id: uuidv7(), seriesId, number: '2', metadataStatus: 'pending' },
  },
  { table: 'copy', record: { ...base, id: uuidv7(), issueId } },
  {
    table: 'price_snapshot',
    record: {
      ...base,
      id: uuidv7(),
      issueId,
      valueCents: 0,
      source: 'manual',
      observedAt: '2026-03-01T00:00:00.000Z',
    },
  },
]

describe('per-table storage', () => {
  it.each([
    ['fully populated', full],
    ['required fields only', minimal],
  ])('round-trips every table (%s)', (_name, mutations) => {
    const db = openDb(':memory:')
    expect(applyMutations(db, userId, mutations).applied).toBe(4)
    const out = pullChanges(db, userId, 0, 100)
    expect(out.changes.map(x => x.mutation)).toEqual(mutations)
    expect(out.changes.map(x => x.seq)).toEqual([1, 2, 3, 4])
  })

  it('keeps one global seq ordering across tables', () => {
    const db = openDb(':memory:')
    applyMutations(db, userId, full)
    const page1 = pullChanges(db, userId, 0, 3)
    expect(page1.hasMore).toBe(true)
    const page2 = pullChanges(db, userId, page1.nextSeq, 3)
    expect([...page1.changes, ...page2.changes].map(x => x.mutation.table)).toEqual([
      'series',
      'issue',
      'copy',
      'price_snapshot',
    ])
  })

  it('stores typed columns rather than a blob', () => {
    const db = openDb(':memory:')
    applyMutations(db, userId, full)
    const row = db.prepare('SELECT title, start_year FROM series').get()
    expect(row).toEqual({ title: 'Saga', start_year: 2012 })
  })

  it('keeps the COLUMNS map in sync with the real schema', () => {
    const db = openDb(':memory:')
    for (const table of tableNames) {
      const actual = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
        .map(r => r.name)
        .filter(n => !['id', 'user_id', 'created_at', 'updated_at', 'deleted_at', 'seq'].includes(n))
        .sort()
      expect(COLUMNS[table].map(x => x.column).sort()).toEqual(actual)
    }
  })
})
