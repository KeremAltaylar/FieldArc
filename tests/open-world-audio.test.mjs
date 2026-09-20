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

test("a point is in reach when the walker is inside what it carries", () => {
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
  /* 0.0018 deg of latitude is about 200 m. */
  const near = pt("near", 29.000, 41.0000, 300);
  const far = pt("far", 29.000, 41.0018, 120);
  const got = zonesNear([near, far], [29.000, 41.0000]);
  assert.deepEqual(got.map((z) => z.id), ["near"], "the 120 m point 200 m away is out of reach");
  assert.equal(got[0].r, 25, "a zone keeps its own event radius");
});
