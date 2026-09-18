// tests/paulx-page.test.mjs — how the page feeds and parameterises the PaulXStretch worklet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8").replace(/\r\n/g, "\n");
const sw = readFileSync("sw.js", "utf8");
function body(name) {
  const start = html.indexOf("function " + name + "(");
  assert.ok(start !== -1, "missing " + name);
  let i = html.indexOf("{", html.indexOf(")", start)), d = 0;
  const from = i;
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

test("pxDefaults carries PaulXStretch's own defaults", () => {
  const d = fn("pxDefaults")();
  assert.equal(d.fft, 0.7);
  assert.deepEqual([d.fshift.on, d.pitch.on, d.harmonics.on, d.ratios.on], [true, true, false, false]);
  assert.deepEqual(d.ratios.l, [0, 0, 1, 0, 0, 0, 0, 0]);
  assert.equal(d.harmonics.freq, 128);
  assert.equal(d.tonal.bw, 0.74);
  assert.equal(d.binaural.hz, 4);
});

test("a point saved before the port keeps its stretch factor: 200^s becomes 1024^s'", () => {
  const src = body("soundOf").src;
  assert.match(src, /Math\.log\(200\) \/ Math\.log\(1024\)/);
  assert.match(src, /pxDefaults\(\)/);
  const s = 0.5, migrated = s * Math.log(200) / Math.log(1024);
  assert.ok(Math.abs(Math.pow(1024, migrated) - Math.pow(200, s)) < 1e-9);
});

test("the page loads the worklet from src/paulx-worklet.js through Tone's context", () => {
  assert.match(body("loadPaulstretchModule").src, /addAudioWorkletModule\("src\/paulx-worklet\.js"\)/);
  assert.match(body("ensureVoice").src, /createAudioWorkletNode\("paulx-processor"/);
  assert.match(body("ensureVoice").src, /outputChannelCount:\s*\[2\]/);
});

test("both channels of a stereo recording reach the worklet, transferred", () => {
  const src = body("ensureVoice").src;
  assert.match(src, /numberOfChannels/);
  assert.match(src, /type: "source", channels: channels/);
  assert.match(src, /channels\.map\(function \(c\) \{ return c\.buffer; \}\)/);
});

test("every site that posts params uses pxParams, so the worklet has one writer", () => {
  ["ensureVoice", "warpStep", "renderSoundscapePanel"].forEach((n) => assert.match(body(n).src, /pxParams\(q, v\)/, n));
});

test("pxParams turns the stored sound into the processor's message", () => {
  const pxBufsize = fn("pxBufsize"), pxDefaults = fn("pxDefaults");
  const b = body("pxParams");
  const pxParams = new Function("pxBufsize", "return function(" + b.params + "){" + b.src + "}")(pxBufsize);
  const q = { stretch: 0.5, morph: 0.2, field: 0.1, px: pxDefaults() };
  const m = pxParams(q, { _warpHz: 40 });
  assert.equal(m.stretch, 32);
  assert.equal(m.bufsize, 16384);
  assert.equal(m.warpHz, 40);
  assert.equal(m.mods.pitch.st, 0);
  assert.equal(m.binaural.on, false);
});

test("stretch no longer drives pitch, and the old engine is gone from the page", () => {
  assert.equal(html.indexOf("function stretchPitchRatio("), -1);
  assert.equal(html.indexOf("function synthesizeHop("), -1);
  assert.equal(html.indexOf("function buildPaulstretchWorkletUrl("), -1);
});

test("the stretched-length readout uses 1024^s and the play range", () => {
  const info = fn("stretchedDurationInfo")(10, 1, 0, 0.25, 0.75);
  assert.equal(info.factor, 1024);
  assert.equal(info.seconds, 5 * 1024);
});

test("the worklet is precached for offline walks", () => {
  assert.match(sw, /"\.\/src\/paulx-worklet\.js"/);
});
