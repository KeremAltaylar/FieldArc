/* FieldArc service worker.
   Tiles are cache-first and permanent — a forest has no signal, and a map you cannot see is
   the same as no map. Everything else is network-first so updates still arrive when online,
   falling back to cache when they do not. */

/* v2: the catch-all below used to intercept every non-tile, non-asset GET with no origin
   check, which meant it silently cached cross-origin API responses (Supabase auth/REST)
   once Task 1 gave the page something to call. Renaming evicts any cache that already
   holds one of those entries, since activate deletes every cache whose name is not
   current. TILES is untouched: those entries are expensive, permanent, and not implicated. */
var SHELL = "fieldarc-shell-v2";
var TILES = "fieldarc-tiles-v1";

var SHELL_FILES = [
  "./",
  "./index.html",
  "./places.geojson",
  "./src/pending.mjs",
  "https://unpkg.com/maplibre-gl@5/dist/maplibre-gl.js",
  "https://unpkg.com/maplibre-gl@5/dist/maplibre-gl.css"
];

var IS_TILE = /tile\.openstreetmap\.org|tile\.opentopomap\.org|arcgisonline\.com/;
var IS_ASSET = /unpkg\.com|fonts\.googleapis\.com|fonts\.gstatic\.com/;

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(SHELL).then(function (c) {
      /* One missing file must not fail the whole install. */
      return Promise.all(SHELL_FILES.map(function (u) {
        return c.add(new Request(u, { mode: "cors" })).catch(function () { return null; });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return (k === SHELL || k === TILES) ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") { return; }
  var url = e.request.url;

  if (IS_TILE.test(url)) {
    e.respondWith(
      caches.open(TILES).then(function (c) {
        return c.match(e.request).then(function (hit) {
          if (hit) { return hit; }
          return fetch(e.request).then(function (r) {
            if (r && r.status === 200) { c.put(e.request, r.clone()); }
            return r;
          });
        });
      })
    );
    return;
  }

  if (IS_ASSET.test(url)) {
    e.respondWith(
      caches.open(SHELL).then(function (c) {
        return c.match(e.request).then(function (hit) {
          return hit || fetch(e.request).then(function (r) {
            if (r && r.status === 200) { c.put(e.request, r.clone()); }
            return r;
          });
        });
      })
    );
    return;
  }

  /* IS_TILE and IS_ASSET above are the only cross-origin hosts this worker deliberately
     caches. Everything else must be same-origin, or it is left alone: no respondWith,
     so the browser performs the request normally. Before this check existed, the
     catch-all below silently intercepted and cached cross-origin API calls too — the
     Supabase auth/REST endpoints supabase-js talks to — which could serve a signed-out
     user a stale cached GET /auth/v1/user, or hand supabase-js this app's own HTML
     (status 200) as the offline fallback for a failed API call, which it then tries to
     parse as JSON. */
  if (new URL(url, self.location.origin).origin !== self.location.origin) { return; }

  /* Same origin: fresh when possible, cached when not. */
  e.respondWith(
    fetch(e.request).then(function (r) {
      if (r && r.status === 200) {
        var copy = r.clone();
        caches.open(SHELL).then(function (c) { c.put(e.request, copy); });
      }
      return r;
    }).catch(function () {
      return caches.match(e.request).then(function (hit) {
        return hit || caches.match("./index.html");
      });
    })
  );
});
