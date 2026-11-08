import { createServer } from 'node:http'
import { getRequestListener } from '@hono/node-server'
import { createApp } from './app.ts'
import { openDb } from './db.ts'

const port = Number(process.env['PORT'] ?? 8787)
// Loopback by default: there is no auth yet, so nothing may be exposed beyond the host.
const hostname = process.env['HOST'] ?? '127.0.0.1'
const dbPath = process.env['DB_PATH'] ?? './data/mylar.sqlite'
const webDist = process.env['WEB_DIST']
// Comma-separated hostnames to answer to. Set this to the public hostname when deploying.
const allowedHosts = process.env['ALLOWED_HOSTS']
  ?.split(',')
  .map((h) => h.trim())
  .filter((h) => h !== '')

const db = openDb(dbPath)
const app = createApp(db, {
  ...(allowedHosts ? { allowedHosts } : {}),
  ...(webDist !== undefined ? { webDist } : {}),
})

// A plain node:http server (rather than serve()) so shutdown can use the http.Server API.
const listener = getRequestListener(app.fetch)
const server = createServer((req, res) => {
  void listener(req, res)
})
server.listen(port, hostname, () => {
  const addr = server.address()
  if (addr !== null && typeof addr === 'object') {
    console.log(`mylar-ledger api listening on ${addr.address}:${addr.port}`)
  }
})

const SHUTDOWN_GRACE_MS = 5000

// As PID 1 in a container, Node ignores SIGTERM unless a handler is installed, so `docker stop`
// would wait out its timeout and SIGKILL. Stop accepting, let in-flight requests finish, close the
// database (checkpointing the WAL), and exit 0.
function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`)
  server.close(() => {
    db.close()
    process.exit(0)
  })
  server.closeIdleConnections()
  setTimeout(() => {
    server.closeAllConnections()
  }, SHUTDOWN_GRACE_MS).unref()
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM')
})
process.on('SIGINT', () => {
  shutdown('SIGINT')
})
