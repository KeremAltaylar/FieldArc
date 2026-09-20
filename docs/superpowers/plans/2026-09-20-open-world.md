# Open World Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One map of every published route and every point — including points that belong to no park — with the nearest route governing what you hear, as the app's default mode.

**Architecture:** Open world is a second mode over the existing engine, not a second engine. A `world` flag decides what `visible()` returns, what the picker lists, and where the walker gets its position, its patch and its zones. The nearest route's patch drives harmony (crossfaded when another takes over), each point sounds by its own radius, and the existing off-route fade is applied to the synth stage instead of the whole walk.

**Tech Stack:** Plain ES5 in `index.html` (no build step), MapLibre GL, Tone.js, Supabase (Postgres + RLS), node:test for tests.

**Spec:** `docs/superpowers/specs/2026-09-20-open-world-design.md`

## Global Constraints

- **Storage keys keep the `fieldarc.` prefix.** The app is Fieldscape; the keys name data already in people's browsers. New key this plan adds: `fieldarc.world`.
- **Style matches the file:** ES5 `var`/`function` in `index.html`, ESM in `tests/`. `index.html` is CRLF — use the Edit tool rather than shell heredocs for edits to it.
- **Every gain change ramps** (A-2). Never assign to a live `.gain.value`.
- **Every value from tokens** (C-1): no hex, no `px` font sizes in new CSS.
- **One screen** (C-8): `document.documentElement.scrollHeight - innerHeight === 0`, plus a screenshot.
- **Measure, don't reason** (V-1, V-2): every claim in a commit message is a number someone ran.
- **Tests run against the live database** for anything touching Supabase (`npm test` uses `.env.local`).
- Run `npm test` and `npm run check` before every commit; both must be green.

---

### Task 1: A point may belong to no park (migration)

**Files:**
- Create: `supabase/migrations/0018_place_is_optional.sql`
- Test: `tests/free-points.test.mjs`

**Interfaces:**
- Produces: `public.features.place` accepts `NULL`; `public_features` returns such rows unchanged.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/free-points.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { asSetter, db } from "./clients.mjs";

const ID = "0f0e0d0c-0b0a-4009-8008-700600500400";

