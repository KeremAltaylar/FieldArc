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
  assert.match(src, /bed\.Tone\.context\.state !== "running"/);
  assert.match(src, /bed\.Tone\.start\(\)/);
});

test("bedStart requests the wake lock once it actually starts building the graph", () => {
  const src = slice("function bedStart()", "\n  }\n");
  assert.match(src, /if \(!wantSound\) \{ bed\.on = false; return; \}\s*\n\s*keepAwake\(true\)/,
    "must request after the early-return, not before — a cancelled start must not hold the lock");
});

test("bedStop releases the wake lock through the shared shouldn't-outlive-other-reasons check", () => {
  const src = slice("function bedStop()", "\n  }\n");
  assert.match(src, /bed\.on = false;\s*\n\s*releaseAwakeIfUnneeded\(\)/);
});

test("stopTrack and gpsSet(false) both route through releaseAwakeIfUnneeded rather than a bare keepAwake(false)", () => {
  const stop = slice("function stopTrack()", "\n  }\n");
  assert.match(stop, /releaseAwakeIfUnneeded\(\)/);
  assert.doesNotMatch(stop, /keepAwake\(false\)/);

  const gps = slice("function gpsSet(on)", "\n  }\n");
  assert.match(gps, /else \{ releaseAwakeIfUnneeded\(\); \}/);
});
