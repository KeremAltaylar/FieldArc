# FieldArc 2.0 — Stage 4: deep links and taking a place offline

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A walk sent as a link opens on that walk, not on whatever place the recipient's
browser last remembered. A listener who taps "Take this place offline" is told the size before
anything downloads, then can drop the network entirely and the map, the archive and every
recording still work. A device that downloaded a place and comes back online to find the
setter has since edited it is told so, without the refresh ever overwriting a walk in progress.

**Architecture:** Three additions, each independent of the other two. First, a static
`404.html` (the standard GitHub Pages SPA-redirect trick) turns an unknown path into a query
string index.html restores via `history.replaceState`, so `/FieldArc/R8845862/<route-id>`
resolves to the running app with that place and route selected — no server, no build step, no
new hosting config beyond the one extra file. Second, the reverse direction: selecting a
feature already writes the current place and selection into the address bar, so there is
nothing separate to "share" — the URL bar already names what is on screen. Third, "Take this
place offline" is the existing `#offline` button taught two new things it does not do today:
state a size before committing, and pull every feature, patch and recording for the place into
IndexedDB (tiles already cache; nothing here changes tile caching). A stored download carries
the count and latest `updated_at` of the rows it came from — the one new thing the server has
to expose — so a later online load can tell it apart from the place having moved on since.

**Tech Stack:** Same as stages 1–3 — `@supabase/supabase-js` v2 UMD, Postgres 17.6, Node 24
`node:test` against the live project. No new library, no new service. `history.pushState` /
`history.replaceState` are the only new browser APIs, both already universal.

**Spec:** `docs/superpowers/specs/2026-09-10-platform-design.md`

## Global Constraints

- **Online is the default; offline is prepared.** Opening a link must work with no
  preparation. Nothing in this stage may make the online path depend on anything downloaded.
- **Offline means every recording in the place**, fetched in one pass, so nothing can go
  missing mid-walk. The app states the total size before the listener commits to the download.
- **A downloaded place records the server version it came from.** Opening it online when the
  server has moved on says so and offers a refresh; it must never auto-overwrite a device that
  might be mid-walk.
- **The app is the front door; there is one URL.** No directory page, no separate route for a
  deep link — `/:place/:route` resolves into the same running app the place picker opens.
- **No build step.** The deployed artifact stays a static file set — one new static file
  (`404.html`) is allowed; a bundler or a server-side rewrite is not.
- **Nothing that works offline today may start requiring a network.** A setter's capture path
  (Mark, trace, attach-audio) is untouched by this stage, same as every stage before it.
- Commit messages: a declarative sentence, then what it prevents or what was measured.

## What stage 3 left for this stage

- There is no routing at all: `index.html` always opens on `localStorage`'s remembered place
  (or Belgrad Ormanı) and nothing is ever selected on load. A link to a specific walk is
  indistinguishable from a link to the app.
- Selecting a feature never touches the address bar, so there is no URL to send in the first
  place — a setter who wants to share a walk today has no link that names it.
- `#offline` ("Download map") caches only basemap tiles. A place taken "offline" this way still
  needs a network for its archive (`fetchPublished`) and its recordings (`audioBlob`'s
  storage fallback) — exactly the two things stage 3 built to require the network in the first
  place for a fresh browser.
- `public_features` carries `created_at` but not `updated_at`, so nothing server-side exists
  yet for a client to compare "what I downloaded" against "what is there now."

## File Structure

| File | Responsibility |
| --- | --- |
| `404.html` | GitHub Pages' only hook for an unknown path: redirects it into `index.html` with the real path preserved in the query string |
| `index.html` | `parseDeepLink`, URL-reflects-selection, offline size estimate + download, staleness check |
| `supabase/migrations/0017_public_features_updated_at.sql` | Exposes `updated_at` — the one new thing a downloaded place can compare itself against |
| `tests/deeplink.test.mjs` | `parseDeepLink` and the URL-building side, read from the page |
| `tests/offline-download.test.mjs` | `offlineBytes`, `placeVersion`, `sameVersion`, and the download/staleness flow's shape |

---

### Task 1: The view tells a downloaded place how to know it is stale

**Files:**
- Create: `supabase/migrations/0017_public_features_updated_at.sql`
- Modify: `tests/fuzz.test.mjs`
- Modify: `index.html` (new `placeVersion()`, `sameVersion()`, near `mergeRemote` at
  `index.html:1733`)
- Test: `tests/offline-download.test.mjs` (created here, extended in later tasks)

**Interfaces:**
- Produces: `updated_at` on every `public_features` row. `placeVersion(rows)` — takes an array
  of rows shaped like a `public_features` response and returns
  `{ count: number, maxUpdatedAt: string|null }`. `sameVersion(a, b)` — true only if both
  `count` and `maxUpdatedAt` match. Both attached to `window.__fa.offline` for later tasks and
  the browser-level check in Task 6.

- [ ] **Step 1: Write the failing test**

```js
// tests/fuzz.test.mjs — append after "an open published point is returned exactly"
test("an open published point carries updated_at, not just created_at", async () => {
  const { data } = await db.from("public_features").select("*").eq("id", ids.open).single();
  assert.ok(data.updated_at, "updated_at must be exposed for a downloaded place to compare against");
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test`
Expected: FAIL — `data.updated_at` is `undefined`.

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/0017_public_features_updated_at.sql

