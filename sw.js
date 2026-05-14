// WWP Service Worker — Cache-first solo para recursos estáticos (NO HTML)
const CACHE = 'wwp-v2';
const STATIC = [
  '/manifest.json',
  '/icon-192.svg',
  '/icon-512.svg',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // API calls y SSE: siempre red (sin cache)
  if (url.pathname.startsWith('/api/') || url.pathname.includes('/notifications/stream')) {
    return;
  }
  // HTML: nunca cachear — siempre red para recibir versiones actualizadas
  if (url.pathname.endsWith('.html') || url.pathname === '/' || !url.pathname.includes('.')) {
    return;
  }
  // Recursos estáticos no-HTML: cache-first
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok && e.request.method === 'GET') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => new Response('Offline', {status: 503}));
    })
  );
});
