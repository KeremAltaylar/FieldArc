// tests/android-audio.test.mjs — what makes a mid-range Android survive the route stack.
/* Kerem, 2026-09-21: "Android Chrome is terrible, full of glitches and I guess synth stacks."
   The guess was right about the stack and wrong about which part of it. Measured by rendering
   each piece in an OfflineAudioContext and timing it (impulse generation separated from
   steady-state convolution, because Tone.Reverb generates its impulse by rendering offline and
   that was inflating the first numbers):

     3 convolution reverbs, as shipped ... 351 ms to generate, 60.9 % of realtime to run
     1 shared convolver ................... 118 ms, 21.2 %
     3 Freeverb (algorithmic) ............. 0 ms,  9.0 %
     3 JCReverb ........................... 0 ms,  7.1 %
     the FM synths alone, no room ......... 0 ms,  6.6 %

   So the three Tone.Reverb convolvers are ~90 % of the route stack's cost, and the synths,
   waveshapers and choruses together are 6.6 %. Decay length barely matters (3.4 s and 7.6 s
   cost the same) — it is the COUNT of convolvers, not the tails, so capping decay would have
   bought nothing. 54 points of a desktop core, before two PaulX stretch voices, on a phone core
   a quarter as fast: continuously past realtime, which is what "full of glitches" is.

   Kerem chose algorithmic rooms on small devices only, so a desktop keeps its convolution. */
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

/* ---- The output buffer ---- */

/* Began as latencyHint "playback"; became an explicit 50 ms once Kerem heard what Android picks
   for "playback" as latency. tests/mobile-budget.test.mjs owns the number itself. */
