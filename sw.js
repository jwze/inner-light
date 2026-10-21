/* Public shell only. Never intercept submissions, API calls or administration. */
'use strict';
importScripts('/vendor/version.js');
importScripts('/offline.js');
const CACHE_PREFIX = 'inner-light-public-';
const CACHE = `${CACHE_PREFIX}${self.INNER_LIGHT_ASSET_VERSION}`;
const ASSETS = ['/', '/index.html', '/style.css', '/core.js', '/effects.js', '/app.js', '/ui.js', '/ui.css', '/extensions.js', '/extensions.css', '/offline.js', '/vendor/version.js', '/vendor/qrcode.js', '/manifest.webmanifest', '/icon.svg', '/vendor/icon-192.png', '/vendor/icon-512.png'];
const STATIC = new Set(ASSETS.filter(path => !['/', '/index.html'].includes(path)));
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Fail installation rather than activate an incomplete offline shell.
    await cache.addAll(ASSETS.map(path => new Request(path, { cache: 'reload', credentials: 'same-origin' })));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await Promise.all((await caches.keys()).filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Explicit allowlist prevents even a navigation to /admin or /api from entering a cache.
  const publicNavigation = request.mode === 'navigate' && ['/', '/index.html'].includes(url.pathname);
  if (publicNavigation) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(request);
        if (response.ok && !response.redirected && response.headers.get('Content-Type')?.includes('text/html')) {
          // Search parameters select a planet at runtime; they are not cache keys.
          await cache.put('/index.html', response.clone());
        }
        return response;
      } catch (_) { return (await cache.match('/index.html')) || Response.error(); }
    })());
  } else if (STATIC.has(url.pathname) && !url.search && request.mode !== 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(url.pathname);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && !response.redirected) await cache.put(url.pathname, response.clone());
      return response;
    })());
  }
});
async function flushOutbox() {
  const result = await self.InnerLightOffline.flush();
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach(client => client.postMessage({ type: 'innerlight:flush' }));
  // Rejecting tells Background Sync to retry retained network/429 failures later.
  if (result.pending || result.busy) throw new Error('Outbox is still pending');
}
self.addEventListener('sync', event => {
  if (event.tag === self.InnerLightOffline.syncTag) event.waitUntil(flushOutbox());
});
self.addEventListener('message', event => {
  if (event.data?.type === 'innerlight:flush') event.waitUntil(flushOutbox().catch(() => {}));
});
