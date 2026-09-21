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

test("bedStart gives the synth stage the level the walker's distance already earned, instead of leaving it at Gain(1) until the next tick", () => {
  const start = src("bedStart");
  assert.match(start, /if \(pacer && pacer\.world\) \{\s*\n\s*setSynthLevel\(walkLevel\(pacer\.routeDist, GPS_FADE_FROM, GPS_LEASH\)\);/);
});

/* ---------------------------------------------------------------------------------------------
   Review fixups on worldSwap. Both the Critical (the timer can re-arm forever under continuous
   motion, deadlocking the crossfade silent) and the Important (the first audible route change
   could see a stale wasRunning and open with a 1.5s gap instead of the no-fade path) are ordinary
   JavaScript once setSynthLevel/worldSwap are pulled out of index.html — so these drive the real
   functions against a fake bed/pacer/mixer and node's mock timers, rather than only checking
   source text for the shape of the fix. */
function buildSwapSandboxFactory() {
  var declsStart = html.indexOf("var WORLD_SWAP = 1.5;");
  var declsEnd = html.indexOf("function setSynthLevel(");
  assert.ok(declsStart !== -1 && declsEnd !== -1 && declsEnd > declsStart,
    "the WORLD_SWAP/worldSwapTimer/pendingSwapId declarations moved or were renamed");
  var decls = html.slice(declsStart, declsEnd);
  return new Function(
    "pacer", "bed", "mixer", "BED", "harmony", "sect", "worldRoutes", "patchOf",
    src("segment") + src("projectToRoute") + src("routeMetrics") + src("nearestRoute") +
    src("walkLevel") + src("mixLevel") +
    "var GPS_FADE_FROM = 60, GPS_LEASH = 120, MIX_ROUTE = \"route\";" +
    /* worldSwap's take() now sets the voice budget through voiceBudget(), which reads
       navigator/screen — neither exists here. The sandbox supplies the identity, because what
       this file tests is the swap timer, not the budget; tests/audio-memory.test.mjs owns that. */
    "function voiceBudget(n) { return n; }" +
    src("sectorHold") + decls + src("setSynthLevel") + src("worldSwap") +
    "; return { worldSwap: worldSwap, setSynthLevel: setSynthLevel };"
  );
}
const swapFactory = buildSwapSandboxFactory();

const swapLine = (coords) => ({ type: "Feature", properties: { kind: "route" },
  geometry: { type: "LineString", coordinates: coords } });
const rA = swapLine([[29.000, 41.000], [29.010, 41.000]]);
const rB = swapLine([[29.000, 41.010], [29.010, 41.010]]);
const rC = swapLine([[29.000, 41.020], [29.010, 41.020]]);
const swapRoutes = [
  { id: "rA", f: rA, m: nearestRoute.routeMetrics(rA) },
  { id: "rB", f: rB, m: nearestRoute.routeMetrics(rB) },
  { id: "rC", f: rC, m: nearestRoute.routeMetrics(rC) },
];
const SWAP_MARGIN = 12;   // sectorHold()'s own value with sect.width unset
const posNear = { rA: [29.005, 41.0002], rB: [29.005, 41.0098], rC: [29.005, 41.0198] };
const near = (id, pos, currentId) => nearestRoute.nearestRoute(swapRoutes, pos, currentId, SWAP_MARGIN);
function fakeSynth() { const calls = []; return { gain: { calls, rampTo(v, t) { calls.push([v, t]); } } }; }
function stubPatchOf(f) { return { bed: { voices: 4 } }; }

test("Critical: continuous ticks toward the same pending target do not re-arm the swap timer", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pacer = { routeId: "rA", world: true, pos: posNear.rB };
  const bed = { synth: fakeSynth() };
  const sandbox = swapFactory(pacer, bed, { mute: {}, solo: {} }, { fade: 0.35, maxVoices: 4 },
    {}, {}, swapRoutes, stubPatchOf);

  const first = near("rB", posNear.rB, pacer.routeId);
  assert.equal(first.id, "rB", "fixture sanity: rB really is nearest from posNear.rB");
  sandbox.worldSwap(first);
  assert.equal(bed.synth.gain.calls.length, 1, "one fade-out on the first tick");

  t.mock.timers.tick(500);
  sandbox.worldSwap(near("rB", posNear.rB, pacer.routeId));   // same target, same routeId (still rA)
  t.mock.timers.tick(500);
  sandbox.worldSwap(near("rB", posNear.rB, pacer.routeId));   // 1000ms elapsed since the first call

  assert.equal(bed.synth.gain.calls.length, 1,
    "repeat ticks toward the still-pending target must not call setSynthLevel(0) again");
  assert.equal(pacer.routeId, "rA",
    "not yet — only 1000ms of the original 1500ms window has elapsed");

  t.mock.timers.tick(500);   // 1500ms total since the FIRST call
  assert.equal(pacer.routeId, "rB",
    "the swap landed on its original deadline — a naive re-arm on every tick would have pushed " +
    "this past 1500ms and it would still read rA (silent the whole time)");
});

