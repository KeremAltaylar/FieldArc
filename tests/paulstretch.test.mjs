// tests/paulstretch.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

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
   same technique tests/rhythm-idiom.test.mjs's extractFn already uses for metricWeight.
   Brace-COUNTING rather than slicing to a second marker: the marker approach broke the
   moment a later task's own function landed between this one and whatever fixed marker
   an earlier task's test had picked (e.g. fft's own test written in Task 1, but three
   more functions land between fft and warpStep by the time Task 4 is done — a fixed end
   marker would silently capture all of them into fft's own "body"). Counting braces from
   the function's own opening one to its own matching close has no such dependency on
   what gets added later. */
function extractFn(name) {
  const startNeedle = "function " + name + "(";
  const start = html.indexOf(startNeedle);
  assert.ok(start !== -1, `function not found: ${name}`);
  const closeParen = html.indexOf(")", start + startNeedle.length - 1);
  const params = html.slice(start + startNeedle.length, closeParen);
  const bodyStart = html.indexOf("{", closeParen);
  let depth = 0, i = bodyStart;
  for (; i < html.length; i++) {
    if (html[i] === "{") { depth++; }
    else if (html[i] === "}") { depth--; if (depth === 0) { break; } }
  }
  const body = html.slice(bodyStart + 1, i);
  return new Function(params, body);
}

test("fft forward then inverse recovers the original signal", () => {
  const fft = extractFn("fft");
  const n = 8;
  const re = [1, 2, 3, 4, 5, 6, 7, 8];
  const im = [0, 0, 0, 0, 0, 0, 0, 0];
  const origRe = re.slice();
  fft(re, im, false);
  fft(re, im, true);
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(re[i] - origRe[i]) < 1e-9, `re[${i}] round-trip mismatch: ${re[i]}`);
    assert.ok(Math.abs(im[i]) < 1e-9, `im[${i}] should return to ~0, got ${im[i]}`);
  }
});

test("fft of a pure sine wave concentrates energy in the expected bin (and its mirror)", () => {
  const fft = extractFn("fft");
  const n = 64, k = 5;
  const re = [], im = [];
  for (let i = 0; i < n; i++) { re.push(Math.sin(2 * Math.PI * k * i / n)); im.push(0); }
  fft(re, im, false);
  const mags = re.map((r, i) => Math.sqrt(r * r + im[i] * im[i]));
  const maxIdx = mags.indexOf(Math.max(...mags));
  assert.ok(maxIdx === k || maxIdx === n - k,
    `expected the dominant bin at ${k} or ${n - k}, got ${maxIdx}`);
});

test("fft is linear: scaling the input scales the transform by the same factor", () => {
  const fft = extractFn("fft");
  const n = 16;
  const re1 = [], im1 = [], re2 = [], im2 = [];
  for (let i = 0; i < n; i++) {
    const v = Math.cos(2 * Math.PI * 3 * i / n) + 0.3 * Math.random();
    re1.push(v); im1.push(0);
    re2.push(v * 2.5); im2.push(0);
  }
  fft(re1, im1, false);
  fft(re2, im2, false);
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(re2[i] - re1[i] * 2.5) < 1e-6, `re[${i}] not linearly scaled`);
    assert.ok(Math.abs(im2[i] - im1[i] * 2.5) < 1e-6, `im[${i}] not linearly scaled`);
  }
});

test("synthesizeHop returns a windowSize-length frame with no NaN/Infinity, for any read position", () => {
  const fft = extractFn("fft");
  const synthesizeHop = extractFn("synthesizeHop");
  const n = 16, windowSize = 16;
  const source = Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * 3 * i / n));
  const rnd = () => Math.random();
  [-5, 0, 5, n - 2, n + 5].forEach((readPos) => {
    const out = synthesizeHop(source, readPos, windowSize, 0, fft, rnd);
    assert.equal(out.length, windowSize);
    out.forEach((v, i) => {
      assert.ok(Number.isFinite(v), `synthesizeHop(readPos=${readPos})[${i}] is not finite: ${v}`);
    });
  });
});

