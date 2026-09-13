import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* Newlines normalised: index.html is stored with CRLF, so a marker written with "\n" (as the
   randomHitFx end-marker below is) never matches and the slice fails for a reason that has
   nothing to do with the code under test — same fix as tests/setter-ui.test.mjs. */
const html = readFileSync("index.html", "utf8").replace(/\r\n/g, "\n");

function slice(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  assert.ok(start !== -1, `start marker not found: ${startMarker}`);
  const end = html.indexOf(endMarker, start + startMarker.length);
  assert.ok(end !== -1, `end marker not found: ${endMarker}`);
  assert.ok(end > start, `"${endMarker}" occurs at or before "${startMarker}"`);
  return html.slice(start, end);
}

test("defaultRhythm's voices carry the five new fields, all at their off position", () => {
  const def = slice("function defaultRhythm()", "function ");
  ["crush: 0", "drive: 0", 'delayDiv: "8n"', "delayFb: 0", "delayWet: 0"].forEach((needle) => {
    assert.ok(def.includes(needle), `defaultRhythm() must include ${needle}`);
  });
});

test("rhythmOf backfills all five new voice fields without touching pulses/rotate/gain/pitch", () => {
  const of = slice("function rhythmOf(f)", "function buildRhythmFx(");
  ["crush", "drive", "delayDiv", "delayFb", "delayWet"].forEach((k) => {
    assert.match(of, new RegExp("v\\." + k + "\\s*===?\\s*undefined"),
      k + " must be backfilled by absence-check, not overwritten if already set");
  });
  /* The backfill block itself must never assign pulses/rotate/gain/pitch — only
     randomRhythm() (an explicit setter action) may do that. */
  const backfillStart = of.indexOf('if (v.crush === undefined)');
  assert.ok(backfillStart !== -1, "the per-field backfill block must exist");
  const nextFieldOrEnd = of.slice(backfillStart).search(/\n\s*if\s*\(!r\.grains\)|\n\s*return r;/);
  const scoped = of.slice(backfillStart, backfillStart + (nextFieldOrEnd === -1 ? of.length : nextFieldOrEnd));
  assert.doesNotMatch(scoped, /\.pulses\s*=|\.rotate\s*=|\.gain\s*=|\.pitch\s*=/,
    "backfilling the new FX fields must not rewrite an existing voice's pattern or level");
});

test("randomHitFx rolls all five fields for all four voices, within valid ranges", () => {
  /* End marker is the next real function's name, not a bare "\n  }\n" or a generic
     "function " — randomHitFx's own body contains a nested `function (slot) {`, so a bare
     "function " marker matches that inner expression first, and "\n  }\n" lands before
     randomHitFx's own closing brace rather than after it. Either would truncate the
     extracted source into something new Function can't parse or run. */
  const src = slice("function randomHitFx(r)", "function advanceSentence(");
  const body = src.slice(0, src.lastIndexOf("}") + 1);
  const factory = new Function("HIT_SLOTS", "DIVISIONS", body + "\nreturn randomHitFx;");
  const randomHitFx = factory(["low", "mid", "high", "rand"], ["4n", "4n.", "8n", "8n.", "16n", "2n", "1n"]);
  for (let i = 0; i < 20; i++) {
    const r = { voices: { low: {}, mid: {}, high: {}, rand: {} } };
    randomHitFx(r);
    ["low", "mid", "high", "rand"].forEach((slot) => {
      const v = r.voices[slot];
      assert.ok(v.crush >= 0 && v.crush <= 1, "crush in range");
      assert.ok(v.drive >= 0 && v.drive <= 1, "drive in range");
      assert.ok(["4n", "4n.", "8n", "8n.", "16n", "2n", "1n"].includes(v.delayDiv), "delayDiv is a real division");
      assert.ok(v.delayFb >= 0 && v.delayFb <= 0.85, "delayFb in range");
      assert.ok(v.delayWet >= 0 && v.delayWet <= 1, "delayWet in range");
    });
  }
});

