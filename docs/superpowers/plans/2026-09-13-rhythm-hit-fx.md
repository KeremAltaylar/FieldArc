# Rhythm mode v2, part 2: per-slot bitcrush, distortion and delay — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each of a rhythm point's four voices (low/mid/high/rand) gets its own small insert
chain — bitcrush, a distortion stage, and an independent short delay — sitting upstream of the
existing shared route-wide room (filter/drive/delay/reverb), which stays exactly as it is. A
"Randomize effects" action rolls new values across all four voices in one click, separate from
"Generate a pattern," so a setter can keep a pattern they like and only reroll its effects (or
the reverse).

**Architecture:** One new per-slot audio chain (`buildHitFx`), built once per slot when a
point's players are constructed and never torn down while it plays (matching every other
audio-graph rule already in this file). Each insert is a `makeBlend()` dry/wet pair — the same
two-summed-gains primitive the shared room's own drive control already uses, not
`Tone.CrossFade` (this file's own A-17 finding documents why). Every new parameter defaults to
its off position (0, or a delay wet of 0), so a point built before this plan lands sounds
identical until a setter touches a new slider.

**Tech Stack:** Same as the rest of `index.html` — ES5 `function` expressions, Tone.js v15
(already loaded from unpkg), `Tone.BitCrusher` is a standard effect in that build. No new
library.

**Spec:** `docs/superpowers/specs/2026-09-13-rhythm-mode-v2-design.md` ("New per-slot inserts"
and the "Decided 2026-09-13, after the first design pass" addendum on Randomize effects).

## Global Constraints

- **Every new effect starts dry.** `crush = 0`, `drive = 0`, `delayWet = 0` on every existing
  and new point until a setter (or "Randomize effects") changes them — a point built before
  this plan must sound identical to today, silently.
- **These are per-slot inserts, upstream of the existing shared room.** `buildRhythmFx`'s
  filter/drive/delay/reverb chain (one instance, shared by every rhythm point on a route) is
  not touched by this plan at all — grep the diff to confirm.
- **No `Tone.Transport.scheduleRepeat`/`.clear()` call may be added.** This plan only adds
  audio nodes built once per point (same lifecycle `R.players`/`R.gain` already have) and a
  parameter-application function called on slider input — nothing here touches scheduling.
- **`delayDiv` is a musical division with a real display**, from the same `DIVISIONS`/
  `DIV_LABEL` this file already uses for the shared room's own delay and `RHYTHM_FIELDS`' own
  `div` row — not a free-running number.
- **Backfilling new voice fields on an existing point must never change that point's
  `pulses`/`rotate`/`gain`/`pitch`** — field-by-field, the same rule `rhythmOf()` already
  applies to `idiom`/`sentenceBars`/`sentenceSet`.
- Commit messages: a declarative sentence, then what it prevents or what was measured.

## File Structure

| File | Responsibility |
| --- | --- |
| `index.html` | Five new per-voice fields (`crush`, `drive`, `delayDiv`, `delayFb`, `delayWet`) in `defaultRhythm()`/`rhythmOf()`'s backfill, new sliders + a delay-division select in the rhythm panel, `randomHitFx()`, `buildHitFx()`, `applyHitFx()`, wiring into `ensureRhythm()`/`disposeRhythm()`/`rhythmStep()` |
| `tests/rhythm-hit-fx.test.mjs` | Data-model backfill, `randomHitFx`'s shape, `buildHitFx`'s node graph and disposal list, `applyHitFx`'s parameter mapping, UI wiring |

---

### Task 1: Data model, defaults, backfill, and the panel controls

**Files:**
- Modify: `index.html` (`defaultRhythm()` at `index.html:6999`, `rhythmOf()` at
  `index.html:7042`, the per-voice row builder and "Generate a pattern" button inside
  `renderRhythmPanel()` around `index.html:4780`–`4848`)
- Test: `tests/rhythm-hit-fx.test.mjs`

**Interfaces:**
- Produces: five new fields per voice in `defaultRhythm()`'s `voices` object — `crush: 0`,
  `drive: 0`, `delayDiv: "8n"`, `delayFb: 0`, `delayWet: 0`. `rhythmOf()` backfills all five,
  field-by-field, for a point saved before this plan. `randomHitFx(r)` — rolls new values for
  all four voices across these five fields, deliberately weighted toward modest values (per
  the spec: "a click lands somewhere usable rather than somewhere extreme most of the time").
  A "Randomize effects" button beside "Generate a pattern."

This task adds no audio node and no scheduling change — it is data and UI only, exactly the
same shape Part 1's Task 1 (`idiom`) took: the sliders exist and persist values after this
task; Task 2 makes them audible.

- [ ] **Step 1: Write the failing test**

```js
// tests/rhythm-hit-fx.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8");

function slice(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  assert.ok(start !== -1, `start marker not found: ${startMarker}`);
  const end = html.indexOf(endMarker, start + startMarker.length);
  assert.ok(end !== -1, `end marker not found: ${endMarker}`);
  assert.ok(end > start, `"${endMarker}" occurs at or before "${startMarker}"`);
  return html.slice(start, end);
}

test("defaultRhythm's voices carry the five new fields, all at their off position", () => {
  const def = slice("function defaultRhythm()", "function ");
  ["crush: 0", "drive: 0", 'delayDiv: "8n"', "delayFb: 0", "delayWet: 0"].forEach((needle) => {
    assert.ok(def.includes(needle), `defaultRhythm() must include ${needle}`);
  });
});

test("rhythmOf backfills all five new voice fields without touching pulses/rotate/gain/pitch", () => {
  const of = slice("function rhythmOf(f)", "function buildRhythmFx(");
  ["crush", "drive", "delayDiv", "delayFb", "delayWet"].forEach((k) => {
    assert.match(of, new RegExp("v\\." + k + "\\s*===?\\s*undefined"),
      k + " must be backfilled by absence-check, not overwritten if already set");
  });
  /* The backfill block itself must never assign pulses/rotate/gain/pitch — only
     randomRhythm() (an explicit setter action) may do that. */
  const backfillStart = of.indexOf('if (v.crush === undefined)');
  assert.ok(backfillStart !== -1, "the per-field backfill block must exist");
  const nextFieldOrEnd = of.slice(backfillStart).search(/\n\s*if\s*\(!r\.grains\)|\n\s*return r;/);
  const scoped = of.slice(backfillStart, backfillStart + (nextFieldOrEnd === -1 ? of.length : nextFieldOrEnd));
  assert.doesNotMatch(scoped, /\.pulses\s*=|\.rotate\s*=|\.gain\s*=|\.pitch\s*=/,
    "backfilling the new FX fields must not rewrite an existing voice's pattern or level");
});

test("randomHitFx rolls all five fields for all four voices, within valid ranges", () => {
  const src = slice("function randomHitFx(r)", "\n  }\n");
  const factory = new Function("HIT_SLOTS", "DIVISIONS",
    src.slice(src.indexOf("{") + 1, src.lastIndexOf("}")) + "\nreturn randomHitFx;");
  const randomHitFx = factory(["low", "mid", "high", "rand"], ["4n", "4n.", "8n", "8n.", "16n", "2n", "1n"]);
  for (let i = 0; i < 20; i++) {
    const r = { voices: { low: {}, mid: {}, high: {}, rand: {} } };
    randomHitFx(r);
    ["low", "mid", "high", "rand"].forEach((slot) => {
      const v = r.voices[slot];
      assert.ok(v.crush >= 0 && v.crush <= 1, "crush in range");
      assert.ok(v.drive >= 0 && v.drive <= 1, "drive in range");
      assert.ok(["4n", "4n.", "8n", "8n.", "16n", "2n", "1n"].includes(v.delayDiv), "delayDiv is a real division");
      assert.ok(v.delayFb >= 0 && v.delayFb <= 0.85, "delayFb in range");
      assert.ok(v.delayWet >= 0 && v.delayWet <= 1, "delayWet in range");
    });
  }
});

test("the rhythm panel has a Randomize effects action, separate from Generate a pattern", () => {
  const panel = slice("function renderRhythmPanel()", "function gcd(");
  assert.match(panel, /randomHitFx\(/);
  assert.match(panel, /"Randomize effects"/);
  assert.match(panel, /"Generate a pattern"/);
});

test("each voice row exposes crush, drive and a delay division/feedback/mix", () => {
  const panel = slice("function renderRhythmPanel()", "function gcd(");
  ["crush", "drive", "delayFb", "delayWet"].forEach((k) => {
    assert.ok(panel.includes('"' + k + '"'), "voice row must include a " + k + " control");
  });
  assert.match(panel, /DIV_LABEL/, "the delay division must show a real division label, not a bare code");
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test`
Expected: FAIL — none of the new fields, `randomHitFx`, or the new controls exist yet.

- [ ] **Step 3: Add the five fields to `defaultRhythm()`**

`index.html:6999`–`7015` currently:

```js
  function defaultRhythm() {
    return {
      on: true, steps: 64, div: "16n", gain: 0.85, swing: 0, idiom: 0.35, sentenceBars: 8,
      /* Sixty-four sixteenths is four bars, which is long enough for four lines to drift
         against each other instead of repeating every bar. The pulse counts are all
         different and three of the four are coprime with 64, so the pattern they make
         together only comes back around after a very long time: 8 divides 64 and gives the
         low its steady half-bar, while 13, 21 and 5 never line up with it twice the same
         way. */
      voices: {
        low:  { pulses:  8, rotate: 0,  gain: 1.00, pitch: 0 },
        mid:  { pulses: 13, rotate: 2,  gain: 0.80, pitch: 0 },
        high: { pulses: 21, rotate: 1,  gain: 0.65, pitch: 0 },
        rand: { pulses:  5, rotate: 11, gain: 0.55, pitch: 0 }
      }
    };
  }
```

Change the `voices` object to:

```js
      /* crush/drive/delay* all default to their off position — a point saved before this
         plan existed must sound identical to today until a setter (or Randomize effects)
         touches one. */
      voices: {
        low:  { pulses:  8, rotate: 0,  gain: 1.00, pitch: 0,
                crush: 0, drive: 0, delayDiv: "8n", delayFb: 0, delayWet: 0 },
        mid:  { pulses: 13, rotate: 2,  gain: 0.80, pitch: 0,
                crush: 0, drive: 0, delayDiv: "8n", delayFb: 0, delayWet: 0 },
        high: { pulses: 21, rotate: 1,  gain: 0.65, pitch: 0,
                crush: 0, drive: 0, delayDiv: "8n", delayFb: 0, delayWet: 0 },
        rand: { pulses:  5, rotate: 11, gain: 0.55, pitch: 0,
                crush: 0, drive: 0, delayDiv: "8n", delayFb: 0, delayWet: 0 }
      }
```

- [ ] **Step 4: Backfill the five fields in `rhythmOf()`**

`index.html:7042`–`7057` currently ends its voices section:

```js
    HIT_SLOTS.forEach(function (k) {
      if (!r.voices[k]) { r.voices[k] = defaultRhythm().voices[k]; }
    });
    if (!r.grains) { r.grains = defaultGrains(); }
```

Change to:

```js
    HIT_SLOTS.forEach(function (k) {
      if (!r.voices[k]) { r.voices[k] = defaultRhythm().voices[k]; }
    });
    var dv = defaultRhythm().voices;
    HIT_SLOTS.forEach(function (k) {
      var v = r.voices[k];
      if (v.crush === undefined) { v.crush = dv[k].crush; }
      if (v.drive === undefined) { v.drive = dv[k].drive; }
      if (v.delayDiv === undefined) { v.delayDiv = dv[k].delayDiv; }
      if (v.delayFb === undefined) { v.delayFb = dv[k].delayFb; }
      if (v.delayWet === undefined) { v.delayWet = dv[k].delayWet; }
    });
    if (!r.grains) { r.grains = defaultGrains(); }
```

- [ ] **Step 5: Add `randomHitFx`**

Add directly after `randomRhythm` (find `function randomRhythm(r) {` and its closing brace,
around `index.html:4908`–`4917`):

```js
  /* A separate roll from randomRhythm(): a setter who likes their pattern should be able to
     reroll only its effects, and vice versa. Weighted toward modest values on each field
     (roughly two-thirds of the time) with an occasional more extreme outlier, so a click
     usually lands somewhere musically usable rather than somewhere harsh. */
  function randomHitFx(r) {
    HIT_SLOTS.forEach(function (slot) {
      var cfg = r.voices[slot];
      cfg.crush = Math.random() < 0.65 ? Math.random() * 0.2 : 0.2 + Math.random() * 0.5;
      cfg.drive = Math.random() < 0.65 ? Math.random() * 0.25 : 0.25 + Math.random() * 0.45;
      cfg.delayDiv = DIVISIONS[Math.floor(Math.random() * DIVISIONS.length)];
      cfg.delayFb = Math.random() * 0.4;
      cfg.delayWet = Math.random() < 0.5 ? 0 : Math.random() * 0.35;
    });
  }
```

- [ ] **Step 6: Add the "Randomize effects" button**

`index.html:4780`–`4797` currently:

```js
    var mhead = document.createElement("div");
    mhead.className = "pphead";
    var h = document.createElement("h2");
    h.textContent = "The four hits";
    mhead.appendChild(h);
    var rnd = document.createElement("button");
    rnd.type = "button"; rnd.className = "ghost ppgen";
    rnd.textContent = "Generate a pattern";
    rnd.title = "Four Euclidean patterns that will not lock to each other";
    rnd.addEventListener("click", function () {
      randomRhythm(r);
      claimEdit(f);
      save();
      renderRhythmPanel();
      toast("New pattern");
    });
    mhead.appendChild(rnd);
    body.appendChild(mhead);
```

Change to add a sibling button (the live-audio `applyHitFx` call is added in Task 2; this task
just wires the data-and-panel half):

```js
    var mhead = document.createElement("div");
    mhead.className = "pphead";
    var h = document.createElement("h2");
    h.textContent = "The four hits";
    mhead.appendChild(h);
    var rnd = document.createElement("button");
    rnd.type = "button"; rnd.className = "ghost ppgen";
    rnd.textContent = "Generate a pattern";
    rnd.title = "Four Euclidean patterns that will not lock to each other";
    rnd.addEventListener("click", function () {
      randomRhythm(r);
      claimEdit(f);
      save();
      renderRhythmPanel();
      toast("New pattern");
    });
    mhead.appendChild(rnd);
    var rndFx = document.createElement("button");
    rndFx.type = "button"; rndFx.className = "ghost ppgen";
    rndFx.textContent = "Randomize effects";
    rndFx.title = "New crush, drive and delay for all four voices";
    rndFx.addEventListener("click", function () {
      randomHitFx(r);
      claimEdit(f);
      save();
      renderRhythmPanel();
      toast("New effects");
    });
    mhead.appendChild(rndFx);
    body.appendChild(mhead);
```

- [ ] **Step 7: Add the per-voice sliders and the delay-division select**

`index.html:4820`–`4841`, the per-voice `[["pulses",...], ["rotate",...], ["gain",...]]`
forEach currently ends the voice row at:

```js
      var pat = document.createElement("div");
      pat.className = "rpat";
      pat.dataset.slot = slot;
      row.appendChild(pat);
      body.appendChild(row);
      drawPattern(slot, r);
    });
```

Insert the new controls between the existing forEach and the pattern strip:

```js
      [["crush", 0, 1, 0.02], ["drive", 0, 1, 0.02],
       ["delayFb", 0, 0.85, 0.02], ["delayWet", 0, 1, 0.02]].forEach(function (spec) {
        var wrap = document.createElement("label");
        wrap.className = "pprow";
        var lab = document.createElement("span");
        lab.textContent = spec[0];
        var inp = document.createElement("input");
        inp.type = "range"; inp.min = spec[1]; inp.max = spec[2]; inp.step = spec[3];
        inp.value = cfg[spec[0]];
        inp.dataset.def = defaultRhythm().voices[slot][spec[0]];
        inp.title = "Shift-drag for fine steps · double-click to reset";
        var out = document.createElement("i");
        var show = function () { out.textContent = (+inp.value).toFixed(2); };
        show();
        inp.addEventListener("input", function () {
          cfg[spec[0]] = +inp.value; show(); commitR();
        });
        wrap.appendChild(lab); wrap.appendChild(inp); wrap.appendChild(out);
        row.appendChild(wrap);
      });
      /* A musical division, not a free number — same idiom as RHYTHM_FIELDS' own "div" row
         and the shared room's own delay-division control. */
      var delWrap = document.createElement("label");
      delWrap.className = "pprow";
      var delLab = document.createElement("span");
      delLab.textContent = "delay time";
      var delSel = document.createElement("select");
      DIVISIONS.forEach(function (d) {
        var op = document.createElement("option");
        op.value = d; op.textContent = DIV_LABEL[d] || d;
        delSel.appendChild(op);
      });
      delSel.value = cfg.delayDiv;
      delSel.addEventListener("change", function () {
        cfg.delayDiv = delSel.value; commitR();
      });
      delWrap.appendChild(delLab); delWrap.appendChild(delSel);
      row.appendChild(delWrap);
      var pat = document.createElement("div");
      pat.className = "rpat";
      pat.dataset.slot = slot;
      row.appendChild(pat);
      body.appendChild(row);
      drawPattern(slot, r);
    });
```

(The `applyHitFx(...)` call these new handlers need for live audio feedback while dragging is
added in Task 2, once `applyHitFx` exists — do not add a call to a function that does not
exist yet in this task.)

- [ ] **Step 8: Run the tests**

Run: `npm test && npm run check`
Expected: all pass.

- [ ] **Step 9: Verify in a browser**

Serve locally, sign in as a setter, select a hits-mode point, open its rhythm panel. Confirm
each voice row now shows crush/drive/delay-feedback/delay-mix sliders and a delay-time
dropdown, all starting at their off position for an existing point. Click "Randomize effects":
confirm the panel updates and the values land within sensible ranges (not everything pinned at
the extreme every time). Confirm "Generate a pattern" still only changes pulses/rotation, never
the new effects fields, and vice versa.

- [ ] **Step 10: Commit**

```bash
git add index.html tests/rhythm-hit-fx.test.mjs
git commit -m "Each hit voice gets its own crush, drive and delay controls, all off by default"
```

---

### Task 2: Wire the per-slot chain into the audio graph

**Files:**
- Modify: `index.html` (`ensureRhythm()`/`disposeRhythm()` at `index.html:7144`, `rhythmStep()`
  at `index.html:7350`, the new sliders' input handlers from Task 1 Step 7)
- Test: `tests/rhythm-hit-fx.test.mjs` (appended)

**Interfaces:**
- Consumes: `makeBlend(Tone, fade)` (existing), `MAX_DELAY_S`, `divSeconds(div, bpm)`
  (existing), `pacer` (existing, for the current tempo).
- Produces: `buildHitFx(Tone)` — one slot's insert chain (`input` → bitcrush → distortion →
  delay → `output`), returning every node it creates so `disposeRhythm` can clean them up.
  `applyHitFx(R, r)` — ramps every slot's chain to match `r.voices[slot]`'s current
  crush/drive/delay values; safe to call with no live `R` (a setter editing a point currently
  out of range).

- [ ] **Step 1: Write the failing test**

```js
// tests/rhythm-hit-fx.test.mjs — appended

test("buildHitFx wires input through bitcrush, distortion and delay inserts to output, each blended via makeBlend", () => {
  const src = slice("function buildHitFx(Tone)", "\n  }\n");
  assert.match(src, /new Tone\.BitCrusher\(/, "bitcrush insert");
  assert.match(src, /new Tone\.WaveShaper\(/, "distortion insert, matching the shared room's own shape");
  assert.match(src, /new Tone\.FeedbackDelay\(/, "an independent per-slot delay");
  const blendCalls = src.match(/makeBlend\(Tone,\s*0\)/g) || [];
  assert.equal(blendCalls.length, 3, "each of the three inserts gets its own dry/wet blend");
  assert.doesNotMatch(src, /Tone\.CrossFade/, "A-17: makeBlend, never Tone.CrossFade");
});

test("buildHitFx returns every node it creates, so disposeRhythm can clean all of them up", () => {
  const src = slice("function buildHitFx(Tone)", "\n  }\n");
  const returnLine = src.slice(src.lastIndexOf("return"));
  ["input", "crush", "crushBlend", "shape", "drivePre", "drivePost", "driveBlend",
   "delay", "delayBlend", "output"].forEach((key) => {
    assert.match(returnLine, new RegExp("\\b" + key + "\\b"), "buildHitFx must return " + key);
  });
});

test("disposeRhythm disposes every per-slot fx node, not just the player", () => {
  const src = slice("function disposeRhythm(id)", "\n  }\n");
  assert.match(src, /R\.fx/, "disposeRhythm must reach into the per-slot fx chains");
});

test("applyHitFx maps crush to both the wet blend and the BitCrusher's own bit depth", () => {
  const src = slice("function applyHitFx(R, r)", "\n  }\n");
  assert.match(src, /crushBlend\.fade\.rampTo\(/);
  assert.match(src, /\.crush\.bits\s*=/);
  assert.match(src, /driveBlend\.fade\.rampTo\(/);
  assert.match(src, /delayBlend\.fade\.rampTo\(/);
  assert.match(src, /delay\.delayTime\.rampTo\(/);
  assert.match(src, /delay\.feedback\.rampTo\(/);
});

test("applyHitFx is safe to call with no live R", () => {
  const src = slice("function applyHitFx(R, r)", "\n  }\n");
  assert.match(src, /if\s*\(!R \|\| !R\.fx\)\s*\{\s*return;\s*\}/,
    "a setter editing a point currently out of range must not throw");
});

test("ensureRhythm connects each player through its slot's fx chain, not straight to R.gain", () => {
  const src = slice("function ensureRhythm(z)", "function disposeRhythm(");
  assert.match(src, /R\.fx\s*=\s*\{\}/);
  assert.match(src, /buildHitFx\(Tone\)/);
  assert.match(src, /\.connect\(R\.fx\[slot\]\.input\)/,
    "each player must feed its own slot's chain, not R.gain directly");
});

test("rhythmStep applies each point's fx once it is ready, without adding new scheduling", () => {
  const step = slice("function rhythmStep(time)", "function updateBed");
  assert.match(step, /applyHitFx\(/);
  assert.doesNotMatch(step, /scheduleRepeat|\.clear\(/,
    "this plan must never add a new Transport scheduling call");
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test`
Expected: FAIL — `buildHitFx`/`applyHitFx` don't exist; `ensureRhythm` still connects players
straight to `R.gain`.

- [ ] **Step 3: Write `buildHitFx`**

Add directly after `buildRhythmFx`/`applyRhythmFx` (find `function applyRhythmFx(patch)` and
its closing brace, around `index.html:7126`–`7139`):

```js
  /* One slot's own insert chain: bitcrush, then a distortion stage using the same tanh
     shape the shared room's own drive already uses (character consistency between "the
     room" and "this voice's own colour"), then an independent short delay — a voice's own
     slap-back, not a second trip through the shared room's delay. Built once per slot, kept
     for the life of the point being in range, same lifecycle R.players/R.gain already have. */
  function buildHitFx(Tone) {
    var input = new Tone.Gain(1);

    var crush = new Tone.BitCrusher(16);
    var crushBlend = makeBlend(Tone, 0);
    input.connect(crushBlend.a);
    input.connect(crush); crush.connect(crushBlend.b);

    var shape = new Tone.WaveShaper(function (x) { return Math.tanh(x * 3); }, 2048);
    var drivePre = new Tone.Gain(1);
    var drivePost = new Tone.Gain(0.6);
    var driveBlend = makeBlend(Tone, 0);
    crushBlend.connect(driveBlend.a);
    crushBlend.connect(drivePre); drivePre.connect(shape); shape.connect(drivePost);
    drivePost.connect(driveBlend.b);

    var delay = new Tone.FeedbackDelay({ maxDelay: MAX_DELAY_S, delayTime: 0.2, feedback: 0, wet: 1 });
    var delayBlend = makeBlend(Tone, 0);
    driveBlend.connect(delayBlend.a);
    driveBlend.connect(delay); delay.connect(delayBlend.b);

    return { input: input, crush: crush, crushBlend: crushBlend, shape: shape,
             drivePre: drivePre, drivePost: drivePost, driveBlend: driveBlend,
             delay: delay, delayBlend: delayBlend, output: delayBlend };
  }

  /* Applied once when a point's fx chain is first ready, and again whenever a setter moves
     one of this slot's sliders — the same "there is one chain, apply on change" shape
     applyRhythmFx already uses for the shared room. Safe with no live R: a setter can edit
     a point's effects while it happens to be out of range. */
  function applyHitFx(R, r) {
    if (!R || !R.fx) { return; }
    HIT_SLOTS.forEach(function (slot) {
      var cfg = r.voices[slot], fx = R.fx[slot];
      if (!cfg || !fx) { return; }
      var crushAmt = cfg.crush || 0;
      fx.crushBlend.fade.rampTo(crushAmt, 0.2);
      fx.crush.bits = Math.max(2, Math.round(16 - crushAmt * 14));
      var driveAmt = cfg.drive || 0;
      fx.driveBlend.fade.rampTo(driveAmt, 0.2);
      fx.drivePre.gain.rampTo(1 + driveAmt * 12, 0.2);
      fx.drivePost.gain.rampTo(0.6 / (1 + driveAmt * 3.4), 0.2);
      fx.delay.delayTime.rampTo(Math.min(MAX_DELAY_S - 0.01,
        divSeconds(cfg.delayDiv || "8n", pacer ? pacer.patch.tempo : 72)), 0.2);
      fx.delay.feedback.rampTo(cfg.delayFb || 0, 0.2);
      fx.delayBlend.fade.rampTo(cfg.delayWet || 0, 0.2);
    });
  }
```

- [ ] **Step 4: Wire `ensureRhythm` to build the chain and route players through it**

`index.html:7144`–`7176` currently:

```js
  function ensureRhythm(z) {
    var R = bed.rhythms[z.id];
    if (R) { return R; }
    var Tone = bed.Tone;
    R = bed.rhythms[z.id] = { ready: 0, players: {}, urls: {}, tick: 0, step: 0, recent: [],
                              gain: new Tone.Gain(0).connect(bed.rfx ? bed.rfx.input
                                                                     : bed.master) };
    /* A grains point loads its one recording as a buffer rather than a player: a player
       plays a file, and what this needs is to read arbitrary slices of it at arbitrary
       times, many at once. */
    if (z.mode === "grains") {
      audioBlob(z.id, remotePath(z.id)).then(function (blob) {
        if (!blob || !bed || !bed.rhythms[z.id]) { return; }
        var url = URL.createObjectURL(blob);
        R.grainUrl = url;
        R.buffer = new Tone.ToneAudioBuffer(url, function () { R.ready++; },
          function () { /* a file that will not decode simply never plays */ });
      }).catch(function () { /* nothing attached yet */ });
      return R;
    }
    HIT_SLOTS.forEach(function (slot) {
      audioBlob(z.id + "#" + slot, remoteHitPath(z.id, slot)).then(function (blob) {
        if (!blob || !bed || !bed.rhythms[z.id]) { return; }
        var url = URL.createObjectURL(blob);
        R.urls[slot] = url;
        R.players[slot] = new Tone.Player({
          url: url, fadeOut: 0.02,
          onload: function () { R.ready++; }
        }).connect(R.gain);
      }).catch(function () { /* a slot that will not load simply never fires */ });
    });
    return R;
  }
```

Change to build `R.fx` for hits-mode points only (grains has no slots), and route each
player through its own slot's chain instead of straight to `R.gain`:

```js
  function ensureRhythm(z) {
    var R = bed.rhythms[z.id];
    if (R) { return R; }
    var Tone = bed.Tone;
    R = bed.rhythms[z.id] = { ready: 0, players: {}, urls: {}, tick: 0, step: 0, recent: [],
                              gain: new Tone.Gain(0).connect(bed.rfx ? bed.rfx.input
                                                                     : bed.master) };
    /* A grains point loads its one recording as a buffer rather than a player: a player
       plays a file, and what this needs is to read arbitrary slices of it at arbitrary
       times, many at once. */
    if (z.mode === "grains") {
      audioBlob(z.id, remotePath(z.id)).then(function (blob) {
        if (!blob || !bed || !bed.rhythms[z.id]) { return; }
        var url = URL.createObjectURL(blob);
        R.grainUrl = url;
        R.buffer = new Tone.ToneAudioBuffer(url, function () { R.ready++; },
          function () { /* a file that will not decode simply never plays */ });
      }).catch(function () { /* nothing attached yet */ });
      return R;
    }
    /* One insert chain per slot, built synchronously so it exists (fully dry, per A-8)
       before any player has even started loading — the async audioBlob() calls below only
       need to connect into it, not build it. */
    R.fx = {};
    HIT_SLOTS.forEach(function (slot) {
      R.fx[slot] = buildHitFx(Tone);
      R.fx[slot].output.connect(R.gain);
    });
    HIT_SLOTS.forEach(function (slot) {
      audioBlob(z.id + "#" + slot, remoteHitPath(z.id, slot)).then(function (blob) {
        if (!blob || !bed || !bed.rhythms[z.id]) { return; }
        var url = URL.createObjectURL(blob);
        R.urls[slot] = url;
        R.players[slot] = new Tone.Player({
          url: url, fadeOut: 0.02,
          onload: function () { R.ready++; }
        }).connect(R.fx[slot].input);
      }).catch(function () { /* a slot that will not load simply never fires */ });
    });
    return R;
  }
```

- [ ] **Step 5: Dispose the per-slot chain in `disposeRhythm`**

`index.html:7178` area, inside the `HIT_SLOTS.forEach` that already disposes each player:

```js
      HIT_SLOTS.forEach(function (slot) {
        try { if (R.players[slot]) { R.players[slot].dispose(); } } catch (e) {}
        if (R.urls[slot]) { URL.revokeObjectURL(R.urls[slot]); }
      });
```

Change to:

```js
      HIT_SLOTS.forEach(function (slot) {
        try { if (R.players[slot]) { R.players[slot].dispose(); } } catch (e) {}
        if (R.urls[slot]) { URL.revokeObjectURL(R.urls[slot]); }
        var fx = R.fx && R.fx[slot];
        if (fx) {
          [fx.input, fx.crush, fx.crushBlend, fx.shape, fx.drivePre, fx.drivePost,
           fx.driveBlend, fx.delay, fx.delayBlend].forEach(function (n) {
            try { n.dispose(); } catch (e) {}
          });
        }
      });
```

- [ ] **Step 6: Apply the chain once it's ready, from `rhythmStep`**

`index.html:7350` area, right after the existing `R.liveVoices` lazy-seed block and before the
`HIT_SLOTS` playback loop:

```js
      if (!R.liveVoices) {
        R.liveVoices = {};
        HIT_SLOTS.forEach(function (slot) {
          R.liveVoices[slot] = { pulses: r.voices[slot].pulses, rotate: r.voices[slot].rotate };
        });
      }
```

Add directly after it:

```js
      if (!R.fxReady && R.fx) { applyHitFx(R, r); R.fxReady = true; }
```

- [ ] **Step 7: Give the new sliders live-audio feedback**

Task 1 Step 7 added input handlers for `crush`/`drive`/`delayFb`/`delayWet` and a `change`
handler for the delay-division select, each currently ending in `commitR();`. Add a live
`applyHitFx` call to all five, so dragging a slider is heard immediately on a point currently
in range (and is a safe no-op otherwise):

The four range-input handlers:
```js
        inp.addEventListener("input", function () {
          cfg[spec[0]] = +inp.value; show(); commitR();
          applyHitFx(bed && bed.rhythms[f.properties.id], r);
        });
```

The delay-division select's handler:
```js
      delSel.addEventListener("change", function () {
        cfg.delayDiv = delSel.value; commitR();
        applyHitFx(bed && bed.rhythms[f.properties.id], r);
      });
```

Also add the same call to the "Randomize effects" button from Task 1 Step 6, right after
`renderRhythmPanel();`:

```js
    rndFx.addEventListener("click", function () {
      randomHitFx(r);
      claimEdit(f);
      save();
      renderRhythmPanel();
      applyHitFx(bed && bed.rhythms[f.properties.id], r);
      toast("New effects");
    });
```

- [ ] **Step 8: Run the tests**

Run: `npm test && npm run check`
Expected: all pass, including every pre-existing test — `putAudio`/`getAudio`/`delAudio` and
the setter capture path this file's `tests/offline.test.mjs` already guards are untouched by
this task.

- [ ] **Step 9: Verify in a browser**

Serve locally, sign in as a setter, walk a route with a hits-mode point that has real attached
recordings. With every new slider at 0, confirm the point sounds exactly as it did before this
plan. Raise `crush` on one voice: confirm audible degradation, and confirm it's silent (fully
dry) back at 0. Raise `drive`: confirm distortion, dry at 0. Raise `delayFb`/`delayWet` on one
voice with `delayDiv` set short: confirm a fast, voice-specific echo distinct from the shared
room's own longer delay (audible both together and independently — e.g. mute the shared room's
delay wet in the Patch panel and confirm this voice's own echo still plays). Click "Randomize
effects" while the route is playing and confirm the change is audible within the 0.2s ramp
time, with no click or zipper artifact at the transition (A-2).

