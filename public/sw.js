// Live Boston's service worker. It keeps the app itself on hand, so it opens
// instantly and survives a patchy connection. Live data (the MBTA, Amtrak,
// Bluebikes, weather) and map tiles always come straight from the network.

const CACHE = 'live-boston-v1';
const SCOPE = self.registration.scope;
/** Built files pile up across releases; keep only the most recent. */
const MAX_ENTRIES = 40;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll([SCOPE, `${SCOPE}manifest.webmanifest`, `${SCOPE}icons/icon-192.png`]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function put(request, response) {
  const cache = await caches.open(CACHE);
  await cache.put(request, response);
  const keys = await cache.keys();
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) await cache.delete(old);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || !request.url.startsWith(SCOPE)) return;

  if (request.mode === 'navigate') {
    // The page: fresh when online, the saved copy when not.
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) event.waitUntil(put(SCOPE, response.clone()));
          return response;
        })
        .catch(() => caches.match(SCOPE)),
    );
    return;
  }

  if (new URL(request.url).pathname.includes('/assets/')) {
    // Built files carry a content hash in their names, so a saved copy is never stale.
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((response) => {
            if (response.ok) event.waitUntil(put(request, response.clone()));
            return response;
          }),
      ),
    );
  }
});

// The leave-now reminder: tapping it brings the app forward.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => (list[0] ? list[0].focus() : self.clients.openWindow(SCOPE))),
  );
});
