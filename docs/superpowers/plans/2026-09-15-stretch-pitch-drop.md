# Stretch also drops pitch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the soundscape bed's `stretch` knob also drop pitch by a bounded, musical
amount (capped at 2 octaves at `stretch = 1`) — decoupled from the time-stretch ratio itself,
so it stays audible across the whole knob range instead of tying pitch directly to
`stretchFactor` and going inaudible well before x200.

**Architecture:** A pure `stretchPitchRatio(stretch)` function (cents, then the multiplicative
ratio derived from them) feeds a new `pitchRatio` parameter through the existing worklet
message protocol, alongside `stretchFactor`/`warpBins`/`morphRate`/`synthesisHop`.
`synthesizeHop`'s own resynthesis step gets a second, MULTIPLICATIVE bin lookup (distinct from
`warpBins`' existing ADDITIVE one) — zero-filled past the spectrum's edge, composed so
`warpBins`' own wrap-around offset applies on top of the pitch-shifted result, not instead of
it. `warp`'s own behaviour, `morph`, `field`, `grit`, and the waveform/cursor visualization are
all untouched.

**Tech Stack:** Same as the worklet this extends — ES5 `function` expressions, no template
literals, `AudioWorkletProcessor`/`AudioWorkletNode` (standard Web Audio API). No new
libraries.

**Spec:** `docs/superpowers/specs/2026-09-15-stretch-pitch-drop-design.md`

## Global Constraints

- **`stretch = 0` stays bit-identical to the plain recording.** `pitchRatio` defaults to `1`
  everywhere (the params object's own default, and `stretchPitchRatio(0).ratio === 1`) — a
  provable no-op, not merely "sounds unchanged."
- **The multiplicative pitch lookup zero-fills past the spectrum's edge; it must never wrap.**
  `warpBins`' own modulo wrap-around is untouched and stays exactly as it is today — it is a
  different mechanism for a different knob (`warp`), not something this plan repurposes.
- **Composition order is fixed:** the pitch-ratio lookup happens first (producing a full,
  zero-filled pitch-shifted magnitude spectrum), and `warpBins`' own additive offset indexes
  into THAT result — `warp` must still audibly do its own job at every non-zero `stretch`,
  not be silently canceled by the pitch lookup.
- **No new slider, no new field in `f.properties.sound`.** `pitchRatio` is derived entirely
  from the existing `stretch` value at the same three call sites that already derive
  `stretchFactor` from it.
- **`-2400` (cents at `stretch = 1`) lives in exactly one place** (`stretchPitchRatio`) —
  every consumer calls the function, none hardcodes the constant.
- Commit messages: a declarative sentence, then what it prevents or what was measured.

## File Structure

| File | Responsibility |
| --- | --- |
| `index.html` | `stretchPitchRatio(stretch)` (new, pure); `synthesizeHop(...)` (signature gains `pitchRatio`, body gains the multiplicative zero-filled lookup); `buildPaulstretchWorkletUrl()`'s embedded worklet source (`this.params` default gains `pitchRatio: 1`, `_synthesizeOneHop`'s call site passes it through); `ensureVoice`'s ready-branch, `warpStep`, `commitLive` (each posts `pitchRatio` alongside `stretchFactor`). |
| `tests/paulstretch.test.mjs` | `stretchPitchRatio`, executed directly; `synthesizeHop`'s four existing direct-call tests updated for the new parameter, plus new tests for the pitch lookup itself; the worklet's `params` default and `_synthesizeOneHop`'s call site (via the existing `loadPaulstretchProcessorClass` sandbox); the three call sites' own structural checks. |

## Order of work

