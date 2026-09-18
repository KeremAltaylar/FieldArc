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
    const out = synthesizeHop(source, readPos, windowSize, 0, 1, fft, rnd);
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
  const out1 = synthesizeHop(source, 0, n, 0, 1, fft, (() => { let c = 0; return () => { c++; return (c % 7) / 7; }; })());
  const out2 = synthesizeHop(source, 0, n, 0, 1, fft, (() => { let c = 0; return () => { c++; return (c % 7) / 7; }; })());
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
  const out = synthesizeHop(source, 0, n, 0, 1, fft, () => 0.37);
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
  const outShifted = synthesizeHop(source, 0, n, shift, 1, fft, () => 0.5);
  const outRe = outShifted.slice(), outIm = new Array(n).fill(0);
  fft(outRe, outIm, false);
  const mag = outRe.map((r, i) => Math.sqrt(r * r + outIm[i] * outIm[i]));
  const peak = mag.indexOf(Math.max(...mag));
  assert.ok(peak === k + shift || peak === n - (k + shift) || peak === Math.abs(n - k - shift),
    `expected the shifted dominant bin near ${k + shift}, got ${peak}`);
});

test("synthesizeHop's pitchRatio shifts the dominant bin multiplicatively — harmonic ratios preserved, not a fixed additive offset the way warpBins is", () => {
  const fft = extractFn("fft");
  const synthesizeHop = extractFn("synthesizeHop");
  const n = 64, k = 8, ratio = 0.5; // one octave down
  const source = Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * k * i / n));
  const out = synthesizeHop(source, 0, n, 0, ratio, fft, () => 0.5);
  const outRe = out.slice(), outIm = new Array(n).fill(0);
  fft(outRe, outIm, false);
  const mag = outRe.map((r, i) => Math.sqrt(r * r + outIm[i] * outIm[i]));
  const peak = mag.indexOf(Math.max(...mag));
  // bin i's magnitude comes from source bin round(i/ratio) — the dominant source bin k
  // ends up at output bin round(k*ratio), the multiplicative relationship a true pitch
  // shift needs (an additive shift, like warpBins, would instead land at k+something).
  const expected = Math.round(k * ratio);
  assert.ok(peak === expected || peak === n - expected,
    `expected the pitch-shifted dominant bin at ${expected} (or its mirror), got ${peak}`);
});

