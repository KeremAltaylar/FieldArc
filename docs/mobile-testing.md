# Testing Fieldscape on a phone

## A real Android (use this for anything about sound or load)

1. Phone: Settings → About → tap Build number 7 times → Developer options → USB debugging on.
2. Plug in over USB. Accept the RSA prompt on the phone.
3. Open Chrome on the phone, on any page.
4. Here: `npm run phone -- devices` — the phone should be listed.

Then, for example:

    npm run phone -- open https://keremaltaylar.github.io/Fieldscape/diag.html
    npm run phone -- eval "document.title"
    npm run phone -- console 20

## The emulator (layout only)

    npm run emulator
    npm run phone -- devices

**Do not judge audio on the emulator.** It runs x86 on this machine's CPU and its audio output
is a host-side shim; a clean run there is not evidence that a real phone is clean.

## Why not just read numbers off the phone by hand

Every mobile finding in this project up to 2026-09-21 was relayed verbatim between a phone screen
and this session. That is slow and it loses detail. The driver above removes the relay.

## Before the emulator will start

`sdkmanager`, `avdmanager` and the emulator all need a JDK, and `JAVA_HOME` is not set globally on
this machine — a fresh shell will fail with a bare "JAVA_HOME is not set" and no hint about which
Java. It is installed; point at it for the session:

    export JAVA_HOME="/c/Program Files/Microsoft/jdk-21.0.12.101-hotspot"
    export PATH="$JAVA_HOME/bin:$PATH"

Recorded here because an agent working on the audio-capability probe lost the emulator as a
measurement venue to exactly this, and reasonably declined to install a second JDK to get around
it.

## An iPhone (by ear — nothing here can drive one)

There is no cable route to an iPhone from this Windows machine (Safari remote debugging needs a
Mac), so the iPhone checks are done by hand on the deployed site.

1. **Does it sound?** Open the app, press Sound. The walk goes straight to the speaker on every
   platform.
2. **Does it survive the lock screen?** No, and that is known: on iOS a walk stops when the
   screen locks. The walk was routed through a media element for one day to get around that, and
   it wrecked the stretch sound on iOS (2026-09-22) — Kerem chose the sound. Keep the screen on;
   the wake lock does that for you while a walk is running.
3. **If a stretch point sounds wrong**, open `diag.html` section 6 ("Stretch engine, playing for
   real"): it runs the same engine on a synthetic source and says whether the engine itself is
   healthy on this device. Then open the app with `?pxdebug` and read the overlay — seconds of
   recording received, read-head position, late hops, render quantum, the stretch and FFT the
   point is actually using, and whether the row is the published one or a local draft.
4. `diag.html` section 5 shows the measured render cost, which audio path the device got, and
   `tinyMemory()`/`smallDevice()`. Screenshot that section when reporting.
