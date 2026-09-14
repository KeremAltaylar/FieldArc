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

test("openPlaceMenu re-filters routes against the live search value once the fetch resolves, not a hardcoded empty string", () => {
  const src = slice("function openPlaceMenu()", "\n  }\n");
  assert.match(src, /renderRouteList\(foldTurkish\(\$\("#place-search"\)\.value\.trim\(\)\)\)/,
    "a slow fetch can resolve after the user has already typed — re-filtering against a " +
    "hardcoded \"\" would silently discard it");
  assert.doesNotMatch(src, /renderRouteList\(""\)/);
  assert.match(src, /if \(\$\("#place-menu"\)\.hidden\) \{ return; \}/,
    "must also bail if the menu closed before the fetch resolved");
});

test("a route row is visually distinct from a place row but reuses the same list markup", () => {
  const src = slice("function renderRouteList(q)", "function openPlaceMenu(");
  assert.match(src, /className = "placerow"/);
  assert.match(src, /pkind">route</);
});

test("renderPlaceList calls renderRouteList unconditionally, even when no place matches the query", () => {
  /* A route-name search (exactly what the picker's own placeholder now advertises) is not
     a place-name search — the two lists must both re-filter on every keystroke, even the
     ones where the place list itself comes up empty. */
  const src = slice("function renderPlaceList()", "\n  }\n");
  const emptyBranchStart = src.indexOf("if (!shown.length)");
  assert.ok(emptyBranchStart !== -1);
  const routeCallIdx = src.indexOf("renderRouteList(q)");
  assert.ok(routeCallIdx > emptyBranchStart,
    "renderRouteList(q) must be reachable after the empty-place branch, not only after the " +
    "non-empty one");
  const emptyBranchToRouteCall = src.slice(emptyBranchStart, routeCallIdx);
  assert.doesNotMatch(emptyBranchToRouteCall, /\breturn;/,
    "an early return between the empty-place check and renderRouteList(q) would skip the " +
    "route re-filter whenever no place name matches the query");
});