Three dispatchable tasks, then a live-verification pass I run directly (not dispatched — see
Task 4's own note). Task 1 is a pure function, provably correct with no browser needed — same
discipline every other piece of stretch arithmetic in this project got. Task 2 changes
`synthesizeHop`'s actual algorithm and is the one place a real defect could hide, so it gets
the most test coverage. Task 3 is pure wiring — three call sites, each already doing the same
kind of thing for `stretchFactor`.

---

### Task 1: `stretchPitchRatio` — the cents/ratio math

**Files:**
- Modify: `index.html` (add directly after `stretchedDurationInfo`'s closing brace, currently
  `index.html:5118`-`5122`)
- Test: `tests/paulstretch.test.mjs` (add near the existing `stretchedDurationInfo` tests)

**Interfaces:**
- Produces: `stretchPitchRatio(stretch)` → `{ cents: number, ratio: number }`. `stretch` is
  clamped to `[0, 1]` the same way every other stretch-derived function in this file already
  clamps it. This is the ONLY interface Task 3 needs from this task; Task 2 needs nothing from
  it (Task 2 takes a plain `pitchRatio` number as a parameter, same as `warpBins`).

- [ ] **Step 1: Write the failing test**

Add to `tests/paulstretch.test.mjs`, near the existing `stretchedDurationInfo` tests (after the
test ending `"...seconds, 0);\n});"` around line 580):

```js
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
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test 2>&1 | grep -A3 "stretchPitchRatio"`
Expected: `function not found: stretchPitchRatio` (or similar `ReferenceError`) from all four
new tests.

- [ ] **Step 3: Add `stretchPitchRatio`**

In `index.html`, immediately after `stretchedDurationInfo`'s closing brace (the `}` on the
line before the `/* The soundscape panel...` comment that precedes `renderSoundscapePanel`):

```js
  /* Tied to the same stretch knob, not to stretchFactor itself: literal tape-style
     pitch/stretchFactor would put a typical field recording's content below or at the
     bottom edge of human hearing well before stretch=1 (x200) — the exact failure the
     phase vocoder was built pitch-preserving to avoid (see the worklet's own spec). -2400
     cents (two octaves) at stretch=1 is a bounded, musical cap instead: audible and
     characterful across the whole knob range. Cents is the same unit the reference
     implementation (github.com/essej/paulxstretch, ProcessedStretch.h's pitch_shift.cents)
     uses for exactly this kind of control. -2400 is tuned by ear, not load-bearing; every
     consumer calls this function rather than hardcoding it, so it stays a one-line retune. */
  function stretchPitchRatio(stretch) {
    var cents = -2400 * Math.max(0, Math.min(1, stretch || 0));
    var ratio = Math.pow(2, cents / 1200);
    return { cents: cents, ratio: ratio };
  }
```

- [ ] **Step 4: Run the tests**

Run: `npm test 2>&1 | tail -20`
Expected: all four new tests pass; total pass count up by 4 from the pre-task baseline; 0
failures.

- [ ] **Step 5: Commit**

```bash
git add index.html tests/paulstretch.test.mjs
git commit -m "$(cat <<'EOF'
Add stretchPitchRatio: the cents/ratio math for stretch's own pitch drop

Bounded at -2400 cents (two octaves) at stretch=1, decoupled from
stretchFactor itself -- literal tape-style pitch/stretchFactor would go
inaudible well before x200, the exact failure the phase vocoder's own
pitch-preserving design already avoids for duration. One function, one
place the -2400 constant lives.
EOF
)"
```

---

### Task 2: `synthesizeHop`'s multiplicative pitch lookup

