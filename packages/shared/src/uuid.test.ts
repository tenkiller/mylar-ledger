import { describe, expect, it } from 'vitest'
import { uuidv7 } from './uuid.ts'

describe('uuidv7', () => {
  it('has version 7 and RFC variant bits', () => {
    const u = uuidv7()
    expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('encodes the timestamp in the prefix, so ids sort by time', () => {
    const a = uuidv7(1_700_000_000_000)
    const b = uuidv7(1_700_000_000_001)
    const c = uuidv7(1_800_000_000_000)
    expect([c, b, a].sort()).toEqual([a, b, c])
    expect(a.replace('-', '').slice(0, 12)).toBe((1_700_000_000_000).toString(16).padStart(12, '0'))
  })
})