test("the rhythm panel has a Randomize effects action, separate from Generate a pattern", () => {
  const panel = slice("function renderRhythmPanel()", "function gcd(");
  assert.match(panel, /randomHitFx\(/);
  assert.match(panel, /"Randomize effects"/);
  assert.match(panel, /"Generate a pattern"/);
});

test("each voice row exposes crush, drive and a delay division/feedback/mix", () => {
  const panel = slice("function renderRhythmPanel()", "function gcd(");
  ["crush", "drive", "delayFb", "delayWet"].forEach((k) => {
    assert.ok(panel.includes('"' + k + '"'), "voice row must include a " + k + " control");
  });
  assert.match(panel, /DIV_LABEL/, "the delay division must show a real division label, not a bare code");
});

test("buildHitFx wires input through bitcrush, distortion and delay inserts to output, each blended via makeBlend", () => {
  const src = slice("function buildHitFx(Tone)", "\n  }\n");
  assert.match(src, /new Tone\.BitCrusher\(/, "bitcrush insert");
  assert.match(src, /new Tone\.WaveShaper\(/, "distortion insert, matching the shared room's own shape");
  assert.match(src, /new Tone\.FeedbackDelay\(/, "an independent per-slot delay");
  const blendCalls = src.match(/makeBlend\(Tone,\s*0\)/g) || [];
  assert.equal(blendCalls.length, 3, "each of the three inserts gets its own dry/wet blend");
  assert.doesNotMatch(src, /Tone\.CrossFade/, "A-17: makeBlend, never Tone.CrossFade");
});

test("buildHitFx returns every node it creates, so disposeRhythm can clean all of them up", () => {
  const src = slice("function buildHitFx(Tone)", "\n  }\n");
  const returnLine = src.slice(src.lastIndexOf("return"));
  ["input", "crush", "crushBlend", "shape", "drivePre", "drivePost", "driveBlend",
   "delay", "delayBlend", "output"].forEach((key) => {
    assert.match(returnLine, new RegExp("\\b" + key + "\\b"), "buildHitFx must return " + key);
  });
});

test("disposeRhythm disposes every per-slot fx node, not just the player", () => {
  const src = slice("function disposeRhythm(id)", "\n  }\n");
  assert.match(src, /R\.fx/, "disposeRhythm must reach into the per-slot fx chains");
});

test("applyHitFx maps crush to both the wet blend and the BitCrusher's own bit depth", () => {
  const src = slice("function applyHitFx(R, r)", "\n  }\n");
  assert.match(src, /crushBlend\.fade\.rampTo\(/);
  assert.match(src, /\.crush\.bits\s*=/);
  assert.match(src, /driveBlend\.fade\.rampTo\(/);
  assert.match(src, /delayBlend\.fade\.rampTo\(/);
  assert.match(src, /delay\.delayTime\.rampTo\(/);
  assert.match(src, /delay\.feedback\.rampTo\(/);
});

test("applyHitFx is safe to call with no live R", () => {
  const src = slice("function applyHitFx(R, r)", "\n  }\n");
  assert.match(src, /if\s*\(!R \|\| !R\.fx\)\s*\{\s*return;\s*\}/,
    "a setter editing a point currently out of range must not throw");
});

test("ensureRhythm connects each player through its slot's fx chain, not straight to R.gain", () => {
  const src = slice("function ensureRhythm(z)", "function disposeRhythm(");
  assert.match(src, /R\.fx\s*=\s*\{\}/);
  assert.match(src, /buildHitFx\(Tone\)/);
  assert.match(src, /\.connect\(R\.fx\[slot\]\.input\)/,
    "each player must feed its own slot's chain, not R.gain directly");
});

test("rhythmStep applies each point's fx once it is ready, without adding new scheduling", () => {
  const step = slice("function rhythmStep(time)", "function updateBed");
  assert.match(step, /applyHitFx\(/);
  assert.doesNotMatch(step, /scheduleRepeat|\.clear\(/,
    "this plan must never add a new Transport scheduling call");
});
