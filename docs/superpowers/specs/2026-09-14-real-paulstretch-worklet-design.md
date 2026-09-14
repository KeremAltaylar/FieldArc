---
project: FieldArc
version: real-paulstretch-worklet
status: design agreed 2026-09-14 (Option B chosen over an offline-render alternative); no implementation plan written yet
baseline: main @ 0e7d963
---

# Real Paulstretch for the soundscape bed — a phase-vocoder AudioWorklet

The soundscape bed's "stretch" knob currently uses `Tone.GrainPlayer` — pure time-domain
granular playback, capped around 6-7x slowdown before the texture falls apart. Kerem's own
words, verbatim from testing it: *"the mechanism doesn't work like I want it... for example
if the recording is 10 seconds I want to warp it and frequency shift that it will [be] 2000
seconds like paulstretch and other effects will aesthetically support this extreme stretch.
current one is nothing like this."* This document replaces the `GrainPlayer` engine with a
real phase vocoder — the actual algorithm the original Paulstretch program uses — built as a
custom `AudioWorkletProcessor`, so extreme ratios (100x-200x+) are both audible-quality and
computationally practical (no multi-hundred-megabyte pre-rendered buffer).

## Why a phase vocoder, and why a custom worklet

Real Paulstretch's character comes from one specific step: take overlapping windowed frames
of the source, FFT each one, **discard the phase and replace it with a fresh random value
per bin, keeping only the magnitude**, then IFFT and overlap-add — writing the frames out far
more slowly than they were read in. The phase randomisation is what removes any sense of
"grain" or repetition at extreme stretch and produces the smeared, cloud-like wash Paulstretch
is known for; a standard (phase-coherent) vocoder sounds cleaner but is not what Kerem is
asking for, and neither is `GrainPlayer`'s literal time-domain resampling.

Nothing in Tone.js or the Web Audio API implements this — `AnalyserNode`'s FFT is
magnitude-only and one-way (not invertible), and there is no built-in phase-vocoder node.
This has to be written from scratch: a small radix-2 FFT (forward and inverse), the
randomise-phase-and-resynthesise loop, and an `AudioWorkletProcessor` to run it continuously
in the audio thread. This is the single biggest and riskiest piece of DSP work built in this
project so far, with no existing library to lean on or verify assumptions against — every
claim below was checked against the real, running browser, not assumed.

## Two things this spec is honest about upfront

**Rendering a genuine 2000-second output would need ~350MB of Float32 audio in memory for
one stereo voice** (10s × 200x × 44.1kHz × 2ch × 4 bytes) if it were pre-rendered — which is
exactly why this is a *real-time* worklet, not an offline render: the worklet generates
audio continuously from the original (short) source buffer and never materialises the full
stretched duration anywhere. A point that stays in range for the equivalent of "2000 seconds"
of stretched listening only ever holds a few seconds of buffered synthesis state at a time.

**The native-worklet ↔ Tone.js integration relies on Tone v15's private internals**,
because Tone's own public API only supports connecting a Tone node's output *into* a native
node (`toneNode.connect(nativeNode)` — this already works, confirmed), not the reverse. To
route the worklet's native output back into the existing Tone-based blend/effects graph, the
only working path found (measured directly in the browser, this exact Tone build) is:

```js
var ctx = Tone.getContext().rawContext._nativeAudioContext;   // the TRUE native AudioContext
var node = new AudioWorkletNode(ctx, "paulstretch-processor");
node.connect(toneGainTarget._gainNode._nativeAudioNode);      // native → Tone.Gain, drilled
toneSourceNode.connect(node);                                  // Tone → native, works natively
```

`Tone.getContext().rawContext` itself fails `instanceof BaseAudioContext` and is rejected by
`new AudioWorkletNode(...)` directly — only `.rawContext._nativeAudioContext` is accepted.
`Tone.Gain`'s own `.connect()` cannot receive a native upstream connection; only its private
`._gainNode._nativeAudioNode` is a true `AudioNode` a native source can `.connect()` into.
This is confirmed working against the current `tone@15` CDN build, but it is reading past
Tone's public API on purpose, and **a future Tone.js point release could rename these
internals and silently break the bridge** — the implementation plan must add a startup
assertion that throws a clear, loud error (caught and logged, not left to silently produce no
sound) if any of `rawContext`, `._nativeAudioContext`, `._gainNode`, or `._nativeAudioNode`
ever stop existing or stop being a real `AudioNode`, so a Tone.js upgrade surfaces this
immediately rather than as an unexplained "the stretch doesn't work anymore" bug report.

## Architecture

