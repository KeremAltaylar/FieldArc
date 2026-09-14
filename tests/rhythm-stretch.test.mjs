// tests/rhythm-stretch.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8").replace(/\r\n/g, "\n");

function slice(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  assert.ok(start !== -1, `start marker not found: ${startMarker}`);
  const end = html.indexOf(endMarker, start + startMarker.length);
  assert.ok(end !== -1, `end marker not found: ${endMarker}`);
  assert.ok(end > start, `"${endMarker}" occurs at or before "${startMarker}"`);
  return html.slice(start, end);
}

/* Pure functions can actually be extracted and run, rather than only pattern-matched —
   same technique tests/rhythm-idiom.test.mjs's extractFn already uses for metricWeight. */
function extractFn(name, endMarker) {
  const src = slice("function " + name + "(", endMarker);
  const openParen = src.indexOf("(");
  const params = src.slice(openParen + 1, src.indexOf(")", openParen));
  const body = src.slice(src.indexOf("{") + 1, src.lastIndexOf("}"));
  return new Function(params, body);
}

test("stretchParams(0) and stretchParams(1) are the fixed neutral and extreme triples", () => {
  const stretchParams = extractFn("stretchParams", "function ");
  const at0 = stretchParams(0);
  assert.equal(at0.playbackRate, 1, "no stretch means normal playback speed");
  assert.ok(at0.grainSize > 0 && at0.overlap > 0 && at0.overlap <= 1,
    "grain settings stay valid even though the blend silences this branch at amount 0");
  const at1 = stretchParams(1);
  assert.ok(at1.playbackRate < at0.playbackRate, "full stretch plays back slower, not faster");
  assert.ok(at1.playbackRate > 0, "playbackRate must stay positive — 0 or negative breaks GrainPlayer");
});

test("stretchParams clamps out-of-range input instead of extrapolating", () => {
  const stretchParams = extractFn("stretchParams", "function ");
  assert.deepEqual(stretchParams(-5), stretchParams(0), "below 0 clamps to the amount=0 triple");
  assert.deepEqual(stretchParams(5), stretchParams(1), "above 1 clamps to the amount=1 triple");
});

test("stretchParams moves all three values monotonically and smoothly across the range", () => {
  const stretchParams = extractFn("stretchParams", "function ");
  let prevRate = stretchParams(0).playbackRate;
  let prevGrain = stretchParams(0).grainSize;
  let prevOverlap = stretchParams(0).overlap;
  for (let i = 1; i <= 20; i++) {
    const p = stretchParams(i / 20);
    assert.ok(p.playbackRate <= prevRate, "playbackRate falls (or holds) as amount rises");
    assert.ok(p.grainSize >= prevGrain, "grainSize rises (or holds) as amount rises");
    assert.ok(p.overlap >= prevOverlap, "overlap rises (or holds) as amount rises, for a smoother cloud");
    prevRate = p.playbackRate; prevGrain = p.grainSize; prevOverlap = p.overlap;
  }
});

test("soundOf backfills stretch at 0 without touching radius/gain/zoneR", () => {
  const of = slice("function soundOf(f)", "function soundOfZone(");
  assert.match(of, /q\.stretch\s*=\s*0/, "stretch must default to 0 on a fresh point");
  assert.match(of, /if\s*\(q\.stretch === undefined\)\s*\{\s*q\.stretch = 0;\s*\}/,
    "an existing point without stretch must be backfilled by absence-check, not overwritten");
});

test("soundOfZone's no-feature fallback also carries stretch", () => {
  const zoneOf = slice("function soundOfZone(z)", "function stretchParams(");
  assert.match(zoneOf, /stretch:\s*0/);
});

test("buildSoundRow's reset default is data-driven, so a new field doesn't reset to the wrong value", () => {
  const row = slice("function buildSoundRow(fl, q, commitQ)", "\n  }\n");
  assert.match(row, /fl\.def\s*===?\s*undefined/,
    "the dataset.def lookup must consult fl.def before falling back to the three legacy cases");
});

test("renderRhythmPanel renders the soundscape panel for soundscape-mode points, before the hits-only return", () => {
  const panel = slice("function renderRhythmPanel()", "function gcd(");
  assert.match(panel, /audio_mode === "soundscape"/);
  assert.match(panel, /renderSoundscapePanel\(/);
});

test("renderSoundscapePanel shows an empty state with no recording attached, and a stretch row otherwise", () => {
  const src = slice("function renderSoundscapePanel(f, q, commitQ, body)", "\n  }\n");
  assert.match(src, /properties\.audio/, "must check whether a recording is attached");
  assert.match(src, /"stretch"/, "must expose the stretch field");
  assert.match(src, /buildSoundRow\(/, "must reuse the existing row builder, not a bespoke one");
});

test("ensureVoice builds a blended GrainPlayer reading the same url as the dry player", () => {
  const src = slice("function ensureVoice(z, d)", "\n  }\n");
  assert.match(src, /new Tone\.GrainPlayer\(/);
  assert.match(src, /stretchBlend\s*=\s*makeBlend\(Tone,\s*0\)/);
  assert.match(src, /\.connect\(v\.stretchBlend\.a\)/, "the dry Player must feed the blend's dry side");
  assert.match(src, /\.connect\(v\.stretchBlend\.b\)/, "the GrainPlayer must feed the blend's wet side");
  assert.match(src, /v\.stretchBlend\.connect\(v\.filter\)/,
    "the blend's output, not the dry player directly, must now feed the filter");
  assert.doesNotMatch(src, /\}\)\.connect\(v\.filter\)/,
    "the dry Player's own .connect(...) must no longer go straight to v.filter");
});

test("ensureVoice re-applies stretch on an already-ready voice, ramped like gain and filter", () => {
  const src = slice("function ensureVoice(z, d)", "\n  }\n");
  const readyBranch = src.slice(src.indexOf("if (v.ready)"), src.indexOf("v.idle = false;"));
  assert.match(readyBranch, /stretchParams\(/);
  assert.match(readyBranch, /v\.stretchBlend\.fade\.rampTo\(/);
});

test("the voice-disposal block also disposes grainPlayer and stretchBlend", () => {
  const src = slice("v.player.stop(); v.player.dispose();", "v.gain.dispose();");
  assert.match(src, /grainPlayer/);
  assert.match(src, /stretchBlend/);
});
