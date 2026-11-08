import { beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import {
  toTimestamp,
  uuidv7,
  type Mutation,
  type PriceSnapshot,
  type PullResponse,
  type PushResponse,
  type Series,
} from '@mylar/shared'
import { createApp } from './app.ts'
import { openDb } from './db.ts'
import { applyMutations, currentSeq } from './sync.ts'

const JSON_HEADERS = { 'content-type': 'application/json' }
const NOW = Date.parse('2026-06-01T00:00:00.000Z')

let db: DatabaseSync
let app: ReturnType<typeof createApp>

const series = (over: Partial<Series> = {}, ms = 100): Mutation => ({
  table: 'series',
  record: {
    id: uuidv7(),
    title: 'Saga',
    createdAt: toTimestamp(0),
    updatedAt: toTimestamp(ms),
    ...over,
  },
})

const snapshot = (id: string, over: Partial<PriceSnapshot>): Mutation => ({
  table: 'price_snapshot',
  record: {
    id,
    issueId: uuidv7(),
    valueCents: 1000,
    source: 'manual',
    observedAt: toTimestamp(50),
    createdAt: toTimestamp(0),
    updatedAt: toTimestamp(100),
    ...over,
  },
})

const push = (mutations: unknown[], headers: Record<string, string> = JSON_HEADERS) =>
  app.request('/sync/push', { method: 'POST', headers, body: JSON.stringify({ mutations }) })

const pull = async (): Promise<PullResponse> =>
  (await (await app.request('/sync/pull?since=0')).json()) as PullResponse

beforeEach(() => {
  db = openDb(':memory:')
  app = createApp(db, { now: () => NOW })
})

describe('request boundary', () => {
  it('rejects non-JSON content types so cross-site simple requests cannot write', async () => {
    const res = await push([series()], { 'content-type': 'text/plain' })
    expect(res.status).toBe(415)
    expect((await pull()).changes).toHaveLength(0)
  })

  it('rejects hosts outside the allowlist (DNS rebinding)', async () => {
    const res = await app.request('http://evil.example/sync/pull?since=0')
    expect(res.status).toBe(403)
  })

  it('rejects a cross-origin Origin header, including "null"', async () => {
    for (const origin of ['http://evil.example', 'null']) {
      const res = await app.request('/healthz', { headers: { origin } })
      expect(res.status).toBe(403)
    }
    const same = await app.request('/healthz', { headers: { origin: 'http://localhost' } })
    expect(same.status).toBe(200)
  })

  it('honors a configured host allowlist', async () => {
    const custom = createApp(db, { allowedHosts: ['ledger.example.com'] })
    expect((await custom.request('https://ledger.example.com/healthz')).status).toBe(200)
    expect((await custom.request('http://localhost/healthz')).status).toBe(403)
  })

  it('rejects oversized bodies', async () => {
    const body = `{"mutations":[],"pad":"${'x'.repeat(5 * 1024 * 1024)}"}`
    const res = await app.request('/sync/push', { method: 'POST', headers: JSON_HEADERS, body })
    expect(res.status).toBe(413)
  })

  it('rejects overlong strings but accepts the maximum', async () => {
    expect((await push([series({ title: 'x'.repeat(501) })])).status).toBe(400)
    expect((await push([series({ title: 'x'.repeat(500) })])).status).toBe(200)
  })

  it('rejects batches over the batch limit', async () => {
    const batch = Array.from({ length: 201 }, () => series())
    expect((await push(batch)).status).toBe(400)
  })
})

describe('coverUrl scheme', () => {
  const issue = (coverUrl: string): Mutation => ({
    table: 'issue',
    record: {
      id: uuidv7(),
      seriesId: uuidv7(),
      number: '1',
      metadataStatus: 'pending',
      createdAt: toTimestamp(0),
      updatedAt: toTimestamp(1),
      coverUrl,
    },
  })

  it.each(['javascript:alert(1)', 'data:text/html,<script>1</script>', 'ftp://x.example/a.jpg'])(
    'rejects %s',
    async (url) => {
      expect((await push([issue(url)])).status).toBe(400)
    },
  )

  it.each(['https://example.com/c.jpg', 'http://example.com/c.jpg'])('accepts %s', async (url) => {
    expect((await push([issue(url)])).status).toBe(200)
  })
})

describe('clock skew guard', () => {
  it('rejects an updatedAt far ahead of server time and applies nothing', async () => {
    const ok = series({}, NOW)
    const bad = series({ updatedAt: toTimestamp(NOW + 6 * 60_000) })
    const res = await push([ok, bad])
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'timestamp_in_future' })
    expect((await pull()).changes).toHaveLength(0)
  })

  it('tolerates modest skew', async () => {
    const res = await push([series({ updatedAt: toTimestamp(NOW + 4 * 60_000) })])
    expect(res.status).toBe(200)
  })
})

