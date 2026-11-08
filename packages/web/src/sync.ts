import {
  mutationSchema,
  pullResponseSchema,
  pushResponseSchema,
  tableNames,
  MAX_PUSH_BATCH,
  type Mutation,
} from '@mylar/shared'
import type { MylarDb } from './db.ts'

export class SyncAuthError extends Error {
  constructor() {
    super('not authenticated')
    this.name = 'SyncAuthError'
  }
}

/** The server refused the request. `code` is the server's machine-readable reason, if any. */
export class SyncRejectedError extends Error {
  readonly status: number
  readonly code: string | undefined
  constructor(status: number, code: string | undefined) {
    super(code ? `server rejected sync: ${code}` : `server rejected sync: HTTP ${status}`)
    this.name = 'SyncRejectedError'
    this.status = status
    this.code = code
  }
}

export interface SyncResult {
  pushed: number
  pulled: number
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

/** Bounds how long one call keeps chasing writes that land mid-sync. */
const MAX_ROUNDS = 5

const inFlight = new WeakMap<MylarDb, Promise<SyncResult>>()
const rerun = new WeakSet<MylarDb>()

/**
 * Push the outbox, then pull. Outbox rows are deleted only after the server acknowledges them, so
 * any failure (offline, 4xx/5xx, expired session) leaves queued writes intact for the next attempt.
 * A request that arrives while a sync is running is coalesced, but flags another round so a write
 * made mid-sync is not left waiting for the next trigger.
 */
export function syncOnce(db: MylarDb, fetchFn: FetchFn = fetch): Promise<SyncResult> {
  const running = inFlight.get(db)
  if (running) {
    rerun.add(db)
    return running
  }
  const p = run(db, fetchFn).finally(() => {
    inFlight.delete(db)
    rerun.delete(db)
  })
  inFlight.set(db, p)
  return p
}

async function run(db: MylarDb, fetchFn: FetchFn): Promise<SyncResult> {
  let pushed = 0
  let pulled = 0
  for (let round = 0; round < MAX_ROUNDS; round++) {
    rerun.delete(db)
    // Pull runs even if push fails, so a stuck outbox entry cannot also block incoming changes.
    let pushError: Error | undefined
    try {
      pushed += await push(db, fetchFn)
    } catch (err) {
      pushError = err instanceof Error ? err : new Error(String(err))
    }
    const result = await pull(db, fetchFn).catch((err: unknown) => {
      if (pushError === undefined) throw err
      return { count: 0, reset: false }
    })
    if (pushError !== undefined) throw pushError
    pulled += result.count
    if (!result.reset && !rerun.has(db) && (await db.outbox.count()) === 0) break
  }
  return { pushed, pulled }
}

async function check(res: Response): Promise<Response> {
  if (res.status === 401) throw new SyncAuthError()
  if (!res.ok) throw new SyncRejectedError(res.status, await errorCode(res))
  return res
}

async function errorCode(res: Response): Promise<string | undefined> {
  try {
    const body: unknown = await res.json()
    if (typeof body === 'object' && body !== null && 'error' in body) {
      return typeof body.error === 'string' ? body.error : undefined
    }
  } catch {
    // Non-JSON error body: fall back to the HTTP status.
  }
  return undefined
}

async function push(db: MylarDb, fetchFn: FetchFn): Promise<number> {
  let total = 0
  for (;;) {
    const batch = await db.outbox.orderBy('id').limit(MAX_PUSH_BATCH).toArray()
    if (batch.length === 0) return total
    const res = await check(
      await fetchFn('/sync/push', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mutations: batch.map((e) => e.mutation) }),
      }),
    )
    pushResponseSchema.parse(await res.json())
    await db.outbox.bulkDelete(batch.flatMap((e) => (e.id === undefined ? [] : [e.id])))
    total += batch.length
  }
}

async function pull(db: MylarDb, fetchFn: FetchFn): Promise<{ count: number; reset: boolean }> {
  let total = 0
  let since = (await db.syncState.get('cursor'))?.seq ?? 0
  for (;;) {
    const res = await check(await fetchFn(`/sync/pull?since=${since}`))
    const page = pullResponseSchema.parse(await res.json())
    const state = await db.syncState.get('cursor')
    const replaced = state?.instanceId !== undefined && state.instanceId !== page.instanceId
    if (replaced || since > page.serverSeq) {
      // The server was reset or restored from older data: our cursor means nothing there, and it
      // may be missing rows we hold. Re-queue everything; the next round pushes it all (idempotent).
      await requeueEverything(db)
      return { count: total, reset: true }
    }
    await db.transaction('rw', [...tables(db), db.syncState], async () => {
      for (const { mutation } of page.changes) await applyRemote(db, mutation)
      await db.syncState.put({ key: 'cursor', seq: page.nextSeq, instanceId: page.instanceId })
    })
    total += page.changes.length
    since = page.nextSeq
    if (!page.hasMore) return { count: total, reset: false }
  }
}

async function requeueEverything(db: MylarDb): Promise<void> {
  await db.transaction('rw', [...tables(db), db.outbox, db.syncState], async () => {
    await db.outbox.clear()
    for (const name of tableNames) {
      const rows = await db.synced(name).toArray()
      await db.outbox.bulkAdd(
        rows.map((record) => ({ mutation: mutationSchema.parse({ table: name, record }) })),
      )
    }
    await db.syncState.clear()
  })
}

function tables(db: MylarDb) {
  return [db.series, db.issue, db.copy, db.price_snapshot]
}

async function applyRemote(db: MylarDb, m: Mutation): Promise<void> {
  const t = db.synced(m.table)
  const local = await t.get(m.record.id)
  if (local && local.updatedAt >= m.record.updatedAt) return
  await t.put(m.record)
}
