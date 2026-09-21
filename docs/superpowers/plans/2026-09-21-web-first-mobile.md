# Web-First Mobile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Fieldscape survive a real walk in a browser — sound that continues with the screen
off — and make every mobile finding measurable from this machine instead of relayed by hand.

**Architecture:** Five independent changes to a single-file ES5 web app plus its dev tooling. A
`MediaSession` and a silent looping `<audio>` element give Android Chrome a reason to keep the
page's audio alive when backgrounded; the screen wake lock then stops being load-bearing for a
listening walk. Alongside, an `adb` + DevTools-protocol driver turns an Android phone or emulator
into something this session can script, and a viewport check catches phone-layout regressions
without any device at all.

**Tech Stack:** Vanilla ES5 in `index.html` (no build step), Tone.js 15 from unpkg, Node 24 for
tooling and tests (`node:test`), Android SDK platform-tools (`adb`) + emulator, Chrome DevTools
Protocol over a native `WebSocket`.

**Spec:** `docs/superpowers/specs/2026-09-21-web-first-mobile-design.md`

## Global Constraints

- **No build step.** `index.html` is served as written. Nothing may introduce bundling or transpiling.
- **No new runtime dependency.** Tooling may add devDependencies; the shipped page may not gain a library.
- **ES5 only in `index.html` and `diag.html`** — `var`, `function`, no arrow functions, no `const`/`let`. Tooling under `tools/` and `tests/` is modern ESM.
- **Desktop behaviour is unchanged.** Every mobile concession is gated on `smallDevice()`.
- **Never cut the archive.** Recording fidelity and recording voices are not what gets reduced; the generative layer is.
- **Audio timing measured against a live AudioContext in this harness is invalid** — its clock runs at ~0.2× real time. Use offline renders or Node benchmarks.
- **Run `npm run check` and the full suite before every commit.** 439 tests pass as of the branch point; no task may reduce that number.
- **Verify a deploy by fetching the live asset**, never by a successful push.

---

### Task 1: The mobile test loop

**Files:**
- Create: `tools/phone.mjs` (already drafted in the working tree — review and finish it)
- Modify: `package.json` (scripts)
- Create: `tests/phone-tool.test.mjs`
- Create: `docs/mobile-testing.md`

**Interfaces:**
- Produces: `node tools/phone.mjs <devices|targets|open URL|eval JS|eval-file PATH|console SECONDS>`,
  and npm aliases `npm run phone -- <args>`. Later tasks use `npm run phone -- eval "<js>"` to read
  values out of a real device.

**Context:** The Android SDK is installed at `%LOCALAPPDATA%\Android\Sdk`. `adb` lives in
`platform-tools/`. Chrome on Android publishes its DevTools on the abstract socket
`chrome_devtools_remote`; `adb forward tcp:9222 localabstract:chrome_devtools_remote` exposes it,
and `http://127.0.0.1:9222/json/list` then lists page targets, each with a `webSocketDebuggerUrl`.
Node 24 has a global `WebSocket`, so no dependency is needed.

- [ ] **Step 1: Write the failing test**

`tests/phone-tool.test.mjs`:

```js
// tests/phone-tool.test.mjs — the shape of the phone driver, without a phone.
/* This cannot connect to a device in CI, so it tests the two things that are still worth
   pinning: that the tool exists with the commands later tasks call, and that it fails with a
   sentence a human can act on rather than a stack trace when nothing is plugged in. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const src = readFileSync("tools/phone.mjs", "utf8");

test("the driver speaks CDP directly, with no dependency", () => {
  assert.match(src, /new WebSocket\(/, "Node 24 has a global WebSocket — nothing to install");
  assert.ok(!/require\(|from "ws"|from 'ws'/.test(src), "no websocket library");
  assert.match(src, /localabstract:chrome_devtools_remote/,
    "the socket Chrome for Android publishes");
  assert.match(src, /Runtime\.evaluate/);
  assert.match(src, /awaitPromise: true/, "a probe must be able to await on the device");
  assert.match(src, /returnByValue: true/, "and get data back, not a remote handle");
});

test("every command later tasks depend on is implemented", () => {
  for (const cmd of ["devices", "targets", "open", "eval", "eval-file", "console"]) {
    assert.ok(src.includes(`"${cmd}"`), "missing command: " + cmd);
  }
});

test("with no device attached it says what to do about it", () => {
  let out = "";
  try {
    out = execFileSync(process.execPath, ["tools/phone.mjs", "devices"],
                       { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    out = (e.stdout || "") + (e.stderr || "");
  }
  assert.match(out, /USB debugging|no device|adb/i,
    "a bare stack trace is not an instruction: " + out.slice(0, 200));
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test --env-file=.env.local tests/phone-tool.test.mjs`
Expected: FAIL — `tools/phone.mjs` may exist as a draft but the test pins details it may not have.

