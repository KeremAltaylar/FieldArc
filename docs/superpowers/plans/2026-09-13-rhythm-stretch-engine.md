# Rhythm mode v2, part 3: the shared stretch engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One continuous "stretch" knob, backed by one shared `Tone.GrainPlayer`-based engine,
in two places: a per-hit-slot stretch (this plan's Task 3, appended once the sibling
`2026-09-13-rhythm-hit-fx.md` plan has merged, since it touches the exact same `ensureRhythm`/
`rhythmStep` code that plan is rewriting) and the soundscape ambient bed's own extreme,
Paulstretch-style warp (this plan's Task 2, independent of the other plan, buildable now).

**Architecture:** A pure function, `stretchParams(amount)`, maps the 0-1 knob to
`{playbackRate, grainSize, overlap}`. Each call site builds its existing `Tone.Player` exactly
as it does today (untouched, always the dry signal) alongside a new `Tone.GrainPlayer` reading
the same buffer, and blends the two with `makeBlend()` — the same two-summed-gains primitive
already used for crush/drive/delay (A-17: never `Tone.CrossFade`). At `amount = 0` the blend's
`fade` is 0, so the output is the untouched `Tone.Player` signal, bit-identical to today (A-8).

**Why `Tone.GrainPlayer` and not the existing `fireGrains`/`variedGrains` grain-cloud
machinery** the original spec named: see the spec's own 2026-09-13 addendum, linked below.
Short version — `fireGrains` is pulse-triggered, which fits the hit-slot case (already
pulse-driven) but not the soundscape ambient bed, which loops continuously with no clock at
all; reusing it there would mean inventing a new `Tone.Transport.scheduleRepeat` this project
doesn't otherwise need. `Tone.GrainPlayer` needs no external clock and serves both call sites
with the same node type and the same blend shape.

**Tech Stack:** Same as the rest of `index.html` — ES5 `function` expressions, Tone.js v15
(already loaded from unpkg), `Tone.GrainPlayer` is a standard node in that build. No new
library.

**Spec:** `docs/superpowers/specs/2026-09-13-rhythm-mode-v2-design.md` ("The stretch engine"
section and the "Addendum, 2026-09-13" at the end of that document, which supersedes the
`stretchVoice`/`fireGrains` description in the body for the reasons given there).

## Global Constraints

- **`amount = 0` is bit-identical to today.** The blend's `fade` at 0 must route 100% of the
  signal through the untouched `Tone.Player`; the `Tone.GrainPlayer`'s contribution must be
  silent, not merely quiet — same bypass-test method A-8 already requires for crush/drive/delay.
- **No new `Tone.Transport.scheduleRepeat`/`.clear()` call.** Both `Tone.GrainPlayer` instances
  this plan adds run on their own internal grain clock; nothing here needs a Transport tick of
  its own.
- **Every gain-carrying ramp uses `.rampTo(value, BED.fade)` (soundscape side) or the
  established `0.2` (hit-slot side, matching the sibling plan's own ramp time) — never a
  direct assignment on a live gain.** `Tone.GrainPlayer`'s own `playbackRate`/`grainSize`/
  `overlap` are plain JS properties in this Tone.js build, not AudioParams — they are
  reassigned directly, which is correct (there is nothing to ramp; the plain assignment only
  changes how future grains are scheduled, not any live audio-rate signal), not a violation of
  A-2.
- **`stretchParams` is one function, called from both places** — no separate hit-slot and
  soundscape copies of the amount-to-grain-settings mapping.
- Commit messages: a declarative sentence, then what it prevents or what was measured.

## File Structure

| File | Responsibility |
| --- | --- |
| `index.html` | `stretchParams(amount)`/`applyStretch(node, amount)`; `soundOf()`/`soundOfZone()` gain a `stretch` field; `buildSoundRow`'s reset-default lookup becomes data-driven; `ensureVoice()` gains a blended `Tone.GrainPlayer`, then is simplified to use `applyStretch`; a new `renderSoundscapePanel()` and its branch in `renderRhythmPanel()`; per-voice `stretch` field, backfill and slider; `ensureRhythm()`/`disposeRhythm()`/`rhythmStep()` gain a per-slot blended `Tone.GrainPlayer` sharing each slot's already-decoded buffer. |
| `tests/rhythm-stretch.test.mjs` | `stretchParams`'s shape and range; `applyStretch`'s apply-on-change behaviour; the soundscape data-model backfill; `ensureVoice`'s node graph, disposal list and refactor to `applyStretch`; the panel branch and empty state; the per-voice `stretch` field/backfill/slider; the per-slot warp engine's shared-buffer construction, disposal, trigger and duration cap. |

## Order of work

Five tasks, in dependency order:

1. **`stretchParams(amount)`** — the shared amount-to-grain-settings mapping. Done.
2. **The soundscape ambient bed's own warp** — `ensureVoice`, `soundOf`/`soundOfZone`,
   `renderSoundscapePanel`. Done (including a final-review fix wave: `overlap`'s wrong
   units, corrected to a fraction of the grain period; the soundscape panel's missed
   default for a fresh point; disposal ordering; per-tick reassignment churn; the
   empty-state flag).
3. **`applyStretch`, extracted and used by `ensureVoice`** — written once
   `2026-09-13-rhythm-hit-fx.md` (the sibling plan this one's per-hit-slot task depends
   on) had merged, since it's shared infrastructure the next two tasks both need. Also
   closes the final review's parked "extract a shared apply helper" observation.
4. **Data model and UI for the per-hit-slot stretch** — mirrors `rhythm-hit-fx`'s own
   Task 1 shape (data/UI only, no audio node yet).
5. **Wire the per-hit-slot warp engine into the audio graph** — mirrors `rhythm-hit-fx`'s
   own Task 2 shape, built on Task 3's shared infrastructure. Unlike the soundscape bed
   (Task 2, which independently decodes the recording twice — a known, parked cost, see
   that task's final review), this task decodes each slot's recording once and builds
   both the dry player and its warp engine from the same buffer, closing the same finding
   for new code rather than carrying the old pattern forward into a second call site.

---

### Task 1: `stretchParams(amount)`

**Files:**
- Modify: `index.html` — add the function near `soundOfZone` (find `function soundOfZone(z)`
  and its closing brace, currently around `index.html:7026`-`7029`)
- Test: `tests/rhythm-stretch.test.mjs` (new file)

**Interfaces:**
- Produces: `stretchParams(amount)` — pure function, `amount` a number (any real value; the
  function clamps internally), returns `{ playbackRate: number, grainSize: number, overlap:
  number }`. `amount <= 0` returns the same fixed neutral triple every time; `amount >= 1`
  returns the same fixed extreme triple every time; between, all three values move smoothly
  and monotonically. This is the interface Task 2 (and the future Task 3) both consume.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test`
Expected: FAIL — `stretchParams` does not exist yet.

- [ ] **Step 3: Add `stretchParams`**

`index.html` currently, right after `soundOfZone`'s closing brace (find `function
soundOfZone(z)` — currently `index.html:7026`-`7029` — and the blank line after it, before the
`euclid`/`rotated` pure-function cluster):

```js
  /* The zone list carries a copy so the audio path never looks a feature up per frame. */
  function soundOfZone(z) {
    var f = feature(z.id);
    return f ? soundOf(f) : { radius: 140, gain: 0.9, zoneR: 25, stretch: 0 };
  }
```

(Note: this step also updates `soundOfZone`'s fallback object — see Task 2 Step 3 below, which
lands together with this one since they're in the same function.)

Add directly after it:

```js
  /* One shared engine for both a per-hit stretch and the soundscape bed's own extreme warp
     (see the design spec's 2026-09-13 addendum for why this is Tone.GrainPlayer rather than
     the existing fireGrains/variedGrains machinery). amount=0 is the neutral triple a caller
     never actually hears, since both call sites blend this branch out entirely at 0 (A-8) —
     it stays a valid, playable setting anyway so nothing downstream has to special-case it. */
  function stretchParams(amount) {
    var a = amount < 0 ? 0 : (amount > 1 ? 1 : amount);
    return {
      playbackRate: 1 - a * 0.85,
      grainSize: 0.06 + a * 0.24,
      overlap: 0.5 + a * 0.45
    };
  }
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: the three new tests pass. Full suite still 165/165 (this step adds no other change
yet — Task 2 lands the `soundOfZone` fallback edit already shown above together with its own
tests).

- [ ] **Step 5: Commit**

```bash
git add index.html tests/rhythm-stretch.test.mjs
git commit -m "Add the shared stretch engine's amount-to-grain-settings mapping"
```

---

### Task 2: The soundscape ambient bed's own warp

**Files:**
- Modify: `index.html` — `soundOf()` (currently `index.html:7014`-`7023`), `soundOfZone()`
  (currently `index.html:7026`-`7029`, edited together with Task 1 Step 3 above),
  `buildSoundRow()` (currently `index.html:5013`-`5036`), `ensureVoice()` (currently
  `index.html:6947`-`6993`), the voice-disposal block (currently `index.html:5671`), and
  `renderRhythmPanel()`'s mode branches (currently `index.html:4739`-`4742`)
- Test: `tests/rhythm-stretch.test.mjs` (appended)

**Interfaces:**
- Consumes: `stretchParams(amount)` (Task 1), `makeBlend(Tone, fade)` (existing), `BED.fade`
  (existing), `buildSoundRow(fl, q, commitQ)` (existing, extended not replaced).
- Produces: `f.properties.sound.stretch` (0-1, default 0, backfilled by `soundOf()`).
  `bed.voices[id].grainPlayer` and `.stretchBlend` — a live voice's warp engine, present
  whenever that voice is ready. `renderSoundscapePanel(f, q, commitQ, body)` — the new panel
  section for soundscape-mode points, mirroring `renderGrainPanel`'s empty-state shape.

- [ ] **Step 1: Write the failing tests**

```js
// tests/rhythm-stretch.test.mjs — appended

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
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test`
Expected: FAIL — none of `soundOf`'s/`soundOfZone`'s stretch field, `buildSoundRow`'s data-driven
default, `renderSoundscapePanel`, or `ensureVoice`'s GrainPlayer exist yet.

- [ ] **Step 3: Backfill `stretch` in `soundOf`/`soundOfZone`**

`index.html:7014`-`7029` currently:

```js
  function soundOf(f) {
    var q = f.properties.sound;
    if (!q) {
      q = f.properties.sound = { radius: 140, gain: 0.9, zoneR: 25 };
    }
    if (q.radius === undefined) { q.radius = 140; }
    if (q.gain === undefined) { q.gain = 0.9; }
    if (q.zoneR === undefined) { q.zoneR = 25; }
    return q;
  }

  /* The zone list carries a copy so the audio path never looks a feature up per frame. */
  function soundOfZone(z) {
    var f = feature(z.id);
    return f ? soundOf(f) : { radius: 140, gain: 0.9, zoneR: 25 };
  }
```

Change to:

```js
  function soundOf(f) {
    var q = f.properties.sound;
    if (!q) {
      q = f.properties.sound = { radius: 140, gain: 0.9, zoneR: 25, stretch: 0 };
    }
    if (q.radius === undefined) { q.radius = 140; }
    if (q.gain === undefined) { q.gain = 0.9; }
    if (q.zoneR === undefined) { q.zoneR = 25; }
    if (q.stretch === undefined) { q.stretch = 0; }
    return q;
  }

  /* The zone list carries a copy so the audio path never looks a feature up per frame. */
  function soundOfZone(z) {
    var f = feature(z.id);
    return f ? soundOf(f) : { radius: 140, gain: 0.9, zoneR: 25, stretch: 0 };
  }
```

- [ ] **Step 4: Make `buildSoundRow`'s reset default data-driven**

`index.html:5013`-`5036` currently includes:

```js
    input.dataset.def = fl.k === "radius" ? 140 : (fl.k === "gain" ? 0.9 : 25);
```

Change to (matching the existing `fl.def === undefined ? ... : fl.def` idiom already used for
the Patch panel's own rows, elsewhere in this file):

```js
    input.dataset.def = fl.def === undefined
      ? (fl.k === "radius" ? 140 : (fl.k === "gain" ? 0.9 : 25))
      : fl.def;
```

This is additive — `SOUND_FIELDS`' three existing entries (`radius`/`gain`/`zoneR`) have no
`def` field, so they keep resolving through the old ternary exactly as before. Only a new
field that sets `def` explicitly (the stretch row, added in Step 6) gets its own reset value.

- [ ] **Step 5: Wire `ensureVoice` to build and blend a `Tone.GrainPlayer`**

`index.html:6947`-`6993` currently:

```js
  function ensureVoice(z, d) {
    var Tone = bed.Tone, q = soundOfZone(z);
    var prox = Math.max(0, 1 - d / q.radius);
    var g = Math.pow(prox, 1.5) * q.gain;

    var v = bed.voices[z.id];
    if (v) {
      if (v.ready) {
        /* A-2: every gain change ramps. A direct assignment on a live parameter zips. */
        v.gain.gain.rampTo(g, BED.fade);
        v.filter.frequency.rampTo(v.cutoffLo + (v.cutoffHi - v.cutoffLo) * prox, BED.fade);
      }
      v.idle = false;
      return;
    }

    v = bed.voices[z.id] = { ready: false, idle: false };
    audioBlob(z.id, remotePath(z.id)).then(function (blob) {
      if (!blob || !bed || !bed.on || !bed.voices[z.id]) { return; }
      var f = feature(z.id), a = (f && f.properties.audio) || {};
      v.url = URL.createObjectURL(blob);
      v.gain = new Tone.Gain(0).connect(bed.master);
      v.filter = new Tone.Filter(400, "lowpass").connect(v.gain);
      /* Its own brightness sets how far the filter can open; proximity decides how far it
         actually does. A dull recording stays dull however close you stand. */
      v.cutoffHi = Math.max(600, Math.min(14000, (a.centroid_hz || 2000) * 2.2));
      v.cutoffLo = 300;
      v.player = new Tone.Player({
        url: v.url, loop: true, fadeIn: 0.05, fadeOut: 0.1,
        onload: function () {
          /* bed.on as well as the registry: a recording that finished decoding after the
             Sound button was pressed would otherwise start into a stopped bed. */
          if (!bed || !bed.on || !bed.voices[z.id]) {
            try { v.player.dispose(); } catch (e) {}
            return;
          }
          v.ready = true;
          v.player.start();
          var dd = segment(pacer ? pacer.pos : z.lonlat, z.lonlat);
          var q2 = soundOfZone(z);
          var pr = Math.max(0, 1 - dd / q2.radius);
          v.gain.gain.rampTo(Math.pow(pr, 1.5) * q2.gain, BED.fade);
          v.filter.frequency.rampTo(v.cutoffLo + (v.cutoffHi - v.cutoffLo) * pr, BED.fade);
        }
      }).connect(v.filter);
    }).catch(function () { delete bed.voices[z.id]; });
  }
```

Change to:

```js
  function ensureVoice(z, d) {
    var Tone = bed.Tone, q = soundOfZone(z);
    var prox = Math.max(0, 1 - d / q.radius);
    var g = Math.pow(prox, 1.5) * q.gain;

    var v = bed.voices[z.id];
    if (v) {
      if (v.ready) {
        /* A-2: every gain change ramps. A direct assignment on a live parameter zips. */
        v.gain.gain.rampTo(g, BED.fade);
        v.filter.frequency.rampTo(v.cutoffLo + (v.cutoffHi - v.cutoffLo) * prox, BED.fade);
        /* playbackRate/grainSize/overlap are plain properties on this Tone.js build's
           GrainPlayer, not AudioParams — there is no live audio-rate signal to ramp, only
           how future grains are scheduled, so a direct assignment is correct here (A-2
           governs gain changes, not grain-scheduling parameters). Only the dry/wet blend
           between the two players is a gain and gets ramped. */
        var sp = stretchParams(q.stretch);
        v.grainPlayer.playbackRate = sp.playbackRate;
        v.grainPlayer.grainSize = sp.grainSize;
        v.grainPlayer.overlap = sp.overlap;
        v.stretchBlend.fade.rampTo(q.stretch, BED.fade);
      }
      v.idle = false;
      return;
    }

    v = bed.voices[z.id] = { ready: false, idle: false };
    audioBlob(z.id, remotePath(z.id)).then(function (blob) {
      if (!blob || !bed || !bed.on || !bed.voices[z.id]) { return; }
      var f = feature(z.id), a = (f && f.properties.audio) || {};
      v.url = URL.createObjectURL(blob);
      v.gain = new Tone.Gain(0).connect(bed.master);
      v.filter = new Tone.Filter(400, "lowpass").connect(v.gain);
      /* Its own brightness sets how far the filter can open; proximity decides how far it
         actually does. A dull recording stays dull however close you stand. */
      v.cutoffHi = Math.max(600, Math.min(14000, (a.centroid_hz || 2000) * 2.2));
      v.cutoffLo = 300;
      /* The dry player and the warp engine read the same file and blend via makeBlend()
         (A-17) rather than Tone.CrossFade — at stretch=0 the blend routes 100% dry, so an
         existing point sounds exactly as it did before this plan (A-8). They are not
         phase-locked to each other, which is fine: this is a blend of two independently
         playing copies of the same material, the same way a dry/effected blend anywhere
         else in this file works, not a stereo pair that needs sample alignment. */
      v.stretchBlend = makeBlend(Tone, 0);
      v.player = new Tone.Player({
        url: v.url, loop: true, fadeIn: 0.05, fadeOut: 0.1,
        onload: function () {
          /* bed.on as well as the registry: a recording that finished decoding after the
             Sound button was pressed would otherwise start into a stopped bed. */
          if (!bed || !bed.on || !bed.voices[z.id]) {
            try { v.player.dispose(); } catch (e) {}
            return;
          }
          v.ready = true;
          v.player.start();
          var dd = segment(pacer ? pacer.pos : z.lonlat, z.lonlat);
          var q2 = soundOfZone(z);
          var pr = Math.max(0, 1 - dd / q2.radius);
          v.gain.gain.rampTo(Math.pow(pr, 1.5) * q2.gain, BED.fade);
          v.filter.frequency.rampTo(v.cutoffLo + (v.cutoffHi - v.cutoffLo) * pr, BED.fade);
          v.stretchBlend.fade.rampTo(q2.stretch, BED.fade);
        }
      }).connect(v.stretchBlend.a);
      var sp = stretchParams(q.stretch);
      v.grainPlayer = new Tone.GrainPlayer({
        url: v.url, loop: true, playbackRate: sp.playbackRate, grainSize: sp.grainSize,
        overlap: sp.overlap,
        onload: function () {
          if (!bed || !bed.on || !bed.voices[z.id]) {
            try { v.grainPlayer.dispose(); } catch (e) {}
            return;
          }
          v.grainPlayer.start();
        }
      }).connect(v.stretchBlend.b);
      v.stretchBlend.connect(v.filter);
    }).catch(function () { delete bed.voices[z.id]; });
  }
```

- [ ] **Step 6: Dispose the warp engine alongside the rest of the voice**

`index.html:5671` currently:

```js
        try { v.player.stop(); v.player.dispose(); v.filter.dispose(); v.gain.dispose(); } catch (e) {}
```

Change to:

```js
        try {
          v.player.stop(); v.player.dispose();
          if (v.grainPlayer) { v.grainPlayer.stop(); v.grainPlayer.dispose(); }
          if (v.stretchBlend) { v.stretchBlend.dispose(); }
          v.filter.dispose(); v.gain.dispose();
        } catch (e) {}
```

- [ ] **Step 7: Add the soundscape panel**

`index.html:4736`-`4742` currently:

```js
    /* C-5: the empty state, which is where a panel usually gives itself away. A sequencer
       with nothing to sequence should say so and say where to go, not offer four rows of
       controls that do nothing when you move them. */
    if (f.properties.audio_mode === "grains") { renderGrainPanel(f, r, body); return; }
    var hitsOn = f.properties.hits || {};
    var filled = HIT_SLOTS.filter(function (k) { return hitsOn[k]; });
    if (f.properties.audio_mode !== "hits") { return; }
```

Change to add a soundscape branch ahead of the grains one (order between them doesn't matter —
`audio_mode` is one value, so exactly one of these ever fires):

```js
    /* C-5: the empty state, which is where a panel usually gives itself away. A sequencer
       with nothing to sequence should say so and say where to go, not offer four rows of
       controls that do nothing when you move them. */
    if (f.properties.audio_mode === "soundscape") {
      renderSoundscapePanel(f, q, commitQ, body);
      return;
    }
    if (f.properties.audio_mode === "grains") { renderGrainPanel(f, r, body); return; }
    var hitsOn = f.properties.hits || {};
    var filled = HIT_SLOTS.filter(function (k) { return hitsOn[k]; });
    if (f.properties.audio_mode !== "hits") { return; }
```

Add `renderSoundscapePanel` directly after `renderRhythmPanel`'s own closing brace (find
`function renderRhythmPanel() {` and its matching `}`; place it wherever `renderGrainPanel`
already sits relative to `renderRhythmPanel`, i.e. as its own top-level function nearby):

```js
  /* The soundscape panel: today just the warp knob. C-5's empty state applies the same way
     the grains panel already handles no attached recording — a warp control is meaningless
     with nothing to warp. */
  function renderSoundscapePanel(f, q, commitQ, body) {
    if (!f.properties.audio) {
      var none = document.createElement("div");
      none.className = "rpempty";
      var et = document.createElement("p");
      et.className = "rpempty-t";
      et.textContent = "No recording attached yet.";
      var ed = document.createElement("p");
      ed.className = "hint";
      ed.textContent = "This point is set to soundscape. Attach a recording on its card, and " +
        "it plays as the ambient bed heard while walking near it.";
      none.appendChild(et); none.appendChild(ed);
      body.appendChild(none);
      return;
    }
    var mhead = document.createElement("div");
    mhead.className = "pphead";
    var h = document.createElement("h2");
    h.textContent = "The ambient bed";
    mhead.appendChild(h);
    body.appendChild(mhead);
    var cols = document.createElement("div");
    cols.className = "ppcols";
    var col = document.createElement("div");
    col.className = "ppcol";
    col.appendChild(buildSoundRow({ k: "stretch", label: "stretch", min: 0, max: 1, step: 0.02,
      def: 0, hint: "extreme time-stretch, from the recording as it is to a slow granular smear" },
      q, commitQ));
    cols.appendChild(col);
    var col2 = document.createElement("div");
    col2.className = "ppcol";
    var note = document.createElement("p");
    note.className = "hint";
    note.textContent = "At 0 the bed plays the recording as it is. Further up, it slows and " +
      "smears into a granular wash — the same engine a hit's own stretch uses, applied " +
      "to the whole recording instead of one hit.";
    col2.appendChild(note);
    cols.appendChild(col2);
    body.appendChild(cols);
  }
```

(`commitQ` is already in scope at the soundscape branch's call site — it's the same closure
defined earlier in `renderRhythmPanel` at the top of the "This point" section, the one
`SOUND_FIELDS.forEach` already uses. Passing it through means the stretch slider gets exactly
the same live-update behaviour — `claimEdit(f); save(); updateBed(); redrawZones();` — that
radius/gain/zoneR already have, so a change is heard on the very next position tick via
`ensureVoice`'s ready-branch re-apply from Step 5.)

- [ ] **Step 8: Run the tests**

Run: `npm test && npm run check`
Expected: all pass, including every pre-existing test.

- [ ] **Step 9: Verify in a browser**

Serve locally, sign in as a setter, select a soundscape-mode point with a recording attached.
Confirm a new "The ambient bed" section appears with a "stretch" slider, starting at 0. Walk a
route so the bed becomes audible; with stretch at 0, confirm it sounds exactly as it did before
this plan. Raise stretch while walking near it: confirm the bed slows and smears into a
granular texture, continuously (no audible seam), and returns to the plain recording when
brought back to 0 with no click. Switch to a hits- or grains-mode point and confirm no
soundscape section appears there. Select a soundscape-mode point with nothing attached yet and
confirm the empty state appears instead of a slider.

- [ ] **Step 10: Commit**

```bash
git add index.html tests/rhythm-stretch.test.mjs
git commit -m "Give the soundscape ambient bed its own Paulstretch-style warp"
```

---

### Task 3: `applyStretch`, a shared apply-on-change helper — and use it in `ensureVoice`

`2026-09-13-rhythm-hit-fx.md` has merged (as has this plan's own Tasks 1-2). Written now
that `ensureRhythm()`/`disposeRhythm()`/`rhythmStep()` have their final merged shape.

The final whole-branch review of Tasks 1-2 (see this plan's own ledger,
`.superpowers/sdd/2026-09-13-rhythm-stretch-engine/progress.md`) parked one finding for
"whichever plan builds the per-hit-slot stretch": `ensureVoice`'s ready-branch and its
construction path each independently do the same "compute `stretchParams`, write three
properties, track what was applied" dance. The per-hit-slot stretch needs the identical
dance in a third place (`applyHitStretch`, Task 5). Extracting it once now — and having
`ensureVoice` itself use it — means the per-hit-slot code in Task 5 is the second caller of
tested infrastructure, not a third hand-rolled copy.

**Files:**
- Modify: `index.html` (add `applyStretch` directly after `stretchParams`, currently ending
  around `index.html:7141`; simplify `ensureVoice`'s ready-branch and `onload` construction,
  currently around `index.html:7004`-`7087`)
- Test: `tests/rhythm-stretch.test.mjs` (appended)

**Interfaces:**
- Produces: `applyStretch(node, amount)` — given any object with `playbackRate`/
  `grainSize`/`overlap` properties (a `Tone.GrainPlayer`, in practice) and a 0-1 amount,
  applies `stretchParams(amount)` to it and records what it applied on the node itself
  (`node.__stretchAmt`), skipping the write entirely when `amount` hasn't changed since the
  last call on that same node. Safe to call with a falsy `node`. This is the interface
  Task 5 consumes.

- [ ] **Step 1: Write the failing test**

```js
// tests/rhythm-stretch.test.mjs — appended

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
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test`
Expected: FAIL — `applyStretch` does not exist yet; `ensureVoice` still does its own inline
reassignment and still sets `v.stretchAmt`.

- [ ] **Step 3: Add `applyStretch`**

`index.html` currently, right after `stretchParams`'s closing brace (currently
`index.html:7131`-`7141`):

```js
  function stretchParams(amount) {
    var a = amount < 0 ? 0 : (amount > 1 ? 1 : amount);
    var playbackRate = 1 - a * 0.85;
    var grainSize = 0.06 + a * 0.24;
    var period = grainSize / playbackRate;
    return {
      playbackRate: playbackRate,
      grainSize: grainSize,
      overlap: period * (0.35 + a * 0.4)
    };
  }
```

Add directly after it:

```js
  /* Applies a stretch amount to a live GrainPlayer, skipping the write when nothing
     changed since the last call on this same node — every caller that owns a GrainPlayer
     (the soundscape bed's own warp, and each hit slot's) shares this rather than
     repeating the three-property dance and its own unchanged-guard. */
  function applyStretch(node, amount) {
    if (!node || node.__stretchAmt === amount) { return; }
    var sp = stretchParams(amount);
    node.playbackRate = sp.playbackRate;
    node.grainSize = sp.grainSize;
    node.overlap = sp.overlap;
    node.__stretchAmt = amount;
  }
```

- [ ] **Step 4: Simplify `ensureVoice` to use it**

`index.html:7004`-`7087` currently:

```js
  function ensureVoice(z, d) {
    var Tone = bed.Tone, q = soundOfZone(z);
    var prox = Math.max(0, 1 - d / q.radius);
    var g = Math.pow(prox, 1.5) * q.gain;

    var v = bed.voices[z.id];
    if (v) {
      if (v.ready) {
        /* A-2: every gain change ramps. A direct assignment on a live parameter zips. */
        v.gain.gain.rampTo(g, BED.fade);
        v.filter.frequency.rampTo(v.cutoffLo + (v.cutoffHi - v.cutoffLo) * prox, BED.fade);
        /* playbackRate/grainSize/overlap are plain properties on this Tone.js build's
           GrainPlayer, not AudioParams — there is no live audio-rate signal to ramp, only
           how future grains are scheduled, so a direct assignment is correct here (A-2
           governs gain changes, not grain-scheduling parameters). Only the dry/wet blend
           between the two players is a gain and gets ramped. Guarded on an actual change
           so a long walk doesn't keep re-appending to the grain clock's own automation
           timeline every position tick with the same value. */
        if (v.stretchAmt !== q.stretch) {
          var sp = stretchParams(q.stretch);
          v.grainPlayer.playbackRate = sp.playbackRate;
          v.grainPlayer.grainSize = sp.grainSize;
          v.grainPlayer.overlap = sp.overlap;
          v.stretchAmt = q.stretch;
        }
        v.stretchBlend.fade.rampTo(q.stretch, BED.fade);
      }
      v.idle = false;
      return;
    }

    v = bed.voices[z.id] = { ready: false, idle: false };
    audioBlob(z.id, remotePath(z.id)).then(function (blob) {
      if (!blob || !bed || !bed.on || !bed.voices[z.id]) { return; }
      var f = feature(z.id), a = (f && f.properties.audio) || {};
      v.url = URL.createObjectURL(blob);
      v.gain = new Tone.Gain(0).connect(bed.master);
      v.filter = new Tone.Filter(400, "lowpass").connect(v.gain);
      /* Its own brightness sets how far the filter can open; proximity decides how far it
         actually does. A dull recording stays dull however close you stand. */
      v.cutoffHi = Math.max(600, Math.min(14000, (a.centroid_hz || 2000) * 2.2));
      v.cutoffLo = 300;
      /* The dry player and the warp engine read the same file and blend via makeBlend()
         (A-17) rather than Tone.CrossFade — at stretch=0 the blend routes 100% dry, so an
         existing point sounds exactly as it did before this plan (A-8). They are not
         phase-locked to each other, which is fine: this is a blend of two independently
         playing copies of the same material, the same way a dry/effected blend anywhere
         else in this file works, not a stereo pair that needs sample alignment. */
      v.stretchBlend = makeBlend(Tone, 0);
      v.player = new Tone.Player({
        url: v.url, loop: true, fadeIn: 0.05, fadeOut: 0.1,
        onload: function () {
          /* bed.on as well as the registry: a recording that finished decoding after the
             Sound button was pressed would otherwise start into a stopped bed. */
          if (!bed || !bed.on || !bed.voices[z.id]) {
            try { v.player.dispose(); } catch (e) {}
            return;
          }
          v.ready = true;
          v.stretchAmt = q.stretch;
          v.player.start();
          var dd = segment(pacer ? pacer.pos : z.lonlat, z.lonlat);
          var q2 = soundOfZone(z);
          var pr = Math.max(0, 1 - dd / q2.radius);
          v.gain.gain.rampTo(Math.pow(pr, 1.5) * q2.gain, BED.fade);
          v.filter.frequency.rampTo(v.cutoffLo + (v.cutoffHi - v.cutoffLo) * pr, BED.fade);
          v.stretchBlend.fade.rampTo(q2.stretch, BED.fade);
        }
      }).connect(v.stretchBlend.a);
      var sp = stretchParams(q.stretch);
      v.grainPlayer = new Tone.GrainPlayer({
        url: v.url, loop: true, playbackRate: sp.playbackRate, grainSize: sp.grainSize,
        overlap: sp.overlap,
        onload: function () {
          if (!bed || !bed.on || !bed.voices[z.id]) {
            try { v.grainPlayer.dispose(); } catch (e) {}
            return;
          }
          v.grainPlayer.start();
        }
      }).connect(v.stretchBlend.b);
      v.stretchBlend.connect(v.filter);
    }).catch(function () { delete bed.voices[z.id]; });
  }
```

Change to (the ready branch's three-property block and `v.stretchAmt` bookkeeping collapse
to one call; the construction path's `sp`/inline-options collapse the same way):

```js
  function ensureVoice(z, d) {
    var Tone = bed.Tone, q = soundOfZone(z);
    var prox = Math.max(0, 1 - d / q.radius);
    var g = Math.pow(prox, 1.5) * q.gain;

    var v = bed.voices[z.id];
    if (v) {
      if (v.ready) {
        /* A-2: every gain change ramps. A direct assignment on a live parameter zips. */
        v.gain.gain.rampTo(g, BED.fade);
        v.filter.frequency.rampTo(v.cutoffLo + (v.cutoffHi - v.cutoffLo) * prox, BED.fade);
        applyStretch(v.grainPlayer, q.stretch);
        v.stretchBlend.fade.rampTo(q.stretch, BED.fade);
      }
      v.idle = false;
      return;
    }

    v = bed.voices[z.id] = { ready: false, idle: false };
    audioBlob(z.id, remotePath(z.id)).then(function (blob) {
      if (!blob || !bed || !bed.on || !bed.voices[z.id]) { return; }
      var f = feature(z.id), a = (f && f.properties.audio) || {};
      v.url = URL.createObjectURL(blob);
      v.gain = new Tone.Gain(0).connect(bed.master);
      v.filter = new Tone.Filter(400, "lowpass").connect(v.gain);
      /* Its own brightness sets how far the filter can open; proximity decides how far it
         actually does. A dull recording stays dull however close you stand. */
      v.cutoffHi = Math.max(600, Math.min(14000, (a.centroid_hz || 2000) * 2.2));
      v.cutoffLo = 300;
      /* The dry player and the warp engine read the same file and blend via makeBlend()
         (A-17) rather than Tone.CrossFade — at stretch=0 the blend routes 100% dry, so an
         existing point sounds exactly as it did before this plan (A-8). They are not
         phase-locked to each other, which is fine: this is a blend of two independently
         playing copies of the same material, the same way a dry/effected blend anywhere
         else in this file works, not a stereo pair that needs sample alignment. */
      v.stretchBlend = makeBlend(Tone, 0);
      v.player = new Tone.Player({
        url: v.url, loop: true, fadeIn: 0.05, fadeOut: 0.1,
        onload: function () {
          /* bed.on as well as the registry: a recording that finished decoding after the
             Sound button was pressed would otherwise start into a stopped bed. */
          if (!bed || !bed.on || !bed.voices[z.id]) {
            try { v.player.dispose(); } catch (e) {}
            return;
          }
          v.ready = true;
          v.player.start();
          var dd = segment(pacer ? pacer.pos : z.lonlat, z.lonlat);
          var q2 = soundOfZone(z);
          var pr = Math.max(0, 1 - dd / q2.radius);
          v.gain.gain.rampTo(Math.pow(pr, 1.5) * q2.gain, BED.fade);
          v.filter.frequency.rampTo(v.cutoffLo + (v.cutoffHi - v.cutoffLo) * pr, BED.fade);
          v.stretchBlend.fade.rampTo(q2.stretch, BED.fade);
        }
      }).connect(v.stretchBlend.a);
      v.grainPlayer = new Tone.GrainPlayer({ url: v.url, loop: true })
        .connect(v.stretchBlend.b);
      applyStretch(v.grainPlayer, q.stretch);
      v.stretchBlend.connect(v.filter);
    }).catch(function () { delete bed.voices[z.id]; });
  }
```

- [ ] **Step 5: Run the tests**

Run: `npm test && npm run check`
Expected: all pass, including every pre-existing test — this is a pure refactor, so no
existing test's expectations about `ensureVoice`'s audible behaviour should have needed to
change (only the two tests that pinned the OLD inline-reassignment source text, if any
exist — check `tests/rhythm-stretch.test.mjs` for a test asserting the literal
`v.stretchAmt !== q.stretch` or `v.grainPlayer.playbackRate =` and update it to assert the
new `applyStretch(...)` call shape instead, the same way `rhythm-hit-fx`'s own fix wave
updated tests that pinned literals its fixes changed).

- [ ] **Step 6: Verify in a browser**

Serve locally, sign in as a setter, walk a route with a soundscape-mode point that has
stretch turned up. Confirm the bed still smears exactly as it did before this task (this
task changes no behaviour, only where the logic that produces it lives).

- [ ] **Step 7: Commit**

```bash
git add index.html tests/rhythm-stretch.test.mjs
git commit -m "Extract applyStretch so the soundscape warp and the next per-slot one share it"
```

---

### Task 4: Data model, defaults, backfill, and the per-voice stretch slider

**Files:**
- Modify: `index.html` (`defaultRhythm()` currently `index.html:7176`-`7199`, `rhythmOf()`
  currently `index.html:7226`-`7272`, `randomHitFx(r)` currently `index.html:5022`-`5031`,
  the per-voice row builder inside `renderRhythmPanel()` currently around
  `index.html:4858`-`4897`)
- Test: `tests/rhythm-stretch.test.mjs` (appended)

**Interfaces:**
- Produces: a sixth field per voice in `defaultRhythm()`'s `voices` object — `stretch: 0`.
  `rhythmOf()` backfills it, field-by-field, for a point saved before this task. `randomHitFx`
  now also rolls `stretch` (the design spec's own "UI" section named it among the fields
  `randomHitFx` should roll, alongside crush/drive/delay, before this field existed to
  implement). A `stretch` slider joins the per-voice row.

This task adds no audio node and no scheduling change — data and UI only, the same shape
`rhythm-hit-fx`'s own Task 1 took for crush/drive/delay: the slider exists and persists a
value after this task; Task 5 makes it audible.

- [ ] **Step 1: Write the failing test**

```js
// tests/rhythm-stretch.test.mjs — appended

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
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test`
Expected: FAIL — `stretch` isn't in `defaultRhythm()`'s voices yet, `rhythmOf()` doesn't
backfill it, `randomHitFx` doesn't roll it, no slider exists.

- [ ] **Step 3: Add `stretch` to `defaultRhythm()`**

`index.html:7176`-`7199` currently:

```js
  function defaultRhythm() {
    return {
      on: true, steps: 64, div: "16n", gain: 0.85, swing: 0, idiom: 0.35, sentenceBars: 8,
      /* Sixty-four sixteenths is four bars, which is long enough for four lines to drift
         against each other instead of repeating every bar. The pulse counts are all
         different and three of the four are coprime with 64, so the pattern they make
         together only comes back around after a very long time: 8 divides 64 and gives the
         low its steady half-bar, while 13, 21 and 5 never line up with it twice the same
         way. */
      /* crush/drive/delay* all default to their off position — a point saved before this
         plan existed must sound identical to today until a setter (or Randomize effects)
         touches one. */
      voices: {
        low:  { pulses:  8, rotate: 0,  gain: 1.00, pitch: 0,
                crush: 0, drive: 0, delayDiv: "8n", delayFb: 0, delayWet: 0 },
        mid:  { pulses: 13, rotate: 2,  gain: 0.80, pitch: 0,
                crush: 0, drive: 0, delayDiv: "8n", delayFb: 0, delayWet: 0 },
        high: { pulses: 21, rotate: 1,  gain: 0.65, pitch: 0,
                crush: 0, drive: 0, delayDiv: "8n", delayFb: 0, delayWet: 0 },
        rand: { pulses:  5, rotate: 11, gain: 0.55, pitch: 0,
                crush: 0, drive: 0, delayDiv: "8n", delayFb: 0, delayWet: 0 }
      }
    };
  }
```

Change the `voices` object to add `stretch: 0` to each slot:

```js
      voices: {
        low:  { pulses:  8, rotate: 0,  gain: 1.00, pitch: 0,
                crush: 0, drive: 0, delayDiv: "8n", delayFb: 0, delayWet: 0, stretch: 0 },
        mid:  { pulses: 13, rotate: 2,  gain: 0.80, pitch: 0,
                crush: 0, drive: 0, delayDiv: "8n", delayFb: 0, delayWet: 0, stretch: 0 },
        high: { pulses: 21, rotate: 1,  gain: 0.65, pitch: 0,
                crush: 0, drive: 0, delayDiv: "8n", delayFb: 0, delayWet: 0, stretch: 0 },
        rand: { pulses:  5, rotate: 11, gain: 0.55, pitch: 0,
                crush: 0, drive: 0, delayDiv: "8n", delayFb: 0, delayWet: 0, stretch: 0 }
      }
```

- [ ] **Step 4: Backfill `stretch` in `rhythmOf()`**

`index.html:7241`-`7249` currently:

```js
    var dv = defaultRhythm().voices;
    HIT_SLOTS.forEach(function (k) {
      var v = r.voices[k];
      if (v.crush === undefined) { v.crush = dv[k].crush; }
      if (v.drive === undefined) { v.drive = dv[k].drive; }
      if (v.delayDiv === undefined) { v.delayDiv = dv[k].delayDiv; }
      if (v.delayFb === undefined) { v.delayFb = dv[k].delayFb; }
      if (v.delayWet === undefined) { v.delayWet = dv[k].delayWet; }
    });
```

Change to:

```js
    var dv = defaultRhythm().voices;
    HIT_SLOTS.forEach(function (k) {
      var v = r.voices[k];
      if (v.crush === undefined) { v.crush = dv[k].crush; }
      if (v.drive === undefined) { v.drive = dv[k].drive; }
      if (v.delayDiv === undefined) { v.delayDiv = dv[k].delayDiv; }
      if (v.delayFb === undefined) { v.delayFb = dv[k].delayFb; }
      if (v.delayWet === undefined) { v.delayWet = dv[k].delayWet; }
      if (v.stretch === undefined) { v.stretch = dv[k].stretch; }
    });
```

- [ ] **Step 5: Roll `stretch` in `randomHitFx`**

`index.html:5022`-`5031` currently:

```js
  function randomHitFx(r) {
    HIT_SLOTS.forEach(function (slot) {
      var cfg = r.voices[slot];
      cfg.crush = Math.random() < 0.65 ? Math.random() * 0.2 : 0.2 + Math.random() * 0.5;
      cfg.drive = Math.random() < 0.65 ? Math.random() * 0.25 : 0.25 + Math.random() * 0.45;
      cfg.delayDiv = DIVISIONS[Math.floor(Math.random() * DIVISIONS.length)];
      cfg.delayFb = Math.random() * 0.4;
      cfg.delayWet = Math.random() < 0.5 ? 0 : Math.random() * 0.35;
    });
  }
```

Change to (weighted toward modest values, same shape as the other fields — matching the
design spec's own "mostly low stretch and crush, occasional higher outliers"):

```js
  function randomHitFx(r) {
    HIT_SLOTS.forEach(function (slot) {
      var cfg = r.voices[slot];
      cfg.crush = Math.random() < 0.65 ? Math.random() * 0.2 : 0.2 + Math.random() * 0.5;
      cfg.drive = Math.random() < 0.65 ? Math.random() * 0.25 : 0.25 + Math.random() * 0.45;
      cfg.delayDiv = DIVISIONS[Math.floor(Math.random() * DIVISIONS.length)];
      cfg.delayFb = Math.random() * 0.4;
      cfg.delayWet = Math.random() < 0.5 ? 0 : Math.random() * 0.35;
      cfg.stretch = Math.random() < 0.7 ? Math.random() * 0.25 : 0.25 + Math.random() * 0.5;
    });
  }
```

- [ ] **Step 6: Add the stretch slider to the per-voice row**

`index.html:4879`-`4897` currently:

```js
      /* A musical division, not a free number — same idiom as RHYTHM_FIELDS' own "div" row
         and the shared room's own delay-division control. */
      var delWrap = document.createElement("label");
      delWrap.className = "pprow";
      var delLab = document.createElement("span");
      delLab.textContent = "delay time";
      var delSel = document.createElement("select");
      DIVISIONS.forEach(function (d) {
        var op = document.createElement("option");
        op.value = d; op.textContent = DIV_LABEL[d] || d;
        delSel.appendChild(op);
      });
      delSel.value = cfg.delayDiv;
      delSel.addEventListener("change", function () {
        cfg.delayDiv = delSel.value; commitR();
        applyHitFx(bed && bed.rhythms[f.properties.id], r);
      });
      delWrap.appendChild(delLab); delWrap.appendChild(delSel);
      row.appendChild(delWrap);
      var pat = document.createElement("div");
```

Insert a stretch slider after the delay-division select, before the pattern strip (the
`applyHitStretch(...)` call this handler needs for live audio feedback is added in Task 5,
once that function exists — do not add a call to a function that does not exist yet in
this task, the same rule `rhythm-hit-fx`'s own Task 1 followed for its four sliders):

```js
      delWrap.appendChild(delLab); delWrap.appendChild(delSel);
      row.appendChild(delWrap);
      var stretchWrap = document.createElement("label");
      stretchWrap.className = "pprow";
      var stretchLab = document.createElement("span");
      stretchLab.textContent = "stretch";
      var stretchInp = document.createElement("input");
      stretchInp.type = "range"; stretchInp.min = 0; stretchInp.max = 1; stretchInp.step = 0.02;
      stretchInp.value = cfg.stretch;
      stretchInp.dataset.def = defaultRhythm().voices[slot].stretch;
      stretchInp.title = "Shift-drag for fine steps · double-click to reset";
      var stretchOut = document.createElement("i");
      var showStretch = function () { stretchOut.textContent = (+stretchInp.value).toFixed(2); };
      showStretch();
      stretchInp.addEventListener("input", function () {
        cfg.stretch = +stretchInp.value; showStretch(); commitR();
      });
      stretchWrap.appendChild(stretchLab); stretchWrap.appendChild(stretchInp);
      stretchWrap.appendChild(stretchOut);
      row.appendChild(stretchWrap);
      var pat = document.createElement("div");
```

- [ ] **Step 7: Run the tests**

Run: `npm test && npm run check`
Expected: all pass.

- [ ] **Step 8: Verify in a browser**

Serve locally, sign in as a setter, select a hits-mode point, open its rhythm panel.
Confirm each voice row now shows a stretch slider, starting at 0 for an existing point.
Click "Randomize effects" a few times: confirm stretch changes too, staying mostly modest
with occasional higher values, and that "Generate a pattern" never touches it.

- [ ] **Step 9: Commit**

```bash
git add index.html tests/rhythm-stretch.test.mjs
git commit -m "Each hit voice gets its own stretch control, off by default"
```

---

### Task 5: Wire the per-slot warp engine into the audio graph

**Files:**
- Modify: `index.html` (`ensureRhythm()`/`disposeRhythm()` currently around
  `index.html:7391`-`7454`, `rhythmStep()` currently around `index.html:7612`-`7685`, the
  new stretch slider's handler from Task 4 Step 6)
- Test: `tests/rhythm-stretch.test.mjs` (appended)

**Interfaces:**
- Consumes: `applyStretch(node, amount)` (Task 3), `makeBlend(Tone, fade)` (existing),
  `buildHitFx(Tone)`/`R.fx[slot].input` (existing, from `rhythm-hit-fx`).
- Produces: `applyHitStretch(R, r)` — ramps every slot's warp blend and reapplies
  `applyStretch` to match `r.voices[slot].stretch`; safe with no live `R`, matching
  `applyHitFx`'s own shape. `R.stretch[slot]` — `{ blend, grainPlayer }`, present once a
  slot's recording has decoded.

- [ ] **Step 1: Write the failing test**

```js
// tests/rhythm-stretch.test.mjs — appended

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
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test`
Expected: FAIL — `applyHitStretch` doesn't exist; `ensureRhythm` still decodes each slot
once for a single dry player only; `rhythmStep` never touches a warp engine.

- [ ] **Step 3: Add `applyHitStretch`**

Add directly after `applyHitFx` (find `function applyHitFx(R, r)` and its closing brace,
currently `index.html:7369`-`7386`):

```js
  /* A stretched hit reads its source more slowly the more extreme the stretch — at
     stretchParams(1)'s playbackRate (0.15), a one-second sample would otherwise take
     roughly 6-7 seconds to traverse before a non-looping GrainPlayer stops on its own,
     during which the pattern has long since retriggered on top of it. The design spec's
     own "stretch engine" section calls this out directly: "a hit that never ends is not
     a hit." This caps how long a single stretched hit is allowed to ring, independent of
     playbackRate. */
  var MAX_STRETCH_HIT_S = 1.5;

  /* Applied once when a point's warp engines are first ready, and again whenever a setter
     moves a slot's stretch slider — the same "one chain, apply on change" shape
     applyHitFx already uses for crush/drive/delay. Safe with no live R: a setter can edit
     a point's stretch while it happens to be out of range. */
  function applyHitStretch(R, r) {
    if (!R || !R.stretch) { return; }
    HIT_SLOTS.forEach(function (slot) {
      var cfg = r.voices[slot], st = R.stretch[slot];
      if (!cfg || !st) { return; }
      applyStretch(st.grainPlayer, cfg.stretch || 0);
      st.blend.fade.rampTo(cfg.stretch || 0, 0.2);
    });
  }
```

- [ ] **Step 4: Wire `ensureRhythm` to decode once and build the blended warp engine**

`index.html:7391`-`7431` currently:

```js
  function ensureRhythm(z) {
    var R = bed.rhythms[z.id];
    if (R) { return R; }
    var Tone = bed.Tone;
    R = bed.rhythms[z.id] = { ready: 0, players: {}, urls: {}, tick: 0, step: 0, recent: [],
                              gain: new Tone.Gain(0).connect(bed.rfx ? bed.rfx.input
                                                                     : bed.master) };
    /* A grains point loads its one recording as a buffer rather than a player: a player
       plays a file, and what this needs is to read arbitrary slices of it at arbitrary
       times, many at once. */
    if (z.mode === "grains") {
      audioBlob(z.id, remotePath(z.id)).then(function (blob) {
        if (!blob || !bed || !bed.rhythms[z.id]) { return; }
        var url = URL.createObjectURL(blob);
        R.grainUrl = url;
        R.buffer = new Tone.ToneAudioBuffer(url, function () { R.ready++; },
          function () { /* a file that will not decode simply never plays */ });
      }).catch(function () { /* nothing attached yet */ });
      return R;
    }
    /* One insert chain per slot, built synchronously so it exists (fully dry, per A-8)
       before any player has even started loading — the async audioBlob() calls below only
       need to connect into it, not build it. */
    R.fx = {};
    HIT_SLOTS.forEach(function (slot) {
      R.fx[slot] = buildHitFx(Tone);
      R.fx[slot].output.connect(R.gain);
    });
    HIT_SLOTS.forEach(function (slot) {
      audioBlob(z.id + "#" + slot, remoteHitPath(z.id, slot)).then(function (blob) {
        if (!blob || !bed || !bed.rhythms[z.id]) { return; }
        var url = URL.createObjectURL(blob);
        R.urls[slot] = url;
        R.players[slot] = new Tone.Player({
          url: url, fadeOut: 0.02,
          onload: function () { R.ready++; }
        }).connect(R.fx[slot].input);
      }).catch(function () { /* a slot that will not load simply never fires */ });
    });
    return R;
  }
```

Change to (`R.buffers`/`R.stretch` added to the initial object; the per-slot loader now
decodes once into `R.buffers[slot]` and, once that decode's own `onload` fires, builds the
dry player and the warp engine from that same already-decoded buffer, blended into the
existing per-slot insert chain instead of connecting the dry player there directly —
measured against the real Tone.js build: passing an already-loaded `ToneAudioBuffer` as a
second player's `url` reuses the decoded audio synchronously rather than fetching and
decoding the file again):

```js
  function ensureRhythm(z) {
    var R = bed.rhythms[z.id];
    if (R) { return R; }
    var Tone = bed.Tone;
    R = bed.rhythms[z.id] = { ready: 0, players: {}, urls: {}, buffers: {}, tick: 0,
                              step: 0, recent: [],
                              gain: new Tone.Gain(0).connect(bed.rfx ? bed.rfx.input
                                                                     : bed.master) };
    /* A grains point loads its one recording as a buffer rather than a player: a player
       plays a file, and what this needs is to read arbitrary slices of it at arbitrary
       times, many at once. */
    if (z.mode === "grains") {
      audioBlob(z.id, remotePath(z.id)).then(function (blob) {
        if (!blob || !bed || !bed.rhythms[z.id]) { return; }
        var url = URL.createObjectURL(blob);
        R.grainUrl = url;
        R.buffer = new Tone.ToneAudioBuffer(url, function () { R.ready++; },
          function () { /* a file that will not decode simply never plays */ });
      }).catch(function () { /* nothing attached yet */ });
      return R;
    }
    /* One insert chain per slot, built synchronously so it exists (fully dry, per A-8)
       before any player has even started loading — the async audioBlob() calls below only
       need to connect into it, not build it. */
    R.fx = {};
    R.stretch = {};
    HIT_SLOTS.forEach(function (slot) {
      R.fx[slot] = buildHitFx(Tone);
      R.fx[slot].output.connect(R.gain);
    });
    HIT_SLOTS.forEach(function (slot) {
      audioBlob(z.id + "#" + slot, remoteHitPath(z.id, slot)).then(function (blob) {
        if (!blob || !bed || !bed.rhythms[z.id]) { return; }
        var url = URL.createObjectURL(blob);
        R.urls[slot] = url;
        /* One decode, two readers: the dry player and this slot's own warp engine both
           read the same already-decoded buffer rather than each fetching and decoding the
           file a second time. */
        R.buffers[slot] = new Tone.ToneAudioBuffer(url, function () {
          if (!bed || !bed.rhythms[z.id]) { return; }
          var blend = makeBlend(Tone, 0);
          R.players[slot] = new Tone.Player({ url: R.buffers[slot], fadeOut: 0.02 })
            .connect(blend.a);
          var gp = new Tone.GrainPlayer({ url: R.buffers[slot], loop: false })
            .connect(blend.b);
          applyStretch(gp, 0);
          blend.connect(R.fx[slot].input);
          R.stretch[slot] = { blend: blend, grainPlayer: gp };
          R.ready++;
        }, function () { /* a slot that will not decode simply never fires */ });
      }).catch(function () { /* a slot that will not load simply never fires */ });
    });
    return R;
  }
```

- [ ] **Step 5: Dispose the buffer and warp engine in `disposeRhythm`**

`index.html:7433`-`7454` currently:

```js
  function disposeRhythm(id) {
    var R = bed.rhythms[id];
    if (!R) { return; }
    delete bed.rhythms[id];
    try { R.gain.gain.rampTo(0, 0.25); } catch (e) { /* ignore */ }
    setTimeout(function () {
      try { if (R.buffer) { R.buffer.dispose(); } } catch (e) {}
      try { if (R.grainUrl) { URL.revokeObjectURL(R.grainUrl); } } catch (e) {}
      HIT_SLOTS.forEach(function (slot) {
        try { if (R.players[slot]) { R.players[slot].dispose(); } } catch (e) {}
        if (R.urls[slot]) { URL.revokeObjectURL(R.urls[slot]); }
        var fx = R.fx && R.fx[slot];
        if (fx) {
          [fx.input, fx.crush, fx.crushBlend, fx.shape, fx.drivePre, fx.drivePost,
           fx.driveBlend, fx.delay, fx.delayBlend].forEach(function (n) {
            try { n.dispose(); } catch (e) {}
          });
        }
      });
      try { R.gain.dispose(); } catch (e) {}
    }, 400);
  }
```

Change the `HIT_SLOTS.forEach` body to also dispose the buffer and warp engine, each in
their own guarded segment so one throwing can't skip the others (matching the fix already
applied to the soundscape bed's own disposal in this plan's final-review fix wave):

```js
      HIT_SLOTS.forEach(function (slot) {
        try { if (R.players[slot]) { R.players[slot].dispose(); } } catch (e) {}
        if (R.urls[slot]) { URL.revokeObjectURL(R.urls[slot]); }
        try { if (R.buffers[slot]) { R.buffers[slot].dispose(); } } catch (e) {}
        var st = R.stretch && R.stretch[slot];
        if (st) {
          try { st.grainPlayer.dispose(); } catch (e) {}
          try { st.blend.dispose(); } catch (e) {}
        }
        var fx = R.fx && R.fx[slot];
        if (fx) {
          [fx.input, fx.crush, fx.crushBlend, fx.shape, fx.drivePre, fx.drivePost,
           fx.driveBlend, fx.delay, fx.delayBlend].forEach(function (n) {
            try { n.dispose(); } catch (e) {}
          });
        }
      });
```

- [ ] **Step 6: Trigger the warp engine alongside the dry hit in `rhythmStep`**

`index.html`'s per-slot trigger loop, inside `rhythmStep(time)`, currently:

```js
      for (var v = 0; v < HIT_SLOTS.length; v++) {
        var slot = HIT_SLOTS[v], cfg = r.voices[slot], live = R.liveVoices[slot];
        var pl = R.players[slot];
        if (!pl || !pl.loaded || !cfg || !live || live.pulses <= 0) { continue; }
        var pat = rotated(euclid(Math.min(live.pulses, steps), steps), live.rotate || 0);
        if (!pat[at]) { continue; }
        /* A-11: never twice identically. A few cents and a few percent, no more. cfg.pitch
           is setter-controlled and static during playback, unlike pulses/rotate above. */
        pl.playbackRate = Math.pow(2, (cfg.pitch || 0) / 12) * (1 + (Math.random() - 0.5) * 0.012);
        /* A-12: accents on downbeats. r.idiom is 0 for a point that has not opted in — the
           multiplication makes that exactly zero contribution, not merely a small one. 4 dB
           is the ceiling so a fully-idiomatic downbeat never pushes into the limiter next to
           a hit that already sits near cfg.gain's own top. The position passed to
           metricWeight is (R.tick - 1) % 16 — the raw sixteenth-note position within one
           real bar (16 rhythmStep ticks) — not `at`/`steps`: `at` is this voice's position
           within its OWN steps-length pattern grid (64 by default, i.e. four bars), so
           passing steps there would measure quarter-/eighth-note landmarks against a
           four-bar span instead of a real bar, and no actual quarter-note would ever land
           on one. */
        var accentDb = (r.idiom || 0) * metricWeight((R.tick - 1) % 16, 16) * 4;
        pl.volume.value = 20 * Math.log10(Math.max(0.02, (cfg.gain === undefined ? 1 : cfg.gain)))
                        + (Math.random() - 0.5) * 1.5 + accentDb;
        try { pl.start(time); } catch (e) { /* a retrigger inside its own fade */ }
      }
```

Change to (the dry player's pitch/gain math is untouched; the warp engine fires alongside
it at the same trigger and inherits the same computed level, with pitch reaching it via
`detune` — measured against the real Tone.js build to be a plain property independent of
`playbackRate`, which `applyStretch` already owns for the stretch amount itself):

```js
      for (var v = 0; v < HIT_SLOTS.length; v++) {
        var slot = HIT_SLOTS[v], cfg = r.voices[slot], live = R.liveVoices[slot];
        var pl = R.players[slot];
        if (!pl || !pl.loaded || !cfg || !live || live.pulses <= 0) { continue; }
        var pat = rotated(euclid(Math.min(live.pulses, steps), steps), live.rotate || 0);
        if (!pat[at]) { continue; }
        /* A-11: never twice identically. A few cents and a few percent, no more. cfg.pitch
           is setter-controlled and static during playback, unlike pulses/rotate above. */
        pl.playbackRate = Math.pow(2, (cfg.pitch || 0) / 12) * (1 + (Math.random() - 0.5) * 0.012);
        /* A-12: accents on downbeats. r.idiom is 0 for a point that has not opted in — the
           multiplication makes that exactly zero contribution, not merely a small one. 4 dB
           is the ceiling so a fully-idiomatic downbeat never pushes into the limiter next to
           a hit that already sits near cfg.gain's own top. The position passed to
           metricWeight is (R.tick - 1) % 16 — the raw sixteenth-note position within one
           real bar (16 rhythmStep ticks) — not `at`/`steps`: `at` is this voice's position
           within its OWN steps-length pattern grid (64 by default, i.e. four bars), so
           passing steps there would measure quarter-/eighth-note landmarks against a
           four-bar span instead of a real bar, and no actual quarter-note would ever land
           on one. */
        var accentDb = (r.idiom || 0) * metricWeight((R.tick - 1) % 16, 16) * 4;
        var vol = 20 * Math.log10(Math.max(0.02, (cfg.gain === undefined ? 1 : cfg.gain)))
                + (Math.random() - 0.5) * 1.5 + accentDb;
        pl.volume.value = vol;
        try { pl.start(time); } catch (e) { /* a retrigger inside its own fade */ }
        /* The warp engine fires alongside the dry hit whether or not stretch is turned
           up — the blend, not the trigger, is what makes it inaudible at 0 (A-8). Pitch
           reaches it via detune rather than playbackRate: playbackRate is already the
           stretch amount's own knob (grain spawn rate, owned by applyStretch), and
           GrainPlayer keeps the two independent, which is the whole point of a granular
           engine. */
        var st = R.stretch[slot];
        if (st && st.grainPlayer && st.grainPlayer.loaded) {
          st.grainPlayer.detune = (cfg.pitch || 0) * 100;
          st.grainPlayer.volume.value = vol;
          try {
            /* Capped independent of playbackRate — see MAX_STRETCH_HIT_S above. */
            st.grainPlayer.start(time);
            st.grainPlayer.stop(time + MAX_STRETCH_HIT_S);
          } catch (e) { /* a retrigger inside its own fade */ }
        }
      }
```

- [ ] **Step 7: Apply stretch once ready, and give the slider live feedback**

Right after the existing `if (!R.fxReady && R.fx) { applyHitFx(R, r); R.fxReady = true; }`
line in `rhythmStep`, add:

```js
      if (!R.stretchReady && R.stretch) { applyHitStretch(R, r); R.stretchReady = true; }
```

Task 4 Step 6 added the stretch slider's `input` handler ending in `commitR();`. Add a
live `applyHitStretch` call, the same way `rhythm-hit-fx`'s Task 2 added `applyHitFx` to
its own sliders:

```js
      stretchInp.addEventListener("input", function () {
        cfg.stretch = +stretchInp.value; showStretch(); commitR();
        applyHitStretch(bed && bed.rhythms[f.properties.id], r);
      });
```

Also add the same call to the "Randomize effects" button, right after `applyHitFx(...)`:

```js
    rndFx.addEventListener("click", function () {
      randomHitFx(r);
      claimEdit(f);
      save();
      renderRhythmPanel();
      applyHitFx(bed && bed.rhythms[f.properties.id], r);
      applyHitStretch(bed && bed.rhythms[f.properties.id], r);
      toast("New effects");
    });
```

- [ ] **Step 8: Run the tests**

Run: `npm test && npm run check`
Expected: all pass, including every pre-existing test.

- [ ] **Step 9: Verify in a browser**

Serve locally, sign in as a setter, walk a route with a hits-mode point carrying real
attached recordings. With stretch at 0 on every voice, confirm the point sounds exactly as
it did before this task. Raise one voice's stretch: confirm each hit on that voice now
smears into a stretched, granular tail behind the dry attack, growing more extreme as the
slider rises, and disappearing entirely back at 0 with no click. Click "Randomize effects"
while the route plays and confirm stretch changes audibly alongside crush/drive/delay,
with no click at the transition (A-2).

- [ ] **Step 10: Commit**

```bash
git add index.html tests/rhythm-stretch.test.mjs
git commit -m "Wire each hit voice's stretch into its own insert chain"
```
