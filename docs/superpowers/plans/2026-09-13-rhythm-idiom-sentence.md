# Rhythm mode v2, part 1: idiom and the sentence maker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A rhythm point's four-hit pattern accents its strong beats instead of hitting every
pulse at the same weight, and its pattern quietly evolves into a related new one every N bars
instead of looping the same pattern forever — both as continuous, always-audible behaviour,
with a real off position at `idiom = 0` and no change to how the point sounds until then.

**Architecture:** Two additions, both entirely inside `rhythmStep()`'s existing per-tick read
of `cfg.pulses`/`cfg.rotate`/`cfg.gain` — no new audio node, no new `Tone.Transport` call.
Idiom adds a metric-weight term to the existing per-hit gain calculation. The sentence maker
adds a bar counter to the existing `R` (per-point scheduling state) that, every `sentenceBars`
bars, rewrites `cfg.pulses`/`cfg.rotate` from a pre-generated, coprime-nudged, cross-voice-
deduplicated set — the same generation logic `randomRhythm()` already uses for the pattern a
setter dials in by hand, refactored so it can produce several related combos instead of one.

**Tech Stack:** Same as the rest of `index.html` — ES5 `function` expressions, Tone.js already
in use, no new library. Tests follow this repo's established convention: `node:test` reading
and, where a function is pure enough, actually executing slices of `index.html`'s own source.

**Spec:** `docs/superpowers/specs/2026-09-13-rhythm-mode-v2-design.md`

## Global Constraints