test("synthesizeHop's pitchRatio at 1 is a provable no-op: matches an independent reference implementation of the pre-pitchRatio resynthesis path", () => {
  const fft = extractFn("fft");
  const synthesizeHop = extractFn("synthesizeHop");

  /* Independent reference for the pre-pitch-lookup resynthesis path: windowing -> fft ->
     magnitude -> warpBins' existing additive offset -> random phase -> ifft -> re-window —
     the exact shape synthesizeHop had before this whole plan added pitchRatio, with no
     pitch lookup at all. At pitchRatio=1, round(i/1) === i for every i, so the shipped
     pitch lookup must reduce to exactly this. Written independently here, not derived from
     or copy-pasted out of synthesizeHop itself, so it can actually catch a regression —
     unlike the self-comparison this test used to be, which compared synthesizeHop only to
     itself with identical arguments and could never fail. That self-comparison form is
     exactly what let fix round 1's real regression (silently zeroing the upper half of the
     spectrum at pitchRatio=1) through undetected. Measured separation between correct code
     and that round-1 regression: worst per-sample diff here is ~2.5e-16 against this
     reference, vs. ~2.15e-1 against the round-1 bug reconstructed the same way — about 14
     orders of magnitude, decisive at any reasonable tolerance. */
  function referenceSynthesizeHop(source, readPos, windowSize, warpBins, fftFn, randomFn) {
    var i, srcIdx, s, w, mag, srcBin, phase;
    var re = new Array(windowSize), im = new Array(windowSize);
    var start = Math.floor(readPos);
    for (i = 0; i < windowSize; i++) {
      srcIdx = start + i;
      s = (srcIdx >= 0 && srcIdx < source.length) ? source[srcIdx] : 0;
      w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (windowSize - 1));
      re[i] = s * w;
      im[i] = 0;
    }
    fftFn(re, im, false);
    mag = new Array(windowSize);
    for (i = 0; i < windowSize; i++) { mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]); }
    var outRe = new Array(windowSize), outIm = new Array(windowSize);
    for (i = 0; i < windowSize; i++) {
      srcBin = ((i - warpBins) % windowSize + windowSize) % windowSize;
      phase = randomFn() * 2 * Math.PI;
      outRe[i] = mag[srcBin] * Math.cos(phase);
      outIm[i] = mag[srcBin] * Math.sin(phase);
    }
    fftFn(outRe, outIm, true);
    for (i = 0; i < windowSize; i++) {
      w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (windowSize - 1));
      outRe[i] *= w;
    }
    return outRe;
  }

  // Sweep a few (windowSize, warpBins) combinations, not just one.
  [
    { n: 16, warpBins: 0 },
    { n: 16, warpBins: 3 },
    { n: 32, warpBins: 0 },
    { n: 32, warpBins: -2 },
    { n: 64, warpBins: 5 },
    { n: 64, warpBins: 0 },
  ].forEach(({ n, warpBins }) => {
    const source = Array.from({ length: n }, (_, i) =>
      Math.sin(2 * Math.PI * 5 * i / n) + 0.3 * Math.cos(2 * Math.PI * 3 * i / n));
    let c1 = 0;
    const rnd1 = () => { c1++; return (c1 % 7) / 7; };
    let c2 = 0;
    const rnd2 = () => { c2++; return (c2 % 7) / 7; };
    const shipped = synthesizeHop(source, 0, n, warpBins, 1, fft, rnd1);
    const reference = referenceSynthesizeHop(source, 0, n, warpBins, fft, rnd2);
    for (let i = 0; i < n; i++) {
      assert.ok(Math.abs(shipped[i] - reference[i]) < 1e-9,
        `n=${n} warpBins=${warpBins} frame[${i}] differs from the independent reference: ` +
        `${shipped[i]} vs ${reference[i]}`);
    }
  });
});

test("synthesizeHop's pitchRatio zero-fills past the spectrum's edge instead of wrapping — a downward pitch shift must not pull spurious high-frequency content back in from the opposite end", () => {
  const fft = extractFn("fft");
  const synthesizeHop = extractFn("synthesizeHop");
  const n = 32;
  // All energy concentrated near the top of the spectrum (bin n/2 - 1, just below Nyquist).
  const source = Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * (n / 2 - 1) * i / n));
  const ratio = 0.25; // aggressive downward shift: round(i/ratio) = 4*i, out of range for i >= n/4
  const out = synthesizeHop(source, 0, n, 0, ratio, fft, () => 0.5);
  const outRe = out.slice(), outIm = new Array(n).fill(0);
  fft(outRe, outIm, false);
  const mag = outRe.map((r, i) => Math.sqrt(r * r + outIm[i] * outIm[i]));
  // Bins whose round(i/ratio) = 4*i lands past n must carry (near-)zero magnitude — if
  // wrapping were happening instead of zero-filling, energy from the source's own top bin
  // would reappear here via modulo arithmetic.
  // Threshold is 1e-3, not an idealized 0 — a Hann-windowed analysis/synthesis pair leaks a
  // small amount of energy into neighboring bins for any real signal (measured max leakage
  // in this exact range: 3.82e-4, at bin 10 — a ~2.6x margin under the 1e-3 threshold, the
  // loop's own weakest legitimate case). A real wrap-around bug instead measures
  // ~0.19-0.37 at bins 11-13 (a 190x-370x margin over 1e-3 — comfortably caught), but its
  // weakest bins are uneven: bins 10 and 14 (the edges of the wrapped-in region) measure
  // only ~2.07e-4 (a ~4.8x margin — still below 1e-3, so those two alone wouldn't catch
  // it), and bin 15 measures ~1.94e-3 (only a ~1.9x margin over 1e-3 — the loop's weakest
  // actual catch). The test as a whole still reliably fails under a wrap regression because
  // bins 11-13 and 15 all individually violate 1e-3, even though bins 10 and 14 wouldn't on
  // their own.
  /* Relative to the peak, not an absolute figure: the pitch drop now keeps the full level, so
     leakage scales with it. Measured after the scatter mapping: peak 4.0 at bin 3, then a
     monotonic fall to -61 dB at bin 10 and -82 dB at Nyquist. Wrapped energy would appear as
     a bump at bins 11-13 around -20 dB. */
  const peak = Math.max(...mag);
  for (let i = Math.ceil(n / 4) + 2; i < n / 2; i++) {
    const db = 20 * Math.log10(mag[i] / peak);
    assert.ok(db < -50,
      `bin ${i} sits at ${db.toFixed(1)} dB from the peak — expected leakage only, not wrapped energy`);
    assert.ok(mag[i + 1] <= mag[i],
      `bin ${i + 1} rises above bin ${i}: a bump in the vacated top is wrapped energy, not leakage`);
  }
});

