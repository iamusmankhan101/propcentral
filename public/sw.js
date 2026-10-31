const CACHE_NAME = 'estate-centric-crm-v3'
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.png',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
]
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com'])

const cacheable = (response) => response && response.ok

async function put(request, response) {
  const cache = await caches.open(CACHE_NAME)
  await cache.put(request, response)
}

// Pre-cache the app shell. A missing optional asset must not fail the install.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await Promise.all(
        APP_SHELL.map((url) =>
          cache.add(url).catch(() => {})
        )
      )
      await self.skipWaiting()
    })
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting()
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)

  if (request.method !== 'GET') return
  if (url.origin === self.location.origin && url.pathname.startsWith('/api')) return

  // App shell navigations: network-first, so a new build is picked up on the next load.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (cacheable(response)) put('/index.html', response.clone())
          return response
        })
        .catch(async () => (await caches.match('/index.html')) || (await caches.match('/')) || Response.error())
    )
    return
  }

  // Web fonts: cache-first with background refresh.
  if (FONT_HOSTS.has(url.hostname)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const network = fetch(request)
          .then((response) => {
            if (cacheable(response)) put(request, response.clone())
            return response
          })
          .catch(() => cached)
        return cached || network
      })
    )
    return
  }

  if (url.origin !== self.location.origin) return

  // Hashed build assets never change: serve from cache, fall back to network.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request).then((response) => {
        if (cacheable(response)) put(request, response.clone())
        return response
      }))
    )
    return
  }

  // Everything else (icons, manifest): stale-while-revalidate.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (cacheable(response)) put(request, response.clone())
          return response
        })
        .catch(() => cached)
      return cached || network
    })
  )
})