**Files:**
- Modify: `index.html:7672`-`7699` (`synthesizeHop`'s signature and body)
- Modify: `index.html:7723` (`this.params` default, inside `buildPaulstretchWorkletUrl`'s
  `lines` array — add `pitchRatio: 1`)
- Modify: `index.html:7730`-`7731` (`_synthesizeOneHop`'s call to `synthesizeHop`, inside the
  same `lines` array — pass `this.params.pitchRatio` through)
- Modify: `tests/paulstretch.test.mjs` (update the four existing tests that call
  `synthesizeHop` directly, since its signature changes)
- Test: `tests/paulstretch.test.mjs` (new tests for the pitch lookup itself)

**Interfaces:**
- Consumes: nothing from Task 1 — `pitchRatio` here is a plain number parameter, the same way
  `warpBins` already is. (Task 3 is what calls `stretchPitchRatio` to produce that number.)
- Produces: `synthesizeHop(source, readPos, windowSize, warpBins, pitchRatio, fftFn, randomFn)`
  — note `pitchRatio` is inserted as the 5th parameter, between `warpBins` and `fftFn`. Task 3
  needs nothing from this task directly (it posts to the worklet's message protocol, which
  this task also updates inside the `lines` array).

- [ ] **Step 1: Write the failing test**

First, update the FOUR existing tests that call `synthesizeHop` directly — they break the
moment the signature changes, so this is done in the same step as the new tests, not after.

In `tests/paulstretch.test.mjs`, in the test `"synthesizeHop returns a windowSize-length frame
with no NaN/Infinity, for any read position"` (around line 93), change:

```js
    const out = synthesizeHop(source, readPos, windowSize, 0, fft, rnd);
```
to:
```js
    const out = synthesizeHop(source, readPos, windowSize, 0, 1, fft, rnd);
```

In `"synthesizeHop is deterministic given a deterministic randomFn..."` (around lines 108-109),
change both calls:
```js
  const out1 = synthesizeHop(source, 0, n, 0, fft, (() => { let c = 0; return () => { c++; return (c % 7) / 7; }; })());
  const out2 = synthesizeHop(source, 0, n, 0, fft, (() => { let c = 0; return () => { c++; return (c % 7) / 7; }; })());
```
to:
```js
  const out1 = synthesizeHop(source, 0, n, 0, 1, fft, (() => { let c = 0; return () => { c++; return (c % 7) / 7; }; })());
  const out2 = synthesizeHop(source, 0, n, 0, 1, fft, (() => { let c = 0; return () => { c++; return (c % 7) / 7; }; })());
```

In `"synthesizeHop's magnitude spectrum (before the final re-window) matches the source's own,
phase aside"` (around line 133), change:
```js
  const out = synthesizeHop(source, 0, n, 0, fft, () => 0.37);
```
to:
```js
  const out = synthesizeHop(source, 0, n, 0, 1, fft, () => 0.37);
```

In `"synthesizeHop's warpBins shifts which bin carries the dominant magnitude"` (around line
148), change:
```js
  const outShifted = synthesizeHop(source, 0, n, shift, fft, () => 0.5);
```
to:
```js
  const outShifted = synthesizeHop(source, 0, n, shift, 1, fft, () => 0.5);
```

Now add the new tests, directly after the `"synthesizeHop's warpBins shifts..."` test (before
`"buildPaulstretchWorkletUrl assembles..."`, currently around line 157):

```js
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

test("synthesizeHop's pitchRatio at 1 is a provable no-op: identical output to the same call before pitchRatio existed", () => {
  const fft = extractFn("fft");
  const synthesizeHop = extractFn("synthesizeHop");
  const n = 32;
  const source = Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * 5 * i / n));
  const withRatio = synthesizeHop(source, 0, n, 3, 1, fft, () => 0.5);
  const withoutRatioEquivalent = synthesizeHop(source, 0, n, 3, 1, fft, () => 0.5);
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(withRatio[i] - withoutRatioEquivalent[i]) < 1e-9,
      `frame[${i}] differs — pitchRatio=1 must be bit-identical to itself across calls, and ` +
      "by construction (round(i/1) === i for every i) identical to no pitch lookup at all");
  }
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
  for (let i = Math.ceil(n / 4) + 2; i < n / 2; i++) {
    assert.ok(mag[i] < 1e-6,
      `bin ${i} (source lookup ${4 * i}, out of the [0,${n}) range) carries ${mag[i]} — ` +
      "expected zero-fill, not wrapped energy from elsewhere in the spectrum");
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
  const peak = mag.indexOf(Math.max(...mag));
  // Pitch-shifted bin is round(k*ratio) = 4; warpBins' own offset composes on top of THAT
  // (the pitch-shifted spectrum), landing the peak at 4 + shift = 6 — not at k + shift = 10
  // (which would mean warpBins was applied to the ORIGINAL spectrum instead, ignoring the
  // pitch shift), and not at just 4 (which would mean warpBins was silently dropped).
  const expected = Math.round(k * ratio) + shift;
  assert.ok(peak === expected || peak === n - expected,
    `expected the composed dominant bin at ${expected} (or its mirror), got ${peak} ` +
    `(pitch-only would be ${Math.round(k * ratio)}, warp-on-original would be ${k + shift})`);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test 2>&1 | tail -40`
Expected: the four updated existing tests fail with a wrong-argument-count-shaped error (extra
`1` being passed where `fftFn` is currently expected — `fft` receiving a boolean/number in the
`inverse` position, or similar), and all four new tests fail since `synthesizeHop` doesn't
accept a `pitchRatio` parameter yet.

- [ ] **Step 3: Add the multiplicative pitch lookup**

In `index.html`, replace `synthesizeHop`'s current signature and body:

```js
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

with:

```js
  function synthesizeHop(source, readPos, windowSize, warpBins, pitchRatio, fftFn, randomFn) {
    var i, srcIdx, s, w, mag, pitchMag, pitchBin, srcBin, phase;
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
    /* Multiplicative, unlike warpBins' own additive offset below — every partial's frequency
       scaled by the same ratio, which is what preserves harmonic relationships (a real pitch
       shift) rather than moving every partial by the same fixed amount (a detuning wobble,
       which is what warpBins is for). Zero-filled past the spectrum's edge: a downward pitch
       shift has nothing to put in the vacated high end, not a wrapped copy from the opposite
       end of the spectrum — wrapping here would be a distinct, physically wrong artifact,
       not a softer version of the real thing. */
    pitchMag = new Array(windowSize);
    for (i = 0; i < windowSize; i++) {
      pitchBin = Math.round(i / pitchRatio);
      pitchMag[i] = (pitchBin >= 0 && pitchBin < windowSize) ? mag[pitchBin] : 0;
    }
    var outRe = new Array(windowSize), outIm = new Array(windowSize);
    for (i = 0; i < windowSize; i++) {
      /* warpBins' own wrap-around offset composes on top of the pitch-shifted spectrum
         above, not the original — warp must still audibly do its own job at every
         non-zero stretch, on top of whatever pitchRatio already did, not be computed
         against the unshifted spectrum and discarded. */
      srcBin = ((i - warpBins) % windowSize + windowSize) % windowSize;
      phase = randomFn() * 2 * Math.PI;
      outRe[i] = pitchMag[srcBin] * Math.cos(phase);
      outIm[i] = pitchMag[srcBin] * Math.sin(phase);
    }
    fftFn(outRe, outIm, true);
    for (i = 0; i < windowSize; i++) {
      w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (windowSize - 1));
      outRe[i] *= w;
    }
    return outRe;
  }
