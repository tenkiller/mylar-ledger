import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { migrate } from './db.ts'
import { hashPassword } from './password.ts'

describe('migrate', () => {
  it('refuses a database from a newer build', () => {
    const raw = new DatabaseSync(':memory:')
    raw.exec('PRAGMA user_version = 99')
    expect(() => {
      migrate(raw)
    }).toThrow(/newer than this build supports/)
  })

  it('is a no-op on an up-to-date database', () => {
    const raw = new DatabaseSync(':memory:')
    migrate(raw)
    expect(() => {
      migrate(raw)
    }).not.toThrow()
  })
})

describe('server process', () => {
  it('exits 0 promptly on SIGTERM even with a keep-alive connection open', async () => {
    const child = spawn(process.execPath, [new URL('./server.ts', import.meta.url).pathname], {
      env: { ...process.env, PORT: '0', DB_PATH: ':memory:', AUTH_DISABLED: 'true' },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    const port = await new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.stdout.on('data', (chunk: Buffer) => {
        const m = /listening on .*:(\d+)/.exec(chunk.toString())
        if (m?.[1]) resolve(Number(m[1]))
      })
    })

    // fetch() holds the connection open (keep-alive), which would stall a naive server.close().
    const res = await fetch(`http://127.0.0.1:${port}/healthz`)
    expect(res.status).toBe(200)

    const started = Date.now()
    const exit = new Promise<number | null>((resolve) =>
      child.once('exit', (code) => {
        resolve(code)
      }),
    )
    child.kill('SIGTERM')
    expect(await exit).toBe(0)
    expect(Date.now() - started).toBeLessThan(3000)
  }, 15_000)
})

interface Running {
  exit: Promise<number | null>
  output: () => string
  port: Promise<number>
  stop: () => Promise<number | null>
}

// Explicit env (not inherited) so the host's own AUTH_* settings cannot leak into a test.
function start(extra: Record<string, string>): Running {
  const child = spawn(process.execPath, [new URL('./server.ts', import.meta.url).pathname], {
    env: { PATH: process.env['PATH'] ?? '', PORT: '0', DB_PATH: ':memory:', ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  const exit = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => {
      resolve(code)
    })
  })
  const port = new Promise<number>((resolve) => {
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
      const m = /listening on .*:(\d+)/.exec(out)
      if (m?.[1]) resolve(Number(m[1]))
    })
  })
  child.stderr.on('data', (chunk: Buffer) => {
    out += chunk.toString()
  })
  return {
    exit,
    output: () => out,
    port,
    stop: () => {
      child.kill('SIGTERM')
      return exit
    },
  }
}

describe('server startup fails closed', () => {
  it('refuses to start without a password hash', async () => {
    const s = start({})
    expect(await s.exit).toBe(1)
    expect(s.output()).toContain('AUTH_PASSWORD_HASH is required')
  })

  it('refuses a malformed password hash', async () => {
    const s = start({ AUTH_PASSWORD_HASH: 'not-a-hash' })
    expect(await s.exit).toBe(1)
    expect(s.output()).toContain('malformed')
  })

  it('refuses AUTH_DISABLED when bound beyond loopback', async () => {
    const s = start({ AUTH_DISABLED: 'true', HOST: '0.0.0.0' })
    expect(await s.exit).toBe(1)
    expect(s.output()).toContain('only allowed when HOST is loopback')
  })

  it('allows AUTH_DISABLED on loopback, with a warning', async () => {
    const s = start({ AUTH_DISABLED: 'true', HOST: '127.0.0.1' })
    await s.port
    expect(s.output()).toContain('authentication is disabled')
    expect(await s.stop()).toBe(0)
  })

  it('serves an authenticated session end to end over real HTTP', async () => {
    const hash = await hashPassword('end to end password', { N: 2 ** 10, r: 8, p: 1 })
    const s = start({ AUTH_PASSWORD_HASH: hash })
    const base = `http://127.0.0.1:${await s.port}`

    expect((await fetch(`${base}/sync/pull?since=0`)).status).toBe(401)

    const login = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'end to end password' }),
    })
    expect(login.status).toBe(200)
    const cookie = login.headers.getSetCookie()[0]?.split(';')[0] ?? ''
    expect(cookie).toMatch(/^__Host-session=/)

    const authed = await fetch(`${base}/sync/pull?since=0`, { headers: { cookie } })
    expect(authed.status).toBe(200)
    expect(await s.stop()).toBe(0)
  })
})