```
                    ┌─────────────────────────────┐
   v.player  ───────┤ makeBlend (existing)         ├──── v.filter (existing, unchanged)
   (dry,             │  .a = dry                    │
    Tone.Player,     │  .b = wet ◄──────────────────┼──── v.grit.output (existing chain,
    unchanged)        └─────────────────────────────┘      unchanged — bitcrush/drive)
                                                                  ▲
                                                          v.grit.input
                                                                  ▲
                                            native→Tone bridge (drilled .connect)
                                                                  ▲
                                          ┌───────────────────────────────────┐
                                          │  AudioWorkletNode                  │
                                          │  "paulstretch-processor"            │
                                          │  (replaces v.grainPlayer entirely)  │
                                          └───────────────────────────────────┘
                                                                  ▲
                                          one-time postMessage: raw source
                                          samples (Float32Array, transferred)
```

`v.player` (dry), `makeBlend`, `v.filter`, and the existing `v.grit` chain (bitcrush/drive)
are **completely unchanged** — this replaces only what feeds `v.stretchBlend.b`. `v.grainPlayer`
and everything that referenced it (`applyStretch`, the `field`/`morph` code in `warpStep` that
manipulated `GrainPlayer`-specific properties) is removed and replaced by the new engine
described below. `stretch = 0` must still be bit-identical to the dry recording (A-8) — the
blend, not the worklet's own internal state, is what guarantees that, exactly as it already
does today.

## The algorithm, inside the worklet

One `AudioWorkletProcessor` per voice (each soundscape bed voice gets its own instance, same
lifecycle `v.player`/`v.grainPlayer` already have — built once when the recording decodes,
disposed when the voice is torn down).

**Setup (once, via `port.postMessage` from the main thread):** the voice's fully-decoded
mono-summed sample data (a transferred `Float32Array`) and its sample rate.

**Fixed parameter:** window size 4096 samples (a Hann window).

**Baseline parameter, `field`-adjustable:** synthesis hop defaults to 1024 samples (75%
overlap — smooth even at the extreme end of the stretch range) and is the one thing `field`
(below) is allowed to move, within safe bounds (never below ~256 samples, where overlap-add
artifacts would appear, never above the window size itself, where gaps would open up).

**Per synthesis hop** (every 1024 output samples — several `process()` calls' worth, since
`process()` is called every 128 samples):
1. Read a 4096-sample frame from the source at the current read position (wrapping/clamping
   at the source's edges — a `roam`-like scan, not a hard stop, so the read position revisits
   the source smoothly rather than snapping).
2. Window it (Hann), forward-FFT it.
3. Compute each bin's magnitude; discard the phase entirely and substitute a fresh uniform
   random value in `[0, 2π)` per bin, per frame — the one step that makes this Paulstretch and
   not a clean phase-vocoder stretch.
4. **Warp** (see below) shifts the magnitude spectrum by an integer bin offset before
   resynthesis — a real pitch/frequency shift, not a wobble on a plain-property knob the way
   the old `GrainPlayer` engine faked it.
5. Inverse-FFT, window again (Hann), overlap-add into a small internal ring buffer.
6. Advance the read position by however many source-seconds correspond to the *real* time
   this hop just covered, divided by `stretchFactor` — computed from wall-clock/output time,
   not from the hop size itself, so `field`'s hop-size changes (above) can vary the texture's
   density without also silently changing how fast the recording is being consumed. At
   `stretchFactor = 200`, the read position crawls forward 200x slower than real time, so
   ~200 seconds of output correspond to ~1 second of source, independent of `field`.

**Per `process()` call (every 128 samples):** copy the next 128 already-synthesised samples
out of the ring buffer into the output. If the ring buffer hasn't been filled far enough ahead
(should not happen in steady state, since synthesis is cheap relative to real-time budget,
but a defensive guard outputs silence rather than reading garbage/uninitialised memory).

## The four extra knobs, remapped onto the new engine

The knob *names* and their *intent* (from the already-shipped design) stay the same; what
each one actually touches changes, since `GrainPlayer`'s properties (`detune`, `loopStart`/
`loopEnd`, `grainSize`/`overlap`) don't exist in this engine at all.

- **stretch** — the core time-stretch factor. Mapped exponentially, not linearly, since most
  of the musically useful range is compressed near the bottom of a 1x-200x span:
  `factor = Math.pow(200, amount)` (amount 0 → 1x, 0.5 → ~14x, 1 → 200x).
- **warp** — a real frequency/pitch shift (step 4 above), not a plain-property wobble. Mapped
  to a slow random-walk of the bin-shift amount (matching the "a slow pitch wobble, like a
  tape losing its own speed" character the UI already promises, now implemented for real
  against the actual spectrum instead of a property Tone happened to expose).
- **morph** — drifts the read position (step 1) at a variable secondary rate, independent of
  the steady stretch-driven advance, so the engine keeps scanning to a new part of the
  recording instead of dwelling on one moment — the same intent as before, now implemented as
  motion through the worklet's own read pointer instead of `GrainPlayer.loopStart`/`loopEnd`.