- [ ] **Step 3: Finish `tools/phone.mjs`**

The draft in the working tree is complete apart from review. Confirm it contains, verbatim, the
error text the third test looks for:

```js
  if (!out.length) {
    throw new Error("no device. Plug in with USB debugging on, or boot an emulator, then " +
                    "accept the RSA prompt on the phone.");
  }
```

and that `adbPath()` prefers the SDK location before falling back to `PATH`:

```js
function adbPath() {
  const local = join(process.env.LOCALAPPDATA || "", "Android", "Sdk", "platform-tools",
                     process.platform === "win32" ? "adb.exe" : "adb");
  if (existsSync(local)) { return local; }
  return "adb";
}
```

- [ ] **Step 4: Add the npm aliases**

In `package.json`, inside `"scripts"`, after the `"usage"` line:

```json
    "phone": "node tools/phone.mjs",
    "emulator": "node tools/emulator.mjs"
```

- [ ] **Step 5: Create the emulator helper**

`tools/emulator.mjs` — creates the AVD if absent and boots it, so the loop is one command:

```js
/* tools/emulator.mjs — create and boot the Android emulator used for layout checks.
 *
 * NOT for audio judgement. The emulator runs x86 on the host CPU and its audio output is a
 * host-side shim, so its glitching behaviour says nothing about a real phone's. Layout,
 * plumbing and exceptions only — trust a real device over USB for load and sound.
 */
import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";

const SDK = join(process.env.LOCALAPPDATA, "Android", "Sdk");
const AVD = "fieldscape-pixel";
const IMAGE = "system-images;android-34;google_apis;x86_64";

function sh(bin, args) {
  return execFileSync(bin, args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

const avdmanager = join(SDK, "cmdline-tools", "latest", "bin", "avdmanager.bat");
const emulator = join(SDK, "emulator", "emulator.exe");
if (!existsSync(emulator)) {
  console.error("emulator not installed. Run:\n  sdkmanager emulator " + IMAGE);
  process.exit(1);
}

const have = sh(avdmanager, ["list", "avd"]).includes(AVD);
if (!have) {
  console.log("creating AVD " + AVD + "…");
  execFileSync(avdmanager, ["create", "avd", "-n", AVD, "-k", IMAGE, "-d", "pixel_6"],
               { input: "no\n", encoding: "utf8" });
}
console.log("booting " + AVD + " — this takes a minute on first run");
/* Audio stays ON: a silent emulator cannot run an AudioContext at all, and Task 3 needs one. */
const child = spawn(emulator, ["-avd", AVD, "-no-boot-anim", "-gpu", "swiftshader_indirect"],
                    { detached: true, stdio: "ignore" });
child.unref();
console.log("booted in the background. Check with: npm run phone -- devices");
```

- [ ] **Step 6: Write the operator's note**

`docs/mobile-testing.md`:

```markdown
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
```

- [ ] **Step 7: Run the tests**

Run: `node --test --env-file=.env.local tests/phone-tool.test.mjs`
Expected: PASS (3 tests)

- [ ] **Step 8: Boot the emulator and prove the loop end to end**

Run:
```bash
npm run emulator
npm run phone -- devices
npm run phone -- open https://keremaltaylar.github.io/Fieldscape/diag.html
npm run phone -- eval "document.querySelector('h1').textContent"
```
Expected: the last command prints `"Fieldscape diagnostics"`. If `targets` reports no pages,
open Chrome on the emulator first — its DevTools socket exists only while Chrome runs.

- [ ] **Step 9: Commit**

```bash
git add tools/phone.mjs tools/emulator.mjs package.json tests/phone-tool.test.mjs docs/mobile-testing.md
git commit -m "A mobile test loop that does not go through Kerem"
```

---

### Task 2: Phone-viewport layout regression check

**Files:**
- Create: `tools/viewports.mjs`
- Create: `tests/viewport.test.mjs`
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes: nothing from Task 1 — this runs in desktop Chrome, no device needed.
- Produces: `npm run viewports`, which prints one line per viewport with the page's
  `scrollHeight - innerHeight` and any horizontal overflow.

**Context:** The studio rulebook's V-2 requires
`document.documentElement.scrollHeight - innerHeight === 0` **and** a screenshot. Rule C-8 says
the whole control surface fits one screen. Those have been checked by hand at one size. Real
phones are 360–430 CSS px wide; the app's mobile breakpoints are `max-width: 900px` and
`max-height: 620px`.

