# Stretch engine: notes

Run every check with `python tests/run.py`. It builds with em++ and runs under node by default;
`CXX=c++ python tests/run.py` builds natively instead. It prints the pass/fail table and exits 0
only if every row passes.

Files: `core/devices/stretch.cpp` (device, registered as `"stretch"`), `core/devices/fft.hpp`
(FFT), `core/fieldscape.h` (+ `fs_set_source`, `fs_stats`), `core/device.hpp`, `core/core.cpp`,
`tests/run.py`, `tests/stretch_test.cpp`.

## Design choices

- **FFT.** A mixed-radix complex FFT (radix 4, 2, 3, 5), Stockham autosort, with a single twiddle
  table. Both channels go through one complex transform (left in the real part, right in the
  imaginary part). They are separated in the spectrum as `(Z_j ± conj Z_{N-j})/2`, and the inverse
  runs the same forward passes on `conj(Y_left + i*Y_right)`. So a stereo frame costs one forward
  and one inverse transform. The largest relative error against a direct DFT is 1.7e-7.
- **Spreading the CPU (a change from the spec's real-time form).** The spec computes the next
  frame in whichever callback finds the queue short. At T = 2 s that is a 96000-point frame in one
  128-sample callback, which cannot fit in 1.33 ms. Instead, each voice plays one hop while it
  builds the next. The frame's work is a list of weighted stages (read, each FFT pass, magnitudes,
  phases, each inverse pass, overlap-add), and each stage can be cut into item ranges. Each
  callback does its share, so the frame is ready half-way through the current hop. A new window's
  table setup (window, twiddles, gain) goes through the same scheduler. The cost is one hop of
  latency: a voice starts with one silent hop, then the first frame's rising half. Late frames
  would be counted, but none occurred.
- **Width.** Every bin draws one shared phase φ, plus one offset per channel δ_c, uniform in
  [−π, π). Channel c uses φ + width·δ_c. At width 0 all channels share the phase, and at width 1
  the channels are independent and uniform. The magnitudes are never touched, so the level is
  exactly the same at every width. Correlation falls smoothly as width rises. Measured spread
  across width 0–1: 0.01 dB.
- **Onset mapping.** θ = 1 − onset. `onset = 0` runs the plain mechanism: no onset code runs, and
  θ would be 1, which m (clamped to [0, 1]) can never exceed. `onset = 1` gives θ = 0, the most
  sensitive setting. The test uses 0.5.
- **Normalisation gain (derived, not tuned).** Random phases spread a frame's energy Σb² evenly
  over its N samples. Windowing again and overlap-adding two independent frames gives a mean
  output/input power ratio of R = (Σw²/N) · (1/H) Σ_m (w[m]² + w[m+H]²) h[m]², with h = 1 for the
  original shape. The device multiplies by 1/√R, which is about 1.44 (+3.2 dB) for the original
  window. `tests/run.py` derives the same formula separately and divides it out for check 1 (the
  reference applies no gain).

## Decisions the spec left open

1. Sections 2 and 6 disagree on reading past the end. I made the read circular everywhere,
   including inside a frame, with no zero padding and no seam fade. A source whose end does not
   meet its start will spread some broadband energy over the frames that span the seam (not
   measured; seam crossfade is deferred per the spec).
2. Stretch smoothing: log S goes through a one-pole filter once per frame, with a 100 ms time
   constant. At large windows that is effectively instant, which is fine because the frames
   themselves crossfade.
3. Freeze sets the read step to exactly 0, with no smoothing. In onset mode it stops τ, so no new
   frames are read and the current blend repeats with fresh phases.
4. Window or shape change. A second voice starts at the new N. It reads from the old voice's next
   read position, re-centred by (N_old − N_new)/2. It waits one new window, until it reaches full
   overlap (a silent hop, then a half-window rise), then takes over with an equal-power crossfade
   over one window. The two voices are uncorrelated, so equal-power keeps the level. A change that
   arrives during a crossfade waits until the crossfade ends, then the latest value applies. The
   window parameter itself is not smoothed.