test("synthesizeHop composes pitchRatio and warpBins in order: warpBins' own offset applies on top of the pitch-shifted spectrum, not instead of it", () => {
  const fft = extractFn("fft");
  const synthesizeHop = extractFn("synthesizeHop");
  const n = 64, k = 8, ratio = 0.5, shift = 2;
  const source = Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * k * i / n));
  const out = synthesizeHop(source, 0, n, shift, ratio, fft, () => 0.5);
  const outRe = out.slice(), outIm = new Array(n).fill(0);
  fft(outRe, outIm, false);
  const mag = outRe.map((r, i) => Math.sqrt(r * r + outIm[i] * outIm[i]));
  // Pitch-shifted bin is round(k*ratio) = 4; warpBins' own offset composes on top of THAT
  // (the pitch-shifted spectrum), landing the peak at 4 + shift = 6 — not at k + shift = 10
  // (which would mean warpBins was applied to the ORIGINAL spectrum instead, ignoring the
  // pitch shift), and not at just 4 (which would mean warpBins was silently dropped).
  //
  // Checked by direct magnitude comparison against those two specific wrong-hypothesis bins,
  // not global indexOf(max): a real-valued source's spectrum is symmetric (energy at both k
  // and n-k), and pitchRatio's lookup maps those two source bins to two DIFFERENT, unrelated
  // output locations once warpBins is folded in (not a simple mirror pair) — both are genuine
  // output peaks, and they can land within fractions of a percent of each other, so which one
  // is the single global argmax is not a meaningful test of composition order. Measured here:
  // mag[6]=3.85 vs the wrong-hypothesis bins at 0.014 and 0.004 — a 250x+ margin either way.
  const expected = Math.round(k * ratio) + shift;
  const pitchOnlyBin = Math.round(k * ratio);
  const warpOnOriginalBin = k + shift;
  const expectedMag = Math.max(mag[expected], mag[n - expected]);
  const pitchOnlyMag = Math.max(mag[pitchOnlyBin], mag[n - pitchOnlyBin]);
  const warpOnOriginalMag = Math.max(mag[warpOnOriginalBin], mag[n - warpOnOriginalBin]);
  /* 3x, not 10x: the scatter mapping spreads the cluster over two bins, and warp's additive
     shift leaves a mirror image at bins 2-3 whose leakage reaches bin 4. Measured: 3.34 at
     bin 6 against 0.96 at bin 4. Were warp dropped, bin 4 would hold 6.66 and bin 6 0.04. */
  assert.ok(expectedMag > pitchOnlyMag * 3,
    `composed bin ${expected} (mag ${expectedMag}) should dominate the pitch-only bin ` +
    `${pitchOnlyBin} (mag ${pitchOnlyMag}) — warpBins must not be silently dropped`);
  assert.ok(expectedMag > warpOnOriginalMag * 10,
    `composed bin ${expected} (mag ${expectedMag}) should dominate the warp-on-original bin ` +
    `${warpOnOriginalBin} (mag ${warpOnOriginalMag}) — warpBins must apply to the pitch-shifted ` +
    "spectrum, not the original");
});