- [ ] **Step 1: Write the failing test**

`tests/viewport.test.mjs`:

```js
// tests/viewport.test.mjs — the viewport list is the contract; the run itself needs Chrome.
/* The measurement lives in tools/viewports.mjs and needs a browser, so what is pinned here is
   the set of sizes: a regression that only shows at 360px is invisible if 360px is not in the
   list. These are the real CSS viewports of phones people actually walk with, plus the two
   breakpoint edges the app's own media queries turn on. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync("tools/viewports.mjs", "utf8");

test("the list covers the narrow end, the tall end and both breakpoint edges", () => {
  for (const w of [360, 390, 412, 430]) {
    assert.ok(src.includes(String(w)), "missing a real phone width: " + w);
  }
  assert.ok(src.includes("900"), "the max-width: 900px breakpoint edge");
  assert.ok(src.includes("620"), "the max-height: 620px breakpoint edge");
});

test("it measures overflow in both directions, not just vertical", () => {
  assert.match(src, /scrollHeight/, "V-2: vertical overflow is the documented check");
  assert.match(src, /scrollWidth/, "a sideways scroll on a phone is the worse failure");
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test --env-file=.env.local tests/viewport.test.mjs`
Expected: FAIL — `tools/viewports.mjs` does not exist.

- [ ] **Step 3: Write `tools/viewports.mjs`**

```js
/* tools/viewports.mjs — measure the app's layout at real phone viewports.
 *
 * Drives whatever Chrome is already listening on --remote-debugging-port=9223, using
 * Emulation.setDeviceMetricsOverride: the same CDP call the DevTools device toolbar makes, so
 * these are true CSS viewports with touch, not a resized desktop window.
 *
 * Start Chrome first:
 *   chrome --remote-debugging-port=9223 --user-data-dir=%TEMP%\fs-viewports
 */
const PORT = 9223;
const URL_UNDER_TEST = process.argv[2] || "http://127.0.0.1:8080/";

/* width x height, and why each one is here. */
const VIEWPORTS = [
  { w: 360, h: 800, why: "the narrow end — a budget Android, where things overlap first" },
  { w: 390, h: 844, why: "iPhone 14/15" },
  { w: 412, h: 915, why: "Pixel" },
  { w: 430, h: 932, why: "iPhone Pro Max" },
  { w: 900, h: 600, why: "the max-width: 900px edge, still mobile layout" },
  { w: 1024, h: 620, why: "the max-height: 620px edge — a laptop in a short window" }
];

async function targets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return (await r.json()).filter((t) => t.type === "page");
}

function session(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 1;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", () => res()));
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) { p.reject(new Error(m.error.message)); } else { p.resolve(m.result); }
    }
  });
  return {
    ready,
    send(method, params = {}) {
      const n = id++;
      return new Promise((resolve, reject) => {
        pending.set(n, { resolve, reject });
        ws.send(JSON.stringify({ id: n, method, params }));
      });
    },
    close: () => ws.close()
  };
}

const list = await targets();
if (!list.length) { console.error("no page target on port " + PORT); process.exit(1); }
const s = session(list[0]);
await s.ready;
await s.send("Page.enable");

let worst = 0;
for (const v of VIEWPORTS) {
  await s.send("Emulation.setDeviceMetricsOverride", {
    width: v.w, height: v.h, deviceScaleFactor: 3, mobile: true
  });
  await s.send("Page.navigate", { url: URL_UNDER_TEST });
  await new Promise((r) => setTimeout(r, 6000));       /* the map and the archive have to land */
  const r = await s.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `({
      vScroll: document.documentElement.scrollHeight - innerHeight,
      hScroll: document.documentElement.scrollWidth - innerWidth,
      offscreen: [...document.querySelectorAll('button, input, select')]
        .filter(function (e) { var b = e.getBoundingClientRect();
          return b.width > 0 && (b.right > innerWidth + 1 || b.left < -1); }).length
    })`
  });
  const m = r.result.value;
  worst = Math.max(worst, m.vScroll, m.hScroll, m.offscreen);
  const bad = m.vScroll > 0 || m.hScroll > 0 || m.offscreen > 0;
  console.log(`${String(v.w).padStart(4)}x${v.h}  vScroll ${String(m.vScroll).padStart(4)}  ` +
              `hScroll ${String(m.hScroll).padStart(4)}  offscreen controls ${m.offscreen}  ` +
              `${bad ? "FAIL" : "ok"}   ${v.why}`);
}
await s.send("Emulation.clearDeviceMetricsOverride");
s.close();
process.exit(worst > 0 ? 1 : 0);
```

- [ ] **Step 4: Add the npm alias**

