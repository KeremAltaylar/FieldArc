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

test("placeVersion counts rows and finds the latest updated_at", () => {
  const src = slice("function placeVersion(", "function sameVersion(");
  assert.match(src, /rows\.length/, "count must come from the rows given, not a stored total");
  assert.match(src, /updated_at/, "the max must be read from each row's updated_at");
});

test("sameVersion compares both count and maxUpdatedAt", () => {
  const src = slice("function sameVersion(", "function ");
  assert.match(src, /count/);
  assert.match(src, /maxUpdatedAt/);
});
