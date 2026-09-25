/* The media Worker's access rules against a simulated Supabase and bucket: every rule in
   worker/src/index.js's header, including the sensitive-point rule no live row can exercise
   (no sensitive point has audio today). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle, keyOf } from "../worker/src/index.js";

const PUB = "11111111-1111-4111-8111-111111111111";      /* published */
const HID = "22222222-2222-4222-8222-222222222222";      /* published, sensitive point (fuzzed) */
const DRAFT = "33333333-3333-4333-8333-333333333333";    /* unpublished or deleted: not in the view */
const SETTER = "setter-token", OTHER = "listener-token";

const env = {
  SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "anon",
  MEDIA: (() => {
    const store = new Map();
    return {
      store,
      async put(key, body, opts) { store.set(key, { bytes: new Uint8Array(await new Response(body).arrayBuffer()), type: opts.httpMetadata.contentType }); },
      async get(key, { range }) {
        const o = store.get(key);
        if (!o) { return null; }
        const m = /bytes=(\d+)-(\d*)/.exec(range.get("Range") || "");
        const off = m ? +m[1] : 0, end = m && m[2] ? +m[2] + 1 : o.bytes.length;
        return { size: o.bytes.length, httpEtag: '"e"', range: m ? { offset: off, length: end - off } : undefined,
                 body: o.bytes.slice(off, end), writeHttpMetadata: (h) => h.set("Content-Type", o.type) };
      }
    };
  })()
};

/* Supabase as the Worker sees it: is_setter() by token, public_features by id. */
const calls = [];
async function supabase(url, init) {
  calls.push(url);
  const tok = init.headers.Authorization.slice(7);
  if (url.endsWith("/rest/v1/rpc/is_setter")) {
    if (tok === SETTER) { return Response.json(true); }
    if (tok === OTHER) { return Response.json(false); }
    return new Response("JWT expired", { status: 401 });
  }
  const id = /id=eq\.([0-9a-f-]+)/.exec(url)[1];
  const rows = { [PUB]: [{ properties: {} }], [HID]: [{ properties: { fuzzed: true } }] }[id] || [];
  return Response.json(rows);
}

const req = (method, path, token, extra = {}) => new Request("https://m.example/r/" + path,
  { method, headers: { ...(token ? { Authorization: "Bearer " + token } : {}), ...extra.headers }, body: extra.body });
const run = (...a) => handle(req(...a), env, supabase);

for (const id of [PUB, HID, DRAFT]) { env.MEDIA.store.set(id + "/take.webm", { bytes: new TextEncoder().encode("0123456789"), type: "audio/webm" }); }

test("anon reads a published file, and only that", async () => {
  const r = await run("GET", PUB + "/take.webm");
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "0123456789");
  assert.equal(r.headers.get("Cache-Control"), "private, no-store");
  assert.equal((await run("GET", DRAFT + "/take.webm")).status, 403, "unpublished or deleted");
  assert.equal((await run("GET", HID + "/take.webm")).status, 403, "sensitive point");
});

test("setters read everything, including drafts and sensitive points", async () => {
  for (const id of [PUB, HID, DRAFT]) { assert.equal((await run("GET", id + "/take.webm", SETTER)).status, 200); }
});

test("a signed-in non-setter or a stale token reads nothing, as in Storage today", async () => {
  assert.equal((await run("GET", PUB + "/take.webm", OTHER)).status, 403);
  assert.equal((await run("GET", PUB + "/take.webm", "expired")).status, 403);
});

test("only setters write; nobody deletes", async () => {
  assert.equal((await run("PUT", DRAFT + "/new.webm", null, { body: "x" })).status, 403);
  assert.equal((await run("PUT", DRAFT + "/new.webm", OTHER, { body: "x" })).status, 403);
  assert.equal(env.MEDIA.store.has(DRAFT + "/new.webm"), false);
  const w = await run("PUT", DRAFT + "/new.webm", SETTER, { body: "abc", headers: { "Content-Type": "audio/wav" } });
  assert.equal(w.status, 201);
  assert.equal(env.MEDIA.store.get(DRAFT + "/new.webm").type, "audio/wav");
  assert.equal((await run("DELETE", PUB + "/take.webm", SETTER)).status, 405);
  assert.equal(env.MEDIA.store.has(PUB + "/take.webm"), true);
});

test("range requests seek", async () => {
  const r = await run("GET", PUB + "/take.webm", null, { headers: { Range: "bytes=2-5" } });
  assert.equal(r.status, 206);
  assert.equal(await r.text(), "2345");
  assert.equal(r.headers.get("Content-Range"), "bytes 2-5/10");
});

test("paths outside <feature uuid>/<file> are refused before Supabase is asked", async () => {
  for (const p of ["/r/../x", "/r/" + PUB, "/r/" + PUB + "/../" + DRAFT + "/take.webm", "/r/not-a-uuid/take.webm", "/x/" + PUB + "/t"]) {
    assert.equal(keyOf(p), null, p);
  }
  const before = calls.length;
  assert.equal((await handle(new Request("https://m.example/r/%2e%2e/take.webm"), env, supabase)).status, 404);
  assert.equal(calls.length, before);
});
