// tests/stretch-diagnostics.test.mjs — what the stretch engine reports about itself.
/* Kerem, 2026-09-22, on iOS Safari and iOS Chrome: the stretch points "are not stretched as on
   the browser... like repeating a 2 note pattern", while the same recordings are right in
   desktop Chrome. The engine runs on the audio thread and nothing outside it can see which of
   the two faults that sound belongs to — a starved engine (hops finishing late) or a short
   source (a few seconds of recording going round and round). So it reports both now, and the
   two places that can be read on a phone with no cable show it: diag.html section 6 for a
   synthetic source, ?pxdebug in the app for the real recordings. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8").replace(/\r\n/g, "\n");
const diag = readFileSync("diag.html", "utf8").replace(/\r\n/g, "\n");
const worklet = readFileSync("src/paulx-worklet.js", "utf8").replace(/\r\n/g, "\n");

function fn(src, name) {
  const s = src.indexOf("function " + name + "(");
  assert.ok(s !== -1, "missing " + name);
  let i = src.indexOf("{", src.indexOf(")", s)), d = 0;
  for (; i < src.length; i++) { if (src[i] === "{") d++; else if (src[i] === "}") { d--; if (!d) break; } }
  return src.slice(s, i + 1);
}

test("the engine counts hops, late hops and the render quantum it is given", () => {
  assert.match(worklet, /this\.hops = 0; this\.late = 0; this\.quantum = 0;/);
  /* A hop is late when swap() finds the job still running and has to drain it — the engine's
     own comment calls that "a late frame, never a gap". Counted where the draining happens. */
  assert.match(worklet, /if \(s\.job\) \{ this\.late\+\+; \}/);
  assert.match(worklet, /this\.hops\+\+;/);
  /* The quantum is read from the actual callback, not assumed: the budgeting maths divides by
     it, so a platform handing this processor something other than 128 is worth seeing. */
  assert.match(worklet, /this\.quantum = n;/);
});

test("all four travel on the position message the engine already sends", () => {
  /* Not a new message and not a new schedule: the same throttled post, which fires once per
     2048 samples, carries them. An extra message per hop would be a cost on the audio thread. */
  const proc = worklet.slice(worklet.indexOf("process(inputs, outputs)"));
  const post = proc.slice(proc.indexOf('type: "pos"'));
  ["hops:", "late:", "quantum:", "sr: sampleRate"].forEach((k) => {
    assert.ok(post.indexOf(k) !== -1 && post.indexOf(k) < post.indexOf("}"), "missing " + k);
  });
});

test("the app keeps the engine's report on the voice and paints it only under ?pxdebug", () => {
  assert.match(html, /v\.stretch\.hops = e\.data\.hops;/);
  assert.match(html, /v\.stretch\.late = e\.data\.late;/);
  assert.match(html, /if \(PXDEBUG\) \{ pxDebugPaint\(\); \}/,
    "a normal walk paints nothing — the flag is what makes it visible");
  const paint = fn(html, "pxDebugPaint");
  assert.match(paint, /st\.sourceLength \/ st\.sr/,
    "seconds of recording received is the number that separates a short source from a slow engine");
  assert.match(paint, /st\.late \/ st\.hops/);
});

test("?pxdebug survives the URL rewrite", () => {
  /* Selecting a route pushes urlForSelection(), a bare path, so a flag read later from
     location.search is already gone — the trap that made ?nostream silently inert when it was
     first shipped. Captured at load and kept for the tab. */
  assert.match(html, /var PXDEBUG = location\.search\.indexOf\("pxdebug"\) !== -1;/);
  assert.match(html, /sessionStorage\.setItem\("fieldarc\.pxdebug", "1"\)/);
  const at = html.indexOf("var PXDEBUG");
  assert.ok(at !== -1 && at < html.indexOf("history.pushState(null"),
    "captured before anything can rewrite the URL");
});

test("diag.html judges the engine by its OUTPUT, not by the read head", () => {
  /* The read head is the wrong instrument and this test is the scar: at x32 the engine pulls
     new source material only every stretch*bufsize/sr seconds — 11 s at the probe's settings —
     so an early version of this probe called a HEALTHY desktop engine "STUCK". Measured in Node
     against the real engine: rd.pos sat at 49152 for eight consecutive hops, correctly. What
     separates a stretch from a repeating loop is whether each hop resembles the one before. */
  assert.match(diag, /var lag = 16384;/, "one hop at the probe's bufsize");
  assert.match(diag, /num \/ Math\.sqrt\(da \* db\)/, "normalised hop-to-hop correlation");
  assert.match(diag, /repeat > 0\.85/, "and a threshold on it");
  assert.match(diag, /0 is NORMAL/,
    "the read-head line must say so, or the next person reads it the way I first did");
  /* Calibration, measured in desktop Chrome on 2026-09-22 with the real worklet: 0.01. */
  assert.ok(diag.indexOf("REPEATING") !== -1 && diag.indexOf("STARVED") !== -1);
});

