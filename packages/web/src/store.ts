import {
  fromTimestamp,
  mutationSchema,
  toTimestamp,
  uuidv7,
  type Mutation,
  type Series,
} from '@mylar/shared'
import type { MylarDb } from './db.ts'

/**
 * Validates, then writes locally and queues the mutation in one transaction, so a write is never
 * queued without being applied. A bad record throws here instead of poisoning every future push.
 * `updatedAt` is bumped past the stored row so a clock-skewed edit cannot lose LWW to its own past.
 */
export async function saveMutation(db: MylarDb, input: Mutation): Promise<void> {
  let mutation = mutationSchema.parse(input)
  await db.transaction('rw', db.synced(mutation.table), db.outbox, async () => {
    const table = db.synced(mutation.table)
    const existing = await table.get(mutation.record.id)
    if (mutation.table === 'price_snapshot' && existing) {
      // Append-only: a stored snapshot's content never changes; it can only be tombstoned.
      const stored = await db.price_snapshot.get(mutation.record.id)
      if (!stored || mutation.record.deletedAt === undefined || stored.deletedAt !== undefined) {
        throw new Error('price snapshots are append-only')
      }
      mutation = mutationSchema.parse({
        table: 'price_snapshot',
        record: {
          ...stored,
          deletedAt: mutation.record.deletedAt,
          updatedAt: mutation.record.updatedAt,
        },
      })
    }
    const queued =
      existing && mutation.record.updatedAt <= existing.updatedAt
        ? mutationSchema.parse({
            table: mutation.table,
            record: {
              ...mutation.record,
              updatedAt: toTimestamp(fromTimestamp(existing.updatedAt) + 1),
            },
          })
        : mutation
    await table.put(queued.record)
    await db.outbox.add({ mutation: queued })
  })
}

export function addSeries(
  db: MylarDb,
  input: { title: string; publisher?: string },
  now: number = Date.now(),
): Promise<void> {
  const record: Series = {
    id: uuidv7(now),
    createdAt: toTimestamp(now),
    updatedAt: toTimestamp(now),
    title: input.title,
    ...(input.publisher ? { publisher: input.publisher } : {}),
  }
  return saveMutation(db, { table: 'series', record })
}

export function deleteSeries(db: MylarDb, id: string, now: number = Date.now()): Promise<void> {
  // Read and write in one transaction so a concurrent edit (another tab) cannot be clobbered
  // by a stale copy of the row.
  return db.transaction('rw', db.series, db.outbox, async () => {
    const existing = await db.series.get(id)
    if (!existing) return
    await saveMutation(db, {
      table: 'series',
      record: { ...existing, deletedAt: toTimestamp(now), updatedAt: toTimestamp(now) },
    })
  })
}
