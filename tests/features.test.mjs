import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { service } from "./clients.mjs";

const db = service();
const ID = "00000000-0000-4000-8000-00000000f001";

before(async () => { await db.from("features").delete().eq("id", ID); });
after(async () => { await db.from("features").delete().eq("id", ID); });

test("a point round-trips with its properties intact", async () => {
  const row = {
    id: ID, place: "R8845862", kind: "point",
    geometry: { type: "Point", coordinates: [28.9925, 41.1855] },
    properties: { name: "probe", published: true, sensitive: false, icon: "tree",
                  sound: { radius: 140, gain: 0.9, zoneR: 25 } }
  };
  const { error } = await db.from("features").insert(row);
  assert.equal(error, null, error?.message);

  const { data } = await db.from("features").select("*").eq("id", ID).single();
  assert.equal(data.kind, "point");
  assert.deepEqual(data.geometry.coordinates, [28.9925, 41.1855]);
  assert.equal(data.properties.sound.zoneR, 25);
  assert.equal(data.deleted_at, null);
});

test("kind is constrained to point or route", async () => {
  const { error } = await db.from("features").insert({
    id: "00000000-0000-4000-8000-00000000f002", place: "R8845862", kind: "banana",
    geometry: { type: "Point", coordinates: [0, 0] }, properties: {}
  });
  assert.ok(error, "a kind outside the enum must be refused by the database");
});
