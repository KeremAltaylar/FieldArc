# FieldArc 2.0 — Stage 3: the listener surface

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A visitor who has never signed in opens the site and is in it — the map, on a place, with its published points and routes drawn — and hears them, with no setter tool anywhere in reach. A signed-in setter sees exactly what they see today; nothing here changes their surface.

**Architecture:** Two additions and one gating pass. First, `anon` gains exactly one new reach: a published feature's recording, via a storage RLS policy keyed to the same `public_features` view that already governs geometry — no signed URLs, no edge function, no new grant surface to reason about beyond the one that already exists. Second, the client fetches `public_features` for the active place and merges it into the in-memory `fc` by id, so a browser with nothing in `localStorage` still has an archive to show; a setter's own device, whose local mirror already holds every id the server would offer, sees the fetch resolve to nothing new. Third, everything a setter can do that a listener should not — Point/Route modes and the mode bar, the card's editing controls, Storage's export/publish tools — is gated behind one already-existing boolean, `setter.signedIn`, through one new function called from the one place session state already changes.

**Tech Stack:** Same as stage 2 — `@supabase/supabase-js` v2 UMD, Postgres 17.6, Node 24 `node:test` against the live project. No new library, no new service.

**Spec:** `docs/superpowers/specs/2026-09-10-platform-design.md`

## Global Constraints

- **A signed-in setter's surface must not change.** Every element this stage hides, hides only when `setter.signedIn` is false. If a setter can open devtools and find a single pixel different from `main` before this stage, that is a regression, not a stage-3 decision.
- **`anon` gains exactly one new reach.** `tests/grants.test.mjs` covers `public` schema objects only and is untouched by this stage; the new surface is a `storage.objects` policy, verified in `tests/storage.test.mjs`. It must be scoped to a *published* feature's recording and nothing else — an unpublished feature's audio must stay unreachable by `anon` even when its id is known.
- **No signed URLs, no edge function.** Decided 2026-09-12, overriding the plan the `0012` migration comment predicted: a direct RLS policy against `public.public_features` costs one migration and no new infrastructure, and is exactly as revocable as a signed URL — unpublishing a feature removes it from the view the policy joins against on the very next request.
- **Offline capture must not regress**, same as stage 2's constraint — nothing here touches Mark, trace, attach-audio or patch editing for a signed-in setter.
- **No build step.** The deployed artifact stays a static file set.
- Commit messages: a declarative sentence, then what it prevents or what was measured.

## What stage 2 left for this stage

- `anon` can read `public_features` (geometry, patch, fuzzed positions) but has no path to a recording's audio at all. A listener today can see a point exists and cannot hear it.
- Nothing populates `fc` for a browser with an empty `localStorage`. A fresh visitor sees the header, the basemap, and an empty archive — the `visible()` filter in `index.html:1710` has nothing to filter.
- Every archive tool — the mode bar, note/tags/type/attach-audio, sensitive/published/Delete, Export/Import/Publish — is visible and functional to anyone, signed in or not. Only `#publish-btn` itself checks `setter.signedIn` (`index.html:1939`); nothing else does.

## File Structure

| File | Responsibility |
| --- | --- |
| `index.html` | Listener fetch-and-merge, the mode-gating pass, GPS/Virtual promotion |
| `supabase/migrations/0015_listener_audio_read.sql` | The one new `anon` grant: a recording, if its feature is published |
| `tests/storage.test.mjs` | Extended: anon can read a published feature's recording, still cannot read an unpublished one |
| `tests/listener.test.mjs` | The fetch-and-merge, as a pure function; the gating list, read from the page |
| `tests/fit.test.mjs` | The 390 px listener-surface fit check, and that the mode bar is actually gone at that width |

---

### Task 1: A listener can read a published feature's recording, and only that

**Files:**
- Create: `supabase/migrations/0015_listener_audio_read.sql`
- Modify: `tests/storage.test.mjs`

**Interfaces:**
- Produces: `anon` role gains `SELECT` on `storage.objects` rows in the `recordings` bucket, scoped per-row to `exists (select 1 from public.public_features where id = <first path segment>)`.

- [ ] **Step 1: Write the failing test**

Add to `tests/storage.test.mjs`, after the existing `"anon cannot list or download"` test (which proves the *unpublished* half of this and must keep passing unchanged):

