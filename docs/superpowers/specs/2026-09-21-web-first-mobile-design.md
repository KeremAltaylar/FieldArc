# Web-first mobile — design

**Decision (Kerem, 2026-09-21):** Fieldscape stays a web app. No Capacitor wrap, no native
rewrite, no store. Everything below is what "web-first" has to be worth.

## Why this decision

The question was whether the sound problems justify a native app. Measured across this day:

- The reverb layer, not the synths, was the Android cost. Three `Tone.Reverb` convolvers were
  ~90 % of the route stack (60.9 % of a desktop core against the FM synths' 6.6 %).
- A PaulX stretch voice is 2.15 % of realtime. The recordings — the actual archive — are nearly
  free. Only the generative layer was ever expensive.
- After the cuts shipped (Freeverb rooms, Vibrato warp, no delay lines on phones, `latencyHint`
  0.05), the phone path renders at 34.7 % against the unchanged desktop path's 122 %.

So the glitching is a tuning problem, and tuning is cheaper in the browser than a rewrite.

**But the real limit is not CPU.** Fieldscape is a forty-minute outdoor walk with the phone in a
pocket. Today that needs `wakeLock.request("screen")` — the screen stays on for the whole walk —
and `bed.resumeLoop` restarts the audio context every 5 s because Chrome suspends it anyway.
That is policy, not performance: a web page is not allowed to be a background companion app.

Native would fix it and costs months, two codebases, and (for iOS) $99/yr plus a Mac that does
not exist here. **The cheap shot has not been taken yet**: a `MediaSession` and a silent looping
`<audio>` element are the standard way to make Android Chrome treat a page as a real media
session and keep it alive backgrounded. The app has neither. That is days, not months, and if it
holds, the native question closes for now.

## What this design covers

1. **Background audio.** Sound survives the screen going off and the app being backgrounded, on
   Android Chrome, without holding a screen wake lock for the whole walk.
2. **A mobile test loop that does not go through Kerem.** Every mobile finding so far has been
   relayed by hand. Chrome on Android exposes DevTools over `adb`; that is scriptable from here,
   against an emulator or a real phone.
3. **Layout regressions caught without a device**, at real phone viewports.
4. **The PWA gaps that stop it being an app on iOS** — no `apple-touch-icon`, no iOS meta, an
   SVG-only manifest icon that iOS ignores for the home screen.
5. **A redirect loop guard** in `404.html`.

## What it deliberately does not cover

- **Further audio cuts.** The next levers (the third voice ~11 points, the sector counter-line
  ~12) each cost a musical line, and nothing should be cut on a guess. Task 1 produces real
  numbers from a real device; the decision comes after, with Kerem, not inside this plan.
- **iOS background audio.** Safari does not allow it. On iPhone the web path has a lower ceiling
  than on Android, and no amount of work here changes that. iPhone stays the weaker experience
  until Apple is paid for. This is accepted, not solved.
- **Native anything.** Revisit only if background audio fails on Android after Task 3.

## Constraints

- **No build step.** `index.html` is one ES5 file served as-is. Nothing may introduce bundling.
- **No new runtime dependency.** Tooling may use devDependencies; the shipped page may not gain
  a library.
- **The archive is the point.** Nothing may reduce recording fidelity or drop a recording voice
  to save CPU — the generative layer is what gets cut, never the field material.
- **Desktop is unchanged.** Every mobile concession is gated on `smallDevice()`; a desktop keeps
  convolution reverb, chorus warp, delay lines and the full voice stack.
- **Verify by measuring.** A claim about audio timing measured against this harness's
  AudioContext is worthless — its clock runs at ~0.2× real time. Offline renders and Node
  benchmarks are valid; live-context timing is not.

## Background audio: how it is supposed to work

Android Chrome keeps a page's audio alive when the page owns an active *media session*. A pure
WebAudio graph does not create one. The established pattern:

1. A silent, looping `<audio>` element, played once from the same user gesture that starts Sound.
   Its playback is what makes the page a media session.
2. `navigator.mediaSession.metadata` so the lock screen shows the walk rather than a blank card,
   and `playbackState`.
3. `mediaSession.setActionHandler` for `play`/`pause`/`stop` so the lock-screen controls and
   headphone buttons drive `bedStart`/`bedStop` instead of doing nothing.

If that holds, `keepAwake` no longer needs to fight for the screen during a listen — it stays for
tracing (where the map must be visible) but a plain listening walk can run with the screen off.
Whether it holds is a device question, answered in Task 3 by measurement, not by assertion.
