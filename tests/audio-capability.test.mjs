// tests/audio-capability.test.mjs — deciding audio quality by measuring the device, not guessing.
/* Kerem, 2026-09-22, on his own iPhone: "sound is still bad when I open the sound." smallDevice()
   guessed "phone" from screen size and deviceMemory, and guessed wrong: 390px and a coarse
   pointer read as small while the full route stack cost that phone 9.7% of one core — four times
   the headroom the dev desktop needed to run the same stack at 70.6% (task-8-brief.md). richAudio()
   replaces the guess with a measurement: render a short offline copy of the full stack and time
   it, the same method diag.html section 5 already proved, and take the cheap path only when a
   device genuinely cannot keep up in real time.

   This file covers richAudioVerdict/saneCapabilityPct as the pure functions they were written to
   be, the caching and fallback behaviour of richAudio()/primeAudioCapability() around them, the
   bedStart ordering that keeps the first walk of a session from racing the probe, and that
   diag.html surfaces what index.html actually decided. tests/android-audio.test.mjs and
   tests/mobile-budget.test.mjs cover the four call sites (makeRoom, makeWarp, buildFxChain,
   voiceBudget) themselves. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8").replace(/\r\n/g, "\n");
const diagHtml = readFileSync("diag.html", "utf8").replace(/\r\n/g, "\n");

function src(name) {
  const s = html.indexOf("function " + name + "(");
  assert.ok(s !== -1, "missing " + name);
  let i = html.indexOf("{", html.indexOf(")", s)), d = 0;
  for (; i < html.length; i++) { if (html[i] === "{") d++; else if (html[i] === "}") { d--; if (!d) break; } }
  return html.slice(s, i + 1);
}
function varDecl(name) {
  const start = html.indexOf("var " + name);
  assert.ok(start !== -1, "missing var " + name);
  return html.slice(start, html.indexOf(";", start) + 1);
}
function mm(pointer) {
  /* A real matchMedia answers by query, not by device — a fine pointer never matches "coarse". */
  return function (q) { return { matches: q.indexOf("pointer: " + pointer) !== -1 }; };
}

/* ---- richAudioVerdict: pure, no localStorage, no matchMedia, no probe ---- */

function verdictFn() {
  const fn = src("smallDevice") + varDecl("AUDIOCAP_THRESHOLD") + src("saneCapabilityPct") +
    src("richAudioVerdict");
  return new Function("navigator", "window", "screen", fn + "; return richAudioVerdict;");
}

test("the threshold is exactly 80%, calibrated from the brief's two real measurements", () => {
  assert.match(html, /var AUDIOCAP_THRESHOLD = 80;/,
    "Kerem's iPhone measured 9.7% and the dev desktop 70.6% — both must keep full quality, and " +
    "both are comfortably under this. It is calibration, not a knob to turn until a test passes.");
});

test("a fine pointer is always true, unconditionally — never measured, never downgraded", () => {
  const verdict = verdictFn()({}, {}, {});
  assert.equal(verdict(true, 9999), true, "even a nonsense reading cannot downgrade a desktop");
  assert.equal(verdict(true, undefined), true, "and neither can no reading at all");
  assert.equal(verdict(true, 0.1), true, "nor a real, cheap, reading — desktop is unconditional");
});

test("a coarse pointer takes the cheap path only above 80% of realtime", () => {
  const verdict = verdictFn()({ deviceMemory: 16 }, { matchMedia: () => ({ matches: false }) },
    { width: 2560, height: 1440 });
  assert.equal(verdict(false, 9.7), true, "Kerem's iPhone — full quality, overwhelming headroom");
  assert.equal(verdict(false, 70.6), true, "the dev desktop's own number — also kept full quality");
  assert.equal(verdict(false, 80), true, "at the threshold itself, still full quality");
  assert.equal(verdict(false, 80.1), false, "just over — genuinely cannot keep up in real time");
  assert.equal(verdict(false, 100), false);
});

