import type { DatabaseSync } from 'node:sqlite'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { pullQuerySchema, pushRequestSchema, toTimestamp } from '@mylar/shared'
import { applyMutations, pullChanges } from './sync.ts'

export const DEFAULT_ALLOWED_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]']
/** A device clock further ahead than this would freeze rows under last-write-wins. */
export const MAX_CLOCK_AHEAD_MS = 5 * 60_000
export const MAX_PUSH_BYTES = 4 * 1024 * 1024

export interface AppOptions {
  /** Hostnames (no port) the server answers to; anything else is rejected (DNS rebinding). */
  allowedHosts?: readonly string[]
  now?: () => number
  /** Directory of the built web app to serve, with SPA fallback to its index.html. */
  webDist?: string
}

export function createApp(db: DatabaseSync, options: AppOptions = {}): Hono {
  const hosts = new Set(options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS)
  const now = options.now ?? Date.now
  const app = new Hono()

  app.use('*', async (c, next) => {
    const url = new URL(c.req.url)
    if (!hosts.has(url.hostname)) return c.json({ error: 'forbidden_host' }, 403)
    const origin = c.req.header('origin')
    if (origin !== undefined && originHost(origin) !== url.host) {
      return c.json({ error: 'forbidden_origin' }, 403)
    }
    await next()
  })

  app.get('/healthz', (c) => {
    db.prepare('SELECT 1').get()
    return c.json({ ok: true })
  })

  app.use(
    '/sync/push',
    bodyLimit({
      maxSize: MAX_PUSH_BYTES,
      onError: (c) => c.json({ error: 'payload_too_large' }, 413),
    }),
  )

  app.post('/sync/push', async (c) => {
    // Requiring JSON forces a CORS preflight for cross-site callers, which we never approve.
    if (!c.req.header('content-type')?.toLowerCase().startsWith('application/json')) {
      return c.json({ error: 'unsupported_media_type' }, 415)
    }
    const body: unknown = await c.req.json().catch(() => null)
    const parsed = pushRequestSchema.safeParse(body)
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
    const latest = toTimestamp(now() + MAX_CLOCK_AHEAD_MS)
    if (parsed.data.mutations.some((m) => m.record.updatedAt > latest)) {
      return c.json({ error: 'timestamp_in_future' }, 400)
    }
    return c.json(applyMutations(db, parsed.data.mutations))
  })

  app.get('/sync/pull', (c) => {
    const parsed = pullQuerySchema.safeParse(c.req.query())
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
    return c.json(pullChanges(db, parsed.data.since, parsed.data.limit))
  })

  if (options.webDist !== undefined) {
    const root = options.webDist
    app.use('/*', serveStatic({ root }))
    app.get(
      '*',
      async (c, next) => {
        // Only extensionless, non-API paths are SPA routes. A missing asset must 404: serving
        // index.html there would let the service worker cache HTML under a script URL.
        const { pathname } = new URL(c.req.url)
        const last = pathname.split('/').pop() ?? ''
        if (
          last.includes('.') ||
          pathname.startsWith('/assets/') ||
          pathname.startsWith('/sync/')
        ) {
          return c.notFound()
        }
        await next()
      },
      serveStatic({ path: `${root}/index.html` }),
    )
  }

  return app
}

function originHost(origin: string): string | undefined {
  try {
    return new URL(origin).host
  } catch {
    return undefined
  }
}
