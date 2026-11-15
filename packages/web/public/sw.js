// Network-first with a cache fallback so the app shell opens offline and on flaky connections.
// Known gap: no build-manifest precache, so assets not yet fetched while online are unavailable
// on a first-ever offline load (see CLAUDE.md "Known gaps").
const CACHE = 'mylar-shell-v1'
const NETWORK_TIMEOUT_MS = 3000

self.addEventListener('install', () => {
  void self.skipWaiting()
})

self.addEventListener('activate', event => {
  // Bumping CACHE drops every older cache.
  event.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', event => {
  const req = event.request
  const url = new URL(req.url)
  if (req.method !== 'GET' || url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/sync') || url.pathname.startsWith('/auth')) return
  if (url.pathname === '/healthz') return
  event.respondWith(handle(event))
})

async function handle(event) {
  const req = event.request
  const cached = await caches.match(req)
  // Unknown navigations (SPA deep links) fall back to the cached shell.
  const fallback = cached ?? (req.mode === 'navigate' ? await caches.match('/') : undefined)

  const network = fetch(req).then(res => {
    if (res.ok) {
      const copy = res.clone()
      event.waitUntil(caches.open(CACHE).then(c => c.put(req, copy)))
    }
    return res
  })

  if (!fallback) return network.catch(() => Response.error())

  // Let a slow request finish in the background (it refreshes the cache) but do not make the
  // user wait on it.
  event.waitUntil(network.catch(() => undefined))
  const timeout = new Promise(resolve => {
    setTimeout(() => resolve(fallback), NETWORK_TIMEOUT_MS)
  })
  return Promise.race([network, timeout]).catch(() => fallback)
}
