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

test("fetchAllRoutes queries public_features for every route, with no place filter", () => {
  const src = slice("function fetchAllRoutes()", "\n  }\n");
  assert.match(src, /\.from\("public_features"\)/);
  assert.match(src, /\.eq\("kind",\s*"route"\)/);
  assert.doesNotMatch(src, /\.eq\("place"/,
    "this must be unscoped by place — fetchPublished already covers the scoped case");
  assert.match(src, /catch\(/, "an offline listener must keep whatever was last fetched, not crash");
});

test("renderRouteList resolves each route's own place via byId, skipping any that don't resolve", () => {
  const src = slice("function renderRouteList(q)", "function openPlaceMenu(");
  assert.match(src, /byId\(rt\.place\)/);
  assert.match(src, /if \(!p\) \{ return false; \}/,
    "a route whose place can't be found must be skipped, not thrown on");
});

test("clicking a route row sets the place first, then selects the route inside it", () => {
  const src = slice("function renderRouteList(q)", "function openPlaceMenu(");
  assert.match(src, /setPlace\(p\)\.then\(function \(\) \{ setSelected\(rt\.id, true\); \}\)/,
    "the route must not be selected before its own place's features have loaded");
});

test("openPlaceMenu fetches the route list every time it opens, not just once", () => {
  const src = slice("function openPlaceMenu()", "\n  }\n");
  assert.match(src, /fetchAllRoutes\(\)/);
  assert.match(src, /renderRouteList\(/);
});

test("a route row is visually distinct from a place row but reuses the same list markup", () => {
  const src = slice("function renderRouteList(q)", "function openPlaceMenu(");
  assert.match(src, /className = "placerow"/);
  assert.match(src, /pkind">route</);
});