In `package.json` `"scripts"`, after `"phone"`:

```json
    "viewports": "node tools/viewports.mjs",
```

- [ ] **Step 5: Run the test**

Run: `node --test --env-file=.env.local tests/viewport.test.mjs`
Expected: PASS (2 tests)

- [ ] **Step 6: Run it for real and record the result**

Start a local server and a Chrome with remote debugging, then:

Run: `npm run viewports -- http://127.0.0.1:8080/`
Expected: six lines. Record the output in the commit message. A `FAIL` line is a finding to
report, not necessarily to fix inside this task — say so plainly rather than adjusting the
thresholds until it passes.

- [ ] **Step 7: Commit**

```bash
git add tools/viewports.mjs tests/viewport.test.mjs package.json
git commit -m "Measure the layout at the viewports people actually walk with"
```

---

### Task 3: Background audio — a media session, so the screen can go off

**Files:**
- Modify: `index.html` (markup near the other `<audio>`-free body elements; `bedStart`; `bedStop`)
- Create: `tests/background-audio.test.mjs`

**Interfaces:**
- Consumes: `bedStart()`, `bedStop()`, `wantSound`, `SOUND_FADE_IN` from the existing audio block.
- Produces: `mediaSessionStart()` and `mediaSessionStop()`, both called from inside `bedStart`/`bedStop`.

**Context:** Android Chrome keeps a backgrounded page's audio alive when the page owns an active
*media session*, and a pure WebAudio graph does not create one. The pattern is a silent looping
`<audio>` element played from the same user gesture that starts Sound, plus
`navigator.mediaSession` metadata and action handlers. The app currently has neither, and instead
holds `wakeLock.request("screen")` for the whole walk and restarts the audio context every 5 s in
`bed.resumeLoop` — both symptoms of this gap.

The silent audio must be a real decodable file, not `src=""`. A 1-second silent WAV is ~200 bytes
inline as a data URI, which keeps the no-build-step constraint and needs no network.

- [ ] **Step 1: Write the failing test**

`tests/background-audio.test.mjs`:

```js
// tests/background-audio.test.mjs — what keeps the sound alive when the screen goes off.
/* Kerem, 2026-09-21, choosing web over a native app: the walk is forty minutes outdoors with the
   phone in a pocket, and today that needs the screen on for the whole of it. Android Chrome will
   keep a backgrounded page's audio alive when the page owns an active media session; a pure
   WebAudio graph does not create one. The silent looping element is what creates it. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8").replace(/\r\n/g, "\n");
function src(name) {
  const s = html.indexOf("function " + name + "(");
  assert.ok(s !== -1, "missing " + name);
  let i = html.indexOf("{", html.indexOf(")", s)), d = 0;
  for (; i < html.length; i++) { if (html[i] === "{") d++; else if (html[i] === "}") { d--; if (!d) break; } }
  return html.slice(s, i + 1);
}

test("a silent looping element exists, and is real audio rather than an empty src", () => {
  const at = html.indexOf('id="keepalive"');
  assert.ok(at !== -1, "no keepalive element");
  const tag = html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1);
  assert.match(tag, /loop/, "it has to keep playing, not end after a second");
  assert.match(tag, /data:audio\/wav;base64,/,
    "a real decodable file — an empty src never becomes a media session, and no build step " +
    "means it travels inline");
  assert.ok(!/controls/.test(tag), "it is machinery, not a control");
});

test("the session starts from the same gesture that starts Sound", () => {
  const start = src("bedStart");
  assert.match(start, /mediaSessionStart\(\)/,
    "play() outside a user gesture is refused, and bedStart runs inside the Sound click");
  const stop = src("bedStop");
  assert.match(stop, /mediaSessionStop\(\)/);
});

test("the lock screen says what is playing, and its buttons work", () => {
  const fn = src("mediaSessionStart");
  assert.match(fn, /navigator\.mediaSession/);
  assert.match(fn, /MediaMetadata/, "a blank lock-screen card is a bug someone will report");
  assert.match(fn, /playbackState = "playing"/);
  for (const action of ["play", "pause", "stop"]) {
    assert.ok(fn.includes(`"${action}"`),
      "headphone buttons and lock-screen controls must drive the walk: " + action);
  }
});

test("every media-session call is guarded, because iOS has none of this", () => {
  /* Safari implements part of mediaSession and none of the background behaviour. A missing
     API must leave a working walk on the platform where this cannot work at all. */
  const fn = src("mediaSessionStart") + src("mediaSessionStop");
  assert.match(fn, /"mediaSession" in navigator/, "feature-detected, not assumed");
  assert.match(fn, /catch/, "and play() rejects on any platform that declines it");
});

test("the context watchdog stays — this reduces suspensions, it does not abolish them", () => {
  assert.match(src("bedStart"), /bed\.resumeLoop/,
    "a phone call, a Bluetooth switch or an audio-focus change can still take the context out");
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test --env-file=.env.local tests/background-audio.test.mjs`
Expected: FAIL — `no keepalive element`.