- **field** — widens or narrows the synthesis hop (step 5's overlap-add cadence, within the
  safe bounds named above), i.e. how densely overlapping frames are, rather than
  `GrainPlayer.grainSize`/`.overlap` jitter — same "one texture into a scattered cloud" intent,
  applied to this engine's own actual density control. Decoupled from `stretch` itself (step
  6 advances the read position from elapsed real time, not from the hop size), so the two
  knobs stay independent rather than field secretly changing how fast the recording plays.
- **grit** — completely unchanged. It never touched `GrainPlayer` specifically; it sits
  downstream of whatever feeds `v.stretchBlend.b`, so it carries over as-is.

## Data model

No changes to `f.properties.sound`'s shape — `stretch`/`warp`/`morph`/`field`/`grit` already
exist from the prior plan and keep their names, ranges (0-1) and defaults (all 0). Only their
*meaning* inside the engine changes, per the mapping above.

## Verification — this needs a different kind of proof than anything else built so far

Every other feature this session was verified two ways: automated tests (source-pattern
assertions against the real file) and, where a Tone.js API assumption mattered, constructing
the real node in a live browser and reading back its behaviour. Neither is sufficient here —
there is no Tone.js node to construct, and "does this sound like Paulstretch" cannot be
asserted from source text. The implementation plan must add a **third** verification layer for
this feature specifically: rendering the worklet's actual output (via `OfflineAudioContext`,
which runs a full native Web Audio graph — including `AudioWorkletNode`s — synchronously to
completion without needing real-time playback, real credentials, or a live route) and
measuring it programmatically:

- **The FFT/IFFT round-trip is lossless on its own** — feed a known signal through
  forward-then-inverse FFT with no phase randomisation and no windowing, and confirm the
  output matches the input to floating-point tolerance. This isolates "is my FFT correct" from
  everything else, the same way `stretchParams`' own arithmetic was checked in isolation
  before it was ever wired into a node.
- **Output duration matches the stretch factor** — render N seconds of a known source at a
  known `stretchFactor` and confirm the rendered output's sample count is proportional (within
  the tolerance one synthesis hop introduces at the edges).
- **stretch = 0 is measurably silent from the worklet's own branch** — with the blend fully
  dry, confirm the worklet's contribution is exactly what A-8 already requires elsewhere:
  render with the blend forced to `fade = 0` and confirm the rendered output is
  sample-identical to the dry player alone.
- **No NaN/Infinity ever reaches the output** — render across the full range of `stretch`,
  `warp`, `morph`, `field` and confirm every sample is finite. Silence is an acceptable failure
  mode to defensively fall back to; `NaN` propagating into the audio graph is not.

## Risks worth naming plainly, not discovering mid-implementation

- The private-Tone-internals bridge (documented above) is the single biggest fragility risk.
  Guarded by a loud startup assertion, per the "two things honest upfront" section.
- `AudioWorkletProcessor` runs in its own restricted global scope with no `window`, no DOM,
  and no access to anything outside what's explicitly passed in — the FFT implementation and
  the whole synthesis loop must be self-contained, dependency-free JS, assembled into the
  worklet module's source as a string and loaded via a `Blob` URL (matching this project's
  own "one file" constraint — confirmed working in the browser this session, the same
  technique already used nowhere else in this codebase but well-supported by the platform).
- Browser support for `AudioWorkletNode` is broad in current Chrome/Firefox/Safari, but this
  is worth a real device check once built, not just a desktop-Chrome check, given this
  project's own established practice of verifying on real phones before calling audio work
  done.
- This entirely replaces `v.grainPlayer` and the `GrainPlayer`-specific code in `warpStep` —
  a real deletion of already-shipped, already-reviewed code, not just an addition. The
  implementation plan should delete cleanly rather than leave dead branches.

## Order of work

1. **The FFT** (forward + inverse, radix-2, power-of-2 sizes) as a pure, dependency-free JS
   function — verified in isolation (the round-trip-losslessness check above) before it is
   ever run inside a worklet, the same discipline `stretchParams`/`metricWeight` got earlier
   this session.
2. **The worklet processor** (the algorithm above, without warp/morph/field yet — just
   stretch) — verified via `OfflineAudioContext` rendering (duration-matches-factor,
   no-NaN, silent-branch-at-stretch-0).
3. **The native↔Tone integration**, replacing `v.grainPlayer` in `ensureVoice`, with the
   loud startup assertion for the private-internals bridge.
4. **warp/morph/field**, each added to the worklet's message-passed parameters and consumed
   inside the algorithm per the remapping above; `grit` needs no change at all.
5. **Cleanup** — delete the dead `GrainPlayer`-specific code from `warpStep`/`applyStretch`'s
   soundscape call site that no longer applies.

See [[audio-quality-bar]], [[verify-by-measuring]].
