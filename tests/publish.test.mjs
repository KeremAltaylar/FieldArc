import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { service } from "./clients.mjs";
import { readFileSync } from "node:fs";

const db = service();
const html = readFileSync("index.html", "utf8");
const EMAIL = "publish-probe@fieldarc.test";
const PASSWORD = "probe-" + "y".repeat(16);
/* A second setter, because two of the rules below are only observable when the person
   publishing is not the person who set the point. */
const EMAIL_B = "publish-probe-b@fieldarc.test";
const PASSWORD_B = "probe-" + "w".repeat(16);
const ID = "00000000-0000-4000-8000-0000000000c1";
/* Not ...c2: that id is fuzz.test.mjs's malformed-radius fixture, and test files run in
   parallel processes against one shared database. Colliding on it made that suite fail. */
const ID2 = "00000000-0000-4000-8000-0000000000d1";
let userId = null;
let userB = null;

before(async () => {
  const { data } = await db.auth.admin.createUser({
    email: EMAIL, password: PASSWORD, email_confirm: true });
  userId = data.user.id;
  await db.from("setters").insert({ id: userId, name: "publish probe" });

  const b = await db.auth.admin.createUser({
    email: EMAIL_B, password: PASSWORD_B, email_confirm: true });
  userB = b.data.user.id;
  await db.from("setters").insert({ id: userB, name: "publish probe B" });
});

after(async () => {
  await db.from("features").delete().in("id", [ID, ID2]);
  await db.from("audit").delete().eq("setter_id", userId);
  await db.from("audit").delete().eq("setter_id", userB);
  await db.from("setters").delete().in("id", [userId, userB].filter(Boolean));
  if (userId) { await db.auth.admin.deleteUser(userId); }
  if (userB) { await db.auth.admin.deleteUser(userB); }
});

async function signInAs(email, password) {
  const c = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY,
                         { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password });
  assert.equal(error, null, error?.message);
  return c;
}

async function asSetter() { return signInAs(EMAIL, PASSWORD); }
async function asSetterB() { return signInAs(EMAIL_B, PASSWORD_B); }

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

/* Findings 3 and 4 are both the same property of PostgREST's upsert: ON CONFLICT DO UPDATE
   sets only the columns the payload actually names, and leaves every other column exactly as
   it was. That cuts both ways, so both directions are measured against the real database
   rather than reasoned about — the defect and the fix differ only by which keys are present. */

test("an upsert that omits deleted_at leaves a soft delete in place — and naming it clears it", async () => {
  const c = await asSetter();
  const base = { id: ID2, place: "PROBE", kind: "point",
    geometry: { type: "Point", coordinates: [29, 41] },
    properties: { name: "undo probe" }, created_by: userId };

  await c.from("features").upsert(base, { onConflict: "id" });
  await c.from("features").update({ deleted_at: new Date().toISOString() }).eq("id", ID2);

  /* The defect: re-publishing a feature the setter brought back out of the trash. */
  await c.from("features").upsert(base, { onConflict: "id" });
  const still = await db.from("features").select("deleted_at").eq("id", ID2).single();
  assert.ok(still.data.deleted_at,
    "an upsert that does not name deleted_at cannot clear it — this is why the fix is needed");

  /* The fix: the row publish() actually sends. */
  await c.from("features").upsert({ ...base, deleted_at: null }, { onConflict: "id" });
  const back = await db.from("features").select("deleted_at").eq("id", ID2).single();
  assert.equal(back.data.deleted_at, null,
    "publishing an undeleted feature must make it visible to listeners again");
});

