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
  /* Standing 8.9 m nearer B than A, with a 20 m margin: A keeps it. */
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

test("a currentId no longer in the list falls back to the global nearest", () => {
  /* The case a live walk produces when a route is unpublished mid-session, or the walker
     leaves the area: pacer.routeId still names a route, but it is no longer in worldRoutes.
     currentId matching nothing means `current` stays null, so the margin check never fires
     and the walker gets the honestly-nearest route rather than something stale. */
  const got = nearestRoute.nearestRoute(listOf(A, B), [29.005, 41.009], "long-gone", 20);
  assert.equal(got.id, "r1", "falls back to the nearest route, not a stale one");
});

/* zonesNear leans on segment and ZONE_MARGIN, so the harness hands it the real segment and the
   real margin, and stubs the rest (soundOf, label, visible, HIT_SLOTS) the way the brief's test
   does. Shared across the zonesNear tests below rather than rebuilt per test. */
const zonesNear = new Function(
  src("segment") + "var ZONE_MARGIN = 1.3;" +
  "var HIT_SLOTS = [\"low\", \"mid\", \"high\", \"rand\"];" +
  "function soundOf(f){ return { radius: f.properties.sound.radius, gain: 0.9, zoneR: 25 }; }" +
  "function label(f){ return f.properties.name; }" +
  "function visible(){ return arguments[0]; }" +
  src("zonesNear") + "; return zonesNear;")();
const pt = (name, lon, lat, radius) => ({ type: "Feature",
  properties: { id: name, name, kind: "point", sound: { radius }, has_audio: true },
  geometry: { type: "Point", coordinates: [lon, lat] } });

test("a point is in reach when the walker is inside what it carries", () => {
  /* 0.0018 deg of latitude is about 200 m. */
  const near = pt("near", 29.000, 41.0000, 300);
  const far = pt("far", 29.000, 41.0018, 120);
  const got = zonesNear([near, far], [29.000, 41.0000]);
  assert.deepEqual(got.map((z) => z.id), ["near"], "the 120 m point 200 m away is out of reach");
  assert.equal(got[0].r, 25, "a zone keeps its own event radius");
});

test("a point past its own radius but still inside the margin is in reach", () => {
  /* 0.00126 deg of latitude, measured via segment(), is 140.10560757237056 m: past this point's
     120 m radius but inside 120 * ZONE_MARGIN (156 m). Without the margin, or with >= in place
     of >, this point would still be excluded/included the same as with the margin applied for
     "near"/"far" above — this fixture is the one that actually depends on ZONE_MARGIN being
     applied at all. */
  const edge = pt("edge", 29.000, 41.00126, 120);
  const got = zonesNear([edge], [29.000, 41.0000]);
  assert.deepEqual(got.map((z) => z.id), ["edge"],
    "140 m is past the 120 m radius but inside the 156 m margin");
});

test("the world walker takes its patch from the nearest route and its zones from the walker", () => {
  const move = src("worldMove");
  assert.match(move, /nearestRoute\(worldRoutes, pos, pacer\.routeId, sectorHold\(\)\)/);
  assert.match(move, /pacer\.zones = zonesNear\(visible\(\), pos\)/);
  assert.match(move, /updateBed\(\)/);
  /* patchOf(near.f) is assigned inside worldSwap, not worldMove itself — worldMove only calls
     worldSwap when the nearest route changes. worldSwap stays its own function because Task 9
     replaces its body wholesale with a crossfade, so the patch assignment is checked there. */
  assert.match(move, /worldSwap\(near\)/);
  assert.match(src("worldSwap"), /pacer\.patch = patchOf\(near\.f\)/);
  const start = src("worldStart");
  assert.match(start, /pacer = \{ f: null, world: true/, "a world walk belongs to no single route");
  assert.match(src("gpsFix"), /if \(pacer && pacer\.world\) \{ worldMove\(/,
    "a GPS fix drives the world walker too");
});