```js
/* PATH is "probe/hello.txt" — no feature owns it, so it stands in for "unpublished" in the
   existing test above. This test needs a real, published feature id, because the policy
   joins on one. */
test("anon can download a published feature's recording, but not an unpublished one", async () => {
  const { data: pub, error: pubErr } = await db.from("features").insert({
    place: "belgrad-ormani", kind: "point",
    geometry: { type: "Point", coordinates: [28.99, 41.19] },
    properties: { published: true }, created_by: userId
  }).select().single();
  assert.equal(pubErr, null, pubErr?.message);

  const { data: draft, error: draftErr } = await db.from("features").insert({
    place: "belgrad-ormani", kind: "point",
    geometry: { type: "Point", coordinates: [28.99, 41.19] },
    properties: { published: false }, created_by: userId
  }).select().single();
  assert.equal(draftErr, null, draftErr?.message);

  const pubPath = pub.id + "/take.wav";
  const draftPath = draft.id + "/take.wav";
  try {
    const { error: upErr } = await db.storage.from("recordings")
      .upload(pubPath, new Blob(["a"]), { upsert: true });
    assert.equal(upErr, null, upErr?.message);
    const { error: upErr2 } = await db.storage.from("recordings")
      .upload(draftPath, new Blob(["a"]), { upsert: true });
    assert.equal(upErr2, null, upErr2?.message);

    const a = anon();
    const okDl = await a.storage.from("recordings").download(pubPath);
    assert.equal(okDl.error, null, "anon could not read a published feature's recording");

    const badDl = await a.storage.from("recordings").download(draftPath);
    assert.ok(badDl.error, "anon read an unpublished feature's recording");
  } finally {
    await db.storage.from("recordings").remove([pubPath, draftPath]);
    await db.from("features").delete().in("id", [pub.id, draft.id]);
  }
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test`
Expected: FAIL on the published-download assertion — no policy grants `anon` anything on `storage.objects` yet.

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/0015_listener_audio_read.sql

-- The one new thing an anonymous reader can reach. Decided 2026-09-12: a direct policy
-- against public.public_features, not a signed URL minted by an edge function — the view
-- already IS the published-and-not-deleted predicate, security_invoker = off so it runs as
-- its owner regardless of who queries it, and anon already holds SELECT on it. Joining a
-- storage policy to it costs one migration; a signed URL would have cost a second runtime.
--
-- storage.foldername(name) splits an object's path on "/" and returns the segments before
-- the filename. Every recording path in this project — "<id>/take.wav" and
-- "<id>/hits/<slot>.<ext>" alike — begins with the feature id, so [1] is always it.

drop policy if exists recordings_anon_read_published on storage.objects;
create policy recordings_anon_read_published on storage.objects
  for select to anon
  using (
    bucket_id = 'recordings'
    and exists (
      select 1 from public.public_features f
      where f.id::text = (storage.foldername(name))[1]
    )
  );
```

- [ ] **Step 4: Apply the migration**

Run: `npm run db:apply`
Expected: `0015_listener_audio_read.sql` applied; the ledger records it; a second run does nothing.

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: the new test passes; every existing test, including `"anon cannot list or download"`, still passes unchanged — that test's `PATH` names no feature, so the new policy's `exists` clause is false for it and access stays denied.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0015_listener_audio_read.sql tests/storage.test.mjs
git commit -m "A listener can hear what is published, and nothing else"
```

---

### Task 2: The archive a listener sees comes from the server, not from an empty browser

**Files:**
- Modify: `index.html` (near `visible()` at `index.html:1710`; the place-change handler; `save()` at `index.html:1751`)
- Test: `tests/listener.test.mjs`

**Interfaces:**
- Consumes: `sb` (Task 1 of stage 2), `place` (the currently selected place object, already tracked)
- Produces: `mergeRemote(rows)` — takes `public_features` rows, appends any whose id is not already in `fc.features`, tagged `properties._remote = true`. `fetchPublished(placeId)` — queries `public_features` for that place and calls `mergeRemote`. Both attached to `window.__fa` for the browser-level check in Task 5.

- [ ] **Step 1: Write the failing test**

