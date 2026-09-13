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

test("offlineBytes sums a recording's own size and every hit's own size", () => {
  const start = html.indexOf("function offlineBytes(");
  const src = html.slice(start, html.indexOf("function ", start + 20));
  assert.match(src, /properties\.audio/);
  assert.match(src, /properties\.hits/);
  assert.doesNotMatch(src, /storage\.from/, "the estimate must not cost a network call");
});

test("the IndexedDB helper takes a store name, so places and audio can share one database", () => {
  const src = slice("function idb(", "function putAudio(");
  assert.match(src, /storeName/);
});

test("downloadPlace writes a places snapshot carrying its own version", () => {
  const src = slice("function downloadPlace(", "$(\"#offline\")");
  assert.match(src, /putPlaceSnapshot/);
  assert.match(src, /placeVersion/);
});
