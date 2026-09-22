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

test("play() is guarded against a synchronous throw, not just a rejected promise", () => {
  /* A rejected promise is the normal "declined" case and was always handled. A THROW from
     play() itself is a different failure: it runs inside bedStart's .then() chain after bed.on
     is already true, so an escaped exception would skip buildRhythmFx, buildVoice, the loop
     scheduling, Transport.start() and the fade-in — the button says Stop over a graph that was
     never built. Same failure class the wake-lock code already carries a scar for. */
  const fn = src("mediaSessionStart");
  const playAt = fn.indexOf("el.play()");
  assert.ok(playAt !== -1, "missing el.play()");
  const tryAt = fn.lastIndexOf("try {", playAt);
  assert.ok(tryAt !== -1 && tryAt < playAt,
    "el.play() must sit inside a try, not just have its returned promise handled");
  assert.ok(fn.indexOf("catch (e)", playAt) !== -1, "and the try must actually be caught");
});

/* Executed, not pattern-matched: mediaSessionStart/Stop run against stubs for each platform
   shape. Two questions live in them (review CRITICAL 1, 2026-09-22): must #keepalive PLAY — yes
   on a phone (Android backgrounding) and on ANY iOS Safari, where it is the walk's only path to
   the speaker — and does this device get a lock-screen card, which stays smallDevice()-only. An
   iPad (iosSafari true, smallDevice false) used to return before el.play(): total silence. */
function runSession(small, ios) {
  const log = [];
  const el = { play: () => { log.push("play"); return Promise.resolve(); },
               pause: () => { log.push("pause"); } };
  const mediaSession = { setActionHandler: () => log.push("handler") };
  Object.defineProperty(mediaSession, "metadata", { set: () => log.push("metadata") });
  Object.defineProperty(mediaSession, "playbackState", { set: (v) => log.push("state:" + v) });
  const fns = new Function("$", "smallDevice", "iosSafari", "keepaliveFallback", "navigator",
    "MediaMetadata", "place", "bed", "wantSound", "bedStop",
    src("mediaSessionStart") + src("mediaSessionStop") +
    "; return { start: mediaSessionStart, stop: mediaSessionStop };")(
    () => el, () => small, () => ios, () => log.push("fallback"), { mediaSession },
    function () {}, null, null, false, () => {});
  fns.start(); const started = log.slice(); log.length = 0;
  fns.stop();
  return { started, stopped: log.slice() };
}

test("desktop is left alone — no element, no Now Playing card, no media keys", () => {
  const r = runSession(false, false);
  assert.deepEqual(r.started, [], "a desktop must touch neither the element nor mediaSession");
  assert.deepEqual(r.stopped, []);
});

test("an iPad plays the element — it is the only output path — but gets no lock-screen card", () => {
  const r = runSession(false, true);
  assert.deepEqual(r.started, ["play"],
    "iosSafari() alone must reach el.play(), or the rerouted walk is silent");
  assert.deepEqual(r.stopped, ["pause"], "and pause it again on Stop");
});

test("phones get the element and the lock-screen card, on iOS and Android alike", () => {
  [[true, true], [true, false]].forEach(([small, ios]) => {
    const r = runSession(small, ios);
    assert.equal(r.started[0], "play", "element first, from inside the Sound gesture");
    assert.ok(r.started.includes("metadata") && r.started.includes("state:playing") &&
      r.started.includes("handler"), "the lock screen says what is playing and its buttons work");
    assert.deepEqual(r.stopped, ["pause", "state:paused"]);
  });
});

test("the context watchdog stays — this reduces suspensions, it does not abolish them", () => {
  assert.match(src("bedStart"), /bed\.resumeLoop/,
    "a phone call, a Bluetooth switch or an audio-focus change can still take the context out");
});

/* ---- iOS: routing the walk itself through #keepalive ----
   The recipe above is Chrome's documented Android trick and it does not survive an iOS lock
   screen — confirmed by ear, on Kerem's own iPhone, with that recipe deployed. iOS keeps a media
   element alive in the background only while it is genuinely playing, so the remaining idea is
   to make #keepalive BE the walk on iOS rather than a silent decoy next to it. Untested on a
   real iPhone by this suite — these tests pin the two ways that would fail silently or badly
   (doubled output, no output) rather than the one thing only a locked phone in a pocket can
   answer (does iOS actually keep it playing). */

