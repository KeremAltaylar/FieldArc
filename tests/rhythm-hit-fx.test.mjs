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
