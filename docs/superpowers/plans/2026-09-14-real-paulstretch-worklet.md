# Real Paulstretch for the soundscape bed — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the soundscape ambient bed's `Tone.GrainPlayer`-based "stretch" engine with
a real phase vocoder (FFT → randomise phase, keep magnitude → IFFT → overlap-add), run
continuously inside a custom `AudioWorkletProcessor`, so extreme ratios (100x–200x+) sound
like genuine Paulstretch rather than the time-domain granular approximation that preceded it.

**Architecture:** A pure, dependency-free FFT and a hop-synthesis function, both first proven
correct by direct execution in Node (no browser needed for the math itself), then assembled
— as plain-string ES5 source, matching this file's own style — into an `AudioWorkletProcessor`
module loaded via a `Blob` URL. The worklet replaces `v.grainPlayer` entirely; `v.player`
(dry), `makeBlend`, `v.filter`, and the existing `v.grit` chain are untouched. The native
worklet's output re-enters the existing Tone.js graph through a bridge into Tone's private
internals — confirmed working against the live browser, guarded by a loud startup assertion
so a future Tone.js version bump fails obviously rather than silently.

**Out of scope, explicitly:** the per-hit-slot stretch (`R.stretch[slot]`, `applyHitStretch`,
`ensureRhythm`'s own separate `Tone.GrainPlayer` per slot, all under "The point rhythm
engine" further down this file) is a completely separate system that happens to share
`stretchParams`/`applyStretch` with the soundscape engine being replaced here.
**`stretchParams` and `applyStretch` themselves are not touched by this plan at all** — only
the soundscape's own call sites (inside `ensureVoice`) stop calling them, because the new
engine has nothing resembling a plain `playbackRate`/`grainSize`/`overlap` triple to apply
them to. Grep the diff before merging to confirm neither function's own body changed and
nothing under the rhythm-engine section changed.

**Tech Stack:** ES5 `function` expressions throughout (matching this file — no template
literals appear anywhere in it; the worklet's module source is assembled via string
concatenation, not backticks). `AudioWorkletProcessor`/`AudioWorkletNode` (standard Web Audio
API, no library). Tone.js v15 only at the boundary where the worklet's native output
re-enters the existing Tone-based graph.

**Spec:** `docs/superpowers/specs/2026-09-14-real-paulstretch-worklet-design.md`

## Global Constraints

- **`stretch = 0` stays bit-identical to the plain recording (A-8).** The blend (`makeBlend`,
  A-17: never `Tone.CrossFade`), not the worklet's own internal state, is what guarantees
  this — exactly as it already does today. Nothing about the worklet's own behaviour at
  `amount = 0` needs to be silent on its own; it only needs to not throw.
- **No pre-rendering.** The worklet must never materialise the full stretched duration as one
  buffer — it generates output continuously from the original (short) source, a few seconds
  of internal buffer state at a time, regardless of how extreme the stretch factor is.
- **The FFT and the hop-synthesis logic must be plain, dependency-free functions**,
  executable and testable directly in Node — proven correct in isolation before either is
  ever assembled into the worklet module string.
- **The native↔Tone bridge must fail loudly, not silently**, if Tone's private internals
  (`rawContext`, `_nativeAudioContext`, `_gainNode`, `_nativeAudioNode`) are ever missing or
  not real `AudioNode`s — caught and logged clearly, never left to produce silent audio with
  no explanation.
- **`stretchParams`/`applyStretch` and everything under "The point rhythm engine" (per-hit
  stretch) are not modified by this plan.** Only `ensureVoice`'s own call sites change.
- Commit messages: a declarative sentence, then what it prevents or what was measured.

## File Structure

| File | Responsibility |
| --- | --- |
| `index.html` | `fft(re, im, inverse)`; `synthesizeHop(...)` (the phase-vocoder core); `buildPaulstretchWorkletUrl()` (assembles both plus the `AudioWorkletProcessor` class into a loadable module); `loadPaulstretchModule(ctx)` (caches the `audioWorklet.addModule()` promise); `connectNativeToToneGain(nativeSrc, toneGain)` (the native→Tone bridge, with its loud assertion); `ensureVoice` rewritten to construct/wire the worklet instead of `GrainPlayer`; `warpStep` simplified (grit unchanged, GrainPlayer-specific warp/morph/field code removed, replaced by posting current parameters to the worklet); `bedStop`'s voice-disposal block updated. |
| `tests/paulstretch.test.mjs` | The FFT and hop-synthesis, executed directly; the worklet module's assembled source (structural checks); the native↔Tone bridge assertion. |
| `tests/rhythm-stretch.test.mjs` | Several soundscape-specific tests that pinned the old `GrainPlayer`-based `ensureVoice`/`warpStep` are removed (they test code this plan deletes); every hit-slot test and every soundscape *data-model*/*UI* test (unrelated to which engine sits underneath) stays exactly as it is. |

## Order of work

Five tasks. Tasks 1-2 are pure functions, provably correct in Node with no browser needed —
build and test them first, the same discipline `stretchParams`/`metricWeight` got earlier in
this project. Task 3 assembles them into the worklet module. Task 4 wires the worklet into
`ensureVoice`, replacing `GrainPlayer`. Task 5 simplifies `warpStep`, removes the now-dead
`GrainPlayer`-specific test coverage, and adds the live verification no source-pattern test
can provide (durations, silence-at-zero, no-NaN) via `OfflineAudioContext`.

---

### Task 1: The FFT

**Files:**
- Modify: `index.html` (add directly after `applyGrit`'s closing brace, currently
  `index.html:7376`-`7381`)
- Test: `tests/paulstretch.test.mjs` (new file)

**Interfaces:**
- Produces: `fft(re, im, inverse)` — in-place radix-2 FFT/IFFT. `re`/`im` are same-length
  indexable numeric arrays (a plain `Array` in tests, a `Float64Array` when called from the
  worklet); length must be a power of 2. `inverse` truthy computes the inverse transform.
  This is the ONLY interface Task 2 needs from this task.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test`
Expected: FAIL — `fft` does not exist yet.

- [ ] **Step 3: Add `fft`**

`index.html` currently, right after `applyGrit`'s closing brace (find `function applyGrit(g,
amount)` — currently `index.html:7376`-`7381` — and the blank line after it, before the
`warpStep` comment block):

```js
  function applyGrit(g, amount) {
    if (!g) { return; }
    var amt = amount || 0;
    g.crush.bits.rampTo(Math.max(2, Math.round(16 - amt * 13)), 0.2);
    g.blend.fade.rampTo(amt, 0.2);
  }
```

Add directly after it:

```js
  /* ---- The soundscape's real Paulstretch engine ----
     A phase vocoder, not GrainPlayer's plain time-domain resampling: FFT each windowed
     frame, keep the magnitude, throw away the phase and substitute a fresh random value
     per bin, IFFT, overlap-add — the one step that gives Paulstretch its smeared, cloud-
     like wash rather than a slowed-down recording. Nothing in Tone.js or the Web Audio API
     implements this, so it is written here from scratch and run inside a custom
     AudioWorkletProcessor, continuously, rather than pre-rendered — a genuine 200x stretch
     of even a short recording would otherwise need hundreds of megabytes of audio held in
     memory at once. See the design spec's own risk section for why this is a custom
     worklet and not something built on an existing Tone.js node. */

  /* A minimal, self-contained radix-2 FFT — no dependency on anything outside this
     function, since it is also assembled into the worklet's own module source (see
     buildPaulstretchWorkletUrl below), which runs in AudioWorkletGlobalScope: no window,
     no DOM, nothing loaded elsewhere in this file is reachable from there. re/im are
     same-length indexable numeric arrays (Float64Array inside the worklet, a plain Array
     in tests), modified in place; their length must be a power of 2. inverse=true runs
     the same butterfly network with the twiddle factors' sign flipped, then scales by
     1/n, rather than needing a second, near-duplicate function. */
  function fft(re, im, inverse) {
    var n = re.length, i, j, bit, tr, ti, len, ang, wr, wi, start, k, half,
        curWr, curWi, uRe, uIm, vRe, vIm, nextWr, nextWi, m;
    for (i = 1, j = 0; i < n; i++) {
      bit = n >> 1;
      for (; j & bit; bit >>= 1) { j ^= bit; }
      j ^= bit;
      if (i < j) {
        tr = re[i]; re[i] = re[j]; re[j] = tr;
        ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    for (len = 2; len <= n; len <<= 1) {
      ang = (inverse ? 1 : -1) * 2 * Math.PI / len;
      wr = Math.cos(ang); wi = Math.sin(ang);
      half = len / 2;
      for (start = 0; start < n; start += len) {
        curWr = 1; curWi = 0;
        for (k = 0; k < half; k++) {
          uRe = re[start + k]; uIm = im[start + k];
          vRe = re[start + k + half] * curWr - im[start + k + half] * curWi;
          vIm = re[start + k + half] * curWi + im[start + k + half] * curWr;
          re[start + k] = uRe + vRe; im[start + k] = uIm + vIm;
          re[start + k + half] = uRe - vRe; im[start + k + half] = uIm - vIm;
          nextWr = curWr * wr - curWi * wi;
          nextWi = curWr * wi + curWi * wr;
          curWr = nextWr; curWi = nextWi;
        }
      }
    }
    if (inverse) {
      for (m = 0; m < n; m++) { re[m] /= n; im[m] /= n; }
    }
  }
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: the three new tests pass. Full suite still 235/235.

(All three tests use `extractFn("fft")`, which locates `fft` by name and extracts its body
by brace-counting rather than by slicing to some other function's start — so it stays valid
regardless of what later tasks insert between `fft` and whatever follows it in the file.)

- [ ] **Step 5: Commit**

```bash
git add index.html tests/paulstretch.test.mjs
git commit -m "Add a self-contained radix-2 FFT for the soundscape's Paulstretch engine"
```

---

### Task 2: The hop-synthesis core

**Files:**
- Modify: `index.html` (add directly after `fft`'s closing brace)
- Test: `tests/paulstretch.test.mjs` (appended)

**Interfaces:**
- Consumes: `fft(re, im, inverse)` (Task 1).
- Produces: `synthesizeHop(source, readPos, windowSize, warpBins, fftFn, randomFn)` — reads
  one `windowSize`-sample Hann-windowed frame from `source` (any indexable numeric array)
  starting at `Math.floor(readPos)` (zero-padding past either end, so a read position near
  the source's edges degrades to silence rather than reading garbage), FFTs it via `fftFn`,
  replaces every bin's phase with `randomFn() * 2 * Math.PI` while keeping its magnitude
  (shifted by `warpBins` bins first — the frequency/pitch shift), inverse-FFTs, re-windows,
  and returns a `windowSize`-length array ready to be overlap-added into an output buffer.
  This is the interface Task 3's worklet processor consumes.

- [ ] **Step 1: Write the failing test**

```js
// tests/paulstretch.test.mjs — appended

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
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test`
Expected: FAIL — `synthesizeHop` does not exist yet.

- [ ] **Step 3: Add `synthesizeHop`**

Add directly after `fft`'s closing brace:

```js
  /* One phase-vocoder hop: read a Hann-windowed frame from `source` at `readPos` (zero-
     padded past either end — a read position drifting near the source's edges degrades to
     silence rather than reading whatever happens to sit past the array), FFT it, shift the
     magnitude spectrum by `warpBins` bins (the frequency/pitch shift — "warp"), discard the
     phase entirely and substitute `randomFn()` per bin (the one step that makes this
     Paulstretch rather than a clean phase-coherent stretch), inverse-FFT, window again, and
     return the frame ready to be overlap-added into an output buffer. Everything the frame
     depends on is passed in — including fftFn and randomFn — so it can be tested
     deterministically without needing the worklet's own random phase to be reproducible. */
  function synthesizeHop(source, readPos, windowSize, warpBins, fftFn, randomFn) {
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
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: all of Task 1's and Task 2's tests pass (Task 1's end-marker dependency on
`synthesizeHop` is now satisfied). Full suite 235/235 plus the 7 new tests.

- [ ] **Step 5: Commit**

```bash
git add index.html tests/paulstretch.test.mjs
git commit -m "Add the phase-vocoder hop: FFT, keep magnitude, randomise phase, IFFT"
```

---

### Task 3: The worklet module

**Files:**
- Modify: `index.html` (add directly after `synthesizeHop`'s closing brace)
- Test: `tests/paulstretch.test.mjs` (appended)

**Interfaces:**
- Consumes: `fft`, `synthesizeHop` (Tasks 1-2) — their SOURCE TEXT, read out of this same
  file at runtime and re-assembled into the worklet module string (so the worklet's copy and
  the main-thread-tested copy are provably the same code, not two hand-kept-in-sync copies).
- Produces: `buildPaulstretchWorkletUrl()` — returns a `Blob` URL for a module implementing
  `class PaulstretchProcessor extends AudioWorkletProcessor` and
  `registerProcessor("paulstretch-processor", PaulstretchProcessor)`. This is the interface
  Task 4 consumes (`audioWorklet.addModule(buildPaulstretchWorkletUrl())`).

**Design of the processor itself** (inside the module string, not directly executable/testable
in Node — `AudioWorkletProcessor` only exists in `AudioWorkletGlobalScope` — verified instead
via Task 5's live-browser checks):

- **Constructor** receives (via the second `AudioWorkletNode` constructor argument's
  `processorOptions`, or via an initial `port.postMessage`) nothing yet — the source audio
  arrives asynchronously once the recording decodes, via `port.postMessage({ type: "source",
  data: Float32Array }, [data.buffer])` (a transfer, not a copy — the main thread's own copy
  becomes unusable after this, which is fine since nothing else needs it once the worklet
  has it).
- **State:** `this.source` (the transferred Float32Array, `null` until it arrives),
  `this.readPos` (float, source-sample units), `this.writeBuf` (a `Float32Array` ring buffer
  a few seconds long — 8 seconds at the context's sample rate is generous headroom),
  `this.writePos`/`this.readOutPos` (ring buffer indices), `this.hopCounter` (samples until
  the next synthesis hop), `this.params` (`{ stretchFactor: 1, warpBins: 0, morphRate: 0,
  synthesisHop: 1024 }`, updated wholesale by `port.postMessage({ type: "params", ...
  })` whenever a setter's slider or `ensureVoice`'s own position-tick sends fresh values —
  matching the exact "point-level values read fresh, no live scheduling ever torn down"
  A-16 principle already used everywhere else in this file, just via `postMessage` instead
  of directly-read object properties, since a worklet cannot read the main thread's `q`
  object directly).
- **`process(inputs, outputs)`:** if `this.source` is null, output silence and return `true`
  (keep the node alive — the source may still be loading). Otherwise, decrement
  `hopCounter` by the render quantum size (128); once it reaches zero, run one
  `synthesizeHop` call (using this module's own local copies of `fft`/`synthesizeHop`,
  assembled into the same module string) at the current `readPos`, overlap-add its result
  into `writeBuf` at the current write position, advance `writePos` by
  `params.synthesisHop`, advance `readPos` by `(elapsed real seconds this hop) /
  params.stretchFactor` in source-sample units (decoupling `field`'s hop-size changes from
  the actual stretch rate, per the design spec), add `params.morphRate`-scaled drift to
  `readPos` separately, wrap `readPos` if it runs past the source's length (a smooth
  scan back to the start, not a hard reset), and reset `hopCounter` to
  `params.synthesisHop`. Then copy the next 128 already-synthesised samples out of
  `writeBuf` into the output.
- **`static get parameterDescriptors()`:** none needed — parameters arrive via
  `port.postMessage`, not native `AudioParam`s, since they change relatively rarely (a
  slider move, a position tick) rather than needing sample-accurate automation.
- Also produces: `loadPaulstretchModule(ctx)` — returns a cached `Promise` from
  `ctx.audioWorklet.addModule(buildPaulstretchWorkletUrl())`. Registration
  (`audioWorklet.addModule`) and construction (`new AudioWorkletNode(...)`) are two
  separate async steps; skipping the first makes the second throw. This is the interface
  Task 4's `ensureVoice` awaits before constructing its `AudioWorkletNode`.

- [ ] **Step 1: Write the failing test**

```js
// tests/paulstretch.test.mjs — appended

test("buildPaulstretchWorkletUrl assembles fft and synthesizeHop's own real source into the module, not a hand-copied duplicate", () => {
  const src = slice("function buildPaulstretchWorkletUrl()", "\n  }\n");
  assert.match(src, /function fft\(/, "the worklet module must embed fft's real source");
  assert.match(src, /function synthesizeHop\(/, "the worklet module must embed synthesizeHop's real source");
  assert.match(src, /registerProcessor\(\s*["']paulstretch-processor["']/);
  assert.match(src, /class PaulstretchProcessor extends AudioWorkletProcessor/);
  assert.match(src, /new Blob\(/);
  assert.match(src, /URL\.createObjectURL\(/);
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
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test`
Expected: FAIL — `buildPaulstretchWorkletUrl` does not exist yet.

- [ ] **Step 3: Add `buildPaulstretchWorkletUrl`**

Add directly after `synthesizeHop`'s closing brace:

```js
  /* AudioWorkletProcessor runs in its own restricted global scope — no window, no DOM,
     nothing else in this file is reachable from there — so its module has to be entirely
     self-contained. Built once, lazily, the first time a soundscape voice needs it (see
     ensureVoice); the resulting Blob URL is cached and reused for every voice's own
     AudioWorkletNode, since audioWorklet.addModule() only needs to run once per context. */
  var paulstretchWorkletUrl = null;
  function buildPaulstretchWorkletUrl() {
    if (paulstretchWorkletUrl) { return paulstretchWorkletUrl; }
    var lines = [
      "'use strict';",
      fft.toString(),
      synthesizeHop.toString(),
      "class PaulstretchProcessor extends AudioWorkletProcessor {",
      "  constructor() {",
      "    super();",
      "    this.source = null;",
      "    this.readPos = 0;",
      "    this.writeBuf = new Float32Array(8 * sampleRate);",
      "    this.writePos = 0;",
      "    this.readOutPos = 0;",
      "    this.hopCounter = 0;",
      "    this.params = { stretchFactor: 1, warpBins: 0, morphRate: 0, synthesisHop: 1024, windowSize: 4096 };",
      "    this.port.onmessage = (e) => {",
      "      if (e.data.type === 'source') { this.source = e.data.data; this.readPos = 0; }",
      "      else if (e.data.type === 'params') { Object.assign(this.params, e.data.params); }",
      "    };",
      "  }",
      "  _synthesizeOneHop() {",
      "    var frame = synthesizeHop(this.source, this.readPos, this.params.windowSize,",
      "      Math.round(this.params.warpBins), fft, Math.random);",
      "    var i, idx;",
      "    for (i = 0; i < frame.length; i++) {",
      "      idx = (this.writePos + i) % this.writeBuf.length;",
      "      this.writeBuf[idx] += frame[i];",
      "    }",
      "    var hopSeconds = this.params.synthesisHop / sampleRate;",
      "    var advance = (hopSeconds / Math.max(1, this.params.stretchFactor)) * sampleRate;",
      "    advance += this.params.morphRate * sampleRate * hopSeconds;",
      "    this.readPos += advance;",
      "    if (this.source.length > 0) {",
      "      this.readPos = ((this.readPos % this.source.length) + this.source.length) % this.source.length;",
      "    }",
      "    this.writePos = (this.writePos + this.params.synthesisHop) % this.writeBuf.length;",
      "    this.hopCounter = this.params.synthesisHop;",
      "  }",
      "  process(inputs, outputs) {",
      "    var output = outputs[0][0];",
      "    if (!output) { return true; }",
      "    if (!this.source) { output.fill(0); return true; }",
      "    var i;",
      "    for (i = 0; i < output.length; i++) {",
      "      if (this.hopCounter <= 0) { this._synthesizeOneHop(); }",
      "      this.hopCounter--;",
      "      var idx = (this.readOutPos + i) % this.writeBuf.length;",
      "      output[i] = this.writeBuf[idx];",
      "      this.writeBuf[idx] = 0;",
      "    }",
      "    this.readOutPos = (this.readOutPos + output.length) % this.writeBuf.length;",
      "    return true;",
      "  }",
      "}",
      "registerProcessor('paulstretch-processor', PaulstretchProcessor);"
    ];
    var blob = new Blob([lines.join("\n")], { type: "application/javascript" });
    paulstretchWorkletUrl = URL.createObjectURL(blob);
    return paulstretchWorkletUrl;
  }

  /* new AudioWorkletNode(ctx, "paulstretch-processor") throws unless this context has
     already run audioWorklet.addModule() for a module that registered that exact name —
     construction and registration are two separate async steps, easy to miss since
     nothing about the AudioWorkletNode constructor itself hints a prior step was needed.
     Cached so every soundscape voice's own ensureVoice call awaits the same promise
     rather than re-adding the module (addModule on an already-loaded module is harmless
     but wasteful, and registerProcessor throws if called twice for the same name on some
     browsers). */
  var paulstretchModulePromise = null;
  function loadPaulstretchModule(ctx) {
    if (!paulstretchModulePromise) {
      paulstretchModulePromise = ctx.audioWorklet.addModule(buildPaulstretchWorkletUrl());
    }
    return paulstretchModulePromise;
  }
```

- [ ] **Step 4: Run the tests**

Run: `npm test && npm run check`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add index.html tests/paulstretch.test.mjs
git commit -m "Assemble the phase vocoder into a loadable AudioWorkletProcessor module"
```

---

### Task 4: Wire the worklet into `ensureVoice`, replacing `GrainPlayer`

**Files:**
- Modify: `index.html` (`ensureVoice` at `index.html:7209`-`7281`, `bedStop`'s voice-disposal
  block, currently around `index.html:5865`-`5885` — locate by the exact quoted text below,
  not the line number, since earlier tasks in this plan will have shifted it)
- Test: `tests/paulstretch.test.mjs` (appended); `tests/rhythm-stretch.test.mjs` (three
  soundscape-specific tests removed — see Step 6)

**Interfaces:**
- Consumes: `buildPaulstretchWorkletUrl()`, `loadPaulstretchModule(ctx)` (Task 3).
- Produces: `connectNativeToToneGain(nativeSrc, toneGain)` — the native→Tone bridge helper,
  with the loud startup assertion. `v.stretch` — the per-voice worklet state (`{ node,
  ready }`), replacing `v.grainPlayer` in every place that used to reference it.

- [ ] **Step 1: Write the failing test**

```js
// tests/paulstretch.test.mjs — appended

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
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test`
Expected: FAIL — none of this exists yet; `ensureVoice` still builds a `GrainPlayer`.

- [ ] **Step 3: Add the native↔Tone bridge helper**

Add directly after `loadPaulstretchModule`'s closing brace:

```js
  /* Tone's own public API only supports connecting a Tone node's output INTO a native
     node (already used below: toneNode.connect(nativeNode) works as-is) — never the
     reverse. Routing the worklet's native output back into the existing Tone-based grit/
     blend graph needs Tone's PRIVATE internals, measured directly against the live
     browser: Tone.Gain's own instance is not a real AudioNode, and neither is its
     ._gainNode — only ._gainNode._nativeAudioNode is. A future Tone.js version could
     rename any of these without warning; asserting here means that shows up as one loud,
     specific error instead of a stretch knob that silently does nothing. */
  function connectNativeToToneGain(nativeSrc, toneGain) {
    var inner = toneGain && toneGain._gainNode && toneGain._gainNode._nativeAudioNode;
    if (!inner || !(inner instanceof AudioNode)) {
      throw new Error("connectNativeToToneGain: Tone.Gain's internal native node was not " +
        "found where expected (._gainNode._nativeAudioNode) — this Tone.js build's " +
        "private internals have likely changed since this bridge was written.");
    }
    nativeSrc.connect(inner);
  }
```

- [ ] **Step 4: Replace `ensureVoice`'s `GrainPlayer` construction**

`index.html` currently (the construction path inside `ensureVoice`'s `audioBlob(...).then(...)`
callback — find the exact text below):

```js
      v.grit = buildGrit(Tone);
      v.grit.output.connect(v.stretchBlend.b);
      v.grainPlayer = new Tone.GrainPlayer({
        url: v.url, loop: true,
        onload: function () {
          if (!bed || !bed.on || !bed.voices[z.id]) {
            try { v.grainPlayer.dispose(); } catch (e) {}
            return;
          }
          v.grainPlayer.start();
        }
      }).connect(v.grit.input);
      applyStretch(v.grainPlayer, q.stretch);
      applyGrit(v.grit, q.grit);
      v.stretchBlend.connect(v.filter);
```

Change to:

```js
      v.grit = buildGrit(Tone);
      v.grit.output.connect(v.stretchBlend.b);
      /* The worklet reads its own copy of the recording, decoded once here rather than
         a second network fetch/decode — a.buffer isn't available yet at this point in
         the callback (a's own shape is the recording's ANALYSIS metadata, not raw
         samples), so this decodes the SAME blob url a second time via a plain
         OfflineAudioContext-free native decode. The one-time cost is small next to a
         200x-stretched ambient bed's own lifetime. */
      v.stretch = { node: null, ready: false };
      var nativeCtx = bed.Tone.context.rawContext._nativeAudioContext;
      Promise.all([
        fetch(v.url).then(function (r) { return r.arrayBuffer(); })
          .then(function (ab) { return nativeCtx.decodeAudioData(ab); }),
        /* new AudioWorkletNode(nativeCtx, "paulstretch-processor") throws unless this
           context has already finished registering that processor name — addModule is
           its own separate async step, cached so only the FIRST voice's ensureVoice call
           actually loads it and every later one just awaits the same promise. */
        loadPaulstretchModule(nativeCtx)
      ]).then(function (results) {
        var audioBuffer = results[0];
        if (!bed || !bed.on || !bed.voices[z.id]) { return; }
        var raw = audioBuffer.getChannelData(0);
        var mono = new Float32Array(raw.length);
        mono.set(raw);
        var node = new AudioWorkletNode(nativeCtx, "paulstretch-processor");
        node.port.postMessage({ type: "source", data: mono }, [mono.buffer]);
        connectNativeToToneGain(node, v.grit.input);
        v.stretch.node = node;
        v.stretch.ready = true;
      }).catch(function () { /* the worklet stays silent (blend at 0) if this fails */ });
      applyGrit(v.grit, q.grit);
      v.stretchBlend.connect(v.filter);
```

- [ ] **Step 5: Replace the ready-branch's stretch handling**

`index.html` currently, inside `ensureVoice`'s `if (v.ready) { ... }` branch:

```js
        applyStretch(v.grainPlayer, q.stretch);
        v.stretchBlend.fade.rampTo(q.stretch, BED.fade);
        applyGrit(v.grit, q.grit);
```

Change to:

```js
        if (v.stretch && v.stretch.ready) {
          v.stretch.node.port.postMessage({ type: "params", params: {
            stretchFactor: Math.pow(200, Math.max(0, Math.min(1, q.stretch))),
            warpBins: v._warpBins || 0,
            morphRate: q.morph || 0
          } });
        }
        v.stretchBlend.fade.rampTo(q.stretch, BED.fade);
        applyGrit(v.grit, q.grit);
```

- [ ] **Step 6: Update `bedStop`'s voice-disposal block**

`index.html` currently:

```js
        try { v.player.stop(); v.player.dispose(); } catch (e) {}
        try {
          if (v.grainPlayer) { v.grainPlayer.stop(); v.grainPlayer.dispose(); }
          if (v.stretchBlend) { v.stretchBlend.dispose(); }
        } catch (e) {}
```

Change to:

```js
        try { v.player.stop(); v.player.dispose(); } catch (e) {}
        try {
          if (v.stretch && v.stretch.node) { v.stretch.node.disconnect(); }
          if (v.stretchBlend) { v.stretchBlend.dispose(); }
        } catch (e) {}
```

- [ ] **Step 7: Remove the three now-obsolete soundscape tests in `tests/rhythm-stretch.test.mjs`**

Delete these three tests entirely (they assert `GrainPlayer`-specific `ensureVoice` code this
task just replaced — find each by its exact name and remove the whole `test(...)` block):

- `"ensureVoice builds a blended GrainPlayer reading the same url as the dry player"`
- `"ensureVoice re-applies stretch on an already-ready voice, ramped like gain and filter"`
- `"ensureVoice uses applyStretch instead of its own inline reassignment"`

Do not touch any other test in that file — every hit-slot test, and every soundscape
data-model/UI test (`soundOf`, `soundOfZone`, `buildSoundRow`, `renderSoundscapePanel`,
`renderRhythmPanel`'s branch) is unrelated to which engine sits underneath and stays exactly
as it is.

- [ ] **Step 8: Run the tests**

Run: `npm test && npm run check`
Expected: all pass, including every hit-slot test (unaffected) and the remaining
soundscape data-model/UI tests (also unaffected — only the engine underneath changed).

- [ ] **Step 9: Commit**

```bash
git add index.html tests/paulstretch.test.mjs tests/rhythm-stretch.test.mjs
git commit -m "Replace the soundscape's GrainPlayer with the real Paulstretch worklet"
```

---

### Task 5: Simplify `warpStep`, wire live slider feedback, and verify live

**Files:**
- Modify: `index.html` (`warpStep` at `index.html:7389`-`7437` pre-task, `renderSoundscapePanel`'s
  slider handlers)
- Test: `tests/paulstretch.test.mjs` (appended); `tests/rhythm-stretch.test.mjs` (four more
  obsolete tests removed — see Step 4)

**Interfaces:**
- Produces: a simplified `warpStep` that no longer touches any `GrainPlayer`-specific
  property, and a live-feedback path from the soundscape panel's sliders straight to the
  worklet, matching the hit-slot engine's own `applyHitStretch`-on-`input` pattern.

- [ ] **Step 1: Write the failing test**

```js
// tests/paulstretch.test.mjs — appended

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
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test`
Expected: FAIL — `warpStep` still has all the old `GrainPlayer` property writes.

- [ ] **Step 3: Rewrite `warpStep`**

`index.html` currently (the whole function — find `function warpStep(time)` and its closing
brace):

```js
  function warpStep(time) {
    if (!bed) { return; }
    Object.keys(bed.voices).forEach(function (id) {
      var v = bed.voices[id];
      if (!v.ready || !v.grainPlayer) { return; }
      var f = feature(id), q = f ? soundOf(f) : null;
      if (!q) { return; }
      if (q.warp > 0) {
        v._warpDetune = Math.max(-50, Math.min(50,
          (v._warpDetune || 0) + (Math.random() * 2 - 1) * q.warp * 12));
      } else {
        v._warpDetune = 0;
      }
      v.grainPlayer.detune = v._warpDetune;

      var dur = (v.grainPlayer.buffer && v.grainPlayer.buffer.duration) || 0;
      if (q.morph > 0 && dur > 1) {
        var winLen = Math.max(1, dur * (1 - q.morph * 0.7));
        v._morphPos = ((v._morphPos || 0) + q.morph * dur * 0.05) % Math.max(0.01, dur - winLen);
        v.grainPlayer.loopStart = v._morphPos;
        v.grainPlayer.loopEnd = Math.min(dur, v._morphPos + winLen);
      } else {
        v.grainPlayer.loopStart = 0;
        v.grainPlayer.loopEnd = 0;
      }

      var sp = stretchParams(q.stretch);
      if (q.field > 0) {
        var j = 1 + (Math.random() * 2 - 1) * q.field * 0.6;
        v.grainPlayer.grainSize = Math.max(0.02, sp.grainSize * j);
        v.grainPlayer.overlap = Math.max(0.01, sp.overlap * j);
      } else {
        v.grainPlayer.grainSize = sp.grainSize;
        v.grainPlayer.overlap = sp.overlap;
      }

      applyGrit(v.grit, q.grit);
    });
  }
```

Change to:

```js
  /* A slow, musical tick (A-1: the Transport, never a UI callback) for the soundscape
     bed's warp/morph/field qualities. The worklet manages its own continuous drift and
     random-walk internally once given target parameters (see buildPaulstretchWorkletUrl);
     this tick's only job is to keep those targets current — warp's own slow wobble is a
     random walk kept here (on the main thread, at a musical cadence) and forwarded as a
     plain bin-shift target, since the worklet itself has no reason to run its own
     independent RNG-driven drift for something this coarse. grit is unrelated to any of
     this and is unchanged from before this plan. */
  function warpStep(time) {
    if (!bed) { return; }
    Object.keys(bed.voices).forEach(function (id) {
      var v = bed.voices[id];
      if (!v.ready || !v.stretch || !v.stretch.ready) { return; }
      var f = feature(id), q = f ? soundOf(f) : null;
      if (!q) { return; }
      if (q.warp > 0) {
        v._warpBins = Math.max(-24, Math.min(24,
          (v._warpBins || 0) + (Math.random() * 2 - 1) * q.warp * 3));
      } else {
        v._warpBins = 0;
      }
      v.stretch.node.port.postMessage({ type: "params", params: {
        stretchFactor: Math.pow(200, Math.max(0, Math.min(1, q.stretch))),
        warpBins: v._warpBins,
        morphRate: q.morph || 0,
        synthesisHop: Math.round(1024 * (1 - (q.field || 0) * 0.6))
      } });
      applyGrit(v.grit, q.grit);
    });
  }
```

- [ ] **Step 4: Remove the four now-obsolete `GrainPlayer`-specific tests in
  `tests/rhythm-stretch.test.mjs`**

Delete these four tests entirely (find each by its exact name):

- `"warpStep's warp resets the detune random-walk to 0 rather than freezing it at its last value"`
- `"warpStep's morph widens the loop window back to the whole buffer at 0, rather than leaving a stale narrow one"`
- `"warpStep clamps morph's loopEnd to the buffer's own duration, since Tone's setter throws past it"`
- `"warpStep's field jitters grainSize/overlap around stretchParams' own values, not a hardcoded pair"`
- `"warpStep resets grainSize/overlap to stretchParams' own values when field is 0, not just when it's above 0"`

(Five tests, not four — recount confirmed while re-reading the current file: `warpStep`'s
morph section produced two separate tests, one for the widen-at-0 behaviour and one for the
loopEnd clamp fix. Remove all five. The two tests `"warpStep is a safe no-op with no bed,
and never writes playbackRate directly"` and `"warpStep applies grit every tick, through
applyGrit rather than a second hand-rolled ramp"` stay — re-verify both still pass against
the rewritten function; if the first's `playbackRate` assertion no longer finds anything
relevant to check, that's fine, it was already checking an absence.)

- [ ] **Step 5: Wire the soundscape panel's sliders to post live updates**

Find `renderSoundscapePanel(f, q, commitQ, body)` and each of the five `buildSoundRow(...)`
calls for `stretch`/`warp`/`morph`/`field`/`grit`. `buildSoundRow`'s own `commitQ` callback
(passed in from `renderRhythmPanel`, already `claimEdit(f); save(); updateBed();
redrawZones();`) already calls `updateBed()`, which reaches `ensureVoice`'s own ready-branch
(Task 4, Step 5) for every in-range voice — which already posts fresh `params` to the
worklet. **No additional wiring is needed here**: confirm this by reading `updateBed()`'s
call chain (`updateBed → ensureVoice` for every near zone) and the ready-branch code from
Task 4 Step 5, and write the test in Step 1 above to assert `renderSoundscapePanel` reaches
`bed.voices[f.properties.id]` — matching the existing `commitQ`-triggers-`updateBed`-triggers-
`ensureVoice` chain already in place, not a new bespoke path. If tracing that chain shows a
gap (e.g. `updateBed` doesn't reach a voice currently out of the "near" set even though it's
selected in the setter panel), add a direct call in each slider's own `input` handler:
`if (bed && bed.voices[f.properties.id]) { /* re-run the same params postMessage Task 4
Step 5 sends */ }` — but only if tracing proves it's needed, per this plan's own "no
placeholders" rule: verify first, then decide, rather than adding speculative code.

- [ ] **Step 6: Run the tests**

Run: `npm test && npm run check`
Expected: all pass.

- [ ] **Step 7: Live verification — this is the step no source-pattern test can replace**

Serve locally, open a real Chrome tab (`claude-in-chrome`), and using
`OfflineAudioContext` (which runs a complete native Web Audio graph, `AudioWorkletNode`
included, synchronously to completion — no real-time playback, no setter credentials, no
live route needed):

1. Load `buildPaulstretchWorkletUrl()`'s real source (extract it the same way the tests do,
   or just open the real page and call the real function via the console) into a real
   `OfflineAudioContext`, construct a `PaulstretchProcessor` node, feed it a few seconds of
   a synthetic test tone via the same `postMessage({ type: "source", ... })` path
   `ensureVoice` uses, render, and confirm: the rendered output's sample count is
   proportional to the render length (sanity: the worklet didn't stall or throw); every
   rendered sample is finite (no `NaN`/`Infinity`); at `stretchFactor` near 1, the output's
   gross spectral content resembles the input's (a coarse but real check that the phase
   vocoder isn't producing pure noise at the "least stretched" setting).
2. Confirm `connectNativeToToneGain`'s assertion actually fires as a real, catchable
   `Error` (not a silent failure) if deliberately given a plain object instead of a real
   `Tone.Gain` — prove the loud-failure guarantee works, don't just read the `if` and trust
   it.
3. If credentials/a real route are available in this environment, additionally walk a
   route with a soundscape point that has stretch turned up and confirm audibly: at
   `stretch = 0` it sounds identical to before this plan; raising `stretch` produces a real
   Paulstretch-style smear (not silence, not a glitch/crash); raising `warp` audibly shifts
   pitch; raising `morph` audibly drifts which part of the recording is heard; raising
   `field` audibly changes the texture's density; `grit` behaves exactly as it did before
   this plan (untouched). If credentials are not available, state that plainly rather than
   skipping silently — the `OfflineAudioContext` checks in sub-step 1 are the verification
   of record for this plan; the live walk is confirmatory, not required to call this done.

- [ ] **Step 8: Commit**

```bash
git add index.html tests/paulstretch.test.mjs tests/rhythm-stretch.test.mjs
git commit -m "Simplify warpStep for the worklet engine and verify against a real render"
```
