import Dexie, { type Table } from 'dexie'
import type { Copy, Issue, Mutation, PriceSnapshot, Series, TableName } from '@mylar/shared'

export interface OutboxEntry {
  id?: number
  mutation: Mutation
}

export interface SyncState {
  key: 'cursor'
  seq: number
  /** The server database this cursor belongs to; a different value means a reset or new server. */
  instanceId?: string
}

/** Minimal row shape the generic sync code needs; every synced record satisfies it. */
export interface SyncedRow {
  id: string
  updatedAt: string
}

export class MylarDb extends Dexie {
  series!: Table<Series, string>
  issue!: Table<Issue, string>
  copy!: Table<Copy, string>
  price_snapshot!: Table<PriceSnapshot, string>
  outbox!: Table<OutboxEntry, number>
  syncState!: Table<SyncState, string>

  constructor(name = 'mylar-ledger') {
    super(name)
    this.version(1).stores({
      series: 'id, title, updatedAt',
      issue: 'id, seriesId, barcode, updatedAt',
      copy: 'id, issueId, updatedAt',
      price_snapshot: 'id, issueId, copyId, observedAt',
      outbox: '++id',
      syncState: 'key',
    })
  }

  synced(name: TableName): Table<SyncedRow, string> {
    return this.table<SyncedRow, string>(name)
  }
}
