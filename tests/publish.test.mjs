import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { service } from "./clients.mjs";
import { readFileSync } from "node:fs";

const db = service();
const html = readFileSync("index.html", "utf8");
const EMAIL = "publish-probe@fieldarc.test";
const PASSWORD = "probe-" + "y".repeat(16);
const ID = "00000000-0000-4000-8000-0000000000c1";
let userId = null;

before(async () => {
  const { data } = await db.auth.admin.createUser({
    email: EMAIL, password: PASSWORD, email_confirm: true });
  userId = data.user.id;
  await db.from("setters").insert({ id: userId, name: "publish probe" });
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

test("the page shows a pending count and a publish control", () => {
  assert.match(html, /id="publish-btn"/);
  assert.match(html, /id="pending-count"/);
});

test("a setter's upsert stamps created_by and is idempotent", async () => {
  const c = await asSetter();
  const row = { id: ID, place: "PROBE", kind: "point",
    geometry: { type: "Point", coordinates: [29, 41] },
    properties: { name: "probe", published: false }, created_by: userId };

  const one = await c.from("features").upsert(row, { onConflict: "id" }).select("id");
  assert.equal(one.error, null, one.error?.message);
  const two = await c.from("features").upsert(row, { onConflict: "id" }).select("id");
  assert.equal(two.error, null, two.error?.message);

  const { count } = await db.from("features")
    .select("id", { count: "exact", head: true }).eq("id", ID);
  assert.equal(count, 1, "publishing twice must not duplicate");

  const { data } = await db.from("features").select("created_by").eq("id", ID).single();
  assert.equal(data.created_by, userId, "the archive records who set it");
});

test("a removal is soft, so a sync cannot erase a morning", async () => {
  const c = await asSetter();
  const { error } = await c.from("features")
    .update({ deleted_at: new Date().toISOString() }).eq("id", ID);
  assert.equal(error, null, error?.message);

  const { data } = await db.from("features").select("deleted_at").eq("id", ID).single();
  assert.ok(data.deleted_at, "the row is still there, marked");
});

test("publishing writes an audit row naming the setter", async () => {
  const c = await asSetter();
  const { error } = await c.from("audit")
    .insert({ setter_id: userId, action: "publish", target_id: ID, detail: { n: 1 } });
  assert.equal(error, null, error?.message);

  const { data } = await db.from("audit").select("action,target_id").eq("setter_id", userId);
  assert.ok(data.some((r) => r.action === "publish" && r.target_id === ID));
});
