import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { createApp } from './app.ts'
import { GLOBAL_LIMIT, IP_LIMIT, SESSION_MAX_AGE_MS, SESSION_TTL_MS } from './auth.ts'
import { openDb } from './db.ts'
import { hashPassword, verifyPassword, type ScryptParams } from './password.ts'

vi.mock('./password.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./password.ts')>()
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) }
})

const FAST: ScryptParams = { N: 2 ** 10, r: 8, p: 1 }
const PASSWORD = 'correct horse battery'
const DAY = 86_400_000
const START = Date.parse('2026-06-01T00:00:00.000Z')
const JSON_HEADERS = { 'content-type': 'application/json' }

let hash: string
let db: DatabaseSync
let app: ReturnType<typeof createApp>
let nowMs: number
let ip: string

beforeAll(async () => {
  hash = await hashPassword(PASSWORD, FAST)
})

beforeEach(() => {
  vi.mocked(verifyPassword).mockClear()
  db = openDb(':memory:')
  nowMs = START
  ip = '203.0.113.1'
  app = makeApp(hash)
})

function makeApp(passwordHash: string) {
  return createApp(db, {
    auth: { passwordHash },
    now: () => nowMs,
    clientIp: () => ip,
  })
}

const login = (password: string, headers: Record<string, string> = JSON_HEADERS) =>
  app.request('/auth/login', { method: 'POST', headers, body: JSON.stringify({ password }) })

const sessionCookie = (res: Response): string | undefined =>
  res.headers.getSetCookie().find((c) => c.startsWith('__Host-session='))

const cookieHeader = (setCookie: string): { cookie: string } => ({
  cookie: setCookie.split(';')[0] ?? '',
})

async function signIn(): Promise<{ cookie: string }> {
  const res = await login(PASSWORD)
  expect(res.status).toBe(200)
  const set = sessionCookie(res)
  if (!set) throw new Error('no session cookie')
  return cookieHeader(set)
}

const pull = (headers: Record<string, string> = {}) => app.request('/sync/pull?since=0', { headers })

describe('login and cookie', () => {
  it('sets a hardened host-prefixed session cookie', async () => {
    const res = await login(PASSWORD)
    expect(res.status).toBe(200)
    const set = sessionCookie(res) ?? ''
    expect(set).toMatch(/^__Host-session=[\w-]{40,};/)
    expect(set).toContain('HttpOnly')
    expect(set).toContain('Secure')
    expect(set).toContain('SameSite=Strict')
    expect(set).toContain('Path=/')
    expect(set).toContain(`Max-Age=${SESSION_TTL_MS / 1000}`)
    expect(set).not.toContain('Domain')
  })

  it('stores only a hash of the session token', async () => {
    const set = sessionCookie(await login(PASSWORD)) ?? ''
    const token = set.split(';')[0]?.split('=')[1] ?? ''
    const rows = db.prepare('SELECT id_hash FROM session').all() as { id_hash: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id_hash).not.toBe(token)
    expect(JSON.stringify(rows)).not.toContain(token)
  })

  it('rejects a wrong password without issuing a cookie', async () => {
    const res = await login('wrong')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'invalid_credentials' })
    expect(sessionCookie(res)).toBeUndefined()
  })

  it('validates the login request', async () => {
    expect((await login(PASSWORD, { 'content-type': 'text/plain' })).status).toBe(415)
    expect((await login('')).status).toBe(400)
    expect((await login('x'.repeat(257))).status).toBe(400)
    const big = await app.request('/auth/login', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ password: 'x'.repeat(2000) }),
    })
    expect(big.status).toBe(413)
    const notJson = await app.request('/auth/login', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: 'not json',
    })
    expect(notJson.status).toBe(400)
    expect(verifyPassword).not.toHaveBeenCalled()
  })
})

describe('protected routes', () => {
  it('rejects sync without a session, or with a bogus one', async () => {
    expect((await pull()).status).toBe(401)
    expect((await pull({ cookie: '__Host-session=bogus' })).status).toBe(401)
    const push = await app.request('/sync/push', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ mutations: [] }),
    })
    expect(push.status).toBe(401)
    expect(await push.json()).toEqual({ error: 'unauthorized' })
  })

  it('allows sync with a valid session', async () => {
    const auth = await signIn()
    expect((await pull(auth)).status).toBe(200)
  })

  it('reports session state and leaves health and shell routes public', async () => {
    const auth = await signIn()
    expect((await app.request('/auth/session')).status).toBe(401)
    expect((await app.request('/auth/session', { headers: auth })).status).toBe(200)
    expect((await app.request('/healthz')).status).toBe(200)
  })
})

describe('logout', () => {
  it('revokes the session server-side and clears the cookie', async () => {
    const auth = await signIn()
    const res = await app.request('/auth/logout', { method: 'POST', headers: auth })
    expect(res.status).toBe(200)
    expect(sessionCookie(res)).toContain('Max-Age=0')
    // Replaying the old token fails: the session is gone, not just forgotten by the browser.
    expect((await pull(auth)).status).toBe(401)
    expect(db.prepare('SELECT COUNT(*) AS n FROM session').get()).toEqual({ n: 0 })
  })
})