test("_synthesizeOneHop passes this.params.pitchRatio through to synthesizeHop, not a hardcoded 1", () => {
  const Processor = loadPaulstretchProcessorClass();
  const proc = new Processor();
  proc.source = new Float32Array(4096).map((_, i) => Math.sin(2 * Math.PI * 10 * i / 64));
  proc.readPos = 0;
  proc.params.stretchFactor = 1;
  proc.params.warpBins = 0;
  proc.params.morphRate = 0;
  proc.params.synthesisHop = 1024;
  proc.params.windowSize = 64;
  proc.params.pitchRatio = 0.5;
  // No throw, finite output — the real assembled module (not a mock) accepting pitchRatio
  // end to end, through the exact params object ensureVoice/warpStep/commitLive will post to.
  proc._synthesizeOneHop();
  assert.ok(Number.isFinite(proc.readPos), "readPos went non-finite");
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
  assert.match(src, /createAudioWorkletNode\(\s*["']paulstretch-processor["']/);
  assert.match(src, /Tone\.connect\(\s*node\s*,\s*v\.grit\.input\s*\)/);
  assert.doesNotMatch(src, /_nativeAudioContext/);
  assert.doesNotMatch(src, /connectNativeToToneGain\(/);
  assert.doesNotMatch(src, /new AudioWorkletNode\(/);
});

test("the worklet node is created with a single output channel, so Tone up-mixes it to both sides", () => {
  /* process() writes one channel. Measured: created through Tone the node came up with a
     second, silent channel — the stretched sound 6 dB down and hard left. */
  const src = slice("function ensureVoice(z, d)", "\n  }\n");
  assert.match(src, /outputChannelCount:\s*\[\s*1\s*\]/);
});

test("ensureVoice awaits loadPaulstretchModule before creating the worklet node", () => {
  const src = slice("function ensureVoice(z, d)", "\n  }\n");
  const moduleCallIdx = src.indexOf("loadPaulstretchModule(");
  const nodeCtorIdx = src.indexOf("createAudioWorkletNode(");
  assert.ok(moduleCallIdx !== -1 && nodeCtorIdx !== -1 && moduleCallIdx < nodeCtorIdx,
    "the module must be registered before the node that names it is created");
});

test("loadPaulstretchModule registers through Tone's context, the same graph the node joins", () => {
  const src = slice("function loadPaulstretchModule(ctx)", "\n  }\n");
  assert.match(src, /addAudioWorkletModule\(\s*buildPaulstretchWorkletUrl\(\)\s*\)/);
});

test("synthesizeHop's pitch drop keeps the level: every source bin is scattered into the output, none discarded", () => {
  /* PaulXStretch's own spectrum_do_pitch_shift (ProcessedStretch.h:359) pitches down by
     scattering: each source bin i lands in output bin floor(i*ratio). Gathering one source bin
     per output bin instead discards (1 - ratio) of the spectrum — -6 dB at two octaves down,
     measured live as stretch 100 being far quieter than stretch 0 (A-18). */
  const fft = extractFn("fft");
  const synthesizeHop = extractFn("synthesizeHop");
  const n = 1024;
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const power = (a) => a.reduce((s, x) => s + x * x, 0);
  let p1 = 0, pQuarter = 0;
  for (let t = 0; t < 12; t++) {
    const source = Array.from({ length: n }, () => rand() * 2 - 1);
    p1 += power(synthesizeHop(source, 0, n, 0, 1, fft, rand));
    pQuarter += power(synthesizeHop(source, 0, n, 0, 0.25, fft, rand));
  }
  const dB = 10 * Math.log10(pQuarter / p1);
  assert.ok(Math.abs(dB) < 1.5,
    `two octaves down changed the frame's power by ${dB.toFixed(2)} dB — expected within 1.5 dB`);
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

/* ---------- Overlap-add gain: phase-randomised resynthesis loses real level ---------- */

test("the worklet's own overlap-add (writeBuf, via the real _synthesizeOneHop) stays close to unity gain at the default window/hop configuration, not the ~40-48% loss phase randomisation produces uncompensated", () => {
  // Phase-vocoder resynthesis with a FRESH RANDOM phase per hop (Paulstretch's own
  // defining trait) sums overlapping hops incoherently, not the way a phase-coherent STFT
  // reconstruction would — real Paulstretch (github.com/essej/paulxstretch,
  // Stretch.cpp:483, `REALTYPE ampfactor=2.0f`) applies a fixed compensation gain for
  // exactly this reason. Measured driving the real process() loop (128-sample blocks,
  // reading AND zeroing each sample exactly as production does — sampling writeBuf
  // directly without that read/zero step still gives a valid reading as long as the
  // buffer is large enough not to wrap mid-measurement, which is why this test's own
  // 30-hop run against the real 8-second writeBuf is safe; a SMALLER hand-rolled ring
  // buffer looped past its own length here would double-accumulate and read high, which
  // is exactly the mistake that produced an inflated live-browser reading during this
  // fix's own investigation), 10-trial average: an uncompensated overlap-add lands at
  // ~0.52x source RMS (~-5.6dB) — real and audible, matching what was actually heard
  // live as "stretch just gets faint," not a rounding artifact.
  const Processor = loadPaulstretchProcessorClass();
  const windowSize = 4096, synthesisHop = 1024, sr = 44100;
  const srcLen = sr * 4;
  const source = new Float32Array(srcLen);
  for (let i = 0; i < srcLen; i++) {
    source[i] = 0.4 * Math.sin(2 * Math.PI * 220 * i / sr) +
                0.3 * Math.sin(2 * Math.PI * 880 * i / sr) +
                0.2 * (Math.random() * 2 - 1);
  }
  let sumSq = 0;
  for (let i = 0; i < source.length; i++) { sumSq += source[i] * source[i]; }
  const srcRms = Math.sqrt(sumSq / source.length);

  const trials = 8, ratios = [];
  for (let t = 0; t < trials; t++) {
    const proc = new Processor();
    proc.source = source;
    proc.readPos = 0;
    proc.params.stretchFactor = 1;
    proc.params.warpBins = 0;
    proc.params.morphRate = 0;
    proc.params.synthesisHop = synthesisHop;
    proc.params.windowSize = windowSize;
    proc.params.pitchRatio = 1;
    for (let h = 0; h < 30; h++) { proc._synthesizeOneHop(); }
    // Sample the ring buffer directly (writeBuf), well into steady state, not the tail.
    const sampleStart = windowSize, sampleEnd = sampleStart + synthesisHop * 8;
    let s = 0, n = 0;
    for (let i = sampleStart; i < Math.min(sampleEnd, proc.writeBuf.length); i++) {
      s += proc.writeBuf[i] * proc.writeBuf[i]; n++;
    }
    ratios.push(Math.sqrt(s / n) / srcRms);
  }
  const mean = ratios.reduce((a, b) => a + b, 0) / trials;
  const dB = 20 * Math.log10(mean);
  assert.ok(mean > 0.85 && mean < 1.2,
    `overlap-add gain at default config is ${mean.toFixed(3)}x source RMS (${dB.toFixed(2)}dB) ` +
    "over 8 trials — expected close to unity (0.85-1.2x); phase-randomised overlap-add " +
    "needs a compensating gain the same way real Paulstretch applies one");
});

test("the overlap-add gain compensation stays safe: it doesn't push routine clipping past what the master bus's own limiter is meant to absorb as occasional peaks", () => {
  // Restoring the level (the test above) and staying safe are two separate properties —
  // the compensation factor could satisfy one and fail the other, so this checks the
  // clip rate independently rather than assuming "close to unity" also means "safe."
  // Driven through the real process() loop (proper read-and-zero, not a hand-rolled ring
  // buffer) so this reflects what actually reaches the master bus's Tone.Limiter(-1) —
  // A-6 — not a synthetic approximation of it.
  const Processor = loadPaulstretchProcessorClass();
  const windowSize = 4096, synthesisHop = 1024, sr = 44100;
  const trials = 6, clipPcts = [];
  for (let t = 0; t < trials; t++) {
    const proc = new Processor();
    const srcLen = sr * 2;
    const source = new Float32Array(srcLen);
    for (let i = 0; i < srcLen; i++) {
      source[i] = 0.4 * Math.sin(2 * Math.PI * 220 * i / sr) +
                  0.3 * Math.sin(2 * Math.PI * 880 * i / sr) +
                  0.2 * (Math.random() * 2 - 1);
    }
    proc.source = source;
    proc.readPos = 0;
    proc.params.stretchFactor = 1;
    proc.params.warpBins = 0;
    proc.params.morphRate = 0;
    proc.params.synthesisHop = synthesisHop;
    proc.params.windowSize = windowSize;
    proc.params.pitchRatio = 1;

    const blockSize = 128, totalSamples = sr * 1;
    let written = 0, clipCount = 0;
    const skip = Math.floor(sr * 0.3); // skip the fill-in transient before steady state
    while (written < totalSamples) {
      const outputs = [[new Float32Array(blockSize)]];
      proc.process([], outputs);
      const block = outputs[0][0];
      for (let i = 0; i < blockSize && written < totalSamples; i++, written++) {
        if (written >= skip && Math.abs(block[i]) > 1.0) { clipCount++; }
      }
    }
    clipPcts.push(100 * clipCount / (totalSamples - skip));
  }
  const meanClipPct = clipPcts.reduce((a, b) => a + b, 0) / trials;
  // 5% is well above the ~1% this fix's own factor measured at (real Paulstretch's own
  // ampfactor lands in the same ballpark for a different windowing) and well below where
  // limiting would stop reading as "occasional peaks" and start reading as routine
  // distortion — a regression that pushes the factor high enough to blow past this is a
  // real problem, not a rounding difference.
  assert.ok(meanClipPct < 5,
    `overlap-add pre-limiter clip rate is ${meanClipPct.toFixed(2)}% over ${trials} trials — ` +
    "expected under 5%; the compensation factor is pushing too much routine energy past " +
    "0dBFS for the master limiter to treat as occasional peaks rather than steady clipping");
});

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

/* ---------- Live cursor: the worklet reports its own real position ---------- */

test("process() posts its own read position back over the port, throttled rather than on every callback, so a live cursor doesn't flood the main thread", () => {
  const Processor = loadPaulstretchProcessorClass();
  const proc = new Processor();
  const posted = [];
  proc.port.postMessage = (msg) => posted.push(msg);
  proc.source = new Float32Array(50000).map((_, i) => Math.sin(i * 0.05));
  proc.params.stretchFactor = 1;
  proc.params.synthesisHop = 1024;
  proc.params.windowSize = 64;

  const blockSize = 128, callCount = 100; // 12800 samples total across many small callbacks
  for (let i = 0; i < callCount; i++) {
    proc.process([], [[new Float32Array(blockSize)]]);
  }

  const posMessages = posted.filter((m) => m.type === "pos");
  assert.ok(posMessages.length > 0, "process() never posted a position update");
  assert.ok(posMessages.length < callCount,
    "position updates must be throttled, not sent on every process() callback " +
    `(got ${posMessages.length} messages over ${callCount} callbacks)`);
  // Each message is a snapshot taken mid-stream, so it can't be compared to the FINAL
  // readPos after every callback has run (more advancing happens after the last message
  // fires) — instead confirm the messages themselves are real, moving snapshots: finite,
  // never past the processor's own eventual position, and advancing over time (not a
  // frozen 0 or a stale duplicate value).
  posMessages.forEach((m) => {
    assert.ok(Number.isFinite(m.readPos), `readPos ${m.readPos} is not finite`);
    assert.ok(m.readPos >= 0 && m.readPos <= proc.readPos,
      `readPos ${m.readPos} is outside [0, ${proc.readPos}]`);
    assert.equal(m.sourceLength, proc.source.length);
  });
  const first = posMessages[0], last = posMessages[posMessages.length - 1];
  assert.ok(last.readPos > first.readPos,
    "readPos must actually advance between the first and last reported snapshot");
});

test("process() posts no position update before a source has arrived", () => {
  const Processor = loadPaulstretchProcessorClass();
  const proc = new Processor();
  const posted = [];
  proc.port.postMessage = (msg) => posted.push(msg);
  for (let i = 0; i < 50; i++) { proc.process([], [[new Float32Array(128)]]); }
  assert.equal(posted.filter((m) => m.type === "pos").length, 0,
    "no source means nothing is playing — a position update here would be meaningless");
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

test("all three sites that post stretch params to the worklet (ensureVoice's ready branch, warpStep, commitLive) also post pitchRatio, derived from stretchPitchRatio", () => {
  const ensureVoiceSrc = slice("function ensureVoice(z, d)", "\n  }\n");
  const readyBranch = ensureVoiceSrc.slice(0, ensureVoiceSrc.indexOf("v = bed.voices[z.id] = { ready: false"));
  const warpStepSrc = slice("function warpStep(time)", "\n  }\n");
  const commitLiveSrc = slice("var commitLive = function ()", "\n    };\n");

  [["ensureVoice's ready branch", readyBranch], ["warpStep", warpStepSrc], ["commitLive", commitLiveSrc]]
    .forEach(([label, src]) => {
      assert.match(src, /pitchRatio:\s*stretchPitchRatio\(q\.stretch\)\.ratio/,
        `${label} must post pitchRatio: stretchPitchRatio(q.stretch).ratio alongside stretchFactor`);
    });
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

test("stretchPitchRatio: at stretch=0 there is no pitch shift at all", () => {
  const stretchPitchRatio = extractFn("stretchPitchRatio");
  const info = stretchPitchRatio(0);
  assert.equal(info.cents, 0);
  assert.equal(info.ratio, 1);
});

test("stretchPitchRatio: at stretch=1 pitch drops exactly two octaves (-2400 cents, ratio 0.25) — the capped amount, not tape-style pitch/stretchFactor", () => {
  const stretchPitchRatio = extractFn("stretchPitchRatio");
  const info = stretchPitchRatio(1);
  assert.equal(info.cents, -2400);
  assert.ok(Math.abs(info.ratio - 0.25) < 1e-9, `expected ratio ~0.25, got ${info.ratio}`);
});

test("stretchPitchRatio is linear in stretch between the two endpoints", () => {
  const stretchPitchRatio = extractFn("stretchPitchRatio");
  const info = stretchPitchRatio(0.5);
  assert.equal(info.cents, -1200);
  assert.ok(Math.abs(info.ratio - 0.5) < 1e-9, `expected ratio ~0.5 (one octave down), got ${info.ratio}`);
});

test("stretchPitchRatio clamps out-of-range stretch instead of producing NaN or an unbounded drop", () => {
  const stretchPitchRatio = extractFn("stretchPitchRatio");
  assert.equal(stretchPitchRatio(-1).cents, 0);
  assert.equal(stretchPitchRatio(5).cents, -2400);
  [NaN, undefined, -1, 5].forEach((s) => {
    const info = stretchPitchRatio(s);
    assert.ok(Number.isFinite(info.cents), `stretch=${s}: cents is not finite`);
    assert.ok(Number.isFinite(info.ratio), `stretch=${s}: ratio is not finite`);
  });
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
