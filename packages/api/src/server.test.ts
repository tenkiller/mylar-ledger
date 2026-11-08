import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { migrate } from './db.ts'

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
      env: { ...process.env, PORT: '0', DB_PATH: ':memory:' },
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
