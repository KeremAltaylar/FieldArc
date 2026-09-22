// tests/viewport.test.mjs — the viewport list is the contract; the run itself needs Chrome.
/* The measurement lives in tools/viewports.mjs and needs a browser, so what is pinned here is
   the set of sizes: a regression that only shows at 360px is invisible if 360px is not in the
   list. These are the real CSS viewports of phones people actually walk with, plus the two
   breakpoint edges the app's own media queries turn on. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync("tools/viewports.mjs", "utf8");

test("the list covers the narrow end, the tall end and both breakpoint edges", () => {
  for (const w of [360, 390, 412, 430]) {
    assert.ok(src.includes(String(w)), "missing a real phone width: " + w);
  }
  assert.ok(src.includes("900"), "the max-width: 900px breakpoint edge");
  assert.ok(src.includes("620"), "the max-height: 620px breakpoint edge");
});

test("it measures overflow in both directions, not just vertical", () => {
  assert.match(src, /scrollHeight/, "V-2: vertical overflow is the documented check");
  assert.match(src, /scrollWidth/, "a sideways scroll on a phone is the worse failure");
});

/* Fix round 1 (2026-09-22): setDeviceMetricsOverride alone does not flip (pointer: coarse) on
   real Chrome — verified on hardware, not inferred. Without setTouchEmulationEnabled the tool
   silently measures the desktop-pointer layout at a phone width, which is a different and
   easier claim than the one it exists to check. Pinning both the call and the assertion so a
   future edit can't drop either without a test failing here. */
test("enables touch emulation and refuses to trust a viewport that didn't actually get it", () => {
  assert.match(src, /setTouchEmulationEnabled/, "the call that actually flips the pointer type");
  assert.match(src, /maxTouchPoints/, "a coarse pointer with zero touch points isn't a phone");
  assert.match(src, /pointer:\s*coarse/, "the exact media feature index.html's CSS gates on");
  assert.match(src, /pointerCoarse/, "the result must be checked, not just requested");
});

test("does not stand a fixed sleep in for the real load condition", () => {
  assert.ok(!/setTimeout\([^)]*6000\)/.test(src), "a blind 6s wait can report a half-built page as clean");
  assert.match(src, /readyState/, "document.readyState is part of what 'loaded' means here");
  assert.match(src, /maplibregl-canvas/, "the map has to actually be in the DOM, not just requested");
});

test("owns its Chrome process end to end and never cleans up by image name", () => {
  assert.match(src, /spawn\(/, "the tool launches its own Chrome rather than expecting one already running");
  assert.match(src, /function killTree/, "cleanup is in the tool, not left to a human");
  // Only the killTree function's own code needs checking — a comment elsewhere is allowed to
  // name the bad `/IM` command it exists to avoid repeating.
  const body = src.slice(src.indexOf("function killTree"), src.indexOf("\n}", src.indexOf("function killTree")));
  assert.match(body, /taskkill/);
  assert.match(body, /\/PID/, "cleanup targets the pid this tool launched, not an image name");
  assert.ok(!/\/IM\b/i.test(body), "killing by image name takes down every Chrome on the machine, not just this one");
});