-- The one new thing a downloaded place needs from the server: when a row last changed. 0014's
-- view exposes created_at but not updated_at, so nothing today lets a client tell "the archive
-- I downloaded" apart from "the archive as it is now" without refetching every row's full
-- content and diffing it by hand. updated_at is already maintained by features_touch (0001)
-- on every write; this migration only widens what the view selects, not what it computes.
--
-- Not sensitive: unlike geometry, "when a row last changed" carries no location information,
-- so it needs no fuzzing and no stripping alongside sensitive/fuzz_m.

create or replace view public.public_features
with (security_invoker = off) as
select f.id, f.place, f.kind, f.geometry_public as geometry,
  (f.properties - 'sensitive' - 'fuzz_m')
    || case when (f.properties->>'sensitive')::boolean is true and f.kind = 'point'
            then jsonb_build_object('fuzzed', true) else '{}'::jsonb end as properties,
  f.created_at, f.updated_at
from public.features f
where f.deleted_at is null and (f.properties->>'published')::boolean is true;

grant select on public.public_features to anon, authenticated;
```

- [ ] **Step 4: Apply the migration**

Run: `npm run db:apply`
Expected: `0017_public_features_updated_at.sql` applied; a second run does nothing.

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: the new test passes; `tests/grants.test.mjs` still shows `anon` reaching exactly
`public_features:SELECT` — a new column changes nothing about the grant.

- [ ] **Step 6: Write `placeVersion` and `sameVersion` as failing tests first**

```js
// tests/offline-download.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8");

function slice(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  assert.ok(start !== -1, `start marker not found: ${startMarker}`);
  const end = html.indexOf(endMarker);
  assert.ok(end !== -1, `end marker not found: ${endMarker}`);
  assert.ok(end > start, `"${endMarker}" occurs at or before "${startMarker}"`);
  return html.slice(start, end);
}

test("placeVersion counts rows and finds the latest updated_at", () => {
  const src = slice("function placeVersion(", "function sameVersion(");
  assert.match(src, /rows\.length/, "count must come from the rows given, not a stored total");
  assert.match(src, /updated_at/, "the max must be read from each row's updated_at");
});

test("sameVersion compares both count and maxUpdatedAt", () => {
  const src = slice("function sameVersion(", "function ");
  assert.match(src, /count/);
  assert.match(src, /maxUpdatedAt/);
});
```

- [ ] **Step 7: Run it to confirm it fails**

Run: `npm test`
Expected: FAIL — neither function exists yet.

- [ ] **Step 8: Write the functions**

Add directly after `mergeRemote` in `index.html` (it currently ends at `index.html:1741`):

```js
  /* The server-version signal a downloaded place compares itself against. Deliberately not a
     single opaque hash: count catches a deletion (maxUpdatedAt alone would not move), and
     maxUpdatedAt catches an edit to an existing row (count alone would not move). Either
     changing means the place has moved on since the download. */
  function placeVersion(rows) {
    var max = null;
    rows.forEach(function (r) {
      if (r.updated_at && (!max || r.updated_at > max)) { max = r.updated_at; }
    });
    return { count: rows.length, maxUpdatedAt: max };
  }

  function sameVersion(a, b) {
    return !!a && !!b && a.count === b.count && a.maxUpdatedAt === b.maxUpdatedAt;
  }
```

- [ ] **Step 9: Expose for later tasks and the browser check**

Near `window.__fa.mergeRemote = mergeRemote;` (`index.html:2923`):

```js
  window.__fa.offline = { version: placeVersion, sameVersion: sameVersion };
```

- [ ] **Step 10: Run the tests**

Run: `npm test && npm run check`
Expected: all pass.

- [ ] **Step 11: Commit**

```bash
git add supabase/migrations/0017_public_features_updated_at.sql tests/fuzz.test.mjs \
        tests/offline-download.test.mjs index.html
git commit -m "A downloaded place can tell it has moved on, from a count and a timestamp"
```

---

### Task 2: A shared link opens on the place and route it names

**Files:**
- Create: `404.html`
- Modify: `index.html` (`loadPlaces()` at `index.html:2780`, `setPlace()` at `index.html:2802`)
- Test: `tests/deeplink.test.mjs`

**Interfaces:**
- Consumes: `setPlace(p, initial)`, `setSelected(id, reveal)`, `byId(id)`, `places` (all
  already in the page).
- Produces: `parseDeepLink(pathname)` — returns `{ place, route }` (route may be `null`) or
  `null` if the path names nothing. `setPlace` now **returns** the promise `fetchPublished`
  gives back, so a caller can chain work onto "the archive for this place has arrived."

The redirect trick: GitHub Pages serves `404.html` for any path it does not recognise as a
file, which is every `/:place/:route` URL — there is no such file on disk. `404.html` rewrites
that path into a query string and redirects to the site root; `index.html` reads the query
string on load and calls `history.replaceState` to put the real-looking path back in the
address bar without a second navigation. `pathSegmentsToKeep = 1` below matches this repo's
GitHub Pages project-page base (`/FieldArc/`) — the deployed base itself, not the place or
route, which is exactly why it is a constant here rather than something `parseDeepLink` has to
infer.

- [ ] **Step 1: Write the failing test**

```js
// tests/deeplink.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";

const html = readFileSync("index.html", "utf8");