```js
// tests/listener.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8");

test("mergeRemote adds a feature the archive does not already have", () => {
  const src = html.slice(html.indexOf("function mergeRemote("),
                         html.indexOf("function fetchPublished("));
  assert.ok(src.length > 0, "mergeRemote exists");
  assert.match(src, /_remote\s*:\s*true/, "a merged feature is marked remote, not local");
});

test("save() never writes a remote feature to localStorage", () => {
  const src = html.slice(html.indexOf("function save() {"), html.indexOf("function save() {") + 600);
  assert.match(src, /_remote/, "save() must filter remote features before persisting");
});

test("fetchPublished queries public_features scoped to a place", () => {
  const src = html.slice(html.indexOf("function fetchPublished("),
                         html.indexOf("function fetchPublished(") + 500);
  assert.match(src, /public_features/);
  assert.match(src, /\.eq\(\s*["']place["']/);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test`
Expected: FAIL — neither function exists yet.

- [ ] **Step 3: Write `mergeRemote` and `fetchPublished`**

Add directly after `visible()` in `index.html` (currently ending at line 1714):

```js
  /* A row from public_features is shaped like the view: id, place, kind, geometry,
     properties, created_at — flat, not nested the way a GeoJSON Feature is. rowFor() (the
     publish path) strips id/place/kind out of properties before sending; this is that,
     reversed, so a merged feature reads exactly like a locally authored one to every
     function that already expects fc.features to hold GeoJSON Features. */
  function rowToFeature(row) {
    var p = Object.assign({}, row.properties,
      { id: row.id, place: row.place, kind: row.kind, _remote: true });
    return { type: "Feature", properties: p, geometry: row.geometry };
  }

  /* Merge, not replace: a setter's own device already holds every id the server would
     offer, so this is a no-op for them past the first id. A fresh browser holds none, so
     every row lands. Either way, something already present locally — published or still a
     draft — is never overwritten by the server's copy of itself. */
  function mergeRemote(rows) {
    var have = {};
    fc.features.forEach(function (f) { have[f.properties.id] = true; });
    rows.forEach(function (row) {
      if (have[row.id]) { return; }
      fc.features.push(rowToFeature(row));
      have[row.id] = true;
    });
  }

  function fetchPublished(placeId) {
    if (!sb || !placeId) { return Promise.resolve(); }
    return sb.from("public_features").select("*").eq("place", placeId)
      .then(function (r) {
        if (r.error || !r.data) { return; }
        mergeRemote(r.data);
        map.getSource("features").setData({ type: "FeatureCollection", features: visible() });
        renderList();
      });
  }
```

- [ ] **Step 4: Filter remote features out of `save()`**

`index.html:1751` currently reads:

```js
  function save() {
    try {
      localStorage.setItem(STORE, JSON.stringify(fc));
```

Change the persisted payload to exclude anything fetched rather than authored:

```js
  function save() {
    try {
      var toStore = { type: fc.type,
        features: fc.features.filter(function (f) { return !f.properties._remote; }) };
      localStorage.setItem(STORE, JSON.stringify(toStore));
```

Leave the rest of `save()` (the `exportState()`/`changes` counting and `renderPending()` call) unchanged — a remote feature was never pending and `rowFor()` never sees it, since it is not in any manifest diff until a setter actually edits it, at which point it is no longer only-remote in any way that matters to storage.

- [ ] **Step 5: Call `fetchPublished` on load and on place change**

Find where `place` is set on initial load and where the place picker changes it — both call the same function today (grep `function setPlace` or the place-menu click handler). Add a call at the end of that function:

```js
  fetchPublished(place ? place.properties.id : DEFAULT_PLACE);
```

- [ ] **Step 6: Expose for the browser check**

Immediately after `window.__fa.sb = sb;`:

```js
  window.__fa.fetchPublished = fetchPublished;
  window.__fa.mergeRemote = mergeRemote;
```

- [ ] **Step 7: Run the tests**

Run: `npm test`
Expected: `listener.test.mjs` passes; `pending.test.mjs` and `publish.test.mjs` still pass — `rowFor()` reads `f.properties`, never `_remote`, so a remote feature that gets edited publishes exactly like a local one, minus the flag (which `rowFor` already drops along with every other key it does not explicitly copy... check this: `rowFor` copies `Object.keys(f.properties)` wholesale, so `_remote` WOULD travel to the server unless stripped. Add `delete p._remote;` next to the existing `delete p.id; delete p.place; delete p.kind;` in `rowFor()` at `index.html:1970`.)