```

Then, inside `buildPaulstretchWorkletUrl`'s `lines` array, change the params default:

```js
      "    this.params = { stretchFactor: 1, warpBins: 0, morphRate: 0, synthesisHop: 1024, windowSize: 4096 };",
```
to:
```js
      "    this.params = { stretchFactor: 1, warpBins: 0, morphRate: 0, synthesisHop: 1024, windowSize: 4096, pitchRatio: 1 };",
```

And `_synthesizeOneHop`'s call site:
```js
      "    var frame = synthesizeHop(this.source, this.readPos, this.params.windowSize,",
      "      Math.round(this.params.warpBins), fft, Math.random);",
```
to:
```js
      "    var frame = synthesizeHop(this.source, this.readPos, this.params.windowSize,",
      "      Math.round(this.params.warpBins), this.params.pitchRatio, fft, Math.random);",
```

- [ ] **Step 4: Run the tests**

Run: `npm test 2>&1 | tail -40`
Expected: all four updated existing tests pass again; all four new tests pass; 0 failures.

- [ ] **Step 5: Confirm the worklet-level integration too**

The four new tests above exercise `synthesizeHop` directly (via `extractFn`), proving the
algorithm itself. Add one more test using `loadPaulstretchProcessorClass()` (the existing
sandbox that runs the REAL assembled worklet module, defined in this same test file) to prove
`_synthesizeOneHop` actually threads `this.params.pitchRatio` through, not just that the
standalone function works:

```js
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
```

Run: `npm test 2>&1 | tail -10`
Expected: this test passes too; total pass count up by 9 from Task 1's ending count (4 updated
+ 4 new + this one = 9 net new/changed assertions in this task).

- [ ] **Step 6: Commit**

```bash
git add index.html tests/paulstretch.test.mjs
git commit -m "$(cat <<'EOF'
Give synthesizeHop a real, multiplicative pitch shift

