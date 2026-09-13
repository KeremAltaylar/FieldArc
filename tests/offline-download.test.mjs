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

test("downloadPlace reports audio and tile failures instead of silently succeeding", () => {
  /* audioBlob resolves to null (not a rejection) on failure, and cacheTiles already counts
     failed tiles — a "saved" result that drops both numbers tells a listener a flaky
     download finished clean when it didn't. */
  const dl = slice("function downloadPlace(", "$(\"#offline\")");
  assert.match(dl, /audioFailed/, "must count blobs that resolved to null");
  assert.match(dl, /tilesFailed/, "must carry cacheTiles' own failed count forward");

  const handler = slice("$(\"#offline\").addEventListener", "setMode(\"select\")");
  assert.match(handler, /result\.audioFailed/, "the success path must surface audio failures");
  assert.match(handler, /result\.tilesFailed/, "the success path must surface tile failures");
});

test("checkStaleness only reports — it never calls downloadPlace itself", () => {
  /* Not the "next function" heuristic used elsewhere in this file: checkStaleness's own
     first line is a `.then(function (snap) {` callback, so that heuristic would cut the
     slice off before ever reaching the toast() call it exists to check for. An explicit
     end marker (the next declaration in index.html) captures the whole body instead. */
  const src = slice("function checkStaleness(", "var offlineArmed");
  assert.match(src, /toast\(/, "a mismatch must be reported, not silently ignored");
  assert.doesNotMatch(src, /downloadPlace\(/, "staleness must never trigger its own refresh");
});

test("setPlace checks staleness for a place that was downloaded", () => {
  const src = slice("function setPlace(p, initial)", "function renderPlaceList");
  assert.match(src, /checkStaleness\(/);
});
