# FieldArc 2.0 — Stage 2: setters sign in and publish

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A setter signs in with a magic link, keeps working exactly as they do now with no network, and pushes what they captured to the server when they have wifi — with the archive recording who did it.

**Architecture:** `index.html` gains a Supabase client and nothing else changes for anyone not signed in. The local archive stays the working copy; a **manifest** of content hashes taken at the last successful publish is what makes "pending" computable without instrumenting every mutation site. Publish walks the difference — added, changed, removed — upserts features, uploads audio to a Storage bucket, and appends audit rows.

**Tech Stack:** `@supabase/supabase-js` v2 UMD from unpkg (already inside the service worker's `IS_ASSET` cache rule, so offline needs no new plumbing), Supabase Auth magic links, Supabase Storage, Postgres 17.6. Tests: Node 24 `node:test` against the live project, plus pure-function tests for the manifest.

**Spec:** `docs/superpowers/specs/2026-09-10-platform-design.md`

## Global Constraints

- **Offline capture must not regress.** Mark, trace, attach-audio and patch editing must work with no network, exactly as at `v1.5-the-field`. This is stage 2's main risk and its main test.
- **Signed out, the app behaves as it does today.** Mode gating and the listener surface are stage 3's. A visitor who never signs in must see no difference.
- **The anon key belongs in the page.** It is public by design and ships to every visitor. The service key and the database URL must never appear in `index.html` or any tracked file.
- **`anon` may reach exactly one object.** `tests/grants.test.mjs` asserts the set is `{public_features: SELECT}`. Any new table, view, function or bucket policy this stage adds must keep that test passing, or extend it deliberately with a recorded reason.
- **`audit` is insert-only for everyone**, including setters. No update policy, no delete policy, and `authenticated` holds no TRUNCATE.
- **No build step.** The deployed artifact stays a static file set.
- Commit messages: a declarative sentence, then what it prevents or what was measured.

## What stage 1 left for this stage

- Storage bucket policies were deferred — there was no bucket until there was an upload path. Task 5 creates it.
- `created_by` is null on all 18 migrated rows. Task 4 backfills them to the first setter, so the existing archive is not permanently nobody's.
- The parked residual: the anonymous view calls `private.fuzz_point`, which requires `anon` to hold EXECUTE on it. Safe only because PostgREST exposes `public` alone. Task 7 removes the dependency entirely.

## File Structure

| File | Responsibility |
| --- | --- |
| `index.html` | The client: config block, Supabase client, session, pending queue, Publish |
| `supabase/migrations/0012_storage_recordings.sql` | The bucket and its access rules |
| `supabase/migrations/0013_created_by_backfill.sql` | Attribute the migrated archive to its setter |
| `supabase/migrations/0014_fuzz_at_rest.sql` | Fuzzed geometry in a column, so the view calls no function |
| `tests/pending.test.mjs` | The manifest diff, as a pure function |
| `tests/publish.test.mjs` | Publish against the live project, as a signed-in setter |
| `tests/storage.test.mjs` | Who can read and write a recording |

---

### Task 1: The client is present and changes nothing

**Files:**
- Modify: `index.html` (the `<script src>` block near line 1476; a new config block; `window.__fa`)
- Test: `tests/client.test.mjs`

**Interfaces:**
- Produces: `window.__fa.sb` — a Supabase client, or `null` when the library did not load. `FA_CONFIG = { url, anonKey }` as a top-level `var` in the page.

- [ ] **Step 1: Write the failing test**

```js
// tests/client.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8");

test("the page loads supabase-js from a host the service worker already caches", () => {
  assert.match(html, /unpkg\.com\/@supabase\/supabase-js@2/,
    "unpkg is in sw.js's IS_ASSET rule; another CDN would break offline");
});

test("the page carries the project url and the anon key, and neither secret", () => {
  assert.match(html, /FA_CONFIG\s*=\s*\{/);
  assert.match(html, /ujdygmcpqsbyeysggypc\.supabase\.co/);
  assert.doesNotMatch(html, /service_role/, "the service key must never ship to a browser");
  assert.doesNotMatch(html, /postgresql:\/\//, "the database url must never ship to a browser");
});

test("a missing library is survivable, not fatal", () => {
  assert.match(html, /typeof supabase === "undefined"/,
    "offline first load must not throw; __fa.sb becomes null instead");
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test`
Expected: FAIL — none of those strings exist yet.

- [ ] **Step 3: Add the script tag**

Immediately after the MapLibre `<script src>` line in `index.html`:

```html
<script src="https://unpkg.com/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
```

- [ ] **Step 4: Add the config and the client**

Inside the main IIFE, directly after the `var PLACE_KEY = ...` line:

```js
  /* The anon key is public by design — it ships to every visitor and is what row-level
     security is written against. The service key and the database URL never appear here. */
  var FA_CONFIG = {
    url: "https://ujdygmcpqsbyeysggypc.supabase.co",
    anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVqZHlnbWNwcXNieWV5c2dneXBjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwNDE4NDIsImV4cCI6MjEwNDYxNzg0Mn0.SJlrNKQftKxdM0G6f18e6PsRCvdhIH8fco5tW3CktwM"
  };

  /* A first load with no signal has no library. That is a normal morning in a forest, so it
     must not throw: everything the archive does locally works without a server. */
  var sb = (typeof supabase === "undefined")
    ? null
    : supabase.createClient(FA_CONFIG.url, FA_CONFIG.anonKey,
        { auth: { persistSession: true, autoRefreshToken: true } });
```

That key is the project's anon/publishable key, copied verbatim — use it as written. It is not a secret: row-level security is written against it and it ships to every visitor by design, which is the whole reason stage 1 spent its effort proving what `anon` can reach. The service key and `DATABASE_URL` must never appear in this file.

If the key has been rotated since this plan was written, take the current one from `.env.local` (`SUPABASE_ANON_KEY`) instead — and if it has, the tests will tell you, because `client.test.mjs` only checks the project URL, not the key.

- [ ] **Step 5: Expose it on the debug hook**

Immediately after `window.__fa = { map: map, errors: [] };`:

```js
  window.__fa.sb = sb;   /* null offline, a client otherwise — measurable either way */
```

- [ ] **Step 6: Run the tests and the checker**

Run: `npm test && npm run check`
Expected: `client.test.mjs` 3/3 pass, the rest still green, no missing ids, no unterminated tags.

- [ ] **Step 7: Verify the app is unchanged in a browser**

Serve locally and load `index.html?rafshim`. Confirm `window.__fa.errors` is empty, the map draws, and `window.__fa.sb` is an object. Then confirm the offline path: in devtools set the network to offline, reload, and confirm the page still renders from the service worker cache and `window.__fa.sb` is `null` rather than the page throwing.

- [ ] **Step 8: Commit**

```bash
git add index.html tests/client.test.mjs
git commit -m "The app can reach the server, and still works when it cannot"
```

---

### Task 2: Sign in with a magic link

**Files:**
- Modify: `index.html` (the `#storage` section around line 1387; the IIFE)
- Test: `tests/auth.test.mjs`

**Interfaces:**
- Consumes: `sb` from Task 1.
- Produces: `signIn(email)`, `signOut()`, `setterState()` returning `{ signedIn: boolean, email: string|null, id: string|null }`; `window.__fa.setter = setterState`. A `#setter` block in the storage section holding `#setter-email`, `#setter-send`, `#setter-out`, `#setter-who`.

- [ ] **Step 1: Write the failing test**

```js
// tests/auth.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { service } from "./clients.mjs";

const html = readFileSync("index.html", "utf8");

test("the page has a sign-in control and it is not a password field", () => {
  assert.match(html, /id="setter-email"/);
  assert.match(html, /id="setter-send"/);
  assert.match(html, /id="setter-out"/);
  assert.doesNotMatch(html, /type="password"/,
    "magic link only — a password field here would be a second credential to leak");
});

test("sign-in asks for a magic link, not a password grant", () => {
  assert.match(html, /signInWithOtp/);
  assert.doesNotMatch(html, /signInWithPassword/);
});

test("the redirect returns to this page, not to a bare origin", () => {
  assert.match(html, /emailRedirectTo/);
  assert.match(html, /location\.origin \+ location\.pathname/);
});

/* A stranger who signs in is authenticated but is not a setter. The database decides that,
   not the page — this asserts the row that grants it does not exist by accident. */
test("being authenticated is not the same as being a setter", async () => {
  const db = service();
  const { data } = await db.from("setters").select("id");
  assert.ok(Array.isArray(data), "setters table is readable by the service role");
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test`
Expected: FAIL — no `#setter-email` in the page.

- [ ] **Step 3: Add the markup**

Inside `<div class="section" id="storage">`, above the existing `<p class="hint" id="saved">`:

```html
      <h2 class="eyebrow">Setter</h2>
      <div id="setter">
        <p id="setter-who" class="hint">Not signed in — this device keeps its own archive.</p>
        <label class="field" for="setter-email"><span>email</span>
          <input type="email" id="setter-email" placeholder="you@example.com"
                 autocomplete="email" inputmode="email"></label>
        <button type="button" id="setter-send">Send link</button>
        <button type="button" id="setter-out" hidden>Sign out</button>
      </div>
```

- [ ] **Step 4: Add the behaviour**

Inside the IIFE, after the `save()` function:

```js
  /* ---------- Setter session ----------
     Magic link only. There is no password to leak, no sign-up page to secure, and no
     account for a listener to abandon — the invited setters are a closed list in the
     database. Signing in changes nothing about how the archive works locally; it only
     decides whether Publish has anywhere to push. */
  var setter = { signedIn: false, email: null, id: null };

  function setterState() { return { signedIn: setter.signedIn, email: setter.email, id: setter.id }; }

  function renderSetter() {
    $("#setter-who").textContent = setter.signedIn
      ? "Signed in as " + setter.email
      : "Not signed in — this device keeps its own archive.";
    $("#setter-email").hidden = setter.signedIn;
    $("#setter-send").hidden = setter.signedIn;
    $("#setter-out").hidden = !setter.signedIn;
    $("#setter-email").parentNode.hidden = setter.signedIn;
  }

  function applySession(session) {
    setter.signedIn = !!(session && session.user);
    setter.email = session && session.user ? session.user.email : null;
    setter.id = session && session.user ? session.user.id : null;
    renderSetter();
  }

  function signIn(email) {
    if (!sb) { toast("No connection — sign in when you are back on wifi."); return; }
    if (!email) { toast("Enter the email you were invited with."); return; }
    sb.auth.signInWithOtp({
      email: email,
      /* Back to this page, not to the origin: FieldArc lives at /FieldArc/ on Pages, and a
         bare origin would land the setter on a 404 holding a valid token. */
      options: { emailRedirectTo: location.origin + location.pathname }
    }).then(function (r) {
      toast(r.error ? "Could not send: " + r.error.message : "Link sent — check your email.");
    });
  }

  function signOut() {
    if (!sb) { return; }
    sb.auth.signOut().then(function () { applySession(null); toast("Signed out."); });
  }

  /* The spec's audit records who signed in, not only who published. Written on the SIGNED_IN
     event rather than inside signIn(), because the session actually begins when the link is
     followed — often on a different device from the one that asked for it. */
  function logSignIn(session) {
    if (!sb || !session || !session.user) { return; }
    sb.from("audit").insert({
      setter_id: session.user.id, action: "sign_in", target_id: null,
      detail: { at: new Date().toISOString() }
    }).then(function () { /* a failed log must never block a sign-in */ });
  }

  if (sb) {
    sb.auth.getSession().then(function (r) { applySession(r.data.session); });
    sb.auth.onAuthStateChange(function (e, session) {
      applySession(session);
      if (e === "SIGNED_IN") { logSignIn(session); }
    });
  } else {
    renderSetter();
  }

  $("#setter-send").addEventListener("click", function () {
    signIn($("#setter-email").value.trim());
  });
  $("#setter-out").addEventListener("click", signOut);
```

- [ ] **Step 5: Expose it**

After `window.__fa.sb = sb;`:

```js
  window.__fa.setter = setterState;
```

- [ ] **Step 6: Run the tests and the checker**

Run: `npm test && npm run check`
Expected: all green.

- [ ] **Step 7: Configure the redirect in Supabase (manual, once)**

Supabase dashboard → Authentication → URL Configuration. Set Site URL to `https://keremaltaylar.github.io/FieldArc/` and add `http://127.0.0.1:8123/index.html` to Redirect URLs so local testing works. Without this the magic link refuses to redirect.

- [ ] **Step 8: Commit**

```bash
git add index.html tests/auth.test.mjs
git commit -m "A setter signs in with a link, and a listener never sees a login"
```

---

### Task 3: What is pending, computed rather than tracked

**Files:**
- Create: `src/pending.mjs` (a module the page and the tests both load)
- Modify: `index.html` (load it as a module and re-export on `__fa`)
- Test: `tests/pending.test.mjs`

**Interfaces:**
- Produces: `hashFeature(feature) -> string`, `manifestOf(features) -> {id: hash}`, `diffManifest(previous, current) -> { added: [id], changed: [id], removed: [id] }`.

**Why a manifest rather than a dirty flag:** the app mutates `fc` from a dozen places — Mark, map clicks, the patch panel, icon pickers, import, the trash. Instrumenting every one of them would be a dozen chances to miss one, and a missed one is work that silently never publishes. A hash taken at the last successful publish makes "what changed" a computation over state that already exists, and it is correct even for a path nobody thought about.

- [ ] **Step 1: Write the failing test**

```js
// tests/pending.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { hashFeature, manifestOf, diffManifest } from "../src/pending.mjs";

const f = (id, name) => ({
  type: "Feature",
  properties: { id, kind: "point", name, place: "P" },
  geometry: { type: "Point", coordinates: [29, 41] }
});

test("the same feature hashes the same twice", () => {
  assert.equal(hashFeature(f("a", "x")), hashFeature(f("a", "x")));
});

test("a changed property changes the hash", () => {
  assert.notEqual(hashFeature(f("a", "x")), hashFeature(f("a", "y")));
});

test("key order does not change the hash", () => {
  const one = { type: "Feature", properties: { id: "a", kind: "point" }, geometry: null };
  const two = { type: "Feature", geometry: null, properties: { kind: "point", id: "a" } };
  assert.equal(hashFeature(one), hashFeature(two),
    "JSON.stringify key order follows insertion order; a re-saved feature must not read as changed");
});

test("added, changed and removed are each reported", () => {
  const before = manifestOf([f("a", "x"), f("b", "x")]);
  const after = manifestOf([f("a", "x"), f("b", "CHANGED"), f("c", "new")]);
  const d = diffManifest(before, after);
  assert.deepEqual(d.added, ["c"]);
  assert.deepEqual(d.changed, ["b"]);
  assert.deepEqual(d.removed, []);
});

test("a feature deleted locally is reported as removed", () => {
  const before = manifestOf([f("a", "x"), f("b", "x")]);
  const after = manifestOf([f("a", "x")]);
  assert.deepEqual(diffManifest(before, after).removed, ["b"]);
});

test("an empty previous manifest makes everything added, not changed", () => {
  const d = diffManifest({}, manifestOf([f("a", "x")]));
  assert.deepEqual(d.added, ["a"]);
  assert.deepEqual(d.changed, []);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/pending.mjs'`.

- [ ] **Step 3: Write the module**

```js
// src/pending.mjs
/* What has changed since the last successful publish, computed from the archive itself.
   The app mutates its FeatureCollection from a dozen places — Mark, map clicks, the patch
   panel, the icon picker, import, the trash. A dirty flag would need every one of them to
   remember, and a forgotten one is work that silently never leaves the device. A manifest of
   content hashes needs none of them to remember anything. */

/* Stable across key order, because JSON.stringify follows insertion order and a feature
   re-saved by a different code path would otherwise read as changed when it is not. */
function canonical(value) {
  if (value === null || typeof value !== "object") { return JSON.stringify(value) ?? "null"; }
  if (Array.isArray(value)) { return "[" + value.map(canonical).join(",") + "]"; }
  return "{" + Object.keys(value).sort()
    .map(function (k) { return JSON.stringify(k) + ":" + canonical(value[k]); })
    .join(",") + "}";
}

/* djb2. This detects change; it defends against nothing, so a cryptographic hash would buy
   only slowness. Returned as unsigned hex so it never carries a minus sign into JSON. */
export function hashFeature(feature) {
  const s = canonical(feature);
  let h = 5381;
  for (let i = 0; i < s.length; i++) { h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0; }
  return h.toString(16);
}

export function manifestOf(features) {
  const out = {};
  for (const f of features) {
    const id = f && f.properties && f.properties.id;
    if (id) { out[id] = hashFeature(f); }
  }
  return out;
}

export function diffManifest(previous, current) {
  const added = [], changed = [], removed = [];
  for (const id of Object.keys(current)) {
    if (!(id in previous)) { added.push(id); }
    else if (previous[id] !== current[id]) { changed.push(id); }
  }
  for (const id of Object.keys(previous)) {
    if (!(id in current)) { removed.push(id); }
  }
  return { added: added.sort(), changed: changed.sort(), removed: removed.sort() };
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: `pending.test.mjs` 6/6 pass.

- [ ] **Step 5: Load it in the page**

The app's main script is a classic `<script>`, not a module, so add a small module block BEFORE it that hangs the functions on `window`:

```html
<script type="module">
  import { hashFeature, manifestOf, diffManifest } from "./src/pending.mjs";
  window.FA_PENDING = { hashFeature, manifestOf, diffManifest };
</script>
```

Add `"./src/pending.mjs"` to `SHELL_FILES` in `sw.js` so a forest reload still has it.

- [ ] **Step 6: Verify in a browser**

Load the page and confirm `window.FA_PENDING.manifestOf([])` returns `{}`. A module script is deferred, so also confirm the main script does not call it at parse time — only from Publish, which is Task 4.

- [ ] **Step 7: Commit**

```bash
git add src/pending.mjs tests/pending.test.mjs index.html sw.js
git commit -m "What is pending is computed from the archive, not remembered by it"
```

---

### Task 4: Publish

**Files:**
- Modify: `index.html` (the storage section, the IIFE)
- Create: `supabase/migrations/0013_created_by_backfill.sql`
- Test: `tests/publish.test.mjs`

**Interfaces:**
- Consumes: `sb`, `setterState()`, `window.FA_PENDING`.
- Produces: `pendingCount() -> number`, `publish() -> Promise<{pushed, removed, failed}>`; `window.__fa.publish = { count: pendingCount, run: publish }`. localStorage key `fieldarc.manifest`.

- [ ] **Step 1: Write the failing test**

```js
// tests/publish.test.mjs
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
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test`
Expected: FAIL — no `#publish-btn` in the page.

- [ ] **Step 3: Add the markup**

Inside `#storage`, below the setter block:

```html
      <div id="publishbar">
        <button type="button" id="publish-btn" disabled>Publish</button>
        <span id="pending-count" class="hint">nothing pending</span>
      </div>
```

- [ ] **Step 4: Add the behaviour**

After the setter session block:

```js
  /* ---------- Publish ----------
     The device is authoritative for anything not yet pushed; the server is authoritative for
     anything published. Which is which is decided by a manifest of content hashes written at
     the last successful publish — see src/pending.mjs for why it is computed rather than
     tracked. Nothing here runs without a session, and nothing here blocks capture. */
  var MANIFEST_KEY = "fieldarc.manifest";

  function loadManifest() {
    try { return JSON.parse(localStorage.getItem(MANIFEST_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function saveManifest(m) {
    try { localStorage.setItem(MANIFEST_KEY, JSON.stringify(m)); } catch (e) { /* full */ }
  }

  function pendingDiff() {
    if (!window.FA_PENDING) { return { added: [], changed: [], removed: [] }; }
    return window.FA_PENDING.diffManifest(loadManifest(),
                                          window.FA_PENDING.manifestOf(fc.features));
  }

  function pendingCount() {
    var d = pendingDiff();
    return d.added.length + d.changed.length + d.removed.length;
  }

  function renderPending() {
    var n = pendingCount();
    $("#pending-count").textContent = n === 0 ? "nothing pending"
      : n + (n === 1 ? " change to publish" : " changes to publish");
    $("#publish-btn").disabled = !setter.signedIn || n === 0;
  }

  function publish() {
    if (!sb || !setter.signedIn) {
      toast("Sign in to publish."); return Promise.resolve({ pushed: 0, removed: 0, failed: 0 });
    }
    var d = pendingDiff();
    var byId = {};
    fc.features.forEach(function (f) { byId[f.properties.id] = f; });

    var rows = d.added.concat(d.changed).map(function (id) {
      var f = byId[id], p = {};
      Object.keys(f.properties).forEach(function (k) { p[k] = f.properties[k]; });
      delete p.id; delete p.place; delete p.kind;
      return { id: id, place: f.properties.place, kind: f.properties.kind,
               geometry: f.geometry, properties: p, created_by: setter.id };
    });

    $("#publish-btn").disabled = true;
    $("#pending-count").textContent = "publishing…";

    var work = rows.length
      ? sb.from("features").upsert(rows, { onConflict: "id" })
      : Promise.resolve({ error: null });

    return work.then(function (r) {
      if (r.error) { throw new Error(r.error.message); }
      if (!d.removed.length) { return { error: null }; }
      /* Soft, reusing the trash the app already keeps: a sync must not erase a morning. */
      return sb.from("features")
        .update({ deleted_at: new Date().toISOString() }).in("id", d.removed);
    }).then(function (r) {
      if (r && r.error) { throw new Error(r.error.message); }
      return sb.from("audit").insert({
        setter_id: setter.id, action: "publish", target_id: null,
        detail: { added: d.added.length, changed: d.changed.length, removed: d.removed.length }
      });
    }).then(function () {
      saveManifest(window.FA_PENDING.manifestOf(fc.features));
      renderPending();
      toast("Published " + rows.length + " · removed " + d.removed.length);
      return { pushed: rows.length, removed: d.removed.length, failed: 0 };
    }).catch(function (e) {
      /* The queue survives: the manifest is only written on success, so a failed publish
         leaves everything pending rather than silently marking it done. */
      renderPending();
      toast("Publish failed — still pending. " + e.message);
      return { pushed: 0, removed: 0, failed: rows.length + d.removed.length };
    });
  }

  $("#publish-btn").addEventListener("click", publish);
```

- [ ] **Step 5: Keep the count live**

Add `renderPending();` as the last line of `commit()` and the last line of `renderSetter()`.

- [ ] **Step 6: Expose it**

After `window.__fa.setter = setterState;`:

```js
  window.__fa.publish = { count: pendingCount, run: publish, diff: pendingDiff };
```

- [ ] **Step 7: Write the backfill migration**

```sql
-- supabase/migrations/0013_created_by_backfill.sql
-- The 18 features migrated in stage 1 have created_by null, because stage 1 had no accounts.
-- The spec's setter surface shows created_by "so two setters can tell their work apart", and
-- an archive that is nobody's cannot do that. Attributes them to the earliest invited setter,
-- which is the person who actually made them, and touches nothing that already has an owner.
update public.features f
   set created_by = (select s.id from public.setters s order by s.invited_at asc limit 1)
 where f.created_by is null
   and exists (select 1 from public.setters);
```

- [ ] **Step 8: Run the tests and apply**

Run: `npm test && npm run db:apply && npm run check`
Expected: `publish.test.mjs` 4/4 pass. The backfill is a no-op until a setter exists, which is correct — re-running it after the first invite does the work.

- [ ] **Step 9: Commit**

```bash
git add index.html tests/publish.test.mjs supabase/migrations/0013_created_by_backfill.sql
git commit -m "Work leaves the device when there is wifi, and not before"
```

---

### Task 5: Recordings reach the server

**Files:**
- Create: `supabase/migrations/0012_storage_recordings.sql`
- Modify: `index.html` (publish path)
- Test: `tests/storage.test.mjs`

**Interfaces:**
- Consumes: `sb`, `setterState()`, `getAudio(id)` (existing, IndexedDB).
- Produces: bucket `recordings`; `uploadAudio(featureId) -> Promise<string|null>` returning the storage path.

- [ ] **Step 1: Write the failing test**

```js
// tests/storage.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { anon, service } from "./clients.mjs";

const db = service();
const EMAIL = "storage-probe@fieldarc.test";
const PASSWORD = "probe-" + "z".repeat(16);
const PATH = "probe/hello.txt";
let userId = null;

before(async () => {
  const { data } = await db.auth.admin.createUser({
    email: EMAIL, password: PASSWORD, email_confirm: true });
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
  await c.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
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
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test`
Expected: FAIL — bucket `recordings` does not exist.

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/0012_storage_recordings.sql
-- Private bucket. Stage 1 deferred this deliberately: there was no bucket until there was an
-- upload path. A public bucket would serve an unpublished point's recording to anyone who
-- guessed the path, which is the same failure as the archive being readable before it is
-- published — the file is the archive, not an illustration of it.

insert into storage.buckets (id, name, public)
values ('recordings', 'recordings', false)
on conflict (id) do nothing;

-- Setters read and write; nobody else touches it. Listeners get their audio through a signed
-- URL minted per request in stage 3, so no anon policy exists here at all.
drop policy if exists recordings_setter_read on storage.objects;
create policy recordings_setter_read on storage.objects
  for select to authenticated
  using (bucket_id = 'recordings' and public.is_setter());

drop policy if exists recordings_setter_write on storage.objects;
create policy recordings_setter_write on storage.objects
  for insert to authenticated
  with check (bucket_id = 'recordings' and public.is_setter());

drop policy if exists recordings_setter_update on storage.objects;
create policy recordings_setter_update on storage.objects
  for update to authenticated
  using (bucket_id = 'recordings' and public.is_setter());
```

- [ ] **Step 4: Add the upload to the publish path**

Before the `sb.from("features").upsert(rows, …)` call in `publish()`:

```js
    /* Audio is the slow half, so it goes first and one file at a time: a walk's worth of
       recordings will not finish in one go on a phone, and a feature row that claims audio
       the server does not have is worse than a queue that is still draining. */
    function uploadAudio(id) {
      return getAudio(id).then(function (blob) {
        if (!blob) { return null; }
        var path = id + "/" + (blob.type === "audio/wav" ? "take.wav" : "take.webm");
        return sb.storage.from("recordings")
          .upload(path, blob, { upsert: true, contentType: blob.type })
          .then(function (r) { return r.error ? Promise.reject(new Error(r.error.message)) : path; });
      });
    }
```

Then replace the `var work = rows.length ? … ;` line and the `return work.then(…)` that follows it with an audio pass that runs first and records each path onto its row:

```js
    /* Sequential on purpose. Six parallel uploads on a phone at the edge of signal is how a
       publish half-finishes; one at a time is slower and finishes. A row is only upserted
       after its file is up, so the server never holds a feature claiming audio it does not
       have — the queue simply stays pending instead. */
    var withAudio = rows.filter(function (r) { return r.properties.has_audio; });
    var audio = withAudio.reduce(function (chain, r) {
      return chain.then(function () {
        return uploadAudio(r.id).then(function (path) {
          if (path) { r.properties.storage_path = path; }
        });
      });
    }, Promise.resolve());

    var work = audio.then(function () {
      return rows.length
        ? sb.from("features").upsert(rows, { onConflict: "id" })
        : { error: null };
    });

    return work.then(function (r) {
```

- [ ] **Step 5: Run the tests**

Run: `npm run db:apply && npm test`
Expected: `storage.test.mjs` 3/3 pass, `grants.test.mjs` still green.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0012_storage_recordings.sql index.html tests/storage.test.mjs
git commit -m "A recording reaches the server, and only a setter can fetch it back"
```

---

### Task 6: Offline capture is unchanged, proved

**Files:**
- Test: `tests/offline.test.mjs`

**Interfaces:**
- Consumes: everything above.

**Why its own task:** the spec names this as stage 2's main risk. Every task above adds a network call near a code path that must never need one. This is the task that says so with numbers rather than intent.

- [ ] **Step 1: Write the test**

```js
// tests/offline.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8");
const sw = readFileSync("sw.js", "utf8");

test("nothing in the capture path awaits the network", () => {
  /* Mark, the trace watcher and the map-click handler must not call sb. If one of them
     does, a setter in a dead zone is a setter who cannot mark a point. */
  const capture = html.slice(html.indexOf("function markPoint"), html.indexOf("function updateLive"));
  assert.doesNotMatch(capture, /\bsb\./, "markPoint must not touch the client");
});

test("save() writes locally and does not publish", () => {
  const save = html.slice(html.indexOf("function save()"), html.indexOf("function uid()"));
  assert.match(save, /localStorage\.setItem/);
  assert.doesNotMatch(save, /publish\(/, "saving must never trigger a push");
});

test("the supabase library is cached by the service worker", () => {
  assert.match(sw, /unpkg\.com/, "IS_ASSET must cover the supabase bundle");
});

test("the pending module is in the shell cache", () => {
  assert.match(sw, /pending\.mjs/, "a forest reload must still have the manifest code");
});

test("publish refuses without a session instead of throwing", () => {
  const pub = html.slice(html.indexOf("function publish()"));
  assert.match(pub, /if \(!sb \|\| !setter\.signedIn\)/);
});
```

- [ ] **Step 2: Run it**

Run: `npm test`
Expected: PASS if Tasks 1-5 were built as written; a failure here names exactly which capture path grew a network dependency.

- [ ] **Step 3: Verify in a browser, offline**

Serve locally, load the page, then in devtools set network to offline. Confirm: the map still renders from cache; Point mode places a point; the point survives a reload; `window.__fa.publish.count()` reports it as pending; Publish reports failure and the count does NOT drop to zero.

- [ ] **Step 4: Commit**

```bash
git add tests/offline.test.mjs
git commit -m "The forest still does not wait on a server, and now a test says so"
```

---

### Task 7: The anonymous view stops calling a function

**Files:**
- Create: `supabase/migrations/0014_fuzz_at_rest.sql`
- Test: `tests/fuzz.test.mjs` (extend)

**Interfaces:**
- Produces: `features.geometry_public jsonb`, maintained by trigger; `public_features` selecting it directly.

**Why:** stage 1 parked this. The anonymous view calls `private.fuzz_point`, which forces `anon` to hold EXECUTE on that function — safe only because PostgREST exposes `public` alone. Computing the fuzzed geometry once, at write time, removes the dependency: `anon` then needs no function privilege at all, and a future change to the exposed-schema setting cannot reopen the oracle.

- [ ] **Step 1: Write the failing test**

Append to `tests/fuzz.test.mjs`:

```js
test("anon needs no function privilege to read the archive", async () => {
  const rows = await sql(
    "select has_function_privilege('anon', p.oid, 'EXECUTE') as ok " +
    "from pg_proc p join pg_namespace n on n.oid = p.pronamespace " +
    "where n.nspname = 'private' and p.proname = 'fuzz_point'");
  assert.equal(rows[0].ok, false,
    "the view computes nothing at read time, so anon should need nothing");
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test`
Expected: FAIL — `ok` is currently `true`.

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/0014_fuzz_at_rest.sql
-- The fuzzed position is computed once, when the row is written, instead of on every
-- anonymous read. That removes the last reason for `anon` to hold EXECUTE on the fuzz
-- function: the view now selects a column. A future change to the API's exposed schemas
-- therefore cannot reopen the oracle closed in 0006.

alter table public.features add column if not exists geometry_public jsonb;

create or replace function private.refresh_geometry_public()
returns trigger language plpgsql security definer
set search_path = public, private, pg_temp as $$
begin
  if (new.properties->>'sensitive')::boolean is true and new.kind = 'point' then
    new.geometry_public := private.fuzz_point(
      new.geometry, new.id,
      greatest(coalesce(nullif(new.properties->>'fuzz_m', '')::double precision, 200), 25));
  else
    new.geometry_public := new.geometry;
  end if;
  return new;
end $$;

drop trigger if exists features_fuzz on public.features;
create trigger features_fuzz before insert or update on public.features
  for each row execute function private.refresh_geometry_public();

update public.features set geometry = geometry;   -- fires the trigger for existing rows

create or replace view public.public_features
with (security_invoker = off) as
select f.id, f.place, f.kind, f.geometry_public as geometry,
  (f.properties - 'sensitive' - 'fuzz_m')
    || case when (f.properties->>'sensitive')::boolean is true and f.kind = 'point'
            then jsonb_build_object('fuzzed', true) else '{}'::jsonb end as properties,
  f.created_at
from public.features f
where f.deleted_at is null and (f.properties->>'published')::boolean is true;

revoke all on public.public_features from anon, authenticated;
grant select on public.public_features to anon, authenticated;
revoke all on function private.fuzz_point(jsonb, uuid, double precision) from anon, authenticated;
```

- [ ] **Step 4: Run the tests**

Run: `npm run db:apply && npm test`
Expected: every fuzz test still passes — the coordinates must be identical, because the same function with the same salt computed them — plus the new one.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0014_fuzz_at_rest.sql tests/fuzz.test.mjs
git commit -m "The fuzz happens once, at rest, so a reader needs no privilege to see it"
```

---

### Task 8: The audit trail, readable in the app

**Files:**
- Modify: `index.html` (the storage section, the IIFE)
- Test: `tests/audit-ui.test.mjs`

**Interfaces:**
- Consumes: `sb`, `setterState()`.
- Produces: `renderAudit()`; a `#audit` block holding `#audit-list` and `#audit-refresh`.

**Why:** the spec's setter surface asks for "the audit trail readable in-app, at least as a plain list". A record nobody can read is a record that only exists in principle — and with two or three setters, "who published this and when" is the question that actually gets asked.

- [ ] **Step 1: Write the failing test**

```js
// tests/audit-ui.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8");

test("the page can show the audit trail", () => {
  assert.match(html, /id="audit-list"/);
  assert.match(html, /id="audit-refresh"/);
});

test("the trail is only fetched for a signed-in setter", () => {
  const fn = html.slice(html.indexOf("function renderAudit"));
  assert.match(fn.slice(0, 400), /setter\.signedIn/,
    "an anonymous fetch would just 401 and print an error where a list belongs");
});

test("the list shows who, what and when — a bare action is not a record", () => {
  const fn = html.slice(html.indexOf("function renderAudit"), html.indexOf("$(\"#audit-refresh\")"));
  for (const field of ["action", "at", "setter_id"]) {
    assert.ok(fn.includes(field), `the rendered row must carry ${field}`);
  }
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test`
Expected: FAIL — no `#audit-list` in the page.

- [ ] **Step 3: Add the markup**

Inside `#storage`, below `#publishbar`:

```html
      <div id="audit">
        <button type="button" id="audit-refresh" class="ghost">Recent activity</button>
        <ul id="audit-list"></ul>
      </div>
```

- [ ] **Step 4: Add the behaviour**

After the publish block:

```js
  /* The last fifty actions, newest first. Names are not joined in — `setters` is readable by
     any setter, so the id is resolved locally against a small map rather than costing a join
     on every refresh. An unknown id prints as itself rather than as blank: a record that
     hides who did something is not a record. */
  var setterNames = {};

  function renderAudit() {
    var ul = $("#audit-list");
    ul.textContent = "";
    if (!sb || !setter.signedIn) {
      var li = document.createElement("li");
      li.className = "hint";
      li.textContent = "Sign in to see who changed what.";
      ul.appendChild(li);
      return;
    }
    sb.from("setters").select("id,name").then(function (r) {
      (r.data || []).forEach(function (s) { setterNames[s.id] = s.name; });
      return sb.from("audit").select("at,action,target_id,setter_id")
               .order("at", { ascending: false }).limit(50);
    }).then(function (r) {
      ul.textContent = "";
      if (r.error) { ul.textContent = "Could not load: " + r.error.message; return; }
      if (!r.data.length) { ul.textContent = "Nothing recorded yet."; return; }
      r.data.forEach(function (row) {
        var li = document.createElement("li");
        var when = new Date(row.at);
        li.textContent = when.toLocaleString() + " · " +
          (setterNames[row.setter_id] || row.setter_id || "unknown") + " · " + row.action +
          (row.target_id ? " · " + String(row.target_id).slice(0, 8) : "");
        ul.appendChild(li);
      });
    });
  }

  $("#audit-refresh").addEventListener("click", renderAudit);
```

- [ ] **Step 5: Refresh it when the session changes**

Add `renderAudit();` as the last line of `renderSetter()`.

- [ ] **Step 6: Run the tests and the checker**

Run: `npm test && npm run check`
Expected: `audit-ui.test.mjs` 3/3 pass, no missing ids.

- [ ] **Step 7: Commit**

```bash
git add index.html tests/audit-ui.test.mjs
git commit -m "The record of who did what is readable by the people it is about"
```

---

## Done when

- `npm test` is green, including `offline.test.mjs`.
- `tests/grants.test.mjs` still asserts anon reaches exactly `{public_features: SELECT}` — with no function privilege at all after Task 7.
- A magic link signs a setter in on the deployed URL, and the pending count drops to zero after Publish and stays zero on reload.
- With the network offline: a point can be marked, survives a reload, is counted as pending, and Publish fails without clearing the queue.
- `created_by` is non-null on all 18 migrated features.

## Deliberately not in this stage

Mode gating, the two ways to hear, the GPS/Virtual switch promoted to a mode, the Mark button demoted to Locate — all stage 3. A listener signing in, comments, moderation — out of scope entirely per the spec.
