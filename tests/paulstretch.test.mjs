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
