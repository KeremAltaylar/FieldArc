import { test } from "node:test";
import assert from "node:assert/strict";
import { service } from "./clients.mjs";

const ID = "0f0e0d0c-0b0a-4009-8008-700600500400";
const db = service();
const asSetter = service;

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

  await db.from("features").delete().eq("id", ID);
});
