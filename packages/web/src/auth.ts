import { loginRequestSchema } from '@mylar/shared'
import type { FetchFn } from './sync.ts'

export type LoginResult =
  | { ok: true }
  | { ok: false; reason: 'invalid' | 'rate_limited' | 'busy' | 'error'; retryAfterSeconds?: number }

/**
 * Signs in with the single account's password. The session lives in an HttpOnly cookie that
 * JavaScript never sees; fetch sends it automatically for same-origin requests.
 */
export async function login(password: string, fetchFn: FetchFn = fetch): Promise<LoginResult> {
  const body = loginRequestSchema.safeParse({ password })
  if (!body.success) return { ok: false, reason: 'invalid' }
  const res = await fetchFn('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body.data),
  })
  if (res.ok) return { ok: true }
  if (res.status === 401) return { ok: false, reason: 'invalid' }
  const retry = Number(res.headers.get('retry-after'))
  const retryAfterSeconds = Number.isFinite(retry) && retry > 0 ? { retryAfterSeconds: retry } : {}
  if (res.status === 429) return { ok: false, reason: 'rate_limited', ...retryAfterSeconds }
  if (res.status === 503) return { ok: false, reason: 'busy', ...retryAfterSeconds }
  return { ok: false, reason: 'error' }
}

/** Ends the server session. Local data stays on the device; only the server access is revoked. */
export async function logout(fetchFn: FetchFn = fetch): Promise<void> {
  await fetchFn('/auth/logout', { method: 'POST' })
}
