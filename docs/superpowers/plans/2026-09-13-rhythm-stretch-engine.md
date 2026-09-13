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
| `index.html` | `stretchParams(amount)`; `soundOf()`/`soundOfZone()` gain a `stretch` field; `buildSoundRow`'s reset-default lookup becomes data-driven; `ensureVoice()` gains a blended `Tone.GrainPlayer`; a new `renderSoundscapePanel()` and its branch in `renderRhythmPanel()`. Task 3 (appended later): the per-slot hit chain in `ensureRhythm()`/`rhythmStep()`. |
| `tests/rhythm-stretch.test.mjs` | `stretchParams`'s shape and range; the data-model backfill; `ensureVoice`'s node graph and disposal list; the panel branch and empty state. |

## Order of work

This plan currently has two tasks. **Task 3 — the per-hit-slot stretch — is deliberately not
written yet**: it touches `ensureRhythm()`/`disposeRhythm()`/`rhythmStep()`, the exact
functions the sibling plan `2026-09-13-rhythm-hit-fx.md` is rewriting concurrently. Writing
Task 3 against pre-hit-fx line numbers and code shapes now would go stale the moment that
plan's Task 2 lands. Once `rhythm-hit-fx` is merged to `main`, append Task 3 to this plan
(same file) using the merged shape of those three functions, then execute it the same way.
Tasks 1 and 2 below touch none of those functions and are safe to build now.

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

### Task 3: The per-hit-slot stretch (write once `2026-09-13-rhythm-hit-fx.md` has merged)

Not yet written — see "Order of work" above. When ready to write it: read the merged
`ensureRhythm()`/`disposeRhythm()`/`rhythmStep()` from `main`, add a sixth per-voice field
(`stretch: 0`, backfilled the same way as the other five), build a `Tone.GrainPlayer` per slot
alongside the existing `Tone.Player` (both reading the slot's own buffer, both triggered
together at the same pulse `time`, both capped to the same short duration so a stretched hit
still ends), blended via `makeBlend()` into `R.fx[slot].input` in place of the dry player's
current direct connection, and add a `stretch` slider to the per-voice row next to
crush/drive/delay. Use `stretchParams(amount)` from Task 1 unchanged.