test("the probe asks for the same audio buffer the walk asks for", () => {
  /* latencyHint 0.05 is tuneToneContext()'s number in index.html. A probe that asked for a
     different buffer would be measuring a different audio thread than the one that misbehaves. */
  assert.match(diag, /latencyHint: 0\.05/);
  assert.match(html, /Tone\.setContext\(new Tone\.Context\(\{ latencyHint: 0\.05 \}\)\)/);
});

test("the ?pxdebug overlay also reports the walk, and keeps reporting it with no voice playing", () => {
  /* The second fault Kerem reported the same day: crossing from one park to another leaves the
     new route silent. That question is answered by which route the walk believes it is on, how
     far off its line the walker is, what the synth stage is actually at, and whether a handover
     is still pending — and by none of them if the overlay only repaints when a recording plays,
     since the whole symptom is nothing playing. */
  const paint = fn(html, "pxDebugPaint");
  assert.match(paint, /pacer\.world \? "world" : "park"/);
  assert.match(paint, /pacer\.routeId/);
  assert.match(paint, /pacer\.routeDist/);
  assert.match(paint, /bed\.synthLevel/);
  assert.match(paint, /pendingSwapId/);
  assert.match(html, /if \(PXDEBUG\) \{\n\s+setInterval\(function \(\) \{ try \{ pxDebugPaint\(\); \}/,
    "repainted on a timer, not only from a stretch voice's position message");
});

test("the overlay names the parameters and where the row came from", () => {
  /* The engine can be perfectly healthy and still play something other than what the setter
     hears: a listener plays the PUBLISHED row, a setter their own local draft, so a point
     re-tuned after publishing sounds different on a phone with every engine number green.
     Kerem's 2026-09-22 screenshot had exactly that shape — src whole, 0% late, read head
     advancing — so the next thing to print is what it is being asked to do. */
  const paint = fn(html, "pxDebugPaint");
  assert.match(paint, /Math\.pow\(1024, Math\.max\(0, Math\.min\(1, q\.stretch \|\| 0\)\)\)/,
    "the same mapping pxParams uses, so the printed x is the engine's real stretch");
  assert.match(paint, /pxBufsize\(q\.px && q\.px\.fft\)/);
  assert.match(paint, /_remote \? "published" : "local draft"/);
});

/* ---- Decoding a published recording, 2026-09-22 ----
   Kerem: micro-glitches on the Koşuyolu points, stretch soloed, while Validebağ stays clean on
   the same phone in the same walk — and his phone reports 0% late hops, so the engine is
   delivering on time. The archive splits the same way the sound does: Koşuyolu was re-encoded
   to Opus in WebM at publish (115 MB WAV -> 13 MB, src/shrink.mjs), Validebağ is an mp3 that
   fitted the 50 MB limit untouched. Both files were fetched and sniffed here to be sure of
   that. Whether Safari's decoder handles Opus-in-WebM can only be answered on the phone. */

test("the decode check measures the two faults a bad decode leaves behind", () => {
  assert.match(diag, /function decMeasure\(buf\)/);
  assert.match(diag, /sr \* 0\.005/, "5 ms of EXACT digital silence — a dropped packet's filler");
  assert.match(diag, /shortBy = f\.expect - buf\.duration/, "and a decode that comes back short");
});

test("the verdict ignores fast jumps, which are musical as often as not", () => {
  /* Calibrated on desktop Chrome, which decodes both files perfectly: the Opus one showed
     nothing, and the MP3 of bird calls showed 29 jumps over half scale — its transients. A
     metric that fails on those would have called a healthy decode broken. */
  assert.match(diag, /if \(Math\.abs\(shortBy\) > 1 \|\| m\.runs\) \{ bad = true; \}/);
  assert.ok(!/m\.runs \|\| m\.jumps\) \{ bad = true/.test(diag));
});

test("it decodes the real published files, through the app's own bucket and key", () => {
  /* Not a synthetic stand-in: the fault is suspected in the publish-time re-encode, so the test
     has to read what listeners actually download. */
  assert.match(diag, /6c20e5a2-a9dc-462f-9ae9-cd93e6d2c2fe\/take\.webm/);
  assert.match(diag, /d4ada7ce-c52a-42bc-be92-1f325e4180cd\/take\.webm/);
  assert.match(diag, /storage\/v1\/object\/recordings\//);
  assert.match(diag, /decodeAudioData/);
});
