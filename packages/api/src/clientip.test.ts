import { describe, expect, it } from 'vitest'
import { rateLimitKey } from './clientip.ts'

describe('rateLimitKey', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:0db8:0001:0002::9', '2001:db8:1:2::/64'],
    ['2001:DB8:1:2:ffff::9', '2001:db8:1:2::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
    ['unknown', 'unknown'],
  ])('%s -> %s', (input, expected) => {
    expect(rateLimitKey(input)).toBe(expected)
  })
})
