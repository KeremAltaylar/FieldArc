import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/* A service worker cannot run under Node, so this checks the source text rather than
   behaviour. It exists because sw.js's catch-all fetch handler once claimed to be
   same-origin only ("Same origin: fresh when possible, cached when not") but performed
   no origin check at all, and so silently cached cross-origin Supabase auth/REST
   responses once Task 1 gave the page an API to call. */

const swPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "sw.js");
const sw = readFileSync(swPath, "utf8");

test("the fetch handler compares origins before falling through to the same-origin path", () => {
  assert.match(sw, /self\.location\.origin/,
    "sw.js must derive the worker's own origin to compare requests against it");
  assert.match(sw, /origin\s*!==\s*self\.location\.origin|self\.location\.origin\s*!==.*origin/,
    "sw.js must reject (return, not respondWith) anything that is not same-origin");
});

test("the origin check sits after IS_TILE and IS_ASSET have already claimed their hosts", () => {
  const tileAt = sw.indexOf("IS_TILE.test(url)");
  const assetAt = sw.indexOf("IS_ASSET.test(url)");
  const originAt = sw.search(/self\.location\.origin/);
  assert.ok(tileAt !== -1 && assetAt !== -1 && originAt !== -1,
    "all three checks must be present");
  assert.ok(originAt > tileAt && originAt > assetAt,
    "the origin check must come after IS_TILE/IS_ASSET, or it would reject the " +
    "cross-origin CDN and tile hosts those checks deliberately allow");
});

test("the shell cache was renamed to v2, evicting any cache already holding a poisoned entry", () => {
  assert.match(sw, /var SHELL\s*=\s*"fieldarc-shell-v2"/,
    "renaming SHELL is what makes activate's cache-name cleanup evict a cache that " +
    "already holds a cached Supabase response from the unguarded catch-all");
});

test("the tile cache is not renamed: tile entries are expensive, permanent, and unaffected", () => {
  assert.match(sw, /var TILES\s*=\s*"fieldarc-tiles-v1"/);
});