test("404.html exists and redirects into index.html with the path preserved", () => {
  assert.ok(existsSync("404.html"), "GitHub Pages needs 404.html at the repo root to catch deep links");
  const redirect = readFileSync("404.html", "utf8");
  assert.match(redirect, /pathSegmentsToKeep/, "the base-path constant must be explicit, not inferred");
  assert.match(redirect, /location\.replace/);
});

test("parseDeepLink strips BASE_PATH before reading segments", () => {
  const start = html.indexOf("var BASE_PATH");
  assert.ok(start !== -1, "BASE_PATH must exist — segment-counting alone cannot tell a bare " +
    "place link at the site root apart from the site root itself");
  const src = html.slice(start, html.indexOf("function setPlace"));
  assert.match(src, /function parseDeepLink\(/);
  assert.match(src, /BASE_PATH/, "parseDeepLink must strip BASE_PATH, not guess it from segment count");
  assert.match(src, /split\(\s*["']\/["']\s*\)/, "must split the remainder on /");
  assert.match(src, /index\.html/, "must ignore a literal index.html segment from a direct file open");
});

test("setPlace returns fetchPublished's promise, so a deep link can chain past it", () => {
  const start = html.indexOf("function setPlace(p, initial)");
  const src = html.slice(start, html.indexOf("function renderPlaceList"));
  assert.match(src, /return fetchPublished\(/, "setPlace must hand back the fetch it triggers");
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test`
Expected: FAIL — `404.html` does not exist, `parseDeepLink` does not exist, `setPlace` does not
return anything.

- [ ] **Step 3: Write `404.html`**

```html
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>FieldArc</title>
<script>
  /* The standard GitHub-Pages SPA redirect (rafgraph/spa-github-pages), trimmed to this
     repo's one case: a project page one level deep (/FieldArc/...), no extra query params
     or hash to round-trip beyond what a deep link itself carries.
     pathSegmentsToKeep = 1 keeps "/FieldArc" and rewrites everything after it into "?p=". */
  var pathSegmentsToKeep = 1;
  var l = window.location;
  var base = l.pathname.split("/").slice(0, 1 + pathSegmentsToKeep).join("/");
  var rest = l.pathname.slice(base.length);
  l.replace(l.protocol + "//" + l.hostname + (l.port ? ":" + l.port : "") +
    base + "/?p=" + encodeURIComponent(rest) + (l.search ? "&" + l.search.slice(1) : "") + l.hash);
</script>
</head>
<body></body>
</html>
```

- [ ] **Step 4: Restore the real path in `index.html`**

Add near the very top of the main `<script>`, before `var $ = function (s) ...` (`index.html:1683`)
so it runs before anything else reads `location`:

```js
  /* The other half of 404.html's redirect: turn "?p=/R8845862/<route-id>" back into
     "/FieldArc/R8845862/<route-id>" in the address bar, with no second navigation and no
     entry added to history — a listener who taps back should leave the app, not land on
     the redirect's own intermediate URL. */
  (function restoreDeepLinkPath() {
    var p = new URLSearchParams(location.search).get("p");
    if (!p) { return; }
    var qs = new URLSearchParams(location.search);
    qs.delete("p");
    var rest = qs.toString();
    history.replaceState(null, "", location.pathname.replace(/\/$/, "") + p +
      (rest ? "?" + rest : "") + location.hash);
  })();

  /* Matches 404.html's pathSegmentsToKeep = 1: the deployed GitHub Pages project page is
     rooted one segment deep ("/FieldArc"), so a deep link's own segments start after that.
     Local development (npx serve . from the repo root) is rooted at "/", with no base
     segment at all. Hardcoded rather than counted from the current path, because counting
     cannot tell "a bare place link at the site root" apart from "the site root with no link"
     — both are exactly one path segment, and only knowing which host this is resolves it. */
  var BASE_PATH = location.hostname === "keremaltaylar.github.io" ? "/FieldArc" : "";

  function parseDeepLink(pathname) {
    var rest = pathname.indexOf(BASE_PATH) === 0 ? pathname.slice(BASE_PATH.length) : pathname;
    var parts = rest.split("/").filter(function (s) { return s && s !== "index.html"; });
    if (!parts.length) { return null; }
    if (parts.length === 1) { return { place: parts[0], route: null }; }
    return { place: parts[0], route: parts[1] };
  }
```

- [ ] **Step 5: Make `setPlace` return its fetch, and select a route once it resolves**

`index.html:2802`–`2844` currently ends:

```js
    setSelected(null);
    closePlaceMenu();
    commit();
    fetchPublished(place ? place.properties.id : DEFAULT_PLACE);
  }
```

Change the last line to return the promise:

```js
    setSelected(null);
    closePlaceMenu();
    commit();
    return fetchPublished(place ? place.properties.id : DEFAULT_PLACE);
  }
```

- [ ] **Step 6: Resolve the deep link once places load**

`index.html:2780`–`2793` currently:

```js
  function loadPlaces() {
    fetch("places.geojson").then(function (r) {
      if (!r.ok) { throw new Error("HTTP " + r.status); }
      return r.json();
    }).then(function (data) {
      places = data.features;
      renderPlaceList();
      var want = localStorage.getItem(PLACE_KEY) || DEFAULT_PLACE;
      setPlace(byId(want) || byId(DEFAULT_PLACE) || places[0], true);
    }).catch(function (err) {
      $("#saved").textContent = "Place catalogue unavailable (" + err.message +
        ") — open via the local server, not file://.";
    });
  }
```

Change to let a deep link's place win over the remembered one, and select its route once the
archive for that place has arrived:

```js
  function loadPlaces() {
    fetch("places.geojson").then(function (r) {
      if (!r.ok) { throw new Error("HTTP " + r.status); }
      return r.json();
    }).then(function (data) {
      places = data.features;
      renderPlaceList();
      var link = parseDeepLink(location.pathname);
      var want = (link && link.place) || localStorage.getItem(PLACE_KEY) || DEFAULT_PLACE;
      var p = byId(want) || byId(DEFAULT_PLACE) || places[0];
      setPlace(p, true).then(function () {
        /* feature() reads fc.features, which mergeRemote (inside fetchPublished) has just
           populated for a fresh browser — the exact gap stage 3 closed for the map, now
           closed for a link too. A route id that names nothing (stale link, wrong place)
           leaves the app on the place alone rather than failing. */
        if (link && link.route && feature(link.route)) { setSelected(link.route, true); }
      });
    }).catch(function (err) {
      $("#saved").textContent = "Place catalogue unavailable (" + err.message +
        ") — open via the local server, not file://.";
    });
  }
```

- [ ] **Step 7: Run the tests**

Run: `npm test && npm run check`
Expected: all pass.

- [ ] **Step 8: Verify in a browser**

`404.html`'s own redirect is only realistic once this is actually deployed under
`/FieldArc/` — locally, `npx serve .` roots the site at `/`, so a 404 there would compute the
wrong base entirely (this is a known limitation of the GitHub-Pages 404 trick, not something
to chase locally). Verify the two halves separately:

Locally: serve the repo, visit `/` — the app opens normally on the remembered place. Then
visit `index.html?p=/R8845862/<a real published route id>` directly, which is exactly what
`404.html` would have redirected to in production — confirm `restoreDeepLinkPath` rewrites the
address bar to `/R8845862/<route id>` and the app opens on Belgrad Ormanı with that route
selected and its card open. Try a nonsense route id under a real place — confirm the place
still loads and nothing throws.

The full chain — an actual `/FieldArc/R8845862/<route id>` URL 404ing to `404.html` and
redirecting correctly — gets its own check in Task 6 against the deployed GitHub Pages site,
once this stage is pushed.

- [ ] **Step 9: Commit**

```bash
git add 404.html index.html tests/deeplink.test.mjs
git commit -m "A link naming a place and a route opens on that place and that route"
```

---

### Task 3: Selecting a route updates the address bar, so sharing is just copying it

**Files:**
- Modify: `index.html` (`setSelected` at `index.html:2992`, `setPlace` at `index.html:2802`)
- Test: `tests/deeplink.test.mjs` (appended)

**Interfaces:**
- Consumes: `place`, `selected` (both already tracked), `history.pushState`.
- Produces: `urlForSelection(placeId, routeId)` — the path string `setSelected` and `setPlace`
  push. Exposed at `window.__fa.deepLink` for the browser check in Task 6.

Only a **route** selection is worth a link — the spec's deep link is "a single walk," and a
point's recording is heard in place on the map it already lives on, not sent as its own
destination. Selecting a point, deselecting, or switching place with nothing selected all
collapse the URL back to `/:place`.

- [ ] **Step 1: Write the failing test**

```js
// tests/deeplink.test.mjs — appended
test("urlForSelection names only a route, never a point", () => {
  const start = html.indexOf("function urlForSelection(");
  const src = html.slice(start, html.indexOf("function ", start + 30));
  assert.match(src, /kind\s*===?\s*["']route["']/, "a point must not become the URL's target");
});

test("setSelected pushes the URL, and setPlace's own URL update comes first", () => {
  const setSel = html.slice(html.indexOf("function setSelected("), html.indexOf("function feature("));
  assert.match(setSel, /pushState|replaceState/, "selecting must update the address bar");
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test`
Expected: FAIL — `urlForSelection` does not exist, `setSelected` touches no history API.

- [ ] **Step 3: Write `urlForSelection` and call it from both places**

Add next to `parseDeepLink` (Task 2, Step 4):

```js
  /* The inverse of parseDeepLink, built on the same BASE_PATH constant rather than by
     stripping segments off the CURRENT address bar — by the second selection in a session
     the current bar already ends in the PREVIOUS place and route, not the site's own root,
     so re-deriving the base from it on every call would drift after the first selection. */
  function urlForSelection(placeId, routeId) {
    return BASE_PATH + "/" + placeId + (routeId ? "/" + routeId : "");
  }
```

`index.html:2992`–`3012`, `setSelected` currently ends:

```js
    renderDetail();
    renderList();
    renderLabels();
  }
```

Change to:

```js
    renderDetail();
    renderList();
    renderLabels();
    var f = id ? feature(id) : null;
    var routeId = (f && f.properties.kind === "route") ? f.properties.id : null;
    if (place) {
      history.pushState(null, "", urlForSelection(place.properties.id, routeId));
    }
  }
```

`setPlace` already calls `setSelected(null)` on `index.html:2840` before its own `commit()` /
`return fetchPublished(...)` — that call already pushes the bare `/:place` URL through the
change above, so `setPlace` itself needs no separate history call.

- [ ] **Step 4: Guard the very first call**

`setSelected(null)` runs once during `loadPlaces()`'s initial `setPlace(p, true)`, before
`urlForSelection` has anything place-specific to say beyond what `restoreDeepLinkPath` (Task 2,
Step 4) already put in the bar. That is fine — pushing `/:place` again is idempotent — but it
must not fire before `place` itself is assigned. `setPlace` assigns `place = p;` as its first
line (`index.html:2804`), and calls `setSelected(null)` afterward, so this ordering already
holds; no change needed here beyond confirming it in the browser check below.

- [ ] **Step 5: Expose for the browser check**

Near `window.__fa.offline = ...` (Task 1, Step 9):

```js
  window.__fa.deepLink = { parse: parseDeepLink, url: urlForSelection };
```

- [ ] **Step 6: Run the tests**

Run: `npm test && npm run check`
Expected: all pass.

- [ ] **Step 7: Verify in a browser**

Serve locally, select a route: confirm the address bar shows `/:place/:route-id`. Select a
point instead: confirm the bar drops back to `/:place`. Switch places with nothing selected:
confirm the bar shows only the new place. Copy the route URL, open it in a private window:
confirm it lands on that route per Task 2. Confirm no new browser-history entry is added for
every intermediate click while dragging or hovering — only actual selection changes should
call `pushState`, which is already true since `setSelected` only runs on an actual selection
change.

- [ ] **Step 8: Commit**

```bash
git add index.html tests/deeplink.test.mjs
git commit -m "Selecting a route is sharing it — the address bar already says which one"
```

---

### Task 4: "Take this place offline" states its size, then fetches everything

**Files:**
- Modify: `index.html` (`db()`/`idb()` at `index.html:3530`, the `#offline` handler at
  `index.html:10071`)
- Test: `tests/offline-download.test.mjs` (appended)

**Interfaces:**
- Consumes: `place`, `fc.features`, `feature(id)`, `HIT_SLOTS`, `audioBlob(key, path)`,
  `tileURLs(bbox, zmin, zmax)`, `activeBase()`, `RASTER`, `placeVersion(rows)` (Task 1).
- Produces: `idb(mode, storeName, fn)` — the existing IndexedDB helper, widened to take a
  store name. `offlineBytes(rows)` — sums every recording's already-known byte size out of
  `public_features` rows, no network call needed. `putPlaceSnapshot(id, snap)` /
  `getPlaceSnapshot(id)` — the new `places` object store. `downloadPlace(place)` — takes the
  same place-feature object `setPlace` holds (not a bare id, since it needs `.properties.bbox`
  for `cacheTiles`), and runs the actual fetch. All attached to `window.__fa.offline`.

The size estimate reads `properties.audio.size` and `properties.hits[slot].size` — both
already written at capture time (`index.html:4811`, `index.html:4067`) and both already
present in a `public_features` row, since the view strips only `sensitive`/`fuzz_m` and
nothing else. No `storage.list()` round trip, no new grant: the number was already in hand.

- [ ] **Step 1: Write the failing test**

```js
// tests/offline-download.test.mjs — appended
test("offlineBytes sums a recording's own size and every hit's own size", () => {
  const start = html.indexOf("function offlineBytes(");
  const src = html.slice(start, html.indexOf("function ", start + 20));
  assert.match(src, /properties\.audio/);
  assert.match(src, /properties\.hits/);
  assert.doesNotMatch(src, /storage\.from/, "the estimate must not cost a network call");
});

test("the IndexedDB helper takes a store name, so places and audio can share one database", () => {
  const src = slice("function idb(", "function putAudio(");
  assert.match(src, /storeName/);
});

test("downloadPlace writes a places snapshot carrying its own version", () => {
  const src = slice("function downloadPlace(", "$(\"#offline\")");
  assert.match(src, /putPlaceSnapshot/);
  assert.match(src, /placeVersion/);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test`
Expected: FAIL — none of these exist yet.

- [ ] **Step 3: Widen the IndexedDB helper**

`index.html:3529`–`3552` currently:

```js
  var dbp = null;
  function db() {
    if (!dbp) {
      dbp = new Promise(function (res, rej) {
        var r = indexedDB.open("fieldarc", 1);
        r.onupgradeneeded = function () { r.result.createObjectStore("audio"); };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
      });
    }
    return dbp;
  }
  function idb(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (res, rej) {
        var tx = d.transaction("audio", mode), req = fn(tx.objectStore("audio"));
        tx.oncomplete = function () { res(req && req.result); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }
  function putAudio(id, blob) { return idb("readwrite", function (st) { return st.put(blob, id); }); }
  function getAudio(id) { return idb("readonly", function (st) { return st.get(id); }); }
  function delAudio(id) { return idb("readwrite", function (st) { return st.delete(id); }); }
```

Change to add a second object store and take its name as a parameter:

```js
  var dbp = null;
  function db() {
    if (!dbp) {
      dbp = new Promise(function (res, rej) {
        var r = indexedDB.open("fieldarc", 2);
        r.onupgradeneeded = function () {
          var d = r.result;
          if (!d.objectStoreNames.contains("audio")) { d.createObjectStore("audio"); }
          /* Keyed by place id, one row per downloaded place: the raw public_features rows
             (so a cold reload has the archive without a fetch) plus the version they were
             downloaded at (Task 5 compares against it) and when. */
          if (!d.objectStoreNames.contains("places")) { d.createObjectStore("places"); }
        };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
      });
    }
    return dbp;
  }
  function idb(mode, storeName, fn) {
    return db().then(function (d) {
      return new Promise(function (res, rej) {
        var tx = d.transaction(storeName, mode), req = fn(tx.objectStore(storeName));
        tx.oncomplete = function () { res(req && req.result); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }
  function putAudio(id, blob) { return idb("readwrite", "audio", function (st) { return st.put(blob, id); }); }
  function getAudio(id) { return idb("readonly", "audio", function (st) { return st.get(id); }); }
  function delAudio(id) { return idb("readwrite", "audio", function (st) { return st.delete(id); }); }
  function putPlaceSnapshot(id, snap) { return idb("readwrite", "places", function (st) { return st.put(snap, id); }); }
  function getPlaceSnapshot(id) { return idb("readonly", "places", function (st) { return st.get(id); }); }
```

- [ ] **Step 4: Write `offlineBytes`**

Add next to `placeVersion` (Task 1, Step 8):

```js
  /* Every byte this place would cost to take offline, read from data already in hand — a
     public_features row already carries properties.audio.size (set at attach time,
     index.html:4811) and properties.hits[slot].size (index.html:4067) for a rhythm point's
     one-shots. Nothing here asks the network, so showing this number costs nothing extra
     over the fetch the download needs anyway. */
  function offlineBytes(rows) {
    var total = 0;
    rows.forEach(function (row) {
      var p = row.properties || {};
      if (p.audio && typeof p.audio.size === "number") { total += p.audio.size; }
      if (p.hits) {
        HIT_SLOTS.forEach(function (slot) {
          var h = p.hits[slot];
          if (h && typeof h === "object" && typeof h.size === "number") { total += h.size; }
        });
      }
    });
    return total;
  }

  function fmtBytes(n) {
    if (n < 1024) { return n + " B"; }
    if (n < 1024 * 1024) { return Math.round(n / 1024) + " KB"; }
    return (n / (1024 * 1024)).toFixed(1) + " MB";
  }
```

- [ ] **Step 5: Extract the existing tile-caching loop into its own function**

`index.html:10071`–`10111` currently runs tile caching directly inside the click handler. Pull
the caching itself out so `downloadPlace` can call it alongside the new work, leaving the
handler to orchestrate:

```js
  function cacheTiles(p, onProgress) {
    if (!RASTER[activeBase()]) { return Promise.resolve({ tiles: 0, failed: 0 }); }
    var bb = p.properties.bbox, zmin = 11, zmax = 15, urls = tileURLs(bb, zmin, zmax);
    while (urls.length > 900 && zmax > zmin) { zmax--; urls = tileURLs(bb, zmin, zmax); }
    var done = 0, failed = 0;
    return caches.open("fieldarc-tiles-v1").then(function (c) {
      var i = 0;
      function next() {
        if (i >= urls.length) { return Promise.resolve(); }
        var u = urls[i++];
        return c.match(u).then(function (hit) {
          if (hit) { return null; }
          return fetch(u, { mode: "cors" }).then(function (r) {
            if (r && r.status === 200) { return c.put(u, r); }
            failed++;
          }).catch(function () { failed++; });
        }).then(function () {
          done++;
          if (onProgress) { onProgress(done, urls.length); }
          return next();
        });
      }
      var lanes = [];
      for (var k = 0; k < 6; k++) { lanes.push(next()); }
      return Promise.all(lanes);
    }).then(function () { return { tiles: urls.length, failed: failed, zmax: zmax }; });
  }
```

- [ ] **Step 6: Write `downloadPlace`**

```js
  /* Every feature, patch and recording for one place, so a walk needs no network afterward.
     Sequential audio fetches, same reasoning as publish()'s uploads (index.html:2272): this
     runs over a phone connection at the edge of a forest's signal, and parallel requests
     there are how a download half-finishes instead of finishing slowly. */
  function downloadPlace(p) {
    return sb.from("public_features").select("*").eq("place", p.properties.id)
      .then(function (r) {
        if (r.error || !r.data) { return Promise.reject(new Error(r.error ? r.error.message : "no data")); }
        var rows = r.data;
        var jobs = [];
        rows.forEach(function (row) {
          var props = row.properties || {};
          if (props.storage_path) { jobs.push(function () { return audioBlob(row.id, props.storage_path); }); }
          if (props.hits) {
            HIT_SLOTS.forEach(function (slot) {
              var h = props.hits[slot];
              if (h && typeof h === "object" && h.storage_path) {
                jobs.push(function () { return audioBlob(row.id + "#" + slot, h.storage_path); });
              }
            });
          }
        });
        var audio = jobs.reduce(function (chain, job) { return chain.then(job); }, Promise.resolve());
        return audio.then(function () { return cacheTiles(p); }).then(function (tileResult) {
          return putPlaceSnapshot(p.properties.id, {
            name: p.properties.name,
            downloadedAt: new Date().toISOString(),
            version: placeVersion(rows),
            features: rows
          }).then(function () { return { rows: rows.length, tiles: tileResult.tiles }; });
        });
      });
  }
```

- [ ] **Step 7: Rewrite the `#offline` handler as arm-then-confirm**

`index.html:10071`–`10111` (after Step 5 has moved the tile loop out) becomes:

```js
  var offlineArmed = null;   /* the place id the button is currently primed to download */
  $("#offline").addEventListener("click", function () {
    var btn = this;
    if (!place) { toast("No place selected"); return; }
    if (!sb) { toast("Offline archive download needs a connection — tiles alone still work below"); return; }
    if (offlineArmed !== place.properties.id) {
      btn.disabled = true;
      sb.from("public_features").select("*").eq("place", place.properties.id).then(function (r) {
        btn.disabled = false;
        if (r.error || !r.data) { toast("Could not size this place — check the connection"); return; }
        offlineArmed = place.properties.id;
        var bytes = offlineBytes(r.data);
        btn.textContent = "Confirm " + fmtBytes(bytes) + " — tap again";
        $("#saved").textContent = r.data.length + " features, " + fmtBytes(bytes) +
          " of recordings, plus map tiles. Tap Download again to fetch it all.";
      });
      return;
    }
    offlineArmed = null;
    btn.disabled = true;
    btn.textContent = "Downloading…";
    downloadPlace(place).then(function (result) {
      btn.disabled = false;
      btn.textContent = "Download map";
      toast(place.properties.name + " saved — " + result.rows + " features, " + result.tiles + " tiles");
      $("#saved").textContent = place.properties.name + " is available offline as of " +
        new Date().toLocaleString() + ".";
    }, function (err) {
      btn.disabled = false;
      btn.textContent = "Download map";
      toast("Download failed: " + (err.message || err));
    });
  });
```

- [ ] **Step 8: Reset the armed state on place change**

Without this, switching away from an armed place and back shows a stale size estimate instead
of re-measuring it. As left by Task 2's Step 5, `setPlace` ends:

```js
    setSelected(null);
    closePlaceMenu();
    commit();
    return fetchPublished(place ? place.properties.id : DEFAULT_PLACE);
  }
```

Insert the reset before the `return` — it must not touch what that line returns:

```js
    setSelected(null);
    closePlaceMenu();
    commit();
    offlineArmed = null;
    $("#offline").textContent = "Download map";
    return fetchPublished(place ? place.properties.id : DEFAULT_PLACE);
  }
```

`offlineArmed` and `$("#offline")` are both declared above this point once Step 7 has run, so
ordering in the file is not an issue — `setPlace` only executes after the whole script has
parsed.

- [ ] **Step 9: Expose for the browser check**

Extend the `window.__fa.offline` assignment from Task 1, Step 9:

```js
  window.__fa.offline = { version: placeVersion, sameVersion: sameVersion,
    bytes: offlineBytes, run: downloadPlace, snapshot: getPlaceSnapshot };
```

- [ ] **Step 10: Run the tests**

Run: `npm test && npm run check`
Expected: all pass, including `tests/offline.test.mjs`'s existing `save() writes locally and
does not publish` test — `downloadPlace` never calls `save()` or touches `fc`/`localStorage`,
only the new `places` IndexedDB store, so a setter's own local mirror is untouched by it.

- [ ] **Step 11: Verify in a browser**

Serve locally, sign out, pick a place with at least one published recording. Click "Download
map": confirm the button shows a byte count and `#saved` states feature/recording counts before
anything downloads. Click again: confirm it downloads, then `window.__fa.offline.snapshot(placeId)`
resolves to an object with `features`, `version` and `downloadedAt`. Turn off networking (or use
devtools' offline throttling), reload: confirm points still play their recordings and the map
still shows tiles at the cached zoom range.

- [ ] **Step 12: Commit**

```bash
git add index.html tests/offline-download.test.mjs
git commit -m "Take this place offline states the size, then actually leaves nothing behind"
```

---

### Task 5: A downloaded place that has moved on says so, without overwriting a walk in progress

**Files:**
- Modify: `index.html` (`setPlace()` at `index.html:2802`)
- Test: `tests/offline-download.test.mjs` (appended)

**Interfaces:**
- Consumes: `getPlaceSnapshot(id)`, `placeVersion`, `sameVersion` (all Task 1 and Task 4),
  `toast(msg)`.
- Produces: `checkStaleness(placeId)` — compares a stored snapshot's version against a fresh
  fetch's; toasts when they differ; never writes anything itself. Exposed at
  `window.__fa.offline.check`.

Refreshing is **manual**, always: this function only ever reports a mismatch, through the same
`toast()` every other non-fatal message in the app already uses. It never calls
`downloadPlace` on its own, and it never touches `fc` or `localStorage` — the constraint from
the spec ("never auto-overwrite a device that might be halfway through a walk") is met by this
function doing nothing but talk.

- [ ] **Step 1: Write the failing test**

```js
// tests/offline-download.test.mjs — appended
test("checkStaleness only reports — it never calls downloadPlace itself", () => {
  const start = html.indexOf("function checkStaleness(");
  const src = html.slice(start, html.indexOf("function ", start + 20));
  assert.match(src, /toast\(/, "a mismatch must be reported, not silently ignored");
  assert.doesNotMatch(src, /downloadPlace\(/, "staleness must never trigger its own refresh");
});

test("setPlace checks staleness for a place that was downloaded", () => {
  const src = slice("function setPlace(p, initial)", "function renderPlaceList");
  assert.match(src, /checkStaleness\(/);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test`
Expected: FAIL — `checkStaleness` does not exist; `setPlace` never calls it.

- [ ] **Step 3: Write `checkStaleness`**

Add next to `downloadPlace` (Task 4, Step 6):

```js
  /* Reports only. A downloaded place is a promise that a walk needs no network — silently
     refreshing it out from under a device that is mid-walk would break that promise in the
     one moment it matters most. The listener decides when to pay for a re-download, same as
     they decided to pay for the first one. */
  function checkStaleness(placeId) {
    if (!sb) { return Promise.resolve(); }
    return getPlaceSnapshot(placeId).then(function (snap) {
      if (!snap) { return; }
      return sb.from("public_features").select("id, updated_at").eq("place", placeId)
        .then(function (r) {
          if (r.error || !r.data) { return; }
          if (!sameVersion(snap.version, placeVersion(r.data))) {
            toast(snap.name + " has changed on the server since it was saved offline — " +
                  "download it again from Storage to refresh your copy.");
          }
        });
    });
  }
```

- [ ] **Step 4: Call it from `setPlace`**

`setPlace` itself, as left by Task 4's Step 8, ends:

```js
    setSelected(null);
    closePlaceMenu();
    commit();
    offlineArmed = null;
    $("#offline").textContent = "Download map";
    return fetchPublished(place ? place.properties.id : DEFAULT_PLACE);
  }
```

Change to check staleness alongside the fetch, independently — one failing must not block the
other:

```js
    setSelected(null);
    closePlaceMenu();
    commit();
    offlineArmed = null;
    $("#offline").textContent = "Download map";
    checkStaleness(p.properties.id);
    return fetchPublished(place ? place.properties.id : DEFAULT_PLACE);
  }
```

- [ ] **Step 5: Expose for the browser check**

Extend `window.__fa.offline` again (Task 4, Step 8):

```js
  window.__fa.offline = { version: placeVersion, sameVersion: sameVersion,
    bytes: offlineBytes, run: downloadPlace, snapshot: getPlaceSnapshot, check: checkStaleness };
```

- [ ] **Step 6: Run the tests**

Run: `npm test && npm run check`
Expected: all pass.

- [ ] **Step 7: Verify in a browser, end to end**

Download a place per Task 4. As a setter (a second signed-in session, or the Supabase table
editor), edit or delete one of that place's published features. Reload the listener's tab on
that place while online: confirm the toast naming the place appears within a few seconds and
that the map, the archive and anything already selected are completely unchanged by it — no
feature disappears, no card closes. Reselect the same place with nothing changed server-side:
confirm no toast appears.

- [ ] **Step 8: Commit**

```bash
git add index.html tests/offline-download.test.mjs
git commit -m "A downloaded place that has moved on says so, and touches nothing on its own"
```

---

### Task 6: Verification

**Files:** none created — this task runs the suite and the manual checks stage 1–3 already
established the pattern for.

- [ ] **Step 1: Run the full suite**

Run: `npm test && npm run check`
Expected: every test from stages 1–4 passes; no missing ids.

- [ ] **Step 2: Manual browser verification — cold deep link**

Clear `localStorage` and IndexedDB for the origin. Open `index.html?p=/:place/:route` directly
(a real published route id) in a fresh tab, signed out. Confirm: the app opens on that place,
that route selected and its card open, with no flash of Belgrad Ormanı or the last-remembered
place first.

Once this stage is pushed and GitHub Pages has rebuilt, repeat this check against the deployed
`https://keremaltaylar.github.io/FieldArc/:place/:route` — the real path this time, not the
`?p=` form — to confirm `404.html`'s redirect actually fires in production, which Task 2's own
verification could not test locally (see Task 2, Step 8).

- [ ] **Step 3: Manual browser verification — share round-trip**

Select a different route on the map. Copy the address bar. Open it in a private window.
Confirm the private window lands on the same route. Deselect. Confirm the bar drops to
`/:place` alone.

- [ ] **Step 4: Manual browser verification — offline holds**

Take a place offline per Task 4. Enable airplane mode or devtools' offline throttling. Reload.
Confirm: the map draws (cached tiles), the archive is populated (the `places` snapshot, not a
failed `fetchPublished`), a point's recording plays (cached in the `audio` store), and starting
a walk on a downloaded route fires zones and plays audio with no network at all — the same A-1
timing check and A-2/A-3/A-4 click checks from the spec's verification list, now run with the
network off entirely rather than merely unexercised.

- [ ] **Step 5: Manual browser verification — staleness, without a network drop**

With the same place still downloaded, go back online and follow Task 5, Step 7's setter-edit
scenario once more end to end, back to back with Step 4's offline run, to confirm the two do
not interact badly — a session that just proved it works with no network must still correctly
notice a change the moment the network returns.

- [ ] **Step 6: Confirm nothing regressed for a setter**

Sign in as the setter used throughout stages 1–3. Confirm Mark, attach-audio, Export/Import,
Publish and the pending count all work exactly as before this stage. Confirm signing in on a
place that was downloaded as a listener does not do anything special — the setter surface
does not know or care that a download happened.

- [ ] **Step 7: Commit**

Only if Steps 2–6 turned up a fix; otherwise this task ends at Step 1's passing run with
nothing to commit.