describe('session lifetime', () => {
  it('does not touch the cookie on every request', async () => {
    const auth = await signIn()
    nowMs += DAY / 2
    expect(sessionCookie(await pull(auth))).toBeUndefined()
  })

  it('slides the expiry and re-issues the cookie after a day', async () => {
    const auth = await signIn()
    nowMs += 2 * DAY
    const res = await pull(auth)
    expect(res.status).toBe(200)
    expect(sessionCookie(res)).toContain(`Max-Age=${SESSION_TTL_MS / 1000}`)
    // 91 days after login but only 89 after the slide: still valid.
    nowMs = START + 91 * DAY
    expect((await pull(auth)).status).toBe(200)
  })

  it('expires after 90 idle days', async () => {
    const auth = await signIn()
    nowMs += SESSION_TTL_MS + 1000
    expect((await pull(auth)).status).toBe(401)
    expect(db.prepare('SELECT COUNT(*) AS n FROM session').get()).toEqual({ n: 0 })
  })

  it('never outlives the absolute one-year cap, and shortens the cookie near it', async () => {
    const auth = await signIn()
    for (const day of [80, 160, 240, 320]) {
      nowMs = START + day * DAY
      expect((await pull(auth)).status).toBe(200)
    }
    nowMs = START + 360 * DAY
    const res = await pull(auth)
    expect(res.status).toBe(200)
    const maxAge = Number(/Max-Age=(\d+)/.exec(sessionCookie(res) ?? '')?.[1])
    expect(maxAge).toBeLessThanOrEqual((SESSION_MAX_AGE_MS - 360 * DAY) / 1000)
    expect(maxAge).toBeGreaterThan(0)
    nowMs = START + 366 * DAY
    expect((await pull(auth)).status).toBe(401)
  })

  it('invalidates every session when the password is rotated', async () => {
    const auth = await signIn()
    app = makeApp(await hashPassword('a different password', FAST))
    expect((await pull(auth)).status).toBe(401)
  })
})

describe('rate limiting', () => {
  const failTimes = async (n: number) => {
    for (let i = 0; i < n; i++) expect((await login('wrong')).status).toBe(401)
  }

  it('blocks an IP after repeated failures, even for the right password, without running scrypt', async () => {
    await failTimes(IP_LIMIT.max)
    vi.mocked(verifyPassword).mockClear()
    const res = await login(PASSWORD)
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe(String(IP_LIMIT.windowMs / 1000))
    expect(verifyPassword).not.toHaveBeenCalled()
  })

  it('lets the IP back in once the window passes', async () => {
    await failTimes(IP_LIMIT.max)
    nowMs += IP_LIMIT.windowMs + 1000
    expect((await login(PASSWORD)).status).toBe(200)
  })

  it('counts each IP separately', async () => {
    await failTimes(IP_LIMIT.max)
    ip = '203.0.113.2'
    expect((await login(PASSWORD)).status).toBe(200)
  })

  it('clears an IP’s failures on a successful login', async () => {
    await failTimes(IP_LIMIT.max - 1)
    expect((await login(PASSWORD)).status).toBe(200)
    await failTimes(IP_LIMIT.max - 1)
    expect((await login(PASSWORD)).status).toBe(200)
  })

  it('applies a global backstop across many IPs', async () => {
    const ips = GLOBAL_LIMIT.max / IP_LIMIT.max
    for (let i = 0; i < ips; i++) {
      ip = `198.51.100.${i + 1}`
      await failTimes(IP_LIMIT.max)
    }
    ip = '192.0.2.99'
    const res = await login(PASSWORD)
    expect(res.status).toBe(429)
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
    nowMs += GLOBAL_LIMIT.windowMs + 1000
    expect((await login(PASSWORD)).status).toBe(200)
  })

  it('treats addresses within one IPv6 /64 as the same client', async () => {
    for (let i = 0; i < IP_LIMIT.max; i++) {
      ip = `2001:db8:1:2::${i + 1}`
      expect((await login('wrong')).status).toBe(401)
    }
    ip = '2001:db8:1:2:ffff::9'
    expect((await login(PASSWORD)).status).toBe(429)
  })

  it('caps concurrent password verifications', async () => {
    const slowHash = await hashPassword(PASSWORD, { N: 2 ** 14, r: 8, p: 1 })
    app = makeApp(slowHash)
    const results = await Promise.all([login(PASSWORD), login(PASSWORD), login(PASSWORD)])
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 503])
    const busy = results.find((r) => r.status === 503)
    expect(busy?.headers.get('retry-after')).toBe('1')
  })
})

describe('cross-site protection', () => {
  it('refuses cross-site unsafe requests but not same-origin ones', async () => {
    const cross = await app.request('/auth/login', {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({ password: PASSWORD }),
    })
    expect(cross.status).toBe(403)
    const same = await login(PASSWORD, { ...JSON_HEADERS, 'sec-fetch-site': 'same-origin' })
    expect(same.status).toBe(200)
  })
})
