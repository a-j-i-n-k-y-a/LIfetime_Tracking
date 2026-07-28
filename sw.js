/**
 * Service worker — makes the app installable and fully usable offline.
 *
 * Strategy, and the reason for it:
 *
 *   app code (html, css, js, manifest)  network-first
 *   icons                               cache-first
 *
 * The first version of this served *everything* cache-first and only ever
 * refreshed when the CACHE string below changed. That meant any deploy which
 * did not also edit this file was invisible to anyone who had already visited:
 * they kept the old app forever, with no indication anything was stale. Several
 * releases shipped that nobody could see.
 *
 * Network-first fixes it at the cost of one request per file when online. The
 * whole app is well under 100KB, so that is a fair trade for never showing
 * someone a build from three deploys ago. Offline still works: every successful
 * response is written to the cache on the way past, and the cache answers as
 * soon as the network does not.
 *
 * Icons stay cache-first — they change about once a year and are the only files
 * here big enough to be worth avoiding.
 */
var CACHE = 'lifetime-tracking-v4';

var SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/core.js',
  './js/sync.js',
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

function store(request, response) {
  if (!response || !response.ok) return response;
  var copy = response.clone();
  caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
  return response;
}

/** Fresh when online, cached when not. */
function networkFirst(request) {
  return fetch(request)
    .then(function (response) { return store(request, response); })
    .catch(function () {
      return caches.match(request).then(function (cached) {
        if (cached) return cached;
        // An unvisited page while offline still gets the app shell, which can
        // render everything from local storage.
        return request.mode === 'navigate'
          ? caches.match('./index.html')
          : Response.error();
      });
    });
}

/** For files that effectively never change. */
function cacheFirst(request) {
  return caches.match(request).then(function (cached) {
    return cached || fetch(request).then(function (response) {
      return store(request, response);
    });
  });
}

self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;

  var url = new URL(event.request.url);

  // Leave anything cross-origin completely alone. In practice that means the
  // GitHub API: sync must always see the live gist and a real 304, never a
  // replayed cache entry, and routing authenticated CORS requests back through
  // the worker buys nothing.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    /\/icons\//.test(url.pathname)
      ? cacheFirst(event.request)
      : networkFirst(event.request)
  );
});
