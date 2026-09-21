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
