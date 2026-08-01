/* Fundi Sales service worker.

   The header badge has claimed "Works offline" since long before anything made
   it true. This is what makes it true: the shell is cached on install and
   served from cache first, so a reload with no signal opens the app instead of
   a dead page.

   Two things this deliberately does not do.

   It never calls skipWaiting() on its own. A rep may be halfway through a
   quote when a new build lands, and swapping the page under her would lose it.
   A waiting worker sits until the page asks, which it only does after she taps
   the toast.

   It does not rely on sw.js changing to notice a new build. This app deploys
   by copying index.html and nothing else, so the worker compares the shell it
   just fetched against the copy it holds and tells the page when they differ.
   Versioning the cache alone would have meant every index.html-only deploy
   going unnoticed until the worker itself happened to change. */

var CACHE = 'fundi-shell-v2';
var SHELL = [
  './',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];
/* Navigations are answered from this one entry. */
var DOC = './';

/* addAll() stores whatever the host hands back, redirect flag and all, and a
   response with that flag set is illegal as the answer to a navigation — the
   browser rejects respondWith and falls through to the dead network. Local
   `serve` 301s /index.html to /index, so the precached document was exactly
   that kind of response and offline failed on the one request that mattered.
   Rebuilding the response from its body drops the flag and makes this
   independent of how a given host spells the document's URL. */
function putClean(cache, url) {
  return fetch(url, { cache: 'reload' }).then(function (res) {
    if (!res || !res.ok) throw new Error('shell fetch failed: ' + url);
    return res.blob().then(function (body) {
      return cache.put(url, new Response(body, {
        status: 200,
        statusText: 'OK',
        headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream' }
      }));
    });
  });
}

self.addEventListener('install', function (e) {
  /* one failure fails the install: a half-cached shell is worse than none */
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(SHELL.map(function (u) { return putClean(c, u); }));
  }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (ks) {
        return Promise.all(ks.map(function (k) {
          return k === CACHE ? null : caches.delete(k);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function tellClients(msg) {
  return self.clients.matchAll({ type: 'window' }).then(function (cs) {
    cs.forEach(function (c) { c.postMessage(msg); });
  });
}

/* Serve the cached copy at once, then refresh it in the background. If the
   refreshed shell differs from what was served, say so — do not apply it. */
function shellFirst(url, isDoc) {
  return caches.open(CACHE).then(function (cache) {
    return cache.match(url, { ignoreSearch: true }).then(function (hit) {
      var net = fetch(url, { cache: 'no-cache' }).then(function (res) {
        if (!res || !res.ok || res.type === 'opaque') return res;
        if (isDoc && hit) {
          return Promise.all([hit.clone().text(), res.clone().text()])
            .then(function (both) {
              if (both[0] !== both[1]) {
                return putClean(cache, url).then(function () {
                  return tellClients({ type: 'UPDATED' });
                }).then(function () { return res; });
              }
              return res;
            })
            .catch(function () { return res; });
        }
        return putClean(cache, url).then(function () { return res; })
          .catch(function () { return res; });
      }).catch(function () { return hit; });
      return hit || net;
    });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;   /* wa.me and tel: are not ours */

  /* A navigation always resolves to the shell, so a deep reload offline still
     opens the app rather than the browser's error page. */
  if (req.mode === 'navigate') {
    e.respondWith(
      shellFirst(DOC, true).then(function (r) {
        return r || fetch(req);
      }).catch(function () { return fetch(req); })
    );
    return;
  }

  var path = url.pathname.split('/').pop() || '';
  if (!path) return;                                   /* the document, handled above */
  var isShell = SHELL.some(function (s) { return s.replace('./', '') === path; });
  if (isShell) e.respondWith(shellFirst('./' + path, false));
});
