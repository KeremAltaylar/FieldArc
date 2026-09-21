// tests/audio-memory.test.mjs — what a voice holds, and what an unreachable archive says.
/* Kerem, 2026-09-21, walking Koşuyolu on his phone as a listener: "the sound ... was clipping and
   lagging", and after a refresh "routes and points were gone although I didn't publish anything".
   Measured causes, not guesses:
   - each soundscape voice decoded the same recording TWICE — once for the stretch worklet and once
     for a dry fallback player that only ever sounds if the worklet fails. 146 MB per copy for his
     6m40s stereo recording, so ~292 MB per point; two points in range put the tab near 300 MB and a
     phone stalls its audio thread long before that. Heap measured 185-200 MB before, 28-39 MB after.
   - nothing was lost: a listener holds nothing locally, so a failed read left an empty map under the
     words "Nothing published here yet", which is a different sentence from the truth. */
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

const ensureVoice = src("ensureVoice");

test("a voice decodes its recording once: no dry player unless the engine fails", () => {
  const players = ensureVoice.match(/new Tone\.Player\(/g) || [];
  assert.equal(players.length, 1, "exactly one construction site for the fallback player");
  const at = ensureVoice.indexOf("new Tone.Player(");
  const fallbackAt = ensureVoice.indexOf("var dryFallback = function ()");
  assert.ok(fallbackAt !== -1 && at > fallbackAt,
    "the only player construction lives inside dryFallback, not on the loading path");
});

test("the fallback is reached from both ways the engine can fail, and only those", () => {
  const calls = ensureVoice.match(/dryFallback\(\);/g) || [];
  assert.equal(calls.length, 2, "the rejected promise and the synchronous throw");
  for (const m of ensureVoice.matchAll(/dryFallback\(\);/g)) {
    const before = ensureVoice.slice(Math.max(0, m.index - 400), m.index);
    assert.match(before, /v\.stretch\.failed = true;/,
      "each call sits in a branch that has just marked the engine failed");
  }
});

/* The engine is what a soundscape point IS (always wet, 2026-09-18). Readiness used to hang off
   the dry player's onload, which is precisely why the player had to exist. */
test("the engine starting is what makes the voice ready", () => {
  assert.match(ensureVoice, /v\.stretch\.ready = true;\s*(\/\*[\s\S]*?\*\/\s*)?voiceReady\(\);/,
    "the worklet path marks the voice ready itself");
  assert.match(ensureVoice, /var voiceReady = function \(\)/);
  assert.match(ensureVoice, /v\.player\.start\(\);\s*voiceReady\(\);/,
    "and the fallback path still does, for a device where the engine cannot run");
});

test("the worklet is handed the decoded arrays, not copies of them", () => {
  assert.match(ensureVoice, /channels\.push\(audioBuffer\.getChannelData\(ci\)\);/,
    "a copy doubles the peak at the worst possible moment");
  assert.doesNotMatch(ensureVoice, /new Float32Array\(audioBuffer\.length\)/);
});

test("disposal tolerates a voice that never needed a player", () => {
  assert.match(src("bedStop"), /if \(v\.player\) \{ v\.player\.stop\(\); v\.player\.dispose\(\); \}/);
});

/* The subtle half, and the one my first attempt got wrong: supabase-js does not reject when the
   host is unroutable — it resolves with { error }. Measured against 127.0.0.1:9. */
test("an unreachable archive takes the same path whether it rejects or resolves with an error", () => {
  const fetchPublished = src("fetchPublished");
  assert.match(fetchPublished, /if \(r\.error \|\| !r\.data\) \{ return archiveUnreachable\(placeId\); \}/,
    "the resolved-with-error shape is a failure, not a silent no-op");
  assert.match(fetchPublished, /\.catch\(function \(\) \{ return archiveUnreachable\(placeId\); \}\)/,
    "and so is a genuine rejection");
});

test("a failed read falls back to what this device last saw, and says so", () => {
  const unreachable = src("archiveUnreachable");
  assert.match(unreachable, /archiveReached = false;/);
  assert.match(unreachable, /cachedPublished\(placeId\)/);
  assert.match(unreachable, /mergeRemote\(hit\.rows\)/);
  const copy = src("emptyCopy");
  assert.match(copy, /archiveReached/, "the copy answers which empty this is");
  assert.match(copy, /Nothing published here yet/);
  assert.match(copy, /Could not reach the archive/);
  assert.match(copy, /Nothing has been lost/,
    "the sentence a listener needs when their work appears to have vanished");
});

test("a successful read refreshes the cache and the flag", () => {
  const fetchPublished = src("fetchPublished");
  assert.match(fetchPublished, /archiveReached = true;/);
  assert.match(fetchPublished, /cachePublished\(placeId, r\.data\);/);
  assert.match(src("cachePublished"), /"pub:" \+ placeId/, "one key per place");
  assert.match(src("cachedPublished"), /"pub:" \+ placeId/);
});
