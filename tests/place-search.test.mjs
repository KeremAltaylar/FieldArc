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

/* foldTurkish is a pure string function with no DOM dependency, so — unlike most of this
   file's functions — it can actually be extracted and run, not just pattern-matched. */
function extractFoldTurkish() {
  const src = slice("function foldTurkish(s) {", "function renderPlaceList(");
  const body = src.slice(src.indexOf("{") + 1, src.lastIndexOf("}"));
  return new Function("s", body);
}

test("foldTurkish makes a plain-ASCII search match a diacritic name", () => {
  const foldTurkish = extractFoldTurkish();
  assert.equal(foldTurkish("Koşuyolu Parkı"), foldTurkish("kosuyolu parki"),
    "ş and ı must fold the same as their ASCII typo, or the search this exists for still fails");
  assert.equal(foldTurkish("Moda Parkı"), foldTurkish("moda parki"));
  assert.equal(foldTurkish("Göktürk Ormanı"), foldTurkish("gokturk ormani"),
    "ö, ü and ğ are the ones NFD actually decomposes — must not regress once ı/İ are handled");
});

test("foldTurkish handles the dotted/dotless I pair NFD does not decompose", () => {
  const foldTurkish = extractFoldTurkish();
  /* ı (dotless) and İ (dotted capital) are their own base characters in Unicode, not a
     letter-plus-combining-mark — NFD leaves them untouched, which is exactly why the naive
     "normalize then strip marks" approach silently misses them. */
  assert.equal(foldTurkish("İstanbul"), "istanbul");
  assert.equal(foldTurkish("ıhlamur"), "ihlamur");
});

test("renderPlaceList filters through foldTurkish, not a bare toLowerCase", () => {
  /* Explicit end marker, not the generic "function " heuristic: renderPlaceList's own body
     nests fc.features.forEach(function (f) {...}) before reaching the filter() call this
     test needs to see, so the generic heuristic would truncate before it and this test
     would pass without checking the line it exists to check. Ends at renderRouteList,
     renderPlaceList's own next sibling — not at openPlaceMenu, which is one function
     further and would also pull renderRouteList's own foldTurkish calls into this count. */
  const render = slice("function renderPlaceList()", "function renderRouteList(");
  const foldCalls = render.match(/foldTurkish\(/g) || [];
  assert.equal(foldCalls.length, 2,
    "both the typed query AND each candidate name must be folded, or the two sides never match");
  assert.doesNotMatch(render, /\.value\.trim\(\)\.toLowerCase\(\)/,
    "reverting to plain toLowerCase() silently reopens the diacritic gap");
});

test("renderRouteList also filters through foldTurkish against both the route name and its place name", () => {
  const render = slice("function renderRouteList(q)", "function openPlaceMenu(");
  const foldCalls = render.match(/foldTurkish\(/g) || [];
  assert.equal(foldCalls.length, 2,
    "both rt.name and its place's name must be folded, the same as the place list");
});
