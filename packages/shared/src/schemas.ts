import { z } from 'zod'

const id = z.uuid()
const cents = z.number().int().nonnegative()

/** Exactly `YYYY-MM-DDTHH:mm:ss.sssZ`: fixed width, so lexicographic order is chronological. */
const timestamp = z.iso.datetime({ precision: 3 })

const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
const daysInMonth = (y: number, m: number): number =>
  m === 2 ? (isLeap(y) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31

/**
 * A calendar date, validated as real. `full` requires YYYY-MM-DD; otherwise YYYY and YYYY-MM are
 * accepted too (cover dates are often only a month or year). All forms sort chronologically as text.
 */
function calendarDate(full: boolean) {
  return z
    .string()
    .regex(
      full ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}(-\d{2}(-\d{2})?)?$/,
      full ? 'expected YYYY-MM-DD' : 'expected YYYY, YYYY-MM or YYYY-MM-DD',
    )
    .refine((s) => {
      const [y, m, d] = s.split('-').map(Number)
      if (y === undefined || y < 1000) return false
      if (m === undefined) return true
      if (m < 1 || m > 12) return false
      return d === undefined || (d >= 1 && d <= daysInMonth(y, m))
    }, 'not a real date')
}

/** Fields every synced row carries. `seq` is server-assigned and never sent by clients. */
const base = {
  id,
  createdAt: timestamp,
  updatedAt: timestamp,
  /** Instant the row was tombstoned; absent while live. */
  deletedAt: timestamp.optional(),
}

export const seriesSchema = z.object({
  ...base,
  title: z.string().min(1).max(500),
  publisher: z.string().max(200).optional(),
  startYear: z.number().int().optional(),
  comicvineId: z.number().int().optional(),
})

export const issueSchema = z.object({
  ...base,
  seriesId: id,
  number: z.string().min(1).max(50),
  coverDate: calendarDate(false).optional(),
  variant: z.string().max(200).optional(),
  barcode: z.string().max(64).optional(),
  // http(s) only: anything else (javascript:, data:) is an XSS vector once rendered as a link.
  coverUrl: z
    .url({ protocol: /^https?$/ })
    .max(2048)
    .optional(),
  comicvineId: z.number().int().optional(),
  metadataStatus: z.enum(['resolved', 'pending']),
})

export const copySchema = z.object({
  ...base,
  issueId: id,
  conditionGrade: z.string().max(50).optional(),
  numericGrade: z.number().min(0).max(10).optional(),
  gradedBy: z.string().max(100).optional(),
  slabCert: z.string().max(100).optional(),
  purchasePriceCents: cents.optional(),
  purchaseDate: calendarDate(true).optional(),
  location: z.string().max(200).optional(),
  notes: z.string().max(5000).optional(),
})

/** Append-only: a correction is a new snapshot, never an edit. */
export const priceSnapshotSchema = z.object({
  ...base,
  issueId: id,
  copyId: id.optional(),
  grade: z.string().max(50).optional(),
  valueCents: cents,
  source: z.string().min(1).max(100),
  observedAt: timestamp,
  note: z.string().max(1000).optional(),
})

export const tableNames = ['series', 'issue', 'copy', 'price_snapshot'] as const
export const tableNameSchema = z.enum(tableNames)
export type TableName = z.infer<typeof tableNameSchema>

export type Series = z.infer<typeof seriesSchema>
export type Issue = z.infer<typeof issueSchema>
export type Copy = z.infer<typeof copySchema>
export type PriceSnapshot = z.infer<typeof priceSnapshotSchema>

/** A full-row upsert. Last-write-wins on `record.updatedAt`; deletes are tombstones. */
export const mutationSchema = z.discriminatedUnion('table', [
  z.object({ table: z.literal('series'), record: seriesSchema }),
  z.object({ table: z.literal('issue'), record: issueSchema }),
  z.object({ table: z.literal('copy'), record: copySchema }),
  z.object({ table: z.literal('price_snapshot'), record: priceSnapshotSchema }),
])
export type Mutation = z.infer<typeof mutationSchema>

export const MAX_PUSH_BATCH = 200
export const MAX_PULL_LIMIT = 500

export const pushRequestSchema = z.object({
  mutations: z.array(mutationSchema).max(MAX_PUSH_BATCH),
})
export type PushRequest = z.infer<typeof pushRequestSchema>

export const pushResponseSchema = z.object({
  /** Mutations that changed server state (the rest lost LWW or were duplicates). */
  applied: z.number().int().nonnegative(),
  /** Highest server seq after this push. */
  seq: z.number().int().nonnegative(),
})
export type PushResponse = z.infer<typeof pushResponseSchema>

export const pullQuerySchema = z.object({
  since: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(MAX_PULL_LIMIT).default(200),
})

export const pullResponseSchema = z.object({
  changes: z.array(z.object({ seq: z.number().int().positive(), mutation: mutationSchema })),
  /** Cursor to pass as `since` next time. */
  nextSeq: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  /** Identifies this database. A change means the server was reset or replaced. */
  instanceId: z.string().min(1),
  /** Highest seq on the server. A cursor above it means the server was restored from older data. */
  serverSeq: z.number().int().nonnegative(),
})
export type PullResponse = z.infer<typeof pullResponseSchema>

export const MAX_PASSWORD_LENGTH = 256

export const loginRequestSchema = z.object({
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
})
export type LoginRequest = z.infer<typeof loginRequestSchema>
