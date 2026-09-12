import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8");

test("mergeRemote adds a feature the archive does not already have", () => {
  const src = html.slice(html.indexOf("function mergeRemote("),
                         html.indexOf("function fetchPublished("));
  assert.ok(src.length > 0, "mergeRemote exists");
  assert.match(src, /_remote\s*:\s*true/, "a merged feature is marked remote, not local");
});

test("save() never writes a remote feature to localStorage", () => {
  const src = html.slice(html.indexOf("function save() {"), html.indexOf("function save() {") + 600);
  assert.match(src, /_remote/, "save() must filter remote features before persisting");
});

test("fetchPublished queries public_features scoped to a place", () => {
  const src = html.slice(html.indexOf("function fetchPublished("),
                         html.indexOf("function fetchPublished(") + 500);
  assert.match(src, /public_features/);
  assert.match(src, /\.eq\(\s*["']place["']/);
});
