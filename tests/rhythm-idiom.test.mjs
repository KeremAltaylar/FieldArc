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
  /* Every fixture above happens to use steps = 16, the one value where a bar and a full
     pattern grid coincide — which is exactly why the accent-term call site could pass the
     wrong position argument (a voice's own `steps`, e.g. 64 by default) without any test
     here catching it. 64 is the shipped default and must still land quarter/eighth
     landmarks correctly on its own four-bar grid. */
  assert.equal(metricWeight(0, 64), 1, "the downbeat is strongest on a 64-step grid too");
  assert.equal(metricWeight(16, 64), 0.6, "64/4 = 16 is a quarter-note landmark");
  assert.equal(metricWeight(8, 64), 0.35, "64/8 = 8 is an eighth-note landmark, weaker than a quarter");
  assert.equal(metricWeight(3, 64), 0.12, "an off-grid position on a 64-step grid still floors, not zero");
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
  /* Matches the exact shape rhythmStep writes: (r.idiom || 0) * metricWeight((R.tick - 1) %
     16, 16) * 4. Checked as one literal pattern rather than "idiom and metricWeight both
     appear somewhere nearby" — the first draft of this test used a generic multiplication
     regex that did not actually match this shape (idiom comes before metricWeight here,
     guarded by `|| 0`, not the other way around), and would have passed against code that
     never multiplied the two at all. The position argument is `(R.tick - 1) % 16` rather
     than `at`/`steps` — `at` is a voice's position within its own steps-length pattern grid
     (64 by default, four bars), so passing it (with steps) would measure metricWeight's
     quarter-/eighth-note landmarks against a four-bar span instead of one real bar. That
     doesn't change whether idiom=0 zeroes the whole term, which is what this test checks. */
  assert.match(step, /\(r\.idiom \|\| 0\)\s*\*\s*metricWeight\(\(R\.tick - 1\) % 16,\s*16\)/,
    "idiom must multiply metricWeight's result, with a || 0 guard so idiom=0 is a real zero");
});

test("idiom and phrase length are real controls, not just data", () => {
  const fields = slice("var RHYTHM_FIELDS", "];");
  assert.match(fields, /k:\s*"idiom"/);
  assert.match(fields, /k:\s*"sentenceBars"/);
});

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
  const r = { sentenceBars: 2, steps: 64,
    /* r.voices is the persisted, setter-owned pattern. advanceSentence must never write to
       it — it mutates R.liveVoices, a playback-only copy — so this fixture's r.voices stays
       fixed as a sentinel: every assertion below checks R.liveVoices, and a final check
       confirms r.voices never moved at all. */
    voices: { low: { pulses: 8, rotate: 0 }, mid: { pulses: 13, rotate: 2 },
              high: { pulses: 21, rotate: 1 }, rand: { pulses: 5, rotate: 11 } },
    sentenceSet: {
      low:  [{ pulses: 8,  rotate: 0 }, { pulses: 9,  rotate: 3 }, { pulses: 11, rotate: 6 }, { pulses: 7,  rotate: 9 }],
      mid:  [{ pulses: 13, rotate: 2 }, { pulses: 15, rotate: 5 }, { pulses: 17, rotate: 1 }, { pulses: 19, rotate: 4 }],
      high: [{ pulses: 21, rotate: 1 }, { pulses: 19, rotate: 8 }, { pulses: 23, rotate: 2 }, { pulses: 25, rotate: 6 }],
      rand: [{ pulses: 5,  rotate: 11 }, { pulses: 7, rotate: 20 }, { pulses: 9,  rotate: 15 }, { pulses: 6,  rotate: 3 }]
    } };
  /* The scheduler seeds R.liveVoices once, as a shallow copy of r.voices, before it ever
     calls advanceSentence — reproduced here rather than re-deriving rhythmStep's seeding. */
  const R = { liveVoices: {
    low: { pulses: 8, rotate: 0 }, mid: { pulses: 13, rotate: 2 },
    high: { pulses: 21, rotate: 1 }, rand: { pulses: 5, rotate: 11 }
  } };
  advanceSentence(r, R);
  assert.equal(R.liveVoices.low.pulses, 8, "one bar into a two-bar phrase: unchanged");
  advanceSentence(r, R);
  assert.equal(R.liveVoices.low.pulses, 9, "two bars elapsed: the phrase advances to variation 1");
  assert.equal(R.barsThisSentence, 0, "the bar counter resets on advance");
  advanceSentence(r, R); advanceSentence(r, R);
  assert.equal(R.liveVoices.low.pulses, 11, "four bars elapsed total: variation 2");
  advanceSentence(r, R); advanceSentence(r, R);
  assert.equal(R.liveVoices.low.pulses, 7, "six bars elapsed total: variation 3");
  advanceSentence(r, R); advanceSentence(r, R);
  assert.equal(R.liveVoices.low.pulses, 8, "eight bars elapsed total: wraps back to variation 0");
  ["low", "mid", "high", "rand"].forEach((slot) => {
    assert.equal(r.voices[slot].pulses, r.sentenceSet[slot][0].pulses,
      slot + ": r.voices (the persisted, setter-owned pattern) must never be touched by advanceSentence");
    assert.equal(r.voices[slot].rotate, r.sentenceSet[slot][0].rotate,
      slot + ": same for rotate — only R.liveVoices may move during playback");
  });
});

