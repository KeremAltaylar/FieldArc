import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8").replace(/\r\n/g, "\n");
function src(name) {
  const s = html.indexOf("function " + name + "(");
  assert.ok(s !== -1, "missing " + name);
  let i = html.indexOf("{", html.indexOf(")", s)), d = 0;
  for (; i < html.length; i++) { if (html[i] === "{") d++; else if (html[i] === "}") { d--; if (!d) break; } }
  return html.slice(s, i + 1);
}

function load(stored) {
  const store = { getItem: () => stored, setItem: () => {} };
  return new Function("localStorage", 'var WORLD_KEY = "fieldarc.world";' + src("worldOn") + "; return worldOn;")(store);
}

test("open world is the default on a device that has never chosen", () => {
  assert.equal(load(null)(), true);
});

test("a device that turned it off stays off", () => {
  assert.equal(load("0")(), false);
});

test("a device that turned it on stays on", () => {
  assert.equal(load("1")(), true);
});

test("the key joins the existing lowercase family", () => {
  assert.match(html, /var WORLD_KEY = "fieldarc\.world";/);
});

test("the map carries its own frame on a desktop, and not on the phone layout", () => {
  const rule = html.slice(html.indexOf("#map {"), html.indexOf("}", html.indexOf("#map {")) + 1);
  assert.match(rule, /border-right: 1px solid var\(--bdr\)/);
  assert.match(rule, /border-bottom: 1px solid var\(--bdr\)/);
  const phone = html.slice(html.indexOf("#map { grid-row: 2; grid-column: 1;"));
  assert.match(phone.slice(0, 400), /#map \{ grid-row: 2; grid-column: 1; border-right: 0; border-bottom: 0; \}/,
    "the phone layout keeps its edges, where the map meets the sheet");
});

test("the picker carries the switch, and a listener sees routes but no park list", () => {
  assert.match(html, /<button type="button" id="world-switch" aria-pressed="true">/);
  assert.match(html, /Open world/);
  const render = src("renderPlaceList");
  assert.match(render, /if \(!setterTools\(\)\) \{ \$\("#place-list"\)\.hidden = true;/,
    "a park list is a dead end for a listener");
  const click = html.slice(html.indexOf('$("#world-switch").addEventListener'));
  assert.match(click.slice(0, 400), /setWorld\(/);
  assert.match(click.slice(0, 400), /applyWorld\(\)/);
});

test("the switch is synced from worldOn() every time the menu renders, not left at its markup default", () => {
  /* A device that previously turned Open world off must see the switch reflect that on the
     next open — the markup's aria-pressed="true" is only the never-chosen default, the same
     way #gps-btn is driven from the stored GPS_KEY rather than trusted from markup. */
  const open = src("openPlaceMenu");
  assert.match(open, /\$\("#world-switch"\)\.setAttribute\("aria-pressed", String\(worldOn\(\)\)\)/,
    "openPlaceMenu must re-read worldOn() and drive the switch from it, not just from the click handler");
});

test("in open world every shown feature is visible, in place mode only the open park's", () => {
  const vis = src("visible");
  assert.match(vis, /worldOn\(\) \|\| !place/,
    "the place filter is skipped in open world");
  assert.match(vis, /f\.properties\.place == null/,
    "a free point passes either way, because no park owns it");
  assert.match(src("fetchWorld"), /from\("public_features"\)\.select\("\*"\)/);
  assert.ok(!src("fetchWorld").includes('.eq("place"'), "every place at once");
  assert.match(src("applyWorld"), /fetchWorld\(\)/);
});

test("a free point is shown even when a park is open", () => {
  const shown = src("visible");
  assert.match(shown, /f\.properties\.place == null/,
    "a point belonging to nothing is not hidden by a park filter");
});

test("a route picked in open world centres and selects without leaving the mode", () => {
  const list = src("renderRouteList");
  assert.match(list, /if \(worldOn\(\)\) \{/, "open world does not fall through to setPlace");
  assert.match(list, /setSelected\(rt\.id, true\)/);
  assert.match(list, /worldMove\(/, "the walker moves to the route the listener picked");
  assert.ok(!/worldOn\(\)[\s\S]{0,200}setWorld\(false\)/.test(list),
    "picking a route must not switch the mode off");
});
