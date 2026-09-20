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
