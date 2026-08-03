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

/* ---- why this file changed, August 2026 --------------------------------
   The banner said "A new version is ready" and then did not deliver one. It
   reappeared on almost every navigation, and the only way to get a new build
   onto a device was to unregister the worker and delete the cache by hand.
   Two faults, compounding.

   One: the background refresh was never held open. shellFirst answered the
   request from cache and started a fetch-then-recache chain afterwards, but
   nothing called waitUntil on it. A service worker is killed as soon as its
   fetch event settles, so that chain was routinely aborted part-way: often
   late enough to have posted UPDATED to the page, and not late enough to have
   written the new document to the cache. The page reloaded, got the same old
   shell back, and put the banner up again. The banner was telling the truth
   about what it had seen and lying about what had happened.

   Two: the update check could not see an update. The first version of this
   file forced cache:'reload' on every navigation, which re-downloaded the
   whole document each time and measured slower than having no worker at all.
   The fix for that dropped to the default cache mode — which, against
   GitHub Pages' max-age, means the browser may answer from its own HTTP cache
   without going to the network, so the worker compared the old ETag with
   itself and concluded nothing had changed. no-cache is the mode that was
   wanted all along: it always revalidates and takes a 304, so an unchanged
   shell costs a header round-trip rather than 700KB.

   Verified by deploying against a live device rather than by reasoning. */
var VERSION = 'r5-activation-fix';
var CACHE = 'fundi-shell-v3';
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
      /* Keep the validators. Without them the only way to ask "has this
         changed?" is to download it again and compare the bytes, which is
         what made this worse than having no worker at all. */
      var h = { 'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream' };
      var et = res.headers.get('ETag'); if (et) h['ETag'] = et;
      var lm = res.headers.get('Last-Modified'); if (lm) h['Last-Modified'] = lm;
      return cache.put(url, new Response(body, { status: 200, statusText: 'OK', headers: h }));
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
/* The document's identity, as cheaply as the server will tell us. */
function stamp(res) {
  if (!res) return '';
  return res.headers.get('ETag') || res.headers.get('Last-Modified') || '';
}

/* `e` is the fetch event, and it is not optional. The refresh has to outlive
   the response or it does not happen: see the note at the top of this file. */
function shellFirst(e, url, isDoc) {
  return caches.open(CACHE).then(function (cache) {
    return cache.match(url, { ignoreSearch: true }).then(function (hit) {
      /* cache:'no-cache' revalidates rather than re-downloads. Against a
         server that sends validators an unchanged shell costs a 304 and no
         body, which is what makes checking on every navigation affordable. */
      var net = fetch(url, { cache: 'no-cache' }).then(function (res) {
        if (!res || !res.ok || res.type === 'opaque') return res;

        if (isDoc && hit) {
          var a = stamp(hit), b = stamp(res);
          /* No validators from the server means no cheap way to tell. Say
             nothing rather than claim an update on every single load. */
          if (!a || !b || a === b) return res;
          /* The page is told only after the new document is in the cache, so
             the reload it offers can actually deliver something. */
          return putClean(cache, url)
            .then(function () { return tellClients({ type: 'UPDATED' }); })
            .then(function () { return res; })
            .catch(function () { return res; });
        }
        return putClean(cache, url).then(function () { return res; })
          .catch(function () { return res; });
      }).catch(function () { return hit; });

      if (hit) {
        /* Answer from cache immediately and keep the worker alive until the
           refresh has finished. Without this the browser is entitled to kill
           the worker the moment the response is delivered, which is exactly
           what stopped every new build from landing. */
        if (e && typeof e.waitUntil === 'function') e.waitUntil(net);
        return hit;
      }
      return net;
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
      shellFirst(e, DOC, true).then(function (r) {
        return r || fetch(req);
      }).catch(function () { return fetch(req); })
    );
    return;
  }

  var path = url.pathname.split('/').pop() || '';
  if (!path) return;                                   /* the document, handled above */
  var isShell = SHELL.some(function (s) { return s.replace('./', '') === path; });
  if (isShell) e.respondWith(shellFirst(e, './' + path, false));
});
