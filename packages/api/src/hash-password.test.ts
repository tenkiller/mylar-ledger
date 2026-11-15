import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { verifyPassword } from './password.ts'

const script = new URL('./hash-password.ts', import.meta.url).pathname
const run = (input: string) => spawnSync(process.execPath, [script], { input, encoding: 'utf8', timeout: 20_000 })

describe('hash-password script', () => {
  it('prints only a verifiable hash for piped input', async () => {
    const res = run('a sufficiently long passphrase\n')
    expect(res.status).toBe(0)
    const hash = res.stdout.trim()
    expect(hash.split('\n')).toHaveLength(1)
    expect(hash).not.toContain('$')
    expect(await verifyPassword('a sufficiently long passphrase', hash)).toBe(true)
  })

  it('refuses a short password and prints no hash', () => {
    const res = run('short\n')
    expect(res.status).toBe(1)
    expect(res.stdout).toBe('')
    expect(res.stderr).toContain('at least 12')
  })
})