test("a nonsense reading falls back to smallDevice()'s guess, never to an optimistic default", () => {
  /* Missing OfflineAudioContext, a throw, or a nonsense number must not hand the expensive path
     to a device that could not even be measured — task-8-brief.md point 5. */
  const desktopLike = verdictFn()({ deviceMemory: 16 }, { matchMedia: mm("fine") },
    { width: 2560, height: 1440 });
  const phoneLike = verdictFn()({ deviceMemory: 4 }, { matchMedia: mm("coarse") },
    { width: 390, height: 844 });
  [undefined, NaN, 0, -1, -9.7, Infinity, 1e7, "9.7", null].forEach((bad) => {
    assert.equal(desktopLike(false, bad), true, "falls back to !smallDevice() for " + bad);
    assert.equal(phoneLike(false, bad), false, "falls back to !smallDevice() for " + bad);
  });
});

test("saneCapabilityPct rejects zero, negative, NaN and absurdly large readings", () => {
  const sane = new Function(src("saneCapabilityPct") + "; return saneCapabilityPct;")();
  [0, -1, -9.7, NaN, Infinity, -Infinity, "9.7", null, undefined, 100000, 1e9].forEach((bad) => {
    assert.equal(sane(bad), false, String(bad) + " must not be sane");
  });
  [0.001, 9.7, 70.6, 80, 99999.9].forEach((good) => {
    assert.equal(sane(good), true, String(good) + " must be sane");
  });
});

/* ---- The cache key ---- */

test("the cache key matches the existing lowercase fieldarc.* family and stores the number", () => {
  assert.match(html, /var AUDIOCAP_KEY = "fieldarc\.audiocap";/,
    "existing keys (fieldarc.gps, fieldarc.place, ...) already name data in people's browsers " +
    "and must not be renamed");
  assert.match(src("richAudio"), /localStorage\.getItem\(AUDIOCAP_KEY\)/);
  assert.match(src("richAudio"), /parseFloat\(cached\)/,
    "the measured number is read back, not just a yes/no flag");
  assert.match(src("primeAudioCapability"), /localStorage\.setItem\(AUDIOCAP_KEY, String\(pct\)\)/,
    "and the measured number is what gets written, so it can be read back during support");
});

/* ---- richAudio() / primeAudioCapability(): caching and fallback, end to end ---- */

function primeModule() {
  const fn = [
    src("smallDevice"), varDecl("AUDIOCAP_KEY"), varDecl("AUDIOCAP_THRESHOLD"),
    varDecl("finePointerCached"), src("finePointer"), src("saneCapabilityPct"),
    src("richAudioVerdict"), varDecl("audioCapPct"), src("richAudio"),
    varDecl("audioCapPriming"), src("voiceBudget"), src("recomputeVoiceBudget"),
    src("primeAudioCapability")
  ].join("\n");
  /* pacer and BED are extra, optional params: recomputeVoiceBudget's `if (pacer && ...)` guard
     makes it a safe no-op when a test has no reason to care about it (they are simply undefined),
     and a test that does (below) passes real objects and inspects BED.maxVoices afterwards —
     passed by reference, so mutating it inside primeAudioCapability is visible to the caller. */
  return new Function("navigator", "window", "screen", "localStorage", "audioCapability", "pacer", "BED",
    fn + "; return { prime: primeAudioCapability, rich: richAudio, pct: function () { return audioCapPct; } };");
}

test("primeAudioCapability never calls the probe on a fine pointer, and never touches localStorage", () => {
  let probed = false;
  const localStorage = { getItem: function () { throw new Error("must not touch localStorage on a desktop"); } };
  const mod = primeModule()({ deviceMemory: 16 }, { matchMedia: mm("fine") }, { width: 2560, height: 1440 },
    localStorage, function () { probed = true; return Promise.resolve(9.7); });
  return mod.prime({}).then(() => {
    assert.equal(probed, false, "the probe must never run on a fine pointer");
    assert.equal(mod.rich(), true);
  });
});

test("a coarse pointer with nothing cached probes once, then caches in memory and in localStorage", () => {
  let probeCalls = 0;
  const store = {};
  const localStorage = {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = v; }
  };
  const mod = primeModule()({}, { matchMedia: mm("coarse") }, { width: 390, height: 844 }, localStorage,
    function () { probeCalls++; return Promise.resolve(9.7); });
  return mod.prime({}).then(() => {
    assert.equal(probeCalls, 1);
    assert.equal(store["fieldarc.audiocap"], "9.7", "the measured number is what gets stored");
    assert.equal(mod.rich(), true);
    return mod.prime({});
  }).then(() => {
    assert.equal(probeCalls, 1, "a second prime in the same session must not probe again");
  });
});

