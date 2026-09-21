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
  assert.match(fw, /if\s*\(pacer\s*&&\s*pacer\.world\)\s*\{\s*worldMove\(pacer\.pos\);\s*\}/,
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
  const WORLD_GUARD = /if\s*\(worldOn\(\)\)\s*\{\s*return;\s*\}/;
  assert.match(click, WORLD_GUARD,
    "the click handler must return before ever touching pacerStart/pacerStop while open world is on");
  const guardAt = click.search(WORLD_GUARD);
  const pacerStartAt = click.search(/pacerStart\(f\)/);
  assert.ok(guardAt !== -1 && pacerStartAt !== -1 && guardAt < pacerStartAt,
    "the guard must come before pacerStart/pacerStop, not after — a guard placed after either " +
    "call runs too late to prevent the walker swap");
});

test("applyWorld reasserts renderDetail() so an open card's #f-walk state cannot survive the toggle stale", () => {
  /* #f-walk's disabled flag and title are written only inside renderDetail() (see the I2 test
     above for the click-handler side of this). applyWorld() itself only ever called
     renderPlaceList() and renderList() — never renderDetail() — so `selected` survived the
     toggle with #f-walk left exactly as renderDetail() last drew it: switching Open world ON
     with a route card open left #f-walk enabled with an empty title (pressable, does nothing);
     switching it OFF left #f-walk disabled with the open-world title (unusable until the
     listener deselected and reselected). This is the same reassertion applyModeGating() already
     performs after ITS OWN blanket rewrite — `if (selected) { renderDetail(); }` — so applyWorld
     must do it too, and it must run regardless of which way the switch just moved (not tucked
     inside only the on-branch or only the off-branch). */
  const aw = src("applyWorld");
  assert.match(aw, /if\s*\(selected\)\s*\{\s*renderDetail\(\);\s*\}/,
    "applyWorld must re-render the open card so #f-walk's disabled/title state tracks the mode " +
    "it is called with, not the mode that was active when the card was last drawn");
  const reassertAt = aw.search(/if\s*\(selected\)\s*\{\s*renderDetail\(\);\s*\}/);
  const elseMatch = aw.match(/\}\s*else\s*\{/);
  let ifElseEnd = -1;
  if (elseMatch) {
    let i = elseMatch.index + elseMatch[0].length - 1, d = 0;
    for (; i < aw.length; i++) { if (aw[i] === "{") { d++; } else if (aw[i] === "}") { d--; if (!d) { break; } } }
    ifElseEnd = i + 1;
  }
  assert.ok(ifElseEnd !== -1 && reassertAt >= ifElseEnd,
    "the reassertion must sit after the on/off branch, not nested inside only one arm of it — " +
    "otherwise it only fires for one direction of the toggle");
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
  const elseMatch = aw.match(/\}\s*else\s*\{/);
  assert.ok(elseMatch, "applyWorld must have a real off-branch, not a bare else-if");
  const elseAt = elseMatch.index;
  let i = elseAt + elseMatch[0].length - 1, d = 0;
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
  /* Not pinned to the literal 5 — only that it is a small positive number of metres. The exact
     figure is a tuning choice, not a contract this test should freeze. */
  const pcm = html.match(/var PLACE_CHECK_M = (\d+(?:\.\d+)?);/);
  assert.ok(pcm, "PLACE_CHECK_M must be declared as a plain numeric literal");
  const placeCheckM = Number(pcm[1]);
  assert.ok(placeCheckM > 0 && placeCheckM <= 20,
    "PLACE_CHECK_M must be a small positive distance, not zero, negative, or huge");
  const lm = src("loadManifest");
  assert.match(lm, /if\s*\(manifestCache\)\s*\{\s*return manifestCache;\s*\}/,
    "loadManifest must serve a cached parse rather than re-parsing localStorage on every call " +
    "worldMove's own visible() makes");
  assert.match(src("saveManifest"), /manifestCache = m;/,
    "the cache must be kept truthful by its one writer, not merely left to go stale forever");
});

