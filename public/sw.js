const CACHE = 'qrfile-pwa-2026-10-02-1';
const ROOT = new URL('./', self.location.href).href;

async function precacheApp() {
  const cache = await caches.open(CACHE);
  const indexResponse = await fetch(ROOT, { cache: 'reload' });
  await cache.put(ROOT, indexResponse.clone());
  const html = await indexResponse.text();
  const urls = new Set([
    new URL('manifest.webmanifest', ROOT).href,
    new URL('icon.svg', ROOT).href,
    new URL('zxing_reader.wasm', ROOT).href,
  ]);
  for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
    try {
      const url = new URL(match[1], ROOT);
      if (url.origin === self.location.origin) urls.add(url.href);
    } catch (_) {}
  }
  await Promise.all([...urls].map(async (url) => {
    try {
      const response = await fetch(url, { cache: 'reload' });
      if (response.ok) await cache.put(url, response);
    } catch (_) {}
  }));
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheApp().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('qrfile-pwa-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(request);
        if (response.ok) await cache.put(ROOT, response.clone());
        return response;
      } catch (_) {
        return (await cache.match(ROOT)) || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(request);
    if (hit) return hit;
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  })());
});
