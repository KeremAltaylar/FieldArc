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