- [ ] **Step 10: Commit**

```bash
git add index.html tests/rhythm-hit-fx.test.mjs
git commit -m "Each hit voice's crush, drive and delay are now actually wired into the signal path"
```

---

### Task 3: Verification

**Files:** none created — this task runs the suite and the manual checks Tasks 1–2 already
established the pattern for.

- [ ] **Step 1: Run the full suite**

Run: `npm test && npm run check`
Expected: every test in `tests/rhythm-hit-fx.test.mjs` and every pre-existing test passes.

- [ ] **Step 2: Confirm the dry path bit-for-bit, per A-8**

Per this project's [[verify-by-measuring]] rule: with every new field at its default (0 /
`"8n"` / 0 / 0), record the output of a hit through its slot's chain, then bypass all three
inserts (disconnect `crush`/`shape`/`delay` and connect `input` straight to `output`) and
record again. Confirm the two are audibly and, if you can capture a waveform, sample-for-sample
identical — the `crushBlend`/`driveBlend`/`delayBlend` fades sitting at 0 must mean the wet
branch contributes nothing, not merely very little.

- [ ] **Step 3: Confirm the shared room is untouched**

Diff `buildRhythmFx`/`applyRhythmFx`/the route Patch panel's `rfx.*` controls against `main`
before this plan — none of this plan's commits should touch them. Walk a route with the shared
room's delay/reverb turned up and a hit voice's own delay also turned up; confirm both are
audible simultaneously and independently adjustable.

- [ ] **Step 4: Confirm nothing regressed for grains mode or the setter capture path**

Select a grains-mode point and confirm it has no crush/drive/delay controls (this plan is
hits-only) and sounds unchanged. Confirm Mark, attach-audio and Export/Import still work
exactly as before — this plan never touches the offline capture path.

- [ ] **Step 5: Commit**

Only if Steps 2–4 turned up a fix; otherwise this task ends at Step 1's passing run with
nothing to commit.
