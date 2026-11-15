import type { Context } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'

/**
 * Key used to count login failures. IPv6 clients usually control a whole /64, so a single address
 * would let them rotate past the limit; collapse to the /64. IPv4-mapped IPv6 maps back to IPv4.
 */
export function rateLimitKey(rawIp: string): string {
  const ip = (rawIp.split('%')[0] ?? rawIp).toLowerCase()
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip)
  if (mapped?.[1]) return mapped[1]
  if (!ip.includes(':')) return ip

  const [left = '', right] = ip.split('::')
  const head = left === '' ? [] : left.split(':')
  const tail = right === undefined || right === '' ? [] : right.split(':')
  const groups =
    right === undefined ? head : [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail]
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`
}

export type ClientIpResolver = (c: Context) => string

/** Socket peer address; "unknown" when unavailable (e.g. `app.request` in tests). */
export const socketClientIp: ClientIpResolver = (c) => {
  try {
    return getConnInfo(c).remote.address ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Trust a proxy-set header (e.g. `Fly-Client-IP`) only when explicitly configured: otherwise any
 * client could send it and pick its own rate-limit bucket. Falls back to the socket address.
 */
export function headerClientIp(headerName: string): ClientIpResolver {
  return (c) => c.req.header(headerName)?.trim() || socketClientIp(c)
}
