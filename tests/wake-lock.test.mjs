import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8").replace(/\r\n/g, "\n");

function slice(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  assert.ok(start !== -1, `start marker not found: ${startMarker}`);
  const end = html.indexOf(endMarker, start + startMarker.length);
  assert.ok(end !== -1, `end marker not found: ${endMarker}`);
  assert.ok(end > start, `"${endMarker}" occurs at or before "${startMarker}"`);
  return html.slice(start, end);
}

test("releaseAwakeIfUnneeded only releases when none of track/gps/bed still want the lock", () => {
  const src = slice("function releaseAwakeIfUnneeded()", "\n  }\n");
  assert.match(src, /!track/);
  assert.match(src, /!gps\.on/);
  assert.match(src, /!\(bed && bed\.on\)/);
  assert.match(src, /keepAwake\(false\)/);
});

test("visibilitychange re-acquires the wake lock for track, gps.on or an active bed, not just track", () => {
  const src = slice('document.addEventListener("visibilitychange"', "\n  });\n");
  assert.match(src, /track \|\| gps\.on \|\| \(bed && bed\.on\)/,
    "the old handler only re-armed for track — gps-follow and plain listening must count too");
});

test("visibilitychange resumes the AudioContext when it isn't running, not only the wake lock", () => {
  const src = slice('document.addEventListener("visibilitychange"', "\n  });\n");
  assert.match(src, /bed\.Tone\.getContext\(\)\.state !== "running"/);
  assert.match(src, /bed\.Tone\.start\(\)/);
});

test("bedStart schedules a periodic watchdog that resumes the context independent of visibilitychange", () => {
  /* visibilitychange only fires on a tab-hidden/tab-visible transition — a context can
     suspend or degrade for other reasons (OS audio-focus changes, a phone call, a
     Bluetooth switch, a power-saving heuristic) while the tab stays foregrounded and
     visible the whole time, which visibilitychange alone would never catch. */
  const src = slice("function bedStart()", "\n  }\n");
  assert.match(src, /bed\.resumeLoop = Tone\.Transport\.scheduleRepeat\(/);
  assert.match(src, /bed\.Tone\.getContext\(\)\.state !== "running"/);
  assert.match(src, /bed\.Tone\.start\(\)/);
  assert.match(src, /\},\s*5\)/,
    "must be a fixed number of real seconds, not a musical division — this has nothing " +
    "to do with tempo");
});

test("bedStart requests the wake lock once it actually starts building the graph", () => {
  const src = slice("function bedStart()", "\n  }\n");
  assert.match(src, /if \(!wantSound\) \{ bed\.on = false; return; \}\s*\n\s*keepAwake\(true\)/,
    "must request after the early-return, not before — a cancelled start must not hold the lock");
});

/* The release moved into bedTeardown on 2026-09-21, and that is the right side of the split:
   Stop now fades for 1.5s and the screen must stay awake until the walk is actually silent. */
test("the teardown releases the wake lock through the shared shouldn't-outlive-other-reasons check", () => {
  const src = slice("function bedTeardown()", "\n  }\n");
  assert.match(src, /bed\.on = false;\s*\n\s*releaseAwakeIfUnneeded\(\)/);
  assert.doesNotMatch(slice("function bedStop()", "\n  }\n"), /releaseAwakeIfUnneeded\(\)/,
    "releasing it the instant Stop is pressed could let the screen sleep mid-fade");
});

test("stopTrack and gpsSet(false) both route through releaseAwakeIfUnneeded rather than a bare keepAwake(false)", () => {
  const stop = slice("function stopTrack()", "\n  }\n");
  assert.match(stop, /releaseAwakeIfUnneeded\(\)/);
  assert.doesNotMatch(stop, /keepAwake\(false\)/);

  const gps = slice("function gpsSet(on)", "\n  }\n");
  assert.match(gps, /else \{ releaseAwakeIfUnneeded\(\); \}/);
});

test("keepAwake(true) refuses a second request while one is already held or in flight", () => {
  const src = slice("function keepAwake(on)", "\n  }\n");
  assert.match(src, /if \(wakeLock \|\| wakeLockPending\) \{ return; \}/,
    "two near-simultaneous callers (e.g. Sound and GPS-follow) must not each spawn their " +
    "own WakeLockSentinel — the second orphans the first, which is then never released");
  assert.match(src, /wakeLockPending = true/);
  assert.match(src, /wakeLockPending = false/);
});
