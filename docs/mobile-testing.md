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

1. **Does it sound?** Open the app, press Sound. On iOS the walk is routed through the page's
   `#keepalive` element (a MediaStream), not straight to the speaker, so iOS keeps it alive with
   the screen locked. If a walk is silent while the level meter moves, the reroute is the
   suspect: the meter taps the limiter, which sits before the reroute.
2. **Rule the reroute out in one step:** add `?nostream` to the URL (e.g.
   `.../Fieldscape/?nostream`). That forces the ordinary `limiter.toDestination()` route. If it
   sounds with `?nostream` and not without, the reroute is broken on that iOS version.
3. **Does it survive the lock screen?** Press Sound, wait for the fade-in, lock the phone for
   two minutes, unlock. Sound should never stop. With `?nostream` it is expected to stop when
   the screen locks; that is the baseline measured on 2026-09-22.
4. `diag.html` section 5 shows the measured render cost, which audio path the device got, and
   `tinyMemory()`/`smallDevice()`. Screenshot that section when reporting.
