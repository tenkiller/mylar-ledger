import { beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import {
  toTimestamp,
  uuidv7,
  type Mutation,
  type PullResponse,
  type PushResponse,
} from '@mylar/shared'
import { createApp } from './app.ts'
import { openDb } from './db.ts'

let db: DatabaseSync
let app: ReturnType<typeof createApp>

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

async function push(mutations: Mutation[]): Promise<PushResponse> {
  const res = await app.request('/sync/push', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mutations }),
  })
  expect(res.status).toBe(200)
  return (await res.json()) as PushResponse
}

async function pull(since: number, limit?: number): Promise<PullResponse> {
  const q = limit === undefined ? `since=${since}` : `since=${since}&limit=${limit}`
  const res = await app.request(`/sync/pull?${q}`)
  expect(res.status).toBe(200)
  return (await res.json()) as PullResponse
}

beforeEach(() => {
  db = openDb(':memory:')
  app = createApp(db, { auth: { disabled: true } })
})

describe('sync', () => {
  it('round-trips a pushed record through pull', async () => {
    const id = uuidv7()
    const m = series(id, 'Saga', 100)
    expect(await push([m])).toEqual({ applied: 1, seq: 1 })
    const out = await pull(0)
    expect(out).toMatchObject({
      changes: [{ seq: 1, mutation: m }],
      nextSeq: 1,
      hasMore: false,
      serverSeq: 1,
    })
  })

  it('treats re-pushing the same mutation as a no-op', async () => {
    const m = series(uuidv7(), 'Saga', 100)
    await push([m])
    expect(await push([m])).toEqual({ applied: 0, seq: 1 })
    expect((await pull(0)).changes).toHaveLength(1)
  })

  it('keeps the newer write and drops an older one (LWW)', async () => {
    const id = uuidv7()
    await push([series(id, 'New', 200)])
    expect((await push([series(id, 'Old', 100)])).applied).toBe(0)
    const [change] = (await pull(0)).changes
    expect(change?.mutation).toEqual(series(id, 'New', 200))
  })

  it('replaces a record with a newer write and bumps its seq', async () => {
    const id = uuidv7()
    await push([series(id, 'v1', 100)])
    await push([series(id, 'v2', 200)])
    const out = await pull(1)
    expect(out.changes.map((c) => c.seq)).toEqual([2])
  })

  it('propagates tombstones', async () => {
    const id = uuidv7()
    await push([series(id, 'Gone', 100)])
    await push([series(id, 'Gone', 200, '2026-11-08T12:00:00.000Z')])
    const [change] = (await pull(0)).changes
    expect(change?.mutation.record.deletedAt).toBe('2026-11-08T12:00:00.000Z')
  })

  it('paginates pulls by limit and cursor', async () => {
    await push([1, 2, 3].map((n) => series(uuidv7(), `S${n}`, n)))
    const first = await pull(0, 2)
    expect(first).toMatchObject({ nextSeq: 2, hasMore: true })
    expect(first.changes).toHaveLength(2)
    const second = await pull(first.nextSeq, 2)
    expect(second).toMatchObject({ nextSeq: 3, hasMore: false })
    expect(second.changes).toHaveLength(1)
  })

  it('rejects malformed pushes and leaves state untouched', async () => {
    const res = await app.request('/sync/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mutations: [{ table: 'series', record: { id: 'nope' } }] }),
    })
    expect(res.status).toBe(400)
    expect((await pull(0)).changes).toHaveLength(0)
  })

  it('rejects an invalid pull limit', async () => {
    const res = await app.request('/sync/pull?since=0&limit=100000')
    expect(res.status).toBe(400)
  })

  it('reports healthy', async () => {
    const res = await app.request('/healthz')
    expect(await res.json()).toEqual({ ok: true })
  })
})
