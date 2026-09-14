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

test("ensureRhythm's per-slot decode routes the GrainPlayer through its own Tone.Gain before the blend", () => {
  const src = slice("function ensureRhythm(z)", "function disposeRhythm(");
  const onloadStart = src.indexOf("R.buffers[slot] = new Tone.ToneAudioBuffer(");
  assert.ok(onloadStart !== -1, "the per-slot decode callback must still exist");
  const onload = src.slice(onloadStart);
  assert.match(onload, /var stretchGain = new Tone\.Gain\(1\);/,
    "each slot's warp engine must get its own dedicated gain stage");
  assert.match(onload, /new Tone\.GrainPlayer\(\{[^}]*\}\)\s*\.connect\(stretchGain\)/,
    "the GrainPlayer must connect into its own gain stage, not straight into the blend");
  assert.doesNotMatch(onload, /new Tone\.GrainPlayer\(\{[^}]*\}\)\s*\.connect\(blend\.b\)/,
    "the GrainPlayer must no longer connect directly to blend.b");
  assert.match(onload, /stretchGain\.connect\(blend\.b\)/,
    "the gain stage, not the GrainPlayer directly, must feed the blend's wet side");
  assert.match(onload, /R\.stretch\[slot\]\s*=\s*\{\s*blend:\s*blend,\s*grainPlayer:\s*gp,\s*gain:\s*stretchGain\s*\}/,
    "the gain node must be stored on R.stretch[slot] alongside blend and grainPlayer, for " +
    "rhythmStep to schedule its fade and disposeRhythm to clean it up");
});

test("disposeRhythm disposes st.gain, the per-slot warp engine's own gain stage", () => {
  const src = slice("function disposeRhythm(id)", "\n  }\n");
  const stBlock = src.slice(src.indexOf("var st = R.stretch && R.stretch[slot];"));
  assert.match(stBlock, /st\.grainPlayer\.dispose\(\)/);
  assert.match(stBlock, /st\.gain\.dispose\(\)/);
  assert.match(stBlock, /st\.blend\.dispose\(\)/);
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
  assert.match(step, /var stopAt = time \+ MAX_STRETCH_HIT_S;/,
    "a non-looping GrainPlayer at an extreme stretch would otherwise take several seconds " +
    "to finish on its own, long after the pattern has retriggered on top of it");
  assert.match(step, /grainPlayer\.stop\(stopAt\)/);
});

test("GrainPlayer.stop() is never called without first scheduling this slot's own gain to fade to 0", () => {
  const step = slice("function rhythmStep(time)", "function updateBed");
  assert.match(step, /st\.gain\.gain\.linearRampToValueAtTime\(0,\s*stopAt\)/,
    "GrainPlayer's real _onstop forces every sounding grain's own fadeOut to 0 and stops it " +
    "instantly, so the click has to be prevented ahead of time by fading this slot's dedicated " +
    "gain stage down to silence, ending exactly at the same stopAt the grain player itself stops at");
  const stopIdx = step.indexOf("grainPlayer.stop(stopAt)");
  assert.ok(stopIdx !== -1, "grainPlayer.stop(stopAt) must exist");
  const before = step.slice(0, stopIdx);
  const rampIdx = before.lastIndexOf("st.gain.gain.linearRampToValueAtTime(0, stopAt)");
  assert.ok(rampIdx !== -1 && rampIdx < stopIdx,
    "the gain fade-out must be scheduled before the grain player's own .stop() call, not after");
});

test("rhythmStep only triggers the warp engine when this voice's own stretch is actually above 0", () => {
  const step = slice("function rhythmStep(time)", "function updateBed");
  assert.match(step, /st\s*&&\s*st\.grainPlayer\s*&&\s*st\.grainPlayer\.loaded\s*&&\s*\(cfg\.stretch \|\| 0\) > 0/,
    "running the grain clock every pulse for zero audible result is wasted CPU on every point " +
    "that hasn't touched the stretch control, which is the overwhelming majority (default: 0)");
});