- **`idiom = 0` must be bit-identical to the pre-this-plan gain formula.** The accent term is
  additive and multiplied by `idiom`; at 0 it must contribute exactly 0, not merely something
  small (per the spec's A-8-derived rule for this generator).
- **No `Tone.Transport.scheduleRepeat`/`.clear()` call may be added anywhere in this plan.**
  Both features change data an existing loop already reads every tick; grep the diff for this
  before calling either task done (A-16).
- **Backfilling `idiom`/`sentenceBars`/`sentenceSet` on an existing point must never change
  that point's current `pulses`/`rotate`.** `rhythmOf()`'s own stated rule — a point saved
  before a control existed gains it rather than being reset to defaults it never chose —
  applies here exactly as it does to every other field it already backfills.
- **A phrase change must never make two voices collide.** Every pre-generated combo (the
  first one applied immediately by "Generate a pattern," and every later phrase) goes through
  the same de-duplication `randomRhythm()` already does across all four voices, not per-voice
  in isolation.
- **`sentenceBars` is counted in real bars**, independent of a voice's own `div`/`steps`
  settings — two points with different `sentenceBars` must not need to agree on anything to
  each keep their own schedule correct.
- Commit messages: a declarative sentence, then what it prevents or what was measured.

## What this plan does not do

No new audio node, no new effect, no new UI panel section beyond two rows in the existing
`RHYTHM_FIELDS` list. The stretch engine and the bitcrush/distortion/per-slot-delay inserts
(including the "Randomize effects" action) are separate plans per the spec's own "Order of
work" — this plan does not touch `ensureRhythm()`'s player-construction code at all.

## File Structure

| File | Responsibility |
| --- | --- |
| `index.html` | `metricWeight()`, the accent term in `rhythmStep()`, `advanceSentence()`, the bar-boundary hook, `oneComboSet()`/`buildSentenceSet()` (refactored out of `randomRhythm()`), `rhythmOf()`/`defaultRhythm()` backfill, two new `RHYTHM_FIELDS` rows |
| `tests/rhythm-idiom.test.mjs` | `metricWeight`, `oneComboSet`/`buildSentenceSet`, `advanceSentence`, the accent term's presence and its zero-at-idiom-0 property, the two new field rows |

---

### Task 1: Idiom — strong beats hit harder, and idiom 0 changes nothing

**Files:**
- Modify: `index.html` (`defaultRhythm()` at `index.html:6924`, `rhythmOf()` at
  `index.html:6967`, `rhythmStep()` at `index.html:7267`, `RHYTHM_FIELDS` at `index.html:4363`)
- Test: `tests/rhythm-idiom.test.mjs`

**Interfaces:**
- Produces: `metricWeight(at, steps)` — a pure function, `0.12`–`1` depending on how
  metrically strong position `at` is within a `steps`-length bar. `defaultRhythm()` now
  includes `idiom: 0.35`. `rhythmOf()` backfills `r.idiom` for a point saved before this plan.
  All attached to `window.__fa.rhythm` alongside the existing `euclid`/`rotated`/`of`/`slots`
  entries.

- [ ] **Step 1: Write the failing test**

```js
// tests/rhythm-idiom.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8");

function slice(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  assert.ok(start !== -1, `start marker not found: ${startMarker}`);
  const end = html.indexOf(endMarker, start + startMarker.length);
  assert.ok(end !== -1, `end marker not found: ${endMarker}`);
  assert.ok(end > start, `"${endMarker}" occurs at or before "${startMarker}"`);
  return html.slice(start, end);
}

/* Pure functions can actually be extracted and run, unlike most of this file's
   DOM-and-Tone-dependent code — so run them, rather than only pattern-matching the source. */
function extractFn(name, endMarker) {
  const src = slice("function " + name + "(", endMarker);
  const openParen = src.indexOf("(");
  const params = src.slice(openParen + 1, src.indexOf(")", openParen));
  const body = src.slice(src.indexOf("{") + 1, src.lastIndexOf("}"));
  return new Function(params, body);
}

test("metricWeight puts the downbeat highest and degrades gracefully off the 4/8 grid", () => {
  const metricWeight = extractFn("metricWeight", "function ");
  assert.equal(metricWeight(0, 16), 1, "the downbeat is always the strongest position");
  assert.equal(metricWeight(4, 16), 0.6, "16/4 = 4 is a quarter-note landmark");
  assert.equal(metricWeight(2, 16), 0.35, "16/8 = 2 is an eighth-note landmark, weaker than a quarter");
  assert.equal(metricWeight(3, 16), 0.12, "an off-grid position sits at the floor, not zero");
  assert.equal(metricWeight(0, 13), 1, "the downbeat is strongest even when steps has no clean quarter/eighth");
  assert.equal(metricWeight(4, 13), 0.12,
    "13 has no integer quarter or eighth spacing — every non-zero position floors, none throws or NaNs");
});

test("defaultRhythm carries an idiom default, and rhythmOf backfills it field-by-field", () => {
  const def = slice("function defaultRhythm()", "function ");
  assert.match(def, /idiom:\s*0\.35/, "the default must be a real, non-zero starting point");
  const of = slice("function rhythmOf(f)", "function buildRhythmFx(");
  assert.match(of, /r\.idiom\s*===?\s*undefined/,
    "backfill must check for absence, not overwrite a setter's existing choice");
});

test("the accent term is exactly zero when idiom is zero", () => {
  const step = slice("function rhythmStep(time)", "function updateBed");
  /* Matches the exact shape Step 5 writes: (r.idiom || 0) * metricWeight(at, steps) * 4.
     Checked as one literal pattern rather than "idiom and metricWeight both appear
     somewhere nearby" — the first draft of this test used a generic multiplication regex
     that did not actually match this shape (idiom comes before metricWeight here, guarded
     by `|| 0`, not the other way around), and would have passed against code that never
     multiplied the two at all. */
  assert.match(step, /\(r\.idiom \|\| 0\)\s*\*\s*metricWeight\(at,\s*steps\)/,
    "idiom must multiply metricWeight's result, with a || 0 guard so idiom=0 is a real zero");
});

test("idiom and phrase length are real controls, not just data", () => {
  const fields = slice("var RHYTHM_FIELDS", "];");
  assert.match(fields, /k:\s*"idiom"/);
  assert.match(fields, /k:\s*"sentenceBars"/);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test`
Expected: FAIL — `metricWeight` does not exist, `defaultRhythm`/`rhythmOf`/`rhythmStep`/
`RHYTHM_FIELDS` do not yet mention idiom.

- [ ] **Step 3: Write `metricWeight`**

Add directly above `defaultRhythm()` (`index.html:6924`):

```js
  /* How strong a beat position is within a steps-length bar, independent of any one voice's
     own div/pulses — the downbeat is always strongest, then quarter- and eighth-note
     landmarks where steps actually divides evenly into them, everything else at a floor
     rather than zero so idiom accents a pattern without ever silencing part of it. */
  function metricWeight(at, steps) {
    if (at === 0) { return 1; }
    var quarter = steps / 4, eighth = steps / 8;
    if (Number.isInteger(quarter) && at % quarter === 0) { return 0.6; }
    if (Number.isInteger(eighth) && at % eighth === 0) { return 0.35; }
    return 0.12;
  }
```

- [ ] **Step 4: Add the default and the backfill**

`index.html:6924`, `defaultRhythm()` currently returns:

```js
  function defaultRhythm() {
    return {
      on: true, steps: 64, div: "16n", gain: 0.85, swing: 0,
```

Change to:

```js
  function defaultRhythm() {
    return {
      on: true, steps: 64, div: "16n", gain: 0.85, swing: 0, idiom: 0.35,
```

`index.html:6967`, `rhythmOf(f)` currently starts:

```js
  function rhythmOf(f) {
    if (!f.properties.rhythm) { f.properties.rhythm = defaultRhythm(); }
    var r = f.properties.rhythm;
    if (!r.voices) { r.voices = defaultRhythm().voices; }
```

Add the backfill right after:

```js
  function rhythmOf(f) {
    if (!f.properties.rhythm) { f.properties.rhythm = defaultRhythm(); }
    var r = f.properties.rhythm;
    if (!r.voices) { r.voices = defaultRhythm().voices; }
    if (r.idiom === undefined) { r.idiom = defaultRhythm().idiom; }
```

- [ ] **Step 5: Add the accent term**

`index.html:7267`–`7306`, inside the `HIT_SLOTS` loop, the per-hit gain line currently reads:

```js
        pl.playbackRate = Math.pow(2, (cfg.pitch || 0) / 12) * (1 + (Math.random() - 0.5) * 0.012);
        pl.volume.value = 20 * Math.log10(Math.max(0.02, (cfg.gain === undefined ? 1 : cfg.gain)))
                        + (Math.random() - 0.5) * 1.5;
        try { pl.start(time); } catch (e) { /* a retrigger inside its own fade */ }
```

Change to:

```js
        pl.playbackRate = Math.pow(2, (cfg.pitch || 0) / 12) * (1 + (Math.random() - 0.5) * 0.012);
        /* A-12: accents on downbeats. r.idiom is 0 for a point that has not opted in — the
           multiplication makes that exactly zero contribution, not merely a small one. 4 dB
           is the ceiling so a fully-idiomatic downbeat never pushes into the limiter next to
           a hit that already sits near cfg.gain's own top. */
        var accentDb = (r.idiom || 0) * metricWeight(at, steps) * 4;
        pl.volume.value = 20 * Math.log10(Math.max(0.02, (cfg.gain === undefined ? 1 : cfg.gain)))
                        + (Math.random() - 0.5) * 1.5 + accentDb;
        try { pl.start(time); } catch (e) { /* a retrigger inside its own fade */ }
```

- [ ] **Step 6: Add the UI rows**

`index.html:4363`, `RHYTHM_FIELDS` currently:

```js
  var RHYTHM_FIELDS = [
    { k: "on", label: "rhythm", toggle: true },
    { k: "steps", label: "steps", min: 4, max: 64, step: 1 },
    { k: "div", label: "step length", options: function () { return DIVISIONS; },
      fmt: function (v) {
        return (DIV_LABEL[v] || v) + " \u00b7 " +
          divSeconds(v, pacer ? pacer.patch.tempo : 72).toFixed(2) + " s";
      } },
    { k: "gain", label: "level", min: 0, max: 1, step: 0.05 }
  ];
```

Change the closing entries to:

```js
  var RHYTHM_FIELDS = [
    { k: "on", label: "rhythm", toggle: true },
    { k: "steps", label: "steps", min: 4, max: 64, step: 1 },
    { k: "div", label: "step length", options: function () { return DIVISIONS; },
      fmt: function (v) {
        return (DIV_LABEL[v] || v) + " \u00b7 " +
          divSeconds(v, pacer ? pacer.patch.tempo : 72).toFixed(2) + " s";
      } },
    { k: "gain", label: "level", min: 0, max: 1, step: 0.05 },
    { k: "idiom", label: "idiom", min: 0, max: 1, step: 0.02 },
    { k: "sentenceBars", label: "phrase length", min: 4, max: 32, step: 1, unit: " bars" }
  ];
```

(`sentenceBars` is added here alongside `idiom` even though Task 2 is what makes it do
anything — `buildRhythmRow` reads whatever field exists on `r`, and Task 2's backfill runs in
the same `rhythmOf()` this task already touches, so there is no working-but-incomplete state
in between: after this task, the slider exists and shows a value; after Task 2, moving it does
something.)

- [ ] **Step 7: Expose for the browser check**

Near `window.__fa.rhythm = { euclid: euclid, rotated: rotated, of: rhythmOf, slots: HIT_SLOTS };`
(`index.html:5492`):

```js
  window.__fa.rhythm = { euclid: euclid, rotated: rotated, of: rhythmOf, slots: HIT_SLOTS,
                          metricWeight: metricWeight };
```

- [ ] **Step 8: Run the tests**

Run: `npm test && npm run check`
Expected: all pass.

- [ ] **Step 9: Verify in a browser**

Serve locally, sign in as a setter, select a point set to four hits, open its rhythm panel.
Confirm an "idiom" slider appears and moving it does not visibly change the pattern grid
(pulses/rotation stay the same — this task only changes gain). With a route playing and the
point in range, set idiom to 0 and then to 1 while listening: confirm the downbeat-adjacent
hits noticeably pop out at 1 and the pattern sounds unchanged in level at 0 compared to a
point whose idiom has never been touched.

- [ ] **Step 10: Commit**

```bash
git add index.html tests/rhythm-idiom.test.mjs
git commit -m "A rhythm point's strong beats hit harder, and idiom at zero changes nothing"
```

---

### Task 2: The sentence maker — a pattern that evolves into a related one every N bars

**Files:**
- Modify: `index.html` (`randomRhythm()`/`gcd()` at `index.html:4856`,
  `rhythmOf()` at `index.html:6967`, `rhythmStep()` at `index.html:7267`)
- Test: `tests/rhythm-idiom.test.mjs` (appended)

**Interfaces:**
- Consumes: `gcd(a, b)` (existing), `HIT_SLOTS` (existing).
- Produces: `oneComboSet(steps)` — one deduplicated `{low, mid, high, rand}` combo, each
  `{pulses, rotate}`, built with the same band-and-coprime logic `randomRhythm()` already
  used. `buildSentenceSet(steps)` — `SENTENCE_VARIATIONS` (4) such combos, reshaped into
  `{low: [combo, combo, combo, combo], mid: [...], ...}`. `advanceSentence(r, R)` — called
  once per elapsed bar; rewrites `r.voices[slot].pulses`/`.rotate` from the next entry in
  `r.sentenceSet` once `R.barsThisSentence` reaches `r.sentenceBars`. `randomRhythm(r)` now
  also seeds `r.sentenceSet`. `rhythmOf()` backfills `r.sentenceBars`/`r.sentenceSet` without
  touching a point's existing pattern.

- [ ] **Step 1: Write the failing test**

```js
// tests/rhythm-idiom.test.mjs — appended

/* gcd, oneComboSet, buildSentenceSet, randomRhythm and advanceSentence all end up defined
   together, in that dependency order, in the real file — but they all reference HIT_SLOTS,
   which is declared thousands of lines later (index.html:6878) and only has its value by
   the time anything actually calls these functions at runtime, thanks to `var` hoisting.
   Extracting any one of them alone and running it immediately would throw a bare
   ReferenceError on HIT_SLOTS. Extracting the whole dependency-ordered block AND passing
   HIT_SLOTS in as a parameter (rather than trying to also slice out its real declaration
   from 2000 lines away) sidesteps that without faking anything these functions actually do. */
function extractRhythmGenerators() {
  const src = slice("function gcd(a, b)", "function redrawZones(");
  const factory = new Function("HIT_SLOTS", src +
    "\nreturn { gcd: gcd, oneComboSet: oneComboSet, buildSentenceSet: buildSentenceSet, " +
    "randomRhythm: randomRhythm, advanceSentence: advanceSentence, " +
    "SENTENCE_VARIATIONS: SENTENCE_VARIATIONS };");
  return factory(["low", "mid", "high", "rand"]);
}

test("HIT_SLOTS really is exactly the four slots this test injects", () => {
  /* Pins the one assumption extractRhythmGenerators() cannot verify by construction — if
     the real constant ever changes, this fails loudly instead of every test above it
     silently testing against the wrong slot list. */
  assert.match(html, /var HIT_SLOTS = \["low", "mid", "high", "rand"\];/);
});

test("oneComboSet never hands two voices the identical pulses+rotation", () => {
  const { oneComboSet } = extractRhythmGenerators();
  for (let i = 0; i < 20; i++) {
    const combo = oneComboSet(64);
    const keys = ["low", "mid", "high", "rand"].map((s) => combo[s].pulses + ":" + combo[s].rotate);
    assert.equal(new Set(keys).size, 4, "run " + i + ": two voices collided — " + JSON.stringify(combo));
    ["low", "mid", "high", "rand"].forEach((s) => {
      assert.ok(combo[s].pulses >= 1 && combo[s].pulses <= 64, s + ".pulses out of range");
      assert.ok(combo[s].rotate >= 0 && combo[s].rotate < 64, s + ".rotate out of range");
    });
  }
});

test("buildSentenceSet produces one combo per sentence variation, per voice", () => {
  const src = slice("function buildSentenceSet(steps)", "function randomRhythm");
  assert.match(src, /SENTENCE_VARIATIONS/, "the variation count must be a named constant, not a bare 4");
  const { buildSentenceSet } = extractRhythmGenerators();
  const set = buildSentenceSet(64);
  ["low", "mid", "high", "rand"].forEach((slot) => {
    assert.equal(set[slot].length, 4, slot + " must carry one combo per sentence variation");
  });
});

test("randomRhythm seeds sentenceSet, and the pattern it applies immediately is that set's first entry", () => {
  const { randomRhythm } = extractRhythmGenerators();
  const r = { steps: 64, voices: { low: {}, mid: {}, high: {}, rand: {} } };
  randomRhythm(r);
  assert.ok(r.sentenceSet, "randomRhythm must build the phrase set, not only today's pattern");
  ["low", "mid", "high", "rand"].forEach((slot) => {
    assert.equal(r.voices[slot].pulses, r.sentenceSet[slot][0].pulses,
      slot + ": the pattern applied now must be exactly the phrase set's own first variation");
    assert.equal(r.voices[slot].rotate, r.sentenceSet[slot][0].rotate);
  });
});

test("advanceSentence only rewrites the pattern once sentenceBars bars have elapsed, and wraps after SENTENCE_VARIATIONS phrases", () => {
  const { advanceSentence } = extractRhythmGenerators();
  /* Four entries per voice, matching the real SENTENCE_VARIATIONS (4) exactly — the wrap
     is `sentenceIdx % SENTENCE_VARIATIONS`, not `% this fixture's array length`, so a
     shorter fixture array would silently no-op past its own end instead of proving a wrap
     at all. This bit the first draft of this test. */
  const r = { sentenceBars: 2,
    voices: { low: { pulses: 8, rotate: 0 }, mid: { pulses: 13, rotate: 2 },
              high: { pulses: 21, rotate: 1 }, rand: { pulses: 5, rotate: 11 } },
    sentenceSet: {
      low:  [{ pulses: 8,  rotate: 0 }, { pulses: 9,  rotate: 3 }, { pulses: 11, rotate: 6 }, { pulses: 7,  rotate: 9 }],
      mid:  [{ pulses: 13, rotate: 2 }, { pulses: 15, rotate: 5 }, { pulses: 17, rotate: 1 }, { pulses: 19, rotate: 4 }],
      high: [{ pulses: 21, rotate: 1 }, { pulses: 19, rotate: 8 }, { pulses: 23, rotate: 2 }, { pulses: 25, rotate: 6 }],
      rand: [{ pulses: 5,  rotate: 11 }, { pulses: 7, rotate: 20 }, { pulses: 9,  rotate: 15 }, { pulses: 6,  rotate: 3 }]
    } };
  const R = {};
  advanceSentence(r, R);
  assert.equal(r.voices.low.pulses, 8, "one bar into a two-bar phrase: unchanged");
  advanceSentence(r, R);
  assert.equal(r.voices.low.pulses, 9, "two bars elapsed: the phrase advances to variation 1");
  assert.equal(R.barsThisSentence, 0, "the bar counter resets on advance");
  advanceSentence(r, R); advanceSentence(r, R);
  assert.equal(r.voices.low.pulses, 11, "four bars elapsed total: variation 2");
  advanceSentence(r, R); advanceSentence(r, R);
  assert.equal(r.voices.low.pulses, 7, "six bars elapsed total: variation 3");
  advanceSentence(r, R); advanceSentence(r, R);
  assert.equal(r.voices.low.pulses, 8, "eight bars elapsed total: wraps back to variation 0");
});

