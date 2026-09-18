# PaulXStretch Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the soundscape's phase-vocoder worklet with a faithful port of PaulXStretch's engine and spectral modules, with a panel that exposes them.

**Architecture:** All DSP moves out of `index.html` into one ES module, `src/paulx-worklet.js`, which is both the AudioWorklet (loaded with `addAudioWorkletModule`) and a plain module the Node tests import. Each DSP function is a port of a named function in github.com/essej/paulxstretch. The page keeps the Tone graph (grit → blend → proximity filter → gain) and only changes how it builds, feeds and parameterises the worklet node.

**Tech Stack:** Vanilla JS, Web Audio AudioWorklet, Tone.js 15 (graph only), node:test.

**Spec:** `docs/superpowers/specs/2026-09-18-paulxstretch-port-design.md`

## Global Constraints

- No build step: the deployed artifact is the static file set; `src/paulx-worklet.js` is served as-is.
- The worklet file is an ES module: no DOM, no `window`, no `performance`; `sampleRate` global only inside the processor class.
- A-2: no `.value =` on a live parameter; A-8 is superseded for the bed by Kerem's "always wet" (2026-09-18).
- A-18: level within 1.5 dB of the source across stretch ×1/×10/×100 and FFT 0.3/0.5/0.7, all modules at defaults.
- C-8: `document.documentElement.scrollHeight - innerHeight === 0` in desktop and phone layouts, plus a screenshot of each.
- Deviation allowed exactly once: pitch mapping sums power going down and scales `1/sqrt(ratio)` going up.
- Offline: `src/paulx-worklet.js` is in the service worker's `SHELL_FILES`.
- Tests: `npm test` (node --test), `npm run check` (HTML ids).

---

### Task 1: Spectral modules

**Files:**
- Create: `src/paulx-worklet.js`
- Test: `tests/paulx-modules.test.mjs`

**Interfaces:**
- Produces (exported): `pxProfile(fi, bwi)`, `pxSpread(nfreq, sr, tmp, f1, f2, bw)`, `pxCompressor(nfreq, f1, f2, power)`, `pxTonalVsNoise(nfreq, sr, tmp, f1, f2, bw, preserve)`, `pxHarmonics(nfreq, sr, tmp, f1, f2, freq, bwCents, n, gauss)`, `pxFreqShift(nfreq, sr, f1, f2, hz)`, `pxPitchShift(nfreq, f1, f2, ratio)`, `pxRatioMix(nfreq, f1, f2, tmp, sum, ratios, levels)`, `pxFilter(nfreq, sr, f1, f2, low, high, stop, hdamp)`, `PX_CHAIN`, `pxChainSteps(ws, nfreq, sr, p, freq)` (generator; `ws = {infreq, tmp, sum}` Float64Arrays of `nfreq`; `p.mods` shape below). All arrays are `Float64Array(nfreq)`; bin `i` is `i*sr/(2*nfreq)` Hz.

`p.mods` shape: `{ harmonics:{on,n,freq,bw,gauss}, tonal:{on,bw,preserve}, fshift:{on,hz}, pitch:{on,st}, ratios:{on,r:[8],l:[8]}, spread:{on,bw}, filter:{on,low,high,stop}, compress:{on,power} }`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/paulx-modules.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import * as PX from "../src/paulx-worklet.js";

const N = 1024, SR = 48000;
const arr = (f) => Float64Array.from({ length: N }, (_, i) => f(i));
const power = (a) => a.reduce((s, x) => s + x * x, 0);
const peak = (a) => a.indexOf(Math.max(...a));

test("pitch shift at ratio 1 is the identity", () => {
  const f1 = arr((i) => Math.abs(Math.sin(i))), f2 = new Float64Array(N);
  PX.pxPitchShift(N, f1, f2, 1);
  f1.forEach((v, i) => assert.ok(Math.abs(v - f2[i]) < 1e-12));
});

test("pitch shift moves a peak multiplicatively and keeps power within 1 dB both ways", () => {
  const f1 = arr((i) => (i === 200 ? 1 : 0.01)), down = new Float64Array(N), up = new Float64Array(N);
  PX.pxPitchShift(N, f1, down, 0.5);
  PX.pxPitchShift(N, f1, up, 2);
  assert.equal(peak(down), 100);
  assert.ok([399, 400, 401].includes(peak(up)));
  const noise = arr(() => Math.random());
  PX.pxPitchShift(N, noise, down, 0.25);
  PX.pxPitchShift(N, noise, up, 1.5);
  const p0 = power(noise);
  assert.ok(Math.abs(10 * Math.log10(power(down) / p0)) < 1, "down");
  assert.ok(Math.abs(10 * Math.log10(power(up) / p0)) < 1, "up");
});

test("frequency shift moves every bin by hz/(sr/2)*nfreq, truncated, and never wraps", () => {
  const f1 = arr((i) => (i === 100 ? 1 : 0)), f2 = new Float64Array(N);
  PX.pxFreqShift(N, SR, f1, f2, 1000);            // 1000/24000*1024 = 42.67 -> 42
  assert.equal(peak(f2), 142);
  PX.pxFreqShift(N, SR, f1, f2, -3000);           // -128 -> bin 100 falls below 0
  assert.equal(power(f2), 0);
});

test("filter passes [low, high) and stop inverts it", () => {
  const f1 = arr(() => 1), f2 = new Float64Array(N);
  PX.pxFilter(N, SR, f1, f2, 1000, 5000, false, 0);  // bins 42..213
  assert.equal(f2[41], 0); assert.equal(f2[42], 1); assert.equal(f2[212], 1); assert.equal(f2[213], 0);
  PX.pxFilter(N, SR, f1, f2, 5000, 1000, true, 0);   // swapped bounds, stop band
  assert.equal(f2[41], 1); assert.equal(f2[42], 0);
});

test("compressor scales by (rms*0.1)^-power, floored at 1e-3", () => {
  const f1 = arr(() => 100), f2 = new Float64Array(N);
  PX.pxCompressor(N, f1, f2, 0.5);                  // rms*0.1 = 10 -> factor 10^-0.5
  assert.ok(Math.abs(f2[5] - 100 * Math.pow(10, -0.5)) < 1e-9);
  PX.pxCompressor(N, f1, f2, 0);
  assert.equal(f2[5], 100);
});

test("harmonics keeps bins near multiples of the base and zeroes the rest (binary mask)", () => {
  const f1 = arr(() => 1), f2 = new Float64Array(N);
  f2.set(f1);
  PX.pxHarmonics(N, SR, new Float64Array(N), f1, f2, 1000, 200, 4, false);
  const bin = (hz) => Math.round(hz / (SR / 2) * N);
  [1000, 2000, 3000, 4000].forEach((hz) => assert.equal(f2[bin(hz)], 1, hz + " Hz kept"));
  assert.equal(f2[bin(1500)], 0);
  assert.equal(f2[bin(6000)], 0, "above n*base is removed");
});

test("tonal vs noise with preserve > 0 removes the smooth floor and keeps peaks", () => {
  const f1 = arr((i) => (i % 64 === 0 ? 50 : 1)), f2 = new Float64Array(N);
  PX.pxTonalVsNoise(N, SR, new Float64Array(N), f1, f2, 0.9, 0.5);
  assert.ok(f2[512] > 10, "a peak survives");
  assert.equal(f2[513], 0, "the floor between peaks is removed");
});

test("spread smooths a single spike into a wider shape", () => {
  const f1 = arr((i) => (i === 400 ? 1 : 0)), f2 = new Float64Array(N);
  PX.pxSpread(N, SR, new Float64Array(N), f1, f2, 0.5);
  const lit = f2.filter((v) => v > 1e-6).length;
  assert.ok(lit > 5, "energy spread over " + lit + " bins");
});

test("ratio mix at default levels (only ratio 1 at level 1) equals input / 1.01", () => {
  const f1 = arr((i) => Math.abs(Math.cos(i))), f2 = new Float64Array(N);
  PX.pxRatioMix(N, f1, f2, new Float64Array(N), new Float64Array(N),
    [0.25, 0.5, 1, 2, 3, 4, 1.5, 1 / 1.5], [0, 0, 1, 0, 0, 0, 0, 0]);
  f1.forEach((v, i) => assert.ok(Math.abs(f2[i] - v / 1.01) < 1e-12));
});

