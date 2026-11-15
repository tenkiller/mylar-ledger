import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { toTimestamp, uuidv7, type PriceSnapshot } from '@mylar/shared'
import { createApp } from '@mylar/api/app'
import { openDb } from '@mylar/api/db'
import { MylarDb } from './db.ts'
import { addSeries, deleteSeries, saveMutation } from './store.ts'
import { SyncAuthError, SyncRejectedError, syncOnce } from './sync.ts'

let n = 0
let server: ReturnType<typeof createApp>
let online = true

const fetchFn = (input: string, init?: RequestInit): Promise<Response> => {
  if (!online) return Promise.reject(new TypeError('network down'))
  return Promise.resolve(server.request(input, init))
}

const newDevice = () => new MylarDb(`test-${++n}`)

beforeEach(() => {
  server = createApp(openDb(':memory:'), { auth: { disabled: true } })
  online = true
})

describe('client sync', () => {
  it('pushes local writes and clears the outbox', async () => {
    const a = newDevice()
    await addSeries(a, { title: 'Saga', publisher: 'Image' })
    expect(await a.outbox.count()).toBe(1)
    expect(await syncOnce(a, fetchFn)).toMatchObject({ pushed: 1 })
    expect(await a.outbox.count()).toBe(0)
  })

  it('converges a second device, including tombstones', async () => {
    const a = newDevice()
    const b = newDevice()
    await addSeries(a, { title: 'Saga' })
    await addSeries(a, { title: 'Monstress' })
    await syncOnce(a, fetchFn)
    await syncOnce(b, fetchFn)
    expect((await b.series.toArray()).map(s => s.title).sort()).toEqual(['Monstress', 'Saga'])

    const saga = (await a.series.toArray()).find(s => s.title === 'Saga')
    await deleteSeries(a, saga?.id ?? '')
    await syncOnce(a, fetchFn)
    await syncOnce(b, fetchFn)
    expect((await b.series.toArray()).filter(s => s.deletedAt === undefined).map(s => s.title)).toEqual(['Monstress'])
  })

  it('keeps queued writes when offline and delivers them later', async () => {
    const a = newDevice()
    online = false
    await addSeries(a, { title: 'Offline add' })
    await expect(syncOnce(a, fetchFn)).rejects.toThrow('network down')
    expect(await a.outbox.count()).toBe(1)

    online = true
    await syncOnce(a, fetchFn)
    expect(await a.outbox.count()).toBe(0)
    const b = newDevice()
    await syncOnce(b, fetchFn)
    expect(await b.series.count()).toBe(1)
  })

  it('keeps queued writes on a 401 and surfaces SyncAuthError', async () => {
    const a = newDevice()
    await addSeries(a, { title: 'Queued' })
    const unauthorized = () => Promise.resolve(new Response('no', { status: 401 }))
    await expect(syncOnce(a, unauthorized)).rejects.toBeInstanceOf(SyncAuthError)
    expect(await a.outbox.count()).toBe(1)
  })

  it('lets the newer edit win across devices', async () => {
    const a = newDevice()
    const b = newDevice()
    await addSeries(a, { title: 'Original' }, 1000)
    await syncOnce(a, fetchFn)
    await syncOnce(b, fetchFn)

    const row = (await b.series.toArray())[0]
    if (!row) throw new Error('expected a row')
    // Device b edits later than device a's stale copy, through the real write path.
    await saveMutation(b, {
      table: 'series',
      record: { ...row, title: 'Edited on b', updatedAt: toTimestamp(5000) },
    })
    await syncOnce(b, fetchFn)
    await syncOnce(a, fetchFn)
    expect((await a.series.toArray())[0]?.title).toBe('Edited on b')
  })

  it('rejects an invalid record before it can reach the outbox', async () => {
    const a = newDevice()
    await expect(
      saveMutation(a, {
        table: 'series',
        record: {
          id: 'not-a-uuid',
          title: '',
          createdAt: toTimestamp(1),
          updatedAt: toTimestamp(1),
        },
      }),
    ).rejects.toThrow()
    expect(await a.outbox.count()).toBe(0)
    expect(await a.series.count()).toBe(0)
  })

  it('bumps updatedAt past the stored row when the clock runs behind', async () => {
    const a = newDevice()
    await addSeries(a, { title: 'v1' }, 5000)
    const row = (await a.series.toArray())[0]
    if (!row) throw new Error('expected a row')
    await saveMutation(a, {
      table: 'series',
      record: { ...row, title: 'v2', updatedAt: toTimestamp(1000) },
    })
    expect((await a.series.get(row.id))?.updatedAt).toBe(toTimestamp(5001))
    await syncOnce(a, fetchFn)
    const b = newDevice()
    await syncOnce(b, fetchFn)
    expect((await b.series.get(row.id))?.title).toBe('v2')
  })

  it('re-pushes everything when the server database was replaced', async () => {
    const a = newDevice()
    await addSeries(a, { title: 'Saga' })
    await addSeries(a, { title: 'Monstress' })
    await syncOnce(a, fetchFn)

    server = createApp(openDb(':memory:'), { auth: { disabled: true } })
    await syncOnce(a, fetchFn)

    const b = newDevice()
    await syncOnce(b, fetchFn)
    expect((await b.series.toArray()).map(s => s.title).sort()).toEqual(['Monstress', 'Saga'])
    expect(await a.outbox.count()).toBe(0)
  })

  it('recovers when the cursor is ahead of a restored server', async () => {
    const a = newDevice()
    for (const t of ['A', 'B', 'C']) await addSeries(a, { title: t })
    await syncOnce(a, fetchFn)
    const state = await a.syncState.get('cursor')
    await a.syncState.put({
      key: 'cursor',
      seq: 999,
      ...(state?.instanceId ? { instanceId: state.instanceId } : {}),
    })

    await syncOnce(a, fetchFn)
    expect((await a.syncState.get('cursor'))?.seq).toBe(3)
    const b = newDevice()
    await syncOnce(b, fetchFn)
    expect(await b.series.count()).toBe(3)
  })

  it('still pulls when push is rejected, and keeps the outbox', async () => {
    const a = newDevice()
    const b = newDevice()
    await addSeries(b, { title: 'From b' })
    await syncOnce(b, fetchFn)

    await addSeries(a, { title: 'Stuck' })
    const rejectPush = (input: string, init?: RequestInit) =>
      input === '/sync/push'
        ? Promise.resolve(Response.json({ error: 'invalid_request' }, { status: 400 }))
        : fetchFn(input, init)
    const err = await syncOnce(a, rejectPush).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SyncRejectedError)
    expect((err as SyncRejectedError).code).toBe('invalid_request')
    expect((await a.series.toArray()).map(s => s.title).sort()).toEqual(['From b', 'Stuck'])
    expect(await a.outbox.count()).toBe(1)
  })

  it('sends a write made while a sync is already running', async () => {
    const a = newDevice()
    await addSeries(a, { title: 'First' })
    let injected = false
    const writeDuringPull = async (input: string, init?: RequestInit) => {
      if (input.startsWith('/sync/pull') && !injected) {
        injected = true
        await addSeries(a, { title: 'During' })
        void syncOnce(a, fetchFn)
      }
      return fetchFn(input, init)
    }
    await syncOnce(a, writeDuringPull)
    expect(await a.outbox.count()).toBe(0)
    const b = newDevice()
    await syncOnce(b, fetchFn)
    expect((await b.series.toArray()).map(s => s.title).sort()).toEqual(['During', 'First'])
  })

  it('syncs more than one push batch and more than one pull page', async () => {
    const a = newDevice()
    for (let i = 0; i < 450; i++) await addSeries(a, { title: `S${i}` })
    expect(await syncOnce(a, fetchFn)).toMatchObject({ pushed: 450 })
    const b = newDevice()
    await syncOnce(b, fetchFn)
    expect(await b.series.count()).toBe(450)
  })

  it('surfaces a device clock that is ahead of the server', async () => {
    server = createApp(openDb(':memory:'), { auth: { disabled: true }, now: () => 0 })
    const a = newDevice()
    await addSeries(a, { title: 'Future' }, 60 * 60_000)
    const err = await syncOnce(a, fetchFn).catch((e: unknown) => e)
    expect((err as SyncRejectedError).code).toBe('timestamp_in_future')
    expect(await a.outbox.count()).toBe(1)
  })

  describe('price snapshots are append-only', () => {
    const snapshot = (): PriceSnapshot => ({
      id: uuidv7(),
      issueId: uuidv7(),
      valueCents: 1500,
      source: 'manual',
      observedAt: toTimestamp(10),
      createdAt: toTimestamp(10),
      updatedAt: toTimestamp(10),
    })

    it('rejects edits but allows a tombstone that keeps the stored content', async () => {
      const a = newDevice()
      const snap = snapshot()
      await saveMutation(a, { table: 'price_snapshot', record: snap })

      await expect(
        saveMutation(a, {
          table: 'price_snapshot',
          record: { ...snap, valueCents: 1, updatedAt: toTimestamp(20) },
        }),
      ).rejects.toThrow('append-only')

      await saveMutation(a, {
        table: 'price_snapshot',
        record: { ...snap, valueCents: 2, updatedAt: toTimestamp(30), deletedAt: toTimestamp(30) },
      })
      expect(await a.price_snapshot.get(snap.id)).toMatchObject({
        valueCents: 1500,
        deletedAt: toTimestamp(30),
      })
    })
  })

  it('keeps unsent entries queued when the server fails mid-push', async () => {
    const a = newDevice()
    for (let i = 0; i < 250; i++) await addSeries(a, { title: `S${i}` })
    let pushes = 0
    const failSecondPush = (input: string, init?: RequestInit) => {
      if (input === '/sync/push' && ++pushes === 2) {
        return Promise.resolve(new Response('boom', { status: 500 }))
      }
      return fetchFn(input, init)
    }
    const err = await syncOnce(a, failSecondPush).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SyncRejectedError)
    expect((err as SyncRejectedError).status).toBe(500)
    // The first batch of 200 was acknowledged and removed; the remaining 50 are still queued.
    expect(await a.outbox.count()).toBe(50)

    await syncOnce(a, fetchFn)
    expect(await a.outbox.count()).toBe(0)
    const b = newDevice()
    await syncOnce(b, fetchFn)
    expect(await b.series.count()).toBe(250)
  })

  it('coalesces concurrent sync calls into one run', async () => {
    const a = newDevice()
    await addSeries(a, { title: 'Only once' })
    let pushes = 0
    const counting = (input: string, init?: RequestInit) => {
      if (input === '/sync/push') pushes++
      return fetchFn(input, init)
    }
    const first = syncOnce(a, counting)
    const second = syncOnce(a, counting)
    expect(second).toBe(first)
    await first
    expect(pushes).toBe(1)
    expect(await a.outbox.count()).toBe(0)
  })

  it('does not let a delete clobber a concurrent edit to the same row', async () => {
    const a = newDevice()
    await addSeries(a, { title: 'Original' })
    const id = (await a.series.toArray())[0]?.id ?? ''

    // A read-modify-write edit, like a second tab would perform.
    const rename = (title: string) =>
      a.transaction('rw', a.series, a.outbox, async () => {
        const row = await a.series.get(id)
        if (!row) return
        await saveMutation(a, { table: 'series', record: { ...row, title } })
      })

    await Promise.all([deleteSeries(a, id), rename('Renamed')])
    const row = await a.series.get(id)
    expect(row?.title).toBe('Renamed')
    expect(row?.deletedAt).toBeDefined()
  })
})
