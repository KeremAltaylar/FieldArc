import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { service } from "./clients.mjs";

const db = service();
const TRUE_LON = 28.9925, TRUE_LAT = 41.1855;
const ids = {
  open:      "00000000-0000-4000-8000-0000000000a1",
  sensitive: "00000000-0000-4000-8000-0000000000a2",
  draft:     "00000000-0000-4000-8000-0000000000a3",
  sensRoute: "00000000-0000-4000-8000-0000000000a4"
};
const metres = (a, b) => {
  const kx = Math.cos((TRUE_LAT * Math.PI) / 180);
  return Math.hypot((a[0] - b[0]) * kx, a[1] - b[1]) * 111320;
};

before(async () => {
  await db.from("features").delete().in("id", Object.values(ids));
  await db.from("features").insert([
    { id: ids.open, place: "T", kind: "point",
      geometry: { type: "Point", coordinates: [TRUE_LON, TRUE_LAT] },
      properties: { published: true, sensitive: false } },
    { id: ids.sensitive, place: "T", kind: "point",
      geometry: { type: "Point", coordinates: [TRUE_LON, TRUE_LAT] },
      properties: { published: true, sensitive: true, fuzz_m: 200 } },
    { id: ids.draft, place: "T", kind: "point",
      geometry: { type: "Point", coordinates: [TRUE_LON, TRUE_LAT] },
      properties: { published: false, sensitive: false } },
    { id: ids.sensRoute, place: "T", kind: "route",
      geometry: { type: "LineString", coordinates: [[TRUE_LON, TRUE_LAT], [29.0, 41.19]] },
      properties: { published: true, sensitive: true } }
  ]);
});
after(async () => { await db.from("features").delete().in("id", Object.values(ids)); });

test("an open published point is returned exactly", async () => {
  const { data } = await db.from("public_features").select("*").eq("id", ids.open).single();
  assert.deepEqual(data.geometry.coordinates, [TRUE_LON, TRUE_LAT]);
});

test("a sensitive point is moved, but stays within its radius", async () => {
  const { data } = await db.from("public_features").select("*").eq("id", ids.sensitive).single();
  const d = metres(data.geometry.coordinates, [TRUE_LON, TRUE_LAT]);
  assert.ok(d > 1, `expected the point to move, moved ${d.toFixed(1)}m`);
  assert.ok(d <= 200, `expected within the 200m radius, was ${d.toFixed(1)}m`);
});

test("the same sensitive point reads the same every time", async () => {
  const reads = [];
  for (let i = 0; i < 5; i++) {
    const { data } = await db.from("public_features").select("geometry").eq("id", ids.sensitive).single();
    reads.push(JSON.stringify(data.geometry.coordinates));
  }
  assert.equal(new Set(reads).size, 1, "a re-randomised offset averages out to the truth");
});

test("the fuzz radius is not disclosed, but the fact of fuzzing is", async () => {
  const { data } = await db.from("public_features").select("properties").eq("id", ids.sensitive).single();
  assert.equal(data.properties.fuzz_m, undefined, "fuzz_m narrows the search");
  assert.equal(data.properties.sensitive, undefined, "the flag itself is internal");
  assert.equal(data.properties.fuzzed, true, "a listener is told the position is approximate");
});

test("an unpublished feature is not in the view", async () => {
  const { data } = await db.from("public_features").select("id").eq("id", ids.draft);
  assert.equal(data.length, 0);
});

test("a sensitive route publishes as drawn", async () => {
  const { data } = await db.from("public_features").select("*").eq("id", ids.sensRoute).single();
  assert.deepEqual(data.geometry.coordinates[0], [TRUE_LON, TRUE_LAT],
    "routes are not fuzzed — decided 2026-09-10, a caution can come later");
  assert.equal(data.properties.fuzzed, undefined, "and it must not claim to be fuzzed");
});