test("Critical: a target change while a swap is pending cancels it and retargets, rather than stubbornly completing to the abandoned route", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pacer = { routeId: "rA", world: true, pos: posNear.rB };
  const bed = { synth: fakeSynth() };
  const sandbox = swapFactory(pacer, bed, { mute: {}, solo: {} }, { fade: 0.35, maxVoices: 4 },
    {}, {}, swapRoutes, stubPatchOf);

  sandbox.worldSwap(near("rB", posNear.rB, pacer.routeId));   // -> rB pending, lands at t=1500
  t.mock.timers.tick(700);

  pacer.pos = posNear.rC;
  const towardC = near("rC", posNear.rC, pacer.routeId);
  assert.equal(towardC.id, "rC", "fixture sanity: rC really is nearest from posNear.rC");
  sandbox.worldSwap(towardC);   // should cancel rB's pending swap and pend rC instead, from t=700

  t.mock.timers.tick(800);   // t=1500 — rB's original, now-abandoned deadline
  assert.equal(pacer.routeId, "rA", "rB's swap must have been cancelled, not merely delayed");

  t.mock.timers.tick(700);   // t=2200 — 1500ms after the retarget to rC
  assert.equal(pacer.routeId, "rC", "the retargeted swap to rC landed on its own deadline");
});

test("Important: a route change before bed.synth exists takes the no-fade path synchronously, and normal fades resume once it does", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pacer = { routeId: null, world: true, pos: posNear.rA };
  /* {} rather than null: bed.synth is what wasRunning actually gates on (worldStart's own
     bootstrap call to worldMove runs before bedStart ever constructs bed.synth). */
  const bed = {};
  const sandbox = swapFactory(pacer, bed, { mute: {}, solo: {} }, { fade: 0.35, maxVoices: 4 },
    {}, {}, swapRoutes, stubPatchOf);

  sandbox.worldSwap(near("rA", posNear.rA, pacer.routeId));   // the worldStart bootstrap call
  assert.equal(pacer.routeId, "rA", "committed synchronously even though nothing is audible yet");

  pacer.pos = posNear.rB;
  sandbox.worldSwap(near("rB", posNear.rB, pacer.routeId));
  assert.equal(pacer.routeId, "rB",
    "still pre-Sound: still synchronous — the first real route must not open with 1.5s of silence");

  bed.synth = fakeSynth();   // Sound pressed
  pacer.pos = posNear.rC;
  sandbox.worldSwap(near("rC", posNear.rC, pacer.routeId));
  assert.equal(pacer.routeId, "rB", "now that bed.synth exists, the swap is deferred, not synchronous");

  t.mock.timers.tick(1500);
  assert.equal(pacer.routeId, "rC", "and lands after the full crossfade window once it does");
});