- [ ] **Step 3: Add the silent element to the markup**

Immediately before the closing `</body>` in `index.html`, above the module scripts:

```html
<!-- Machinery, not a control. Android Chrome keeps a backgrounded page's audio alive only while
     the page owns an active media session, and a WebAudio graph alone never creates one — which
     is why a walk used to need the screen held on for its whole length. This element is one
     second of silence on a loop; playing it from the Sound gesture is what makes the session
     real. It is inline because there is no build step and a walk starts where there is no
     signal. -->
<audio id="keepalive" loop preload="auto" aria-hidden="true"
       src="data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA="></audio>
```

- [ ] **Step 4: Add the two functions**

In `index.html`, immediately above `function bedStart() {`:

```js
  /* ---- Staying alive with the screen off ----
     A walk is forty minutes outdoors with the phone in a pocket. Until this existed that needed
     wakeLock("screen") held for the whole of it — battery, pocket taps, sunlight — and the
     context still got suspended, which is what bed.resumeLoop has always been patching over.

     Android Chrome keeps a backgrounded page's audio alive while the page owns an active media
     session. A WebAudio graph does not create one; an <audio> element actually playing does. So
     the silent loop is not a hack around the rule, it is the rule: the page really is playing
     media, and the graph it also runs is allowed to keep going.

     Both halves are fully guarded. Safari implements some of mediaSession and none of the
     background behaviour, so on iPhone this does nothing and must break nothing. */
  function mediaSessionStart() {
    var el = $("#keepalive");
    if (el) {
      /* Started from inside the Sound click: play() outside a user gesture is refused. */
      var p = el.play();
      if (p && p.catch) { p.catch(function () { /* declined — the walk still sounds */ }); }
    }
    if (!("mediaSession" in navigator)) { return; }
    try {
      var where = (place && place.properties && place.properties.name) || "Open world";
      navigator.mediaSession.metadata = new MediaMetadata({
        title: "Fieldscape", artist: where, album: "A walk"
      });
      navigator.mediaSession.playbackState = "playing";
      /* The lock screen and the button on a pair of headphones both arrive here. Without these
         they appear to work and do nothing, which is worse than not appearing at all. */
      navigator.mediaSession.setActionHandler("play", function () {
        if (!(bed && bed.on) && !wantSound) { $("#patch-play").click(); }
      });
      navigator.mediaSession.setActionHandler("pause", function () { bedStop(); });
      navigator.mediaSession.setActionHandler("stop", function () { bedStop(); });
    } catch (e) { /* an older or partial implementation — the walk still sounds */ }
  }

  function mediaSessionStop() {
    var el = $("#keepalive");
    if (el) { try { el.pause(); } catch (e) { /* never played */ } }
    if (!("mediaSession" in navigator)) { return; }
    try { navigator.mediaSession.playbackState = "paused"; } catch (e) { /* ignore */ }
  }
```

- [ ] **Step 5: Call them**

In `bedStart`, immediately after `keepAwake(true);`:

```js
        mediaSessionStart();
```

In `bedStop`, immediately after `bed.on = false;`:

```js
    mediaSessionStop();
```

- [ ] **Step 6: Run the tests**

Run: `node --test --env-file=.env.local tests/background-audio.test.mjs`
Expected: PASS (5 tests)

- [ ] **Step 7: Run the whole suite and the HTML check**

Run: `npm run check && node --test --env-file=.env.local "tests/**/*.test.mjs"`
Expected: every test passes, including the five added here. (The suite was 439 at the branch point and grows with each task, so check for zero failures rather than a total.)

- [ ] **Step 8: Verify on a real Android — this is the task's actual deliverable**

The tests prove the code is wired. Only a device proves the behaviour. With a phone attached
(see `docs/mobile-testing.md`):

```bash
npm run phone -- open https://keremaltaylar.github.io/Fieldscape/
# on the phone: start a walk, press Sound, confirm it sounds
npm run phone -- eval "({ playing: !document.querySelector('#keepalive').paused, state: navigator.mediaSession.playbackState, ctx: window.__fa.bed && window.__fa.bed.Tone.context.state })"
# lock the phone, wait 120 seconds, then without unlocking:
npm run phone -- eval "({ ctx: window.__fa.bed.Tone.context.state, hidden: document.hidden, voices: Object.keys(window.__fa.bed.voices).length })"
```

