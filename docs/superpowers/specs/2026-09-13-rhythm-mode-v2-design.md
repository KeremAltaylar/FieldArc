---
project: FieldArc
version: rhythm-mode-v2
status: design agreed 2026-09-13; no implementation plan written yet
baseline: main @ afcc943
---

# Rhythm mode v2 — idiom, sentences, and a per-hit stretch

A point's "four hits" mode plays a Euclidean pattern per voice already — evenly spread
pulses, in tempo, with a shared per-route effects room (filter/drive, delay, reverb). This
round makes that mode more musical without touching what already works: a continuous knob
that leans the pattern toward how a person would actually accent it, a phrase length that
lets the pattern evolve instead of looping forever, and a per-voice insert chain — bitcrush,
distortion, an independent delay, and a stretch control that shares its DSP core with the
soundscape sub-project's extreme warp — that sibling spec is not yet written, and this
document treats the stretch engine only as far as the hit-slot needs it.

## The idea worth protecting

Every control here is a knob, not a mode switch. Kerem's own answers during design settled
this repeatedly: idiom is a 0–1 blend, not "Euclidean vs. idiomatic"; the stretch is a
continuous morph through three characters, not three separate effects; sentence length is a
number of bars, not a preset. **Nothing here is a toggle that reads as a decision — it is all
a position on a line**, consistent with the studio rulebook's C-12 (every continuous parameter
is a knob) and A-9 (rates are musical divisions, shown as what they come to).

The second thing worth protecting: **nothing here tears down the running scheduler.**
`rhythmStep()` already recomputes each voice's Euclidean pattern fresh every sixteenth — it
is cheap, and it means a change to `cfg.pulses`/`cfg.rotate` is heard on the very next tick
with no rescheduling at all. Idiom, the sentence maker, and every new per-voice effect are
built to fit that same shape: they change what a value *is*, never how the loop is *wired*.
Per the studio rulebook's A-16, tearing down live scheduling to change a parameter is a
measured, repeatable source of bugs in exactly this kind of code, and this design has no
reason to reopen that door.

## Decisions taken

Agreed 2026-09-13 with Kerem. These are settled; the implementation plan should not reopen
them.

1. **Idiom is one knob per point**, not per voice. It biases playback accenting; it does not
   force pulse positions to move. The existing per-voice density bands and coprime-nudging in
   `randomRhythm()` already solve "does this pattern have a spine" at generation time — idiom
   layers a second, always-on effect on top: strong beats hit harder.
2. **The sentence maker changes data, not wiring.** A per-point bars-count triggers a
   phrase-boundary callback that rewrites `cfg.pulses`/`cfg.rotate` for each voice; the
   existing `Tone.Transport.scheduleRepeat(rhythmStep, SECT_GRID)` loop is never touched.
