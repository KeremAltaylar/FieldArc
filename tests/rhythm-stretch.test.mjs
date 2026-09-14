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
  assert.ok(at0.grainSize > 0, "grain settings stay valid even though the blend silences this branch at amount 0");
  assert.ok(at0.overlap > 0 && at0.overlap < at0.grainSize / at0.playbackRate,
    "overlap must be a positive fraction of the grain period, never longer than the grain itself");
  const at1 = stretchParams(1);
  assert.ok(at1.playbackRate < at0.playbackRate, "full stretch plays back slower, not faster");
  assert.ok(at1.playbackRate > 0, "playbackRate must stay positive — 0 or negative breaks GrainPlayer");
  assert.ok(at1.overlap > 0 && at1.overlap < at1.grainSize / at1.playbackRate,
    "the same overlap-vs-period guarantee must hold at full stretch too");
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
    const period = p.grainSize / p.playbackRate;
    assert.ok(p.playbackRate <= prevRate, "playbackRate falls (or holds) as amount rises");
    assert.ok(p.grainSize >= prevGrain, "grainSize rises (or holds) as amount rises");
    assert.ok(p.overlap > 0, "overlap must always be positive");
    assert.ok(p.overlap < period, "overlap must never outlast the grain period it was computed from");
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

test("renderRhythmPanel falls through to the soundscape panel for anything that isn't hits or grains", () => {
  const panel = slice("function renderRhythmPanel()", "function gcd(");
  assert.match(panel, /audio_mode !== "hits"/,
    "the soundscape branch must be the fallback for everything but hits, after grains is checked");
  assert.doesNotMatch(panel, /audio_mode === "soundscape"/,
    "must not gate on a literal audio_mode === \"soundscape\" check — a fresh point never has " +
    "audio_mode set at all, and is treated as soundscape everywhere else via that same fallback");
  assert.match(panel, /renderSoundscapePanel\(/);
});

test("a point with no audio_mode set still gets the soundscape panel, not silently nothing", () => {
  const panel = slice("function renderRhythmPanel()", "function gcd(");
  const grainsIdx = panel.indexOf('audio_mode === "grains"');
  const soundscapeIdx = panel.indexOf('audio_mode !== "hits"');
  assert.ok(grainsIdx !== -1 && soundscapeIdx !== -1 && grainsIdx < soundscapeIdx,
    "grains must be checked before the soundscape fallback runs");
  const fallthrough = panel.slice(soundscapeIdx, panel.indexOf("return;", soundscapeIdx) + "return;".length);
  assert.match(fallthrough, /renderSoundscapePanel\(/,
    "an undefined audio_mode (a brand-new point) is neither \"grains\" nor \"hits\", so it must " +
    "fall into this branch and render the soundscape panel rather than returning empty-handed");
});

test("renderSoundscapePanel shows an empty state with no recording attached, and a stretch row otherwise", () => {
  const src = slice("function renderSoundscapePanel(f, q, commitQ, body)", "\n  }\n");
  assert.match(src, /properties\.has_audio/,
    "must gate on has_audio, the same flag buildZones/updateBed actually key playback on");
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
  assert.match(readyBranch, /applyStretch\(/,
    "the ready branch delegates to applyStretch (which itself calls stretchParams) rather than inlining it");
  assert.match(readyBranch, /v\.stretchBlend\.fade\.rampTo\(/);
});

test("the voice-disposal block also disposes grainPlayer and stretchBlend", () => {
  const src = slice("v.player.stop(); v.player.dispose();", "v.gain.dispose();");
  assert.match(src, /grainPlayer/);
  assert.match(src, /stretchBlend/);
});

test("applyStretch sets playbackRate/grainSize/overlap via the real stretchParams, tracks what it applied, and skips redundant writes", () => {
  const stretchParams = extractFn("stretchParams", "function ");
  /* applyStretch calls stretchParams internally, so the extraction has to inject the real
     one rather than leave it as an undefined free variable — same shape
     tests/rhythm-hit-fx.test.mjs already uses to inject HIT_SLOTS/DIVISIONS into
     randomHitFx. The end marker must land AFTER applyStretch's own closing brace (not
     coincide with it) so the whole "function applyStretch(node, amount) { ... }"
     declaration survives intact for the factory to declare-and-return by name —
     "function euclid(" is the real next top-level function once this task's edit lands,
     and applyStretch's own body has no nested "function" keyword to collide with it. */
  const src = slice("function applyStretch(node, amount)", "function euclid(");
  const decl = src.slice(0, src.lastIndexOf("}") + 1);
  const factory = new Function("stretchParams", decl + "\nreturn applyStretch;");
  const applyStretch = factory(stretchParams);

  const node = {};
  applyStretch(node, 0.5);
  const expected = stretchParams(0.5);
  assert.equal(node.playbackRate, expected.playbackRate);
  assert.equal(node.grainSize, expected.grainSize);
  assert.equal(node.overlap, expected.overlap);
  assert.equal(node.__stretchAmt, 0.5, "must record what it applied, for the next call to compare against");

  node.playbackRate = -1; // simulate something else having touched the node meanwhile
  applyStretch(node, 0.5); // same amount again
  assert.equal(node.playbackRate, -1, "an unchanged amount must not touch the node again");

  applyStretch(node, 0.9);
  assert.notEqual(node.playbackRate, -1, "a changed amount must update the node");
});

test("applyStretch is a safe no-op with no node", () => {
  const src = slice("function applyStretch(node, amount)", "function euclid(");
  assert.match(src, /if\s*\(!node/);
});

test("ensureVoice uses applyStretch instead of its own inline reassignment", () => {
  const src = slice("function ensureVoice(z, d)", "\n  }\n");
  assert.match(src, /applyStretch\(v\.grainPlayer,\s*q\.stretch\)/,
    "the ready branch must delegate to the shared helper");
  assert.match(src, /applyStretch\(v\.grainPlayer,\s*q\.stretch\)/,
    "the construction path must also delegate to the shared helper, seeding the GrainPlayer's initial values");
  assert.doesNotMatch(src, /v\.grainPlayer\.playbackRate\s*=/,
    "no more inline reassignment of the GrainPlayer's own properties — applyStretch owns that now");
  assert.doesNotMatch(src, /v\.stretchAmt/,
    "the per-node __stretchAmt bookkeeping lives on the GrainPlayer itself now, not on v");
});

test("defaultRhythm's voices carry a stretch field, off by default", () => {
  const def = slice("function defaultRhythm()", "function ");
  const matches = def.match(/stretch:\s*0/g) || [];
  assert.equal(matches.length, 4, "all four voices must default stretch to 0");
});

test("rhythmOf backfills stretch without touching the other five per-voice fields", () => {
  const of = slice("function rhythmOf(f)", "function buildRhythmFx(");
  assert.match(of, /v\.stretch\s*===?\s*undefined/,
    "stretch must be backfilled by absence-check, not overwritten if already set");
  const backfillStart = of.indexOf("if (v.crush === undefined)");
  assert.ok(backfillStart !== -1, "the per-field backfill block must exist");
  const nextFieldOrEnd = of.slice(backfillStart).search(/\n\s*if\s*\(!r\.grains\)|\n\s*return r;/);
  const scoped = of.slice(backfillStart, backfillStart + (nextFieldOrEnd === -1 ? of.length : nextFieldOrEnd));
  assert.doesNotMatch(scoped, /\.pulses\s*=|\.rotate\s*=|\.gain\s*=|\.pitch\s*=/,
    "backfilling stretch must not rewrite an existing voice's pattern or level");
});

test("randomHitFx also rolls stretch for all four voices, within range", () => {
  const src = slice("function randomHitFx(r)", "function advanceSentence(");
  const decl = src.slice(0, src.lastIndexOf("}") + 1);
  const factory = new Function("HIT_SLOTS", "DIVISIONS", decl + "\nreturn randomHitFx;");
  const randomHitFx = factory(["low", "mid", "high", "rand"], ["4n", "4n.", "8n", "8n.", "16n", "2n", "1n"]);
  for (let i = 0; i < 20; i++) {
    const r = { voices: { low: {}, mid: {}, high: {}, rand: {} } };
    randomHitFx(r);
    ["low", "mid", "high", "rand"].forEach((slot) => {
      assert.ok(r.voices[slot].stretch >= 0 && r.voices[slot].stretch <= 1, "stretch in range");
    });
  }
});

test("each voice row exposes a stretch control", () => {
  const panel = slice("function renderRhythmPanel()", "function gcd(");
  assert.match(panel, /"stretch"/);
});

test("applyHitStretch ramps each slot's warp blend and reapplies applyStretch, safely with no live R", () => {
  const src = slice("function applyHitStretch(R, r)", "\n  }\n");
  assert.match(src, /if\s*\(!R \|\| !R\.stretch\)\s*\{\s*return;\s*\}/,
    "a setter editing a point currently out of range must not throw");
  assert.match(src, /applyStretch\(/);
  assert.match(src, /\.blend\.fade\.rampTo\(/);
});

test("ensureRhythm decodes each slot's recording once and builds both the dry player and its warp engine from the same buffer", () => {
  const src = slice("function ensureRhythm(z)", "function disposeRhythm(");
  assert.match(src, /R\.stretch\s*=\s*\{\}/);
  assert.match(src, /R\.buffers\s*=\s*\{\}/);
  assert.match(src, /new Tone\.ToneAudioBuffer\(/, "one decode per slot, not two");
  assert.match(src, /new Tone\.Player\(\{\s*url:\s*R\.buffers\[slot\]/,
    "the dry player must read the already-decoded buffer, not fetch the url again");
  assert.match(src, /new Tone\.GrainPlayer\(\{\s*url:\s*R\.buffers\[slot\]/,
    "the warp engine must read the same already-decoded buffer");
  assert.match(src, /\.connect\(R\.fx\[slot\]\.input\)/,
    "the blend, not either player directly, must feed the slot's insert chain");
});

test("disposeRhythm disposes each slot's buffer and warp engine, not just the player", () => {
  const src = slice("function disposeRhythm(id)", "\n  }\n");
  assert.match(src, /R\.buffers/);
  assert.match(src, /R\.stretch/);
});

test("rhythmStep triggers each slot's warp engine alongside its dry hit, with pitch via detune not playbackRate", () => {
  const step = slice("function rhythmStep(time)", "function updateBed");
  assert.match(step, /grainPlayer\.detune\s*=/,
    "pitch must reach the warp engine via detune — playbackRate is already the stretch amount's own knob");
  assert.doesNotMatch(step, /grainPlayer\.playbackRate\s*=/,
    "rhythmStep must never touch the warp engine's playbackRate directly — only applyStretch may");
  assert.match(step, /grainPlayer\.start\(time\)/);
});

test("a stretched hit is capped to MAX_STRETCH_HIT_S regardless of how slow playbackRate makes it", () => {
  const step = slice("function rhythmStep(time)", "function updateBed");
  assert.match(step, /grainPlayer\.stop\(time \+ MAX_STRETCH_HIT_S\)/,
    "a non-looping GrainPlayer at an extreme stretch would otherwise take several seconds " +
    "to finish on its own, long after the pattern has retriggered on top of it");
});

test("rhythmStep applies each point's stretch once ready, alongside its fx, without new scheduling", () => {
  const step = slice("function rhythmStep(time)", "function updateBed");
  assert.match(step, /applyHitStretch\(/);
  assert.doesNotMatch(step, /scheduleRepeat|\.clear\(/,
    "this task must never add a new Transport scheduling call");
});
