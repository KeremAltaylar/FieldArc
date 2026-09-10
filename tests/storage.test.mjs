import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { anon, service, sql } from "./clients.mjs";

const db = service();
const html = readFileSync("index.html", "utf8");
const EMAIL = "storage-probe@fieldarc.test";
const PASSWORD = "probe-" + "z".repeat(16);
const PATH = "probe/hello.txt";
let userId = null;

before(async () => {
  const { data, error } = await db.auth.admin.createUser({
    email: EMAIL, password: PASSWORD, email_confirm: true });
  assert.equal(error, null, error?.message);
  userId = data.user.id;
  await db.from("setters").insert({ id: userId, name: "storage probe" });
});

after(async () => {
  await db.storage.from("recordings").remove([PATH]);
  await db.from("setters").delete().eq("id", userId);
  if (userId) { await db.auth.admin.deleteUser(userId); }
});

test("the bucket exists and is not public", async () => {
  const { data, error } = await db.storage.getBucket("recordings");
  assert.equal(error, null, error?.message);
  assert.equal(data.public, false,
    "a public bucket would serve an unpublished point's recording to anyone with the path");
});

test("a setter can upload", async () => {
  const c = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY,
                         { auth: { persistSession: false } });
  const { error: authErr } = await c.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  assert.equal(authErr, null, authErr?.message);
  const { error } = await c.storage.from("recordings")
    .upload(PATH, new Blob(["hello"]), { upsert: true });
  assert.equal(error, null, error?.message);
});

test("anon cannot list or download", async () => {
  const a = anon();
  const list = await a.storage.from("recordings").list("probe");
  assert.ok(list.error || (list.data ?? []).length === 0, "anon listed the bucket");
  const dl = await a.storage.from("recordings").download(PATH);
  assert.ok(dl.error, "anon downloaded a recording");
});

/* The upload has to happen BEFORE the row is upserted. A feature row that claims audio the
   server does not hold is worse than a queue still draining: the archive would advertise a
   document it cannot produce. */
test("the upload is chained ahead of the feature upsert", () => {
  /* End marker is the click wiring, which is the first thing after publish(). Do NOT use
     $("#publish-btn") — it appears inside renderPending(), which is defined earlier, so the
     slice would run backwards and silently produce an empty string that matches nothing. */
  const pub = html.slice(html.indexOf("function publish()"),
                         html.indexOf('addEventListener("click", publish)'));
  const audioAt = pub.indexOf("var audio =");
  const workAt = pub.indexOf("var work = audio.then");
  assert.ok(audioAt > 0, "the audio pass exists");
  assert.ok(workAt > audioAt, "the upsert waits on the audio chain, not the other way round");
  assert.match(pub, /reduce\(/, "uploads are sequenced, not fired in parallel");
});

test("only features carrying audio are uploaded for", () => {
  /* End marker is the click wiring, which is the first thing after publish(). Do NOT use
     $("#publish-btn") — it appears inside renderPending(), which is defined earlier, so the
     slice would run backwards and silently produce an empty string that matches nothing. */
  const pub = html.slice(html.indexOf("function publish()"),
                         html.indexOf('addEventListener("click", publish)'));
  assert.match(pub, /rows\.filter\(function \(r\) \{ return r\.properties\.has_audio; \}\)/);
});

/* A feature can claim has_audio with no blob behind it: IndexedDB evicted it, site data got
   cleared, or the feature was imported from a GeoJSON export that never carried audio. The
   caller only sets storage_path when uploadAudio resolves with one, so a resolved null used to
   slip such a row through to the upsert with has_audio: true and nothing in the bucket — the
   exact "advertises a document the archive cannot produce" failure the upload-before-upsert
   ordering exists to prevent, arriving through the back door. uploadAudio must reject instead,
   so the reduce chain aborts, publish's .catch runs, and the row stays pending. This can't be
   exercised through the browser publish path from Node, so it asserts on the source: the
   missing-blob branch is a rejection, not a `return null`. */
test("a feature claiming audio with no blob behind it aborts the publish instead of upserting anyway", () => {
  const fnAt = html.indexOf("function uploadAudio(id)");
  assert.ok(fnAt > 0, "uploadAudio exists");
  const fn = html.slice(fnAt, html.indexOf("\n    }\n", fnAt));
  assert.doesNotMatch(fn, /if \(!blob\) \{ return null; \}/,
    "a missing blob must not resolve null — that is how a false has_audio row reached the server");
  assert.match(fn, /if \(!blob\) \{[\s\S]*?Promise\.reject\(/,
    "a missing blob must reject, aborting the audio chain rather than continuing without a path");
});

/* DELETE is deliberately uncovered on storage.objects for this bucket — see 0012's comment.
   Deletes in this project are soft everywhere: a feature is marked deleted_at, never removed,
   and a recording outliving its feature row is the safe direction. This asserts the absence
   holds, so a future "tidy up" that adds a delete policy has to argue with a failing test
   instead of just not noticing this comment. */
test("no delete policy exists for storage.objects on the recordings bucket", async () => {
  const rows = await sql(`
    select policyname from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and cmd = 'DELETE'`);
  assert.deepEqual(rows, [],
    "a DELETE policy would make .remove() actually delete — RLS-denied deletes must stay denied");
});
