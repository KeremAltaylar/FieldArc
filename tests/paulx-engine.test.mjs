// tests/paulx-engine.test.mjs — the stretch engine, ported from PaulXStretch's Stretch.cpp.
import { test } from "node:test";
import assert from "node:assert/strict";
await import("../src/paulx-worklet.js");
const PX = globalThis.PaulX;

const SR = 48000;
const rms = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);
const db = (x) => 20 * Math.log10(x);
function source(seconds) {
  const n = Math.round(SR * seconds), s = new Float32Array(n);
  let seed = 3;
  for (let i = 0; i < n; i++) {
    seed = (seed * 16807) % 2147483647;
    s[i] = 0.3 * Math.sin(2 * Math.PI * 440 * i / SR) + 0.15 * Math.sin(2 * Math.PI * 1320 * i / SR) +
           0.1 * (seed / 2147483647 * 2 - 1);
  }
  return s;
}
const SRC = source(6);
const defaults = () => ({ stretch: 1, freeze: false, onset: 0, morph: 0, field: 0, warpHz: 0,
  mods: { fshift: { on: true, hz: 0 }, pitch: { on: true, st: 0 } } });
function render(bufsize, p, hops, src = SRC) {
  const rd = new PX.PxReader(src, SR), st = new PX.PxStretcher(bufsize, SR, 7);
  rd.setRange(0, 1, 0.01);
  st.prime(rd);
  const out = new Float64Array(bufsize * hops), hop = new Float64Array(bufsize);
  for (let h = 0; h < hops; h++) { PX.pxRun(st.hopJob(rd, p, hop)); out.set(hop, h * bufsize); }
  return { out, rd, st };
}

test("the FFT matches a direct DFT bin and round-trips", () => {
  const n = 64, re = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.3) + i / n), im = new Float64Array(n);
  const orig = re.slice();
  PX.pxRun(PX.pxFftSteps(re, im, false));
  let dr = 0, di = 0;
  for (let i = 0; i < n; i++) { dr += orig[i] * Math.cos(-2 * Math.PI * 5 * i / n); di += orig[i] * Math.sin(-2 * Math.PI * 5 * i / n); }
  assert.ok(Math.abs(re[5] - dr) < 1e-9 && Math.abs(im[5] - di) < 1e-9);
  PX.pxRun(PX.pxFftSteps(re, im, true));
  orig.forEach((v, i) => assert.ok(Math.abs(re[i] - v) < 1e-9));
});

test("the FFT yields often enough to be spread across render quanta", () => {
  const n = 65536, { steps } = PX.pxRun(PX.pxFftSteps(new Float64Array(n), new Float64Array(n), false));
  assert.ok(steps >= 16, "only " + steps + " yields for a 65536-point FFT");
});

test("the Hamming window is PaulXStretch's: 0.53836 - 0.46164 cos(2 pi i/(N+1))", () => {
  const w = PX.pxHamming(8);
  assert.ok(Math.abs(w[3] - (0.53836 - 0.46164 * Math.cos(2 * Math.PI * 3 / 9))) < 1e-12);
});

test("at stretch x1 the engine plays at the source's speed and level", () => {
  const b = 2048, { out, rd } = render(b, defaults(), 120);
  const d = db(rms(out.slice(4 * b)) / rms(SRC));
  assert.ok(Math.abs(d) < 1.5, "level " + d.toFixed(2) + " dB");
  assert.equal(rd.pos, 122 * b, "three primed chunks, then one per hop from the second hop on");
});

test("level holds within 1.5 dB at x10 and x100 and across FFT sizes (A-18)", () => {
  const seen = [];
  for (const [b, stretch] of [[1024, 10], [4096, 10], [16384, 100], [2048, 100]]) {
    const { out } = render(b, Object.assign(defaults(), { stretch }), Math.max(40, Math.ceil(SR * 3 / b)));
    const d = db(rms(out.slice(4 * b)) / rms(SRC));
    seen.push(`${b}/x${stretch}: ${d.toFixed(2)}`);
    assert.ok(Math.abs(d) < 1.5, seen.join(", "));
  }
});

test("the read position advances bufsize/stretch per hop", () => {
  const b = 1024, { rd } = render(b, Object.assign(defaults(), { stretch: 8 }), 64);
  assert.equal(rd.pos, 3 * b + 7 * b, "64 hops at x8: reads on hops 9, 17 … 57");
});

test("freeze stops the read position and keeps sounding", () => {
  const b = 1024, p = defaults();
  const rd = new PX.PxReader(SRC, SR), st = new PX.PxStretcher(b, SR, 1), hop = new Float64Array(b);
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
  for (let i = SR; i < SR * 4; i++) { src[i] = 0.5 * Math.sin(2 * Math.PI * 300 * i / SR); }
  const p = Object.assign(defaults(), { stretch: 50, onset: 0.8 });
  const rd = new PX.PxReader(src, SR), st = new PX.PxStretcher(b, SR, 2), hop = new Float64Array(b);
  rd.setRange(0, 1, 0);
  st.prime(rd);
  let fired = false;
  for (let h = 0; h < 4000 && !fired; h++) { if (PX.pxRun(st.hopJob(rd, p, hop)).value > 0.5) { fired = true; } }
  assert.ok(fired, "the transient at 1 s was detected");
  assert.ok(st.credit > 0, "time credit is owed after the snap");
});

test("the reader loops within [start, end) and crossfades the seam", () => {
  const data = Float32Array.from({ length: 1000 }, (_, i) => i);
  const rd = new PX.PxReader(data, 1000);
  rd.setRange(0.2, 0.6, 0.05);             // s0 200, s1 600, xf 50
  assert.equal(rd.pos, 200);
  const seen = [];
  for (let i = 0; i < 450; i++) { seen.push(rd.next()); }
  assert.equal(seen[0], 200);
  assert.ok(Math.abs(seen[375] - (575 * 0.5 + 225 * 0.5)) < 1e-9, "midway through the seam");
  assert.equal(seen[400], 250, "after the seam, playback resumes past the faded-in head");
});

test("field jitter and warp change the output without moving the level more than 1.5 dB", () => {
  const b = 2048;
  const base = render(b, Object.assign(defaults(), { stretch: 4 }), 60).out.slice(4 * b);
  const extra = render(b, Object.assign(defaults(), { stretch: 4, field: 1, warpHz: 150 }), 60).out.slice(4 * b);
  assert.ok(Math.abs(db(rms(extra) / rms(base))) < 1.5);
  assert.notDeepEqual(Array.from(extra.slice(0, 64)), Array.from(base.slice(0, 64)));
});
