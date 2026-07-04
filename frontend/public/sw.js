// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

const CACHE_NAME = 'shellorchestra-pwa-v4';
const CACHEABLE_PATHS = new Set([
  '/manifest.webmanifest',
  '/favicon.ico',
  '/favicon.svg',
  '/favicon-16x16.png',
  '/favicon-32x32.png',
  '/favicon-48x48.png',
  '/favicon-64x64.png',
  '/favicon-96x96.png',
  '/favicon-192x192.png',
  '/apple-touch-icon.png',
  '/apple-touch-icon-120x120.png',
  '/apple-touch-icon-152x152.png',
  '/apple-touch-icon-167x167.png',
  '/apple-touch-icon-180x180.png',
  '/pwa/shellorchestra_icon_1_64.png',
  '/pwa/shellorchestra_icon_1_96.png',
  '/pwa/shellorchestra_logo_1_120.png',
  '/pwa/shellorchestra_logo_1_128.png',
  '/pwa/shellorchestra_logo_1_144.png',
  '/pwa/shellorchestra_logo_1_152.png',
  '/pwa/shellorchestra_logo_1_192.png',
  '/pwa/shellorchestra_logo_1_256.png',
  '/pwa/shellorchestra_logo_1_384.png',
  '/pwa/shellorchestra_logo_1_512.png',
  '/pwa/shellorchestra_logo_1_maskable_512.png',
]);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll([...CACHEABLE_PATHS])).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (!CACHEABLE_PATHS.has(url.pathname)) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(event.request);
      if (cached) return cached;

      const response = await fetch(event.request);
      if (response.ok) await cache.put(event.request, response.clone());
      return response;
    }),
  );
});
