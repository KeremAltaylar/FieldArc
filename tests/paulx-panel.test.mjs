// tests/paulx-panel.test.mjs — the soundscape panel's PaulXStretch controls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8").replace(/\r\n/g, "\n");
function src(name) {
  const s = html.indexOf("function " + name + "(");
  assert.ok(s !== -1, "missing " + name);
  let i = html.indexOf("{", html.indexOf(")", s)), d = 0;
  const from = i;
  for (; i < html.length; i++) { if (html[i] === "{") d++; else if (html[i] === "}") { d--; if (!d) break; } }
  return html.slice(from + 1, i);
}

test("the panel has its sections and every PaulXStretch control", () => {
  const p = src("renderSoundscapePanel");
  ["Stretch", "Spectrum", "Extras"].forEach((h) => assert.match(p, new RegExp('heading\\("' + h + '"\\)')));
  ["Harmonics", "Tonal vs noise", "Frequency shift", "Pitch shift", "Ratios", "Spread", "Filter",
   "Compressor", "Binaural beats"].forEach((m) => assert.match(p, new RegExp('buildPxModule\\("' + m + '"'), m));
  ["stretch", "fft", "onset", "start", "end", "xfade", "warp", "morph", "field", "grit"]
    .forEach((k) => assert.match(p, new RegExp('k: "' + k + '"'), k));
  assert.match(p, /buildPxToggle\("freeze"/);
  assert.match(p, /buildPxToggle\("gaussian"/);
  assert.match(p, /buildPxToggle\("stop band"/);
  assert.match(p, /buildPxSelect\("mode"/);
});

test("readouts are in real units", () => {
  const p = src("renderSoundscapePanel");
  [/Hz"/, /" st"/, /" ¢"/, /"×"/, /" %"/, /" s"/].forEach((re) => assert.match(p, re));
});

test("a module heading is a real toggle bound to .on, and an off module dims", () => {
  const m = src("buildPxModule");
  assert.match(m, /aria-pressed/);
  assert.match(m, /obj\.on = !obj\.on/);
  assert.match(m, /classList\.toggle\("off", !obj\.on\)/);
  assert.match(html, /\.pxmod\.off \.pprow \{ opacity:/);
});

test("rows declare data-def, so the global double-click reset and shift-fine drag apply", () => {
  assert.match(src("buildPxRow"), /dataset\.def/);
});

test("log sliders keep the stored value in real units", () => {
  const b = src("buildPxRow");
  assert.match(b, /Math\.log\(v\)/);
  assert.match(b, /Math\.exp\(u\)/);
});

test("narrow or short screens get tabs, not a scrolling panel", () => {
  /* Measured: 1428x729 three columns, 501x695 five tabs, 832x390 five tabs with two sub-columns
     — every one 0 px of panel scroll. Three tabs had scrolled 23-168 px. */
  const p = src("renderSoundscapePanel");
  assert.match(p, /setAttribute\("role", "tablist"\)/);
  assert.match(p, /innerWidth < 1000 \|\| innerHeight < 700/);
  ["Point", "Stretch", "Spectrum", "Ratios", "Output"].forEach((t) => assert.match(p, new RegExp('title: "' + t + '"')));
  assert.match(p, /twoUp = tabbed && innerWidth >= 700/);
  assert.match(p, /innerHeight < 500\) \{ wave\.classList\.add\("short"\); mhead\.hidden = true; \}/);
});

test("every drag updates the caption first, whether or not a voice is playing, then posts pxParams", () => {
  const p = src("renderSoundscapePanel");
  const live = p.slice(p.indexOf("var commitLive = function ()"));
  const caption = live.indexOf("updateWaveCaption();"), guard = live.search(/if \(!v \|\| !v\.ready/);
  assert.ok(caption !== -1 && guard !== -1 && caption < guard);
  assert.match(live, /pxParams\(q, v\)/);
});

test("the copy names the engine it is", () => {
  assert.match(src("renderSoundscapePanel"), /PaulXStretch engine/);
});

test("the waveform dims what lies outside the play range", () => {
  assert.match(src("soundscapeWaveDraw"), /q\.px\.start/);
});
