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

test("an iPad arms nothing, and that is now harmless", () => {
  /* While the walk was routed through #keepalive this was a silent-walk bug: an iPad passes
     iosSafari() but fails smallDevice(), so it returned before el.play() and the only output
     path never started. The walk goes straight to the speaker now, so an iPad that arms no
     backgrounding trick simply stops when its screen locks, like every other tablet. */
  const r = runSession(false, true);
  assert.deepEqual(r.started, []);
  assert.deepEqual(r.stopped, []);
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

/* ---- iOS: the walk is NOT routed through #keepalive, and must not be ----
   For one day (2026-09-21 to 2026-09-22) it was: iOS keeps a backgrounded page alive only while
   a media element is genuinely playing, and Kerem's own lock test had confirmed that a pure
   WebAudio walk stops dead when the screen locks, so bedStart routed the limiter into this
   element's srcObject through a MediaStreamDestination. It reached the speaker and it wrecked
   the sound: the stretch points came out as "repeating a 2 note pattern" on iOS Safari AND iOS
   Chrome, in two parks, while desktop was right.

   Isolated by elimination: diag.html's stretch probe plays the same engine straight to the
   speaker and sounded correct on that phone; ?nostream (the app's direct path) sounded correct
   too; engine, recordings and parameters all measured identical across the two devices. What
   was left was WebKit's own MediaStream playback path. Kerem chose the sound over the lock
   screen, 2026-09-22 — a walk keeps the screen on, which is what the wake lock is for. */

test("the master chain has exactly one output: straight to the destination", () => {
  const fn = src("bedStart");
  assert.match(fn, /limiter\.toDestination\(\);/);
  assert.ok(!/createMediaStreamDestination/.test(fn),
    "no MediaStream on any platform — this is what mangled the stretch on iOS");
  /* The assignment, not the word: the comments still explain what was here and why it went. */
  assert.ok(!/\.srcObject\s*=/.test(html),
    "#keepalive plays its silent WAV and nothing else, everywhere");
});

test("nothing is left of the reroute: no platform check, no fallback, no escape hatch", () => {
  /* Each of these existed only to serve the reroute — a fallback for when its play() was
     declined, an escape hatch to rule it out by URL, and the iOS check that armed it. Dead code
     around an audio graph is how the last stale-context bug survived two reviews. */
  ["function iosSafari(", "function keepaliveFallback(", "function nostream(", "var NOSTREAM"]
    .forEach((gone) => assert.ok(html.indexOf(gone) === -1, gone + " should be gone"));
});

test("#keepalive is a silent decoy again, and only a phone arms it", () => {
  const start = src("mediaSessionStart"), stop = src("mediaSessionStop");
  [start, stop].forEach((fn) => {
    const guard = fn.indexOf("if (!smallDevice()) { return; }");
    assert.ok(guard !== -1, "one gate, at the top");
    ["el.play()", "el.pause()", "navigator.mediaSession"].forEach((needle) => {
      const at = fn.indexOf(needle);
      if (at !== -1) { assert.ok(guard < at, needle + " must sit behind the gate"); }
    });
  });
  /* And a declined play() is harmless again: the walk reaches the speaker regardless. */
  assert.ok(!/keepaliveFallback/.test(start));
});