test("rhythmStep advances the sentence on a bar boundary, counted independently of this voice's own div", () => {
  const step = slice("function rhythmStep(time)", "function updateBed");
  assert.match(step, /advanceSentence\(/);
  /* The bar check must sit on R.tick (every 16th note, every point, unconditionally) rather
     than on the stride-gated `at`/`steps` path below it, or a point on a coarse div would
     advance its sentence too slowly relative to real bars. */
  const tickAt = step.indexOf("R.tick = (R.tick || 0) + 1;");
  const strideGateAt = step.indexOf("(R.tick - 1) % stride !== 0");
  const advanceAt = step.indexOf("advanceSentence(");
  assert.ok(tickAt !== -1 && strideGateAt !== -1 && advanceAt !== -1, "all three anchors must exist");
  assert.ok(tickAt < advanceAt && advanceAt < strideGateAt,
    "the sentence check must run after R.tick increments and before the stride gate could skip it");
});

test("rhythmOf backfills sentenceBars and sentenceSet without touching an existing pattern", () => {
  const of = slice("function rhythmOf(f)", "function buildRhythmFx(");
  assert.match(of, /r\.sentenceBars\s*===?\s*undefined/);
  assert.match(of, /if\s*\(!r\.sentenceSet\)/);
  /* The backfill branch itself must never assign r.voices[...].pulses/.rotate — only
     randomRhythm() (an explicit setter action) may do that. */
  const backfillBlock = of.slice(of.indexOf("if (!r.sentenceSet)"));
  const nextFieldOrEnd = backfillBlock.search(/\n\s*if\s*\(|\n\s*return r;/);
  const scoped = backfillBlock.slice(0, nextFieldOrEnd === -1 ? undefined : nextFieldOrEnd);
  assert.doesNotMatch(scoped, /\.pulses\s*=|\.rotate\s*=/,
    "backfilling the phrase set must not rewrite the voices a setter already chose");
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test`
Expected: FAIL — none of `oneComboSet`, `buildSentenceSet`, `advanceSentence` exist yet;
`randomRhythm` does not seed `sentenceSet`; `rhythmStep` never calls `advanceSentence`.

- [ ] **Step 3: Refactor `randomRhythm` into `oneComboSet` + `buildSentenceSet`**

`index.html:4856`–`4882` currently:

```js
  function gcd(a, b) { while (b) { var t = a % b; a = b; b = t; } return a; }

  function randomRhythm(r) {
    var steps = Math.max(4, Math.min(64, r.steps | 0));
    var band = { low: [0.05, 0.16], mid: [0.16, 0.34], high: [0.28, 0.55],
                 rand: [0.04, 0.28] };
    HIT_SLOTS.forEach(function (slot) {
      var b = band[slot], cfg = r.voices[slot];
      var k = Math.round(steps * (b[0] + Math.random() * (b[1] - b[0])));
      if (k < 1) { k = 1; }
      /* Nudge to something coprime with the step count, but never past the band. */
      for (var tries = 0; tries < 4 && gcd(k, steps) > 1; tries++) {
        var up = k + 1;
        k = (up <= steps && up <= Math.ceil(steps * b[1]) + 1) ? up : k - 1;
        if (k < 1) { k = 1; break; }
      }
      cfg.pulses = Math.min(k, steps);
      cfg.rotate = Math.random() < 0.45 ? 0 : Math.floor(Math.random() * steps);
    });
    /* Two voices with the same count and the same rotation are one voice played twice. */
    var seen = {};
    HIT_SLOTS.forEach(function (slot) {
      var cfg = r.voices[slot], key = cfg.pulses + ":" + cfg.rotate;
      if (seen[key]) { cfg.rotate = (cfg.rotate + 1 + Math.floor(Math.random() * 3)) % steps; }
      seen[cfg.pulses + ":" + cfg.rotate] = 1;
    });
  }
```

Change to:

```js
  function gcd(a, b) { while (b) { var t = a % b; a = b; b = t; } return a; }

  var RHYTHM_BAND = { low: [0.05, 0.16], mid: [0.16, 0.34], high: [0.28, 0.55], rand: [0.04, 0.28] };
  /* How many related patterns one phrase cycle carries. A setter picks the phrase LENGTH
     (sentenceBars); this is how many distinct phrases exist to cycle through before one
     repeats — the same reason four hits, not two or eight, made the original pattern rich
     enough to not obviously loop. */
  var SENTENCE_VARIATIONS = 4;

  /* One deduplicated combo across all four voices — not four independent draws applied to
     one voice each, since a later dedup pass has to reason about all four together anyway.
     This is the unit both the pattern a setter sees immediately and every later phrase are
     built from, so a phrase change is never a step down from the pattern they actually
     chose. */
  function oneComboSet(steps) {
    var out = {};
    HIT_SLOTS.forEach(function (slot) {
      var b = RHYTHM_BAND[slot];
      var k = Math.round(steps * (b[0] + Math.random() * (b[1] - b[0])));
      if (k < 1) { k = 1; }
      /* Nudge to something coprime with the step count, but never past the band. */
      for (var tries = 0; tries < 4 && gcd(k, steps) > 1; tries++) {
        var up = k + 1;
        k = (up <= steps && up <= Math.ceil(steps * b[1]) + 1) ? up : k - 1;
        if (k < 1) { k = 1; break; }
      }
      out[slot] = { pulses: Math.min(k, steps), rotate: Math.random() < 0.45 ? 0 : Math.floor(Math.random() * steps) };
    });
    /* Two voices with the same count and the same rotation are one voice played twice. */
    var seen = {};
    HIT_SLOTS.forEach(function (slot) {
      var c = out[slot], key = c.pulses + ":" + c.rotate;
      if (seen[key]) { c.rotate = (c.rotate + 1 + Math.floor(Math.random() * 3)) % steps; }
      seen[c.pulses + ":" + c.rotate] = 1;
    });
    return out;
  }

  /* SENTENCE_VARIATIONS combos, reshaped from "one set of four voices" to "one array of
     combos per voice" — the shape advanceSentence actually walks through phrase by phrase. */
  function buildSentenceSet(steps) {
    var sets = [];
    for (var i = 0; i < SENTENCE_VARIATIONS; i++) { sets.push(oneComboSet(steps)); }
    var out = {};
    HIT_SLOTS.forEach(function (slot) {
      out[slot] = sets.map(function (s) { return s[slot]; });
    });
    return out;
  }

  function randomRhythm(r) {
    var steps = Math.max(4, Math.min(64, r.steps | 0));
    r.sentenceSet = buildSentenceSet(steps);
    HIT_SLOTS.forEach(function (slot) {
      var first = r.sentenceSet[slot][0];
      r.voices[slot].pulses = first.pulses;
      r.voices[slot].rotate = first.rotate;
    });
  }
```

- [ ] **Step 4: Write `advanceSentence`**

Add directly after `randomRhythm` (same location `gcd`/`randomRhythm` already live,
`index.html:4856` area):

```js
  /* One bar has just elapsed for this point. Counted against this point's OWN sentenceBars,
     not the route's — two points with different phrase lengths never need to agree on
     anything, the same independence rhythmStep already gives their step counters (R.tick,
     R.step) today. Cycles through sentenceSet rather than drawing fresh each phrase, so a
     later phrase is a related pattern rather than a coin flip (A-11/A-12). */
  function advanceSentence(r, R) {
    R.barsThisSentence = (R.barsThisSentence || 0) + 1;
    var span = Math.max(1, r.sentenceBars || 8);
    if (R.barsThisSentence < span || !r.sentenceSet) { return; }
    R.barsThisSentence = 0;
    R.sentenceIdx = ((R.sentenceIdx || 0) + 1) % SENTENCE_VARIATIONS;
    HIT_SLOTS.forEach(function (slot) {
      var set = r.sentenceSet[slot], combo = set && set[R.sentenceIdx];
      if (combo) { r.voices[slot].pulses = combo.pulses; r.voices[slot].rotate = combo.rotate; }
    });
  }
```

- [ ] **Step 5: Hook the bar boundary into `rhythmStep`**

`index.html:7267` area, currently:

```js
      var stride = SECT_STRIDE[r.div] || 1;
      R.tick = (R.tick || 0) + 1;
      if ((R.tick - 1) % stride !== 0) { continue; }
```

Change to:

```js
      var stride = SECT_STRIDE[r.div] || 1;
      R.tick = (R.tick || 0) + 1;
      /* Bars, not the stride gate below: a phrase length is measured against a real bar,
         not against this voice's own step subdivision, so the sentence maker advances on
         schedule however div/steps are set. 16 sixteenths per bar matches SECT_GRID's own
         "16n" and the whole-note "1n" a bar already means everywhere else in this file
         (SECT_STRIDE["1n"] === 16). Hits only: a grains point has one line, not four voices
         to cycle through phrases across. */
      if (f.properties.audio_mode === "hits" && (R.tick - 1) % 16 === 0) {
        advanceSentence(r, R);
      }
      if ((R.tick - 1) % stride !== 0) { continue; }
```

- [ ] **Step 6: Backfill `sentenceBars` and `sentenceSet` in `rhythmOf`**

Continuing the edit Task 1's Step 4 made, `rhythmOf()` now reads:

```js
  function rhythmOf(f) {
    if (!f.properties.rhythm) { f.properties.rhythm = defaultRhythm(); }
    var r = f.properties.rhythm;
    if (!r.voices) { r.voices = defaultRhythm().voices; }
    if (r.idiom === undefined) { r.idiom = defaultRhythm().idiom; }
```

Change to:

```js
  function rhythmOf(f) {
    if (!f.properties.rhythm) { f.properties.rhythm = defaultRhythm(); }
    var r = f.properties.rhythm;
    if (!r.voices) { r.voices = defaultRhythm().voices; }
    if (r.idiom === undefined) { r.idiom = defaultRhythm().idiom; }
    if (r.sentenceBars === undefined) { r.sentenceBars = defaultRhythm().sentenceBars; }
    if (!r.sentenceSet) {
      /* Built fresh, not from randomRhythm(): that also overwrites cfg.pulses/.rotate, and
         a point saved before this plan existed must keep the pattern its setter already
         chose. Only the phrase set — what it grows INTO later — is new for them. */
      r.sentenceSet = buildSentenceSet(Math.max(4, Math.min(64, r.steps | 0)));
    }
```

Also add `sentenceBars: 8,` to `defaultRhythm()`'s return, right next to the `idiom: 0.35`
Task 1 added:

```js
      on: true, steps: 64, div: "16n", gain: 0.85, swing: 0, idiom: 0.35, sentenceBars: 8,
```

- [ ] **Step 7: Run the tests**

Run: `npm test && npm run check`
Expected: all pass, including every existing test — `randomRhythm`'s externally-visible
behaviour (what it assigns to `cfg.pulses`/`.rotate` on the *first* generated combo) is
unchanged; only its internals moved into `oneComboSet`/`buildSentenceSet`.

- [ ] **Step 8: Verify in a browser**

Serve locally, sign in as a setter, select a hits point, click "Generate a pattern," then set
its phrase length to 4 bars (near the minimum, for a quick check) via the new slider. Start a
route walk with the point in range and listen across several phrases: confirm the pattern
audibly changes into a related-sounding new one roughly every 4 bars, not sooner, and that
`window.__fa.rhythm.of(feature).sentenceSet` (read from the console) shows four combos per
voice. Confirm a point that already had a hand-tuned pattern before this change — check one of
the existing test-archive points, or a freshly-imported older export — keeps its exact
original pattern on first load and only starts varying once its first phrase completes.

- [ ] **Step 9: Commit**

```bash
git add index.html tests/rhythm-idiom.test.mjs
git commit -m "A rhythm point's pattern becomes a related new one every N bars, not a fixed loop"
```

---

### Task 3: Verification

**Files:** none created — this task runs the suite and the manual checks Tasks 1–2 already
established the pattern for.

- [ ] **Step 1: Run the full suite**

Run: `npm test && npm run check`
Expected: every test in `tests/rhythm-idiom.test.mjs` and every pre-existing test passes; no
missing ids.

- [ ] **Step 2: Measure the sentence boundary against the Transport clock**

Per the spec's own verification section and this project's [[verify-by-measuring]] rule:
serve locally, set a known tempo and `sentenceBars = 2` on a hits point, start a route walk
with it in range, and log `r.voices.low.pulses` (via `window.__fa.rhythm.of(feature)`) once at
the start of every bar for 8 bars (a `setInterval` at the bar length in ms, computed from
tempo, is enough — this does not need sample accuracy, only bar-count accuracy). Confirm the
value changes exactly at bars 2, 4, 6 and 8, not one bar early or late and not by drifting.

- [ ] **Step 3: Confirm idiom's dry path measurement**

Per A-8's own test method, applied to a generator rather than an effect: with idiom fixed at
0, log `pl.volume.value` for several triggered hits (via a temporary console log or a debug
counter) and confirm the values match what the pre-this-plan formula would have produced for
the same `cfg.gain` and the same random humanization draw — i.e., confirm by inspection that
removing `+ accentDb` at `idiom = 0` changes nothing, since `accentDb` itself is provably 0
there (already covered by Step 3's unit test in Task 1, restated here as a live listening
check rather than only a source-level one).

- [ ] **Step 4: Confirm nothing regressed for grains mode or a route with no rhythm points**

Select a grains-mode point and confirm its pattern and sound are unaffected (the bar-boundary
hook only fires for `audio_mode === "hits"`). Walk a route with no hits/grains points at all
and confirm nothing throws — `bed.rhythms` stays empty and `rhythmStep` returns early via its
existing `!bed || !bed.on || !pacer` guard, unchanged by this plan.

- [ ] **Step 5: Commit**

Only if Steps 2–4 turned up a fix; otherwise this task ends at Step 1's passing run with
nothing to commit.