test("I4: the movement gate assigns placeCheckedAt only when the check actually runs, not on every move", () => {
  /* The I4 test above asserts only that the gate's condition reads
     `segment(pacer.placeCheckedAt, pos) >= PLACE_CHECK_M` — it never asserts that
     `pacer.placeCheckedAt = pos` sits INSIDE that if's branch. Hoist that one assignment a line
     up, out of the if, and the condition above still matches verbatim (the string is untouched),
     every other I4 assertion still passes, but the gate's meaning inverts: placeCheckedAt now
     tracks the position as of the PREVIOUS single call rather than the position as of the last
     time the branch actually ran, so a walker taking sub-5 m steps (a drag handler firing on
     every pointermove, or a GPS watch under a second apart) never accumulates enough distance
     between consecutive calls to trip the check again — it silently becomes "distance since last
     move" instead of "distance since last place check", and a park crossing made of small steps
     is never noticed.

     This executes the real gate — extracted verbatim from worldMove's own source, not
     reimplemented — over a sequence of real 1 m steps (real haversine distance, via the actual
     segment() the app ships) and counts how many times the expensive branch (placeAt) actually
     fires. Correct: roughly once every PLACE_CHECK_M metres. Hoisted: at most once, ever. */
  const wm = src("worldMove");
  const gateStart = wm.indexOf("if (!pacer.placeCheckedAt");
  assert.ok(gateStart !== -1, "worldMove's place-check gate was not found in its expected shape");
  const openBrace = wm.indexOf("{", gateStart);
  let i = openBrace, d = 0;
  for (; i < wm.length; i++) { if (wm[i] === "{") { d++; } else if (wm[i] === "}") { d--; if (!d) { break; } } }
  const gate = wm.slice(gateStart, i + 1);
  const headerLen = openBrace + 1 - gateStart;   /* "if (...) {" — no braces inside the condition */
  assert.match(gate.slice(headerLen), /pacer\.placeCheckedAt\s*=\s*pos;/,
    "the gate must assign placeCheckedAt inside its own branch, not merely somewhere in its text");

  const segment = new Function("return (" + src("segment") + ");")();
  const pcm = html.match(/var PLACE_CHECK_M = (\d+(?:\.\d+)?);/);
  const PLACE_CHECK_M = Number(pcm[1]);

  function runGate(gateSrc) {
    var calls = 0;
    var placeAt = function () { calls++; return null; };
    var sect = { seeds: null, cells: null, key: null, idx: null };
    var sectorGeometry = function () {};
    var drawSectors = function () {};
    var setPlaceFrame = function () {};
    var pacer = { placeId: undefined, patch: { sect: { n: 8 } } };
    var fn = new Function(
      "pacer", "pos", "PLACE_CHECK_M", "segment", "placeAt", "sect",
      "sectorGeometry", "drawSectors", "setPlaceFrame", gateSrc
    );
    /* One degree of latitude is ~111.2 km near the equator; find the step size that the app's
       OWN segment() calls 1 metre, by bisection, rather than trusting an approximated constant
       that could quietly drift from what segment() actually computes. */
    var lo = 0, hi = 0.001;
    for (var b = 0; b < 60; b++) {
      var mid = (lo + hi) / 2;
      if (segment([0, 0], [0, mid]) < 1) { lo = mid; } else { hi = mid; }
    }
    var stepDeg = (lo + hi) / 2;
    var fires = [];
    for (var step = 1; step <= 20; step++) {
      var pos = [0, stepDeg * step];
      fn(pacer, pos, PLACE_CHECK_M, segment, placeAt, sect, sectorGeometry, drawSectors, setPlaceFrame);
      fires.push(calls);
    }
    return fires;
  }

  const fires = runGate(gate);
  const totalFires = fires[fires.length - 1];
  /* 20 one-metre steps cover 20 metres; the correct gate fires on step 1 (placeCheckedAt is
     unset) and then again roughly every PLACE_CHECK_M metres — several times, not once, and
     nowhere near once per step. */
  assert.ok(totalFires >= 3 && totalFires <= 8,
    "over 20 one-metre steps the gate should fire a handful of times (about one per " +
    PLACE_CHECK_M + " m covered), not on every step and not just once — got " + totalFires);
  /* The hoisted bug: move the assignment out of the if, one line up, exactly as the reviewer
     described — built by index, not by a regex that would choke on the condition's own nested
     parens in segment(pacer.placeCheckedAt, pos). The header ("if (...) {") is untouched, so a
     test that only regex-matches the condition string cannot see this. */
  const header = gate.slice(0, headerLen);
  const bodyAndClose = gate.slice(headerLen);
  const assignRe = /pacer\.placeCheckedAt\s*=\s*pos;\s*/;
  assert.match(bodyAndClose, assignRe, "expected the assignment inside the gate's body");
  const bodyWithoutAssign = bodyAndClose.replace(assignRe, "");
  const hoisted = "pacer.placeCheckedAt = pos; " + header + bodyWithoutAssign;
  assert.notEqual(hoisted, gate, "the hoist transform must actually change the gate's text");
  const hoistedFires = runGate(hoisted);
  const hoistedTotal = hoistedFires[hoistedFires.length - 1];
  assert.ok(hoistedTotal < totalFires,
    "the hoisted (buggy) gate must fire fewer times than the real one over the same steps — " +
    "if it does not, this test cannot tell the two apart");
});