Expected after two minutes locked: `ctx: "running"`. A `"suspended"` or `"interrupted"` means the
media session did not hold, and that is the finding — report it, do not paper over it. Record
both readings in the commit message.

- [ ] **Step 9: Commit**

```bash
git add index.html tests/background-audio.test.mjs
git commit -m "A media session, so a walk can have the screen off"
```

---

### Task 4: Let the screen sleep on a listening walk

**Files:**
- Modify: `index.html` (`releaseAwakeIfUnneeded`, and the `bedStart` call added in Task 3)
- Modify: `tests/wake-lock.test.mjs`

**Interfaces:**
- Consumes: `mediaSessionStart()` from Task 3, `keepAwake(on)`, `releaseAwakeIfUnneeded()`.
- Produces: no new names. Changes which reasons hold the screen awake.

**Context:** `keepAwake(true)` is currently called for three reasons: tracing a route, GPS follow,
and sound playing. Tracing genuinely needs the screen — a setter is looking at the map. Sound
playing does not, once Task 3 holds. This task removes only that third reason, and only when the
media session actually took.

**Do this task only if Task 3's Step 8 showed `ctx: "running"` after two minutes locked.** If it
did not, the wake lock is still load-bearing; record that in the ledger and skip to Task 5.

- [ ] **Step 1: Write the failing test**

Add to `tests/wake-lock.test.mjs`:

```js
/* 2026-09-21: sound alone stopped being a reason to hold the screen awake, because the media
   session added in tests/background-audio.test.mjs keeps a backgrounded walk sounding. Tracing
   still holds it — a setter drawing a route is looking at the map — and so does GPS follow while
   the app is in the foreground. */
test("sound alone no longer holds the screen awake", () => {
  const start = slice("function bedStart()", "\n  }\n");
  assert.ok(!/keepAwake\(true\)/.test(start),
    "the media session is what keeps a backgrounded walk alive now, not the screen");
  assert.match(start, /mediaSessionStart\(\)/, "replaced by, not merely deleted");
});

test("tracing and GPS follow still hold it", () => {
  assert.match(slice("function startTrack()", "\n  }\n"), /keepAwake\(true\)/,
    "a setter drawing a route is looking at the map");
  assert.match(slice("function gpsSet(on)", "\n  }\n"), /keepAwake\(true\)/);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test --env-file=.env.local tests/wake-lock.test.mjs`
Expected: FAIL — `bedStart` still calls `keepAwake(true)`.

- [ ] **Step 3: Remove sound as a reason**

In `bedStart`, replace:

```js
        keepAwake(true);
        mediaSessionStart();
```

with:

```js
        /* Sound is no longer a reason to hold the screen. The media session keeps a
           backgrounded walk alive (see mediaSessionStart), and a walk that needed the screen on
           for forty minutes outdoors was the single worst thing about listening on a phone.
           Tracing and GPS follow still hold it — see releaseAwakeIfUnneeded. */
        mediaSessionStart();
```

- [ ] **Step 4: Stop counting sound as a reason to keep holding it**

`releaseAwakeIfUnneeded` currently reads:

```js
  function releaseAwakeIfUnneeded() {
    if (!track && !gps.on && !(bed && bed.on)) { keepAwake(false); }
  }
```

Replace it with:

```js
  /* Sound is no longer one of the reasons (see bedStart): a backgrounded walk is kept alive by
     the media session, not by the screen. Tracing needs the screen because a setter is drawing
     on the map, and GPS follow needs it while the app is in front. */
  function releaseAwakeIfUnneeded() {
    if (!track && !gps.on) { keepAwake(false); }
  }
```

Add to `tests/wake-lock.test.mjs`:

```js
test("a walk that is only sounding does not keep the lock alive either", () => {
  const fn = slice("function releaseAwakeIfUnneeded()", "\n  }\n");
  assert.ok(!/bed && bed\.on/.test(fn),
    "sound stopped being a reason to hold the screen; leaving it here would keep the lock " +
    "for the whole walk through the back door");
  assert.match(fn, /!track && !gps\.on/);
});
```

- [ ] **Step 5: Run the tests**

Run: `npm run check && node --test --env-file=.env.local "tests/**/*.test.mjs"`
Expected: all pass.

- [ ] **Step 6: Verify on the phone**

```bash
# start a listening walk with Sound on, do not start a trace
npm run phone -- eval "({ wake: !!window.__fa.wakeLock })"
```
Expected: no wake lock held for a plain listening walk. Then lock the phone for two minutes and
confirm sound continues, exactly as in Task 3 Step 8.

