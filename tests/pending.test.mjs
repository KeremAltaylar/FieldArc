import { test } from "node:test";
import assert from "node:assert/strict";
import { hashFeature, manifestOf, diffManifest } from "../src/pending.mjs";

const f = (id, name) => ({
  type: "Feature",
  properties: { id, kind: "point", name, place: "P" },
  geometry: { type: "Point", coordinates: [29, 41] }
});

test("the same feature hashes the same twice", () => {
  assert.equal(hashFeature(f("a", "x")), hashFeature(f("a", "x")));
});

test("a changed property changes the hash", () => {
  assert.notEqual(hashFeature(f("a", "x")), hashFeature(f("a", "y")));
});

test("key order does not change the hash", () => {
  const one = { type: "Feature", properties: { id: "a", kind: "point" }, geometry: null };
  const two = { type: "Feature", geometry: null, properties: { kind: "point", id: "a" } };
  assert.equal(hashFeature(one), hashFeature(two),
    "JSON.stringify key order follows insertion order; a re-saved feature must not read as changed");
});

test("added, changed and removed are each reported", () => {
  const before = manifestOf([f("a", "x"), f("b", "x")]);
  const after = manifestOf([f("a", "x"), f("b", "CHANGED"), f("c", "new")]);
  const d = diffManifest(before, after);
  assert.deepEqual(d.added, ["c"]);
  assert.deepEqual(d.changed, ["b"]);
  assert.deepEqual(d.removed, []);
});

test("a feature deleted locally is reported as removed", () => {
  const before = manifestOf([f("a", "x"), f("b", "x")]);
  const after = manifestOf([f("a", "x")]);
  assert.deepEqual(diffManifest(before, after).removed, ["b"]);
});

test("an empty previous manifest makes everything added, not changed", () => {
  const d = diffManifest({}, manifestOf([f("a", "x")]));
  assert.deepEqual(d.added, ["a"]);
  assert.deepEqual(d.changed, []);
});