test("a value already cached from a previous session is used without ever probing", () => {
  let probeCalls = 0;
  const store = { "fieldarc.audiocap": "70.6" };
  const localStorage = {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function () { throw new Error("must not re-write an existing cache"); }
  };
  const mod = primeModule()({}, { matchMedia: mm("coarse") }, { width: 390, height: 844 }, localStorage,
    function () { probeCalls++; return Promise.resolve(9.7); });
  return mod.prime({}).then(() => {
    assert.equal(probeCalls, 0, "a cached reading must never be re-measured");
    assert.equal(mod.rich(), true, "70.6% is under threshold");
  });
});

test("a failed probe falls back safely and is never written to the cache", () => {
  const store = {};
  const localStorage = {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = v; }
  };
  const mod = primeModule()({ deviceMemory: 4 }, { matchMedia: mm("coarse") }, { width: 390, height: 844 },
    localStorage, function () { return Promise.resolve(-1); });   /* what audioCapability() resolves on any failure */
  return mod.prime({}).then(() => {
    assert.equal(store["fieldarc.audiocap"], undefined, "nonsense must not poison the cache for next time");
    assert.equal(mod.rich(), false, "falls back to smallDevice(), which this phone fails too");
  });
});

/* ---- Fix round 1, finding 1: a corrupt cache entry must not be permanent ---- */

test("an insane cached string is never adopted, and always triggers a fresh, overwriting probe", () => {
  /* Both richAudio() and primeAudioCapability() used to gate on `cached !== null` alone, not on
     the parsed value being sane — so a corrupt entry (or a future format change) became a
     sticky, permanent audioCapPct with saneCapabilityPct correctly rejecting it every time but
     the probe never running again to fix it. Every kind of "corrupt" the brief names: zero,
     negative, NaN and absurdly large — plus the literal parseFloat failure text and an empty
     string. */
  const cases = ["not-a-number", "NaN", "0", "-5", "", "1e9"];
  return Promise.all(cases.map((bad) => {
    let probeCalls = 0;
    const store = { "fieldarc.audiocap": bad };
    const localStorage = {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setItem: function (k, v) { store[k] = v; }
    };
    const mod = primeModule()({ deviceMemory: 4 }, { matchMedia: mm("coarse") }, { width: 390, height: 844 },
      localStorage, function () { probeCalls++; return Promise.resolve(9.7); });
    return mod.prime({}).then(() => {
      assert.equal(probeCalls, 1, JSON.stringify(bad) + " must not short-circuit the probe");
      assert.equal(store["fieldarc.audiocap"], "9.7", JSON.stringify(bad) + " must be overwritten by the fresh reading");
      assert.equal(mod.rich(), true, "9.7% keeps full quality once the real measurement lands");
    });
  }));
});

test("richAudio() itself never adopts a corrupt cached value either — same fallback, no throw", () => {
  function richAudioModule() {
    const fn = [
      src("smallDevice"), varDecl("AUDIOCAP_KEY"), varDecl("AUDIOCAP_THRESHOLD"),
      varDecl("finePointerCached"), src("finePointer"), src("saneCapabilityPct"),
      varDecl("audioCapPct"), src("richAudioVerdict"), src("richAudio")
    ].join("\n");
    return new Function("navigator", "window", "screen", "localStorage", fn + "; return richAudio;");
  }
  const localStorage = { getItem: function () { return "not-a-number"; } };
  const richPhone = richAudioModule()({ deviceMemory: 4 }, { matchMedia: mm("coarse") },
    { width: 390, height: 844 }, localStorage);
  /* A big-screened coarse-pointer device (a tablet) smallDevice() would not have called "small" */
  const richCapableGuess = richAudioModule()({ deviceMemory: 16 }, { matchMedia: mm("coarse") },
    { width: 900, height: 900 }, localStorage);
  assert.doesNotThrow(() => richPhone());
  assert.equal(richPhone(), false, "falls back to smallDevice(), which this phone fails");
  assert.equal(richCapableGuess(), true, "falls back to !smallDevice() for a device the old guess liked");
});

/* ---- Fix round 1, finding 2: voiceBudget()'s other call sites can run before the probe has ---- */

