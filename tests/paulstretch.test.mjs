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

test("loadPaulstretchModule registers the module only once", () => {
  const src = slice("function loadPaulstretchModule(ctx)", "\n  }\n");
  assert.match(src, /if\s*\(!paulstretchModulePromise\)/,
    "must cache the promise — addModule/registerProcessor for the same name a second " +
    "time throws on some browsers, and every voice's ensureVoice call reaches this");
});

test("ensureVoice builds the worklet through Tone's own context, never by splicing a native node behind it", () => {
  /* Measured 2026-09-18 in Chrome with Tone 15.5.42: a native AudioWorkletNode connected into
     a Tone.Gain's private _nativeAudioNode reached that gain (-20 dBFS) and went no further —
     every node downstream read -inf, while the same chain fed by a Tone.Oscillator read -3 dBFS.
     standardized-audio-context only wires a node's outputs once it sees an active input through
     its own graph; a node spliced in natively is invisible to it. That silence is the whole
     "stretch fades out instead of stretching" report. */
  const src = slice("function ensureVoice(z, d)", "\n  }\n");
  assert.match(src, /createAudioWorkletNode\(\s*["']paulx-processor["']/);
  assert.match(src, /Tone\.connect\(\s*node\s*,\s*v\.grit\.input\s*\)/);
  assert.doesNotMatch(src, /_nativeAudioContext/);
  assert.doesNotMatch(src, /connectNativeToToneGain\(/);
  assert.doesNotMatch(src, /new AudioWorkletNode\(/);
});

test("ensureVoice awaits loadPaulstretchModule before creating the worklet node", () => {
  const src = slice("function ensureVoice(z, d)", "\n  }\n");
  const moduleCallIdx = src.indexOf("loadPaulstretchModule(");
  const nodeCtorIdx = src.indexOf("createAudioWorkletNode(");
  assert.ok(moduleCallIdx !== -1 && nodeCtorIdx !== -1 && moduleCallIdx < nodeCtorIdx,
    "the module must be registered before the node that names it is created");
});

test("ensureVoice no longer references GrainPlayer or applyStretch for the soundscape voice", () => {
  const src = slice("function ensureVoice(z, d)", "\n  }\n");
  assert.doesNotMatch(src, /Tone\.GrainPlayer/);
  assert.doesNotMatch(src, /applyStretch\(/);
});

test("voice disposal disconnects the worklet node rather than disposing a Tone object it no longer has", () => {
  const src = slice("function freeVoice(v)", "\n  }\n");
  assert.match(src, /v\.stretch\.node\.disconnect\(\)/);
  assert.doesNotMatch(src, /v\.grainPlayer/);
  /* And the references go with it: the processor holds the whole recording for as long as the
     node is reachable, which is the leak freeVoice was extracted to fix. */
  assert.match(src, /v\.stretch\.node\.port\.onmessage = null;/);
  assert.match(src, /v\.stretch\.node = null;/);
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

test("the soundscape panel's stretch/warp/morph/field/grit sliders post live updates to the worklet while dragging", () => {
  const src = slice("function renderSoundscapePanel(f, q, commitQ, body)", "\n  }\n");
  assert.match(src, /bed\.voices\[f\.properties\.id\]/,
    "must reach the live voice for this point, the same way the hit-slot sliders reach " +
    "bed.rhythms[f.properties.id]");
});

/* ---------- Final-review fix round: the remaining three findings ---------- */

test("the soundscape is always the stretch engine: stretch is never a dry/wet amount, and the plain recording is heard only if the engine failed", () => {
  /* Kerem, 2026-09-18: "the signal should always be wet so 0 means 0 stretch". The blend is
     a failure fallback now, not a control. */
  const src = slice("function ensureVoice(z, d)", "\n  }\n");
  assert.doesNotMatch(src, /stretchBlend\.fade\.rampTo\(\s*q2?\.stretch/,
    "the stretch amount must never drive the dry/wet blend");
  assert.match(src, /v\.stretchBlend = makeBlend\(Tone, 1\)/, "wet from the first moment");
  assert.match(src, /stretchBlend\.fade\.rampTo\(v\.stretch\.failed \? 0 : 1, BED\.fade\)/);
  const failures = (src.match(/v\.stretch\.failed = true;/g) || []).length;
  assert.ok(failures >= 2, "both the async and the synchronous failure paths must fall back to dry");
});

test("ensureVoice logs+toasts loudly on any stretch-init failure, instead of an uncaught throw or a silent no-op catch", () => {
  const src = slice("function ensureVoice(z, d)", "\n  }\n");
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
  const promiseAllThen = src.slice(src.indexOf("Promise.all(["), src.indexOf("Tone.connect(node"));
  assert.match(promiseAllThen, /bed\.voices\[z\.id\]\s*!==\s*v/,
    "must compare identity against the closure's own v, not just truthiness — a replacement " +
    "voice under the same id must abort this stale continuation rather than wiring a live " +
    "worklet into a disposed v.grit.input");
});

test("ensureVoice listens for the worklet's own 'pos' messages and stores them on v.stretch, so the panel's live cursor has somewhere to read a real position from", () => {
  const src = slice("function ensureVoice(z, d)", "\n  }\n");
  const nodeIdx = src.indexOf("var node = tctx.createAudioWorkletNode(");
  const readyIdx = src.indexOf("v.stretch.ready = true;");
  assert.ok(nodeIdx !== -1 && readyIdx !== -1 && nodeIdx < readyIdx,
    "expected the worklet node construction before the ready flag is set");
  const between = src.slice(nodeIdx, readyIdx);
  assert.match(between, /node\.port\.onmessage\s*=\s*function/,
    "ensureVoice must listen on the worklet's own port, not just send to it");
  assert.match(between, /e\.data\.type === ['"]pos['"]/,
    "the listener must recognise the worklet's 'pos' message type");
  assert.match(between, /v\.stretch\.readPos\s*=\s*e\.data\.readPos/,
    "the reported readPos must be stored on v.stretch, where the panel's redraw loop reads it");
  assert.match(between, /v\.stretch\.sourceLength\s*=\s*e\.data\.sourceLength/,
    "the reported sourceLength must be stored too — the panel needs it to compute a fraction");
});

/* ---------- The soundscape panel's waveform + stretched-length readout ---------- */

test("stretchedDurationInfo: at stretch=0 the recording's own length comes back untouched, matching the panel's own \"played as it is\" claim", () => {
  const stretchedDurationInfo = extractFn("stretchedDurationInfo");
  const info = stretchedDurationInfo(4.2, 0, 0);
  assert.equal(info.factor, 1);
  assert.equal(info.seconds, 4.2);
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

/* ---------- The waveform elongates instead of shrinking ---------- */

test("smoothedPeaksForStretch is a no-op at stretch=0 — the waveform must look exactly like the plain recording until stretch actually does something", () => {
  const smoothedPeaksForStretch = extractFn("smoothedPeaksForStretch");
  const peaks = [0.1, 0.9, 0.2, 0.8, 0.3, 0.7, 0.1, 0.9];
  assert.deepEqual(smoothedPeaksForStretch(peaks, 0), peaks);
});

test("smoothedPeaksForStretch keeps the same length and spreads a sharp peak into a softer, broader hump as stretch rises — never shrinks the recording into a smaller picture", () => {
  const smoothedPeaksForStretch = extractFn("smoothedPeaksForStretch");
  const n = 200;
  const impulse = new Array(n).fill(0);
  impulse[100] = 1;

  const half = smoothedPeaksForStretch(impulse, 0.5);
  const max = smoothedPeaksForStretch(impulse, 1);
  assert.equal(half.length, n, "stretch must never change how many points the waveform draws");
  assert.equal(max.length, n, "stretch must never change how many points the waveform draws");

  // The peak's own value must be averaged DOWN (a sharp spike softening into a hump) —
  // more so at stretch=1 than at stretch=0.5.
  assert.ok(max[100] < half[100], "max stretch must soften the peak more than half stretch");
  assert.ok(half[100] < impulse[100], "any smoothing must reduce the sharp peak's own value");

  // A box average's total "energy" is conserved, so a wider window flattens the peak's
  // own height — but it must reach further outward with non-zero influence, which is
  // the actual "hump spreading" a person sees: the width of the softened bump, not its
  // height at one fixed point.
  function reach(arr) {
    var maxDist = 0;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] > 1e-9) { maxDist = Math.max(maxDist, Math.abs(i - 100)); }
    }
    return maxDist;
  }
  assert.ok(reach(max) > reach(half) && reach(half) > 0,
    "the hump's reach must widen further outward at higher stretch, not stay pinned to the original spike");
});

test("smoothedPeaksForStretch clamps out-of-range stretch instead of producing NaN or throwing", () => {
  const smoothedPeaksForStretch = extractFn("smoothedPeaksForStretch");
  const peaks = [0.1, 0.9, 0.2, 0.8, 0.3, 0.7, 0.1, 0.9];
  [-1, 5, NaN, undefined].forEach((s) => {
    const out = smoothedPeaksForStretch(peaks, s);
    assert.equal(out.length, peaks.length);
    out.forEach((v) => assert.ok(Number.isFinite(v), `stretch=${s} produced a non-finite value`));
  });
});
