import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { anon, service } from "./clients.mjs";

const db = service();
const EMAIL = "probe-setter@fieldarc.test";
const PASSWORD = "probe-" + "x".repeat(16);
const ID = "00000000-0000-4000-8000-0000000000b1";
let userId = null;

// A second fixture, published and sensitive, for the fuzz_point recovery oracle below.
// A distinct id namespace (b-prefix) from fuzz.test.mjs's a-prefix so the two suites never
// collide if they ever run concurrently against the same database.
const SENS_ID = "00000000-0000-4000-8000-0000000000b2";
const TRUE_LON = 28.9925, TRUE_LAT = 41.1855;
const metresApart = (a, b) => {
  const kx = Math.cos((TRUE_LAT * Math.PI) / 180);
  return Math.hypot((a[0] - b[0]) * kx, a[1] - b[1]) * 111320;
};

before(async () => {
  const { data } = await db.auth.admin.createUser({
    email: EMAIL, password: PASSWORD, email_confirm: true
  });
  userId = data.user.id;
  await db.from("setters").insert({ id: userId, name: "probe" });
  await db.from("features").delete().in("id", [ID, SENS_ID]);
  await db.from("features").insert([
    {
      id: ID, place: "T", kind: "point",
      geometry: { type: "Point", coordinates: [28.99, 41.18] },
      properties: { published: false }
    },
    {
      id: SENS_ID, place: "T", kind: "point",
      geometry: { type: "Point", coordinates: [TRUE_LON, TRUE_LAT] },
      properties: { published: true, sensitive: true, fuzz_m: 200 }
    }
  ]);
});

after(async () => {
  await db.from("features").delete().in("id", [ID, SENS_ID]);
  await db.from("audit").delete().eq("setter_id", userId);
  await db.from("setters").delete().eq("id", userId);
  if (userId) { await db.auth.admin.deleteUser(userId); }
});

