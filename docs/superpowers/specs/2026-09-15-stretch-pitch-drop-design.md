---
project: FieldArc
version: stretch-pitch-drop
status: design agreed 2026-09-15; no implementation plan written yet
baseline: main @ 05269c1
---

# Stretch also drops pitch — a bounded, musical amount, decoupled from the time ratio

Kerem's own words: *"be sure about that stretch lengthens and warps the sound file (not
dry/wet mix of the warped file — it starts to go to x200 length like you do in Paulstretch
or Ableton Live's clip view.) ... I want audio files to be longer than the original one and
lower than the original one in frequency ... you are shortening it, x200 means x200
slower."* Read plainly: turning `stretch` up should make the material sound like it's
physically slowing down — tape or vinyl at a lower speed — not just longer while staying at
the same pitch. The existing worklet (`docs/superpowers/specs/2026-09-14-real-paulstretch-
worklet-design.md`) deliberately preserves pitch while stretching time; this spec adds a
genuine pitch drop back in, without reintroducing the exact problem pitch-preservation was
built to solve.

## The constraint that shapes this whole design

Literal tape-style slowdown ties pitch to the stretch ratio directly: at a real x200
slowdown, a typical field recording's content (roughly 200Hz-5kHz) would drop to
1Hz-25Hz — below or at the very bottom edge of human hearing. That is *why* `GrainPlayer`'s
old engine fell apart past ~6-7x and why the phase vocoder was built pitch-preserving in the
first place (see the prior spec's own opening). Tying pitch to `stretchFactor` directly
would silently recreate that failure at the top of the stretch range — the exact opposite of
what this feature is supposed to deliver.

**Decided (confirmed with Kerem):** pitch drop is bounded and decoupled from the time
ratio — a separate, capped mapping from the same `stretch` knob, not `pitch = original /
stretchFactor`. At `stretch = 1` (x200 time), pitch drops by a fixed, musical amount — 2
octaves — never further, so the effect stays audible and characterful across the entire
knob range instead of going silent or turning to a sub-bass thump partway up it.

```
pitchCents = -2400 * clamp(stretch, 0, 1)     // 0 at stretch=0, -2400 (-2 octaves) at stretch=1
pitchRatio = 2 ^ (pitchCents / 1200)          // the multiplicative frequency ratio applied
```

Cents (1200 = one octave) is the same unit the reference implementation
(github.com/essej/paulxstretch, `ProcessedStretch.h`'s `pitch_shift.cents`) uses for exactly
this kind of control — confirmed by reading its real source, not assumed. -2400 is a
starting value tuned by ear during implementation, not a load-bearing constant; the
implementation plan should leave it easy to retune in one place.

## Two different mechanisms already look similar in this codebase — they are not

`warpStep`'s existing `warp` knob already does something that LOOKS like a frequency shift:
`_synthesizeOneHop`'s bin lookup is `srcBin = ((i - warpBins) % windowSize + windowSize) %
windowSize` — every output bin borrows magnitude from a bin a fixed OFFSET away. This is an
**additive** shift (every partial moves by the same number of Hz), which is what real
frequency-shifters (ring modulators) do — it does not preserve harmonic ratios, which is
exactly why `warp`'s own hint text calls it "a wobble," not a pitch shift, and why it sounds
detuned/inharmonic rather than musically transposed at any real amount.

A true pitch shift needs a **multiplicative** bin lookup instead — every partial's frequency
scaled by the same ratio, which is what actually preserves harmonic relationships (500Hz +
3000Hz shifted down an octave becomes 250Hz + 1500Hz — same 1:6 ratio, still sounds like one
coherent sound, just lower). This needs a second, separate lookup step in the same place
`warpBins` already applies its own — not a repurposing of `warpBins` itself, which must keep
doing exactly what it already does for `warp`.

```
srcBin = Math.round(i / pitchRatio)     // multiplicative: preserves harmonic ratios
```

For `pitchRatio < 1` (any downward shift), `srcBin` runs past the meaningful spectrum for
higher output bins — there is no source content to pull from up there. **This must go
silent for those bins (magnitude 0), not wrap around** the way `warpBins`' own modulo
arithmetic already does for its offset. Wrapping here would pull spurious high-frequency
content back in from the "other end" of the spectrum — physically wrong for a pitch drop,
and likely to sound like a distinct, audible artifact rather than a clean transposition.
`warp`'s own wrap-around behavior is unaffected and untouched; it is a different, already-
accepted character of a different knob.

**Composing the two:** apply the pitch-ratio lookup first, then `warpBins`' own additive
offset on top of the result — `warp`'s wobble should still audibly jitter the now-lower
pitch, not be computed against the original, unshifted spectrum and then discarded.

```js
var pitchBin = Math.round(i / pitchRatio);
var mv = (pitchBin >= 0 && pitchBin < windowSize) ? mag[pitchBin] : 0;
srcBin = ((/* map mv's own bin */ pitchBin - warpBins) % windowSize + windowSize) % windowSize;
```

(The exact composition — whether `warpBins` re-indexes into `mag` again after the pitch
lookup, or is applied as a second pass on the already-pitch-shifted array — is an
implementation-plan-level detail with more than one workable shape; the requirement this
spec fixes is only the ORDER — pitch ratio's zero-fill first, `warp`'s wrap-around offset on
top of whatever that produces — and that `warp` must still visibly/audibly do its own job at
every non-zero `stretch` value, not be silently canceled by the pitch lookup's zero-fill.)

## Where this plugs in

`pitchRatio` becomes a fifth field in the worklet's `params` object (alongside
`stretchFactor`, `warpBins`, `morphRate`, `synthesisHop`), defaulting to `1` (no shift) —
consistent with every other param's own "0/1 = untouched" convention. Computed identically
at all three existing call sites that already compute `stretchFactor` from `q.stretch`
(`ensureVoice`'s ready-branch, `warpStep`, `commitLive`) — the same pattern those three
already follow for `stretchFactor` itself, so this is one more field alongside work already
being done at each site, not a new code path.

`synthesizeHop`'s own signature gains one parameter (`pitchRatio`), threaded through from
`_synthesizeOneHop`'s call exactly the way `warpBins` already is.

## What does NOT change

- `stretch = 0` is still bit-identical to the dry recording — `pitchRatio` defaults to `1`
  (identity), and at `stretch = 0` nothing in this spec's own mapping produces anything
  else. A-8 (the prior spec's own global constraint) is unaffected.
- `warpBins`'s own wrap-around behavior, its own random-walk update in `warpStep`, and its
  own UI copy are untouched.
- `morph`, `field`, `grit` — untouched, no interaction with this feature at all.
- The waveform/cursor visualization shipped this session reads `q.stretch`/`q.morph` only;
  it has no pitch dependency and needs no change.
- No new slider, no new field in `f.properties.sound` — this is derived entirely from the
  existing `stretch` value, per Kerem's own confirmed choice (a bounded amount tied to the
  same knob, not an independent control).

## Verification

Same discipline the original worklet spec used — automated tests plus a real
`OfflineAudioContext` render, not source-pattern assertions alone, since "does this sound
right" still can't be asserted from text:

- **Ratio math, in isolation:** `pitchCents`/`pitchRatio` at `stretch = 0` (0 cents, ratio 1)
  and `stretch = 1` (-2400 cents, ratio exactly `0.25`, i.e. two octaves down) — a plain
  arithmetic check, the same style `stretchedDurationInfo`'s own tests already use.
- **The bin lookup, via the existing `loadPaulstretchProcessorClass()` sandbox** (runs the
  real assembled worklet source, not a description of it — same technique already proven
  this session for the position-reporting tests): feed a synthetic tone at a known
  frequency, confirm the resynthesized magnitude spectrum's peak lands at `pitchRatio ×`
  that frequency, not at the original. Check the magnitude spectrum `_synthesizeOneHop`
  computes internally, not the time-domain output — phase is randomized every hop by
  design, so only the magnitude side of the round-trip is meaningful to assert against.
- **Zero-fill, not wrap:** confirm a bin whose `i / pitchRatio` lookup falls outside
  `[0, windowSize)` produces exactly `0` magnitude, never a wrapped value from the opposite
  end of the spectrum.
- **`stretch = 0` still silent from this feature specifically:** `pitchRatio = 1` produces
  `srcBin = i` for every bin before `warpBins`' own offset — i.e., provably a no-op, not
  merely "sounds unchanged."
- **No NaN/Infinity** across the full `stretch` range, `warp` on and off, same discipline the
  original spec's own render checks already apply.
- **Live confirmation, `OfflineAudioContext`:** render at `stretch = 1` and confirm the
  output's own dominant spectral content sits measurably lower than the source's — not just
  that the math above is correct in isolation, the same "prove it against the real thing"
  standard the original worklet plan held itself to for its own extreme-stretch case.

## Order of work

1. `pitchCents`/`pitchRatio` as a small pure function (`stretchPitchRatio(stretch)` or
   similar), tested in isolation before it touches the worklet, matching this project's own
   established pattern for every other piece of stretch-related arithmetic.
2. `synthesizeHop`'s bin lookup, extended to take `pitchRatio` and apply the zero-fill
   multiplicative lookup ahead of `warpBins`' existing offset — verified via the processor
   sandbox (known-frequency-in, shifted-frequency-out) before it is wired into any message
   protocol.
3. The worklet's `params` object gains `pitchRatio` (default `1`), and the three call sites
   (`ensureVoice`, `warpStep`, `commitLive`) each send it alongside `stretchFactor`.
4. Live `OfflineAudioContext` verification against the real assembled worklet, the same
   rigor the original stretch factor and the position-reporting feature both got.

See [[audio-quality-bar]], [[verify-by-measuring]], [[2026-09-14-real-paulstretch-worklet-design]].
