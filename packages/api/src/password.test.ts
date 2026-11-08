import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PARAMS,
  hashPassword,
  parseHash,
  passwordFingerprint,
  verifyPassword,
  type ScryptParams,
} from './password.ts'

const FAST: ScryptParams = { N: 2 ** 10, r: 8, p: 1 }

describe('password hashing', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery', FAST)
    expect(await verifyPassword('correct horse battery', hash)).toBe(true)
    expect(await verifyPassword('wrong', hash)).toBe(false)
    expect(await verifyPassword('', hash)).toBe(false)
  })

  it('salts: the same password hashes differently each time', async () => {
    expect(await hashPassword('same', FAST)).not.toBe(await hashPassword('same', FAST))
  })

  it('embeds its parameters and has no "$" (safe for env files and shells)', async () => {
    const hash = await hashPassword('x', FAST)
    expect(hash).toMatch(/^scrypt:1024:8:1:[\w-]+:[\w-]+$/)
    expect(hash).not.toContain('$')
    expect(parseHash(hash)?.params).toEqual(FAST)
  })

  it('verifies hashes made with older parameters', async () => {
    const old = await hashPassword('pw', { N: 2 ** 11, r: 8, p: 1 })
    expect(await verifyPassword('pw', old)).toBe(true)
  })

  it('runs the real default parameters within the memory limit', async () => {
    const hash = await hashPassword('production-profile', DEFAULT_PARAMS)
    expect(hash.startsWith('scrypt:32768:8:3:')).toBe(true)
    expect(await verifyPassword('production-profile', hash)).toBe(true)
  })

  it.each([
    ['empty', ''],
    ['wrong scheme', 'bcrypt:1024:8:1:aaaa:bbbb'],
    ['too few parts', 'scrypt:1024:8:1:aaaa'],
    ['non power-of-two N', 'scrypt:1000:8:1:aaaa:bbbb'],
    ['N too large for the memory cap', `scrypt:${2 ** 17}:8:1:aaaa:bbbb`],
    ['garbage salt/key lengths', 'scrypt:1024:8:1:aaaa:bbbb'],
  ])('rejects a malformed or unsupported hash (%s)', async (_n, bad) => {
    expect(parseHash(bad)).toBeUndefined()
    expect(await verifyPassword('anything', bad)).toBe(false)
  })

  it('refuses to hash with unsupported parameters', async () => {
    await expect(hashPassword('x', { N: 3, r: 8, p: 1 })).rejects.toThrow('unsupported')
  })

  it('fingerprints deterministically and differently per hash', async () => {
    const a = await hashPassword('x', FAST)
    const b = await hashPassword('x', FAST)
    expect(passwordFingerprint(a)).toBe(passwordFingerprint(a))
    expect(passwordFingerprint(a)).not.toBe(passwordFingerprint(b))
  })
})
