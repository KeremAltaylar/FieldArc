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
  return new Function("localStorage", 'var WORLD_KEY = "fieldarc.world";' + src("worldOn") + "; return worldOn;")(store);
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

test("the map carries its own frame on a desktop, and not on the phone layout", () => {
  const rule = html.slice(html.indexOf("#map {"), html.indexOf("}", html.indexOf("#map {")) + 1);
  assert.match(rule, /border-right: 1px solid var\(--bdr\)/);
  assert.match(rule, /border-bottom: 1px solid var\(--bdr\)/);
  const phone = html.slice(html.indexOf("#map { grid-row: 2; grid-column: 1;"));
  assert.match(phone.slice(0, 400), /#map \{ grid-row: 2; grid-column: 1; border-right: 0; border-bottom: 0; \}/,
    "the phone layout keeps its edges, where the map meets the sheet");
});

test("the picker carries the switch, and a listener sees routes but no park list", () => {
  /* assert.match(html, /Open world/) used to sit here as a second, separate assertion — it
     cannot fail, because "Open world" also appears inside this very file's own comments (see
     the design decisions table above), so the string is always present regardless of the
     button's markup. Matched as one tag instead, so the button's own visible text is what is
     actually checked. */
  assert.match(html, /<button type="button" id="world-switch" aria-pressed="true">Open world<\/button>/);
  const render = src("renderPlaceList");
  assert.match(render, /if \(!setterTools\(\)\) \{ \$\("#place-list"\)\.hidden = true;/,
    "a park list is a dead end for a listener");
  const click = html.slice(html.indexOf('$("#world-switch").addEventListener'));
  assert.match(click.slice(0, 400), /setWorld\(/);
  assert.match(click.slice(0, 400), /applyWorld\(\)/);
});

test("the switch is synced from worldOn() every time the menu renders, not left at its markup default", () => {
  /* A device that previously turned Open world off must see the switch reflect that on the
     next open — the markup's aria-pressed="true" is only the never-chosen default, the same
     way #gps-btn is driven from the stored GPS_KEY rather than trusted from markup. */
  const open = src("openPlaceMenu");
  assert.match(open, /\$\("#world-switch"\)\.setAttribute\("aria-pressed", String\(worldOn\(\)\)\)/,
    "openPlaceMenu must re-read worldOn() and drive the switch from it, not just from the click handler");
});

test("in open world every shown feature is visible, in place mode only the open park's", () => {
  const vis = src("visible");
  assert.match(vis, /worldOn\(\) \|\| !place/,
    "the place filter is skipped in open world");
  assert.match(vis, /f\.properties\.place == null/,
    "a free point passes either way, because no park owns it");
  assert.match(src("fetchWorld"), /from\("public_features"\)\.select\("\*"\)/);
  assert.ok(!src("fetchWorld").includes('.eq("place"'), "every place at once");
  assert.match(src("applyWorld"), /fetchWorld\(\)/);
});

test("visible()'s place filter, run for real: a free point passes in place mode too, a foreign park's point does not", () => {
  /* The test this replaced re-asserted the same /f\.properties\.place == null/ source match the
     test above it already makes — a change that broke the rule would have had to fail both or
     neither, so the second test caught nothing extra. This one instead extracts the `here`
     expression verbatim and executes it, in place mode specifically (worldOn() false), which the
     test above never exercises — it only checks fetchWorld/applyWorld's open-world wiring. */
  const vis = src("visible");
  const start = vis.indexOf("var here = "), end = vis.indexOf(";", vis.indexOf("place.properties.id"));
  assert.ok(start !== -1 && end !== -1, "the here-expression was not found — did visible() change shape?");
  const stmt = "return " + vis.slice(start + "var here = ".length, end) + ";";
  const here = new Function("worldOn", "place", "f", stmt);
  const placeMode = function () { return false; };
  const parkA = { properties: { id: "PARK_A" } };
  assert.equal(here(placeMode, parkA, { properties: { place: null } }), true,
    "a free point is shown in place mode no matter which park is open");
  assert.equal(here(placeMode, parkA, { properties: { place: "PARK_B" } }), false,
    "a point belonging to a different park is hidden in place mode");
  assert.equal(here(placeMode, parkA, { properties: { place: "PARK_A" } }), true,
    "a point belonging to the open park is shown");
});

test("a route picked in open world centres and selects without leaving the mode", () => {
  const list = src("renderRouteList");
  const s = list.indexOf("if (worldOn()) {");
  assert.ok(s !== -1, "open world does not fall through to setPlace");
  /* Task 12's actual failure shape: a removed `return;` inside this branch does not show up as
     a missing string anywhere — worldMove(...) and setSelected(...) are still called exactly as
     before, and the branch simply keeps running into `setPlace(p).then(...)` below it. The old
     version of this test only grepped the whole function's source for those calls and for the
     absence of setWorld(false) nearby, which a removed `return;` does not touch at all — it
     could not have caught it. Extracting the brace-matched branch and asserting on ITS contents
     can. */
  let i = list.indexOf("{", s), d = 0;
  for (; i < list.length; i++) { if (list[i] === "{") { d++; } else if (list[i] === "}") { d--; if (!d) { break; } } }
  const branch = list.slice(s, i + 1);
  assert.match(branch, /setSelected\(rt\.id, true\)/);
  assert.match(branch, /worldMove\(/, "the walker moves to the route the listener picked");
  assert.match(branch, /return;/,
    "without this the branch falls through to setPlace(p) below — Task 12's own regression shape");
  assert.doesNotMatch(branch, /setPlace\(/,
    "picking a route in open world must never call setPlace — that is what narrows the map to one park");
  assert.doesNotMatch(branch, /setWorld\(false\)/, "picking a route must not switch the mode off");
});

test("C1: fetchWorld rebuilds worldRoutes once every park's routes are actually in, and re-runs nearestRoute", () => {
  /* worldStart() snapshots worldRoutes synchronously, from whatever fetchPublished(place) had
     already merged for the one park setPlace opened — applyWorld() fires fetchWorld() and then
     calls worldStart() in the same tick, without waiting on the network. A listener opening the
     site gets a map showing every route (the map layer is keyed off visible(), rebuilt again once
     fetchWorld lands) but a walker that can only ever pick a nearest route from that one park —
     walk anywhere else and the synth stage sits at 0 forever. This asserts fetchWorld's own .then
     repairs that once the request actually resolves. */
  const fw = src("fetchWorld");
  assert.match(fw, /worldRoutes = computeWorldRoutes\(\)/,
    "fetchWorld's .then must rebuild worldRoutes from every place now in fc, not leave " +
    "worldStart's boot-time snapshot (one park's routes) standing forever");
  assert.match(fw, /if \(pacer && pacer\.world\) \{ worldMove\(pacer\.pos\); \}/,
    "and re-run nearestRoute against wherever the walker already is, or a route from a park " +
    "that only just arrived can never become the nearest one");
  /* computeWorldRoutes must be the one true builder — worldStart() has to use it too, or a
     rewrite could satisfy the assertions above while worldStart's own snapshot silently drifts
     from what fetchWorld later computes. */
  assert.match(src("worldStart"), /worldRoutes = computeWorldRoutes\(\)/);
});

test("I2: Walk is a no-op in open world — it must never replace the world walker with a route walk", () => {
  /* pacer.f is null in a world walk, so `pacer && pacer.f === f` never matched: a first click on
     Walk fell through to pacerStart(f), tearing down the world walker (and everything it was
     doing — sections, zones, the synth crossfade) while the switch still read Open world; a
     second click then called pacerStop() on that route walk and left no walker running at all. */
  const click = html.slice(html.indexOf('$("#f-walk").addEventListener'), html.indexOf('$("#f-patch").addEventListener'));
  assert.match(click, /if \(worldOn\(\)\) \{ return; \}/,
    "the click handler must return before ever touching pacerStart/pacerStop while open world is on");
  const guardAt = click.search(/if \(worldOn\(\)\) \{ return; \}/);
  const pacerStartAt = click.search(/pacerStart\(f\)/);
  assert.ok(guardAt !== -1 && pacerStartAt !== -1 && guardAt < pacerStartAt,
    "the guard must come before pacerStart/pacerStop, not after — a guard placed after either " +
    "call runs too late to prevent the walker swap");
});

test("I3: leaving open world restores the selected park's own frame and sections", () => {
  /* worldMove hands the map boundary and sect.frame to whichever park the walker is standing in
     (worldMove's own place-change block, never touching the module-level `place` the picker still
     shows as selected) — correct while open world is on, the spec's own rule. But applyWorld's
     off-branch used to stop there: turning the switch off left the map showing whatever park the
     walker was last standing in, while the picker, the place name and the offline download all
     still said the originally selected park — and the next route walk in THAT park cut its
     sections out of the wrong park's ring. */
  const aw = src("applyWorld");
  const elseAt = aw.indexOf("} else {");
  assert.ok(elseAt !== -1, "applyWorld must have a real off-branch, not a bare else-if");
  let i = aw.indexOf("{", elseAt + "} else ".length), d = 0;
  for (; i < aw.length; i++) { if (aw[i] === "{") { d++; } else if (aw[i] === "}") { d--; if (!d) { break; } } }
  const offBranch = aw.slice(elseAt, i + 1);
  assert.match(offBranch, /worldStop\(\)/, "the world walker must still be stopped");
  assert.match(offBranch, /setPlaceFrame\(place\)/,
    "and the selected place's own frame (and sect.frame, re-cut from it) must be restored — " +
    "otherwise the map and the sections are left on whichever park the walker last stood in");
});

test("I4: worldMove gates placeAt to real movement, and caches the manifest rather than re-parsing it per move", () => {
  const wm = src("worldMove");
  assert.match(wm, /segment\(pacer\.placeCheckedAt, pos\) >= PLACE_CHECK_M/,
    "placeAt must not run on every pointer-move/GPS tick — only once the walker has covered " +
    "PLACE_CHECK_M metres since the last check");
  assert.match(html, /var PLACE_CHECK_M = 5;/);
  const lm = src("loadManifest");
  assert.match(lm, /if \(manifestCache\) \{ return manifestCache; \}/,
    "loadManifest must serve a cached parse rather than re-parsing localStorage on every call " +
    "worldMove's own visible() makes");
  assert.match(src("saveManifest"), /manifestCache = m;/,
    "the cache must be kept truthful by its one writer, not merely left to go stale forever");
});
