import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { service } from "./clients.mjs";

const html = readFileSync("index.html", "utf8").replace(/\r\n/g, "\n");
const ID = "0f0e0d0c-0b0a-4009-8008-700600500400";
const db = service();
const asSetter = service;

before(async () => { await db.from("features").delete().eq("id", ID); });
after(async () => { await db.from("features").delete().eq("id", ID); });

test("a point with no place publishes and comes back published", async () => {
  const c = await asSetter();
  const { error } = await c.from("features").upsert({
    id: ID, place: null, kind: "point",
    geometry: { type: "Point", coordinates: [29.02, 41.01] },
    properties: { name: "free point probe", published: true }, deleted_at: null
  }, { onConflict: "id" });
  assert.equal(error, null, error?.message);

  const row = await db.from("features").select("place").eq("id", ID).single();
  assert.equal(row.error, null, "select should succeed");
  assert.equal(row.data.place, null, "the column holds NULL, not a sentinel string");

  const pub = await db.from("public_features").select("id,place").eq("id", ID).single();
  assert.equal(pub.error, null, "a free point is visible to a listener");
  assert.equal(pub.data.place, null);
});

test("marking in open world makes a free point, and the card offers to attach it", () => {
  const matches = html.match(/place: worldOn\(\) \? null : \(place \? place\.properties\.id : DEFAULT_PLACE\)/g);
  assert.ok(matches, "a point marked in open world belongs to no park");
  assert.equal(matches.length, 3,
    "exactly the point-creation sites get this treatment — a route must keep its park");
  assert.match(html, /<button type="button" class="ghost" id="f-attach" hidden>/);
  const click = html.slice(html.indexOf('$("#f-attach").addEventListener'));
  assert.match(click.slice(0, 500), /f\.properties\.place = p\.properties\.id/);
  assert.match(click.slice(0, 500), /claimEdit\(f\)/, "attaching is an edit like any other");
});

/* All three normalisation pieces below are extracted verbatim from index.html and executed for
   real — not re-implemented — so a future edit that reverts any of them back to a truthiness
   check (`!f.properties.place`) is caught here rather than only in a code review. This is
   deliberately brittle against a semantically-identical rewrite: the point is to fail loudly the
   moment the guarded source text changes shape, not to tolerate refactors quietly. Neither
   placeUnset() nor either call site touches the DOM, localStorage or fc directly, so all three
   are extractable as plain functions. */

function extractPlaceUnset() {
  const stmt = 'return !("place" in f.properties) || f.properties.place === "";';
  assert.ok(html.includes(stmt),
    "the placeUnset() body was not found verbatim — did it change shape?");
  return new Function("f", stmt);
}

test("placeUnset() rescues a missing key and an empty string, but not an explicit null", () => {
  const placeUnset = extractPlaceUnset();
  assert.equal(placeUnset({ properties: {} }), true, "a key that was never set means nobody has said");
  assert.equal(placeUnset({ properties: { place: "" } }), true,
    "an empty string from a foreign .geojson export also means nobody has said");
  assert.equal(placeUnset({ properties: { place: null } }), false,
    "an explicit null is a free point's deliberate statement of belonging to nothing");
  assert.equal(placeUnset({ properties: { place: "R8845862" } }), false, "a real place is left alone");
});

test("the load-time normalisation keys off placeUnset(), not a bare truthiness check", () => {
  const stmt = "if (placeUnset(f)) { f.properties.place = DEFAULT_PLACE; }";
  assert.ok(html.includes(stmt),
    "the load-time normalisation statement was not found verbatim — did it change shape?");
  const placeUnset = extractPlaceUnset();
  const normalise = new Function("f", "DEFAULT_PLACE", "placeUnset", stmt);

  const free = { properties: { place: null } };
  normalise(free, "R8845862", placeUnset);
  assert.equal(free.properties.place, null,
    "a deliberate free point (place: null) must survive every reload, not just the first one");

  const legacy = { properties: {} };
  normalise(legacy, "R8845862", placeUnset);
  assert.equal(legacy.properties.place, "R8845862",
    "a legacy feature with no place key at all still gets the default");

  const empty = { properties: { place: "" } };
  normalise(empty, "R8845862", placeUnset);
  assert.equal(empty.properties.place, "R8845862",
    "an empty string means nobody has said, not a deliberate free point — it gets the default");
});

test("the .geojson import path applies the identical missing/empty/null rule", () => {
  const stmt = "if (placeUnset(f)) { f.properties.place = place ? place.properties.id : DEFAULT_PLACE; }";
  assert.ok(html.includes(stmt),
    "the import normalisation statement was not found verbatim — did it change shape?");
  const placeUnset = extractPlaceUnset();
  const normalise = new Function("f", "place", "DEFAULT_PLACE", "placeUnset", stmt);

  const free = { properties: { place: null } };
  normalise(free, null, "R8845862", placeUnset);
  assert.equal(free.properties.place, null,
    "an imported free point must not be adopted into whatever park happens to be open");

  const legacy = { properties: {} };
  normalise(legacy, null, "R8845862", placeUnset);
  assert.equal(legacy.properties.place, "R8845862",
    "a legacy imported feature with no place key still gets the fallback");

  const empty = { properties: { place: "" } };
  normalise(empty, null, "R8845862", placeUnset);
  assert.equal(empty.properties.place, "R8845862",
    "an imported feature with place: \"\" also gets the fallback, not a free pass");
});
