/* Fieldscape media Worker: serves recordings and photos from the private R2 bucket with exactly the
   access rules Supabase Storage enforces today (supabase/migrations 0012, 0015, 0016):

   - Setters (a signed-in user for whom public.is_setter() is true) read and write everything.
   - A signed-in user who is not a setter reads nothing (Storage's anon policy is for the anon
     role only; a token that is not a setter's, including an expired one, is refused).
   - Anyone without a token reads a file only when its feature - the first path segment - is in
     public.public_features (published, not deleted) and is not a fuzzed (sensitive) point.
   - Nobody deletes: the project's deletes are soft, and a file outliving its feature is safe.

   The rules stay in Supabase. The Worker asks the same questions Storage's policies ask, with
   the caller's own token or the public anon key, so it holds no secret and cannot grant more
   than Supabase would. Nothing is cached at the edge: unpublishing must revoke access on the very
   next request, as it does today.

   GET  /r/<feature id>/<file>   (Range supported, for seeking)
   PUT  /r/<feature id>/<file>   (setters only; overwrites, like the app's upsert uploads) */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/* The object key, or null for anything that isn't <uuid>/<path> without traversal. */
export function keyOf(pathname) {
  if (!pathname.startsWith("/r/")) { return null; }
  const key = decodeURIComponent(pathname.slice(3));
  const parts = key.split("/");
  if (parts.length < 2 || !UUID.test(parts[0]) || parts.some((p) => !p || p === "." || p === "..")) { return null; }
  return key;
}

async function supa(env, fetcher, path, token, init = {}) {
  return fetcher(env.SUPABASE_URL + path, {
    ...init,
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: "Bearer " + (token || env.SUPABASE_ANON_KEY),
               "Content-Type": "application/json", ...(init.headers || {}) }
  });
}

/* is_setter() asked with the caller's own token: an expired or forged token is simply not a setter. */
export async function isSetter(env, token, fetcher = fetch) {
  if (!token) { return false; }
  const r = await supa(env, fetcher, "/rest/v1/rpc/is_setter", token, { method: "POST", body: "{}" });
  return r.ok && (await r.json()) === true;
}

/* The anon policy's predicate, asked of the same view it reads. */
export async function publiclyReadable(env, featureId, fetcher = fetch) {
  const r = await supa(env, fetcher, "/rest/v1/public_features?select=properties&id=eq." + featureId, null);
  if (!r.ok) { return false; }
  const rows = await r.json();
  return rows.length === 1 && !(rows[0].properties && rows[0].properties.fuzzed === true);
}

function cors(env, h = new Headers()) {
  h.set("Access-Control-Allow-Origin", env.ALLOW_ORIGIN || "*");
  h.set("Access-Control-Allow-Headers", "Authorization, Range, Content-Type");
  h.set("Access-Control-Allow-Methods", "GET, HEAD, PUT, OPTIONS");
  h.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, ETag");
  return h;
}
const deny = (env, status, msg) => new Response(msg, { status, headers: cors(env) });

export async function handle(request, env, fetcher = fetch) {
  if (request.method === "OPTIONS") { return new Response(null, { status: 204, headers: cors(env) }); }
  const key = keyOf(new URL(request.url).pathname);
  if (!key) { return deny(env, 404, "not found"); }
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;

  if (request.method === "PUT") {
    if (!(await isSetter(env, token, fetcher))) { return deny(env, 403, "setters only"); }
    await env.MEDIA.put(key, request.body, { httpMetadata: { contentType: request.headers.get("Content-Type") || "application/octet-stream" } });
    return new Response(null, { status: 201, headers: cors(env) });
  }
  if (request.method !== "GET" && request.method !== "HEAD") { return deny(env, 405, "method not allowed"); }

  const allowed = token ? await isSetter(env, token, fetcher) : await publiclyReadable(env, key.split("/")[0], fetcher);
  if (!allowed) { return deny(env, 403, "not readable"); }

  const obj = await env.MEDIA.get(key, { range: request.headers, onlyIf: request.headers });
  if (!obj) { return deny(env, 404, "not found"); }
  const h = cors(env);
  obj.writeHttpMetadata(h);
  h.set("ETag", obj.httpEtag);
  h.set("Accept-Ranges", "bytes");
  h.set("Cache-Control", "private, no-store");   /* access can be revoked at any time */
  if (!("body" in obj)) { return new Response(null, { status: 304, headers: h }); }
  let status = 200;
  if (obj.range && request.headers.has("Range")) {
    const off = obj.range.offset || 0, len = obj.range.length ?? obj.size - off;
    h.set("Content-Range", `bytes ${off}-${off + len - 1}/${obj.size}`);
    h.set("Content-Length", String(len));
    status = 206;
  } else {
    h.set("Content-Length", String(obj.size));
  }
  return new Response(request.method === "HEAD" ? null : obj.body, { status, headers: h });
}

export default { fetch: (request, env) => handle(request, env) };
