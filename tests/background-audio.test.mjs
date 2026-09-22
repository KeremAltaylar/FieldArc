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

test("desktop is left alone — no backgrounding problem there, and arming it is a regression", () => {
  /* Desktop has no screen to lock and no phone in a pocket — nothing here helps it. Arming it
     anyway would be a live annoyance: a "Fieldscape" Now Playing entry, and desktop media keys
     silently retargeting to the walk whenever Sound is on. Gated the same way makeWarp,
     buildFxChain and voiceBudget already gate their own, opposite-direction cost. */
  [src("mediaSessionStart"), src("mediaSessionStop")].forEach((fn) => {
    const guardAt = fn.indexOf("if (!smallDevice()) { return; }");
    assert.ok(guardAt !== -1, "missing the smallDevice() gate");
    /* Both halves — the keepalive element AND the mediaSession wiring — must be gated, not just
       one: a desktop-shaped environment must never touch either. */
    ["el.play()", "el.pause()", "navigator.mediaSession"].forEach((needle) => {
      const at = fn.indexOf(needle);
      if (at !== -1) {
        assert.ok(guardAt < at, needle + " runs before the smallDevice() gate — desktop would " +
          "still arm this");
      }
    });
  });
});

test("the context watchdog stays — this reduces suspensions, it does not abolish them", () => {
  assert.match(src("bedStart"), /bed\.resumeLoop/,
    "a phone call, a Bluetooth switch or an audio-focus change can still take the context out");
});
