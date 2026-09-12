// tests/fit.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8");

test("the mode bar carries a class or id applyModeGating can find at any width", () => {
  // A static check that the selector list from Task 3 still resolves against the current
  // markup — catches a future rename of .modes or #mode-icons before it silently stops
  // gating anything.
  assert.match(html, /class="modes"/);
  assert.match(html, /id="mode-icons"/);
});
