// tests/patch-follows-route.test.mjs — the route you are walking owns the sound.
/* Measured on the live app, 2026-09-21: `bed.voice` and its three FX chains are built once per
   page session (bedStart guards with `if (!bed.voice)`) and bedStop never clears them, so
   pressing Sound, stopping, and starting again on a DIFFERENT route returned the identical
   voice object and the identical FX chain — same reverb decay (3.4s), same fx3 wet (0.72). The
   first route of a session therefore owned the synth type, the reverb decays, the delay
   divisions and every wet level for every route walked afterwards. voiceStep keeps the
   per-tick parameters current, which is why this hid: the notes followed the patch while the
   instrument they were played on did not.

   commitPatch already held the complete "tell an existing voice what this patch says" routine
   — it was simply wired only to the patch panel, never to the walk changing route. These tests
   pin that routine as a named function and pin all three callers. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8").replace(/\r\n/g, "\n");
function src(name) {
  const s = html.indexOf("function " + name + "(");
  assert.ok(s !== -1, "missing " + name);
  let i = html.indexOf("{", html.indexOf(")", s)), d = 0;
  for (; i < html.length; i++) { if (html[i] === "{") d++; else if (html[i] === "}") { d--; if (!d) break; } }
  return html.slice(s, i + 1);
}

test("applyPatchToVoice exists, and is the only place the ramps are written", () => {
  const fn = src("applyPatchToVoice");
  for (const p of ["fx.delay.wet", "fx.delay.feedback", "fx.reverb.wet",
                   "fx2.delay.wet", "fx2.reverb.wet", "fx3.delay.wet", "fx3.reverb.wet"]) {
    assert.ok(fn.includes(p), "applyPatchToVoice must carry " + p);
  }
  for (const call of ["applySynths(patch)", "applyRevDecay(patch)", "applySectRhythm(patch)",
                      "applyRhythmFx(patch)"]) {
    assert.ok(fn.includes(call), "applyPatchToVoice must carry " + call);
  }
  /* DRY: commitPatch delegates rather than keeping its own copy, or the two drift apart the
     next time a patch field is added. */
  const commit = src("commitPatch");
  assert.ok(commit.includes("applyPatchToVoice(patch)"), "commitPatch must delegate");
  assert.ok(!commit.includes("fx3.delay.feedback.rampTo"),
    "commitPatch must not keep a second copy of the ramps");
});

test("pressing Sound hands the current walk's patch to a voice built by an earlier one", () => {
  const fn = src("bedStart");
  assert.match(fn, /if \(!bed\.voice\) \{ bed\.voice = buildVoice\(Tone, patch\); \}\s*\n\s*else \{ applyPatchToVoice\(patch\); \}/,
    "a voice that already exists must be told this patch, not left on the last one's");
});

test("crossing into another route's reach in open world re-voices the synths", () => {
  const fn = src("worldSwap");
  const take = fn.slice(fn.indexOf("var take ="));
  assert.ok(take.includes("pacer.patch = patchOf(near.f);"), "the swap still adopts the patch");
  assert.ok(take.includes("applyPatchToVoice(pacer.patch);"),
    "and the synths must follow it, or open world crossfades to a key change with the old instrument");
  assert.ok(take.indexOf("applyPatchToVoice") > take.indexOf("pacer.patch = patchOf"),
    "applied after the patch is adopted, not before");
});

/* The routine is extracted verbatim and executed against recording stubs, so this fails if a
   future edit drops a field rather than only if the source text changes shape. */
test("every FX parameter the patch names reaches the graph", () => {
  const body = src("applyPatchToVoice").replace(/^function applyPatchToVoice\(patch\) \{/, "").replace(/\}$/, "");
  const ramped = {};
  const param = (name) => ({ rampTo: (v) => { ramped[name] = v; }, value: 0 });
  const chain = (tag) => ({
    delay: { delayTime: param(tag + ".delayTime"), wet: param(tag + ".wet"),
             feedback: param(tag + ".feedback") },
    reverb: { wet: param(tag + ".revWet") }
  });
  const voice = {
    bus: { gain: param("bus") },
    synth: { bass: { gain: { gain: param("bass") } }, top: { gain: { gain: param("top") } } },
    sect: { gain: { gain: param("sect") } },
    v3: { bus: { gain: param("v3") } },
    fx: chain("fx"), fx2: chain("fx2"), fx3: chain("fx3")
  };
  const bed = { on: true, voice, rhythms: {}, Tone: { Transport: { bpm: param("bpm") } } };
  const patch = {
    tempo: 96,
    voice: { on: true, gain: 0.8, bass: 0.9, top: 0.7 },
    sect: { on: true, gain: 0.5 },
    v3: { on: true, gain: 0.55 },
    fx:  { delayDiv: "8n.", delayWet: 0.75, delayFb: 0.72, revWet: 0.18 },
    fx2: { delayDiv: "8n",  delayWet: 0.40, delayFb: 0.70, revWet: 0.00 },
    fx3: { delayDiv: "4n",  delayWet: 0.68, delayFb: 0.70, revWet: 0.72 }
  };
  const noop = () => {};
  const run = new Function(
    "patch", "bed", "MAX_DELAY_S", "delaySeconds", "divSeconds", "applySynths",
    "applyRevDecay", "applySectRhythm", "applyRhythmFx", "applyHitFx", "feature", "rhythmOf",
    body);
  run(patch, bed, 4, () => 0.3, () => 0.5, noop, noop, noop, noop, noop, () => null, noop);

  assert.equal(ramped.bpm, 96, "tempo");
  assert.equal(ramped.bus, 0.8, "the pad's level");
  assert.equal(ramped.bass, 0.9);
  assert.equal(ramped.top, 0.7);
  assert.equal(ramped.sect, 0.5, "the counter-line's level");
  assert.equal(ramped.v3, 0.55, "the third voice's level");
  assert.equal(ramped["fx.wet"], 0.75);
  assert.equal(ramped["fx.feedback"], 0.72);
  assert.equal(ramped["fx.revWet"], 0.18);
  assert.equal(ramped["fx2.wet"], 0.40);
  assert.equal(ramped["fx2.revWet"], 0.00, "a patch that asks for no reverb must get none");
  assert.equal(ramped["fx3.wet"], 0.68);
  assert.equal(ramped["fx3.revWet"], 0.72, "the fx3 wet that was measured stuck at the first route's");
});

test("a voice toggled off is silenced by the same routine", () => {
  const fn = src("applyPatchToVoice");
  assert.ok(fn.includes("patch.voice.on ? patch.voice.gain : 0"), "the pad's own toggle");
  assert.ok(fn.includes("patch.sect.on ? patch.sect.gain : 0"), "the counter-line's");
  assert.ok(fn.includes("patch.v3.on ? patch.v3.gain : 0"), "the third voice's");
});
