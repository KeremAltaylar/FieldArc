import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";

const html = readFileSync("index.html", "utf8");

test("404.html exists and redirects into index.html with the path preserved", () => {
  assert.ok(existsSync("404.html"), "GitHub Pages needs 404.html at the repo root to catch deep links");
  const redirect = readFileSync("404.html", "utf8");
  assert.match(redirect, /pathSegmentsToKeep/, "the base-path constant must be explicit, not inferred");
  assert.match(redirect, /location\.replace/);
});

test("parseDeepLink strips BASE_PATH before reading segments", () => {
  const start = html.indexOf("var BASE_PATH");
  assert.ok(start !== -1, "BASE_PATH must exist — segment-counting alone cannot tell a bare " +
    "place link at the site root apart from the site root itself");
  const src = html.slice(start, html.indexOf("function setPlace"));
  assert.match(src, /function parseDeepLink\(/);
  assert.match(src, /BASE_PATH/, "parseDeepLink must strip BASE_PATH, not guess it from segment count");
  assert.match(src, /split\(\s*["']\/["']\s*\)/, "must split the remainder on /");
  assert.match(src, /index\.html/, "must ignore a literal index.html segment from a direct file open");
});

test("pinBaseURI pins document.baseURI to BASE_PATH before any relative fetch can run", () => {
  const start = html.indexOf("var BASE_PATH");
  const src = html.slice(start, html.indexOf("function parseDeepLink("));
  assert.match(src, /function pinBaseURI\(/,
    "a <base> tag must be inserted right after BASE_PATH is known, before restoreDeepLinkPath's " +
    "pushState/replaceState rewrites the address bar out from under any later relative fetch " +
    "(places.geojson, ./sw.js) — a relative URL resolves against document.baseURI, which tracks " +
    "the address bar, not the URL the page actually loaded from");
  assert.match(src, /document\.createElement\(\s*["']base["']\s*\)/,
    "must insert an actual <base> element, not just read location");
  assert.match(src, /document\.head\.appendChild/, "the <base> element must land in <head> to take effect");
  assert.match(src, /location\.origin\s*\+\s*BASE_PATH/,
    "the <base> href must be built from BASE_PATH (the site's real root), not from the " +
    "current, possibly-already-rewritten pathname");
});

test("setPlace returns fetchPublished's promise, so a deep link can chain past it", () => {
  const start = html.indexOf("function setPlace(p, initial)");
  const src = html.slice(start, html.indexOf("function renderPlaceList"));
  assert.match(src, /return fetchPublished\(/, "setPlace must hand back the fetch it triggers");
});

test("loadPlaces rejects a linked route that belongs to a different place", () => {
  const start = html.indexOf("function loadPlaces(");
  const src = html.slice(start, html.indexOf("function byId"));
  assert.match(src, /properties\.place\s*===?\s*p\.properties\.id/,
    "feature() searches every place's features, so a linked route id must be checked " +
    "against the place just loaded before setSelected runs, not just found to exist");
});

test("urlForSelection names only a route, never a point", () => {
  const start = html.indexOf("function urlForSelection(");
  const src = html.slice(start, html.indexOf("function ", start + 30));
  assert.match(src, /kind\s*===?\s*["']route["']/, "a point must not become the URL's target");
});

test("setSelected pushes the URL, and setPlace's own URL update comes first", () => {
  const setSel = html.slice(html.indexOf("function setSelected("), html.indexOf("function feature("));
  assert.match(setSel, /pushState|replaceState/, "selecting must update the address bar");
});

test("setSelected does not push when the selection hasn't actually changed", () => {
  const setSel = html.slice(html.indexOf("function setSelected("), html.indexOf("function feature("));
  assert.match(setSel, /var\s+wasSelected\s*=\s*selected/,
    "must capture the previous selected value before reassigning");
  assert.match(setSel, /id\s*!==?\s*wasSelected/,
    "pushState must only fire when the id actually changed, preventing spurious history entries");
});