warpBins already shifts bins, but additively -- every partial moves by
the same fixed offset, which detunes rather than transposes (correct
for warp's own wobble, wrong for a clean pitch drop). pitchRatio is a
second, multiplicative lookup that preserves harmonic ratios, zero-
filled past the spectrum's edge rather than wrapping -- a downward
shift has nothing to put in the vacated high end. Composed so warpBins'
own offset applies on top of the pitch-shifted spectrum, not instead of
it, so warp still does its own job at any pitchRatio.
EOF
)"
```

---

### Task 3: Wire `pitchRatio` into the three call sites

**Files:**
- Modify: `index.html:7419`-`7436` (`ensureVoice`'s ready-branch)
- Modify: `index.html:7817`-`7837` (`warpStep`)
- Modify: `index.html:5227`-`5251` (`commitLive`, inside `renderSoundscapePanel`)
- Test: `tests/paulstretch.test.mjs`

**Interfaces:**
- Consumes: `stretchPitchRatio(stretch)` (Task 1) → `.ratio`.
- Produces: nothing further downstream — this is the last task in the plan (Task 4 is
  verification only, no new interface).

- [ ] **Step 1: Write the failing test**

Add to `tests/paulstretch.test.mjs`, near the existing tests for these three sites (after the
test `"ensureVoice only ramps stretchBlend.fade toward q.stretch..."`, currently ending around
line 493):

```js
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
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test 2>&1 | grep -A6 "also post pitchRatio"`
Expected: FAIL — none of the three sites reference `pitchRatio` yet.

- [ ] **Step 3: Add it to `ensureVoice`'s ready branch**

In `index.html`, change:
```js
          v.stretch.node.port.postMessage({ type: "params", params: {
            stretchFactor: Math.pow(200, Math.max(0, Math.min(1, q.stretch))),
            warpBins: v._warpBins || 0,
            morphRate: q.morph || 0
          } });
```
to:
```js
          v.stretch.node.port.postMessage({ type: "params", params: {
            stretchFactor: Math.pow(200, Math.max(0, Math.min(1, q.stretch))),
            warpBins: v._warpBins || 0,
            morphRate: q.morph || 0,
            pitchRatio: stretchPitchRatio(q.stretch).ratio
          } });
```

- [ ] **Step 4: Add it to `warpStep`**

Change:
```js
      v.stretch.node.port.postMessage({ type: "params", params: {
        stretchFactor: Math.pow(200, Math.max(0, Math.min(1, q.stretch))),
        warpBins: v._warpBins,
        morphRate: q.morph || 0,
        /* See commitLive's own copy of this clamp above for why. */
        synthesisHop: Math.max(64, Math.round(1024 * (1 - (q.field || 0) * 0.6)))
      } });
```
to:
```js
      v.stretch.node.port.postMessage({ type: "params", params: {
        stretchFactor: Math.pow(200, Math.max(0, Math.min(1, q.stretch))),
        warpBins: v._warpBins,
        morphRate: q.morph || 0,
        pitchRatio: stretchPitchRatio(q.stretch).ratio,
        /* See commitLive's own copy of this clamp above for why. */
        synthesisHop: Math.max(64, Math.round(1024 * (1 - (q.field || 0) * 0.6)))
      } });
```

- [ ] **Step 5: Add it to `commitLive`**

Change:
```js
      v.stretch.node.port.postMessage({ type: "params", params: {
        stretchFactor: Math.pow(200, Math.max(0, Math.min(1, q.stretch))),
        warpBins: v._warpBins || 0,
        morphRate: q.morph || 0,
        /* Clamped so an out-of-range field (imported/synced data, or any future caller
           that bypasses the slider's own 0-1 clamp) can never drive this to zero or
           negative — inside the worklet that would stop hopCounter from ever counting
           back up past 0, locking process() into calling _synthesizeOneHop() on every
           sample. 64 stays comfortably clear of that while leaving the normal
           1024-at-field-0 down to 410-at-field-1 slider range untouched. */
        synthesisHop: Math.max(64, Math.round(1024 * (1 - (q.field || 0) * 0.6)))
      } });
```
to:
```js
      v.stretch.node.port.postMessage({ type: "params", params: {
        stretchFactor: Math.pow(200, Math.max(0, Math.min(1, q.stretch))),
        warpBins: v._warpBins || 0,
        morphRate: q.morph || 0,
        pitchRatio: stretchPitchRatio(q.stretch).ratio,
        /* Clamped so an out-of-range field (imported/synced data, or any future caller
           that bypasses the slider's own 0-1 clamp) can never drive this to zero or
           negative — inside the worklet that would stop hopCounter from ever counting
           back up past 0, locking process() into calling _synthesizeOneHop() on every
           sample. 64 stays comfortably clear of that while leaving the normal
           1024-at-field-0 down to 410-at-field-1 slider range untouched. */
        synthesisHop: Math.max(64, Math.round(1024 * (1 - (q.field || 0) * 0.6)))
      } });
