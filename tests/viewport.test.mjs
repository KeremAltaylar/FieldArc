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