5. Onset-mode edges. Entering onset mode sets τ = 0 and credit = 0 and reads the next frame, with
   A_prev taken from the last magnitudes. On a voice's first frame, A_prev = A_cur and
   B_{t−1} = B_t (so m = 0). The source uses zeros there, which fades in from silence.
6. Nyquist under width: its sign is the sign of cos(channel phase), so at width 0 it is shared too.
7. RNG. The device's PCG32 is seeded from `seed` at prepare. Each voice gets its own PCG32, seeded
   from the device's. Output therefore does not depend on callback size; check 7 confirms this for
   128 vs 480. `seed` is capped at 2^24 so it stays an exact float.
8. `fs_stats` fields:
   - `underruns`: `fs_process` calls that took longer than the audio they produced (timed in core
     for every device).
   - `late_frames`: frames that were not ready at their hop.
   - Also `frames` and `wraps`, which check 2 uses.
9. `fs_set_source` has no lock. The host calls it from the audio thread or while stopped. When a
   new source arrives, the read positions wrap to the new length. Channels beyond 2 are ignored.
   `frames = 0` or NULL means silence.
10. Buffers are sized at prepare for T = 2 s at the prepared sample rate, for two voices.

## How the checks measure (where the spec left it open)

- **1:** S = 8 and T = 0.25 s at 48 kHz, on pink noise and on a speech stand-in. The reference is
  `reference/paulstretch_stereo.py`, with only its two I/O lines patched at run time into `build/`.
  The first and last second are dropped (start-up, and the reference's end fade). Bands run from
  31.5 Hz to 16 kHz and count only when they are within 50 dB of the loudest band.
- **2:** frames × H at the moment the read position first wraps. That is the reference's own
  definition of output length (it writes frames until `start_pos >= n`), so being within one hop
  follows by construction. The measurement confirms the counter matches.
- **3:** "RMS in" means the span of input the frames actually read. At S = 1024 the read position
  moves about 1 sample per frame, so only a few thousand samples are stretched, and their local
  level differs from the whole file's. The table prints both. Against the whole file, the worst
  cell (S = 1024, T = 0.05) varied from −0.2 to −1.1 dB between noise realisations. Against the
  span read, it was −0.02 to −0.75 dB. That cell's error comes from the input, and its margin is
  the thinnest in the table.
- **4:** pink noise brick-walled at 4 kHz (circular, so no seam) is played for 90 s. Stretch,
  window (0.02–2 s, log) and width sweep on slow LFOs, set every 128-sample callback. The energy
  above 10 kHz is measured with 1024-point Blackman-Harris frames every 10 ms.
- **5:** the first 2 s are skipped (start-up). Dropout means any 10 ms block more than 20 dB below
  the mean.
- **6:** the input is one 0.3 s decaying noise burst (τ = 30 ms) after 2 s of silence, with T = 0.34
  and onset = 0.5. Rise is measured on a 10 ms RMS envelope smoothed over 50 ms: the time from the
  last point below −20 dB of peak to the peak.
- **8:** timed with `std::chrono::steady_clock` inside `fs_process`, 40 s per case.
- **9:** one Voice is stepped stage by stage (third frame, so overlap-add has a partner), and the
  device output is checked as well.
- `scipy.signal` is blocked on this machine by an Application Control policy. The analysis uses
  numpy only; the reference needs only `scipy.io.wavfile`, which loads.

## Unverified

- Native clang/gcc and Android NDK builds. The only compiler used was em++ (clang → wasm). The code
  is plain C++17 and builds clean with `-Wall -Wextra -pedantic -Wshadow`.
- CPU anywhere except node/wasm on this PC. Phones, iOS and AudioWorklet timing are untested, and
  CPU was only measured at a 128-frame callback.
- Sample rates other than 48 kHz.
- Seam behaviour with non-circular sources (decision 1).
- Calling `fs_set_source` while audio is running.
- Onset mode combined with a live window change: the new voice starts fresh onset state. This was
  exercised only by the determinism check, and its sound was not measured.
- Test 10 (Kerem's ear). Real Fieldscape recordings.
