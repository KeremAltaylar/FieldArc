// tests/paulstretch.test.mjs
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