- [ ] **Step 7: Commit**

```bash
git add index.html tests/wake-lock.test.mjs
git commit -m "A listening walk lets the screen sleep"
```

---

### Task 5: The PWA gaps that stop it being an app on iOS

**Files:**
- Create: `icon-180.png`, `icon-192.png`, `icon-512.png`
- Modify: `manifest.webmanifest`
- Modify: `index.html` (`<head>`)
- Modify: `sw.js` (`SHELL_FILES`)
- Create: `tests/pwa.test.mjs`

**Interfaces:**
- Consumes: the existing `icon.svg`.
- Produces: nothing other tasks depend on.

**Context:** The manifest offers only `icon.svg`. **iOS ignores SVG icons for the home screen** and
falls back to a screenshot of the page, and Android prefers a raster icon for the splash screen.
There are no `apple-mobile-web-app-*` meta tags, so an iPhone home-screen launch does not run
standalone. Kerem accepted that iPhone stays the weaker experience — that is about background
audio, not about the app looking broken when installed.

Generate the PNGs from `icon.svg` with `sharp` as a devDependency, or by rendering the SVG in the
Chrome already used by Task 2. Do not hand-draw them.

- [ ] **Step 1: Write the failing test**

`tests/pwa.test.mjs`:

```js
// tests/pwa.test.mjs — installable, and recognisably itself once installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";

const html = readFileSync("index.html", "utf8").replace(/\r\n/g, "\n");
const manifest = JSON.parse(readFileSync("manifest.webmanifest", "utf8"));
const head = html.slice(0, html.indexOf("</head>"));

test("the manifest offers raster icons, because iOS ignores SVG on the home screen", () => {
  const raster = manifest.icons.filter((i) => i.type === "image/png");
  assert.ok(raster.length >= 2, "an SVG-only manifest gets a screenshot as the icon on iOS");
  for (const size of ["192x192", "512x512"]) {
    assert.ok(raster.some((i) => i.sizes === size), "missing " + size);
  }
  assert.ok(manifest.icons.some((i) => (i.purpose || "").includes("maskable")),
    "Android crops a non-maskable icon into a circle badly");
});

test("an iPhone home-screen launch runs standalone and knows its own icon", () => {
  assert.match(head, /<link rel="apple-touch-icon" href="\.\/icon-180\.png">/);
  assert.match(head, /<meta name="apple-mobile-web-app-capable" content="yes">/);
  assert.match(head, /apple-mobile-web-app-status-bar-style/);
  assert.match(head, /<meta name="apple-mobile-web-app-title" content="Fieldscape">/);
});

test("the icons are real files of a plausible size", () => {
  for (const f of ["icon-180.png", "icon-192.png", "icon-512.png"]) {
    const bytes = statSync(f).size;
    assert.ok(bytes > 500, f + " is " + bytes + " bytes — that is not a rendered icon");
  }
});

test("the service worker caches them, so an installed app works offline from first launch", () => {
  const sw = readFileSync("sw.js", "utf8");
  for (const f of ["icon-180.png", "icon-192.png", "icon-512.png"]) {
    assert.ok(sw.includes(f), "not in SHELL_FILES: " + f);
  }
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test --env-file=.env.local tests/pwa.test.mjs`
Expected: FAIL — no raster icons.

- [ ] **Step 3: Render the icons**

```bash
npm install --save-dev sharp
node -e "const s=require('sharp');for(const n of [180,192,512]){s('icon.svg').resize(n,n).png().toFile('icon-'+n+'.png');}"
```

Check each file opens and is not blank before continuing.

- [ ] **Step 4: Add them to the manifest**

Replace the `"icons"` array in `manifest.webmanifest` with:

```json
  "icons": [
    { "src": "./icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any" },
    { "src": "./icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "./icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "./icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
```

- [ ] **Step 5: Add the iOS head tags**

In `index.html`, immediately after the existing `<link rel="manifest" …>` line:

```html
<!-- iOS reads none of the manifest for the home screen: it wants its own icon and its own
     standalone flag, and without them an installed Fieldscape launches in a Safari chrome with a
     screenshot for an icon. Background audio still does not work there (Safari does not allow
     it) — this is only about the app being recognisably itself once installed. -->
<link rel="apple-touch-icon" href="./icon-180.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Fieldscape">
```

- [ ] **Step 6: Add them to the service worker shell**

In `sw.js`, add to `SHELL_FILES` after `"./index.html"`:

```js
  "./icon-180.png",
  "./icon-192.png",
  "./icon-512.png",
```

Bump `SHELL` to `"fieldarc-shell-v3"` so the new shell actually replaces the cached one.

