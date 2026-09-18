// tests/paulx-modules.test.mjs — the spectral modules, ported from PaulXStretch's ProcessedStretch.h.
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
  /* Band-limited to the lower quarter, so shifting up by 1.5 keeps it all below Nyquist: content
     pushed past the top of the band is gone for physical reasons, not a level fault. */
  const noise = arr((i) => (i < N / 4 ? Math.random() : 0));
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
  PX.pxFreqShift(N, SR, f1, f2, -3000);           // -128: bin 100 falls below 0
  assert.equal(power(f2), 0);
});

test("filter passes [low, high) and stop inverts it", () => {
  const f1 = arr(() => 1), f2 = new Float64Array(N);
  /* The original multiplies a damping factor of (1 + 1e-8) per bin even at hdamp 0, so a
     passed bin reads 1 + i*1e-8 — kept, and compared with a tolerance. */
  const one = (v) => Math.abs(v - 1) < 1e-5;
  PX.pxFilter(N, SR, f1, f2, 1000, 5000, false, 0);  // bins 42..212
  assert.equal(f2[41], 0); assert.ok(one(f2[42])); assert.ok(one(f2[212])); assert.equal(f2[213], 0);
  PX.pxFilter(N, SR, f1, f2, 5000, 1000, true, 0);   // swapped bounds, stop band
  assert.ok(one(f2[41])); assert.equal(f2[42], 0);
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

test("harmonics' windowed loop matches visiting every bin, as the original does", () => {
  const f1 = arr((i) => 1 + (i % 7)), a = new Float64Array(N), b = new Float64Array(N), tmp = new Float64Array(N);
  PX.pxHarmonics(N, SR, tmp, f1, a, 187, 60, 30, true);
  // Reference: the original's full loop over every bin.
  const amp = new Float64Array(N);
  for (let nh = 1; nh <= 30; nh++) {
    const f = nh * 187; if (f >= SR / 2) break;
    const bwi = (Math.pow(2, 60 / 1200) - 1) * f / (2 * SR), fi = f / SR;
    for (let i = 1; i < N; i++) { amp[i] += PX.pxProfile((i / N * 0.5) - fi, bwi); }
  }
  let max = 0; for (let i = 1; i < N; i++) { max = Math.max(max, amp[i]); }
  for (let i = 1; i < N; i++) { b[i] = f1[i] * amp[i] / max; }
  for (let i = 1; i < N; i++) { assert.ok(Math.abs(a[i] - b[i]) < 1e-12, "bin " + i); }
});

test("tonal vs noise with preserve > 0 removes the smooth floor and keeps peaks", () => {
  const f1 = arr((i) => (i % 64 === 0 ? 50 : 1)), f2 = new Float64Array(N);
  PX.pxTonalVsNoise(N, SR, new Float64Array(N), f1, f2, 0.9, 0.5);
  assert.ok(f2[512] > 10, "a peak survives: " + f2[512]);
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
