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
