import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import {
  mutationSchema,
  tableNames,
  type Mutation,
  type PullResponse,
  type PushResponse,
  type TableName,
} from '@mylar/shared'

interface Col {
  /** Property name on the shared record type. */
  field: string
  column: string
}

const c = (field: string, column: string): Col => ({ field, column })

/** Domain columns per table; id/created_at/updated_at/deleted_at/seq are common and handled separately. */
export const COLUMNS: Record<TableName, readonly Col[]> = {
  series: [
    c('title', 'title'),
    c('publisher', 'publisher'),
    c('startYear', 'start_year'),
    c('comicvineId', 'comicvine_id'),
  ],
  issue: [
    c('seriesId', 'series_id'),
    c('number', 'number'),
    c('coverDate', 'cover_date'),
    c('variant', 'variant'),
    c('barcode', 'barcode'),
    c('coverUrl', 'cover_url'),
    c('comicvineId', 'comicvine_id'),
    c('metadataStatus', 'metadata_status'),
  ],
  copy: [
    c('issueId', 'issue_id'),
    c('conditionGrade', 'condition_grade'),
    c('numericGrade', 'numeric_grade'),
    c('gradedBy', 'graded_by'),
    c('slabCert', 'slab_cert'),
    c('purchasePriceCents', 'purchase_price_cents'),
    c('purchaseDate', 'purchase_date'),
    c('location', 'location'),
    c('notes', 'notes'),
  ],
  price_snapshot: [
    c('issueId', 'issue_id'),
    c('copyId', 'copy_id'),
    c('grade', 'grade'),
    c('valueCents', 'value_cents'),
    c('source', 'source'),
    c('observedAt', 'observed_at'),
    c('note', 'note'),
  ],
}

type Row = Record<string, unknown>

export function instanceId(db: DatabaseSync): string {
  const row = db.prepare('SELECT instance_id FROM server_meta WHERE id = 1').get() as
    { instance_id: string } | undefined
  if (!row) throw new Error('server_meta row missing')
  return row.instance_id
}

export function currentSeq(db: DatabaseSync): number {
  const row = db.prepare('SELECT value FROM seq_counter WHERE id = 1').get() as { value: number } | undefined
  return row?.value ?? 0
}

function toParams(table: TableName, record: Row, seq: number): SQLInputValue[] {
  const domain = COLUMNS[table].map(({ field }) => {
    const v = record[field]
    return v === undefined ? null : (v as SQLInputValue)
  })
  return [
    record['id'] as string,
    record['createdAt'] as string,
    record['updatedAt'] as string,
    (record['deletedAt'] as string | undefined) ?? null,
    seq,
    ...domain,
  ]
}

function toRecord(row: Row, table: TableName): Row {
  const record: Row = {
    id: row['id'],
    createdAt: row['created_at'],
    updatedAt: row['updated_at'],
  }
  if (typeof row['deleted_at'] === 'string') record['deletedAt'] = row['deleted_at']
  for (const { field, column } of COLUMNS[table]) {
    const v = row[column]
    if (v !== null && v !== undefined) record[field] = v
  }
  return record
}

function upsertSql(table: TableName): string {
  const cols = ['id', 'created_at', 'updated_at', 'deleted_at', 'seq', ...COLUMNS[table].map(x => x.column)]
  const placeholders = cols.map(() => '?').join(', ')
  // created_at is immutable once stored.
  const updates = cols
    .slice(1)
    .filter(col => col !== 'created_at')
    .map(col => `${col} = excluded.${col}`)
    .join(', ')
  return `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})
          ON CONFLICT (id) DO UPDATE SET ${updates}`
}

/**
 * Last-write-wins per row: a mutation applies only if strictly newer than the stored row, which
 * also makes re-pushing the same outbox entry a no-op. Only applied changes get a new seq.
 * Table names interpolated into SQL come from the closed `TableName` enum, never from input.
 */
export function applyMutations(db: DatabaseSync, mutations: readonly Mutation[]): PushResponse {
  const find = Object.fromEntries(
    tableNames.map(t => [t, db.prepare(`SELECT updated_at, deleted_at FROM ${t} WHERE id = ?`)]),
  ) as Record<TableName, ReturnType<DatabaseSync['prepare']>>
  const upsert = Object.fromEntries(tableNames.map(t => [t, db.prepare(upsertSql(t))])) as Record<
    TableName,
    ReturnType<DatabaseSync['prepare']>
  >
  const tombstoneSnapshot = db.prepare('UPDATE price_snapshot SET deleted_at = ?, updated_at = ?, seq = ? WHERE id = ?')
  const bump = db.prepare('UPDATE seq_counter SET value = ? WHERE id = 1')

  let applied = 0
  db.exec('BEGIN IMMEDIATE')
  try {
    let seq = currentSeq(db)
    for (const { table, record } of mutations) {
      const existing = find[table].get(record.id) as { updated_at: string; deleted_at: string | null } | undefined
      if (existing !== undefined && record.updatedAt <= existing.updated_at) continue
      if (table === 'price_snapshot' && existing !== undefined) {
        // Append-only: an existing snapshot's content never changes; it can only be tombstoned once.
        if (record.deletedAt === undefined || existing.deleted_at !== null) continue
        seq += 1
        tombstoneSnapshot.run(record.deletedAt, record.updatedAt, seq, record.id)
        applied += 1
        continue
      }
      seq += 1
      upsert[table].run(...toParams(table, record, seq))
      applied += 1
    }
    bump.run(seq)
    db.exec('COMMIT')
    return { applied, seq }
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export function pullChanges(db: DatabaseSync, since: number, limit: number): PullResponse {
  // Each table's own top-`limit+1` is enough: the global top-`limit+1` is a subset of their union.
  const rows = tableNames
    .flatMap(table =>
      (db.prepare(`SELECT * FROM ${table} WHERE seq > ? ORDER BY seq LIMIT ?`).all(since, limit + 1) as Row[]).map(
        row => ({ table, row }),
      ),
    )
    .sort((a, b) => (a.row['seq'] as number) - (b.row['seq'] as number))
    .slice(0, limit + 1)
  const page = rows.slice(0, limit)
  const changes = page.map(({ table, row }) => ({
    seq: row['seq'] as number,
    mutation: mutationSchema.parse({ table, record: toRecord(row, table) }),
  }))
  return {
    changes,
    nextSeq: page.at(-1) ? (page.at(-1)?.row['seq'] as number) : since,
    hasMore: rows.length > limit,
    instanceId: instanceId(db),
    serverSeq: currentSeq(db),
  }
}