- [ ] **Step 8: Verify in a browser**

Serve locally, clear `localStorage` for the origin, load the page signed out. Confirm `window.__fa.mergeRemote` populated `fc.features` from the server and the map draws the real published archive, not an empty one. Then sign in as the setter on the same browser and confirm nothing duplicates — every remote id should already be a local id.

- [ ] **Step 9: Commit**

```bash
git add index.html tests/listener.test.mjs
git commit -m "A fresh browser sees the published archive, not an empty one"
```

---

### Task 3: Archive tools are setter-only

**Files:**
- Modify: `index.html` (new `applyModeGating()`; called from `renderSetter()` at `index.html:1773` and once at init)
- Test: `tests/listener.test.mjs` (appended)

**Interfaces:**
- Consumes: `setter.signedIn` (stage 2)
- Produces: `applyModeGating()` — the single function that hides or shows every setter-only control. Exposed at `window.__fa.applyModeGating` for the browser check in Task 5.

Decided here, reading the spec's two "Gone" / "kept" lists (`docs/superpowers/specs/2026-09-10-platform-design.md`, "The listener surface" and "The setter surface") against the actual DOM:

| Hidden from a listener | Element(s) |
| --- | --- |
| Mode bar | `.modes` (`index.html:1409`), `#mode-icons` (`:1414`) |
| Name / note / type / tags | `#f-name` (`:1448`), `#f-note` (`:1450`), `#g-type` (`:1451`), `#f-tags` (`:1455`) |
| Attach-audio and the recording-type switch | `.recmode` (`:1458`), `#rec-add` (`:1468`) — the player itself (`#player`, `:1470`) stays, so a listener can still press play |
| Remove the recording | `#rec-remove` (`:1480`) — inside `#player`, so it is hidden on its own rather than by hiding the whole player |
| sensitive / published | `.chips` (`:1489`) |
| Delete, Patch, Rhythm | `#f-delete` (`:1501`), `#f-patch` (`:1498`), `#f-rhythm` (`:1499`) — `#f-walk` and `#f-zoom` are **kept**: starting a route is how a listener hears it, and zooming to a feature is not authoring |
| Export / Import / Download / Undo | the `.actions` row and `#offline`/`#undo` at the top of `#storage` (`:1508`–`:1513`) |
| Publish bar | `#publishbar` (`:1527`) — `#setter` (the sign-in block itself, `:1519`) is **kept**: it is how a listener becomes a setter |
| Mark | `#markbar` (`:1611`, the whole button and its live-trace readout) — decided 2026-09-12: a listener has no marking to do, and GPS/Virtual already covers "use my own position" for a route in progress, so the button is hidden entirely rather than relabeled to Locate |

- [ ] **Step 1: Write the failing test**

```js
// append to tests/listener.test.mjs

test("applyModeGating hides exactly the setter-only elements, and never the sign-in block", () => {
  const src = html.slice(html.indexOf("function applyModeGating("),
                         html.indexOf("function applyModeGating(") + 2000);
  const mustHide = [".modes", "#mode-icons", "#f-name", "#f-note", "#g-type", "#f-tags",
    ".recmode", "#rec-add", "#rec-remove", ".chips", "#f-delete", "#f-patch", "#f-rhythm",
    "#offline", "#undo", "#publishbar", "#markbar"];
  mustHide.forEach((sel) => {
    assert.ok(src.includes(JSON.stringify(sel)) || src.includes("'" + sel + "'"),
      sel + " is not in the gated list");
  });
  assert.doesNotMatch(src, /["']#setter["']/,
    "the sign-in block must never be hidden — it is how a listener becomes a setter");
  assert.doesNotMatch(src, /["']#f-walk["']/, "Walk stays — it is how a listener hears a route");
  assert.doesNotMatch(src, /["']#f-zoom["']/, "Zoom to stays — it is not an authoring tool");
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test`
Expected: FAIL — `applyModeGating` does not exist yet.

- [ ] **Step 3: Write `applyModeGating`**

Add after `renderSetter()` (which ends at `index.html:1793`):