test("BED.maxVoices is recomputed once the probe settles, against whatever patch is current then", () => {
  const store = {};
  const localStorage = {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = v; }
  };
  /* pacerStart/worldStart already ran voiceBudget() against the pre-measurement fallback and set
     this — the exact stale value this recompute exists to correct. */
  const pacer = { patch: { bed: { voices: 4 } } };
  const BED = { maxVoices: 2 };
  const mod = primeModule()({}, { matchMedia: mm("coarse") }, { width: 390, height: 844 }, localStorage,
    function () { return Promise.resolve(9.7); }, pacer, BED);
  return mod.prime({}).then(() => {
    assert.equal(BED.maxVoices, 4, "corrected once richAudio() is actually known — 9.7% keeps full quality");
  });
});

test("recomputeVoiceBudget is a safe no-op with no pacer yet — first load, before any walk started", () => {
  const mod = primeModule()({ deviceMemory: 16 }, { matchMedia: mm("fine") }, { width: 2560, height: 1440 },
    { getItem: function () { return null; } }, function () { throw new Error("must not probe a desktop"); },
    undefined, undefined);
  return mod.prime({});   /* must resolve without throwing */
});

test("a legitimate reselect that already ran with the final answer is not clobbered by the recompute", () => {
  const store = { "fieldarc.audiocap": "9.7" };
  const localStorage = {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = v; }
  };
  /* Stands in for worldSwap's take() or commitPatch having already run AFTER the probe settled,
     computing the right answer on its own. The recompute must reproduce it, not overwrite it
     with something else. */
  const pacer = { patch: { bed: { voices: 3 } } };
  const BED = { maxVoices: 3 };
  const mod = primeModule()({}, { matchMedia: mm("coarse") }, { width: 390, height: 844 }, localStorage,
    function () { throw new Error("cached — must not probe"); }, pacer, BED);
  return mod.prime({}).then(() => {
    assert.equal(BED.maxVoices, 3, "recompute reproduces the same, already-correct answer — not a clobber");
  });
});

/* ---- Ordering: the trap this task must not fall into ---- */

