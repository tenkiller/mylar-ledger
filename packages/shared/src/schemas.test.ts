import { describe, expect, it } from 'vitest'
import { copySchema, issueSchema, seriesSchema } from './schemas.ts'
import { fromTimestamp, toTimestamp } from './time.ts'
import { uuidv7 } from './uuid.ts'

const row = (over: Record<string, unknown>) => ({
  id: uuidv7(),
  title: 'Saga',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

describe('timestamps', () => {
  it('accepts fixed-width UTC timestamps', () => {
    expect(seriesSchema.safeParse(row({ deletedAt: '2026-02-01T00:00:00.000Z' })).success).toBe(true)
  })

  it.each([
    ['no milliseconds', '2026-01-01T00:00:00Z'],
    ['extra precision', '2026-01-01T00:00:00.000000Z'],
    ['offset instead of Z', '2026-01-01T00:00:00.000+02:00'],
    ['date only', '2026-01-01'],
  ])('rejects %s, so string order stays chronological', (_n, value) => {
    expect(seriesSchema.safeParse(row({ updatedAt: value })).success).toBe(false)
  })

  it('requires createdAt', () => {
    expect(seriesSchema.safeParse(row({ createdAt: undefined })).success).toBe(false)
  })

  it('round-trips and sorts as strings', () => {
    expect(fromTimestamp(toTimestamp(1_700_000_000_123))).toBe(1_700_000_000_123)
    expect(toTimestamp(999) < toTimestamp(1000)).toBe(true)
  })
})

describe('calendar dates', () => {
  const stamps = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
  const issue = (coverDate: string) =>
    issueSchema.safeParse({
      id: uuidv7(),
      seriesId: uuidv7(),
      number: '1',
      metadataStatus: 'pending',
      coverDate,
      ...stamps,
    }).success
  const copy = (purchaseDate: string) =>
    copySchema.safeParse({ id: uuidv7(), issueId: uuidv7(), purchaseDate, ...stamps }).success

  it.each(['2012', '2012-03', '2012-03-01', '2024-02-29', '1938-06'])('coverDate accepts %s', (d) => {
    expect(issue(d)).toBe(true)
  })

  it.each([
    '2012-13',
    '2012-00',
    '2012-02-30',
    '2023-02-29',
    '2012-04-31',
    '2012-03-00',
    '12',
    '0999',
    '2012-3',
    '2012-03-1',
    'Spring 2012',
    '2012-03-01T00:00:00Z',
  ])('coverDate rejects %s', (d) => {
    expect(issue(d)).toBe(false)
  })

  it('purchaseDate requires a full real date', () => {
    expect(copy('2020-01-02')).toBe(true)
    for (const d of ['2020', '2020-01', '2020-02-30', 'yesterday']) expect(copy(d)).toBe(false)
  })
})