3. **One stretch engine, two knobs.** The per-hit-slot stretch and the soundscape player's
   extreme warp are the same underlying granular/stretch core, parameterised differently at
   the call site. Building two would duplicate exactly the code this project already has
   working (the `grains` mode's grain-cloud engine) for no benefit.
4. **New per-slot inserts sit *before* the shared route room**, not instead of it. The
   existing `buildRhythmFx` chain (filter/drive → send → delay → reverb, one instance shared
   by every rhythm point on the route) stays exactly as it is — it is the "room" every hit
   already plays into. Bitcrush, distortion, the per-slot delay and the stretch are inserts on
   each voice's own signal, upstream of that shared bus, the way a drum voice's own colouring
   sits before it reaches a shared reverb send.
5. **No new grant, no new audio library.** Everything is built from Tone.js primitives and
   Web Audio nodes already in use elsewhere in this file (`Tone.Gain`, `Tone.Filter`,
   `Tone.FeedbackDelay`, `Tone.WaveShaper`, `Tone.ToneAudioBuffer`, the existing granular
   scheduling in `fireGrains`). `makeBlend()` (two summed gains) is the mix-control primitive
   for every new dry/wet here, not `Tone.CrossFade` — A-17 already found and documented why
   `CrossFade`'s internal constant-source panner can silently pass no signal.

## Architecture

```
                    per-point, once                          per-voice, four times
   ┌────────────────────────────────┐        ┌──────────────────────────────────────────┐
   │ idiom (0–1)                    │        │ Tone.Player (existing)                    │
   │ sentenceBars (4–32, default 8) │        │   ↓                                       │
   └────────────────┬───────────────┘        │ stretch (0–1): dry ↔ grain-cloud ↔ smear   │
                     │ read every tick        │   ↓                                       │
                     │ (accent weight,        │ bitcrush (amount + mix)                   │
                     │  phrase boundary)      │   ↓                                       │
                     ▼                        │ distortion (WaveShaper, drive + mix)      │
   rhythmStep() — UNCHANGED SCHEDULING        │   ↓                                       │
   reads cfg.pulses/cfg.rotate fresh          │ per-slot delay (division, feedback, mix)  │
   every step, same as today                  │   ↓                                       │
                                              └──────────────┬───────────────────────────┘
                                                              ▼
                                              existing buildRhythmFx() room
                                              (filter/drive → send → delay → reverb)
                                                              ▼
                                                          bed.master
```

## Idiom

**Data:** `r.idiom` (0–1, default 0.35 — enough presence to be worth having, low enough that
0 remains a real, reachable "just Euclidean" state per A-8's own dry-default logic applied to
a generator rather than an effect).

**Effect, entirely inside `rhythmStep()`'s existing per-hit gain line:**

A step's *metric weight* is how strong a beat it is within the bar — the downbeat highest,
then quarter-note landmarks, then eighth-note landmarks, then everything else at a floor
weight. This is computed once per `steps` value (cached, not per-tick) as
`metricWeight(position, steps)`, purely a function of position and step count.

The existing per-hit gain line

```js
pl.volume.value = 20 * Math.log10(Math.max(0.02, (cfg.gain === undefined ? 1 : cfg.gain)))
                + (Math.random() - 0.5) * 1.5;
```

gains one more term: `+ idiom * metricWeight(at, steps) * ACCENT_DB` (a fixed ceiling, on the
order of 3–4 dB, so idiom at 1 accents strong beats audibly without a strong hit clipping
against the route's limiter). At `idiom = 0` this term is exactly zero — bit-identical to
today, satisfying the same "prove the dry path" test A-8 asks of an effect, applied here to a
generator's added shaping.

**Why this and not moving pulses:** moving *where* a pulse lands changes the pattern's
identity — a setter who dialled in `E(13,64) ↺2` sees that pattern in the panel and hears it
change under them with no visible cause if idiom silently reshuffles it. Accenting changes how
loud each hit is, which is exactly what the panel's own `gain` field already visibly governs,
so idiom rising never contradicts what is on screen. `randomRhythm()`'s per-voice density
bands and coprime-nudging remain the tool for "generate a pattern with a spine" — idiom is
orthogonal to it, not a replacement.

## The sentence maker

**Data:** `r.sentenceBars` (4–32, default 8, an integer — bars, not a musical division, since
a phrase is measured in bars regardless of the step grid underneath it).

**Mechanism:** `bed.rhythms[id]` already carries a per-point `tick`/`step` counter. It gains
one more: `bar` and `barsIntoSentence`, advanced by a new lightweight bar-boundary check
inside `rhythmStep` (which already runs every `SECT_GRID` tick and already knows the
subdivision arithmetic to detect a bar rolling over — no new `Transport.scheduleRepeat` call,
which would be a second clock to keep in phase with the first for no reason). When
`barsIntoSentence` reaches `r.sentenceBars`, the callback:

1. Picks the next entry from a small curated set of pulse/rotation combinations per voice —
   not a fresh random draw each phrase, which would fight `randomRhythm()`'s own coprime
   logic and could hand two voices the same count on the same phrase. The set is built once,
   at pattern-generation time, using the same band + coprime-nudge + de-dup logic
   `randomRhythm()` already has, sized to 3–4 variations per voice.
2. Writes the new `pulses`/`rotate` directly onto `cfg` for each voice.
3. Resets `barsIntoSentence` to 0.

Nothing else changes. The next `rhythmStep()` tick reads the new `cfg.pulses`/`cfg.rotate`
exactly as it reads today's, because it already recomputes the Euclidean pattern from scratch
every step — the phrase change is invisible to the scheduler and audible on the very next
downbeat.

**Variation, not randomness, per A-11 and A-12:** the curated-set approach means a phrase
change is a *related* pattern, not a coin flip — the same reasoning `defaultRhythm()`'s own
comment already gives for why 8/13/21/5 were chosen together. A future phrase should feel like
the same piece breathing, not four fresh dice rolls every 8 bars.

## The stretch engine

One function, `stretchVoice(buffer, amount, opts)`, called from two places:

- **Per hit-slot** (this project): `amount` is `cfg.stretch` (0–1, default 0). At 0, the
  existing one-shot `Tone.Player.start()` path is untouched — this is a new parameter with a
  real off position, not a mode switch on top of the existing playback.
- **Soundscape player** (the other spec): `amount` is a transport-level control over the
  whole recording, not a per-trigger one, since a soundscape is one continuous playback, not a
  sequence of retriggered hits.

**Behaviour across the range**, built on the grain-cloud machinery `fireGrains`/
`variedGrains`/the four-stage grain envelope already implement for `grains` mode — reused,
not reimplemented:

- **0.0–0.15:** no grains at all. `playbackRate` drops toward ~0.6× and `pl.detune` follows,
  which alone reads as "the same hit, deeper and slower" — cheap, real-time, no new nodes.
- **0.15–0.6:** a genuine grain cloud replaces the one-shot trigger, using the existing grain
  parameters (size, count, spread, scatter, envelope) at settings tuned for a *short* source
  (a hit's sample is seconds, not the minutes a soundscape recording might be) — smaller grain
  counts and a shorter overall cloud duration than the soundscape end of the range uses.
- **0.6–1.0:** grain density and overall cloud duration both keep climbing, and grain pitch
  variance (`vary`) rises with it — the same texture the existing `grains` mode already makes
  at its own high-density settings, arrived at from the opposite end of a continuous knob
  instead of being a separate mode a setter has to choose into.

There is no discrete "now it's Paulstretch" boundary — the top of the range is a lot of
short, overlapping, pitch-varied grains stretched across a long duration, which is what
Paulstretch *is*, functionally, without needing an FFT phase-randomisation implementation this
project does not otherwise have a use for. `stretchVoice` takes a `maxDuration` option
specifically so the hit-slot caller can cap how long a single "stretched hit" is allowed to
ring (a hit that never ends is not a hit), while the soundscape caller leaves it effectively
unbounded.

## New per-slot inserts

Each of the four `HIT_SLOTS` gains its own small chain, built once per slot when
`ensureRhythm()` creates that slot's `Tone.Player` (never torn down while the point is in
range, same lifecycle the player itself already has):

- **Bitcrush** — `cfg.crush` (0–1, default 0) drives a `Tone.BitCrusher`-equivalent (bit
  depth from 16 down to ~2 as the knob rises) blended via `makeBlend()`, default fully dry.
- **Distortion** — `cfg.drive` per voice (0–1, default 0) into a `Tone.WaveShaper` using the
  same `tanh` curve shape `buildRhythmFx`'s own drive already uses (consistency of character
  between the shared room's drive and each voice's own), through `makeBlend()`.
- **Per-slot delay** — `cfg.delayDiv` (a musical division, from the same `DIVISIONS` array
  and `divSeconds()` helper the shared room and the synth voices already use — A-9's "every
  rate is a division of the bar, shown as what it comes to"), `cfg.delayFb`, `cfg.delayWet`.
  A short `Tone.FeedbackDelay` per slot, independent of the shared room's own delay — a
  voice's own slap-back, not a second trip through the same room.

All four new per-voice parameters (`stretch`, `crush`, `drive`, `delayDiv`/`delayFb`/
`delayWet`) default to their off position. A point saved before this version existed gains
them at those defaults the same way `rhythmOf()` already backfills missing fields today —
field by field, never resetting what a setter already chose.

## Data model

`f.properties.rhythm`:
```
{
  on, steps, div, gain, swing,        // unchanged
  idiom: 0.35,                        // new, per point
  sentenceBars: 8,                    // new, per point
  sentenceSet: { low: [...], mid: [...], high: [...], rand: [...] },
                                       // new, generated alongside pulses/rotate, not setter-facing
  voices: {
    low:  { pulses, rotate, gain, pitch,      // unchanged
            stretch: 0, crush: 0, drive: 0,   // new
            delayDiv: "8n", delayFb: 0, delayWet: 0 },  // new
    mid:  { ... }, high: { ... }, rand: { ... }
  }
}
```

`rhythmOf()` gains the same field-by-field backfill it already does for `grains` — `idiom`,
`sentenceBars`, `sentenceSet`, and each voice's four new fields default in independently, so
an archive exported before this version imports cleanly.

## UI

Two new rows join `RHYTHM_FIELDS` (idiom, sentence length) — same declarative row-builder,
same panel, no new UI surface. Each hit-slot's existing inline
`[["pulses"...], ["rotate"...], ["gain"...]]` row gains four more sliders in the same style:
stretch, crush, drive, and the delay division/feedback/mix trio (matching how the shared
room's own delay controls are already laid out in the route's Patch panel). "Generate a
pattern" continues to call `randomRhythm()` unchanged; it now also seeds `sentenceSet` from
the same density-band logic at generation time.

**Decided 2026-09-13, after the first design pass:** eight sliders per voice (sixteen total,
on top of the existing three) is a lot to dial in by hand for someone who mostly wants "make
it sound interesting," so the new effects get their own randomize action rather than only
manual sliders. A second ghost button, "Randomize effects," sits next to "Generate a pattern"
in the same header and calls a new `randomHitFx(r)` — the same shape as `randomRhythm()`, but
rolling `stretch`/`crush`/`drive`/`delayDiv`/`delayFb`/`delayWet` per voice within modest
default bands (mostly low stretch and crush, occasional higher outliers, a random musical
division for each voice's delay) rather than a full 0–1 uniform draw, so a click lands
somewhere usable rather than somewhere extreme most of the time. It is deliberately a
separate action from "Generate a pattern": a setter who has a pattern they like should be able
to reroll only its effects, and vice versa. The sliders stay — this is an additional path to a
result, not a replacement for hand-tuning one voice's drive.

## Verification

Per the studio rulebook's `verify.md` and this project's own [[verify-by-measuring]] standing
rule — measured, not assumed:

- **A-8, applied to idiom:** `idiom = 0` must produce bit-identical gain values to the
  pre-this-version code path. Diff the computed `pl.volume.value` at idiom 0 against the
  current `main` branch's formula for the same inputs.
- **A-8, applied to crush/drive/per-slot delay:** each at 0 must be silent in the processed
  signal — the dry path only. Bypass test per A-8's own method: null the wet branch and
  confirm the output is bit-identical to the unprocessed player output.
- **A-9:** the per-slot delay's shown value must match `divSeconds(cfg.delayDiv, tempo)` at
  the route's current tempo, re-displayed when tempo changes, the same as the shared room's
  delay already does.
- **A-16:** confirm no `Tone.Transport.scheduleRepeat`/`clear` call is added anywhere in this
  feature — grep the diff for it. The only new state is data (`cfg.pulses`, `barsIntoSentence`,
  etc.), read by the loop that already exists.
- **A-2/A-3:** every new gain node (bitcrush mix, drive mix, delay mix, stretch cloud) ramps,
  never jumps; grain envelopes reuse the existing four-stage envelope's floors.
- **Sentence boundary, measured on the Transport clock:** start a point with `sentenceBars=2`
  at a known tempo, log `cfg.pulses` at every bar for 8 bars, and confirm it changes exactly
  every 2 bars, not sooner and not by drifting.
- **Stretch continuity:** sweep `cfg.stretch` from 0 to 1 in a browser and confirm there is no
  audible seam at the 0.15/0.6 internal boundaries named above — they are where the
  implementation's behaviour changes, not where the knob should sound like it jumps.

## Order of work

This is more than one implementation plan should carry cleanly. It decomposes into three,
each leaving the app working on its own:

1. **Idiom + sentence maker.** Both operate purely on data `rhythmStep()` already reads;
   neither needs a new audio node. Lowest risk, and it is the "make the existing four hits
   more musical" half of the ask on its own.
2. **The shared stretch engine**, built and proven against the hit-slot use first (shorter
   material, easier to audition quickly), with the soundscape player's own call site left for
   the sibling spec once the engine itself is solid.
3. **Per-slot bitcrush/distortion/delay inserts.** Independent of 1 and 2; can land before or
   after either.

See [[audio-quality-bar]], [[instrument-design-language]], [[studio-toolchain-plan]].