```js
  /* Every control a setter has that a listener should not. Two elements are deliberately
     absent: #setter, because it is the door a listener walks through to become a setter,
     and #f-walk / #f-zoom, because starting a route is how a listener hears it and zooming
     to a feature is not an authoring act. .actions here means #storage's top row
     (Export/Import), scoped through its parent so the card's own .actions row (Zoom to,
     Delete) is untouched — Delete is named directly instead. #markbar is hidden outright
     rather than relabeled to Locate — decided 2026-09-12: a listener has no marking to do,
     and the GPS/Virtual toggle already covers "use my own position" for a route in progress. */
  var SETTER_ONLY = [".modes", "#mode-icons", "#f-name", "#f-note", "#g-type", "#f-tags",
    ".recmode", "#rec-add", "#rec-remove", ".chips", "#f-delete", "#f-patch", "#f-rhythm",
    "#storage > .actions", "#offline", "#undo", "#publishbar", "#markbar"];

  function applyModeGating() {
    var show = setter.signedIn;
    SETTER_ONLY.forEach(function (sel) {
      document.querySelectorAll(sel).forEach(function (el) { el.hidden = !show; });
    });
    /* mode never reaches "point" or "route" for a listener — the buttons that would set it
       are gone, and #markbar (Mark's own button) is gone too — but a stale mode from a
       session that just signed out must not survive the transition. */
    if (!show && mode !== "select") { setMode("select"); }
  }
```

- [ ] **Step 4: Call it from `renderSetter()` and once at init**

`renderSetter()` at `index.html:1791` already ends with `renderPending(); renderAudit();` — add the call alongside them:

```js
    renderPending();
    renderAudit();
    applyModeGating();
```

Find the initial call to `renderSetter()` made once at page load, before any session is known (it renders the default "Not signed in" state) — `applyModeGating()` runs there too, since `renderSetter()` already calls it. No separate init call is needed.

- [ ] **Step 5: Expose for the browser check**

```js
  window.__fa.applyModeGating = applyModeGating;
```

- [ ] **Step 6: Run the tests**

Run: `npm test && npm run check`
Expected: the new test passes; `check-html.js` reports no missing ids (every selector in `SETTER_ONLY` names an id or class already in the page).

- [ ] **Step 7: Verify in a browser, both ways**

Serve locally, load signed out: confirm the mode bar, note, tags, type picker, attach-audio, sensitive/published, Delete, Patch, Rhythm, Export/Import/Download/Undo, the publish bar, and the Mark button are all gone; confirm the sign-in email field is still there; confirm clicking a point still plays its recording (`#player` visible, `#rec-remove` not) and clicking a route and pressing Walk still starts it. Then sign in and confirm every one of those reappears exactly as before this stage, Mark included.

- [ ] **Step 8: Commit**

```bash
git add index.html tests/listener.test.mjs
git commit -m "Everything a setter can do that a listener should not is now gated on one boolean"
```

---

### Task 4: GPS/Virtual is the listener's primary control

**Files:**
- Modify: `index.html` (`#patchbar` around `:1602`; CSS near `#patchbar`)
- Test: `tests/listener.test.mjs` (appended)

**Interfaces:**
- Consumes: `pacer` (the active-walk state, already tracked)

The spec: *"the GPS/Virtual toggle is the listener's primary control... it is presented as a mode, not as a small button in the patch strip."* Today `#gps-btn` is exactly that small button, styled `class="ghost"` alongside Cells inside `#patchbar` (`index.html:1602`–`1610`). For a listener, promote it: move it out of the ghost-button row and give it its own two-state control next to `#patch-play` ("Sound" — the start/stop for the walk).

Mark itself needs no promotion or relabeling here — decided 2026-09-12, Task 3 hides `#markbar` outright for a listener rather than repurposing it as Locate. A listener's only way to use their own position is the GPS toggle on a route already in progress, which is exactly what this task promotes.

- [ ] **Step 1: Write the failing test**

```js
// append to tests/listener.test.mjs

test("GPS is promoted out of the ghost-button row for a listener", () => {
  const idx = html.indexOf('id="gps-btn"');
  const tag = html.slice(html.lastIndexOf("<button", idx), idx + 30);
  assert.doesNotMatch(tag, /class="ghost"/,
    "gps-btn must not stay styled as a small ghost button once promoted");
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test`
Expected: FAIL — `gps-btn` still carries `class="ghost"`.