test("synthesizeHop is deterministic given a deterministic randomFn — no hidden state beyond what's passed in", () => {
  const fft = extractFn("fft");
  const synthesizeHop = extractFn("synthesizeHop");
  const n = 32;
  const source = Array.from({ length: n }, (_, i) => Math.cos(2 * Math.PI * 4 * i / n));
  let calls = 0;
  const rnd = () => { calls++; return (calls % 7) / 7; }; // deterministic but non-constant
  const out1 = synthesizeHop(source, 0, n, 0, fft, (() => { let c = 0; return () => { c++; return (c % 7) / 7; }; })());
  const out2 = synthesizeHop(source, 0, n, 0, fft, (() => { let c = 0; return () => { c++; return (c % 7) / 7; }; })());
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(out1[i] - out2[i]) < 1e-9, `frame[${i}] differs between two calls with identical inputs`);
  }
});

test("synthesizeHop's magnitude spectrum (before the final re-window) matches the source's own, phase aside", () => {
  /* The whole point of the phase-vocoder step is "keep magnitude, replace phase" — verify
     that literally, not just "the output has plausible-looking numbers". Uses a FIXED
     randomFn so the output's own re-transform is directly comparable, rather than trying
     to reason about a randomised result. warpBins=0 so no shift is applied either. */
  const fft = extractFn("fft");
  const synthesizeHop = extractFn("synthesizeHop");
  const n = 32;
  const source = Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * 6 * i / n));
  // Compute the expected magnitude spectrum of the windowed source directly.
  const win = Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)));
  const expectedRe = source.map((s, i) => s * win[i]);
  const expectedIm = new Array(n).fill(0);
  fft(expectedRe, expectedIm, false);
  const expectedMag = expectedRe.map((r, i) => Math.sqrt(r * r + expectedIm[i] * expectedIm[i]));
  // Run synthesizeHop with a fixed phase, then re-FFT its output (which was re-windowed —
  // divide that back out isn't needed since we only check magnitude proportionality
  // qualitatively: the frame with the most source energy in a bin must still show it).
  const out = synthesizeHop(source, 0, n, 0, fft, () => 0.37);
  const outRe = out.slice(), outIm = new Array(n).fill(0);
  fft(outRe, outIm, false);
  const outMag = outRe.map((r, i) => Math.sqrt(r * r + outIm[i] * outIm[i]));
  const expectedPeak = expectedMag.indexOf(Math.max(...expectedMag));
  const outPeak = outMag.indexOf(Math.max(...outMag));
  assert.equal(outPeak, expectedPeak,
    "the dominant frequency bin must survive the magnitude-keep/phase-discard round trip");
});

test("synthesizeHop's warpBins shifts which bin carries the dominant magnitude", () => {
  const fft = extractFn("fft");
  const synthesizeHop = extractFn("synthesizeHop");
  const n = 32, k = 4, shift = 3;
  const source = Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * k * i / n));
  const outShifted = synthesizeHop(source, 0, n, shift, fft, () => 0.5);
  const outRe = outShifted.slice(), outIm = new Array(n).fill(0);
  fft(outRe, outIm, false);
  const mag = outRe.map((r, i) => Math.sqrt(r * r + outIm[i] * outIm[i]));
  const peak = mag.indexOf(Math.max(...mag));
  assert.ok(peak === k + shift || peak === n - (k + shift) || peak === Math.abs(n - k - shift),
    `expected the shifted dominant bin near ${k + shift}, got ${peak}`);
});

