---
project: FieldArc
version: paulxstretch-port
status: design agreed 2026-09-18 with Kerem (scope, pitch, extras answered); plan at docs/superpowers/plans/2026-09-18-paulxstretch-port.md
baseline: main @ 463de82 + always-wet change (uncommitted)
---

# The soundscape becomes PaulXStretch

Kerem, 2026-09-18: *"add other features and musicality of the paul stretch to mechanism"*,
with a screenshot of PaulXStretch. Earlier the same day: *"the signal should always be wet so 0
means 0 stretch"* — already done: the bed is always the engine, the dry player is only a
failure fallback.

Reference: github.com/essej/paulxstretch, `Source/PS_Source/` — `Stretch.cpp` (engine),
`ProcessedStretch.h` (spectral modules), `BinauralBeats.*`, `PluginProcessor.cpp`
(parameter ranges, defaults, FFT-size mapping). Every DSP function here is a port of a named
function there, and says so in its comment.

## Decisions (asked and answered)

| Question | Answer |
| --- | --- |
| Scope | Everything but Free filter: Stretch, FFT size, Freeze, Onset, Sound start/end, Loop xfade, and the chain Harmonics, Tonal vs Noise, Frequency shift, Pitch shift, Ratios, Spread, Filter, Compressor, plus Binaural beats |
| Pitch | Separate, like the original: stretch no longer drops pitch; Pitch shift ±24 semitones, default 0 |
| warp / morph / field / grit | Kept, grouped as FieldArc extras after the PaulXStretch controls |

## What the port changes in the engine

The current worklet is "a phase vocoder with random phase", not PaulXStretch's engine. Measured
against the source, four structural differences, all ported:

1. **Frame and hop.** PaulXStretch's "FFT size" is the *hop* (`bufsize`); the window is
   `2*bufsize`, Hamming (`0.53836-0.46164*cos(2πi/(N+1))`), 50% overlap. Ours is a 4096 Hann
   window at 75% overlap. The slider maps 0–1 to `2^(7+10x)` exactly as `setFFTSize` does
   without prebuffering (0.70 → 16384, matching Kerem's screenshot), rounded to a power of 2.
2. **Resynthesis.** No synthesis window. Each output hop crossfades the new frame's second half
   against the previous frame's first half with a raised cosine, multiplied by
   `(h - (1-h)cos(2πi/bufsize)) * 2`, `h = 0.853553390593` (`Stretch::process`). DC and Nyquist
   are zeroed; phase is uniform in 32768 steps.
3. **Input stepping.** A three-chunk window (`very_old | old | new`) with a fractional
   `remained_samples` start, `skip_samples` for ratios above one chunk per hop, primed full at
   start so a high stretch does not open on silence. Stretch knob 0–1 maps to `1024^x`
   (the original's range tops at 1024); saved points migrate so their factor is unchanged.
4. **Per-channel stretchers.** A stereo recording gets two stretchers with independent random
   phase (today the right channel is discarded); a mono one is duplicated to both sides.

Plus Freeze (stop advancing), Onset detection (`do_detect_onset` + `here_is_onset`: a detected
transient snaps to a new input chunk and pays the time back with credit), and a play range with
a loop crossfade in seconds.

## The one deliberate deviation

`spectrum_do_pitch_shift` sums magnitudes when shifting down and duplicates bins when shifting
up, so level moves with pitch: +6 dB two octaves down. Rulebook A-18 (a timbre control must not
be a level control) is Kerem's rule, so the port sums **power** going down and scales by
`1/sqrt(ratio)` going up. It is used by Pitch shift and Ratios. Everything else is literal,
including the aliasing in `spectrum_spread`'s call from Tonal vs Noise.

## Running a 32768-sample FFT on a phone's audio thread

A render quantum is 128 samples, 2.67 ms at 48 kHz. One hop at the default size is two
32768-point FFTs plus the chain — several milliseconds of JS in a single `process()` call, which
drops out. The next hop is therefore computed as a **generator job** that yields after each FFT
stage, each module and each harmonic, and `process()` advances it by a step budget sized so the
job finishes within the current hop (steps per hop ÷ quanta per hop × 1.5). If a quantum reaches
the hop boundary with the job unfinished, it is drained synchronously — a late frame, never a
missing one.

## Level

Measured, never assumed: with every module at its default, the engine's RMS must sit within
1.5 dB of the source's at stretch ×1, ×10 and ×100, and at FFT sizes 0.3, 0.5 and 0.7. If the
ported constants (`ampfactor 2.0`) do not land there with our FFT scaling, one global makeup
constant is measured and recorded.

## Panel

```
 THE AMBIENT BED
 [ waveform: dim outside start/end · live cursor                                   ]
 12.4 s recording → 3h 32m per pass (×1024) · window 0.68 s
 ┌ STRETCH ───────────────┐ ┌ SPECTRUM ── in order ─────┐ ┌ RATIOS ────────────── ⏻ ┐
 │ stretch      ×1024     │ │ ⏻ HARMONICS               │ │ 1 ─○──── ×0.25  ─○─ 0.00 │
 │ fft size     16384     │ │   count 10 · base 128 Hz  │ │ …eight rows…            │
 │ onset        0.00      │ │   bandwidth 25 ¢ · gauss  │ ├ BINAURAL BEATS ────── ⏻ ┤
 │ freeze       off       │ │ ⏻ TONAL VS NOISE          │ │ power 0.50              │
 │ start        0 %       │ │ ⏻ FREQUENCY SHIFT  0 Hz   │ │ beat 4.00 Hz            │
 │ end          100 %     │ │ ⏻ PITCH SHIFT     0.0 st  │ │ mode left-right         │
 │ loop xfade   0.01 s    │ │ ⏻ SPREAD · FILTER · COMP  │ └─────────────────────────┘
 ├ EXTRAS ────────────────┤ └───────────────────────────┘
 │ warp · morph · field · grit                          
```

Headings carry a power toggle (`aria-pressed`), as the original's modules do; a module that is
off keeps its controls editable and dims them. Every readout is in real units (×, samples/s,
Hz, cents, semitones, %). Double-click reset and shift-fine drag come from the existing global
range handlers via `data-def`. Below 1000 px wide, or under 700 px tall, the three columns
become three tabs — Stretch · Spectrum · Ratios & binaural — with the waveform above them in
every tab. `scrollHeight - innerHeight` must be 0 in every layout (C-8).

## Out of scope

Free filter (its curve editor), module reordering, capture/record, the dry-playrate control,
Num ins/outs.