test("rhythmStep no longer gates stretch behind a point-level ready latch, and adds no new scheduling", () => {
  const step = slice("function rhythmStep(time)", "function updateBed");
  assert.doesNotMatch(step, /applyHitStretch\(/,
    "rhythmStep must not apply stretch via a point-level latch — each slot seeds its " +
    "own stretch from real data the moment its own decode finishes, in ensureRhythm");
  assert.doesNotMatch(step, /scheduleRepeat|\.clear\(/,
    "this task must never add a new Transport scheduling call");
});

test("R.stretchReady, the point-level ready latch, is fully removed rather than merely bypassed", () => {
  assert.doesNotMatch(html, /stretchReady/,
    "R.stretch is a synchronous {} the instant a point enters range, while R.stretch[slot] " +
    "populates asynchronously per slot on its own decode — a point-level latch fires on the " +
    "very first rhythmStep tick, almost always before any slot has actually decoded, and " +
    "then never fires again, permanently skipping every slot not yet ready");
});

test("each slot seeds its own stretch from real, current data the moment its own decode finishes", () => {
  const src = slice("function ensureRhythm(z)", "function disposeRhythm(");
  const onloadStart = src.indexOf("R.buffers[slot] = new Tone.ToneAudioBuffer(");
  assert.ok(onloadStart !== -1, "the per-slot decode callback must still exist");
  const onload = src.slice(onloadStart);
  assert.match(onload, /rhythmOf\(/,
    "must look up this point's real current voices[slot].stretch, not assume 0 or trust a " +
    "point-level latch that can race ahead of this very decode");
  assert.match(onload, /applyStretch\(gp,\s*amt\)/,
    "the warp engine's initial playbackRate/grainSize/overlap must come from the real value");
  assert.match(onload, /blend\.fade\.rampTo\(amt,/,
    "the blend must be ramped to the real value too — a nonzero saved stretch must not stay " +
    "silently at 0 just because this slot loaded after some other point-level gate fired");
});

test("soundOf backfills warp/morph/field/grit at 0, without touching the fields that came before them", () => {
  const of = slice("function soundOf(f)", "function soundOfZone(");
  ["warp", "morph", "field", "grit"].forEach((k) => {
    assert.match(of, new RegExp("q\\." + k + "\\s*===?\\s*undefined"),
      k + " must be backfilled by absence-check, not overwritten if already set");
  });
  assert.doesNotMatch(of, /\.radius\s*=\s*140;[\s\S]*\.radius\s*=/,
    "radius's own backfill line must not be touched by this addition");
});

test("soundOfZone's no-feature fallback also carries the four new fields", () => {
  const zoneOf = slice("function soundOfZone(z)", "function stretchParams(");
  ["warp:", "morph:", "field:", "grit:"].forEach((k) => {
    assert.match(zoneOf, new RegExp(k.replace(":", "") + ":\\s*0"));
  });
});

test("buildGrit wires input through bitcrush and a tanh drive, blended via makeBlend and never Tone.CrossFade", () => {
  const src = slice("function buildGrit(Tone)", "\n  }\n");
  assert.match(src, /new Tone\.BitCrusher\(/);
  assert.match(src, /new Tone\.WaveShaper\(/);
  assert.match(src, /makeBlend\(Tone,\s*0\)/);
  assert.doesNotMatch(src, /Tone\.CrossFade/, "A-17: makeBlend, never Tone.CrossFade");
});

test("applyGrit ramps the BitCrusher's own bit depth via its Param, not a direct assignment", () => {
  const src = slice("function applyGrit(g, amount)", "\n  }\n");
  assert.match(src, /if \(!g\) \{ return; \}/, "must be a safe no-op with no live grit chain");
  assert.match(src, /g\.crush\.bits\.rampTo\(/,
    "measured against the real Tone.js build earlier this session: BitCrusher.bits is a " +
    "live Param — a direct assignment (.bits = n) silently orphans it from the real DSP");
  assert.doesNotMatch(src, /g\.crush\.bits\s*=[^=]/);
  assert.match(src, /g\.blend\.fade\.rampTo\(/);
});

test("warpStep is a safe no-op with no bed, and never writes playbackRate directly", () => {
  const src = slice("function warpStep(time)", "\n  }\n");
  assert.match(src, /if \(!bed\) \{ return; \}/);
  assert.doesNotMatch(src, /grainPlayer\.playbackRate\s*=/,
    "playbackRate is stretch's own knob, owned by applyStretch — warpStep must never touch it");
});

test("warpStep's warp resets the detune random-walk to 0 rather than freezing it at its last value", () => {
  const src = slice("function warpStep(time)", "\n  }\n");
  assert.match(src, /if \(q\.warp > 0\)/);
  assert.match(src, /v\._warpDetune = 0;/);
  assert.match(src, /v\.grainPlayer\.detune = v\._warpDetune;/);
});

test("warpStep's morph widens the loop window back to the whole buffer at 0, rather than leaving a stale narrow one", () => {
  const src = slice("function warpStep(time)", "\n  }\n");
  assert.match(src, /if \(q\.morph > 0 && dur > 1\)/);
  assert.match(src, /v\.grainPlayer\.loopStart = 0;/);
  assert.match(src, /v\.grainPlayer\.loopEnd = 0;/);
});

test("warpStep clamps morph's loopEnd to the buffer's own duration, since Tone's setter throws past it", () => {
  const src = slice("function warpStep(time)", "\n  }\n");
  assert.match(src, /v\.grainPlayer\.loopEnd = Math\.min\(dur, v\._morphPos \+ winLen\);/,
    "measured against the real Tone.js build: GrainPlayer's loopEnd setter asserts " +
    "0 <= value <= buffer.duration and throws — on a short recording near the top of " +
    "the morph range, _morphPos + winLen can land fractionally past dur");
});

test("warpStep's field jitters grainSize/overlap around stretchParams' own values, not a hardcoded pair", () => {
  const src = slice("function warpStep(time)", "\n  }\n");
  assert.match(src, /if \(q\.field > 0\)/);
  assert.match(src, /stretchParams\(q\.stretch\)/);
  assert.match(src, /v\.grainPlayer\.grainSize\s*=/);
  assert.match(src, /v\.grainPlayer\.overlap\s*=/);
});

test("warpStep resets grainSize/overlap to stretchParams' own values when field is 0, not just when it's above 0", () => {
  /* The original code only ever wrote grainSize/overlap inside `if (q.field > 0)`, with
     no else — turning field back down left the GrainPlayer stranded at its last random
     jitter (up to ±60% off) forever, since nothing else ever revisits those two
     properties once stretch itself stops changing. */
  const src = slice("function warpStep(time)", "\n  }\n");
  const fieldIfIdx = src.indexOf("if (q.field > 0)");
  assert.ok(fieldIfIdx !== -1);
  const afterField = src.slice(fieldIfIdx);
  assert.match(afterField, /\} else \{\s*\n\s*v\.grainPlayer\.grainSize = sp\.grainSize;\s*\n\s*v\.grainPlayer\.overlap = sp\.overlap;\s*\n\s*\}/);
});

test("warpStep applies grit every tick, through applyGrit rather than a second hand-rolled ramp", () => {
  const src = slice("function warpStep(time)", "\n  }\n");
  assert.match(src, /applyGrit\(v\.grit, q\.grit\)/);
});

test("bedStart schedules warpStep on the Transport, never a UI callback, only once per bed", () => {
  const src = slice("function bedStart()", "\n  }\n");
  assert.match(src, /bed\.warpLoop = Tone\.Transport\.scheduleRepeat\(warpStep,/);
});

test("bedStop disposes every grit-chain node, each in its own guarded segment", () => {
  const src = slice("function bedStop()", "\n  }\n");
  assert.match(src, /v\.grit\.input,\s*v\.grit\.crush,\s*v\.grit\.shape,\s*v\.grit\.blend/);
});

test("renderSoundscapePanel exposes warp, morph, field and grit alongside stretch", () => {
  const src = slice("function renderSoundscapePanel(f, q, commitQ, body)", "\n  }\n");
  ["stretch", "warp", "morph", "field", "grit"].forEach((k) => {
    assert.match(src, new RegExp('k:\\s*"' + k + '"'));
  });
});
