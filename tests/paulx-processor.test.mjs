// tests/paulx-processor.test.mjs — the AudioWorkletProcessor around the engine.
import { test } from "node:test";
import assert from "node:assert/strict";

let Proc = null;
globalThis.sampleRate = 48000;
globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage() {}, onmessage: null }; } };
globalThis.registerProcessor = (name, cls) => { if (name === "paulx-processor") { Proc = cls; } };
const PX = await import("../src/paulx-worklet.js");

const SR = 48000;
const params = (o = {}) => Object.assign({ stretch: 1, bufsize: 2048, freeze: false, onset: 0, start: 0, end: 1,
  xfade: 0.01, morph: 0, field: 0, warpHz: 0, mods: { fshift: { on: true, hz: 0 }, pitch: { on: true, st: 0 } },
  binaural: { on: false, power: 0.5, hz: 4, mode: 0 } }, o);
const tone = (n, f, ph = 0) => Float32Array.from({ length: n }, (_, i) => 0.3 * Math.sin(2 * Math.PI * f * i / SR + ph));
const quantum = (pr) => { const out = [[new Float32Array(128), new Float32Array(128)]]; pr.process([], out); return out[0]; };
function start(p, channels) {
  const pr = new Proc();
  pr.port.onmessage({ data: { type: "params", params: p } });
  pr.port.onmessage({ data: { type: "source", channels } });
  return pr;
}
function run(p, quanta, channels = [tone(SR * 4, 440)]) {
  const pr = start(p, channels), L = new Float32Array(quanta * 128), R = new Float32Array(quanta * 128);
  for (let q = 0; q < quanta; q++) { const o = quantum(pr); L.set(o[0], q * 128); R.set(o[1], q * 128); }
  return { pr, L, R };
}
const rms = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);

test("the processor registers as paulx-processor and fills both channels", () => {
  assert.ok(Proc);
  const { L, R } = run(params(), 400);
  assert.ok(rms(L.slice(20000)) > 0.05);
  assert.deepEqual(Array.from(R.slice(20000, 20100)), Array.from(L.slice(20000, 20100)), "mono source: R mirrors L");
});

test("a stereo source gets two stretchers with independent phase", () => {
  const { L, R } = run(params(), 400, [tone(SR * 4, 440), tone(SR * 4, 440)]);
  let diff = 0;
  for (let i = 20000; i < 30000; i++) { diff += Math.abs(L[i] - R[i]); }
  assert.ok(diff > 1, "identical channels would mean shared phase");
});

test("a large hop's work is spread: each quantum runs a small fraction of it", () => {
  const { pr } = run(params({ bufsize: 16384 }), 600);
  const s = pr.ch[0];
  assert.ok(s.est > 20, "a 16384 hop is many steps: " + s.est);
  assert.ok(s.budget < s.est / 4, "budget " + s.budget + " of " + s.est + " steps per quantum");
});

test("the spread job produces the same audio as computing each hop at once", () => {
  const a = run(params({ bufsize: 1024 }), 300).L;
  const rd = new PX.PxReader(tone(SR * 4, 440), SR), st = new PX.PxStretcher(1024, SR, 0x5eed), hop = new Float64Array(1024);
  rd.setRange(0, 1, 0.01);
  st.prime(rd);
  const ref = [];
  for (let h = 0; h < 37; h++) { PX.pxRun(st.hopJob(rd, params({ bufsize: 1024 }), hop)); ref.push(...hop); }
  for (let i = 0; i < 37 * 1024; i++) { assert.ok(Math.abs(a[i] - ref[i]) < 1e-6, "sample " + i); }
});

test("changing the FFT size rebuilds without a click", () => {
  const pr = start(params(), [tone(SR * 4, 440)]);
  for (let i = 0; i < 300; i++) { quantum(pr); }
  pr.port.onmessage({ data: { type: "params", params: params({ bufsize: 4096 }) } });
  let maxStep = 0, prev = null;
  for (let i = 0; i < 80; i++) {
    for (const v of quantum(pr)[0]) { if (prev !== null) { maxStep = Math.max(maxStep, Math.abs(v - prev)); } prev = v; }
  }
  assert.equal(pr.ch[0].st.bufsize, 4096);
  assert.ok(maxStep < 0.15, "largest sample-to-sample jump " + maxStep.toFixed(3));
});

test("binaural beats: left moves down and right up by half the beat frequency", () => {
  const bb = new PX.PxBinaural(SR), n = SR;
  const L = tone(n, 1000), R = tone(n, 1000);
  bb.process(L, R, { power: 0, hz: 20, mode: 0 });
  const zc = (a) => { let c = 0; for (let i = 1001; i < a.length; i++) { if (a[i - 1] <= 0 && a[i] > 0) { c++; } } return c * SR / (a.length - 1001); };
  assert.ok(Math.abs(zc(L) - 990) < 3, "left " + zc(L));
  assert.ok(Math.abs(zc(R) - 1010) < 3, "right " + zc(R));
});

test("binaural beats run only when enabled, and then on both channels", () => {
  const off = run(params(), 300), on = run(params({ binaural: { on: true, power: 0, hz: 8, mode: 0 } }), 300);
  let dL = 0; for (let i = 20000; i < 30000; i++) { dL += Math.abs(off.L[i] - on.L[i]); }
  assert.ok(dL > 1, "enabling changes the output");
  let same = 0; for (let i = 20000; i < 30000; i++) { same += Math.abs(on.L[i] - on.R[i]); }
  assert.ok(same > 1, "left and right now differ");
});

test("the processor reports its read position, throttled", () => {
  const pr = new Proc(), sent = [];
  pr.port.postMessage = (m) => sent.push(m);
  pr.port.onmessage({ data: { type: "params", params: params() } });
  pr.port.onmessage({ data: { type: "source", channels: [tone(SR * 4, 440)] } });
  for (let i = 0; i < 64; i++) { quantum(pr); }
  const pos = sent.filter((m) => m.type === "pos");
  assert.equal(pos.length, 4);
  assert.equal(pos[0].sourceLength, SR * 4);
});

test("before a source arrives the processor outputs silence", () => {
  const pr = new Proc();
  pr.port.onmessage({ data: { type: "params", params: params() } });
  const o = quantum(pr);
  assert.equal(rms(o[0]), 0);
});
