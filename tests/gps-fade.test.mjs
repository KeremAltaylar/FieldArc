// tests/gps-fade.test.mjs — leaving the route fades the piece out, returning fades it in.
/* Kerem, 2026-09-20: "I want gps mode listener when he leaves the route slowly sound fade out
   and visa versa when he catches it fade in". Before this the walk simply held at full level
   past the 120 m leash. */
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
const walkLevel = new Function(src("walkLevel") + "; return walkLevel;")();
const FROM = 60, LEASH = 120;

test("full level on the route and anywhere inside the fade distance", () => {
  for (const d of [0, 1, 30, 59.9, 60]) { assert.equal(walkLevel(d, FROM, LEASH), 1, d + " m"); }
});

test("silent at the leash and beyond, never negative", () => {
  for (const d of [120, 121, 500, 5000]) { assert.equal(walkLevel(d, FROM, LEASH), 0, d + " m"); }
});

test("the fade falls smoothly across the band, halfway at the middle", () => {
  assert.ok(Math.abs(walkLevel(90, FROM, LEASH) - 0.5) < 1e-12, "half level halfway out");
  let last = 1;
  for (let d = 60; d <= 120; d += 0.5) {
    const v = walkLevel(d, FROM, LEASH);
    assert.ok(v <= last + 1e-12, "never rises on the way out (" + d + " m)");
    assert.ok(v >= 0 && v <= 1, "stays a gain (" + d + " m)");
    last = v;
  }
});

/* A corner in the curve is audible as a lurch. The cosine leaves the ends flat: the first and
   last metre of the band must move the level far less than the middle metre does. */
test("no corner at either end of the band", () => {
  const step = (a, b) => Math.abs(walkLevel(a, FROM, LEASH) - walkLevel(b, FROM, LEASH));
  const mid = step(90, 91);
  assert.ok(step(60, 61) < mid / 4, "flat where the fade starts");
  assert.ok(step(119, 120) < mid / 4, "flat where it reaches silence");
});

test("the level is applied as a ramp on the one gain the whole walk plays through", () => {
  assert.match(src("setWalkLevel"), /bed\.walk\.gain\.rampTo\(level, WALK_FADE\)/,
    "a step on a gain is a click");
  assert.match(html, /var walk = new Tone\.Gain\(1\)\.connect\(limiter\);/);
  assert.match(html, /master: walk,\s*\n?\s*walk: walk, synth: synth, limiter: limiter/,
    "everything that connects to the master now passes through it");
});

test("an imprecise fix holds the level; past the leash it is zero and the walker still holds", () => {
  const fix = src("gpsFix");
  const accAt = fix.indexOf("acc > GPS_ACC_MAX"), setAt = fix.indexOf("setWalkLevel(walkLevel(");
  const leashAt = fix.indexOf("pr.dist > GPS_LEASH");
  assert.ok(accAt !== -1 && setAt > accAt, "the accuracy gate returns before the level is touched");
  assert.ok(leashAt > setAt, "the level is set before the leash returns, so it reaches 0 out there");
  assert.match(fix, /setWalkLevel\(walkLevel\(pr\.dist, GPS_FADE_FROM, GPS_LEASH\)\)/);
  assert.match(src("gpsSet"), /if \(!on\) \{ setWalkLevel\(1\); \}/,
    "leaving GPS mode must not leave a silent walk behind");
});

test("the fade band is 60 m to the existing 120 m leash, ramped over 0.6 s", () => {
  assert.match(html, /var GPS_FADE_FROM = 60;/);
  assert.match(html, /var GPS_LEASH = 120;/);
  assert.match(html, /var WALK_FADE = 0\.6;/);
});