function iosSafariFor(nav) {
  /* iosSafari() takes no argument in the real code — it reads the ambient `navigator` — so the
     mock is closed over as the generated function's own `navigator` parameter, and iosSafari()
     is invoked (not just returned) inside that same scope. */
  return new Function("navigator", src("iosSafari") + "; return iosSafari();")(nav);
}

test("iosSafari() catches an iPhone, an old iPad, and an iPad wearing a Mac's user agent", () => {
  const iphone = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) " +
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
    platform: "iPhone", maxTouchPoints: 5 };
  assert.equal(iosSafariFor(iphone), true, "a plain iPhone UA");
  const oldIpad = { userAgent: "Mozilla/5.0 (iPad; CPU OS 12_0 like Mac OS X) " +
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.0 Mobile/16A366 Safari/604.1",
    platform: "iPad", maxTouchPoints: 5 };
  assert.equal(iosSafariFor(oldIpad), true, "an iPad that still identifies itself as an iPad");
  const modernIpad = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_6) " +
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
    platform: "MacIntel", maxTouchPoints: 5 };
  assert.equal(iosSafariFor(modernIpad), true,
    "iPadOS 13+ ships a Mac-shaped UA by default — touch is the only thing left that tells it " +
    "apart from a real Mac");
});

test("iosSafari() clears a real Mac, Android, and desktop Windows/Chrome", () => {
  const realMac = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
    platform: "MacIntel", maxTouchPoints: 0 };
  assert.equal(iosSafariFor(realMac), false,
    "no Mac has ever reported more than one simultaneous touch point");
  const android = { userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36",
    platform: "Linux armv8l", maxTouchPoints: 5 };
  assert.equal(iosSafariFor(android), false, "iosSafari() must not widen into \"all phones\"");
  const windows = { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36", platform: "Win32", maxTouchPoints: 0 };
  assert.equal(iosSafariFor(windows), false);
});

test("iosSafari() is a platform gate, not a capability guess — it stays out of smallDevice/richAudio", () => {
  /* smallDevice() answers "does this look like a phone" and richAudio() answers "can this
     device render the full stack" — a capable and a weak iPhone need the exact same MediaStream
     reroute, and an Android phone, however weak, needs none of it. Folding this into either
     capability gate would make the reroute track the wrong axis. */
  assert.ok(!/iosSafari/.test(src("smallDevice")), "smallDevice() answers a different question");
  assert.ok(!/iosSafari/.test(src("richAudio")), "richAudio() answers a different question");
});

test("exactly one output path — the limiter never reaches both the context and the iOS stream", () => {
  /* The trap: if the limiter reaches ctx.destination AND a MediaStream, the walk plays twice —
     once direct, once through #keepalive — which sounds like phasing or doubled loudness, not
     an obvious routing bug. */
  const start = src("bedStart");
  const toDestCount = (start.match(/\.toDestination\(\)/g) || []).length;
  assert.equal(toDestCount, 1,
    "toDestination() must appear exactly once — one platform's branch, not a leftover from both");
  const streamCount = (start.match(/createMediaStreamDestination\(\)/g) || []).length;
  assert.equal(streamCount, 1, "createMediaStreamDestination() must appear exactly once");
  const gateAt = start.indexOf("if (iosSafari()");
  assert.ok(gateAt !== -1, "bedStart must branch on `if (iosSafari() ...)` to choose the route");
  const streamAt = start.indexOf("createMediaStreamDestination()");
  const elseAt = start.indexOf("} else {", gateAt);
  const destAt = start.indexOf(".toDestination()");
  assert.ok(elseAt !== -1 && gateAt < streamAt && streamAt < elseAt && elseAt < destAt,
    "the stream route and toDestination() must sit in the two arms of one if/iosSafari()/else — " +
    "never both reachable from the same build");
});