test("the context asks for more buffer than Tone's default", () => {
  const fn = src("tuneToneContext");
  assert.ok(!/latencyHint: "interactive"/.test(fn),
    'Tone\'s default is "interactive" — the smallest buffer Android will hand out. Nothing here ' +
    "is played by hand, so that latency buys nothing and costs glitch headroom");
  assert.match(fn, /latencyHint: 0\.05/);
  assert.match(fn, /Tone\.setContext/);
  assert.match(fn, /try \{/, "an older Tone, or a context that cannot be replaced, must not break sound");
  /* Both paths through loadTone: the cached window.Tone and the freshly injected script. */
  const loader = src("loadTone");
  assert.equal((loader.match(/tuneToneContext\(/g) || []).length, 2,
    "the cached-Tone path needs it as much as the first load does");
});

test("the context is tuned once, before any node is built", () => {
  const fn = src("tuneToneContext");
  assert.match(fn, /if \(tuneToneContext\.done\) \{ return Tone; \}/,
    "replacing the context after the graph exists would orphan every node on it");
  assert.match(fn, /tuneToneContext\.done = true;/);
});

/* ---- The rooms ---- */

/* smallDevice() stopped being the decision on 2026-09-22 (task 8) — it guessed "phone" from
   screen size and deviceMemory, and guessed wrong for Kerem's own iPhone: 390px and a coarse
   pointer read as small while the full stack cost it 9.7% of one core, four times the headroom
   the dev desktop needed to run the same stack at 70.6%. richAudio() replaced it at every call
   site that spends CPU (the four this file and mobile-budget.test.mjs cover); smallDevice()
   survives only as richAudio()'s fallback for a device that cannot be measured, and as the gate
   on mediaSessionStart/Stop, which is not a cost question — see tests/audio-capability.test.mjs
   for the threshold and fallback themselves. */
test("smallDevice still exists: richAudio()'s fallback, the recording cap, and the media-session gate", () => {
  const small = src("smallDevice");
  assert.match(small, /navigator\.deviceMemory/);
  assert.match(small, /pointer: coarse/);
  assert.match(small, /Math\.min\(screen\.width, screen\.height\) <= 500/);
  /* Review CRITICAL 2, 2026-09-22: the recording cap is a memory ceiling (each soundscape voice
     holds its whole recording), which a render-cost probe knows nothing about. Asking richAudio()
     here gave Kerem's 9.7% iPhone four resident recordings — the Koşuyolu tab-kill again. */
  const budget = src("voiceBudget");
  assert.match(budget, /smallDevice\(\)/, "the recording cap asks the memory question");
  assert.ok(!/richAudio\(\)/.test(budget), "not the render-cost one");
  /* mediaSessionStart/Stop are a real, deliberate exception: backgrounding is not a cost
     question, so they still gate on smallDevice() directly rather than richAudio(). */
  assert.match(src("mediaSessionStart"), /smallDevice\(\)/);
  assert.match(src("mediaSessionStop"), /smallDevice\(\)/);
});

test("a device that measures too expensive gets algorithmic rooms; a capable one keeps convolution", () => {
  const fn = src("makeRoom");
  assert.match(fn, /richAudio\(\)/);
  assert.match(fn, /new Tone\.Freeverb/, "measured 9.0% against the convolver's 60.9%");
  assert.match(fn, /new Tone\.Reverb\(\{ decay: decay, wet: 0 \}\)/,
    "a device that measures cheap enough is unchanged — Kerem's patches keep the rooms he wrote them in");
  /* buildFxChain must go through it rather than constructing a Reverb itself. */
  const chain = src("buildFxChain");
  assert.match(chain, /makeRoom\(Tone, cfg\.revDecay\)/);
  assert.ok(!/new Tone\.Reverb/.test(chain), "no second construction site");
  /* The rhythm room is the fourth one, and counts the same. */
  assert.match(src("buildRhythmFx"), /makeRoom\(/, "the rhythm room is a room too");
});

test("a room's size still follows the patch's decay, on both kinds", () => {
  const fn = src("roomSize");
  const run = new Function("decay", fn + "; return roomSize(decay);");
  const small = run(0.4), mid = run(3.4), big = run(7.6);
  assert.ok(small < mid && mid < big, "a longer decay is a bigger room: " + [small, mid, big]);
  assert.ok(small >= 0 && big <= 0.95, "and stays inside Freeverb's range: " + [small, big]);
  assert.ok(run(0) >= 0 && run(60) <= 0.95, "clamped at both ends");
});

test("changing decay on an algorithmic room costs nothing and never regenerates", () => {
  const fn = src("applyDecayTo");
  assert.match(fn, /typeof rv\.generate !== "function"/,
    "a Freeverb has no impulse to generate — setting roomSize is instant");
  const at = fn.indexOf('typeof rv.generate !== "function"');
  assert.ok(at < fn.indexOf("rv.__busy = true"),
    "and it must return before the fade-out/regenerate dance, which exists only for convolvers");
  assert.match(fn.slice(at, at + 220), /roomSize/);
});

/* ---- The Sound toggle's fade ---- */

test("Sound fades in over 2s and out over 1.5s", () => {
  assert.match(html, /var SOUND_FADE_IN = 2;/, "Kerem chose a slow bloom");
  assert.match(html, /var SOUND_FADE_OUT = 1\.5;/);
  assert.match(src("bedStart"), /fadeSound\(bed\.fade\.gain, 1, SOUND_FADE_IN\)/);
  assert.match(src("bedStop"), /fadeSound\(bed\.fade\.gain, 0, SOUND_FADE_OUT\)/);
});

/* Not because rampTo is broken — for a gain param it is a linear ramp that arrives on time
   (only frequency/bpm/decibels params take Tone's exponential approach). Two real reasons: an
   interrupted fade must restart from where it got to, and a release must end in true silence. */
test("an interrupted fade restarts from where it got to, and Stop ends in true silence", () => {
  const fn = src("fadeSound");
  assert.match(fn, /param\.cancelScheduledValues\(now\)/,
    "Stop halfway through the bloom must not leave a ramp still pulling toward 1");
  assert.match(fn, /param\.setValueAtTime\(from, now\)/,
    "and must continue from the value the fade actually reached");
  assert.match(fn, /linearRampToValueAtTime\(to, now \+ seconds\)/,
    "in is linear: an exponential rise from silence sits at nothing then lunges");
  assert.match(fn, /exponentialRampToValueAtTime\(0\.0001, now \+ seconds\)/, "out holds its shape (A-3)");
  assert.match(fn, /param\.setValueAtTime\(0, now \+ seconds\)/,
    "exponential cannot reach zero, so it is pinned there at the end — silence must be silent");
  /* The teardown is scheduled off the same number, so it fires after the fade, not during. */
  assert.match(src("bedStop"), /SOUND_FADE_OUT \* 1000 \+ 80/);
});

test("the fade has its own node, so it does not fight the walk's fade", () => {
  const start = src("bedStart");
  assert.match(start, /var fade = new Tone\.Gain\(0\)\.connect\(limiter\)/,
    "starts silent and blooms; bed.walk stays the GPS fade's alone (setWalkLevel ramps it)");
  assert.match(start, /walk = new Tone\.Gain\(1\)\.connect\(fade\)/,
    "walk -> fade -> limiter, so the two fades multiply rather than overwrite each other");
});

test("Stop keeps sounding while it fades, and tears down only afterwards", () => {
  const stop = src("bedStop");
  assert.match(stop, /bed\.on = false;/);
  const onAt = stop.indexOf("bed.on = false;");
  const teardownAt = stop.indexOf("bedTeardown");
  assert.ok(onAt !== -1 && teardownAt > onAt,
    "nothing new may spin up during the fade (updateBed returns on !bed.on), but the voices " +
    "that are sounding must keep sounding until the fade has run");
  assert.match(stop, /setTimeout\(/, "the teardown is deferred by the fade's own length");
  assert.ok(!/rampTo\(0, 0\.2\)/.test(stop),
    "the old per-voice 0.2s ramp would cut the tail 1.3s before the master fade finished");
  /* Pressing Sound again mid-fade must resume, not die when the pending teardown lands. */
  const teardown = src("bedTeardown");
  assert.match(teardown, /if \(!bed \|\| bed\.on\) \{ return; \}/,
    "a pending teardown must stand down if Sound came back on");
  const start = src("bedStart");
  assert.match(start, /clearTimeout\(bed\.fadeTimer\)/, "and the timer is cleared on the way back up");
});
