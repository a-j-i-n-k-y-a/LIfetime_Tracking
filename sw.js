/**
 * Service worker — makes the app installable and fully usable offline.
 *
 * The whole app is a handful of static files, so the shell is precached on
 * install and served cache-first. Bump CACHE whenever you ship a change,
 * otherwise returning visitors keep the old copy.
 */
var CACHE = 'lifetime-tracking-v1';

var SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/core.js',
  './js/app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE)
      .then(function (cache) { return cache.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (key) {
          return key === CACHE ? null : caches.delete(key);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(function (cached) {
      if (cached) return cached;

      return fetch(event.request)
        .then(function (response) {
          // Only cache same-origin successes; opaque cross-origin responses
          // would silently fill the cache with unusable entries.
          if (response.ok && new URL(event.request.url).origin === self.location.origin) {
            var copy = response.clone();
            caches.open(CACHE).then(function (cache) { cache.put(event.request, copy); });
          }
          return response;
        })
        .catch(function () {
          // Offline and not cached — fall back to the app shell for navigations.
          return event.request.mode === 'navigate' ? caches.match('./index.html') : Response.error();
        });
    })
  );
});
