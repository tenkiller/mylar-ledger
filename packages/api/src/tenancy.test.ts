import { describe, expect, it } from 'vitest'
import { toTimestamp, uuidv7, type Mutation } from '@mylar/shared'
import { openDb } from './db.ts'
import { applyMutations, currentSeq, pullChanges } from './sync.ts'

// BRE-6: these target the per-user signatures (db, userId, ...) and fail until they exist.
const alice = 'user-alice'
const bob = 'user-bob'

const series = (id: string, title: string, ms: number, deletedAt?: string): Mutation => ({
  table: 'series',
  record: {
    id,
    title,
    createdAt: toTimestamp(0),
    updatedAt: toTimestamp(ms),
    ...(deletedAt ? { deletedAt } : {}),
  },
})

const issueId = uuidv7()

const snapshot = (id: string, ms: number, deletedAt?: string): Mutation => ({
  table: 'price_snapshot',
  record: {
    id,
    issueId,
    valueCents: 100,
    source: 'manual',
    observedAt: toTimestamp(0),
    createdAt: toTimestamp(0),
    updatedAt: toTimestamp(ms),
    ...(deletedAt ? { deletedAt } : {}),
  },
})

describe('tenant isolation', () => {
  it("does not return one user's rows to another", () => {
    const db = openDb(':memory:')
    applyMutations(db, alice, [series(uuidv7(), 'Saga', 1000)])
    const out = pullChanges(db, bob, 0, 100)
    expect(out.changes).toEqual([])
    expect(out.serverSeq).toBe(0)
  })

  it("keeps a colliding id as a separate row and leaves the owner's row unchanged", () => {
    const db = openDb(':memory:')
    const id = uuidv7()
    applyMutations(db, alice, [series(id, 'Saga', 1000)])
    // Newer updatedAt: under the old `ON CONFLICT (id)` this would overwrite Alice's row.
    expect(applyMutations(db, bob, [series(id, 'Hijacked', 2000)]).applied).toBe(1)

    const a = pullChanges(db, alice, 0, 100).changes.map(x => x.mutation)
    const b = pullChanges(db, bob, 0, 100).changes.map(x => x.mutation)
    expect(a).toEqual([series(id, 'Saga', 1000)])
    expect(b).toEqual([series(id, 'Hijacked', 2000)])
  })

  it("does not let one user's LWW check see another user's newer row", () => {
    const db = openDb(':memory:')
    const id = uuidv7()
    applyMutations(db, alice, [series(id, 'Saga', 5000)])
    // Older than Alice's row, but Bob has no row, so it must apply.
    expect(applyMutations(db, bob, [series(id, 'Bob copy', 1000)]).applied).toBe(1)
  })

  it("does not let one user tombstone another user's price snapshot", () => {
    const db = openDb(':memory:')
    const id = uuidv7()
    applyMutations(db, alice, [snapshot(id, 1000)])
    applyMutations(db, bob, [snapshot(id, 2000, toTimestamp(2000))])

    const a = pullChanges(db, alice, 0, 100).changes.map(x => x.mutation)
    expect(a).toEqual([snapshot(id, 1000)])
  })

  it('numbers seq per user and reports a per-user serverSeq', () => {
    const db = openDb(':memory:')
    applyMutations(db, alice, [series(uuidv7(), 'A1', 1000), series(uuidv7(), 'A2', 1000)])
    applyMutations(db, bob, [series(uuidv7(), 'B1', 1000)])

    expect(pullChanges(db, alice, 0, 100).changes.map(x => x.seq)).toEqual([1, 2])
    expect(pullChanges(db, bob, 0, 100).changes.map(x => x.seq)).toEqual([1])
    expect(currentSeq(db, alice)).toBe(2)
    expect(currentSeq(db, bob)).toBe(1)
    expect(currentSeq(db, 'user-nobody')).toBe(0)
  })

  it("rolls back only the pushing user's batch", () => {
    const db = openDb(':memory:')
    applyMutations(db, alice, [series(uuidv7(), 'Saga', 1000)])
    // A malformed record makes the batch throw; Alice's committed state must be intact.
    const bad = { table: 'series', record: { id: uuidv7() } } as unknown as Mutation
    expect(() => applyMutations(db, bob, [series(uuidv7(), 'ok', 1000), bad])).toThrow()
    expect(currentSeq(db, bob)).toBe(0)
    expect(currentSeq(db, alice)).toBe(1)
  })
})
