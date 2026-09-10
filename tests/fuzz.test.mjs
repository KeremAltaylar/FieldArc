import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { anon, service, sql } from "./clients.mjs";

const db = service();
const TRUE_LON = 28.9925, TRUE_LAT = 41.1855;
const ids = {
  open:      "00000000-0000-4000-8000-0000000000a1",
  sensitive: "00000000-0000-4000-8000-0000000000a2",
  draft:     "00000000-0000-4000-8000-0000000000a3",
  sensRoute: "00000000-0000-4000-8000-0000000000a4",
  zeroFuzz:  "00000000-0000-4000-8000-0000000000c7",
  wordFuzz:  "00000000-0000-4000-8000-0000000000c2"
};
const TRUE_GEOM = { type: "Point", coordinates: [TRUE_LON, TRUE_LAT] };
/* What private.fuzz_point returns for this point at a given radius, asked directly. Used to
   pin down WHICH radius the view chose, which distance alone cannot: the offset is uniform
   over the disc, so a 25 m radius yields anything from 0 to 25 m and a single measurement
   proves nothing about the radius behind it. */
const fuzzedAt = async (id, radius) => {
  const rows = await sql(
    `select private.fuzz_point($1::jsonb, $2::uuid, $3::double precision) as g`,
    [JSON.stringify(TRUE_GEOM), id, radius]);
  return rows[0].g.coordinates;
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
      properties: { published: true, sensitive: true } },
    // Two malformed radii, both of which a hand-edited archive or a slider bound to the
    // wrong input can produce. Place PROBE so they are identifiable as throwaway rows.
    { id: ids.zeroFuzz, place: "PROBE", kind: "point",
      geometry: { type: "Point", coordinates: [TRUE_LON, TRUE_LAT] },
      properties: { published: true, sensitive: true, fuzz_m: 0 } },
    { id: ids.wordFuzz, place: "PROBE", kind: "point",
      geometry: { type: "Point", coordinates: [TRUE_LON, TRUE_LAT] },
      properties: { published: true, sensitive: true, fuzz_m: "about two hundred" } }
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

test("a fuzz radius of zero is floored, not honoured", async () => {
  // `coalesce((properties->>'fuzz_m')::float8, 200)` caught null and absence but not zero,
  // and fuzz_point at radius 0 returns the true coordinate — which the view then stamped
  // `fuzzed: true` on. An exact position published under a label asserting it is
  // approximate is worse than an open point, because the label is what a setter trusts.
  const { data, error } = await anon().from("public_features")
    .select("geometry, properties").eq("id", ids.zeroFuzz).single();
  assert.equal(error, null, error?.message);
  const seen = data.geometry.coordinates;

  assert.equal(data.properties.fuzzed, true, "the row still claims to be fuzzed");
  assert.notDeepEqual(seen, [TRUE_LON, TRUE_LAT], "a point claiming to be fuzzed was not");
  assert.deepEqual(seen, await fuzzedAt(ids.zeroFuzz, 25),
    "the radius used must be the 25 m floor");
  // And the floor is the only reason it moved: the old expression's radius returns the
  // truth exactly, which is the defect stated as an assertion.
  assert.deepEqual(await fuzzedAt(ids.zeroFuzz, 0), [TRUE_LON, TRUE_LAT]);

  const d = metres(seen, [TRUE_LON, TRUE_LAT]);
  assert.ok(d > 0 && d <= 25, `expected a displacement inside the 25 m floor, got ${d.toFixed(1)}m`);
  // Not "at least 25 m": the offset is uniform over the disc, so a 25 m radius draws a
  // displacement anywhere in [0, 25]. The floor bounds the radius, not the draw — which is
  // why the assertion that carries the weight above is the equality with fuzzedAt(…, 25).
});

test("a fuzz radius that is not a number does not take the whole view down", async () => {
  // The cast was unguarded, and a cast error is not scoped to the row that caused it: one
  // malformed value raised for every anonymous read of every place, so a single bad row
  // took the entire listener-facing surface offline.
  const { data: all, error: allErr } = await anon().from("public_features").select("id");
  assert.equal(allErr, null, allErr?.message);
  assert.ok(all.length >= 1, "the view returned rows rather than an error");

  const { data, error } = await anon().from("public_features")
    .select("geometry, properties").eq("id", ids.wordFuzz).single();
  assert.equal(error, null, error?.message);
  const seen = data.geometry.coordinates;

  assert.equal(data.properties.fuzz_m, undefined, "the bad value is not republished");
  assert.deepEqual(seen, await fuzzedAt(ids.wordFuzz, 200),
    "an unreadable radius falls back to the 200 m default, not to no fuzz");
  assert.notDeepEqual(seen, [TRUE_LON, TRUE_LAT]);
});

test("a sensitive route publishes as drawn", async () => {
  const { data } = await db.from("public_features").select("*").eq("id", ids.sensRoute).single();
  assert.deepEqual(data.geometry.coordinates[0], [TRUE_LON, TRUE_LAT],
    "routes are not fuzzed — decided 2026-09-10, a caution can come later");
  assert.equal(data.properties.fuzzed, undefined, "and it must not claim to be fuzzed");
});

test("anon needs no function privilege to read the archive", async () => {
  const rows = await sql(
    "select has_function_privilege('anon', p.oid, 'EXECUTE') as ok " +
    "from pg_proc p join pg_namespace n on n.oid = p.pronamespace " +
    "where n.nspname = 'private' and p.proname = 'fuzz_point'");
  assert.equal(rows[0].ok, false,
    "the view computes nothing at read time, so anon should need nothing");
});
