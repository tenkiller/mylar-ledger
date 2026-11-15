import 'fake-indexeddb/auto'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '@mylar/api/app'
import { openDb } from '@mylar/api/db'
import { hashPassword } from '@mylar/api/password'
import { login, logout } from './auth.ts'
import { MylarDb } from './db.ts'
import { addSeries } from './store.ts'
import { SyncAuthError, syncOnce, type FetchFn } from './sync.ts'

const PASSWORD = 'a sufficiently long passphrase'
let hash: string
let server: ReturnType<typeof createApp>
let n = 0

beforeAll(async () => {
  hash = await hashPassword(PASSWORD, { N: 2 ** 10, r: 8, p: 1 })
})

beforeEach(() => {
  server = createApp(openDb(':memory:'), { auth: { passwordHash: hash } })
})

const newDevice = () => new MylarDb(`auth-test-${++n}`)

/** A minimal cookie jar standing in for the browser, so the real cookie flow is exercised. */
function browser(): FetchFn {
  let session: string | undefined
  return async (input, init) => {
    const headers = new Headers(init?.headers)
    if (session) headers.set('cookie', session)
    const res = await server.request(input, { ...init, headers })
    for (const set of res.headers.getSetCookie()) {
      if (!set.startsWith('__Host-session=')) continue
      session = /Max-Age=0/.test(set) ? undefined : (set.split(';')[0] ?? undefined)
    }
    return res
  }
}

describe('sign-in flow', () => {
  it('keeps writes queued while signed out, then flushes them after login', async () => {
    const a = newDevice()
    const fetchFn = browser()
    await addSeries(a, { title: 'Written offline' })
    await addSeries(a, { title: 'Also offline' })

    const err = await syncOnce(a, fetchFn).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SyncAuthError)
    expect(await a.outbox.count()).toBe(2)

    expect(await login('wrong password', fetchFn)).toEqual({ ok: false, reason: 'invalid' })
    expect(await login(PASSWORD, fetchFn)).toEqual({ ok: true })

    expect(await syncOnce(a, fetchFn)).toMatchObject({ pushed: 2 })
    expect(await a.outbox.count()).toBe(0)

    // A second device with its own session sees the data.
    const b = newDevice()
    const other = browser()
    await login(PASSWORD, other)
    await syncOnce(b, other)
    expect((await b.series.toArray()).map((s) => s.title).sort()).toEqual(['Also offline', 'Written offline'])
  })

  it('requires signing in again after logout, without losing queued writes', async () => {
    const a = newDevice()
    const fetchFn = browser()
    await login(PASSWORD, fetchFn)
    await syncOnce(a, fetchFn)

    await logout(fetchFn)
    await addSeries(a, { title: 'After logout' })
    await expect(syncOnce(a, fetchFn)).rejects.toBeInstanceOf(SyncAuthError)
    expect(await a.outbox.count()).toBe(1)

    await login(PASSWORD, fetchFn)
    await syncOnce(a, fetchFn)
    expect(await a.outbox.count()).toBe(0)
  })

  it('reports rate limiting with a retry hint', async () => {
    const fetchFn = browser()
    for (let i = 0; i < 5; i++) await login('nope', fetchFn)
    const result = await login(PASSWORD, fetchFn)
    expect(result).toMatchObject({ ok: false, reason: 'rate_limited' })
    expect(result.ok ? 0 : result.retryAfterSeconds).toBeGreaterThan(0)
  })

  it('never sends an empty or oversized password to the server', async () => {
    let calls = 0
    const spy: FetchFn = (input, init) => {
      calls++
      return Promise.resolve(server.request(input, init))
    }
    expect(await login('', spy)).toEqual({ ok: false, reason: 'invalid' })
    expect(await login('x'.repeat(300), spy)).toEqual({ ok: false, reason: 'invalid' })
    expect(calls).toBe(0)
  })
})