async function asSetter() {
  const c = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY,
                         { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  assert.equal(error, null, error?.message);
  return c;
}

test("anon cannot read the features table at all", async () => {
  const { data, error } = await anon().from("features").select("id");
  assert.ok(error || (data ?? []).length === 0, "anon reached the underlying table");
});

test("anon cannot read setters, recordings or audit", async () => {
  // setters already has a row from before() — but recordings and audit start empty, and
  // an empty result is what a correctly-denied anon *and* a wide-open, empty table both
  // return. Seed one row into each so a leaked grant would actually surface as data.
  const { data: rec, error: recSeedErr } = await db.from("recordings")
    .insert({ feature_id: ID, storage_path: `probe/${ID}.wav`, mime: "audio/wav", bytes: 1 })
    .select().single();
  assert.equal(recSeedErr, null, recSeedErr?.message);
  const { data: aud, error: audSeedErr } = await db.from("audit")
    .insert({ setter_id: userId, action: "create", target_id: ID })
    .select().single();
  assert.equal(audSeedErr, null, audSeedErr?.message);

  try {
    for (const t of ["setters", "recordings", "audit"]) {
      const { data, error } = await anon().from(t).select("*").limit(1);
      assert.ok(error || (data ?? []).length === 0, `anon reached ${t}`);
    }
  } finally {
    await db.from("recordings").delete().eq("id", rec.id);
    await db.from("audit").delete().eq("id", aud.id);
  }
});

test("anon cannot call fuzz_point directly as an RPC", async () => {
  // fuzz_point(x, id, r) = x + offset(id, salt, r) — the offset does not depend on x. A
  // caller who can invoke it with an x of their choosing can subtract it out and recover
  // the exact offset, then subtract that from a published fuzzed point to get the truth.
  // The function must not be reachable by anon at all, regardless of what it computes.
  const { data, error } = await anon().rpc("fuzz_point", {
    g: { type: "Point", coordinates: [TRUE_LON, TRUE_LAT] },
    fid: SENS_ID, radius_m: 200
  });
  assert.ok(error, "anon invoked fuzz_point");
  assert.equal(data, null);
});

test("anon cannot call is_setter directly as an RPC", async () => {
  const { data, error } = await anon().rpc("is_setter");
  assert.ok(error, "anon invoked is_setter");
  assert.equal(data, null);
});

test("anon cannot use fuzz_point to recover a sensitive point's true coordinate", async () => {
  // The oracle: read the fuzzed position as anon would see it, then attempt the exact
  // attack described above — probe fuzz_point at the fuzzed point's own latitude (so the
  // cos(lat) term matches) to try to recover the offset and subtract back to the truth.
  const { data: pub, error: readErr } = await anon().from("public_features")
    .select("geometry").eq("id", SENS_ID).single();
  assert.equal(readErr, null, readErr?.message);
  const seen = pub.geometry.coordinates;

  assert.ok(metresApart(seen, [TRUE_LON, TRUE_LAT]) > 1,
    "the published point must not be the true point");
  assert.ok(metresApart(seen, [TRUE_LON, TRUE_LAT]) <= 200,
    "the published point must stay within its declared radius");

  const { data: probe, error: probeErr } = await anon().rpc("fuzz_point", {
    g: { type: "Point", coordinates: seen }, fid: SENS_ID, radius_m: 200
  });
  assert.ok(probeErr, "the recovery RPC must be refused, not merely unhelpful");
  assert.equal(probe, null);
});

test("anon cannot write through the public view", async () => {
  /* The view is auto-updatable and declares security_invoker = off, so a write through it
     executes as the view's owner and never meets the row-level security added in 0005.
     Supabase's default privileges granted anon ALL on it at creation and 0004 and 0006 only
     ever ADDED `grant select`, so this was accepted until 0007: an UPDATE setting
     kind='route' made the view stop fuzzing the row — the true coordinate came back at
     0.00 m error with the `fuzzed` marker gone — and a DELETE removed the base row.
     Asserted here rather than left to the migration because 0011 redefines the view, and a
     `create or replace view` that someone later turns into a drop-and-recreate would hand
     the default privileges back their opening. */
  const { error: upErr } = await anon().from("public_features")
    .update({ kind: "route" }).eq("id", SENS_ID);
  assert.ok(upErr, "anon updated a row through the view");

  const { error: delErr } = await anon().from("public_features").delete().eq("id", SENS_ID);
  assert.ok(delErr, "anon deleted a row through the view");

  const { data } = await db.from("features").select("kind").eq("id", SENS_ID).single();
  assert.equal(data.kind, "point", "the base row survived unchanged");
});

test("anon cannot write a feature", async () => {
  const { error } = await anon().from("features").insert({
    place: "T", kind: "point", geometry: { type: "Point", coordinates: [0, 0] }, properties: {}
  });
  assert.ok(error, "anon inserted a feature");
});

test("a setter can read and write features", async () => {
  const c = await asSetter();
  const { data, error } = await c.from("features").select("id").eq("id", ID);
  assert.equal(error, null, error?.message);
  assert.equal(data.length, 1, "a setter sees unpublished work");

  const { error: upErr } = await c.from("features")
    .update({ properties: { published: true } }).eq("id", ID);
  assert.equal(upErr, null, upErr?.message);
});

test("a setter can append to audit but cannot revise it", async () => {
  const c = await asSetter();
  const { error: insErr } = await c.from("audit")
    .insert({ setter_id: userId, action: "publish", target_id: ID });
  assert.equal(insErr, null, insErr?.message);

  const { data: rows } = await c.from("audit").select("id").eq("target_id", ID);
  assert.ok(rows.length >= 1);

  const { error: updErr, data: updData } = await c.from("audit")
    .update({ action: "delete" }).eq("id", rows[0].id).select();
  assert.ok(updErr || (updData ?? []).length === 0, "an audit row was rewritten");

  const { error: delErr, data: delData } = await c.from("audit")
    .delete().eq("id", rows[0].id).select();
  assert.ok(delErr || (delData ?? []).length === 0, "an audit row was deleted");
});
