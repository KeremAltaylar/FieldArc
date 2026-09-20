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