test("on iOS the stream exists before srcObject is assigned to it, and the limiter is what feeds it", () => {
  /* Assigning srcObject before the stream is created, or feeding it from anything other than the
     limiter, plays nothing at all — the brief's silence risk. */
  const start = src("bedStart");
  const streamAt = start.indexOf("createMediaStreamDestination()");
  const srcObjAt = start.indexOf(".srcObject =");
  assert.ok(streamAt !== -1 && srcObjAt !== -1 && streamAt < srcObjAt,
    "the stream must exist before something is assigned to play it");
  assert.match(start, /limiter\.connect\([a-zA-Z]*[Ss]tream/,
    "the limiter — the master's own output — must be what reaches the stream, not a bypass");
});

test("the master chain, including the iOS stream, is a page-lifetime singleton — teardown leaves it alone", () => {
  /* bed.master/limiter/walk/fade/synth are only ever built once, inside bedStart's `!bed.master`
     guard — bedTeardown never rebuilds them. Disposing the iOS stream or its wiring here would
     leave the next Sound press with nothing to reconnect to: the exact "stale stream on a second
     walk" failure the brief warns about, just arrived at by deleting the wrong thing. The actual
     per-walk release is mediaSessionStop()'s el.pause(), called from bedStop before the fade even
     starts — it stops the walk reaching the speaker without touching wiring a second Sound press
     needs, on iOS exactly as it already does on Android. */
  const teardown = src("bedTeardown");
  assert.ok(!/[Ii]osStream/.test(teardown), "the iOS stream is master-chain, not per-walk");
  assert.ok(!/bed\.limiter/.test(teardown), "the limiter itself is never disposed per-walk");
  const stop = src("bedStop");
  assert.match(stop, /mediaSessionStop\(\)/,
    "el.pause() — the real per-walk release, on every platform — runs from bedStop");
});

/* ---- When the iOS reroute itself fails ----
   On Android/desktop, #keepalive failing to play was always harmless — the real signal reached
   ctx.destination regardless. After the iOS reroute, #keepalive is the ONLY path there, so a
   decline or a throw means total silence unless something falls the graph back to the
   destination everyone else uses. Silence with no explanation, on the first audible test this
   build has ever had, is indistinguishable from "the change broke it" — so this must fall back
   audibly and say so, not fail quietly. */

function fallbackFn() {
  /* keepaliveFallback() closes over `bed` and `toast` as free variables in the real code — both
     become this generated function's own parameters here, the same pattern
     tests/audio-capability.test.mjs uses for richAudioVerdict's navigator/window/screen. */
  return new Function("bed", "toast", src("keepaliveFallback") + "; return keepaliveFallback;");
}

test("a failed play() on iOS falls back to the context destination — disconnect before connect, never both", () => {
  const calls = [];
  const mockStream = { tag: "the-ios-stream" };
  const limiter = {
    disconnect: function (n) { calls.push(["disconnect", n]); },
    toDestination: function () { calls.push(["toDestination"]); }
  };
  const bed = { iosStream: mockStream, limiter: limiter };
  const toastCalls = [];
  const fallback = fallbackFn()(bed, function (msg) { toastCalls.push(msg); });
  fallback();
  assert.deepEqual(calls, [["disconnect", mockStream], ["toDestination"]],
    "must disconnect from the stream before connecting to the destination, in that order — " +
    "the both-paths trap must not reopen in the one place it was never tested before");
  assert.equal(bed.iosStream, null,
    "cleared so a later, stale rejection (or a second decline) is a no-op, not a second fallback");
  assert.equal(toastCalls.length, 1, "the owner must be told — silence with no explanation is " +
    "indistinguishable from the change having broken the sound");
  assert.match(toastCalls[0], /background/i);
});

test("the fallback is a no-op off the iOS branch, and idempotent once it has already run", () => {
  const calls = [];
  const limiter = { disconnect: function () { calls.push("disconnect"); },
                     toDestination: function () { calls.push("toDestination"); } };
  const toastCalls = [];
  const toastFn = function (m) { toastCalls.push(m); };
  /* Android/desktop: bed.iosStream was never built — a decline there was always harmless, and
     must stay that way; no reconnect, no toast. */
  fallbackFn()({ iosStream: null, limiter: limiter }, toastFn)();
  assert.equal(calls.length, 0, "nothing built the stream, so there is nothing to fall back from");
  assert.equal(toastCalls.length, 0);
  /* A second call after the first already ran (bed.iosStream now null) — e.g. a stale rejection
     arriving late, or mediaSessionStart trying again on the next Sound press — must not touch
     the limiter or the owner a second time. */
  const bed2 = { iosStream: null, limiter: limiter };
  fallbackFn()(bed2, toastFn)();
  assert.equal(calls.length, 0);
  assert.equal(toastCalls.length, 0);
});

test("both play() failure paths reach the fallback, not just a comment saying it's harmless", () => {
  const fn = src("mediaSessionStart");
  const playAt = fn.indexOf("el.play()");
  assert.ok(playAt !== -1);
  assert.match(fn, /p\.catch\(keepaliveFallback\)/,
    "a declined play() must reach the fallback — the old bare comment is no longer true on iOS");
  const catchAt = fn.indexOf("catch (e)", playAt);
  assert.ok(catchAt !== -1);
  assert.match(fn.slice(catchAt, catchAt + 60), /keepaliveFallback\(\)/,
    "a synchronous throw must reach the fallback too, not just be swallowed");
});

/* ---- Two defects found in a fake-iPhone browser on 2026-09-22, after the branch merged ----
   Kerem pressed Sound on his own iPhone and it would not switch on. Reproduced by shimming
   desktop Chrome into iOS Safari's shape (UA, maxTouchPoints, coarse pointer, no deviceMemory)
   against a local copy: "Sound unavailable: Failed to execute 'connect' on 'AudioNode': cannot
   connect to an AudioNode belonging to a different audio context." */

test("the iOS stream is built on the LIVE Tone context, not the stale Tone.context getter", () => {
  /* tuneToneContext() calls Tone.setContext(new Tone.Context({ latencyHint: 0.05 })) at load, so
     every node the app builds belongs to that replacement. `Tone.context` is a getter fixed to
     the context Tone made for itself when the bundle evaluated — measured in the page:
     Tone.context === Tone.getContext() is FALSE, and their rawContexts differ. Building the
     MediaStreamDestination on Tone.context therefore produced a node from a foreign context, and
     limiter.connect(it) threw — taking the whole of bedStart down with it, which is exactly
     "Sound does not toggle on". Desktop never reaches this branch, so nothing caught it. */
  const fn = src("bedStart");
  assert.match(fn, /Tone\.getContext\(\)\.createMediaStreamDestination\(\)/,
    "the stream must come from the same context the limiter belongs to");
  assert.ok(!/Tone\.context\.createMediaStreamDestination/.test(fn),
    "Tone.context is the pre-tuneToneContext context and its nodes cannot connect to ours");
});

test("the context watchdogs ask the live context whether it is running", () => {
  /* Same root cause, quieter symptom: both watchdogs read bed.Tone.context.state — the stale
     context, which is never the one the walk plays through, so they were reporting on something
     the app does not use. */
  const html2 = html;
  assert.ok(!/bed\.Tone\.context\.state/.test(html2),
    "a watchdog that watches the wrong context cannot see the right one suspend");
  assert.match(html2, /bed\.Tone\.getContext\(\)\.state !== "running"/);
});

test("?nostream survives the first route selection, which rewrites the address bar", () => {
  /* Selecting a route pushes urlForSelection() — a bare path, no query string — so reading
     location.search at Sound-press time found nothing and the escape hatch silently did nothing.
     Captured at load instead, and kept in sessionStorage for the tab. */
  assert.match(html, /var NOSTREAM = location\.search\.indexOf\("nostream"\) !== -1;/);
  assert.match(src("nostream"), /return NOSTREAM;/,
    "read once at load — location.search is gone by the time Sound is pressed");
  assert.ok(!/return location\.search\.indexOf\("nostream"\)/.test(html));
  const at = html.indexOf("var NOSTREAM");
  const pushAt = html.indexOf("history.pushState(null");
  assert.ok(at !== -1 && pushAt !== -1 && at < pushAt,
    "and captured before anything can rewrite the URL");
  assert.match(html, /sessionStorage\.setItem\("fieldarc\.nostream", "1"\)/,
    "a reload or a deep-link redirect keeps the switch for this tab");
});
