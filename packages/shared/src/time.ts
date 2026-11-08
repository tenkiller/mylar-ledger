/** Fixed-width UTC ISO 8601 (`YYYY-MM-DDTHH:mm:ss.sssZ`), so string order equals time order. */
export function toTimestamp(ms: number = Date.now()): string {
  return new Date(ms).toISOString()
}

export function fromTimestamp(t: string): number {
  return Date.parse(t)
}