test("an upsert that omits created_by leaves the original setter's name on the work", async () => {
  const c = await asSetter();
  await c.from("features").upsert({ id: ID2, place: "PROBE", kind: "point",
    geometry: { type: "Point", coordinates: [29, 41] },
    properties: { name: "authorship probe" }, created_by: userId }, { onConflict: "id" });

  /* Setter B fixes a typo in setter A's point and publishes it. A change carries no
     created_by, so the archive keeps saying A set it. */
  const cb = await asSetterB();
  const edit = await cb.from("features").upsert({ id: ID2, place: "PROBE", kind: "point",
    geometry: { type: "Point", coordinates: [29, 41] },
    properties: { name: "authorship probe, corrected" }, deleted_at: null },
    { onConflict: "id" });
  assert.equal(edit.error, null, edit.error?.message);

  const kept = await db.from("features").select("created_by,properties").eq("id", ID2).single();
  assert.equal(kept.data.created_by, userId, "editing someone's point must not take it over");
  assert.equal(kept.data.properties.name, "authorship probe, corrected", "the edit still landed");

  /* The defect, for contrast: stamping it on every push is what transferred authorship. */
  await cb.from("features").upsert({ id: ID2, place: "PROBE", kind: "point",
    geometry: { type: "Point", coordinates: [29, 41] },
    properties: { name: "authorship probe, corrected" }, created_by: userB },
    { onConflict: "id" });
  const taken = await db.from("features").select("created_by").eq("id", ID2).single();
  assert.equal(taken.data.created_by, userB,
    "naming created_by on a change does overwrite it — which is precisely why publish() must not");
});

test("publish() stamps created_by on new features only, and always clears deleted_at", () => {
  const start = html.indexOf("function publish()");
  const end = html.indexOf('addEventListener("click", publish)');
  assert.ok(start !== -1 && end > start, "the publish() slice is bounded and forwards");
  const pub = html.slice(start, end);
  assert.match(pub, /deleted_at: null/, "every published row states that it is not deleted");
  assert.match(pub, /if \(isNew\) \{ row\.created_by = setter\.id; \}/,
    "created_by is conditional on the feature being new, not stamped on every row");
  assert.doesNotMatch(pub, /geometry: f\.geometry, properties: p, created_by: setter\.id/,
    "the unconditional stamp is what reassigned another setter's work");
  /* Two batches — see the test below for the measured reason they cannot be one. */
  assert.match(pub, /upsertBatch\(newRows\)/);
  assert.match(pub, /upsertBatch\(changedRows\)/);
});

/* Why added and changed rows cannot share one request, measured rather than assumed. The
   guess was that PostgREST would refuse a bulk body whose objects carry different keys. It
   does not: it takes the UNION of the keys and writes NULL for whichever object is missing
   one. Batching a change alongside an addition would therefore not merely fail to preserve
   created_by — it would erase it, which is worse than the defect being fixed. This test
   exists so that a future tidy-up concatenating the two arrays back together fails here
   instead of quietly unowning half the archive. */
test("a mixed batch nulls the column the other row omits — which is why publish sends two", async () => {
  const c = await asSetter();
  const geom = { type: "Point", coordinates: [29, 41] };
  await c.from("features").upsert({ id: ID2, place: "PROBE", kind: "point",
    geometry: geom, properties: { n: 0 }, created_by: userId }, { onConflict: "id" });

  const mixed = await c.from("features").upsert([
    { id: ID, place: "PROBE", kind: "point", geometry: geom,
      properties: { n: 1 }, deleted_at: null, created_by: userId },
    { id: ID2, place: "PROBE", kind: "point", geometry: geom,
      properties: { n: 2 }, deleted_at: null }
  ], { onConflict: "id" });
  assert.equal(mixed.error, null,
    "PostgREST accepts the mixed body — the danger is that it does not complain");

  const { data } = await db.from("features").select("created_by").eq("id", ID2).single();
  assert.equal(data.created_by, null,
    "the omitted key was written as NULL, not left alone — one batch would unown the row");
});

test("publishing writes an audit row naming the setter", async () => {
  const c = await asSetter();
  const { error } = await c.from("audit")
    .insert({ setter_id: userId, action: "publish", target_id: ID, detail: { n: 1 } });
  assert.equal(error, null, error?.message);

  const { data } = await db.from("audit").select("action,target_id").eq("setter_id", userId);
  assert.ok(data.some((r) => r.action === "publish" && r.target_id === ID));
});