```

- [ ] **Step 6: Run the tests**

Run: `npm test 2>&1 | tail -15 && npm run check 2>&1 | tail -10`
Expected: the new structural test passes; every pre-existing test still passes (none of these
three sites' pre-existing tests assert an EXACT/closed params shape that a new field would
break — confirm this by reading the diff of `npm test`'s pass count against Task 2's ending
count: it should be exactly +1); `npm run check` clean.

- [ ] **Step 7: Commit**

```bash
git add index.html tests/paulstretch.test.mjs
git commit -m "$(cat <<'EOF'
Wire pitchRatio into the three sites that already post stretchFactor

Same pattern each of the three already follows for stretchFactor itself
-- ensureVoice's ready branch, warpStep, and commitLive all derive
pitchRatio from stretchPitchRatio(q.stretch) and post it alongside the
params they already send. No new slider: this is entirely driven by
the existing stretch value, per the design's own decoupled-but-derived
approach.
EOF
)"
```

---

### Task 4: Live verification — the one thing no source-pattern test can prove

**This task is reserved for the controller session, not a dispatched implementer** — same as
the original worklet plan's own Task 5 Step 7. "Does this actually sound like a pitch drop,
not just pass arithmetic checks" cannot be asserted from source text; it needs the real
assembled worklet running against a real `OfflineAudioContext`.

**Files:** none modified — verification only.

- [ ] **Step 1: Serve the branch locally and open a real Chrome tab**

Same technique already proven twice this session (the original worklet's own Task 5 Step 7,
and this session's live verification of the waveform/cursor feature): serve the worktree's
`index.html`, fetch its source from the live page, extract `fft`, `synthesizeHop`,
`stretchPitchRatio`, `buildPaulstretchWorkletUrl`, `loadPaulstretchModule` via the same
brace-counting technique the test suite uses, and `eval` them as real named function
declarations (not `new Function` reconstructions, which would give `.toString()` an
`"function anonymous(...)"` header — matters here because `buildPaulstretchWorkletUrl`
embeds `synthesizeHop.toString()` verbatim into the worklet module source).

- [ ] **Step 2: Render a synthetic tone through the real worklet at pitchRatio's two extremes**

Construct a real `OfflineAudioContext`, `addModule()` the real assembled worklet, build a
`PaulstretchProcessor` node, feed it a few seconds of a synthetic pure tone (a known
frequency, e.g. 440Hz) via the same `postMessage({type: "source", ...})` path `ensureVoice`
uses, and render twice:

1. `stretchFactor: 1`, `pitchRatio: stretchPitchRatio(0).ratio` (i.e. `1`) — confirm the
   rendered output's own dominant spectral peak (via a simple DFT/peak-find over the
   rendered buffer, not a full analysis library) sits at ~440Hz, matching the source.
2. `stretchFactor: 1`, `pitchRatio: stretchPitchRatio(1).ratio` (i.e. `0.25`) — confirm the
   rendered output's own dominant spectral peak sits at ~110Hz (440 × 0.25 — two octaves
   down), not at 440Hz and not at some unrelated frequency.

Both renders: confirm every sample is finite (no NaN/Infinity), matching the same discipline
the original worklet's own live verification held itself to.

- [ ] **Step 3: Confirm warp composes correctly, not just in the unit tests**

Render once more with both `warpBins` (a nonzero value, e.g. from simulating `warp > 0` for a
few `_synthesizeOneHop` calls) and `pitchRatio: 0.25` active together. Confirm the render
completes without throwing, produces finite audio, and — since this is the one thing worth a
human ear, not just an automated peak-find — note in the report whether the result sounds like
a lower-pitched version of the source with `warp`'s own wobble still present, for Kerem to
spot-check if he wants to (this plan's own automated proof is the peak-frequency and
finite-sample checks above; a listening pass is confirmatory, not required to call this task
done, same standing the original worklet plan gave its own optional live route-walk).

- [ ] **Step 4: Clean up**

Close the browser tab, stop the local server.

- [ ] **Step 5: Final whole-plan review**

Once Tasks 1-3 are individually reviewed and this task's live verification is clean, dispatch
the final whole-branch code review (most capable model available) per
`superpowers:subagent-driven-development`'s own process, pointed at the full diff since this
plan's own base commit. Address any findings the same way the original worklet's final review
was handled — one bundled fix dispatch, one scoped re-review, adjudicate any residuals.

See [[audio-quality-bar]], [[verify-by-measuring]], [[2026-09-15-stretch-pitch-drop-design]].