test("advanceSentence does nothing when R.liveVoices has not been seeded yet", () => {
  const { advanceSentence } = extractRhythmGenerators();
  /* Guards against a caller that skips rhythmStep's lazy-init: without R.liveVoices there
     is nothing safe to mutate, so advanceSentence must no-op rather than throw or silently
     fall back to writing r.voices. */
  const r = { sentenceBars: 1, steps: 16,
    voices: { low: { pulses: 8, rotate: 0 }, mid: { pulses: 13, rotate: 2 },
              high: { pulses: 21, rotate: 1 }, rand: { pulses: 5, rotate: 11 } },
    sentenceSet: {
      low: [{ pulses: 9, rotate: 3 }], mid: [{ pulses: 15, rotate: 5 }],
      high: [{ pulses: 19, rotate: 8 }], rand: [{ pulses: 7, rotate: 20 }]
    } };
  const R = {};
  assert.doesNotThrow(() => advanceSentence(r, R));
  assert.equal(R.liveVoices, undefined, "no liveVoices must be fabricated by advanceSentence itself");
  assert.equal(r.voices.low.pulses, 8, "r.voices must still be untouched");
});

test("advanceSentence clamps a stale sentenceSet combo to the current steps, so voices never collide", () => {
  const { advanceSentence } = extractRhythmGenerators();
  /* A setter lowered steps to 8 after the phrase set was built for 64 — the stale combo's
     pulses (55) and rotate (40) both exceed the new step count. Finding 3 fixes the root
     cause (rebuilding sentenceSet when steps changes); this is the defensive backstop that
     must hold even if a stale set slips through some other path. */
  const r = { sentenceBars: 1, steps: 8,
    voices: { low: { pulses: 3, rotate: 0 }, mid: { pulses: 3, rotate: 0 },
              high: { pulses: 3, rotate: 0 }, rand: { pulses: 3, rotate: 0 } },
    /* advanceSentence's first call moves R.sentenceIdx from undefined to 1 (0 + 1, wrapped
       by SENTENCE_VARIATIONS), so the stale combo lives at index 1 here, with a harmless
       placeholder at index 0 that is never reached. */
    sentenceSet: { low: [{ pulses: 3, rotate: 0 }, { pulses: 55, rotate: 40 }],
                   mid: [{ pulses: 3, rotate: 0 }, { pulses: 3, rotate: 0 }],
                   high: [{ pulses: 3, rotate: 0 }, { pulses: 3, rotate: 0 }],
                   rand: [{ pulses: 3, rotate: 0 }, { pulses: 3, rotate: 0 }] } };
  const R = { liveVoices: {
    low: { pulses: 3, rotate: 0 }, mid: { pulses: 3, rotate: 0 },
    high: { pulses: 3, rotate: 0 }, rand: { pulses: 3, rotate: 0 }
  } };
  advanceSentence(r, R);
  assert.equal(R.liveVoices.low.pulses, 8, "pulses must be clamped down to steps, never exceed it");
  assert.equal(R.liveVoices.low.rotate, 40 % 8, "rotate must wrap into [0, steps)");
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