test("the chain runs enabled modules in PaulXStretch's order and skips disabled ones", () => {
  assert.deepEqual(PX.PX_CHAIN, ["harmonics", "tonal", "fshift", "pitch", "ratios", "spread", "filter", "compress"]);
  const ws = { infreq: new Float64Array(N), tmp: new Float64Array(N), sum: new Float64Array(N) };
  const freq = arr((i) => (i === 100 ? 1 : 0));
  const p = { mods: { fshift: { on: true, hz: 1000 }, pitch: { on: true, st: 12 }, filter: { on: false } } };
  for (const _ of PX.pxChainSteps(ws, N, SR, p, freq)) { /* drain */ }
  assert.ok([284, 285].includes(peak(freq)), "shift to 142 then up an octave: " + peak(freq));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/paulx-modules.test.mjs`
Expected: FAIL — `Cannot find module '../src/paulx-worklet.js'`.

- [ ] **Step 3: Implement**

```js
// src/paulx-worklet.js
/* FieldArc's port of PaulXStretch (github.com/essej/paulxstretch, GPL-2, Nasca Octavian Paul
   and Xenakios). One file, two jobs: the AudioWorklet module the page loads, and a plain ES
   module the Node tests import. Every function names what it ports. */

/* ProcessedStretch.h profile() */
export function pxProfile(fi, bwi) {
  var x = fi / bwi;
  x *= x;
  if (x > 14.71280603) { return 0; }
  return Math.exp(-x);
}

/* ProcessedStretch.h spectrum_spread(). f2 may be tmp itself, as Tonal vs Noise calls it —
   the aliasing is the original's, and is kept. */
export function pxSpread(nfreq, sr, tmp, f1, f2, bandwidth) {
  var minfreq = 20, maxfreq = 0.5 * sr, lmin = Math.log(minfreq), lmax = Math.log(maxfreq);
  var i, k, x, x0, x1, xp, y;
  for (i = 0; i < nfreq; i++) {
    x = Math.exp(lmin + (i / nfreq) * (lmax - lmin)) / maxfreq * nfreq;
    y = 0;
    x0 = Math.floor(x); if (x0 >= nfreq) { x0 = nfreq - 1; }
    x1 = x0 + 1; if (x1 >= nfreq) { x1 = nfreq - 1; }
    xp = x - x0;
    if (x < nfreq) { y = f1[x0] * (1 - xp) + f1[x1] * xp; }
    tmp[i] = y;
  }
  var n = 2, a = 1 - Math.pow(2, -bandwidth * bandwidth * 10);
  a = Math.pow(a, 8192 / nfreq * n);
  for (k = 0; k < n; k++) {
    tmp[0] = 0;
    for (i = 1; i < nfreq; i++) { tmp[i] = tmp[i - 1] * a + tmp[i] * (1 - a); }
    tmp[nfreq - 1] = 0;
    for (i = nfreq - 2; i > 0; i--) { tmp[i] = tmp[i + 1] * a + tmp[i] * (1 - a); }
  }
  f2[0] = 0;
  var ld = Math.log(maxfreq / minfreq);
  for (i = 1; i < nfreq; i++) {
    x = Math.log(((i / nfreq) * maxfreq) / minfreq) / ld * nfreq;
    y = 0;
    if (x > 0 && x < nfreq) {
      x0 = Math.floor(x); if (x0 >= nfreq) { x0 = nfreq - 1; }
      x1 = x0 + 1; if (x1 >= nfreq) { x1 = nfreq - 1; }
      xp = x - x0;
      y = tmp[x0] * (1 - xp) + tmp[x1] * xp;
    }
    f2[i] = y;
  }
}

/* ProcessedStretch.h spectrum_do_compressor() */
export function pxCompressor(nfreq, f1, f2, power) {
  var rms = 0, i;
  for (i = 0; i < nfreq; i++) { rms += f1[i] * f1[i]; }
  rms = Math.sqrt(rms / nfreq) * 0.1;
  if (rms < 1e-3) { rms = 1e-3; }
  var r = Math.pow(rms, -power);
  for (i = 0; i < nfreq; i++) { f2[i] = f1[i] * r; }
}

/* ProcessedStretch.h spectrum_do_tonal_vs_noise() */
export function pxTonalVsNoise(nfreq, sr, tmp, f1, f2, bandwidth, preserve) {
  pxSpread(nfreq, sr, tmp, f1, tmp, bandwidth);
  var i, x, s, r, mul;
  if (preserve >= 0) {
    mul = Math.pow(10, preserve) - 1;
    for (i = 0; i < nfreq; i++) {
      x = f1[i]; s = tmp[i] + 1e-6;
      r = x - s * mul;
      f2[i] = r < 0 ? 0 : r;
    }
  } else {
    mul = Math.pow(5, 1 + preserve) - 1;
    for (i = 0; i < nfreq; i++) {
      x = f1[i]; s = tmp[i] + 1e-6;
      r = x - s * mul + 0.1 * mul;
      f2[i] = r < 0 ? x : 0;
    }
  }
}

/* ProcessedStretch.h spectrum_do_harmonics(). The profile is exactly 0 past |fi|/bwi >
   3.8357 (sqrt of 14.71280603), so each harmonic only visits that window — the same result
   the original gets by visiting every bin. */
export function pxHarmonics(nfreq, sr, tmp, f1, f2, freq, bandwidth, nharmonics, gauss) {
  var i, nh, f, bwHz, bwi, fi, lo, hi, reach;
  if (freq < 10) { freq = 10; }
  for (i = 0; i < nfreq; i++) { tmp[i] = 0; }
  for (nh = 1; nh <= nharmonics; nh++) {
    f = nh * freq;
    if (f >= sr / 2) { break; }
    bwHz = (Math.pow(2, bandwidth / 1200) - 1) * f;
    bwi = bwHz / (2 * sr);
    fi = f / sr;
    reach = 3.8358 * bwi;
    lo = Math.max(1, Math.floor((fi - reach) * 2 * nfreq));
    hi = Math.min(nfreq - 1, Math.ceil((fi + reach) * 2 * nfreq));
    for (i = lo; i <= hi; i++) { tmp[i] += pxProfile((i / nfreq * 0.5) - fi, bwi); }
  }
  var max = 0;
  for (i = 1; i < nfreq; i++) { if (tmp[i] > max) { max = tmp[i]; } }
  if (max < 1e-8) { max = 1e-8; }
  for (i = 1; i < nfreq; i++) {
    var a = tmp[i] / max;
    if (!gauss) { a = a < 0.368 ? 0 : 1; }
    f2[i] = f1[i] * a;
  }
}

/* ProcessedStretch.h spectrum_do_freq_shift(); (int) truncates toward zero. */
export function pxFreqShift(nfreq, sr, f1, f2, hz) {
  var i, i2, ifreq = Math.trunc(hz / (sr * 0.5) * nfreq);
  for (i = 0; i < nfreq; i++) { f2[i] = 0; }
  for (i = 0; i < nfreq; i++) {
    i2 = ifreq + i;
    if (i2 > 0 && i2 < nfreq) { f2[i2] = f1[i]; }
  }
}

/* ProcessedStretch.h spectrum_do_pitch_shift(), with the spec's one deviation: the original
   sums magnitudes going down (+6 dB at two octaves) and duplicates bins going up. This sums
   power down and scales by 1/sqrt(ratio) up, so pitch never moves the level (A-18). */
export function pxPitchShift(nfreq, f1, f2, ratio) {
  var i, i2;
  for (i = 0; i < nfreq; i++) { f2[i] = 0; }
  if (ratio < 1) {
    for (i = 0; i < nfreq; i++) {
      i2 = Math.floor(i * ratio);
      if (i2 >= nfreq) { break; }
      f2[i2] += f1[i] * f1[i];
    }
    for (i = 0; i < nfreq; i++) { f2[i] = Math.sqrt(f2[i]); }
  } else {
    var inv = 1 / ratio, g = 1 / Math.sqrt(ratio);
    for (i = 0; i < nfreq; i++) { f2[i] = f1[Math.floor(i * inv)] * g; }
  }
}

/* ProcessedStretch.h spectrum_do_ratiomix() */
export function pxRatioMix(nfreq, f1, f2, tmp, sum, ratios, levels) {
  var i, k, lv, ra, total = 0.01;
  for (i = 0; i < nfreq; i++) { sum[i] = 0; }
  for (k = 0; k < ratios.length; k++) {
    lv = levels[k]; ra = ratios[k];
    total += lv;
    if (lv > 1e-3 && ra > 0) {
      pxPitchShift(nfreq, f1, tmp, ra);
      for (i = 0; i < nfreq; i++) { sum[i] += tmp[i] * lv; }
    }
  }
  if (total < 0.5) { total = 0.5; }
  for (i = 0; i < nfreq; i++) { f2[i] = sum[i] / total; }
}

/* ProcessedStretch.h spectrum_do_filter() */
export function pxFilter(nfreq, sr, f1, f2, low, high, stop, hdamp) {
  var lo = low, hi = high, i, a;
  if (!(low < high)) { lo = high; hi = low; }
  var ilow = Math.trunc(lo / sr * nfreq * 2), ihigh = Math.trunc(hi / sr * nfreq * 2);
  var dmp = 1, dmprap = 1 - Math.pow((hdamp || 0) * 0.5, 4);
  for (i = 0; i < nfreq; i++) {
    a = (i >= ilow && i < ihigh) ? 1 : 0;
    if (stop) { a = 1 - a; }
    f2[i] = f1[i] * a * dmp;
    dmp *= dmprap + 1e-8;
  }
}

/* ProcessedStretch::process_spectrum() with PaulXStretch's default module order (Free filter
   omitted). Each enabled module reads a copy and writes back into freq; bins a module does not
   write keep their value, as in the original. Yields after each module. */
export var PX_CHAIN = ["harmonics", "tonal", "fshift", "pitch", "ratios", "spread", "filter", "compress"];
export function* pxChainSteps(ws, nfreq, sr, p, freq) {
  var m = p.mods || {}, inf = ws.infreq, k, c;
  for (k = 0; k < PX_CHAIN.length; k++) {
    c = m[PX_CHAIN[k]];
    if (!c || !c.on) { continue; }
    inf.set(freq);
    switch (PX_CHAIN[k]) {
      case "harmonics": pxHarmonics(nfreq, sr, ws.tmp, inf, freq, c.freq, c.bw, c.n, c.gauss); break;
      case "tonal": pxTonalVsNoise(nfreq, sr, ws.tmp, inf, freq, c.bw, c.preserve); break;
      case "fshift": pxFreqShift(nfreq, sr, inf, freq, c.hz); break;
      case "pitch": pxPitchShift(nfreq, inf, freq, Math.pow(2, c.st / 12)); break;
      case "ratios": pxRatioMix(nfreq, inf, freq, ws.tmp, ws.sum, c.r, c.l); break;
      case "spread": pxSpread(nfreq, sr, ws.tmp, inf, freq, c.bw); break;
      case "filter": pxFilter(nfreq, sr, inf, freq, c.low, c.high, c.stop, 0); break;
      case "compress": pxCompressor(nfreq, inf, freq, c.power); break;
    }
    yield;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/paulx-modules.test.mjs` — Expected: 10 pass.

- [ ] **Step 5: Commit** — `git add src/paulx-worklet.js tests/paulx-modules.test.mjs && git commit -m "Port PaulXStretch's spectral modules"`

---

### Task 2: The engine — window, FFT steps, reader, stretcher

**Files:**
- Modify: `src/paulx-worklet.js` (append)
- Test: `tests/paulx-engine.test.mjs`

**Interfaces:**
- Consumes: `pxChainSteps`, `PX_CHAIN` (Task 1).
- Produces (exported): `pxHamming(n)`, `pxFftSteps(re, im, inverse)` (generator; in place; inverse divides by n), `pxOnset(bufsize, sr, now, old, sens)`, `pxOutputHop(bufsize, cur, old, out)`, `PxRng(seed)` with `.phase()` and `.unit()`, `PxReader(data, sr)` with `.setRange(start, end, xfadeS)`, `.next()`, `.read(out)`, `.skip(n)`, `.pos`, `.s0`, `.s1`; `PxStretcher(bufsize, sr, seed)` with `.prime(reader)` and generator `.hopJob(reader, p, out)` returning the onset value; `pxRun(gen)` drains a generator and returns `{ value, steps }`.
- `p` (engine params): `{ stretch, freeze, onset, morph, field, warpHz, mods }`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/paulx-engine.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import * as PX from "../src/paulx-worklet.js";

const SR = 48000;
const rms = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);
const db = (x) => 20 * Math.log10(x);
function source(seconds) {
  const n = Math.round(SR * seconds), s = new Float32Array(n);
  let seed = 3;
  for (let i = 0; i < n; i++) {
    seed = (seed * 16807) % 2147483647;
    s[i] = 0.3 * Math.sin(2 * Math.PI * 440 * i / SR) + 0.15 * Math.sin(2 * Math.PI * 1320 * i / SR) + 0.1 * (seed / 2147483647 * 2 - 1);
  }
  return s;
}
const defaults = () => ({ stretch: 1, freeze: false, onset: 0, morph: 0, field: 0, warpHz: 0,
  mods: { fshift: { on: true, hz: 0 }, pitch: { on: true, st: 0 } } });
function render(bufsize, p, hops, src = source(6)) {
  const rd = new PX.PxReader(src, SR), st = new PX.PxStretcher(bufsize, SR, 7);
  rd.setRange(0, 1, 0.01);
  st.prime(rd);
  const out = [], hop = new Float64Array(bufsize);
  for (let h = 0; h < hops; h++) { PX.pxRun(st.hopJob(rd, p, hop)); out.push(...hop); }
  return { out: Float64Array.from(out), rd, st, src };
}

test("the FFT round-trips and matches a direct DFT bin", () => {
  const n = 64, re = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.3) + i / n), im = new Float64Array(n);
  const orig = re.slice();
  PX.pxRun(PX.pxFftSteps(re, im, false));
  let dr = 0, di = 0; for (let i = 0; i < n; i++) { dr += orig[i] * Math.cos(-2 * Math.PI * 5 * i / n); di += orig[i] * Math.sin(-2 * Math.PI * 5 * i / n); }
  assert.ok(Math.abs(re[5] - dr) < 1e-9 && Math.abs(im[5] - di) < 1e-9);
  PX.pxRun(PX.pxFftSteps(re, im, true));
  orig.forEach((v, i) => assert.ok(Math.abs(re[i] - v) < 1e-9));
});

test("the FFT yields often enough to be spread across render quanta", () => {
  const n = 65536, { steps } = PX.pxRun(PX.pxFftSteps(new Float64Array(n), new Float64Array(n), false));
  assert.ok(steps >= 16, "only " + steps + " yields for a 65536-point FFT");
});

test("the Hamming window is PaulXStretch's (0.53836 - 0.46164 cos(2 pi i/(N+1)))", () => {
  const w = PX.pxHamming(8);
  assert.ok(Math.abs(w[3] - (0.53836 - 0.46164 * Math.cos(2 * Math.PI * 3 / 9))) < 1e-12);
});

test("at stretch x1 the engine plays at the source's speed and level", () => {
  const b = 2048, { out, rd } = render(b, defaults(), 120);
  const steady = out.slice(4 * b);
  const d = db(rms(steady) / rms(source(6)));
  assert.ok(Math.abs(d) < 1.5, "level " + d.toFixed(2) + " dB");
  assert.equal(rd.pos, 122 * b, "three primed chunks, then one per hop from the second hop on");
});

test("level holds within 1.5 dB at x10 and x100, and at three FFT sizes (A-18)", () => {
  for (const [b, stretch] of [[1024, 10], [4096, 10], [16384, 100], [2048, 100]]) {
    const p = Object.assign(defaults(), { stretch });
    const { out } = render(b, p, Math.max(40, Math.ceil(SR * 3 / b)));
    const d = db(rms(out.slice(4 * b)) / rms(source(6)));
    assert.ok(Math.abs(d) < 1.5, `bufsize ${b} x${stretch}: ${d.toFixed(2)} dB`);
  }
});

test("the read position advances bufsize/stretch per hop", () => {
  const b = 1024, p = Object.assign(defaults(), { stretch: 8 });
  const { rd } = render(b, p, 64);
  assert.equal(rd.pos, 3 * b + 7 * b, "64 hops at x8: reads on hops 9, 17 … 57");
});

test("freeze stops the read position and keeps sounding", () => {
  const b = 1024, p = Object.assign(defaults(), { stretch: 1 });
  const rd = new PX.PxReader(source(6), SR), st = new PX.PxStretcher(b, SR, 1), hop = new Float64Array(b);
  rd.setRange(0, 1, 0);
  st.prime(rd);
  for (let h = 0; h < 10; h++) { PX.pxRun(st.hopJob(rd, p, hop)); }
  p.freeze = true;
  const at = rd.pos;
  let sound = 0;
  for (let h = 0; h < 20; h++) { PX.pxRun(st.hopJob(rd, p, hop)); sound += rms(hop); }
  assert.equal(rd.pos, at);
  assert.ok(sound / 20 > 0.05, "frozen output is not silent");
});

test("a detected onset snaps to a new chunk and repays the time with credit", () => {
  const b = 1024, src = new Float32Array(SR * 4);
  for (let i = SR; i < SR * 4; i++) { src[i] = 0.5 * Math.sin(2 * Math.PI * 300 * i / SR); }   // silence, then a hit
  const p = Object.assign(defaults(), { stretch: 50, onset: 0.8 });
  const rd = new PX.PxReader(src, SR), st = new PX.PxStretcher(b, SR, 2), hop = new Float64Array(b);
  rd.setRange(0, 1, 0);
  st.prime(rd);
  let fired = false;
  for (let h = 0; h < 4000 && !fired; h++) { const r = PX.pxRun(st.hopJob(rd, p, hop)); if (r.value > 0.5) { fired = true; } }
  assert.ok(fired, "the transient at 1 s was detected");
  assert.ok(st.credit > 0, "time credit is owed after the snap");
});

test("the reader loops within [start, end) and crossfades the seam", () => {
  const data = Float32Array.from({ length: 1000 }, (_, i) => i);
  const rd = new PX.PxReader(data, 1000);
  rd.setRange(0.2, 0.6, 0.05);             // s0 200, s1 600, xf 50
  assert.equal(rd.pos, 200);
  const seen = []; for (let i = 0; i < 450; i++) { seen.push(rd.next()); }
  assert.equal(seen[0], 200);
  assert.ok(Math.abs(seen[375] - (575 * 0.5 + 225 * 0.5)) < 1e-9, "midway through the seam");
  assert.equal(seen[400], 250, "after the seam, playback resumes past the faded-in head");
});

test("field jitter and warp change the output without changing the level by more than 1.5 dB", () => {
  const b = 2048;
  const base = render(b, Object.assign(defaults(), { stretch: 4 }), 60).out.slice(4 * b);
  const extra = render(b, Object.assign(defaults(), { stretch: 4, field: 1, warpHz: 150 }), 60).out.slice(4 * b);
  assert.ok(Math.abs(db(rms(extra) / rms(base))) < 1.5);
  assert.notDeepEqual(Array.from(extra.slice(0, 64)), Array.from(base.slice(0, 64)));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/paulx-engine.test.mjs` — Expected: FAIL, `PX.pxRun is not a function`.

- [ ] **Step 3: Implement (append to `src/paulx-worklet.js`)**

```js
/* Drains a generator; the worklet steps the same generators a few at a time instead. */
export function pxRun(gen) {
  var r, steps = 0;
  do { r = gen.next(); steps++; } while (!r.done);
  return { value: r.value, steps: steps };
}

/* Stretch.cpp FFT::applywindow W_HAMMING — the plugin's windowing type 1. */
export function pxHamming(n) {
  var w = new Float64Array(n);
  for (var i = 0; i < n; i++) { w[i] = 0.53836 - 0.46164 * Math.cos(2 * Math.PI * i / (n + 1)); }
  return w;
}

/* Radix-2 complex FFT, in place, forward unnormalised like FFTW, inverse divided by n (the
   original's HC2R followed by 1/nsamples). Twiddles come from a per-size table; it yields
   every 4096 butterflies so a 65536-point transform spreads over many render quanta. */
var pxTwiddles = {};
function pxTwiddle(n) {
  var t = pxTwiddles[n];
  if (!t) {
    t = { c: new Float64Array(n / 2), s: new Float64Array(n / 2) };
    for (var k = 0; k < n / 2; k++) { t.c[k] = Math.cos(2 * Math.PI * k / n); t.s[k] = Math.sin(2 * Math.PI * k / n); }
    pxTwiddles[n] = t;
  }
  return t;
}
export function* pxFftSteps(re, im, inverse) {
  var n = re.length, i, j, bit, t, len, half, step, start, k, tw = pxTwiddle(n), ops = 0;
  var sgn = inverse ? 1 : -1, cr, ci, ur, ui, vr, vi, a, b;
  for (i = 1, j = 0; i < n; i++) {
    bit = n >> 1;
    for (; j & bit; bit >>= 1) { j ^= bit; }
    j ^= bit;
    if (i < j) { t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  yield;
  for (len = 2; len <= n; len <<= 1) {
    half = len >> 1; step = n / len;
    for (start = 0; start < n; start += len) {
      for (k = 0; k < half; k++) {
        cr = tw.c[k * step]; ci = sgn * tw.s[k * step];
        a = start + k; b = a + half;
        vr = re[b] * cr - im[b] * ci; vi = re[b] * ci + im[b] * cr;
        ur = re[a]; ui = im[a];
        re[a] = ur + vr; im[a] = ui + vi;
        re[b] = ur - vr; im[b] = ui - vi;
      }
      ops += half;
      if (ops >= 4096) { ops = 0; yield; }
    }
  }
  if (inverse) { for (i = 0; i < n; i++) { re[i] /= n; im[i] /= n; } }
}

/* Stretch::do_detect_onset(). osincold is never reset inside the loop — as in the original. */
export function pxOnset(bufsize, sr, now, old, sens) {
  if (!(sens > 1e-3)) { return 0; }
  var os = 0, osinc = 0, osincold = 1e-5, maxk = 1 + Math.trunc(bufsize * 500 / (sr * 0.5)), k = 0, i;
  for (i = 0; i < bufsize; i++) {
    osinc += now[i] - old[i];
    osincold += old[i];
    if (k >= maxk) { k = 0; os += osinc / osincold; osinc = 0; }
    k++;
  }
  os += osinc;
  if (os < 0) { os = 0; }
  var st = Math.pow(20, 1 - sens) - 1, sth = st * 0.75, r = 0;
  if (os > sth) { r = (os - sth) / (st - sth); if (r > 1) { r = 1; } }
  return r;
}

/* Stretch::process() "make the output buffer": the new frame's second half crossfaded with
   the previous frame's first half, the dip of two uncorrelated signals at the midpoint
   corrected, and ampfactor 2. */
export function pxOutputHop(bufsize, cur, old, out) {
  var t = Math.PI / bufsize, h = 0.853553390593, i, a, o;
  for (i = 0; i < bufsize; i++) {
    a = 0.5 + 0.5 * Math.cos(i * t);
    o = cur[i + bufsize] * (1 - a) + old[i] * a;
    out[i] = o * (h - (1 - h) * Math.cos(i * 2 * t)) * 2;
  }
}

/* The original draws each phase as a 16-bit integer times pi/16384; a seeded xorshift makes the
   tests reproducible. */
export function PxRng(seed) { this.s = (seed >>> 0) || 1; }
PxRng.prototype.next = function () {
  var x = this.s;
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
  this.s = x >>> 0;
  return this.s;
};
PxRng.prototype.phase = function () { return (this.next() & 32767) * (Math.PI / 16384); };
PxRng.prototype.unit = function () { return this.next() / 4294967296; };

/* The input file with the plugin's play range and loop crossfade. Over the last xf samples
   before `end` the tail fades out under the head [start, start+xf), and playback resumes at
   start+xf, so the loop has no seam. */
export function PxReader(data, sr) { this.data = data; this.sr = sr; this.pos = 0; this.s0 = 0; this.s1 = data.length; this.xf = 0; }
PxReader.prototype.setRange = function (start, end, xfadeS) {
  var len = this.data.length, a = Math.max(0, Math.min(1, start)), b = Math.max(0, Math.min(1, end)), t;
  if (b < a) { t = a; a = b; b = t; }
  var s0 = Math.floor(a * len), s1 = Math.min(len, Math.max(s0 + 1, Math.floor(b * len)));
  if (s0 >= s1) { s0 = Math.max(0, s1 - 1); }
  this.s0 = s0; this.s1 = s1;
  this.xf = Math.max(0, Math.min(Math.floor((xfadeS || 0) * this.sr), Math.floor((s1 - s0) / 2)));
  if (this.pos < s0 || this.pos >= s1) { this.pos = s0; }
};
PxReader.prototype.next = function () {
  var p = this.pos, d = this.data, v = d[p], z = this.s1 - this.xf;
  if (this.xf > 0 && p >= z) { var t = (p - z) / this.xf; v = v * (1 - t) + d[this.s0 + (p - z)] * t; }
  p++;
  if (p >= this.s1) { p = this.s0 + this.xf; }
  this.pos = p;
  return v;
};
PxReader.prototype.read = function (out) { for (var i = 0; i < out.length; i++) { out[i] = this.next(); } };
PxReader.prototype.skip = function (n) { for (var i = 0; i < n; i++) { this.next(); } };

/* Stretch: the three-chunk input window, the fractional start, skip and onset credit, freeze.
   bufsize is PaulXStretch's "FFT size" (the hop); the FFT itself is 2*bufsize. */
export function PxStretcher(bufsize, sr, seed) {
  var N = 2 * bufsize;
  this.bufsize = bufsize; this.sr = sr; this.N = N;
  this.win = pxHamming(N);
  this.veryOld = new Float64Array(bufsize); this.old = new Float64Array(bufsize);
  this.nw = new Float64Array(bufsize); this.chunk = new Float64Array(bufsize);
  this.inFreq = new Float64Array(bufsize); this.oldFreq = new Float64Array(bufsize);
  this.freq = new Float64Array(bufsize);
  this.re = new Float64Array(N); this.im = new Float64Array(N);
  this.oldOut = new Float64Array(N);
  this.ws = { infreq: new Float64Array(bufsize), tmp: new Float64Array(bufsize), sum: new Float64Array(bufsize) };
  this.rng = new PxRng(seed); this.jit = new PxRng((seed ^ 0x9e3779b9) >>> 0);
  this.remained = 0; this.requireNew = false; this.skip = 0; this.credit = 0; this.inFreqValid = false;
}

/* Stretch::do_analyse_inbuf(): the spectrum of [old | smps], used only for onset detection. */
PxStretcher.prototype.analyse = function* (a, b, dst) {
  var n = this.bufsize, re = this.re, im = this.im, w = this.win, i;
  for (i = 0; i < n; i++) { re[i] = a[i] * w[i]; re[i + n] = b[i] * w[i + n]; }
  for (i = 0; i < this.N; i++) { im[i] = 0; }
  yield* pxFftSteps(re, im, false);
  dst[0] = 0;
  for (i = 1; i < n; i++) { dst[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]); }
};

/* get_nsamples_for_fill(): three chunks, so a high stretch starts on sound, not on zeros. */
PxStretcher.prototype.prime = function (reader) {
  for (var k = 0; k < 3; k++) {
    reader.read(this.chunk);
    this.veryOld.set(this.old); this.old.set(this.nw); this.nw.set(this.chunk);
  }
  this.remained = 0; this.requireNew = false; this.skip = 0; this.credit = 0; this.inFreqValid = false;
};

PxStretcher.prototype.hopJob = function* (reader, p, out) {
  var b = this.bufsize, N = this.N, re = this.re, im = this.im, w = this.win, f = this.freq, i, onset = 0;
  if (!p.freeze && this.requireNew) {
    if (this.skip) { reader.skip(this.skip); }
    reader.read(this.chunk);
    if (p.onset > 1e-3) {
      this.oldFreq.set(this.inFreq);
      yield* this.analyse(this.old, this.chunk, this.inFreq);
      if (this.inFreqValid) { onset = pxOnset(b, this.sr, this.inFreq, this.oldFreq, p.onset); }
      this.inFreqValid = true;
    } else {
      this.inFreqValid = false;
    }
    this.veryOld.set(this.old); this.old.set(this.nw); this.nw.set(this.chunk);
  }
  var start = Math.floor(this.remained * b);
  if (start >= b) { start = b - 1; }
  /* FieldArc extra "field": the analysis frame wanders around its true position. */
  if (p.field > 0) {
    start += Math.round((this.jit.unit() - 0.5) * p.field * b);
    start = Math.max(0, Math.min(b - 1, start));
  }
  for (i = 0; i < b - start; i++) { re[i] = this.veryOld[i + start]; }
  for (i = 0; i < b; i++) { re[b - start + i] = this.old[i]; }
  for (i = 0; i < start; i++) { re[2 * b - start + i] = this.nw[i]; }
  for (i = 0; i < N; i++) { re[i] *= w[i]; im[i] = 0; }
  yield* pxFftSteps(re, im, false);
  f[0] = 0;
  for (i = 1; i < b; i++) { f[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]); }
  yield* pxChainSteps(this.ws, b, this.sr, p, f);
  /* FieldArc extra "warp": the whole spectrum drifts by a few Hz, empty bins left empty. */
  var shift = Math.round((p.warpHz || 0) / (this.sr / N));
  if (shift) {
    var tmp = this.ws.tmp;
    tmp.set(f);
    for (i = 1; i < b; i++) { var s = i - shift; f[i] = (s >= 1 && s < b) ? tmp[s] : 0; }
  }
  /* FFT::freq2smp(): random phase on bins 1..b-1, DC and Nyquist zero, real output. The
     original's FFTW layout also zeroes the imaginary part of bin b-1; kept. */
  re[0] = 0; im[0] = 0; re[b] = 0; im[b] = 0;
  for (i = 1; i < b; i++) {
    var ph = this.rng.phase(), m = f[i];
    re[i] = m * Math.cos(ph); im[i] = m * Math.sin(ph);
  }
  im[b - 1] = 0;
  for (i = 1; i < b; i++) { re[N - i] = re[i]; im[N - i] = -im[i]; }
  yield* pxFftSteps(re, im, true);
  pxOutputHop(b, re, this.oldOut, out);
  this.oldOut.set(re);
  if (!p.freeze) {
    var r = (1 + (p.morph || 0)) / Math.max(1, p.stretch);
    if (this.credit > 0) {
      var cg = 0.5 * r;
      this.credit -= cg; if (this.credit < 0) { this.credit = 0; }
      r -= cg;
    }
    this.remained += r;
    if (this.remained >= 1) {
      this.skip = Math.floor(this.remained - 1) * b;
      this.remained -= Math.floor(this.remained);
      this.requireNew = true;
    } else {
      this.requireNew = false;
    }
    /* Stretch::here_is_onset() */
    if (onset > 0.5) { this.requireNew = true; this.credit += 1 - this.remained; this.remained = 0; this.skip = 0; }
  }
  return onset;
};
```

- [ ] **Step 4: Run** `node --test tests/paulx-engine.test.mjs` — Expected: all pass. If the level tests fail by a constant offset across all four configurations, measure it, add `var PX_MAKEUP = <measured>` multiplying `out[i]` in `pxOutputHop`, and record the measurement in its comment. A spread of more than 1 dB between configurations is a bug, not a calibration.

- [ ] **Step 5: Commit** — `git commit -m "Port PaulXStretch's engine: window, stepping, onset, freeze, output crossfade"`

---

### Task 3: The processor — stepped jobs, stereo, binaural, parameter rebuilds

**Files:**
- Modify: `src/paulx-worklet.js` (append)
- Test: `tests/paulx-processor.test.mjs`

**Interfaces:**
- Consumes: Task 2 exports.
- Produces: `PxBinaural(sr)` with `.process(L, R, bb)` where `bb = {power, hz, mode}`; registered processor name **`"paulx-processor"`**. Messages in: `{type:"source", channels:[Float32Array, Float32Array?]}`, `{type:"params", params}` where `params = {stretch, bufsize, freeze, onset, start, end, xfade, morph, field, warpHz, mods, binaural:{on,power,hz,mode}}`. Message out: `{type:"pos", readPos, sourceLength}` every 2048 samples.

- [ ] **Step 1: Write the failing tests**

```js
// tests/paulx-processor.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

let Proc = null;
globalThis.sampleRate = 48000;
globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage() {}, onmessage: null }; } };
globalThis.registerProcessor = (name, cls) => { if (name === "paulx-processor") { Proc = cls; } };
const PX = await import("../src/paulx-worklet.js");

const SR = 48000;
const params = (o = {}) => Object.assign({ stretch: 1, bufsize: 2048, freeze: false, onset: 0, start: 0, end: 1, xfade: 0.01,
  morph: 0, field: 0, warpHz: 0, mods: { fshift: { on: true, hz: 0 }, pitch: { on: true, st: 0 } },
  binaural: { on: false, power: 0.5, hz: 4, mode: 0 } }, o);
const tone = (n, f) => Float32Array.from({ length: n }, (_, i) => 0.3 * Math.sin(2 * Math.PI * f * i / SR));
function run(p, quanta, left = tone(SR * 4, 440), right = null) {
  const pr = new Proc();
  pr.port.onmessage({ data: { type: "params", params: p } });
  pr.port.onmessage({ data: { type: "source", channels: right ? [left, right] : [left] } });
  const L = [], R = [];
  for (let q = 0; q < quanta; q++) {
    const out = [[new Float32Array(128), new Float32Array(128)]];
    pr.process([], out);
    L.push(...out[0][0]); R.push(...out[0][1]);
  }
  return { pr, L: Float32Array.from(L), R: Float32Array.from(R) };
}
const rms = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);

test("the processor registers as paulx-processor and fills both channels", () => {
  assert.ok(Proc);
  const { L, R } = run(params(), 400);
  assert.ok(rms(L.slice(20000)) > 0.05);
  assert.deepEqual(Array.from(R.slice(20000, 20100)), Array.from(L.slice(20000, 20100)), "mono source: R mirrors L");
});

test("a stereo source gets two stretchers with independent phase", () => {
  const { L, R } = run(params(), 400, tone(SR * 4, 440), tone(SR * 4, 440));
  let diff = 0; for (let i = 20000; i < 30000; i++) { diff += Math.abs(L[i] - R[i]); }
  assert.ok(diff > 1, "identical channels would mean shared phase");
});

test("no single render quantum runs a whole hop of work once the job is spread", () => {
  const { pr } = run(params({ bufsize: 16384 }), 600);
  const s = pr.ch[0];
  assert.ok(s.est > 20, "a 16384 hop is many steps: " + s.est);
  assert.ok(s.budget < s.est / 4, "budget " + s.budget + " of " + s.est + " steps per quantum");
});

test("changing the FFT size rebuilds without a click: output ramps through zero", () => {
  const pr = new Proc();
  pr.port.onmessage({ data: { type: "params", params: params() } });
  pr.port.onmessage({ data: { type: "source", channels: [tone(SR * 4, 440)] } });
  const q = () => { const o = [[new Float32Array(128), new Float32Array(128)]]; pr.process([], o); return o[0][0]; };
  for (let i = 0; i < 300; i++) { q(); }
  pr.port.onmessage({ data: { type: "params", params: params({ bufsize: 4096 }) } });
  let maxStep = 0, prev = 0;
  for (let i = 0; i < 60; i++) { for (const v of q()) { maxStep = Math.max(maxStep, Math.abs(v - prev)); prev = v; } }
  assert.equal(pr.ch[0].st.bufsize, 4096);
  assert.ok(maxStep < 0.2, "largest sample-to-sample jump " + maxStep);
});

test("binaural beats: left moves down and right up by half the beat frequency", () => {
  const bb = new PX.PxBinaural(SR), n = SR;
  const L = tone(n, 1000), R = tone(n, 1000);
  bb.process(L, R, { power: 0, hz: 20, mode: 0 });
  const zc = (a) => { let c = 0; for (let i = 1000; i < a.length; i++) { if (a[i - 1] <= 0 && a[i] > 0) { c++; } } return c * SR / (a.length - 1000); };
  assert.ok(Math.abs(zc(L) - 990) < 3, "left " + zc(L));
  assert.ok(Math.abs(zc(R) - 1010) < 3, "right " + zc(R));
});

test("the processor reports its read position, throttled", () => {
  const pr = new Proc(), sent = [];
  pr.port.postMessage = (m) => sent.push(m);
  pr.port.onmessage({ data: { type: "params", params: params() } });
  pr.port.onmessage({ data: { type: "source", channels: [tone(SR * 4, 440)] } });
  for (let i = 0; i < 64; i++) { pr.process([], [[new Float32Array(128), new Float32Array(128)]]); }
  const pos = sent.filter((m) => m.type === "pos");
  assert.equal(pos.length, 4);
  assert.equal(pos[0].sourceLength, SR * 4);
});
```

- [ ] **Step 2: Run** `node --test tests/paulx-processor.test.mjs` — Expected: FAIL (`Proc` undefined).

- [ ] **Step 3: Implement (append)**

```js
/* BinauralBeats.h AP / Hilbert and BinauralBeats::process(). Runs only when enabled, as the
   original's free_edit.get_enabled() gate. */
var PX_HL = [0.6923877778065, 0.9360654322959, 0.9882295226860, 0.9987488452737];
var PX_HR = [0.4021921162426, 0.8561710882420, 0.9722909545651, 0.9952884791278];
function PxAllpass(a) { this.a = a * a; this.i1 = 0; this.i2 = 0; this.o1 = 0; this.o2 = 0; }
PxAllpass.prototype.run = function (x) {
  var o = this.a * (x + this.o2) - this.i2;
  this.i2 = this.i1; this.i1 = x; this.o2 = this.o1; this.o1 = o;
  return o;
};
function PxHilbert() {
  this.l = PX_HL.map(function (a) { return new PxAllpass(a); });
  this.r = PX_HR.map(function (a) { return new PxAllpass(a); });
  this.old = 0; this.h1 = 0; this.h2 = 0;
}
PxHilbert.prototype.run = function (x) {
  var a = this.old, b = x;
  for (var k = 0; k < 4; k++) { a = this.l[k].run(a); b = this.r[k].run(b); }
  this.old = x; this.h1 = a; this.h2 = b;
};
export function PxBinaural(sr) { this.sr = sr; this.t = 0; this.hl = new PxHilbert(); this.hr = new PxHilbert(); }
PxBinaural.prototype.process = function (L, R, bb) {
  var n = L.length, mono = bb.power * 0.5, freq = bb.hz * 0.5, i, l, r, x, c, s, ol1, ol2, or1, or2;
  for (i = 0; i < n; i++) { l = L[i]; r = R[i]; L[i] = l * (1 - mono) + r * mono; R[i] = r * (1 - mono) + l * mono; }
  for (i = 0; i < n; i++) {
    this.t = (this.t + freq / this.sr) % 1;
    x = this.t * 2 * Math.PI; c = Math.cos(x); s = Math.sin(x);
    this.hl.run(L[i]); ol1 = this.hl.h1 * c + this.hl.h2 * s; ol2 = this.hl.h1 * c - this.hl.h2 * s;
    this.hr.run(R[i]); or1 = this.hr.h1 * c - this.hr.h2 * s; or2 = this.hr.h1 * c + this.hr.h2 * s;
    if (bb.mode === 1) { L[i] = ol1; R[i] = or1; }
    else if (bb.mode === 2) { L[i] = (ol1 + or1) * 0.5; R[i] = (ol2 + or2) * 0.5; }
    else { L[i] = ol2; R[i] = or2; }
  }
};

if (typeof AudioWorkletProcessor !== "undefined") {
  /* The next hop is computed while the current one plays: a job stepped a budget of times per
     128-sample quantum, sized from how many steps the last hop took so it ends inside the hop.
     A quantum that reaches the boundary first drains the job — a late frame, never a gap. */
  class PxProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.p = null; this.src = null; this.ch = [];
      this.gain = 1; this.rebuild = false; this.posCount = 0;
      this.bb = new PxBinaural(sampleRate);
      this.port.onmessage = (e) => this.onMsg(e.data);
    }
    onMsg(d) {
      if (d.type === "source") { this.src = d.channels; this.build(); return; }
      if (d.type !== "params") { return; }
      var prev = this.p;
      this.p = d.params;
      if (!this.ch.length) { if (this.src) { this.build(); } return; }
      if (prev && prev.bufsize !== this.p.bufsize) { this.rebuild = true; }
      for (var c = 0; c < this.ch.length; c++) { this.ch[c].rd.setRange(this.p.start, this.p.end, this.p.xfade); }
    }
    build() {
      if (!this.p || !this.src) { return; }
      var b = this.p.bufsize, p = this.p;
      this.ch = this.src.map(function (data, k) {
        var rd = new PxReader(data, sampleRate);
        rd.setRange(p.start, p.end, p.xfade);
        var st = new PxStretcher(b, sampleRate, 0x5eed + k * 7919);
        st.prime(rd);
        var s = { rd: rd, st: st, cur: new Float64Array(b), nxt: new Float64Array(b), idx: 0, job: null, steps: 0, est: 0, budget: 1 };
        s.est = pxRun(st.hopJob(rd, p, s.cur)).steps;
        s.job = st.hopJob(rd, p, s.nxt);
        return s;
      });
    }
    swap(s) {
      while (s.job && !s.job.next().done) { s.steps++; }
      if (s.steps) { s.est = s.steps + 1; }
      var t = s.cur; s.cur = s.nxt; s.nxt = t; s.idx = 0; s.steps = 0;
      s.job = s.st.hopJob(s.rd, this.p, s.nxt);
    }
    process(inputs, outputs) {
      var out = outputs[0], L = out[0], R = out[1], n = L.length, i, c, s;
      if (!this.ch.length) { L.fill(0); if (R) { R.fill(0); } return true; }
      for (c = 0; c < this.ch.length; c++) {
        s = this.ch[c];
        var dst = c === 0 ? L : R, b = s.st.bufsize;
        if (!dst) { continue; }
        for (i = 0; i < n; i++) {
          if (s.idx >= b) { this.swap(s); }
          dst[i] = s.cur[s.idx++];
        }
        s.budget = Math.ceil(s.est * n / b * 1.5) + 1;
        for (var k = 0; k < s.budget && s.job; k++) {
          if (s.job.next().done) { s.job = null; } else { s.steps++; }
        }
      }
      if (this.ch.length === 1 && R) { R.set(L); }
      if (R && this.p.binaural && this.p.binaural.on) { this.bb.process(L, R, this.p.binaural); }
      /* An FFT-size change rebuilds the stretchers: fade out over 256 samples, rebuild, and
         let the new stretcher's own priming bring the sound back. */
      for (i = 0; i < n; i++) {
        var target = this.rebuild ? 0 : 1;
        this.gain += (target - this.gain) / 256 * 4;
        if (this.rebuild && this.gain < 1e-3) { this.gain = 0; this.rebuild = false; this.build(); }
        L[i] *= this.gain; if (R) { R[i] *= this.gain; }
      }
      this.posCount += n;
      if (this.posCount >= 2048) {
        this.posCount = 0;
        this.port.postMessage({ type: "pos", readPos: this.ch[0].rd.pos, sourceLength: this.ch[0].rd.data.length });
      }
      return true;
    }
  }
  registerProcessor("paulx-processor", PxProcessor);
}
```

Note for the implementer: `this.gain` approaches its target exponentially with a time constant of 64 samples, so the fade to below 1e-3 takes ~440 samples; after `build()` it rises from 0 over the same span while the new stretcher's first frames are already crossfading in from zeros.

- [ ] **Step 4: Run** `node --test tests/paulx-processor.test.mjs` — Expected: 6 pass.

- [ ] **Step 5: Commit** — `git commit -m "PaulXStretch processor: stepped jobs, stereo stretchers, binaural beats"`

---

### Task 4: Wire the page to the new worklet

**Files:**
- Modify: `index.html` — `soundOf` (~line 7890), `ensureVoice` (~7735), `warpStep` (~8155), `renderSoundscapePanel`'s `commitLive` (~5552), `stretchedDurationInfo` (~5427), `loadPaulstretchModule` (~8142); delete `stretchPitchRatio`, `synthesizeHop`, `buildPaulstretchWorkletUrl`.
- Modify: `sw.js` — add `"./src/paulx-worklet.js"` to `SHELL_FILES`.
- Modify: `tests/paulstretch.test.mjs` — delete tests of removed functions (listed below); keep and retarget the integration ones.
- Test: `tests/paulx-page.test.mjs`

**Interfaces:**
- Produces: `pxDefaults()` → the `q.px` object; `pxBufsize(fft)` → `2^round(7+10*fft)`; `pxParams(q, v)` → the processor's `params` message; migration in `soundOf`.

`q.px` defaults (from PluginProcessor.cpp): `{ v:1, fft:0.7, freeze:false, onset:0, start:0, end:1, xfade:0.01, harmonics:{on:false,n:10,freq:128,bw:25,gauss:false}, tonal:{on:false,bw:0.74,preserve:0.5}, fshift:{on:true,hz:0}, pitch:{on:true,st:0}, ratios:{on:false,r:[0.25,0.5,1,2,3,4,1.5,1/1.5],l:[0,0,1,0,0,0,0,0]}, spread:{on:false,bw:0}, filter:{on:false,low:20,high:20000,stop:false}, compress:{on:false,power:0}, binaural:{on:false,power:0.5,hz:4,mode:0} }`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/paulx-page.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8").replace(/\r\n/g, "\n");
const sw = readFileSync("sw.js", "utf8");
function body(name) {
  const start = html.indexOf("function " + name + "(");
  assert.ok(start !== -1, "missing " + name);
  let i = html.indexOf("{", html.indexOf(")", start)), d = 0; const from = i;
  for (; i < html.length; i++) { if (html[i] === "{") d++; else if (html[i] === "}") { d--; if (!d) break; } }
  return { params: html.slice(start + name.length + 10, html.indexOf(")", start)), src: html.slice(from + 1, i) };
}
const fn = (name) => { const b = body(name); return new Function(b.params, b.src); };

test("pxBufsize maps the FFT-size knob exactly as PaulXStretch: 0.70 -> 16384", () => {
  const pxBufsize = fn("pxBufsize");
  assert.equal(pxBufsize(0.7), 16384);
  assert.equal(pxBufsize(0), 128);
  assert.equal(pxBufsize(1), 131072);
});

test("a point saved before the port keeps its stretch factor: 200^s becomes 1024^s'", () => {
  const src = body("soundOf").src;
  assert.match(src, /Math\.log\(200\) \/ Math\.log\(1024\)/);
  assert.match(src, /pxDefaults\(\)/);
});

test("the page loads the worklet from src/paulx-worklet.js through Tone's context", () => {
  assert.match(body("loadPaulstretchModule").src, /addAudioWorkletModule\("src\/paulx-worklet\.js"\)/);
  assert.match(body("ensureVoice").src, /createAudioWorkletNode\("paulx-processor"/);
  assert.match(body("ensureVoice").src, /outputChannelCount:\s*\[2\]/);
});

test("both channels of a stereo recording reach the worklet", () => {
  assert.match(body("ensureVoice").src, /numberOfChannels/);
});

test("every site that posts params uses pxParams, so there is one writer (A-9)", () => {
  ["ensureVoice", "warpStep"].forEach((n) => assert.match(body(n).src, /pxParams\(q, v\)/, n));
  const panel = body("renderSoundscapePanel").src;
  assert.match(panel, /pxParams\(q, v\)/);
});

test("stretch no longer drives pitch", () => {
  assert.equal(html.indexOf("function stretchPitchRatio("), -1);
  assert.equal(html.indexOf("function synthesizeHop("), -1);
  assert.equal(html.indexOf("function buildPaulstretchWorkletUrl("), -1);
});

test("the stretched-length readout uses 1024^s and the play range", () => {
  const f = fn("stretchedDurationInfo");
  const info = f(10, 1, 0, 0.25, 0.75);
  assert.equal(info.factor, 1024);
  assert.equal(info.seconds, 5 * 1024);
});

test("the worklet is precached for offline walks", () => {
  assert.match(sw, /"\.\/src\/paulx-worklet\.js"/);
});
```

- [ ] **Step 2: Run** — Expected: FAIL on every test.

- [ ] **Step 3: Implement**

Add near `soundOf`:

```js
  /* PaulXStretch's defaults (PluginProcessor.cpp). Frequency and pitch shift start enabled at
     zero, as in the plugin; every other module starts off. */
  function pxDefaults() {
    return { v: 1, fft: 0.7, freeze: false, onset: 0, start: 0, end: 1, xfade: 0.01,
      harmonics: { on: false, n: 10, freq: 128, bw: 25, gauss: false },
      tonal: { on: false, bw: 0.74, preserve: 0.5 },
      fshift: { on: true, hz: 0 },
      pitch: { on: true, st: 0 },
      ratios: { on: false, r: [0.25, 0.5, 1, 2, 3, 4, 1.5, 1 / 1.5], l: [0, 0, 1, 0, 0, 0, 0, 0] },
      spread: { on: false, bw: 0 },
      filter: { on: false, low: 20, high: 20000, stop: false },
      compress: { on: false, power: 0 },
      binaural: { on: false, power: 0.5, hz: 4, mode: 0 } };
  }

  /* setFFTSize() without prebuffering: 2^(7 + 10x), rounded to a power of two for the FFT. */
  function pxBufsize(fft) {
    return Math.pow(2, Math.round(7 + 10 * Math.max(0, Math.min(1, fft || 0))));
  }

  function pxParams(q, v) {
    var x = q.px;
    return {
      stretch: Math.pow(1024, Math.max(0, Math.min(1, q.stretch || 0))),
      bufsize: pxBufsize(x.fft), freeze: !!x.freeze, onset: x.onset,
      start: x.start, end: x.end, xfade: x.xfade,
      morph: q.morph || 0, field: q.field || 0, warpHz: (v && v._warpHz) || 0,
      mods: { harmonics: x.harmonics, tonal: x.tonal, fshift: x.fshift, pitch: x.pitch,
              ratios: x.ratios, spread: x.spread, filter: x.filter, compress: x.compress },
      binaural: x.binaural
    };
  }
```

In `soundOf`, after the existing `q.grit` default:

```js
    /* The PaulXStretch port. Stretch moved from 200^s to the original's 1024^s range, so a
       point saved before keeps the factor it had: s' = s * ln200 / ln1024. Its pitch drop is
       gone — pitch is its own control now (Kerem, 2026-09-18). */
    if (!q.px) {
      q.stretch = q.stretch * Math.log(200) / Math.log(1024);
      q.px = pxDefaults();
    }
```

`stretchedDurationInfo` becomes:

```js
  function stretchedDurationInfo(durationS, stretch, morph, start, end) {
    var factor = Math.pow(1024, Math.max(0, Math.min(1, stretch || 0)));
    var a = start === undefined ? 0 : start, b = end === undefined ? 1 : end;
    var span = Math.abs(b - a);
    var seconds = (durationS || 0) * span * factor / (1 + Math.max(0, morph || 0));
    return { factor: factor, seconds: seconds };
  }
```

`loadPaulstretchModule`:

```js
  var paulstretchModulePromise = null;
  function loadPaulstretchModule(ctx) {
    if (!paulstretchModulePromise) {
      paulstretchModulePromise = ctx.addAudioWorkletModule("src/paulx-worklet.js");
    }
    return paulstretchModulePromise;
  }
```

In `ensureVoice`'s worklet `.then`, replace the mono copy and node creation with:

```js
          var channels = [];
          for (var ci = 0; ci < Math.min(2, audioBuffer.numberOfChannels); ci++) {
            var copy = new Float32Array(audioBuffer.length);
            copy.set(audioBuffer.getChannelData(ci));
            channels.push(copy);
          }
          var node = tctx.createAudioWorkletNode("paulx-processor",
            { numberOfInputs: 0, outputChannelCount: [2] });
```

then post params before the source, and transfer every channel:

```js
          node.port.postMessage({ type: "params", params: pxParams(q, v) });
          node.port.postMessage({ type: "source", channels: channels },
            channels.map(function (c) { return c.buffer; }));
```

In the existing-voice branch of `ensureVoice`, in `warpStep` and in `commitLive`, replace each params literal with `pxParams(q, v)`. `warpStep`'s random walk becomes Hz:

```js
      if (q.warp > 0) {
        v._warpHz = Math.max(-300, Math.min(300, (v._warpHz || 0) + (Math.random() * 2 - 1) * q.warp * 40));
      } else {
        v._warpHz = 0;
      }
      v.stretch.node.port.postMessage({ type: "params", params: pxParams(q, v) });
```

Delete `stretchPitchRatio`, `synthesizeHop`, `buildPaulstretchWorkletUrl` and the `paulstretchWorkletUrl` variable. In `updateWaveCaption`, drop the pitch sentence and pass `q.px.start, q.px.end`.

`sw.js`: add `"./src/paulx-worklet.js",` after `"./src/pending.mjs",`.

`tests/paulstretch.test.mjs`: delete every test whose name starts with `synthesizeHop`, `fft forward`, `fft of a pure`, `fft is linear`, `_synthesizeOneHop`, `buildPaulstretchWorkletUrl`, `the worklet module never`, `the worklet's process()`, `the worklet's own overlap-add`, `the overlap-add gain`, `process() posts`, `synthesisHop is clamped`, `stretchPitchRatio`, `all three sites that post`, `stretchedDurationInfo`, and the helper functions `extractRawFnSource`, `buildWorkletModuleSource`, `loadPaulstretchProcessorClass`, `extractSynthesisHopFn`. Change `createAudioWorkletNode(\s*["']paulstretch-processor["']` to `paulx-processor` and `outputChannelCount:\s*\[\s*1\s*\]` to `\[\s*2\s*\]` in the remaining tests.

- [ ] **Step 4: Run** `npm test && npm run check` — Expected: all pass.

- [ ] **Step 5: Commit** — `git commit -m "Feed the soundscape to the PaulXStretch worklet; stretch no longer drops pitch"`

---

### Task 5: The panel

**Files:**
- Modify: `index.html` — `renderSoundscapePanel`, `soundscapeWaveDraw` (range shading), CSS after `.ppwave`.
- Test: `tests/paulx-panel.test.mjs`

**Interfaces:**
- Consumes: `pxDefaults`, `pxBufsize`, `pxParams`, `stretchedDurationInfo(duration, stretch, morph, start, end)`.
- Produces: `buildPxRow(spec, obj, commit)` → `.pprow` element; `spec = {k, label, min, max, step, def, fmt(value) -> string, log?}`; `buildPxToggle(label, obj, key, commit)`; `buildPxModule(title, obj, rows, commit)` → section with a power toggle bound to `obj.on`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/paulx-panel.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8").replace(/\r\n/g, "\n");
function src(name) {
  const s = html.indexOf("function " + name + "(");
  assert.ok(s !== -1, "missing " + name);
  let i = html.indexOf("{", html.indexOf(")", s)), d = 0; const from = i;
  for (; i < html.length; i++) { if (html[i] === "{") d++; else if (html[i] === "}") { d--; if (!d) break; } }
  return html.slice(from + 1, i);
}

test("the panel has the three sections and every PaulXStretch control", () => {
  const p = src("renderSoundscapePanel");
  ["Stretch", "Spectrum", "Ratios", "Binaural beats", "Extras"].forEach((h) => assert.match(p, new RegExp('"' + h + '"')));
  ["Harmonics", "Tonal vs noise", "Frequency shift", "Pitch shift", "Spread", "Filter", "Compressor"]
    .forEach((m) => assert.match(p, new RegExp('buildPxModule\\("' + m + '"')));
  ["fft", "onset", "start", "end", "xfade"].forEach((k) => assert.match(p, new RegExp('k: "' + k + '"')));
  assert.match(p, /buildPxToggle\("freeze"/);
});

test("readouts are in real units", () => {
  const p = src("renderSoundscapePanel");
  assert.match(p, /" Hz"/); assert.match(p, /" st"/); assert.match(p, /" ¢"/); assert.match(p, /"×"/); assert.match(p, /" %"/);
});

test("a module heading is a real toggle bound to .on", () => {
  const m = src("buildPxModule");
  assert.match(m, /aria-pressed/);
  assert.match(m, /obj\.on = !obj\.on/);
});

test("rows declare data-def, so the global double-click reset and shift-fine drag apply", () => {
  assert.match(src("buildPxRow"), /dataset\.def/);
});

test("narrow or short screens get tabs, not a scrolling panel (C-8, mobile tabs)", () => {
  const p = src("renderSoundscapePanel");
  assert.match(p, /role", "tablist"|setAttribute\("role", "tablist"\)/);
  assert.match(p, /innerWidth < 1000 \|\| innerHeight < 700/);
});
```

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement**

Row and module builders (next to `buildSoundRow`):

```js
  /* A PaulXStretch control. `log` sliders move in log space so 20 Hz-20 kHz is usable; the
     readout is always the real unit. */
  function buildPxRow(fl, obj, commit) {
    var row = document.createElement("label");
    row.className = "pprow";
    var name = document.createElement("span");
    name.textContent = fl.label;
    if (fl.hint) { row.title = fl.hint; }
    var input = document.createElement("input"), val = document.createElement("i");
    input.type = "range";
    var toUi = function (v) { return fl.log ? Math.log(v) : v; };
    var fromUi = function (u) { return fl.log ? Math.exp(u) : u; };
    input.min = toUi(fl.min); input.max = toUi(fl.max);
    input.step = fl.log ? "any" : fl.step;
    input.value = toUi(fl.get ? fl.get(obj) : obj[fl.k]);
    input.dataset.def = toUi(fl.def);
    input.title = (fl.hint || "") + " · double-click to reset · shift-drag for fine steps";
    var show = function () { val.textContent = fl.fmt(fromUi(+input.value)); };
    show();
    input.addEventListener("input", function () {
      var v = fromUi(+input.value);
      if (fl.set) { fl.set(obj, v); } else { obj[fl.k] = v; }
      show(); commit();
    });
    row.appendChild(name); row.appendChild(input); row.appendChild(val);
    return row;
  }

  function buildPxToggle(label, obj, key, commit) {
    var row = document.createElement("div");
    row.className = "pprow";
    var name = document.createElement("span"); name.textContent = label;
    var b = document.createElement("button");
    b.type = "button"; b.className = "ghost";
    var set = function () { b.setAttribute("aria-pressed", String(!!obj[key])); b.textContent = obj[key] ? "on" : "off"; };
    set();
    b.addEventListener("click", function () { obj[key] = !obj[key]; set(); commit(); });
    row.appendChild(name); row.appendChild(b); row.appendChild(document.createElement("i"));
    return row;
  }

  /* A module in the chain: its heading is its power switch, as in PaulXStretch. Off, its
     controls stay editable and dim, so a setting can be dialled in before it is heard. */
  function buildPxModule(title, obj, rows, commit) {
    var box = document.createElement("section");
    box.className = "pxmod";
    var h = document.createElement("h2");
    var b = document.createElement("button");
    b.type = "button"; b.className = "pxpower";
    b.textContent = title;
    var set = function () { b.setAttribute("aria-pressed", String(!!obj.on)); box.classList.toggle("off", !obj.on); };
    set();
    b.addEventListener("click", function () { obj.on = !obj.on; set(); commit(); });
    h.appendChild(b);
    box.appendChild(h);
    rows.forEach(function (r) { box.appendChild(r); });
    return box;
  }
```

Formatters (inside `renderSoundscapePanel`):

```js
    var fx = {
      x: function (v) { return "×" + (v >= 10 ? Math.round(v) : v.toFixed(1)); },
      hz: function (v) { return (v >= 1000 ? (v / 1000).toFixed(1) + " k" : Math.round(v) + " ") + "Hz"; },
      st: function (v) { return (v > 0 ? "+" : "") + v.toFixed(1) + " st"; },
      pct: function (v) { return Math.round(v * 100) + " %"; },
      two: function (v) { return v.toFixed(2); },
      sec: function (v) { return v.toFixed(2) + " s"; },
      int: function (v) { return String(Math.round(v)); }
    };
```

Sections (replacing the current `cols` block; `commitLive` is the existing function, now posting `pxParams(q, v)`):

```js
    var x = q.px;
    var colStretch = [
      buildPxRow({ label: "stretch", k: "stretch", min: 0, max: 1, step: 0.005, def: 0,
        fmt: function (v) { return fx.x(Math.pow(1024, v)); }, hint: "×1 plays at the recording's speed; ×1024 is PaulXStretch's maximum" }, q, commitLive),
      buildPxRow({ label: "fft size", k: "fft", min: 0, max: 1, step: 0.01, def: 0.7,
        fmt: function (v) { return String(pxBufsize(v)); }, hint: "hop in samples; the window is twice this — larger is smoother and slower to react" }, x, commitLive),
      buildPxRow({ label: "onset", k: "onset", min: 0, max: 1, step: 0.01, def: 0, fmt: fx.two,
        hint: "lets transients through: a detected attack jumps ahead and the time is paid back after" }, x, commitLive),
      buildPxToggle("freeze", x, "freeze", commitLive),
      buildPxRow({ label: "start", k: "start", min: 0, max: 1, step: 0.001, def: 0, fmt: fx.pct }, x, commitLive),
      buildPxRow({ label: "end", k: "end", min: 0, max: 1, step: 0.001, def: 1, fmt: fx.pct }, x, commitLive),
      buildPxRow({ label: "loop xfade", k: "xfade", min: 0, max: 1, step: 0.001, def: 0.01, fmt: fx.sec }, x, commitLive)
    ];
    var colExtras = [
      buildPxRow({ label: "warp", k: "warp", min: 0, max: 1, step: 0.02, def: 0, fmt: fx.two, hint: "the whole spectrum drifts up to ±300 Hz, slowly" }, q, commitLive),
      buildPxRow({ label: "morph", k: "morph", min: 0, max: 1, step: 0.02, def: 0, fmt: fx.two, hint: "reads through the recording faster than the stretch alone" }, q, commitLive),
      buildPxRow({ label: "field", k: "field", min: 0, max: 1, step: 0.02, def: 0, fmt: fx.two, hint: "each frame is taken from a wandering position around the true one" }, q, commitLive),
      buildPxRow({ label: "grit", k: "grit", min: 0, max: 1, step: 0.02, def: 0, fmt: fx.two, hint: "bitcrush and drive on the stretched signal" }, q, commitLive)
    ];
    var colSpectrum = [
      buildPxModule("Harmonics", x.harmonics, [
        buildPxRow({ label: "count", k: "n", min: 1, max: 100, step: 1, def: 10, fmt: fx.int }, x.harmonics, commitLive),
        buildPxRow({ label: "base", k: "freq", min: 1, max: 5000, step: 0.1, def: 128, log: true, fmt: fx.hz }, x.harmonics, commitLive),
        buildPxRow({ label: "bandwidth", k: "bw", min: 0.1, max: 200, step: 0.01, def: 25, fmt: function (v) { return v.toFixed(1) + " ¢"; } }, x.harmonics, commitLive),
        buildPxToggle("gaussian", x.harmonics, "gauss", commitLive)
      ], commitLive),
      buildPxModule("Tonal vs noise", x.tonal, [
        buildPxRow({ label: "bandwidth", k: "bw", min: 0.74, max: 1, step: 0.001, def: 0.74, fmt: fx.two }, x.tonal, commitLive),
        buildPxRow({ label: "preserve", k: "preserve", min: -1, max: 1, step: 0.001, def: 0.5, fmt: fx.two, hint: "above 0 keeps the tones, below 0 keeps the noise" }, x.tonal, commitLive)
      ], commitLive),
      buildPxModule("Frequency shift", x.fshift, [
        buildPxRow({ label: "shift", k: "hz", min: -1000, max: 1000, step: 1, def: 0, fmt: fx.hz }, x.fshift, commitLive)
      ], commitLive),
      buildPxModule("Pitch shift", x.pitch, [
        buildPxRow({ label: "pitch", k: "st", min: -24, max: 24, step: 0.1, def: 0, fmt: fx.st }, x.pitch, commitLive)
      ], commitLive),
      buildPxModule("Spread", x.spread, [
        buildPxRow({ label: "spread", k: "bw", min: 0, max: 1, step: 0.001, def: 0, fmt: fx.two }, x.spread, commitLive)
      ], commitLive),
      buildPxModule("Filter", x.filter, [
        buildPxRow({ label: "low", k: "low", min: 20, max: 20000, def: 20, log: true, fmt: fx.hz }, x.filter, commitLive),
        buildPxRow({ label: "high", k: "high", min: 20, max: 20000, def: 20000, log: true, fmt: fx.hz }, x.filter, commitLive),
        buildPxToggle("stop band", x.filter, "stop", commitLive)
      ], commitLive),
      buildPxModule("Compressor", x.compress, [
        buildPxRow({ label: "amount", k: "power", min: 0, max: 1, step: 0.001, def: 0, fmt: fx.two }, x.compress, commitLive)
      ], commitLive)
    ];
    var ratioRows = x.ratios.r.map(function (_, i) {
      var row = document.createElement("div");
      row.className = "pxratio";
      row.appendChild(buildPxRow({ label: String(i + 1), min: 0.125, max: 8, def: [0.25, 0.5, 1, 2, 3, 4, 1.5, 1 / 1.5][i], log: true,
        get: function (o) { return o.r[i]; }, set: function (o, v) { o.r[i] = v; },
        fmt: function (v) { return "×" + v.toFixed(2); } }, x.ratios, commitLive));
      row.appendChild(buildPxRow({ label: "level", min: 0, max: 1, step: 0.001, def: i === 2 ? 1 : 0,
        get: function (o) { return o.l[i]; }, set: function (o, v) { o.l[i] = v; }, fmt: fx.two }, x.ratios, commitLive));
      return row;
    });
    var colRatios = [
      buildPxModule("Ratios", x.ratios, ratioRows, commitLive),
      buildPxModule("Binaural beats", x.binaural, [
        buildPxRow({ label: "power", k: "power", min: 0, max: 1, step: 0.01, def: 0.5, fmt: fx.two }, x.binaural, commitLive),
        buildPxRow({ label: "beat", k: "hz", min: 0.05, max: 50, def: 4, log: true, fmt: function (v) { return v.toFixed(2) + " Hz"; } }, x.binaural, commitLive),
        buildPxSelect("mode", x.binaural, "mode", ["left-right", "right-left", "symmetric"], commitLive)
      ], commitLive)
    ];
```

`buildPxSelect(label, obj, key, names, commit)` builds a `.pprow` with a `<select>` whose option values are indices and writes `obj[key] = +select.value`.

Layout: one grid for wide-and-tall screens, tabs otherwise. Every section heading string used below (`"Stretch"`, `"Extras"`, `"Spectrum"`, `"Ratios"`, `"Binaural beats"`) is the literal text.

```js
    var sections = [
      { title: "Stretch", nodes: [heading("Stretch")].concat(colStretch, [heading("Extras")], colExtras) },
      { title: "Spectrum", nodes: [heading("Spectrum"), chainNote()].concat(colSpectrum) },
      { title: "Ratios & binaural", nodes: colRatios }
    ];
    var tabbed = innerWidth < 1000 || innerHeight < 700;
    var cols = document.createElement("div");
    cols.className = "ppcols";
    cols.style.setProperty("--ppcols", tabbed ? 1 : 3);
    var panes = sections.map(function (s) {
      var col = document.createElement("div");
      col.className = "ppcol";
      s.nodes.forEach(function (n) { col.appendChild(n); });
      cols.appendChild(col);
      return col;
    });
    if (tabbed) {
      var tabs = document.createElement("div");
      tabs.className = "pptabs";
      tabs.setAttribute("role", "tablist");
      var pick = function (k) {
        panes.forEach(function (p, i) { p.hidden = i !== k; });
        Array.prototype.forEach.call(tabs.children, function (t, i) { t.setAttribute("aria-selected", String(i === k)); });
        pxTab = k;
      };
      sections.forEach(function (s, i) {
        var t = document.createElement("button");
        t.type = "button"; t.setAttribute("role", "tab"); t.textContent = s.title;
        t.addEventListener("click", function () { pick(i); });
        tabs.appendChild(t);
      });
      body.appendChild(tabs);
      pick(pxTab || 0);
    }
    body.appendChild(cols);
```

with `var pxTab = 0;` at file scope beside `swRAF`, `heading(t)` returning an `h2` with `textContent = t`, and `chainNote()` returning a `p.hint` reading "Applied in order: harmonics → tonal/noise → frequency → pitch → ratios → spread → filter → compressor."

CSS (after `.ppwave`):

```css
.pxmod { margin-bottom: var(--s-2); }
.pxmod.off .pprow { opacity: 0.45; }
.pxmod h2 { margin: var(--s-2) 0 var(--s-1); }
.pxpower {
  width: 100%; text-align: left; padding: 2px 0 2px 1.4rem; border: 0; position: relative;
  font-family: var(--font-mono); font-size: var(--t-xs); letter-spacing: var(--track-eyebrow);
  text-transform: uppercase; color: var(--faint); background: transparent;
}
.pxpower::before {
  content: ""; position: absolute; left: 0.2rem; top: 50%; width: 0.6rem; height: 0.6rem;
  margin-top: -0.3rem; border-radius: 50%; border: 1px solid var(--faint);
}
.pxpower[aria-pressed="true"] { color: var(--ink); }
.pxpower[aria-pressed="true"]::before { background: var(--lamp); border-color: var(--lamp); }
.pxpower:hover { color: var(--ink); }
.pxpower:focus-visible { outline: 2px solid var(--lamp); outline-offset: 1px; }
.pxratio { display: grid; grid-template-columns: 1fr 1fr; gap: 0 var(--s-2); }
.pxratio .pprow { grid-template-columns: 2.4rem 1fr 3.2rem; }
.pptabs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0;
  border: 1px solid var(--bdr); border-radius: 2px; overflow: hidden; margin: var(--s-2) 0; }
.pptabs button { border: 0; border-radius: 0; }
.pptabs button + button { border-left: 1px solid var(--bdr); }
.pptabs button[aria-selected="true"] { color: var(--sunk); background: var(--accent); }
```

`soundscapeWaveDraw`: after painting, dim outside the range —

```js
    var x0 = (q.px.start || 0) * w, x1 = (q.px.end === undefined ? 1 : q.px.end) * w;
    ctx.fillStyle = "rgba(10,14,12,0.6)";
    ctx.fillRect(0, 0, Math.min(x0, x1), h);
    ctx.fillRect(Math.max(x0, x1), 0, w - Math.max(x0, x1), h);
```

and `smoothedPeaksForStretch(peaks, q.stretch)` keeps its argument.

Replace the panel's closing `note` with: "Always heard through the PaulXStretch engine. Stretch ×1 plays at the recording's own speed with randomised phase; the Spectrum chain and Ratios act on every frame; Extras are FieldArc's own."

- [ ] **Step 4: Run** `npm test && npm run check` — Expected: all pass.

- [ ] **Step 5: Commit** — `git commit -m "The soundscape panel exposes PaulXStretch's controls"`

---

### Task 6: Measure it in the browser, then ship

**Files:** none new; measurement harness in the session scratchpad.

- [ ] **Step 1: Level and timbre sweep (A-18).** Serve the repo, load `src/paulx-worklet.js` through `Tone.getContext().addAudioWorkletModule`, feed the same 3 s test source used in the engine tests, meter L/R RMS at stretch ×1/×10/×100 × FFT 0.3/0.5/0.7. Requirement: within 1.5 dB of the source, L = R for mono. Then for Pitch shift −12/0/+12, Frequency shift ±500 Hz, Harmonics on, Filter 500–2000 Hz: record RMS **and** spectral peak / centroid — the spectrum must move; for pitch and frequency shift the level must hold within 1.5 dB.

- [ ] **Step 2: CPU.** Wrap `process()` with `Date.now()` deltas is too coarse in a worklet; instead count, per quantum, the steps taken against the per-quantum budget and post the maximum; and in the page, run an `OfflineAudioContext` render of 30 s at FFT 0.7 and 1.0 and record wall time per rendered second. State the phone as unverified.

- [ ] **Step 3: Layout.** Open a point's soundscape panel at 1440×900 and 390×844 (and 844×390): `scrollHeight - innerHeight === 0`, no horizontal overflow, screenshot each; check the tabs switch and every control is reachable without scrolling.

- [ ] **Step 4: Full suite** `npm test && npm run check`.

- [ ] **Step 5: Commit, push, verify live** — push `main`; wait for the Pages run; fetch the live `index.html` **and** `src/paulx-worklet.js` and grep for `paulx-processor` in both.