test("a point with no place publishes and comes back published", async () => {
  const c = await asSetter();
  const { error } = await c.from("features").upsert({
    id: ID, place: null, kind: "point",
    geometry: { type: "Point", coordinates: [29.02, 41.01] },
    properties: { name: "free point probe", published: true }, deleted_at: null
  }, { onConflict: "id" });
  assert.equal(error, null, error?.message);

  const row = await db.from("features").select("place").eq("id", ID).single();
  assert.equal(row.data.place, null, "the column holds NULL, not a sentinel string");

  const pub = await db.from("public_features").select("id,place").eq("id", ID).single();
  assert.equal(pub.error, null, "a free point is visible to a listener");
  assert.equal(pub.data.place, null);

  await db.from("features").delete().eq("id", ID);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- tests/free-points.test.mjs`
Expected: FAIL — `null value in column "place" of relation "features" violates not-null constraint`.

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/0018_place_is_optional.sql
-- A point may belong to no park and no route (Kerem, 2026-09-20): "points that can be placed
-- without attaching to a park". Open world shows these anywhere; nothing else changes.
--
-- Deliberately only the constraint. public_features selects place as-is and needs no edit; the
-- fuzz trigger keys on properties->>'sensitive'; RLS never mentions place. A NULL place is
-- "belongs to nothing", which is why this is a nullable column rather than a 'world' sentinel:
-- a sentinel would join against the place catalogue and find nothing, in every query that
-- already treats place as a foreign key by convention.
alter table public.features alter column place drop not null;
```

- [ ] **Step 4: Apply it and re-run the test**

Run: `npm run db:apply && npm test -- tests/free-points.test.mjs`
Expected: PASS. The ledger records 0018 so a second run is a no-op.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0018_place_is_optional.sql tests/free-points.test.mjs
git commit -m "A feature may belong to no place"
```

---

### Task 2: The mode itself

**Files:**
- Modify: `index.html` (near `var PLACE_KEY`, and the `window.__fa` hook block)
- Test: `tests/world-mode.test.mjs`

**Interfaces:**
- Produces: `worldOn()` → boolean; `setWorld(on)` persists and re-renders; `WORLD_KEY = "fieldarc.world"`. Later tasks read `worldOn()` and never the key.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/world-mode.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8").replace(/\r\n/g, "\n");
function src(name) {
  const s = html.indexOf("function " + name + "(");
  assert.ok(s !== -1, "missing " + name);
  let i = html.indexOf("{", html.indexOf(")", s)), d = 0;
  for (; i < html.length; i++) { if (html[i] === "{") d++; else if (html[i] === "}") { d--; if (!d) break; } }
  return html.slice(s, i + 1);
}

function load(stored) {
  const store = { getItem: () => stored, setItem: () => {} };
  return new Function("localStorage", src("worldOn") + "; return worldOn;")(store);
}

test("open world is the default on a device that has never chosen", () => {
  assert.equal(load(null)(), true);
});

test("a device that turned it off stays off", () => {
  assert.equal(load("0")(), false);
});

test("a device that turned it on stays on", () => {
  assert.equal(load("1")(), true);
});

test("the key joins the existing lowercase family", () => {
  assert.match(html, /var WORLD_KEY = "fieldarc\.world";/);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- tests/world-mode.test.mjs`
Expected: FAIL — "missing worldOn".

- [ ] **Step 3: Implement**

Add beside `PLACE_KEY` in `index.html`:

```javascript
  /* Open world: every published route at once, and points that belong to no park. The default
     on a device that has never chosen (Kerem, 2026-09-20: "default opening will be the open
     world mode"); the choice is remembered after that. Same lowercase key family as the rest —
     see STORE's note for why these never take the new name. */
  var WORLD_KEY = "fieldarc.world";

  function worldOn() {
    try { return localStorage.getItem(WORLD_KEY) !== "0"; } catch (e) { return true; }
  }
  function setWorld(on) {
    try { localStorage.setItem(WORLD_KEY, on ? "1" : "0"); } catch (e) { /* private mode */ }
  }
```

- [ ] **Step 4: Run the test**

Run: `npm test -- tests/world-mode.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add index.html tests/world-mode.test.mjs
git commit -m "Open world is a mode, and the default one"
```

---

### Task 3: The map is framed on all four sides

**Files:**
- Modify: `index.html` (the `#map` rule at ~line 877)
- Test: `tests/world-mode.test.mjs` (append)

**Interfaces:** none.

- [ ] **Step 1: Write the failing test**

```javascript
test("the map carries its own frame on a desktop, and not on the phone layout", () => {
  const rule = html.slice(html.indexOf("#map {"), html.indexOf("}", html.indexOf("#map {")) + 1);
  assert.match(rule, /border-right: 1px solid var\(--bdr\)/);
  assert.match(rule, /border-bottom: 1px solid var\(--bdr\)/);
  const phone = html.slice(html.indexOf("#map { grid-row: 2; grid-column: 1; }"));
  assert.match(phone.slice(0, 400), /#map \{ grid-row: 2; grid-column: 1; border-right: 0; border-bottom: 0; \}/,
    "the phone layout keeps its edges, where the map meets the sheet");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- tests/world-mode.test.mjs`
Expected: FAIL on the first `assert.match`.

- [ ] **Step 3: Implement**

Replace the desktop rule:

```css
/* Framed on all four sides. The right and bottom edges were missing, so at a desktop width the
   map ran to the window edge and the frame read as unfinished. */
#map {
  position: relative; background: var(--sunk);
  border-right: 1px solid var(--bdr); border-bottom: 1px solid var(--bdr);
}
```

and inside the existing phone media block replace `#map { grid-row: 2; grid-column: 1; }` with:

```css
  #map { grid-row: 2; grid-column: 1; border-right: 0; border-bottom: 0; }
```

- [ ] **Step 4: Run the test**

Run: `npm test -- tests/world-mode.test.mjs` — PASS.

- [ ] **Step 5: Commit**

```bash
git add index.html tests/world-mode.test.mjs
git commit -m "The map is framed on all four sides"
```

---

### Task 4: The switch in the picker, and a listener's menu

**Files:**
- Modify: `index.html` — the place menu markup (~line 1626 `#place-btn`, the `#place-menu` block), `renderPlaceList()` (~3498), `renderRouteList()` (~3545), `applyModeGating()`
- Test: `tests/world-mode.test.mjs` (append)

**Interfaces:**
- Produces: `#world-switch` button with `aria-pressed`; clicking it calls `setWorld()` then `applyWorld()` (Task 5 defines `applyWorld`; until then it is a no-op stub added here).

- [ ] **Step 1: Write the failing test**

```javascript
test("the picker carries the switch, and a listener sees routes but no park list", () => {
  assert.match(html, /<button type="button" id="world-switch" aria-pressed="true">/);
  assert.match(html, /Open world/);
  const render = src("renderPlaceList");
  assert.match(render, /if \(!setterTools\(\)\) \{ \$\("#place-list"\)\.hidden = true;/,
    "a park list is a dead end for a listener");
  const click = html.slice(html.indexOf('$("#world-switch").addEventListener'));
  assert.match(click.slice(0, 400), /setWorld\(/);
  assert.match(click.slice(0, 400), /applyWorld\(\)/);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- tests/world-mode.test.mjs` — FAIL, no `#world-switch`.

- [ ] **Step 3: Implement**

Markup, first child of `#place-menu` (above the search field):

```html
      <div class="worldrow">
        <button type="button" id="world-switch" aria-pressed="true">Open world</button>
        <span class="hint">all routes at once</span>
      </div>
```

CSS beside the other picker rules:

```css
.worldrow {
  display: flex; align-items: center; gap: var(--s-3);
  padding: var(--s-2) var(--s-3); border-bottom: 1px solid var(--bdr);
}
.worldrow .hint { margin: 0; }
```

Behaviour, beside the other picker handlers:

```javascript
  $("#world-switch").addEventListener("click", function () {
    var on = this.getAttribute("aria-pressed") !== "true";
    setWorld(on);
    this.setAttribute("aria-pressed", String(on));
    applyWorld();
  });
```

In `renderPlaceList()`, right after `var ul = $("#place-list");`:

```javascript
    /* A listener browses routes, not parks: a park with nothing published in it is a dead end,
       and the route rows already name the park each one belongs to. */
    $("#place-list").hidden = !setterTools();
    $("#place-list-label").hidden = !setterTools();
```

and add `<span class="eyebrow" id="place-list-label">Places</span>` above `#place-list` if it has no label element yet.

Add the stub `applyWorld` (Task 5 fills it):

```javascript
  function applyWorld() { renderPlaceList(); }
```

- [ ] **Step 4: Run the test**

Run: `npm test -- tests/world-mode.test.mjs` — PASS.

- [ ] **Step 5: Commit**

```bash
git add index.html tests/world-mode.test.mjs
git commit -m "The picker carries the Open world switch"
```

---

### Task 5: What the map shows in Open world

**Files:**
- Modify: `index.html` — `visible()` (~2053), `fetchPublished()` (~2250), `setPlace()` (~3438), `applyWorld()` (from Task 4)
- Test: `tests/world-mode.test.mjs` (append)

**Interfaces:**
- Consumes: `worldOn()` (Task 2).
- Produces: `fetchWorld()` → Promise; `visible()` returns every shown feature when `worldOn()`.

- [ ] **Step 1: Write the failing test**

```javascript
test("in open world every shown feature is visible, in place mode only the open park's", () => {
  const vis = src("visible");
  assert.match(vis, /worldOn\(\) \|\| !place \|\| f\.properties\.place === place\.properties\.id/,
    "the place filter is skipped in open world, and a free point passes either way");
  assert.match(src("fetchWorld"), /from\("public_features"\)\.select\("\*"\)/);
  assert.ok(!src("fetchWorld").includes('.eq("place"'), "every place at once");
  assert.match(src("applyWorld"), /fetchWorld\(\)/);
});

test("a free point is shown even when a park is open", () => {
  const shown = src("visible");
  assert.match(shown, /f\.properties\.place == null/,
    "a point belonging to nothing is not hidden by a park filter");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- tests/world-mode.test.mjs` — FAIL, no `fetchWorld`.

- [ ] **Step 3: Implement**

`visible()` becomes:

```javascript
  function visible() {
    var man = setterTools() ? null : loadManifest();
    return fc.features.filter(function (f) {
      /* Open world shows everything; a place shows its own; and a feature that belongs to no
         place (a free point) is never hidden by a park filter, because no park owns it. */
      var here = worldOn() || !place || f.properties.place == null ||
                 f.properties.place === place.properties.id;
      return here && shownTo(f, man);
    });
  }
```

Add beside `fetchPublished`:

```javascript
  /* Open world needs every published feature, not one place's. One query: public_features is
     already filtered to what is published, and the catalogue is small (measure before paging). */
  function fetchWorld() {
    if (!sb) { return Promise.resolve(); }
    return sb.from("public_features").select("*")
      .then(function (r) {
        if (r.error || !r.data) { return; }
        mergeRemote(r.data);
        map.getSource("features").setData({ type: "FeatureCollection", features: visible() });
        renderList();
      })
      .catch(function () { /* offline is the normal case in a forest */ });
  }
```

Fill in `applyWorld`:

```javascript
  /* Everything that differs between the modes, in one place: what the map holds, what the
     picker lists, and — once Task 8 lands — which walker is running. */
  function applyWorld() {
    var on = worldOn();
    $("#world-switch").setAttribute("aria-pressed", String(on));
    document.body.classList.toggle("world", on);
    if (on) { fetchWorld(); }
    map.getSource("features").setData({ type: "FeatureCollection", features: visible() });
    renderPlaceList();
    renderList();
  }
```

and call `applyWorld()` once at startup, after the first `setPlace(...)` resolves.

- [ ] **Step 4: Run the test**

Run: `npm test` — all green.

- [ ] **Step 5: Commit**

```bash
git add index.html tests/world-mode.test.mjs
git commit -m "Open world shows every route, every point, and what belongs to nothing"
```

---

### Task 6: Which route is nearest

**Files:**
- Modify: `index.html` (beside `projectToRoute`, ~6429)
- Test: `tests/open-world-audio.test.mjs`

**Interfaces:**
- Consumes: `projectToRoute(m, p)` → `{ t, dist }`, `routeMetrics(f)` → `{ coords, cum, total }`.
- Produces: `nearestRoute(list, pos, currentId, marginM)` → `{ id, f, m, t, dist }` or `null`, where `list` is `[{ id, f, m }]`.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/open-world-audio.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8").replace(/\r\n/g, "\n");
function src(name) {
  const s = html.indexOf("function " + name + "(");
  assert.ok(s !== -1, "missing " + name);
  let i = html.indexOf("{", html.indexOf(")", s)), d = 0;
  for (; i < html.length; i++) { if (html[i] === "{") d++; else if (html[i] === "}") { d--; if (!d) break; } }
  return html.slice(s, i + 1);
}
/* nearestRoute leans on projectToRoute and segment, so the harness hands it the real ones. */
const nearestRoute = new Function(
  src("segment") + src("projectToRoute") + src("routeMetrics") + src("nearestRoute") +
  "; return { nearestRoute: nearestRoute, routeMetrics: routeMetrics };")();

const line = (coords) => ({ type: "Feature", properties: { kind: "route" }, geometry: { type: "LineString", coordinates: coords } });
const A = line([[29.000, 41.000], [29.010, 41.000]]);   // runs east
const B = line([[29.000, 41.010], [29.010, 41.010]]);   // ~1.1 km north of A
const listOf = (...fs) => fs.map((f, i) => ({ id: "r" + i, f, m: nearestRoute.routeMetrics(f) }));

test("with nothing playing yet, the nearer line wins", () => {
  const got = nearestRoute.nearestRoute(listOf(A, B), [29.005, 41.001], null, 20);
  assert.equal(got.id, "r0");
  assert.ok(got.dist > 90 && got.dist < 130, "about 110 m off A: " + got.dist);
  assert.ok(Math.abs(got.t - 0.5) < 0.05, "half way along A");
});

test("the far line does not steal the walk until it is clearly nearer", () => {
  /* Standing 5 m nearer B than A, with a 20 m margin: A keeps it. */
  const mid = [29.005, 41.00504];
  const got = nearestRoute.nearestRoute(listOf(A, B), mid, "r0", 20);
  assert.equal(got.id, "r0", "no flip inside the margin");
});

test("once it is clearly nearer, it takes over", () => {
  const got = nearestRoute.nearestRoute(listOf(A, B), [29.005, 41.009], "r0", 20);
  assert.equal(got.id, "r1");
});

test("no routes at all is not an error", () => {
  assert.equal(nearestRoute.nearestRoute([], [29, 41], null, 20), null);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- tests/open-world-audio.test.mjs`
Expected: FAIL — "missing nearestRoute".

- [ ] **Step 3: Implement**

```javascript
  /* Which route the walker is listening to in open world. The current one keeps the walk until
     a challenger is clearly nearer — the same hysteresis the sections use, and for the same
     reason: two routes that run close together would otherwise swap the key back and forth at
     every step. Self-contained apart from projectToRoute, so the tests can run it directly. */
  function nearestRoute(list, pos, currentId, marginM) {
    var best = null, current = null;
    for (var i = 0; i < list.length; i++) {
      var r = list[i], pr = projectToRoute(r.m, pos);
      var cand = { id: r.id, f: r.f, m: r.m, t: pr.t, dist: pr.dist };
      if (!best || cand.dist < best.dist) { best = cand; }
      if (currentId && r.id === currentId) { current = cand; }
    }
    if (!best) { return null; }
    if (current && best.id !== current.id && current.dist - best.dist < marginM) { return current; }
    return best;
  }
```

- [ ] **Step 4: Run the test**

Run: `npm test -- tests/open-world-audio.test.mjs` — PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add index.html tests/open-world-audio.test.mjs
git commit -m "The nearest route, and it has to earn the handover"
```

---

### Task 7: Which points are in reach

**Files:**
- Modify: `index.html` (beside `buildZones`, ~6464)
- Test: `tests/open-world-audio.test.mjs` (append)

**Interfaces:**
- Consumes: `soundOf(f)` → `{ radius, gain, zoneR }`, `segment(a, b)` → metres, `ZONE_MARGIN`.
- Produces: `zonesNear(features, pos)` → the same zone objects `buildZones` produces.

- [ ] **Step 1: Write the failing test**

```javascript
test("a point is in reach when the walker is inside what it carries", () => {
  const zonesNear = new Function(
    src("segment") + "var ZONE_MARGIN = 1.3;" +
    "function soundOf(f){ return { radius: f.properties.sound.radius, gain: 0.9, zoneR: 25 }; }" +
    "function label(f){ return f.properties.name; }" +
    "function visible(){ return arguments[0]; }" +
    src("zonesNear") + "; return zonesNear;")();
  const pt = (name, lon, lat, radius) => ({ type: "Feature",
    properties: { id: name, name, kind: "point", sound: { radius }, has_audio: true },
    geometry: { type: "Point", coordinates: [lon, lat] } });
  /* 0.0018 deg of latitude is about 200 m. */
  const near = pt("near", 29.000, 41.0000, 300);
  const far = pt("far", 29.000, 41.0018, 120);
  const got = zonesNear([near, far], [29.000, 41.0000]);
  assert.deepEqual(got.map((z) => z.id), ["near"], "the 120 m point 200 m away is out of reach");
  assert.equal(got[0].r, 25, "a zone keeps its own event radius");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- tests/open-world-audio.test.mjs` — FAIL, "missing zonesNear".

- [ ] **Step 3: Implement**

```javascript
  /* Open world has no line to measure against, so a point is in reach when the walker is inside
     what it carries — the same radius its level already fades across, times the margin the zone
     engine uses everywhere else, so a point is admitted exactly when it could be heard.
     Takes the feature list rather than reading visible() itself, so the tests can feed it. */
  function zonesNear(features, pos) {
    var list = [];
    features.forEach(function (g) {
      if (g.geometry.type !== "Point") { return; }
      var q = soundOf(g);
      if (segment(pos, g.geometry.coordinates) > q.radius * ZONE_MARGIN) { return; }
      list.push({
        id: g.properties.id, lonlat: g.geometry.coordinates, r: q.zoneR,
        name: label(g), icon: g.properties.icon || null,
        has_audio: !!g.properties.has_audio,
        mode: (g.properties.audio_mode === "hits" || g.properties.audio_mode === "grains")
          ? g.properties.audio_mode : "soundscape",
        has_hits: !!(g.properties.hits && HIT_SLOTS.some(function (k) {
          return g.properties.hits[k];
        })),
        inside: false, firedAt: 0
      });
    });
    return list;
  }
```

- [ ] **Step 4: Run the test**

Run: `npm test -- tests/open-world-audio.test.mjs` — PASS.

- [ ] **Step 5: Commit**

```bash
git add index.html tests/open-world-audio.test.mjs
git commit -m "In open world a point is in reach by its own radius"
```

---

### Task 8: The world walker

**Files:**
- Modify: `index.html` — `pacerStart` (~6940), `pacerSet` (~6915), `gpsFix` (~6860), `updateBed` (~9327), `applyWorld` (Task 5)
- Test: `tests/open-world-audio.test.mjs` (append)

**Interfaces:**
- Consumes: `nearestRoute` (Task 6), `zonesNear` (Task 7), `worldOn` (Task 2).
- Produces: `worldStart()`, `worldStop()`, `worldMove(pos)`; `pacer.world === true` while it runs.

- [ ] **Step 1: Write the failing test**

```javascript
test("the world walker takes its patch from the nearest route and its zones from the walker", () => {
  const move = src("worldMove");
  assert.match(move, /nearestRoute\(worldRoutes, pos, pacer\.routeId, sectorHold\(\)\)/);
  assert.match(move, /pacer\.zones = zonesNear\(visible\(\), pos\)/);
  assert.match(move, /pacer\.patch = patchOf\(near\.f\)/);
  assert.match(move, /updateBed\(\)/);
  const start = src("worldStart");
  assert.match(start, /pacer = \{ f: null, world: true/, "a world walk belongs to no single route");
  assert.match(src("gpsFix"), /if \(pacer && pacer\.world\) \{ worldMove\(/,
    "a GPS fix drives the world walker too");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- tests/open-world-audio.test.mjs` — FAIL, "missing worldMove".

- [ ] **Step 3: Implement**

```javascript
  /* ---------- The world walker ----------
     No single route: the walker is a position in the city. Whichever route is nearest lends its
     patch, the points in reach are the zones, and the synth stage fades with the distance to
     that route (Task 9) so standing beside a free point in the middle of nowhere still sounds. */
  var worldRoutes = [];

  /* The same hold the sections use, so two routes that run close together do not swap the key
     back and forth at every step. */
  function sectorHold() { return Math.max(8, Math.min(40, 0.06 * (sect.width || 200))); }

  function worldStart() {
    pacerStop();
    worldRoutes = visible().filter(function (f) { return f.properties.kind === "route"; })
      .map(function (f) { return { id: f.properties.id, f: f, m: routeMetrics(f) }; })
      .filter(function (r) { return r.m.total > 0; });

    var el = document.createElement("div");
    el.className = "pacer";
    el.title = "Drag to listen from here";
    var start = worldRoutes.length ? worldRoutes[0].m.coords[0] : map.getCenter().toArray();
    var marker = new maplibregl.Marker({ element: el, draggable: true })
      .setLngLat(start).addTo(map);
    marker.on("drag", function () { worldMove(marker.getLngLat().toArray()); });

    pacer = { f: null, world: true, routeId: null, m: null, t: 0, pos: start, marker: marker,
              zones: [], log: [], patch: defaultPatch() };
    harmony.idx = null; harmony.chord = null; harmony.tones = null;
    harmony.last = { bass: null, top: null };
    worldMove(start);
    pacerReadout();
  }

  function worldStop() { pacerStop(); }

  function worldMove(pos) {
    if (!pacer || !pacer.world) { return; }
    pacer.pos = pos;
    if (pacer.marker) { pacer.marker.setLngLat(pos); }
    var near = nearestRoute(worldRoutes, pos, pacer.routeId, sectorHold());
    if (near) {
      if (near.id !== pacer.routeId) { worldSwap(near); }
      pacer.t = near.t;
      pacer.m = near.m;
      pacer.routeDist = near.dist;
    } else {
      pacer.routeDist = Infinity;
    }
    pacer.zones = zonesNear(visible(), pos);
    updateBed();
    pacerReadout();
  }
```

`worldSwap` is Task 9; add this placeholder now so the file parses, and Task 9 replaces its body:

```javascript
  function worldSwap(near) {
    pacer.routeId = near.id;
    pacer.patch = patchOf(near.f);
    BED.maxVoices = pacer.patch.bed.voices;
  }
```

In `gpsFix`, immediately after the accuracy gate:

```javascript
    if (pacer && pacer.world) {
      worldMove([+pos.coords.longitude.toFixed(6), +pos.coords.latitude.toFixed(6)]);
      return;
    }
```

In `applyWorld`, after the map source is set:

```javascript
    if (on) { worldStart(); } else if (pacer && pacer.world) { worldStop(); }
```

- [ ] **Step 4: Run the tests**

Run: `npm test` — all green. `npm run check` — green.

- [ ] **Step 5: Commit**

```bash
git add index.html tests/open-world-audio.test.mjs
git commit -m "The world walker: a position, the nearest route, and what is in reach"
```

---

### Task 9: The handover is heard as a transition

**Files:**
- Modify: `index.html` — `worldSwap` (Task 8), and the walk-fade application in `gpsFix`
- Test: `tests/open-world-audio.test.mjs` (append)

**Interfaces:**
- Consumes: `walkLevel(dist, from, leash)`, `setWalkLevel(level)`, `bed.synth`, `BED.fade`.
- Produces: `setSynthLevel(level)`; `worldSwap` crossfades over `WORLD_SWAP` seconds.

- [ ] **Step 1: Write the failing test**

```javascript
test("a route handover fades the synths out and back, and distance fades the synths not the walk", () => {
  assert.match(html, /var WORLD_SWAP = 1\.5;/);
  const swap = src("worldSwap");
  assert.match(swap, /setSynthLevel\(0\)/, "out before the patch changes");
  assert.match(swap, /pacer\.patch = patchOf\(near\.f\)/);
  assert.match(swap, /setTimeout\(/, "and back after it");
  const level = src("setSynthLevel");
  assert.match(level, /bed\.synth\.gain\.rampTo\(/);
  assert.match(level, /mixLevel\(mixer, MIX_ROUTE\)/, "a muted route stays muted through a swap");
  const move = src("worldMove");
  assert.match(move, /setSynthLevel\(walkLevel\(pacer\.routeDist, GPS_FADE_FROM, GPS_LEASH\)\)/,
    "in open world the distance fade belongs to the synths; points keep their own");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- tests/open-world-audio.test.mjs` — FAIL, no `WORLD_SWAP`.

- [ ] **Step 3: Implement**

```javascript
  var WORLD_SWAP = 1.5;      /* seconds — a change of key is a transition, not a jump cut */
  var worldSwapTimer = null;

  /* The synth stage's own level. Multiplied by the mixer, so muting the route on its card still
     means muted while a swap or a fade is running. */
  function setSynthLevel(level) {
    if (!bed || !bed.synth) { return; }
    bed.synthLevel = level;
    bed.synth.gain.rampTo(level * mixLevel(mixer, MIX_ROUTE), BED.fade);
  }

  function worldSwap(near) {
    var wasRunning = pacer.routeId !== null;
    setSynthLevel(0);
    clearTimeout(worldSwapTimer);
    var take = function () {
      pacer.routeId = near.id;
      pacer.patch = patchOf(near.f);
      BED.maxVoices = pacer.patch.bed.voices;
      harmony.idx = null; harmony.chord = null; harmony.tones = null;
      sect.idx = null;
      setSynthLevel(walkLevel(near.dist, GPS_FADE_FROM, GPS_LEASH));
    };
    /* The first route of a session needs no fade out — there is nothing playing to fade. */
    if (!wasRunning) { take(); return; }
    worldSwapTimer = setTimeout(take, WORLD_SWAP * 1000);
  }
```

and in `worldMove`, replace `pacer.routeDist = near.dist;` with:

```javascript
      pacer.routeDist = near.dist;
      if (near.id === pacer.routeId) {
        setSynthLevel(walkLevel(pacer.routeDist, GPS_FADE_FROM, GPS_LEASH));
      }
```

and in the `else` branch (`pacer.routeDist = Infinity;`) add `setSynthLevel(0);`.

In `gpsFix`, the existing `setWalkLevel(...)` call becomes place-mode only:

```javascript
    /* In open world the fade belongs to the synths — a free point beside you must still sound
       when no route is anywhere near. In place mode the whole walk fades, as shipped. */
    if (!(pacer && pacer.world)) {
      setWalkLevel(walkLevel(pr.dist, GPS_FADE_FROM, GPS_LEASH));
    }
```

- [ ] **Step 4: Run the tests**

Run: `npm test` — all green.

- [ ] **Step 5: Commit**

```bash
git add index.html tests/open-world-audio.test.mjs
git commit -m "A route handover is a transition, and distance fades the synths"
```

---

### Task 10: Sections follow the park you are standing in

**Files:**
- Modify: `index.html` — beside `sectorGeometry` (~6520), `worldMove` (Task 8)
- Test: `tests/sectors.test.mjs` (append)

**Interfaces:**
- Consumes: `places` (the catalogue array), `sect`, `sectorGeometry(m, n)`.
- Produces: `placeAt(pos)` → a place feature or `null`.

- [ ] **Step 1: Write the failing test**

```javascript
test("the park under the walker is found from the catalogue, and nothing outside one", () => {
  const placeAt = new Function("places",
    src("pointInRing") + src("placeAt") + "; return placeAt;")(places.features);
  const valide = places.features.find((p) => p.properties.id === "W153690111");
  const inside = valide.geometry.type === "Polygon"
    ? valide.geometry.coordinates[0][0] : valide.geometry.coordinates[0][0][0];
  /* A point far out in the Marmara sea belongs to no park. */
  assert.equal(placeAt([28.5, 40.5]), null);
  assert.ok(placeAt([29.0434, 41.0155]), "a point inside Validebağ resolves to a park");
});
```

(`src` and a `places` load are already at the top of this test file; add
`const places = JSON.parse(readFileSync("places.geojson", "utf8"));` if it is not there.)

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- tests/sectors.test.mjs` — FAIL, "missing placeAt".

- [ ] **Step 3: Implement**

```javascript
  /* Ray casting, the same rule equalAreaSectors uses on its samples. */
  function pointInRing(pt, ring) {
    var c = false;
    for (var k = 0, j = ring.length - 1; k < ring.length; j = k++) {
      if ((ring[k][1] > pt[1]) !== (ring[j][1] > pt[1]) &&
          pt[0] < (ring[j][0] - ring[k][0]) * (pt[1] - ring[k][1]) / (ring[j][1] - ring[k][1]) + ring[k][0]) {
        c = !c;
      }
    }
    return c;
  }

  /* Which park the walker is standing in, if any. Ninety polygons is cheap, and open world only
     asks when the walker has actually moved (worldMove). Outside every park this is null, and
     the sector voice rests — there is no boundary to divide. */
  function placeAt(pos) {
    for (var i = 0; i < places.length; i++) {
      var g = places[i].geometry;
      var polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
      for (var j = 0; j < polys.length; j++) {
        if (pointInRing(pos, polys[j][0])) { return places[i]; }
      }
    }
    return null;
  }
```

In `worldMove`, after `pacer.zones = ...`:

```javascript
    /* The park underfoot owns the sections. Recut only when it changes — the solve is up to
       129 ms and a walker crosses a boundary rarely. */
    var here = placeAt(pos);
    var hereId = here ? here.properties.id : null;
    if (hereId !== pacer.placeId) {
      pacer.placeId = hereId;
      if (here) { setPlaceFrame(here); sectorGeometry(pacer.m || { coords: [pos] }, pacer.patch.sect.n); }
      else { sect.seeds = null; sect.cells = null; sect.key = null; sect.idx = null; }
      drawSectors();
    }
```

Extract the boundary half of `setPlace` into `setPlaceFrame(p)` so the two callers cannot drift.
Move exactly the block that runs from `map.getSource("forest").setData(...)` (index.html:3447)
down to and including `drawSectors();` (index.html:3469) — that is: the forest source, the
`rings`/`b` bounds loop, the `rings.sort`, `main`, `frame`, the `line()` helper, the
`forest-outer` source, the `sect.frame` assignment, the `if (pacer) { sectorGeometry(...) }`
line and `drawSectors()`. `setPlaceFrame` returns the `b` bounds object, because `setPlace`
uses it two lines later for `forestBounds` and `fitBounds`:

```javascript
  /* The boundary half of setPlace, on its own because open world also needs it: the walker
     crossing into a park loads that park's frame without selecting the park. */
  function setPlaceFrame(p) {
    map.getSource("forest").setData({ type: "FeatureCollection", features: [p] });
    var rings = [], b = new maplibregl.LngLatBounds();
    p.geometry.coordinates.forEach(function (poly) {
      poly[0].forEach(function (c) { b.extend(c); });
      rings.push(poly);
    });
    rings.sort(function (x, y) { return ringArea(y[0]) - ringArea(x[0]); });
    var main = rings[0][0];
    var frame = simplify(main, p.properties.area_km2 > 5 ? 0.0003 : 0.00008);
    var line = function (coords) {
      return { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } };
    };
    map.getSource("forest-outer").setData({ type: "FeatureCollection", features: [line(frame)] });
    sect.frame = (frame.length > 2 && frame[0][0] === frame[frame.length - 1][0] &&
                  frame[0][1] === frame[frame.length - 1][1]) ? frame.slice(0, -1) : frame;
    if (pacer) { sectorGeometry(pacer.m, pacer.patch.sect.n); sect.idx = null; }
    drawSectors();
    return b;
  }
```

In `setPlace`, the moved block becomes `var b = setPlaceFrame(p);`. Keep the comments that
travelled with those lines.

- [ ] **Step 4: Run the tests**

Run: `npm test` — all green.

- [ ] **Step 5: Commit**

```bash
git add index.html tests/sectors.test.mjs
git commit -m "In open world the park underfoot owns the sections"
```

---

### Task 11: Marking a free point, and attaching it later

**Files:**
- Modify: `index.html` — the Mark handler (`markAt`/`#mark` click), the point card (`renderDetail`, ~11898), card markup beside the chips row
- Test: `tests/free-points.test.mjs` (append)

**Interfaces:**
- Consumes: `worldOn()`, `placeAt(pos)` (Task 10).
- Produces: `#f-attach` button; a feature written with `place: null` in open world.

- [ ] **Step 1: Write the failing test**

```javascript
import { readFileSync } from "node:fs";
const html = readFileSync("index.html", "utf8").replace(/\r\n/g, "\n");

test("marking in open world makes a free point, and the card offers to attach it", () => {
  assert.match(html, /place: worldOn\(\) \? null : place\.properties\.id/,
    "a point marked in open world belongs to no park");
  assert.match(html, /<button type="button" class="ghost" id="f-attach" hidden>/);
  const click = html.slice(html.indexOf('$("#f-attach").addEventListener'));
  assert.match(click.slice(0, 500), /f\.properties\.place = p\.properties\.id/);
  assert.match(click.slice(0, 500), /claimEdit\(f\)/, "attaching is an edit like any other");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- tests/free-points.test.mjs` — FAIL.

- [ ] **Step 3: Implement**

Wherever a new point's properties are built (the Mark handler and the map-click point path), the place becomes:

```javascript
      place: worldOn() ? null : place.properties.id,
```

Card markup, in the actions row before `#f-zoom`:

```html
        <button type="button" class="ghost" id="f-attach" hidden>Attach to this park</button>
```

In `renderDetail`, beside the other action visibility lines:

```javascript
    /* A free point standing inside a park can join it — one tap, and then it behaves like any
       other point of that park (its offline download, its place filter). */
    var host = (f.properties.kind === "point" && f.properties.place == null && setterTools())
      ? placeAt(f.geometry.coordinates) : null;
    $("#f-attach").hidden = !host;
    if (host) { $("#f-attach").textContent = "Attach to " + host.properties.name; }
```

Handler, beside the other card handlers:

```javascript
  $("#f-attach").addEventListener("click", function () {
    var f = feature(selected);
    if (!f || !setterTools() || f.properties.place != null) { return; }
    var p = placeAt(f.geometry.coordinates);
    if (!p) { return; }
    claimEdit(f);
    f.properties.place = p.properties.id;
    commit();
    renderDetail();
    toast(label(f) + " joined " + p.properties.name);
  });
```

- [ ] **Step 4: Run the tests**

Run: `npm test` — all green. `npm run check` — green.

- [ ] **Step 5: Commit**

```bash
git add index.html tests/free-points.test.mjs
git commit -m "A point marked in open world belongs to nothing, until you attach it"
```

---

### Task 12: Picking a route in Open world focuses it, and stays

**Files:**
- Modify: `index.html` — `renderRouteList()` (~3545)
- Test: `tests/world-mode.test.mjs` (append)

**Interfaces:**
- Consumes: `worldOn()` (Task 2), `worldMove` (Task 8), `setSelected(id, true)`.

Kerem's message said the other routes should disappear; asked directly he chose focus-only, and
the switch is what gives the exclusive view. This task implements what he chose.

- [ ] **Step 1: Write the failing test**

```javascript
test("a route picked in open world centres and selects without leaving the mode", () => {
  const list = src("renderRouteList");
  assert.match(list, /if \(worldOn\(\)\) \{/, "open world does not fall through to setPlace");
  assert.match(list, /setSelected\(rt\.id, true\)/);
  assert.match(list, /worldMove\(/, "the walker moves to the route the listener picked");
  assert.ok(!/worldOn\(\)[\s\S]{0,200}setWorld\(false\)/.test(list),
    "picking a route must not switch the mode off");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- tests/world-mode.test.mjs` — FAIL.

- [ ] **Step 3: Implement**

In `renderRouteList`, the row's click handler becomes:

```javascript
      b.addEventListener("click", function () {
        /* In open world everything stays on the map: picking a route centres it, selects it and
           moves the walker to its start, so it is the one you are listening to. Turning the
           switch off is what narrows the map to a single place and route. */
        if (worldOn()) {
          closePlaceMenu();
          setSelected(rt.id, true);
          var f = feature(rt.id);
          if (f && f.geometry && f.geometry.coordinates.length) {
            worldMove(f.geometry.coordinates[0]);
            map.flyTo({ center: f.geometry.coordinates[0], duration: 700 });
          }
          return;
        }
        setPlace(p).then(function () { setSelected(rt.id, true); });
      });
```

If the menu's close function has another name, use that one — it is the function
`#place-btn`'s own click handler calls to hide `#place-menu`.

- [ ] **Step 4: Run the tests**

Run: `npm test` — all green.

- [ ] **Step 5: Commit**

```bash
git add index.html tests/world-mode.test.mjs
git commit -m "A route picked in open world focuses rather than isolating"
```

---

### Task 13: Measure it, then say so

**Files:**
- Modify: `docs/superpowers/specs/2026-09-20-open-world-design.md` (a Measured section at the end)
- No source changes unless a measurement finds a defect.

**Interfaces:** none.

- [ ] **Step 1: Serve the app and open it**

```bash
python -m http.server 8765 &
```

Open `http://localhost:8765/` in Chrome. Confirm it starts in Open world with the switch pressed.

- [ ] **Step 2: Measure the fit and the frame**

In the console:

```javascript
({ scroll: document.documentElement.scrollHeight - innerHeight,
   frame: getComputedStyle(document.querySelector("#map")).borderRightWidth })
```

Expected: `scroll: 0`, `frame: "1px"`. Take a screenshot at 1440×900 and at 390×844.

- [ ] **Step 3: Measure the crossfade**

Start Sound with a real click, then drag the world marker from beside one route to beside another and sample:

```javascript
const b = window.__fa.bed, out = [];
const t = setInterval(() => out.push(+b.synth.gain.value.toFixed(3)), 100);
window.__fa.world.move([29.043, 41.015]);      // beside route A
setTimeout(() => window.__fa.world.move([29.05, 41.02]), 2000);   // beside route B
setTimeout(() => { clearInterval(t); console.log(out.join(" ")); }, 6000);
```

Expected: a fall to 0 and a rise back, no step from one sample to the next larger than about 0.2.

- [ ] **Step 4: Measure a free point with no route near**

Move the walker beside a published free point at least 200 m from every route:

```javascript
const b = window.__fa.bed;
({ synth: +b.synth.gain.value.toFixed(3),
   points: Object.keys(b.voices).map((id) => +b.voices[id].gain.gain.value.toFixed(3)) })
```

Expected: `synth: 0`, at least one point gain above 0.

- [ ] **Step 5: Record the numbers in the spec and commit**

Append a `## Measured` section to the spec with the actual numbers, then:

```bash
git add docs/superpowers/specs/2026-09-20-open-world-design.md
git commit -m "Measured: open world fit, crossfade and a point with no route near"
```

- [ ] **Step 6: Push and verify the deploy**

```bash
git push origin main
gh api repos/KeremAltaylar/Fieldscape/pages/builds/latest --jq '.status + " " + .commit[0:7]'
curl -s "https://keremaltaylar.github.io/Fieldscape/index.html?x=$RANDOM" | grep -c "function worldMove"
```

Expected: `built <the pushed sha>`, and `1`.

---

## Notes for whoever executes this

- **Place mode must not change.** After every task, the existing suite is the regression test: if a Place-mode test goes red, the task is wrong, not the test.
- **`window.__fa` is how the browser measurements reach the code.** Task 8 should add `window.__fa.world = { start: worldStart, move: worldMove, routes: function () { return worldRoutes; } };` beside the other hooks.
- **The audio graph is built once.** Nothing in this plan tears down and rebuilds voices; a swap changes `pacer.patch` and lets the running scheduler read it.
