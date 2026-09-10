import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { anon, service } from "./clients.mjs";

const db = service();
const EMAIL = "probe-setter@fieldarc.test";
const PASSWORD = "probe-" + "x".repeat(16);
const ID = "00000000-0000-4000-8000-0000000000b1";
let userId = null;

before(async () => {
  const { data } = await db.auth.admin.createUser({
    email: EMAIL, password: PASSWORD, email_confirm: true
  });
  userId = data.user.id;
  await db.from("setters").insert({ id: userId, name: "probe" });
  await db.from("features").delete().eq("id", ID);
  await db.from("features").insert({
    id: ID, place: "T", kind: "point",
    geometry: { type: "Point", coordinates: [28.99, 41.18] },
    properties: { published: false }
  });
});

after(async () => {
  await db.from("features").delete().eq("id", ID);
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
  for (const t of ["setters", "recordings", "audit"]) {
    const { data, error } = await anon().from(t).select("*").limit(1);
    assert.ok(error || (data ?? []).length === 0, `anon reached ${t}`);
  }
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
