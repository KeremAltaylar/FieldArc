// tests/mobile-budget.test.mjs — what a phone is allowed to spend on the synth layer.
/* Kerem, 2026-09-21, after the reverb fix shipped: "phone is still laggy and latency rich that
   it glitches a little, so we should consider mobile."

   Measured again, this time including the thing that had never been costed. One PaulX stretch
   voice is 2.15 % of realtime (benchmarked directly in Node — no AudioContext, so this harness's
   broken audio clock cannot reach it), so two voices are ~4.3 %. The recordings are nearly free.
   The route synth layer is the whole bill. From a ~39 % baseline on the dev desktop:

     warp: Chorus -> LFO on the filter .... ~10 points
     drop the three delay lines ........... ~9 points
     drop the third voice (v3) ............ ~11 points
     drop the sector counter-line ......... ~12 points
     no reverb at all ..................... ~6 points   (already cheap since Freeverb)

   Tone.Chorus had become the single most expensive element — more than all four rooms together.
   Kerem chose the two that keep every musical line: LFO warp and no delays. Both phone-only. */
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

test("latency is an explicit 50ms, not a keyword", () => {
  const fn = src("tuneToneContext");
  assert.match(fn, /latencyHint: 0\.05/,
    'Kerem felt "playback" as latency on Android; "interactive" is the buffer that glitches. ' +
    "A number sits between the two and means the same thing on every platform");
  assert.ok(!/"playback"|"interactive"/.test(fn), "no keyword left to argue with the number");
});

/* ---- Warp ---- */

test("a phone's warp is a Vibrato; everything else keeps its chorus", () => {
  const fn = src("makeWarp");
  assert.match(fn, /smallDevice\(\)/);
  assert.match(fn, /new Tone\.Chorus\(opts\)/, "a desktop is unchanged");
  assert.match(fn, /new Tone\.Vibrato/,
    "the same modulated-delay idea with one line instead of a stereo pair: measured 16.3% " +
    "against the chorus's 25.7%, over an 8.4% passthrough floor");
  /* All three voices go through it — pad, counter-line and third voice each had their own. */
  const build = src("buildVoice");
  assert.equal((build.match(/makeWarp\(Tone, \{/g) || []).length, 3,
    "pad, sector and v3 all get their warp from one place");
  assert.ok(!/new Tone\.Chorus/.test(build), "no chorus built directly any more");
});

test("the stand-in answers everything the morphs ask of a warp", () => {
  /* voiceStep/sectorStep/thirdStep all do `V.warp.wet.rampTo(x, 0.3)` and `V.warp.depth = y`.
     Chorus exposes depth as a number with a setter, Vibrato as a Param — assigning a number
     straight onto a Param replaces the object and kills the modulation silently. */
  const fn = src("makeWarp");
  assert.match(fn, /Object\.defineProperty\(v, "depth"/,
    "depth must take a number, the way the chorus did");
  assert.match(fn, /depthParam\.value = Math\.max\(0, Math\.min\(1, d\)\)/, "clamped to its range");
  assert.match(fn, /v\.start = function/, "the call sites call .start(); Vibrato has no such method");
});

/* The first attempt put an LFO on each voice's filter cutoff. voiceStep/sectorStep/thirdStep
   already ramp those cutoffs from the morphs, and Tone marks a param with a signal connected to
   it as overridden with range [0, 0] — so every morph tick threw RangeError and the filter
   stopped following its morph. Caught by reading the console, not by any test. */
test("a warp never borrows a parameter something else already drives", () => {
  const fn = src("makeWarp");
  assert.ok(!/frequency\)/.test(fn.replace(/frequency: opts\.frequency/g, "")),
    "nothing here may connect into a filter's frequency — the morphs own it");
  assert.ok(!/new Tone\.LFO/.test(fn), "and the LFO that did is gone");
});

/* ---- Delays ---- */

test("a phone's voices reach the room without the delay line", () => {
  const fn = src("buildFxChain");
  assert.match(fn, /if \(smallDevice\(\)\)/);
  assert.match(fn, /new Tone\.FeedbackDelay/, "a desktop still has its echoes");
  const small = fn.slice(fn.indexOf("if (smallDevice())"));
  assert.ok(!/FeedbackDelay/.test(small.slice(0, small.indexOf("return fx;"))) ||
            small.indexOf("FeedbackDelay") > small.indexOf("return fx;"),
    "the small-device branch must not build one");
});

test("the delay handles still exist on a phone, so every patch write lands somewhere", () => {
  /* applyPatchToVoice ramps fx/fx2/fx3 .delay.delayTime/.feedback/.wet unconditionally, and
     buildVoice CONNECTS voices into fx.delay. A phone that simply omitted them would throw on
     the first patch apply and route no audio at all. */
  const fn = src("buildFxChain");
  const small = fn.slice(fn.indexOf("if (smallDevice())"), fn.indexOf("return fx;"));
  ["delayTime", "feedback", "wet"].forEach((k) => {
    assert.ok(small.includes("dIn." + k + " ="), "the small-device branch must still expose ." + k);
  });
  assert.match(small, /dIn\.connect\(fx\.reverb\)/, "and still carry the audio to the room");
});

test("what a phone gives up is the echo, not a voice", () => {
  /* The cuts Kerem chose deliberately keep all four lines. If a future change starts skipping
     a whole voice on small devices, that is a musical decision and must not arrive quietly. */
  const build = src("buildVoice");
  assert.ok(!/smallDevice\(\)/.test(build),
    "buildVoice builds every voice on every device — the savings come from makeWarp and " +
    "buildFxChain, not from silencing a line");
});
