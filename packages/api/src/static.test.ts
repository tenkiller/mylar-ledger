import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { openDb } from './db.ts'

let dir: string
let app: ReturnType<typeof createApp>

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mylar-web-'))
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>shell</title>')
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)')
  app = createApp(openDb(':memory:'), { auth: { disabled: true }, webDist: dir })
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const get = async (path: string) => {
  const res = await app.request(path)
  return { status: res.status, type: res.headers.get('content-type') ?? '', body: await res.text() }
}

describe('static serving', () => {
  it('serves the shell and real assets', async () => {
    const shell = await get('/')
    expect(shell.status).toBe(200)
    expect(shell.body).toContain('shell')
    expect(await get('/assets/app.js')).toMatchObject({ status: 200, body: 'console.log(1)' })
  })

  it('falls back to the shell for extensionless SPA routes', async () => {
    const res = await get('/series/123')
    expect(res.status).toBe(200)
    expect(res.body).toContain('shell')
  })

  it.each(['/assets/gone.js', '/favicon.ico', '/missing.css', '/sync/unknown'])(
    '404s %s instead of returning the shell',
    async (path) => {
      const res = await get(path)
      expect(res.status).toBe(404)
      expect(res.body).not.toContain('shell')
    },
  )

  it('still serves the API routes', async () => {
    expect(await get('/healthz')).toMatchObject({ status: 200, body: '{"ok":true}' })
  })
})
