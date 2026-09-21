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

/* The rest of this file checks pure functions by running them; the wiring below — whether a
   bar gets unhidden, whether one function calls another — has no meaningful return value to
   assert on, so these are source-level checks of the actual call sites instead. That is a
   weaker guarantee than running the code, but it is what a test running under node, with no
   DOM and no MapLibre, can reach; it still catches the literal regressions task-8 review found
   (a walk starting with the transport permanently hidden, or a move that never reaches the
   zone/sector engines). */

test("worldStart reveals the transport and patch bars — otherwise a world walk has no way to start audio and no visible feedback", () => {
  const start = src("worldStart");
  assert.match(start, /\$\("#pacerbar"\)\.hidden = false/,
    "#pacerbar carries GPS, the readout, and the only Sound/Tone.start() gesture");
  assert.match(start, /\$\("#patchbar"\)\.hidden = false/,
    "#patchbar carries the morph/cells toggle");
});

test("worldMove drives the zone and sector engines, not just the bed", () => {
  const move = src("worldMove");
  assert.match(move, /pacerCheckZones\(\)/,
    "so zoneFire and the enter/exit toast fire for a world walk the same as a route walk");
  assert.match(move, /sectorUpdate\(\)/,
    "so the place-wide sector voice moves as the walker crosses a boundary, instead of freezing");
});

test("worldMove preserves each zone's inside/firedAt state across the fresh zonesNear() list it rebuilds every move", () => {
  /* Without this, pacerCheckZones would see every zone as freshly not-inside on every single
     fix — retriggering its enter event (and zoneFire) on every move spent within a zone's
     radius, which is exactly what A-14's cooldown/margin hysteresis exists to prevent. */
  const move = src("worldMove");
  assert.match(move, /prior\.inside/);
  assert.match(move, /prior\.firedAt/);
});

test("pacerStart and worldStart share one setup function rather than duplicating the window.__fa hooks and the GPS auto-restore", () => {
  const boot = src("pacerBoot");
  assert.match(boot, /window\.__fa\.world = \{ start: worldStart, move: worldMove/);
  assert.match(boot, /localStorage\.getItem\(GPS_KEY\)/);
  assert.match(src("pacerStart"), /pacerBoot\(\)/);
  assert.match(src("worldStart"), /pacerBoot\(\)/);
  /* The hooks must live in pacerBoot only — if pacerStart still built its own window.__fa.gps
     (or any of the others), a world-only session (no route walk ever started) would still be
     missing them, which was exactly review item 4. */
  assert.doesNotMatch(src("pacerStart"), /window\.__fa\.gps = /);
});

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

test("applyMixer scales the synth stage by its own level, not just the mixer, so a mute/solo toggle cannot slam a fade or crossfade back to full", () => {
  const apply = src("applyMixer");
  assert.match(apply,
    /bed\.synth\.gain\.rampTo\(\(bed\.synthLevel === undefined \? 1 : bed\.synthLevel\) \* mixLevel\(mixer, MIX_ROUTE\), BED\.fade\)/);
});