test("bedStart resolves primeAudioCapability before buildVoice is reachable — chained, not raced", () => {
  /* primeAudioCapability returns a promise (OfflineAudioContext rendering is async) and this file
     is ES5 — no await. Firing it without waiting would let the very first walk of a session take
     the wrong path while every later one gets the right one, invisibly. */
  const fn = src("bedStart");
  assert.match(fn, /return primeAudioCapability\(Tone\)\.then\(function \(\) \{/,
    "must be .then()-chained, not fired-and-forgotten");
  const primeAt = fn.indexOf("primeAudioCapability(Tone).then(");
  const buildAt = fn.indexOf("buildVoice(Tone, patch)");
  assert.ok(primeAt !== -1 && buildAt !== -1 && primeAt < buildAt,
    "buildVoice must be textually inside the primeAudioCapability callback, not before it");
});

test("primeAudioCapability's promise genuinely stays pending until the probe resolves — the mechanism bedStart's .then() chain depends on", () => {
  /* Behavioural, not textual: exercises the REAL primeAudioCapability extracted from index.html,
     with a deliberately slow, hand-controlled stub standing in for the actual
     OfflineAudioContext render (this harness has no browser to run one for real — see the
     "audioCapability renders only after every collected .ready promise has actually resolved"
     test above for that half, which IS run against real promise timing). It proves the promise
     bedStart chains a buildVoice-standin behind genuinely does not resolve early — exactly the
     failure a fire-and-forget call would have produced invisibly on a session's first Sound
     press.

     Full bedStart() itself is deliberately NOT executed here. It also touches the DOM
     ($("#patch-play"), window.__fa), Tone.Transport scheduling, and the entire buildVoice/
     buildFxChain/makeWarp graph — which is why every other test in this suite that checks
     bedStart's internal ordering (tests/wake-lock.test.mjs, tests/rhythm-stretch.test.mjs,
     tests/background-audio.test.mjs, tests/patch-follows-route.test.mjs,
     tests/open-world-audio.test.mjs) does the same source-position check as the test above
     rather than calling it: there is no existing harness for running bedStart, and building a
     faithful one would mean re-implementing large parts of Tone.js's API to avoid throwing. This
     test instead proves, by real execution, the one piece that was actually at risk. */
  const fn = [
    src("smallDevice"), varDecl("AUDIOCAP_KEY"), varDecl("AUDIOCAP_THRESHOLD"),
    varDecl("finePointerCached"), src("finePointer"), src("saneCapabilityPct"),
    src("richAudioVerdict"), varDecl("audioCapPct"), src("richAudio"),
    varDecl("audioCapPriming"), src("voiceBudget"), src("recomputeVoiceBudget"),
    src("primeAudioCapability")
  ].join("\n");
  let resolveProbe;
  const slowProbe = function () { return new Promise((r) => { resolveProbe = r; }); };
  const primeAudioCapability = new Function("navigator", "window", "screen", "localStorage",
    "audioCapability", "pacer", "BED", fn + "; return primeAudioCapability;")(
    {}, { matchMedia: mm("coarse") }, { width: 390, height: 844 },
    { getItem: function () { return null; }, setItem: function () {} },
    slowProbe, undefined, undefined);

  let buildVoiceCalled = false;
  /* The exact shape bedStart itself uses: return primeAudioCapability(Tone).then(function () { ... buildVoice ... }); */
  const chained = primeAudioCapability({}).then(function () { buildVoiceCalled = true; });

  function flush(times) {
    var p = Promise.resolve();
    for (var i = 0; i < times; i++) { p = p.then(function () {}); }
    return p;
  }
  return flush(5).then(function () {
    assert.equal(buildVoiceCalled, false, "must still be waiting — the probe has not resolved yet");
    resolveProbe(9.7);
    return chained;
  }).then(function () {
    assert.equal(buildVoiceCalled, true, "runs once the probe genuinely resolves");
  });
});

test("no async/await anywhere in index.html or diag.html — ES5 only", () => {
  assert.ok(!/\basync\s+function\b/.test(html) && !/\bawait\b/.test(html), "index.html");
  assert.ok(!/\basync\s+function\b/.test(diagHtml) && !/\bawait\b/.test(diagHtml), "diag.html");
});

/* ---- The probe itself ---- */

test("the probe is kept short: about 1.5s of audio, not diag.html's 4s", () => {
  assert.match(src("audioCapability"), /var SECONDS = 1\.5;/,
    "runs once, unattended, on a person's first Sound press with this device — short enough " +
    "not to be felt there");
});

test("the probe resolves -1 rather than rejecting, on every failure path", () => {
  const fn = src("audioCapability");
  assert.match(fn, /typeof OfflineAudioContext === "undefined"/);
  assert.match(fn, /return Promise\.resolve\(-1\)/);
  assert.match(fn, /catch \(e\) \{ resolve\(-1\); \}/);
  assert.ok(!/\breject\(/.test(fn), "never rejects — a caller that forgot .catch must not hang or throw");
});

/* ---- Fix round 1, ruling: await the real impulse-generation promises, not a guessed duration ---- */

test("no fixed wait stands in for real impulse-ready promises any more", () => {
  const fn = src("audioCapability");
  assert.ok(!/setTimeout/.test(fn),
    "a guessed 400ms was replaced by Promise.all over each reverb's own .ready — unnecessarily " +
    "slow on a quick device and not necessarily enough on a genuinely slow one");
  assert.match(fn, /Promise\.all\(ready\)/);
  assert.match(fn, /audioCapabilityStack\(Tone, ready\)/, "the collected .ready promises are passed in");
});

test("audioCapabilityStack collects every reverb's own .ready promise when asked", () => {
  const fn = src("audioCapabilityStack");
  assert.match(fn, /function audioCapabilityStack\(Tone, readyList\)/);
  assert.match(fn, /if \(readyList\) \{ readyList\.push\(r\.ready\); \}/);
  assert.ok(!/\.generate\(\)/.test(fn),
    "must not call generate() a second time — Tone.Reverb's own constructor already triggers " +
    "it once and keeps that render's completion promise on .ready");
});

/* Behavioural, not just textual: a real Tone.Reverb starts generating the moment it is
   constructed and resolves .ready when that offline render actually finishes — this proves
   audioCapability() really waits for that, rather than a fixed duration that happens to still
   be present in some other form. */
test("audioCapability renders only after every collected .ready promise has actually resolved", () => {
  function stubTone() {
    var readies = [];
    function chainable() {
      var n = {};
      n.connect = function () { return n; };
      n.toDestination = function () { return n; };
      n.start = function () { return n; };
      n.triggerAttack = function () {};
      return n;
    }
    function Reverb() {
      var n = chainable();
      var resolve;
      n.ready = new Promise(function (r) { resolve = r; });
      readies.push({ node: n, resolve: resolve });
      return n;
    }
    return {
      readies: readies,
      T: {
        Gain: function () { return chainable(); },
        Limiter: function () { return chainable(); },
        Filter: function () { return chainable(); },
        FeedbackDelay: function () { return chainable(); },
        Chorus: function () { return chainable(); },
        WaveShaper: function () { return chainable(); },
        FMSynth: function () { return chainable(); },
        NoiseSynth: function () { return chainable(); },
        Reverb: Reverb,
        getContext: function () { return "prev-ctx"; },
        setContext: function () {}
      }
    };
  }
  function flush(times) {
    var p = Promise.resolve();
    for (var i = 0; i < times; i++) { p = p.then(function () {}); }
    return p;
  }
  const fn = src("audioCapabilityStack") + "\n" + src("audioCapability");
  function FakeOfflineAudioContext() {
    this.startRendering = function () { FakeOfflineAudioContext.called = true; return Promise.resolve(); };
  }
  const audioCapability = new Function("OfflineAudioContext", "performance",
    fn + "; return audioCapability;")(FakeOfflineAudioContext, { now: function () { return 0; } });
  const stub = stubTone();
  const done = audioCapability(stub.T);
  assert.equal(stub.readies.length, 4, "three route chains plus the rhythm room");
  return flush(5).then(() => {
    assert.ok(!FakeOfflineAudioContext.called, "must not render before every impulse is ready");
    stub.readies.slice(0, 3).forEach((r) => r.resolve());
    return flush(5);
  }).then(() => {
    assert.ok(!FakeOfflineAudioContext.called, "must not render while even one reverb is still generating");
    stub.readies[3].resolve();
    return flush(5);
  }).then(() => {
    assert.ok(FakeOfflineAudioContext.called, "renders once every real .ready promise has resolved");
    return done;
  });
});

test("the probe stack always builds the FULL route — asking richAudio() inside it would be circular", () => {
  const fn = src("audioCapabilityStack");
  /* One Reverb/FeedbackDelay/Chorus each in SOURCE, inside a room()/chain()/voice() helper that
     is CALLED four (room), three (chain) and three (voice) times — the same "same node types and
     counts" shape diag.html's buildStack(T, false) uses, just written as a helper instead of
     unrolled four times. */
  assert.match(fn, /function room\(decay\) \{[\s\S]*new Tone\.Reverb/);
  assert.match(fn, /function chain\(c\) \{[\s\S]*new Tone\.FeedbackDelay/);
  assert.match(fn, /new Tone\.Chorus\(\{ frequency: rate/);
  assert.match(fn, /var fx = chain\(\{ d: 3\.4,/);
  assert.match(fn, /var fx2 = chain\(\{ d: 0\.4,/);
  assert.match(fn, /var fx3 = chain\(\{ d: 7\.6,/);
  assert.match(fn, /voice\(fx, 2, 0\.55\)/, "the pad: bass and top");
  assert.match(fn, /voice\(fx2, 1, 1\.7\)/, "the sector counter-line");
  assert.match(fn, /voice\(fx3, 1, 0\.35\)/, "the third voice");
  assert.match(fn, /var rr = room\(1\.2\)/, "the rhythm room — a fourth room(), outside the three chains");
  assert.match(fn, /new Tone\.NoiseSynth/, "the rhythm room's own source");
  assert.ok(!/richAudio\(\)|smallDevice\(\)/.test(fn),
    "this is the FULL stack, unconditionally — richAudio() is the answer this probe exists to " +
    "produce, so calling it here would measure whichever path it happened to fall back to");
});

/* ---- diag.html shows what index.html actually decided ---- */

test("diag.html surfaces the measured number and which path it produced", () => {
  assert.match(diagHtml, /var AUDIOCAP_KEY = "fieldarc\.audiocap";/,
    "the same key index.html writes, so a phone that has opened the real app shows its real reading");
  assert.match(diagHtml, /var AUDIOCAP_THRESHOLD = 80;/);
  assert.match(diagHtml, /function richAudioVerdict\(/);
  assert.match(diagHtml, /audLine\("fieldarc\.audiocap \(cached on this device\)"/);
  assert.match(diagHtml, /audLine\("audio path index\.html actually runs, right now"/);
  /* The render test's own live measurement is logged too, not just the cached reading. */
  assert.match(diagHtml, /audLog\("richAudio\(\)      " \+ \(rich \? "TRUE" : "FALSE"\)/);
});
