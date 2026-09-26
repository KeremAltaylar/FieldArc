# Fieldscape phone tests

Every build handed over for testing gets the next number. The number shows on the phone: long-press the
place name at the top of the walk panel, and the developer line starts with **Fieldscape · Test N**
(iPhone; Android from its next build on). If the number on the phone is not the one below, it is the
wrong build.

| Test | Date | Phone | What changed | Result |
|---|---|---|---|---|
| 1 | 2026-09-26 | iPhone 8 | First real-device builds: walk by hand, Sound/Stop, Go to buttons, 16-bit decoding one at a time | Sound great in Koşuyolu, no clicks. Memory kills fixed (4 min on/off screen, no crash). Half-second glitch on the first screen lock and on a screenshot: worst 243.54 ms callback, 3 underruns |
| 2 | 2026-09-26 | Android (brother's phone) | First APK (`Fieldscape-test.apk`), then `Fieldscape-test-2.apk`: real-time audio thread + 350 ms buffer | Test 1 APK: sound as good as iPhone; glitch going to the Home screen with the screen on. Test 2 APK: **everything passes** (Home screen, screen off, sound) |
| 2 | 2026-09-26 | iPhone 8 | Recordings kept warm (memory-reclaim theory) | Same glitch: worst 188.43 ms, 3 underruns. Theory wrong |
| 3 | 2026-09-26 | iPhone 8 | Sound rendered ~350 ms ahead on its own real-time thread (core/player.cpp); the audio callback only copies. Developer line shows the test number, how far ahead it is, and dropouts | **Dropouts 0**, callback worst 0.10 ms, render worst 128 ms absorbed - the app no longer drops sound. Yet the first screen lock and the first screenshot still glitch audibly: the cause is outside the app |
| 4 | 2026-09-26 | iPhone 8 | Diagnostics only: the developer line counts what iOS does to the audio (engine config changes, route changes, interruptions, background, screenshot) and shows the last one with the hardware rate, I/O buffer and whether the engine was running | **Solved - not an app bug.** Events: background 1, screenshot 1; no engine config change, no route change, engine running, 0 dropouts. Kerem found the glitch happens only in a session started from Xcode (▶), once, on the first lock or screenshot; opened from the phone it never glitches (Lock Sound off made no difference). Cause: the debugger stops every thread while it registers the system code iOS loads the first time the app goes to the background. Listeners never run under a debugger |