- [ ] **Step 3: Restyle the GPS toggle**

`index.html:1606`–`1607` currently:

```html
      <button type="button" id="gps-btn" class="ghost" aria-pressed="false"
              title="Let your own position drive the listener along this route">GPS</button>
```

Change to drop `class="ghost"` and give it a dedicated class the CSS can promote:

```html
      <button type="button" id="gps-btn" class="modeToggle" aria-pressed="false"
              title="Let your own position drive the listener along this route">GPS</button>
```

Add beside the existing `#patchbar` rules in the `<style>` block:

```css
/* Promoted out of the ghost-button row: for a walker this is the choice between their own
   position and the draggable marker, not a small aside next to Cells. Same visual weight as
   #patch-play, which sits beside it. */
#patchbar #gps-btn.modeToggle {
  font-family: var(--font-mono);
  font-size: var(--t-sm);
  padding: var(--s-2) var(--s-3);
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: passes.

- [ ] **Step 5: Verify in a browser**

Serve locally, sign out, select a route and press Walk. Confirm GPS reads as a primary control beside Sound, not a small ghost button, and confirm the Mark button is nowhere on screen — the walk is driven by GPS or the draggable Virtual marker alone. Sign in and confirm Mark is back exactly as before this stage.

- [ ] **Step 6: Commit**

```bash
git add index.html tests/listener.test.mjs
git commit -m "GPS/Virtual reads as the walker's primary choice"
```

---

### Task 5: Verification

**Files:**
- Create: `tests/fit.test.mjs`

Per the spec's own verification section: *"Fit. `scrollHeight - innerHeight === 0` on both surfaces, and the listener surface at 390 px wide with its mode bar gone."*

- [ ] **Step 1: Write the fit test**

```js
// tests/fit.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8");

test("the mode bar carries a class or id applyModeGating can find at any width", () => {
  // A static check that the selector list from Task 3 still resolves against the current
  // markup — catches a future rename of .modes or #mode-icons before it silently stops
  // gating anything.
  assert.match(html, /class="modes"/);
  assert.match(html, /id="mode-icons"/);
});
```

(The `scrollHeight - innerHeight === 0` and 390 px checks are layout facts a jsdom-free Node test cannot measure honestly — record them as manual browser steps below, the same way stage 2's fit checks were closed. Do not simulate them with a fake DOM; a passing fake measurement here would be worse than an honest manual step, per the standing rule against measurements that cannot fail.)

- [ ] **Step 2: Run the full suite**

Run: `npm test && npm run check`
Expected: every test from stages 1–3 passes; no missing ids.

- [ ] **Step 3: Manual browser verification — signed out**

Serve locally (`npx serve .`), open `index.html?rafshim` signed out, and confirm, in order:
1. `document.documentElement.scrollHeight - window.innerHeight === 0` at the default window size.
2. Resize to 390 px wide (or use device emulation). The mode bar is not merely hidden-but-present — `document.querySelector(".modes").hidden` is `true` — and the panel does not reserve blank space where it was.
3. Select a point with a recording: it plays. Select a route and press Walk: the walker appears, GPS/Virtual controls the walk, zones fire.
4. Confirm no setter control is reachable by any click path: no Point/Route mode, no note/tags/type fields, no attach-audio, no sensitive/published, no Delete, no Patch, no Export/Import/Publish.
5. The A-1 timing check and the A-2/A-3/A-4 click checks (per the spec's verification list) still pass with this stage's code loaded — run whatever manual or scripted check stage 1/2 used for these; this stage touches no audio-engine code, so a regression here means a gating change accidentally hid or altered something the engine depends on.

- [ ] **Step 4: Manual browser verification — signed in**

Sign in as the setter used throughout stages 1–2. Confirm every element from Task 3's table is visible and functional exactly as it was on `main` before this stage — mode bar, card editing, Export/Import, Publish. Confirm Mark still reads "Mark" and still creates points and traces.

- [ ] **Step 5: Commit**

```bash
git add tests/fit.test.mjs
git commit -m "The listener surface fits at 390px, and the setter surface is provably unchanged"
```