test("buildPaulstretchWorkletUrl assembles fft and synthesizeHop's own real source into the module, not a hand-copied duplicate", () => {
  const fft = extractFn("fft");
  const synthesizeHop = extractFn("synthesizeHop");
  const src = slice("function buildPaulstretchWorkletUrl()", "\n  }\n");
  assert.match(src, /registerProcessor\(\s*["']paulstretch-processor["']/);
  assert.match(src, /class PaulstretchProcessor extends AudioWorkletProcessor/);
  assert.match(src, /new Blob\(/);
  assert.match(src, /URL\.createObjectURL\(/);
  // Prove the worklet embeds fft.toString()/synthesizeHop.toString() calls, not
  // hardcoded duplicates that could silently drift from the real functions later.
  assert.match(src, /fft\.toString\(\)/, "must call fft.toString(), not embed a hardcoded duplicate");
  assert.match(src, /synthesizeHop\.toString\(\)/, "must call synthesizeHop.toString(), not embed a hardcoded duplicate");
});

test("the worklet module never materialises the full stretched duration as one pre-rendered buffer", () => {
  const src = slice("function buildPaulstretchWorkletUrl()", "\n  }\n");
  assert.doesNotMatch(src, /new Float32Array\(\s*source\.length\s*\*\s*(stretchFactor|params\.stretchFactor)/,
    "a buffer sized by source length times the stretch factor would be exactly the " +
    "hundreds-of-megabytes-at-200x problem this design specifically avoids");
});

test("the worklet's process() outputs silence rather than throwing before its source has arrived", () => {
  const src = slice("function buildPaulstretchWorkletUrl()", "\n  }\n");
  assert.match(src, /if\s*\(!this\.source\)/);
});

test("loadPaulstretchModule registers the module before anything can construct the node from it, and only once", () => {
  const src = slice("function loadPaulstretchModule(ctx)", "\n  }\n");
  assert.match(src, /ctx\.audioWorklet\.addModule\(\s*buildPaulstretchWorkletUrl\(\)\s*\)/);
  assert.match(src, /if\s*\(!paulstretchModulePromise\)/,
    "must cache the promise — addModule/registerProcessor for the same name a second " +
    "time throws on some browsers, and every voice's ensureVoice call reaches this");
});

test("connectNativeToToneGain asserts Tone's private internals are real AudioNodes before relying on them", () => {
  const src = slice("function connectNativeToToneGain(nativeSrc, toneGain)", "\n  }\n");
  assert.match(src, /toneGain\._gainNode/);
  assert.match(src, /_nativeAudioNode/);
  assert.match(src, /instanceof AudioNode/,
    "must check the drilled-into object is really a native AudioNode, not just present, " +
    "so a future Tone.js version renaming these internals fails loudly rather than " +
    "silently connecting to the wrong thing or throwing an unrelated-looking error");
  assert.match(src, /throw new Error/);
});

test("ensureVoice constructs the worklet node from Tone's true native context, not the Tone-wrapped one", () => {
  const src = slice("function ensureVoice(z, d)", "\n  }\n");
  assert.match(src, /rawContext\._nativeAudioContext/,
    "measured against the real build: rawContext itself fails instanceof BaseAudioContext " +
    "and AudioWorkletNode's own constructor rejects it directly");
  assert.match(src, /new AudioWorkletNode\(/);
});

test("ensureVoice awaits loadPaulstretchModule before constructing the AudioWorkletNode", () => {
  const src = slice("function ensureVoice(z, d)", "\n  }\n");
  assert.match(src, /loadPaulstretchModule\(/,
    "new AudioWorkletNode(ctx, 'paulstretch-processor') throws unless addModule already " +
    "registered that name on this context — skipping this is an easy, silent-until-runtime mistake");
  const moduleCallIdx = src.indexOf("loadPaulstretchModule(");
  const nodeCtorIdx = src.indexOf("new AudioWorkletNode(");
  assert.ok(moduleCallIdx !== -1 && nodeCtorIdx !== -1 && moduleCallIdx < nodeCtorIdx,
    "loadPaulstretchModule's promise must resolve (i.e. appear earlier in the .then chain) " +
    "before the AudioWorkletNode constructor runs");
});

test("ensureVoice no longer references GrainPlayer or applyStretch for the soundscape voice", () => {
  const src = slice("function ensureVoice(z, d)", "\n  }\n");
  assert.doesNotMatch(src, /Tone\.GrainPlayer/);
  assert.doesNotMatch(src, /applyStretch\(/);
});

test("ensureVoice sends the decoded recording to the worklet via a transferred Float32Array, not a copy", () => {
  const src = slice("function ensureVoice(z, d)", "\n  }\n");
  assert.match(src, /postMessage\(\s*\{\s*type:\s*["']source["']/);
  assert.match(src, /\[\s*\w+\.buffer\s*\]/, "the second postMessage argument must transfer, not copy");
});

test("bedStop's voice-disposal block disconnects the worklet node rather than disposing a Tone object it no longer has", () => {
  const src = slice("v.player.stop(); v.player.dispose();", "v.filter.dispose(); v.gain.dispose();");
  assert.match(src, /v\.stretch\.node\.disconnect\(\)/);
  assert.doesNotMatch(src, /v\.grainPlayer/);
});

test("warpStep no longer references GrainPlayer-specific properties", () => {
  const src = slice("function warpStep(time)", "\n  }\n");
  assert.doesNotMatch(src, /\.detune\s*=/);
  assert.doesNotMatch(src, /\.loopStart\s*=/);
  assert.doesNotMatch(src, /\.loopEnd\s*=/);
  assert.doesNotMatch(src, /\.grainSize\s*=/);
  assert.doesNotMatch(src, /\.overlap\s*=/);
});

test("warpStep still applies grit every tick, unchanged", () => {
  const src = slice("function warpStep(time)", "\n  }\n");
  assert.match(src, /applyGrit\(v\.grit, q\.grit\)/);
});

test("warpStep posts fresh stretch/warp/morph parameters to the worklet for every ready voice", () => {
  const src = slice("function warpStep(time)", "\n  }\n");
  assert.match(src, /v\.stretch\.node\.port\.postMessage\(/);
  assert.match(src, /stretchFactor:/);
  assert.match(src, /warpBins:/);
  assert.match(src, /morphRate:/);
});

test("the soundscape panel's stretch/warp/morph/field/grit sliders post live updates to the worklet while dragging", () => {
  const src = slice("function renderSoundscapePanel(f, q, commitQ, body)", "\n  }\n");
  assert.match(src, /bed\.voices\[f\.properties\.id\]/,
    "must reach the live voice for this point, the same way the hit-slot sliders reach " +
    "bed.rhythms[f.properties.id]");
});

/* ---------- Final-review fix round: morph formula + synthesisHop clamp ----------
   These two are singled out (final-review-fix-brief.md) as the easiest to silently
   regress: the morph fix is a one-character-looking change to an arithmetic formula
   buried inside a string-assembled worklet module, and the clamp is a bare Math.max
   easy to "clean up" away later. Both get real, executed coverage below rather than
   pattern-matching alone. */

/* Raw source text of a top-level "function NAME(...) { ... }" declaration, exactly as
   written in the file — i.e. what fft.toString()/synthesizeHop.toString() themselves
   return in the real browser. Deliberately NOT extractFn(): extractFn hands back a
   `new Function(...)`-built function, whose own .toString() prints "function anonymous"
   rather than the real name, which would silently strip the "synthesizeHop"/"fft"
   identifiers the worklet's own class methods call by name. */
function extractRawFnSource(name) {
  const startNeedle = "function " + name + "(";
  const start = html.indexOf(startNeedle);
  assert.ok(start !== -1, `function not found: ${name}`);
  const closeParen = html.indexOf(")", start + startNeedle.length - 1);
  const bodyStart = html.indexOf("{", closeParen);
  let depth = 0, i = bodyStart;
  for (; i < html.length; i++) {
    if (html[i] === "{") { depth++; }
    else if (html[i] === "}") { depth--; if (depth === 0) { break; } }
  }
  return html.slice(start, i + 1);
}

/* Assembles the SAME module source buildPaulstretchWorkletUrl() would — the literal
   `lines` array text straight from the file, with its two fft.toString()/
   synthesizeHop.toString() calls swapped for the real, raw source text those calls
   would themselves produce — without needing Blob/URL.createObjectURL, which Node's
   test runner doesn't reliably provide. */
function buildWorkletModuleSource() {
  const fnSrc = slice("function buildPaulstretchWorkletUrl()", "\n  }\n");
  const linesStart = fnSrc.indexOf("var lines = [");
  assert.ok(linesStart !== -1, "buildPaulstretchWorkletUrl's lines array not found");
  const blobIdx = fnSrc.indexOf("var blob = new Blob(");
  assert.ok(blobIdx !== -1, "buildPaulstretchWorkletUrl's Blob construction not found");
  // The array's own elements include strings like "frame[i];", which itself contains
  // "];" — indexOf from the start would stop there instead of at the array's real
  // close. lastIndexOf scanning backward from the Blob construction lands on the
  // actual closing "];" immediately before it, regardless of what's embedded earlier.
  const linesEnd = fnSrc.lastIndexOf("];", blobIdx) + 2;
  assert.ok(linesEnd > linesStart + "var lines = [".length,
    "could not locate the lines array's own closing bracket");
  let linesSrc = fnSrc.slice(linesStart, linesEnd);
  assert.ok(linesSrc.includes("fft.toString()") && linesSrc.includes("synthesizeHop.toString()"),
    "expected exactly the two known .toString() calls in the lines array");
  linesSrc = linesSrc.replace("fft.toString()", JSON.stringify(extractRawFnSource("fft")));
  linesSrc = linesSrc.replace("synthesizeHop.toString()",
    JSON.stringify(extractRawFnSource("synthesizeHop")));
  const buildLines = new Function(linesSrc + "\nreturn lines;");
  const lines = buildLines();
  return lines.join("\n");
}

/* Runs the assembled module in a real V8 context (not a regex) with the minimal native
   surface an AudioWorkletProcessor needs (sampleRate, a base class with a .port,
   registerProcessor), and hands back the actual class the module registers — so tests
   below call the real _synthesizeOneHop(), not a description of it. */
function loadPaulstretchProcessorClass() {
  const sandbox = { sampleRate: 44100 };
  sandbox.AudioWorkletProcessor = class {
    constructor() { this.port = { onmessage: null, postMessage() {} }; }
  };
  let captured = null;
  sandbox.registerProcessor = function (name, cls) { captured = cls; };
  vm.createContext(sandbox);
  vm.runInContext(buildWorkletModuleSource(), sandbox);
  assert.ok(captured, "registerProcessor was never called by the assembled worklet module");
  return captured;
}

test("_synthesizeOneHop's morph contribution stays scaled by 1/stretchFactor: at stretchFactor=200 it never dominates the primary stretch term, across morphRate 0 to 1", () => {
  const Processor = loadPaulstretchProcessorClass();
  const stretchFactor = 200;
  const synthesisHop = 1024;
  const primaryAdvance = synthesisHop / stretchFactor; // samples/hop from the stretch alone
  [0, 0.02, 0.25, 0.5, 1.0].forEach((morphRate) => {
    const proc = new Processor();
    proc.source = new Float32Array(200000); // long enough that readPos never wraps below
    proc.readPos = 1000;
    proc.params.stretchFactor = stretchFactor;
    proc.params.morphRate = morphRate;
    proc.params.synthesisHop = synthesisHop;
    proc.params.windowSize = 64; // any power of 2; only the advance math is under test
    proc._synthesizeOneHop();
    const advance = proc.readPos - 1000;
    const expected = primaryAdvance * (1 + morphRate);
    assert.ok(Math.abs(advance - expected) < 1e-6,
      `morphRate=${morphRate}: expected advance ~${expected}, got ${advance}`);
    // The bug this guards against: morph's term applied at an unstretched rate, which at
    // morphRate=0.02 already ran ~4x the primary term and by morphRate=1.0 erased the
    // stretch entirely. The fixed formula can add at most one more primary term.
    assert.ok(advance <= primaryAdvance * 2 + 1e-9,
      `morphRate=${morphRate}: advance ${advance} exceeds twice the primary stretch term ` +
      `(${primaryAdvance}) — morph is dominating the stretch again`);
    // Even at morph's maximum, the read position must still crawl far slower than one
    // synthesis hop per hop — proof the 200x stretch survives, not just "some advance".
    assert.ok(advance < synthesisHop / 10,
      `morphRate=${morphRate}: advance ${advance} is no longer small next to synthesisHop ` +
      `(${synthesisHop}) — the extreme stretch has collapsed`);
  });
});

test("_synthesizeOneHop never produces a non-finite readPos, even with warpBins active alongside morph", () => {
  const Processor = loadPaulstretchProcessorClass();
  const proc = new Processor();
  proc.source = new Float32Array(4096).map((_, i) => Math.sin(i * 0.1));
  proc.readPos = 0;
  proc.params.stretchFactor = 200;
  proc.params.morphRate = 1.0;
  proc.params.warpBins = 7;
  proc.params.synthesisHop = 1024;
  proc.params.windowSize = 64;
  for (let i = 0; i < 5; i++) { proc._synthesizeOneHop(); }
  assert.ok(Number.isFinite(proc.readPos), `readPos went non-finite: ${proc.readPos}`);
  assert.ok(proc.readPos >= 0 && proc.readPos < proc.source.length,
    `readPos ${proc.readPos} left the source's own [0, length) range`);
});

/* Pulls the exact `synthesisHop: Math.max(...)` expression out of each computation site
   and evaluates it for real (balanced-paren extraction, not a regex over the whole
   thing, since the expression nests Math.round(...) and (...) groups inside it) — so a
   regression that changes the clamp's floor, or drops it, fails on real numbers. */
function extractSynthesisHopFn(fnSrc, label) {
  const marker = "synthesisHop: ";
  const idx = fnSrc.indexOf(marker);
  assert.ok(idx !== -1, `${label}: synthesisHop assignment not found`);
  const exprStart = idx + marker.length;
  assert.ok(fnSrc.slice(exprStart).startsWith("Math.max("),
    `${label}: synthesisHop must be clamped via Math.max(...)`);
  const parenStart = fnSrc.indexOf("(", exprStart);
  let depth = 0, i = parenStart;
  for (; i < fnSrc.length; i++) {
    if (fnSrc[i] === "(") { depth++; }
    else if (fnSrc[i] === ")") { depth--; if (depth === 0) { break; } }
  }
  assert.ok(depth === 0, `${label}: synthesisHop expression's parens never balanced`);
  const expr = fnSrc.slice(exprStart, i + 1);
  return new Function("q", "return " + expr + ";");
}

test("synthesisHop is clamped to a safe positive floor in both warpStep and commitLive, so an out-of-range field (imported/synced data, or any future non-slider caller) can never drive the worklet's hopCounter to zero or negative", () => {
  const warpStepSrc = slice("function warpStep(time)", "\n  }\n");
  const commitLiveSrc = slice("var commitLive = function ()", "\n    };\n");
  const warpStepHop = extractSynthesisHopFn(warpStepSrc, "warpStep");
  const commitLiveHop = extractSynthesisHopFn(commitLiveSrc, "commitLive");

  [0, 0.5, 1, 1.0001, 5, 100, -1, -100, NaN].forEach((field) => {
    [["warpStep", warpStepHop], ["commitLive", commitLiveHop]].forEach(([label, fn]) => {
      const hop = fn({ field: field });
      assert.ok(Number.isFinite(hop) && hop >= 64,
        `${label} field=${field}: synthesisHop ${hop} fell to or below the safe floor — ` +
        "this is exactly the condition that locks hopCounter and the audio thread with it");
    });
  });

  // The normal slider range (field 0 to 1) must stay exactly as before this fix.
  assert.equal(warpStepHop({ field: 0 }), 1024);
  assert.equal(warpStepHop({ field: 1 }), 410);
  assert.equal(commitLiveHop({ field: 0 }), 1024);
  assert.equal(commitLiveHop({ field: 1 }), 410);
});

/* ---------- Final-review fix round: the remaining three findings ---------- */

test("ensureVoice only ramps stretchBlend.fade toward q.stretch when the worklet is actually ready, at both ready-branch call sites — otherwise a failed/loading worklet fades toward a wet side with nothing feeding it, which is quieter, not silent", () => {
  const src = slice("function ensureVoice(z, d)", "\n  }\n");
  const onloadSrc = slice("onload: function () {", "\n        }\n      }).connect(v.stretchBlend.a);");
  assert.match(onloadSrc, /\(v\.stretch\s*&&\s*v\.stretch\.ready\)\s*\?\s*q2\.stretch\s*:\s*0/,
    "the onload branch must gate its blend ramp on v.stretch.ready");
  const existingVoiceSrc = src.slice(0, src.indexOf("v = bed.voices[z.id] = { ready: false"));
  assert.match(existingVoiceSrc, /if\s*\(v\.stretch\s*&&\s*v\.stretch\.ready\)\s*\{[\s\S]*?v\.stretchBlend\.fade\.rampTo\(q\.stretch, BED\.fade\);[\s\S]*?\}\s*else\s*\{[\s\S]*?v\.stretchBlend\.fade\.rampTo\(0, BED\.fade\);/,
    "the existing-voice branch must ramp toward q.stretch only inside the v.stretch.ready guard, and to 0 otherwise");
});

test("ensureVoice guards the nativeCtx lookup and logs+toasts loudly on any stretch-init failure, instead of an uncaught throw or a silent no-op catch", () => {
  const src = slice("function ensureVoice(z, d)", "\n  }\n");
  assert.match(src, /if\s*\(!nativeCtx\)\s*\{\s*throw new Error/,
    "a missing/renamed Tone internal must throw a caught, loud error rather than an " +
    "uncaught throw that leaks the already-built dry player/filter/grit/blend");
  const catchCount = (src.match(/console\.error\(\s*"Paulstretch worklet failed to initialize/g) || []).length;
  assert.ok(catchCount >= 2,
    "both the synchronous nativeCtx guard and the async Promise.all catch must log loudly");
  assert.match(src, /toast\(\s*"Extreme stretch unavailable/,
    "the failure must also reach the person using the app via toast(), not just the console");
  assert.doesNotMatch(src, /the worklet stays silent \(blend at 0\)/,
    "the old, now-inaccurate silent-catch comment must be gone");
});

test("ensureVoice's Promise.all callback checks the resolved voice is still THIS closure's own v, not merely that some voice exists at that id — a stop/start race during decode must abort the stale continuation", () => {
  const src = slice("function ensureVoice(z, d)", "\n  }\n");
  const promiseAllThen = src.slice(src.indexOf("Promise.all(["), src.indexOf("connectNativeToToneGain("));
  assert.match(promiseAllThen, /bed\.voices\[z\.id\]\s*!==\s*v/,
    "must compare identity against the closure's own v, not just truthiness — a replacement " +
    "voice under the same id must abort this stale continuation rather than wiring a live " +
    "worklet into a disposed v.grit.input");
});

test("the soundscape panel's copy describes the real phase-vocoder engine, not the deleted GrainPlayer one", () => {
  const src = slice("function renderSoundscapePanel(f, q, commitQ, body)", "\n  }\n");
  assert.doesNotMatch(src, /jitters grain size and overlap/,
    "field is a direct function of the slider, not a per-tick jitter, and it no longer " +
    "touches grain size/overlap — that GrainPlayer property doesn't exist in this engine");
  assert.doesNotMatch(src, /granular wash/i,
    "the bed's own engine is a phase vocoder (spectral), not granular");
  assert.doesNotMatch(src, /the same engine a hit's own stretch uses/,
    "false since this plan: hit-slot stretch still uses Tone.GrainPlayer, only the " +
    "soundscape bed moved to the worklet");
  assert.doesNotMatch(src, /scattered grain cloud/,
    "field no longer produces a grain cloud — it widens/narrows the phase vocoder's own " +
    "synthesis-hop overlap density");
  assert.match(src, /phase vocoder/i,
    "the copy should name the actual engine somewhere in the panel");
});

/* ---------- The soundscape panel's waveform + stretched-length readout ---------- */

test("stretchedDurationInfo: at stretch=0 the recording's own length comes back untouched, matching the panel's own \"played as it is\" claim", () => {
  const stretchedDurationInfo = extractFn("stretchedDurationInfo");
  const info = stretchedDurationInfo(4.2, 0, 0);
  assert.equal(info.factor, 1);
  assert.equal(info.seconds, 4.2);
});

test("stretchedDurationInfo: at stretch=1 one pass takes the full 200x — the actual motivating case, not some partial blend", () => {
  const stretchedDurationInfo = extractFn("stretchedDurationInfo");
  const info = stretchedDurationInfo(3, 1, 0);
  assert.equal(info.factor, 200);
  assert.equal(info.seconds, 600);
});

test("stretchedDurationInfo: morph shortens the reported pass length by exactly the same 1/(1+morphRate) the worklet's own advance formula applies, so the readout can never drift from what's actually heard", () => {
  const stretchedDurationInfo = extractFn("stretchedDurationInfo");
  const info = stretchedDurationInfo(3, 1, 1);
  assert.equal(info.factor, 200);
  assert.equal(info.seconds, 300);
});

test("stretchedDurationInfo clamps stretch and morph the same way the worklet's own params do, so out-of-range callers can't produce a negative or absurd readout", () => {
  const stretchedDurationInfo = extractFn("stretchedDurationInfo");
  assert.equal(stretchedDurationInfo(3, -1, 0).factor, 1);
  assert.equal(stretchedDurationInfo(3, 5, 0).factor, 200);
  assert.equal(stretchedDurationInfo(3, 0, -1).seconds, 3);
  assert.equal(stretchedDurationInfo(0, 1, 0).seconds, 0);
});

test("fmtLongDuration formats seconds, minutes and hours the way a person actually reads an extreme-stretch length, not fmtTime's m:ss", () => {
  const fmtLongDuration = extractFn("fmtLongDuration");
  assert.equal(fmtLongDuration(0), "0s");
  assert.equal(fmtLongDuration(45), "45s");
  assert.equal(fmtLongDuration(90), "1m 30s");
  assert.equal(fmtLongDuration(120), "2m");
  assert.equal(fmtLongDuration(3720), "1h 2m");
  assert.equal(fmtLongDuration(7200), "2h");
  assert.equal(fmtLongDuration(-5), "0s");
  assert.equal(fmtLongDuration(NaN), "0s");
});

test("renderSoundscapePanel draws a waveform and a stretched-length caption above the sliders, and the caption updates on every commitLive drag, not just at first render", () => {
  const src = slice("function renderSoundscapePanel(f, q, commitQ, body)", "\n  }\n");
  const waveIdx = src.indexOf("ppwave");
  const colsIdx = src.indexOf("var cols = document.createElement");
  assert.ok(waveIdx !== -1, "the panel must create a .ppwave canvas");
  assert.ok(waveIdx < colsIdx,
    "the waveform must be built before the slider columns, so it renders above them");
  assert.match(src, /updateWaveCaption\(\);\s*\n\s*\n\s*var cols/,
    "the caption must be populated once at initial render, before the sliders exist");
  const commitLiveSrc = src.slice(src.indexOf("var commitLive = function ()"),
    src.indexOf("col.appendChild(buildSoundRow({ k: \"stretch\""));
  assert.match(commitLiveSrc, /updateWaveCaption\(\);/,
    "every commitLive drag (stretch, warp, morph, field, grit all call it) must refresh " +
    "the caption, not just the worklet's own params");
  /* Regression coverage for a real bug caught by live testing (not by this suite): the
     caption update was originally placed AFTER commitLive's live-voice guard
     ("if (!v || !v.ready...) { return; }"), so it silently never ran while editing in the
     setter with no bed voice currently playing — the common case, not the exception. The
     caption is pure arithmetic on q/durationS and must run unconditionally, before that
     guard, same as commitQ() itself. */
  const guardIdx = commitLiveSrc.search(/if\s*\(!v\s*\|\|\s*!v\.ready/);
  const captionIdx = commitLiveSrc.indexOf("updateWaveCaption();");
  assert.ok(guardIdx !== -1, "commitLive's live-voice guard must still be present");
  assert.ok(captionIdx < guardIdx,
    "updateWaveCaption() must run before the live-voice guard, not after it — otherwise " +
    "the caption never updates unless a bed voice happens to be playing right now");
  assert.match(src, /q\.stretch > 0/,
    "at stretch=0 the caption must say the recording plays as it is, matching the rest " +
    "of the panel's own dry-at-zero language, not report a meaningless ×1 stretch");
});
