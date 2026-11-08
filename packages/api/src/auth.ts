import { createHash, randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { fromTimestamp, loginRequestSchema, toTimestamp } from '@mylar/shared'
import { rateLimitKey, type ClientIpResolver } from './clientip.ts'
import { passwordFingerprint, verifyPassword } from './password.ts'

const COOKIE = 'session'
const DAY_MS = 86_400_000
export const SESSION_TTL_MS = 90 * DAY_MS
export const SESSION_MAX_AGE_MS = 365 * DAY_MS
/** `last_seen` (and the cookie) are refreshed at most this often, so reads do not write. */
const SLIDE_AFTER_MS = DAY_MS

export const IP_LIMIT = { max: 5, windowMs: 15 * 60_000 }
export const GLOBAL_LIMIT = { max: 30, windowMs: 60 * 60_000 }
/** Each scrypt run holds ~32 MiB; unbounded parallel logins would OOM a small machine. */
const MAX_CONCURRENT_VERIFY = 2
const LOGIN_BODY_LIMIT_BYTES = 1024

interface SessionRow {
  created_at: string
  last_seen_at: string
  expires_at: string
  password_fp: string
}

export interface AuthDeps {
  db: DatabaseSync
  passwordHash: string
  now: () => number
  clientIp: ClientIpResolver
}

export interface Auth {
  requireAuth: MiddlewareHandler
  routes: Hono
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

export function createAuth({ db, passwordHash, now, clientIp }: AuthDeps): Auth {
  const fingerprint = passwordFingerprint(passwordHash)
  let verifying = 0

  const setSessionCookie = (c: Context, token: string, maxAgeSeconds: number): void => {
    setCookie(c, COOKIE, token, {
      prefix: 'host',
      secure: true,
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
      maxAge: maxAgeSeconds,
    })
  }

  function createSession(): { token: string; maxAgeSeconds: number } {
    const token = randomBytes(32).toString('base64url')
    const nowMs = now()
    // Only a hash is stored, so a leaked database does not leak usable sessions.
    db.prepare(
      `INSERT INTO session (id_hash, created_at, last_seen_at, expires_at, password_fp)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      sha256(token),
      toTimestamp(nowMs),
      toTimestamp(nowMs),
      toTimestamp(nowMs + SESSION_TTL_MS),
      fingerprint,
    )
    return { token, maxAgeSeconds: SESSION_TTL_MS / 1000 }
  }

  /** Returns whether the session is valid, and a new cookie lifetime when it was just extended. */
  function checkSession(token: string): { reissueSeconds?: number } | undefined {
    const id = sha256(token)
    const row = db
      .prepare(
        'SELECT created_at, last_seen_at, expires_at, password_fp FROM session WHERE id_hash = ?',
      )
      .get(id) as SessionRow | undefined
    if (!row) return undefined
    const nowMs = now()
    // A rotated password invalidates every session issued under the old one.
    if (row.password_fp !== fingerprint || row.expires_at <= toTimestamp(nowMs)) {
      db.prepare('DELETE FROM session WHERE id_hash = ?').run(id)
      return undefined
    }
    if (nowMs - fromTimestamp(row.last_seen_at) < SLIDE_AFTER_MS) return {}
    const expiresMs = Math.min(
      nowMs + SESSION_TTL_MS,
      fromTimestamp(row.created_at) + SESSION_MAX_AGE_MS,
    )
    db.prepare('UPDATE session SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?').run(
      toTimestamp(nowMs),
      toTimestamp(expiresMs),
      id,
    )
    // The browser enforces Max-Age, so the cookie must be re-issued or it would expire at 90 days
    // from login while the server still considers the session valid.
    return { reissueSeconds: Math.max(1, Math.floor((expiresMs - nowMs) / 1000)) }
  }

  function waitSeconds(times: readonly string[], limit: { max: number; windowMs: number }): number {
    if (times.length < limit.max) return 0
    const oldestCounted = times[times.length - limit.max]
    if (oldestCounted === undefined) return 0
    return fromTimestamp(oldestCounted) + limit.windowMs - now()
  }

  /** Seconds until another attempt is allowed; 0 means allowed. Checked before any scrypt work. */
  function retryAfterSeconds(ip: string): number {
    const nowMs = now()
    db.prepare('DELETE FROM login_failure WHERE at <= ?').run(
      toTimestamp(nowMs - GLOBAL_LIMIT.windowMs),
    )
    const rows = (sql: string, ...args: string[]): string[] =>
      (db.prepare(sql).all(...args) as { at: string }[]).map((r) => r.at)
    const perIp = rows(
      'SELECT at FROM login_failure WHERE ip = ? AND at > ? ORDER BY at',
      ip,
      toTimestamp(nowMs - IP_LIMIT.windowMs),
    )
    const global = rows('SELECT at FROM login_failure ORDER BY at')
    const waitMs = Math.max(waitSeconds(perIp, IP_LIMIT), waitSeconds(global, GLOBAL_LIMIT))
    return waitMs > 0 ? Math.max(1, Math.ceil(waitMs / 1000)) : 0
  }

  const requireAuth: MiddlewareHandler = async (c, next) => {
    const token = getCookie(c, COOKIE, 'host')
    const session = token === undefined ? undefined : checkSession(token)
    if (token === undefined || !session) return c.json({ error: 'unauthorized' }, 401)
    if (session.reissueSeconds !== undefined) setSessionCookie(c, token, session.reissueSeconds)
    await next()
  }

  const routes = new Hono()

  routes.use(
    '/login',
    bodyLimit({
      maxSize: LOGIN_BODY_LIMIT_BYTES,
      onError: (c) => c.json({ error: 'payload_too_large' }, 413),
    }),
  )

  routes.post('/login', async (c) => {
    if (!c.req.header('content-type')?.toLowerCase().startsWith('application/json')) {
      return c.json({ error: 'unsupported_media_type' }, 415)
    }
    const parsed = loginRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)

    const ip = rateLimitKey(clientIp(c))
    const wait = retryAfterSeconds(ip)
    if (wait > 0) {
      c.header('Retry-After', String(wait))
      return c.json({ error: 'too_many_attempts' }, 429)
    }
    if (verifying >= MAX_CONCURRENT_VERIFY) {
      c.header('Retry-After', '1')
      return c.json({ error: 'busy' }, 503)
    }

    verifying += 1
    let ok: boolean
    try {
      ok = await verifyPassword(parsed.data.password, passwordHash)
    } finally {
      verifying -= 1
    }

    if (!ok) {
      db.prepare('INSERT INTO login_failure (ip, at) VALUES (?, ?)').run(ip, toTimestamp(now()))
      return c.json({ error: 'invalid_credentials' }, 401)
    }
    db.prepare('DELETE FROM login_failure WHERE ip = ?').run(ip)
    db.prepare('DELETE FROM session WHERE expires_at <= ?').run(toTimestamp(now()))
    const session = createSession()
    setSessionCookie(c, session.token, session.maxAgeSeconds)
    return c.json({ authenticated: true })
  })

  routes.post('/logout', (c) => {
    const token = getCookie(c, COOKIE, 'host')
    if (token !== undefined) db.prepare('DELETE FROM session WHERE id_hash = ?').run(sha256(token))
    deleteCookie(c, COOKIE, { prefix: 'host', secure: true, path: '/' })
    return c.json({ authenticated: false })
  })

  routes.get('/session', requireAuth, (c) => c.json({ authenticated: true }))

  return { requireAuth, routes }
}
