import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

export interface ScryptParams {
  N: number
  r: number
  p: number
}

/** OWASP's ~32 MiB scrypt profile. */
export const DEFAULT_PARAMS: ScryptParams = { N: 2 ** 15, r: 8, p: 3 }

const KEY_LENGTH = 32
const SALT_LENGTH = 16
// Node's default maxmem (32 MiB) is right at the edge for N=2^15, r=8, so raise it explicitly.
const MAX_MEMORY = 64 * 1024 * 1024

const memoryNeeded = ({ N, r, p }: ScryptParams): number => 128 * N * r + 128 * r * p

function isSupported(params: ScryptParams): boolean {
  const { N, r, p } = params
  return (
    Number.isInteger(N) &&
    N >= 2 ** 10 &&
    N <= 2 ** 17 &&
    (N & (N - 1)) === 0 &&
    Number.isInteger(r) &&
    r >= 1 &&
    r <= 16 &&
    Number.isInteger(p) &&
    p >= 1 &&
    p <= 16 &&
    memoryNeeded(params) <= MAX_MEMORY
  )
}

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, { ...params, maxmem: MAX_MEMORY }, (err, key) => {
      if (err) reject(err)
      else resolve(key)
    })
  })
}

interface ParsedHash {
  params: ScryptParams
  salt: Buffer
  key: Buffer
}

/**
 * Format: `scrypt:N:r:p:<salt>:<hash>` with base64url parts. It deliberately contains no `$`, which
 * Compose and shells would try to interpolate when the hash is passed as an environment variable.
 */
export function parseHash(stored: string): ParsedHash | undefined {
  const parts = stored.split(':')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return undefined
  const [, n, r, p, salt, key] = parts as [string, string, string, string, string, string]
  const params = { N: Number(n), r: Number(r), p: Number(p) }
  if (!isSupported(params)) return undefined
  const saltBuf = Buffer.from(salt, 'base64url')
  const keyBuf = Buffer.from(key, 'base64url')
  if (saltBuf.length !== SALT_LENGTH || keyBuf.length !== KEY_LENGTH) return undefined
  return { params, salt: saltBuf, key: keyBuf }
}

export async function hashPassword(password: string, params: ScryptParams = DEFAULT_PARAMS): Promise<string> {
  if (!isSupported(params)) throw new Error('unsupported scrypt parameters')
  const salt = randomBytes(SALT_LENGTH)
  const key = await derive(password, salt, params)
  return `scrypt:${params.N}:${params.r}:${params.p}:${salt.toString('base64url')}:${key.toString('base64url')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored)
  if (!parsed) return false
  const key = await derive(password, parsed.salt, parsed.params)
  return timingSafeEqual(key, parsed.key)
}

/** Stored with each session so rotating the password invalidates every existing session. */
export function passwordFingerprint(stored: string): string {
  return createHash('sha256').update(stored).digest('hex')
}