describe('server identity', () => {
  it('reports a stable instance id and the current seq', async () => {
    await push([series()])
    const a = await pull()
    const b = await pull()
    expect(a.instanceId).toMatch(/^[0-9a-f]{32}$/)
    expect(b.instanceId).toBe(a.instanceId)
    expect(a.serverSeq).toBe(1)
  })

  it('gives each new database its own id', async () => {
    const other = createApp(openDb(':memory:'))
    const o = (await (await other.request('/sync/pull?since=0')).json()) as PullResponse
    expect(o.instanceId).not.toBe((await pull()).instanceId)
  })
})

describe('immutability rules', () => {
  const id = uuidv7()

  it('never changes a price snapshot once stored, except to tombstone it', async () => {
    await push([snapshot(id, {})])

    const edit = await push([snapshot(id, { valueCents: 9999, updatedAt: toTimestamp(200) })])
    expect(((await edit.json()) as PushResponse).applied).toBe(0)

    const tomb = await push([
      snapshot(id, { valueCents: 7777, updatedAt: toTimestamp(300), deletedAt: toTimestamp(300) }),
    ])
    expect(((await tomb.json()) as PushResponse).applied).toBe(1)

    const [change] = (await pull()).changes
    expect(change?.mutation.record).toMatchObject({
      valueCents: 1000,
      deletedAt: toTimestamp(300),
      updatedAt: toTimestamp(300),
    })

    const again = await push([
      snapshot(id, { updatedAt: toTimestamp(400), deletedAt: toTimestamp(400) }),
    ])
    expect(((await again.json()) as PushResponse).applied).toBe(0)
  })

  it('never overwrites createdAt on update', async () => {
    const m = series({ createdAt: toTimestamp(5) }, 100)
    await push([m])
    await push([
      { ...m, record: { ...m.record, createdAt: toTimestamp(9), updatedAt: toTimestamp(200) } },
    ])
    const [change] = (await pull()).changes
    expect(change?.mutation.record).toMatchObject({
      createdAt: toTimestamp(5),
      updatedAt: toTimestamp(200),
    })
  })
})

describe('transactions', () => {
  it('rolls back the whole batch and leaves seq untouched when one write fails', async () => {
    db.exec(
      `CREATE TRIGGER reject_boom BEFORE INSERT ON series WHEN NEW.title = 'boom'
       BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    )
    const batch = [
      series({ title: 'before' }),
      series({ title: 'boom' }),
      series({ title: 'after' }),
    ]
    expect(() => applyMutations(db, batch)).toThrow('boom')

    expect((await pull()).changes).toHaveLength(0)
    expect(currentSeq(db)).toBe(0)

    // The failed attempt must not wedge the connection or burn sequence numbers.
    const ok = await push([series({ title: 'fine' })])
    expect(((await ok.json()) as PushResponse).seq).toBe(1)
  })
})

describe('deletes under last-write-wins', () => {
  it('lets a later edit resurrect a tombstoned row (whole-row LWW, by design)', async () => {
    const m = series({}, 100)
    await push([m])
    await push([
      { ...m, record: { ...m.record, updatedAt: toTimestamp(200), deletedAt: toTimestamp(200) } },
    ])
    expect((await pull()).changes[0]?.mutation.record.deletedAt).toBe(toTimestamp(200))

    // A stale device that never saw the delete edits later, so its live copy wins.
    await push([{ ...m, record: { ...m.record, title: 'Edited', updatedAt: toTimestamp(300) } }])
    const record = (await pull()).changes[0]?.mutation.record
    expect(record?.deletedAt).toBeUndefined()
    expect(record).toMatchObject({ title: 'Edited' })
  })

  it('does not let an edit older than the tombstone resurrect the row', async () => {
    const m = series({}, 100)
    await push([m])
    await push([
      { ...m, record: { ...m.record, updatedAt: toTimestamp(300), deletedAt: toTimestamp(300) } },
    ])
    const stale = await push([
      { ...m, record: { ...m.record, title: 'Stale', updatedAt: toTimestamp(200) } },
    ])
    expect(((await stale.json()) as PushResponse).applied).toBe(0)
    expect((await pull()).changes[0]?.mutation.record.deletedAt).toBe(toTimestamp(300))
  })
})
