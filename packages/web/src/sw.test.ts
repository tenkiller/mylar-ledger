import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: FakeEvent) => void

interface FakeEvent {
  request?: { method: string; url: string; mode: string }
  respondWith?: (p: Promise<Response>) => void
  waitUntil: (p: Promise<unknown>) => void
}

const ORIGIN = 'http://localhost'
const SW_SOURCE = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8')

const keyOf = (r: string | { url: string }): string =>
  typeof r === 'string' ? new URL(r, ORIGIN).href : r.url

interface Harness {
  caches: Map<string, Map<string, Response>>
  fetchFn: ReturnType<typeof vi.fn<(r: unknown) => Promise<Response>>>
  fire(type: 'activate'): Promise<void>
  request(path: string, mode?: string, method?: string): Promise<Response | undefined>
}

function load(): Harness {
  const store = new Map<string, Map<string, Response>>()
  const handlers = new Map<string, Handler>()
  const fetchFn = vi.fn<(r: unknown) => Promise<Response>>()

  const cachesApi = {
    open: (name: string) => {
      const c = store.get(name) ?? new Map<string, Response>()
      store.set(name, c)
      return Promise.resolve({
        put: (r: { url: string }, res: Response) => {
          c.set(keyOf(r), res)
          return Promise.resolve()
        },
      })
    },
    match: (r: string | { url: string }) => {
      for (const c of store.values()) {
        const hit = c.get(keyOf(r))
        if (hit) return Promise.resolve(hit.clone())
      }
      return Promise.resolve(undefined)
    },
    keys: () => Promise.resolve([...store.keys()]),
    delete: (name: string) => Promise.resolve(store.delete(name)),
  }

  const self = {
    location: { origin: ORIGIN },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
    addEventListener: (type: string, fn: Handler) => handlers.set(type, fn),
  }

  runInNewContext(SW_SOURCE, {
    self,
    caches: cachesApi,
    fetch: fetchFn,
    URL,
    Response,
    Promise,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  })

  return {
    caches: store,
    fetchFn,
    async fire(type) {
      const pending: Promise<unknown>[] = []
      handlers.get(type)?.({ waitUntil: (p) => pending.push(p) })
      await Promise.all(pending)
    },
    async request(path, mode = 'no-cors', method = 'GET') {
      let responded: Promise<Response> | undefined
      handlers.get('fetch')?.({
        request: { method, url: new URL(path, ORIGIN).href, mode },
        respondWith: (p) => {
          responded = p
        },
        // waitUntil work is deliberately not awaited: the browser does not block the response on it.
        waitUntil: () => undefined,
      })
      return await responded
    },
  }
}

const seed = (h: Harness, path: string, body: string, cache = 'mylar-shell-v1') => {
  const c = h.caches.get(cache) ?? new Map<string, Response>()
  c.set(new URL(path, ORIGIN).href, new Response(body))
  h.caches.set(cache, c)
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('service worker fetch', () => {
  it('serves the cached copy when the network hangs past the timeout', async () => {
    const h = load()
    seed(h, '/app.js', 'cached')
    h.fetchFn.mockReturnValue(new Promise(() => undefined))
    const p = h.request('/app.js')
    // Let the handler register its timeout before the clock moves.
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(3000)
    expect(await (await p)?.text()).toBe('cached')
  })

  it('prefers a fast network response and refreshes the cache', async () => {
    const h = load()
    seed(h, '/app.js', 'cached')
    h.fetchFn.mockResolvedValue(new Response('fresh'))
    const res = await h.request('/app.js')
    expect(await res?.text()).toBe('fresh')
    await vi.advanceTimersByTimeAsync(0)
    expect(await h.caches.get('mylar-shell-v1')?.get(`${ORIGIN}/app.js`)?.text()).toBe('fresh')
  })

  it('does not cache failed responses', async () => {
    const h = load()
    h.fetchFn.mockResolvedValue(new Response('not found', { status: 404 }))
    const res = await h.request('/assets/gone.js')
    expect(res?.status).toBe(404)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.caches.get('mylar-shell-v1')?.has(`${ORIGIN}/assets/gone.js`) ?? false).toBe(false)
  })

  it('serves the cache when the network fails', async () => {
    const h = load()
    seed(h, '/app.js', 'cached')
    h.fetchFn.mockRejectedValue(new TypeError('offline'))
    expect(await (await h.request('/app.js'))?.text()).toBe('cached')
  })

  it('falls back to the cached shell for an unknown navigation when offline', async () => {
    const h = load()
    seed(h, '/', 'shell')
    h.fetchFn.mockRejectedValue(new TypeError('offline'))
    expect(await (await h.request('/some/deep/link', 'navigate'))?.text()).toBe('shell')
  })

  it('waits for the network when nothing is cached', async () => {
    const h = load()
    let resolve: (r: Response) => void = () => undefined
    h.fetchFn.mockReturnValue(new Promise<Response>((r) => (resolve = r)))
    const p = h.request('/new.js')
    await vi.advanceTimersByTimeAsync(10_000)
    resolve(new Response('late'))
    expect(await (await p)?.text()).toBe('late')
  })

  it('does not intercept sync calls, non-GETs or other origins', async () => {
    const h = load()
    expect(await h.request('/sync/pull?since=0')).toBeUndefined()
    expect(await h.request('/healthz')).toBeUndefined()
    expect(await h.request('/x', 'no-cors', 'POST')).toBeUndefined()
  })
})

describe('service worker activate', () => {
  it('deletes old caches and keeps the current one', async () => {
    const h = load()
    seed(h, '/a', 'a', 'mylar-shell-v0')
    seed(h, '/b', 'b', 'mylar-shell-v1')
    await h.fire('activate')
    expect([...h.caches.keys()]).toEqual(['mylar-shell-v1'])
  })
})
