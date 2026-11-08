# Mylar Ledger

Personal comic collection catalog and price tracker. Local-first Preact PWA (Dexie) syncing to a
Hono + `node:sqlite` server; deployed target is Fly.io (single machine + volume).

## Commands

- `npm run lint | typecheck | test | build` (root, all workspaces). All must pass clean.
- Dev: `npm run dev -w @mylar/api` (127.0.0.1:8787), `npm run dev -w @mylar/web` (proxies /sync).

## Style

- ESNext syntax. No semicolons (Prettier enforces: `npm run format`).

## Invariants

- Server is authoritative; each client holds a full local copy. Writes go through `saveMutation`
  (validates, writes locally + queues outbox in one transaction). Never write synced tables directly.
- Outbox rows are deleted only after the server acks. A failed sync must never drop queued writes.
- Conflicts: last-write-wins per row on `updatedAt`. Timestamps are fixed-width UTC strings
  (`YYYY-MM-DDTHH:mm:ss.sssZ`) so string comparison is chronological; do not loosen the format.
  Known, accepted: an exact `updatedAt` tie with different content on two devices leaves them
  diverged (the server keeps the first push, a client keeps its local row). Not worth fixing for
  one user; revisit if a second writer is ever added.
- LWW replaces the whole row, by design: concurrent edits to different fields on two devices lose
  one side, and a later edit from a stale device (no `deletedAt`) resurrects a deleted row. A test
  pins the resurrection. Per-field merge would be a protocol change; not worth it for one user.
- Deletes are tombstones (`deletedAt`), never row removal. Price snapshots are append-only.
- One global `seq` orders changes across all tables. Cross-table references are deliberately not
  foreign keys (offline clients can push children before parents).
- `COLUMNS` in `packages/api/src/sync.ts` must match the real SQLite schema (a test enforces it).

## Schema changes

- Before first deploy, migration 0 may be edited in place. After first deploy: append-only
  migrations, never edit an applied one.

## Hard stops

- No auth exists yet. The server defaults to loopback and the image sets no `HOST`; only compose
  sets it (with a loopback-only published port). Do not change that, expose the port, or deploy.
- Requests are rejected unless the Host is in `ALLOWED_HOSTS` (default: loopback names), and
  `/sync/push` requires `application/json`. Keep both checks when adding auth (CSRF/DNS rebinding).
- Never touch Fly.io or any cloud resource without explicit approval.

## Toolchain

- Node 26 runs the API's `.ts` directly (no build); keep `.ts` extensions in relative imports.

## Known gaps (fix later)

- Service worker has no build-manifest precache: assets not fetched while online are missing on a
  first-ever offline load. Fix by generating a precache list from Vite's build output.
