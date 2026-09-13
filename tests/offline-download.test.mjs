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

test("setPlace re-enables the offline button, so a stale in-flight arm-query or " +
     "download left over from the previous place can't leave it stuck disabled", () => {
  /* The stale-place guard in the #offline handler (`if (place !== targetPlace) { return; }`)
     abandons any in-flight operation for the OLD place without ever resetting
     btn.disabled back to false for it. setPlace already resets offlineArmed and the
     button's text on every switch — disabled must be reset right alongside them. */
  const src = slice("function setPlace(p, initial)", "function renderPlaceList");
  const armedAt = src.indexOf("offlineArmed = null;");
  assert.ok(armedAt !== -1, "setPlace must still reset offlineArmed");
  assert.match(src.slice(armedAt), /\$\("#offline"\)\.disabled\s*=\s*false/,
    "must reset the button's disabled state alongside offlineArmed and its text");
});

test("loadPlaces falls back to the downloaded snapshot when the place ends up with no " +
     "features after fetchPublished settles", () => {
  /* This is the fix for the cold/offline-reload bug: putPlaceSnapshot wrote a snapshot
     that nothing ever read back into fc. The real proof of this fix is the live-browser
     verification in the fix report, not a source-text regex — but the wiring itself
     (calling getPlaceSnapshot and feeding its features through mergeRemote) is at least
     pinned here so a future edit can't silently drop it. */
  const start = html.indexOf("function loadPlaces(");
  const src = html.slice(start, html.indexOf("function byId"));
  assert.match(src, /visible\(\)\.length\s*>\s*0|visible\(\)\.length\s*===?\s*0/,
    "must gate the fallback on whether the place actually has any features");
  assert.match(src, /getPlaceSnapshot\(/, "must read back the snapshot downloadPlace wrote");
  assert.match(src, /mergeRemote\(\s*snap\.features\s*\)/,
    "the snapshot's features must be merged into fc the same way a live fetch's rows are");
  assert.match(src, /map\.getSource\(\s*["']features["']\s*\)\.setData/,
    "the map must be redrawn from the snapshot, not just fc updated invisibly");
});

test("the #offline button's size-estimate query has a .catch, so a network rejection " +
     "can't leave the button disabled forever", () => {
  const handler = slice("$(\"#offline\").addEventListener", "setMode(\"select\")");
  const armStep = handler.slice(0, handler.indexOf("offlineArmed = null;"));
  assert.match(armStep, /\.catch\(/, "a genuine network rejection on the size query must be caught");
  assert.match(armStep, /btn\.disabled\s*=\s*false/, "the catch must re-enable the button");
});

test("the #offline click handler captures the place it started for and uses it in both " +
     "in-flight callbacks, not whatever `place` is when they resolve", () => {
  const handler = slice("$(\"#offline\").addEventListener", "setMode(\"select\")");
  assert.match(handler, /var\s+targetPlace\s*=\s*place\s*;/,
    "must snapshot `place` once, up front, before either async step");
  assert.match(handler, /downloadPlace\(\s*targetPlace\s*\)/,
    "the download itself must run against the captured place");
  assert.match(handler, /place\s*!==?\s*targetPlace/,
    "each callback must check whether the place has since changed before touching the UI");
});

test("the #offline click handler restores the !window.caches guard", () => {
  const handler = slice("$(\"#offline\").addEventListener", "setMode(\"select\")");
  assert.match(handler, /!window\.caches/, "offline storage being unavailable must still be checked");
});

test("db() handles a blocked upgrade and a version change from elsewhere", () => {
  const src = slice("function db()", "function idb(");
  assert.match(src, /onblocked\s*=/, "another tab holding the old version open must not hang silently");
  assert.match(src, /onversionchange\s*=/, "a version bump elsewhere must not leave a stale connection open");
});

test("downloadPlace verifies a fetched blob actually landed in storage before counting " +
     "the job as successful", () => {
  /* audioBlob swallows a failed putAudio write and still returns the blob it fetched —
     correct for its other caller (lazy per-open playback), wrong for a download whose
     whole point is that the write succeeded. Reading the key back with getAudio is the
     only way downloadPlace can tell the two cases apart. */
  const dl = slice("function downloadPlace(", "$(\"#offline\")");
  assert.match(dl, /getAudio\(\s*key\s*\)/, "must read the blob back by the same key it was stored under");
  assert.match(dl, /if \(!stored\) \{ audioFailed\+\+; \}/,
    "a fetch that succeeded but didn't land in storage must still count as a failure");
});

test("downloadPlace does not add navigator.storage.persist/estimate UI", () => {
  /* Explicitly out of scope for this fix wave — only the fetch-vs-store distinction above. */
  const dl = slice("function downloadPlace(", "$(\"#offline\")");
  assert.doesNotMatch(dl, /navigator\.storage/);
});

test("downloadPlace's snapshot write does not depend on cacheTiles succeeding", () => {
  /* The snapshot is load-bearing for the cold-offline-reload fallback (loadPlaces reads
     it back) — a listener whose every recording fetched fine must not lose the whole
     offline archive because tile caching rejected outright (Cache API unavailable,
     storage full, a rejected caches.open()). A per-tile failure already comes back as a
     resolved { failed } count from cacheTiles and needs no special handling; only an
     outright rejection of the cacheTiles() call itself is the gap this closes. */
  const dl = slice("function downloadPlace(", "$(\"#offline\")");
  const cacheTilesCallAt = dl.indexOf("cacheTiles(p)");
  const putSnapshotAt = dl.indexOf("putPlaceSnapshot(");
  assert.ok(cacheTilesCallAt !== -1, "downloadPlace must still call cacheTiles");
  assert.ok(putSnapshotAt !== -1 && putSnapshotAt > cacheTilesCallAt,
    "putPlaceSnapshot must still run after the tile step, just not depend on it succeeding");
  const between = dl.slice(cacheTilesCallAt, putSnapshotAt);
  assert.match(between, /\.catch\(/,
    "a rejected cacheTiles() must not prevent putPlaceSnapshot from running");
});

test("checkStaleness swallows a genuine network rejection, not just a Supabase {error} reply", () => {
  /* Supabase resolves most failures to { error }, already handled above — but a real network
     rejection (DNS, dropped connection, aborted request) rejects the promise instead.
     checkStaleness is called fire-and-forget from setPlace with no .then/.catch at the call
     site, so an unhandled rejection here would reach the app's global unhandledrejection
     handler and toast a spurious "Error: ..." at a listener who is simply offline in the
     field — exactly the case this function must degrade silently through, per fetchPublished's
     identical guard on the same public_features query shape. */
  const src = slice("function checkStaleness(", "var offlineArmed");
  assert.match(src, /\.catch\(/, "a network rejection on the version fetch must be caught");
});