- [ ] **Step 7: Run the tests**

Run: `npm run check && node --test --env-file=.env.local "tests/**/*.test.mjs"`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add icon-180.png icon-192.png icon-512.png manifest.webmanifest index.html sw.js package.json package-lock.json tests/pwa.test.mjs
git commit -m "Installable, and recognisably itself once installed"
```

---

### Task 6: Stop the deep-link redirect looping off GitHub Pages

**Files:**
- Modify: `404.html`
- Create: `tests/spa-redirect.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

**Context:** `404.html` implements the standard GitHub-Pages SPA redirect with
`pathSegmentsToKeep = 1`, correct for `keremaltaylar.github.io/Fieldscape/`. Off that host the
assumption is wrong: serving the repo at a local root makes `base` the deep link's own first
segment, the rewritten URL 404s again, and each pass appends another `?p=`. Observed on
2026-09-21 as a URL carrying 150 copies of `p=%2F`. Harmless in production today, and one
hosting change away from not being.

- [ ] **Step 1: Write the failing test**

`tests/spa-redirect.test.mjs`:

```js
// tests/spa-redirect.test.mjs — the deep-link redirect, and the loop it used to allow.
/* Observed 2026-09-21 serving the repo from a local root: a deep link 404s, 404.html rewrites
   it, the rewrite 404s, and each pass appends another p= — a URL with 150 copies of p=%2F. The
   host that production runs on makes pathSegmentsToKeep = 1 correct, so this never bit a real
   visitor; a redirect that can loop at all should not be able to loop twice. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("404.html", "utf8");

test("a rewrite that has already happened is not rewritten again", () => {
  assert.match(html, /indexOf\("p="\)|has\("p"\)|searchParams/,
    "404.html must notice its own previous pass");
  const guard = html.indexOf("p=");
  const replace = html.indexOf("location.replace");
  assert.ok(guard !== -1 && guard < replace, "and notice it before redirecting again");
});

test("the redirect still works for a first-time deep link", () => {
  assert.match(html, /pathSegmentsToKeep = 1/, "production is one segment deep (/Fieldscape)");
  assert.match(html, /encodeURIComponent/);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test --env-file=.env.local tests/spa-redirect.test.mjs`
Expected: FAIL — no guard.

- [ ] **Step 3: Add the guard**

In `404.html`, immediately after `var l = window.location;`:

Wrap the existing redirect so it only runs on a first pass. Replace the three lines from
`var base = ...` through the closing `);` of `window.location.replace(...)` with:

```js
  /* One pass only. Off GitHub Pages — a local server at the repo root, say — pathSegmentsToKeep
     is wrong, the rewritten URL 404s again, and every pass appends another p=. Measured on
     2026-09-21: 150 copies of p=%2F in one address bar. A first pass always has no p=, so this
     costs a real deep link nothing and costs a loop everything. */
  if (l.search.indexOf("p=") === -1) {
    var base = l.pathname.split("/").slice(0, 1 + pathSegmentsToKeep).join("/");
    var rest = l.pathname.slice(base.length);
    window.location.replace(l.protocol + "//" + l.hostname + (l.port ? ":" + l.port : "") +
      base + "/?p=" + encodeURIComponent(rest) + (l.search ? "&" + l.search.slice(1) : "") + l.hash);
  }
```

- [ ] **Step 4: Run the tests**

Run: `node --test --env-file=.env.local tests/spa-redirect.test.mjs`
Expected: PASS (2 tests)

- [ ] **Step 5: Verify a real deep link still works after deploy**

After pushing, fetch the live deep link and confirm the app boots:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://keremaltaylar.github.io/Fieldscape/W248012830
```
Expected: 200, and opening it in a browser lands on Koşuyolu Parkı with the path restored.

- [ ] **Step 6: Commit**

```bash
git add 404.html tests/spa-redirect.test.mjs
git commit -m "The deep-link redirect gets one pass, not a hundred and fifty"
```

---

## After the plan

Task 3's Step 8 is the gate the whole web-first decision rests on. Report its two readings to
Kerem explicitly — not folded into a summary — because they decide what happens next:

- **Context still `running` after two minutes locked** → web-first is validated. The remaining
  audio question is tuning, and the next decision is whether to spend the third voice (~11 points)
  or the sector counter-line (~12) on a phone. That needs Kerem, and real device numbers from
  `diag.html` section 5 gathered through `npm run phone`.
- **Context `suspended` or `interrupted`** → the cheap shot missed. The web platform will not
  carry a forty-minute pocket walk on Android, and the native question reopens on evidence rather
  than on estimates. Do not start a native anything inside this plan; bring the finding back.
