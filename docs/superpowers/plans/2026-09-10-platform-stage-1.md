# FieldArc 2.0 — Stage 1: the server, read-only

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the database that will hold the archive, prove that an anonymous reader cannot see an unpublished feature or a sensitive point's true position, and copy the existing archive into it — while the app keeps running entirely on its local mirror.

**Architecture:** A hosted Supabase project. Schema and policies live in this repo as SQL migrations pushed with the Supabase CLI. Features are stored in the shape the app already speaks — GeoJSON geometry, a `properties` jsonb carrying the patch — so migration is a copy rather than a re-modelling. Anonymous readers never touch the `features` table; they select from a view that filters to published rows and replaces a sensitive point's geometry with a stable, salted offset computed inside the database. Nothing in `index.html` changes in this stage.

**Tech Stack:** Supabase (Postgres 17.6, PostgREST, Auth), Node 24 with `pg` (`node:test`, `--env-file`), `@supabase/supabase-js` v2 as a dev dependency only.

**Spec:** `docs/superpowers/specs/2026-09-10-platform-design.md`

## Global Constraints

- **`index.html` is not modified in this stage.** The app continues to run on `localStorage` and IndexedDB. If a task appears to require an app change, stop — it belongs to a later stage.
- **No build step is introduced.** `package.json` exists for tests and tools only. The deployed artifact remains a static file set.
- **No PostGIS.** Geometry is GeoJSON in a `jsonb` column and distance arithmetic uses the same flat lon/lat approximation `index.html` already uses (`111320 m` per degree of latitude, scaled by `cos(lat)` for longitude).
- **Anonymous access is proved by querying as an anonymous client**, never by trusting the UI (spec, *Verification*).
- **`audit` is insert-only for everyone**, including setters — no update policy and no delete policy exist.
- **The fuzz offset is stable per feature and salted server-side.** Default radius **200 m**, per-feature override via `properties.fuzz_m`.
- **Secrets never enter the repo.** Keys live in `.env.local`, which is gitignored. `.env.local.example` carries names only.
- Commit messages follow the repo's voice: a declarative sentence, then what it prevents or what was measured.

## Decisions this plan makes that the spec did not

- **`sensitive` affects points only. A sensitive route publishes as drawn.** Kerem's call, 2026-09-10: fuzzing routes is not significant, and a caution can be added later if it ever matters. This is deliberate rather than overlooked — offsetting every vertex of a LineString would either destroy the walk or leave the true path recoverable from its shape, so the choice was between publishing it and withholding it, and publishing it is what was chosen. Implemented in Task 4.
- **Audio migration is deferred to stage 2.** The existing archive has no features with audio (`has_audio` is false on all 16), and stage 1 has no authenticated upload path. Kerem uploads audio himself once the platform stands, through the path stage 2 builds.
- **Storage bucket policies are stage 2's**, not stage 1's. There is no bucket until there is an upload path. Stage 1 revokes `recordings` from `anon` entirely; the spec's rule that anon may read a recording only when its feature is published lands with the bucket.

## File Structure

| File | Responsibility |
| --- | --- |
| `supabase/migrations/0001_features.sql` | The `features` table and its indexes |
| `supabase/migrations/0002_setters_recordings_audit.sql` | The three supporting tables |
| `supabase/migrations/0003_fuzz.sql` | `private.config`, `public.fuzz_point` |
| `supabase/migrations/0004_public_view.sql` | `public.public_features`, the only thing anon may read |
| `supabase/migrations/0005_rls.sql` | RLS enabled, grants revoked, policies created |
| `tests/authority.test.mjs` | Proves what anon and a setter can and cannot do |
| `tools/migrate-archive.mjs` | Copies a GeoJSON export into `features` |
| `package.json` | Dev dependency and test/tool scripts |
| `.env.local.example` | Key names, no values |

---

### Task 1: Project, keys and a test harness that can reach the database

**Files:**
- Create: `package.json`, `.env.local.example`, `tests/clients.mjs`, `tests/connection.test.mjs`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing.
- Produces: `npm test` runs `node --test --env-file=.env.local "tests/**/*.test.mjs"`. Env names `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`.

- [ ] **Step 1: Kerem creates the Supabase project (manual, cannot be automated)**

At <https://supabase.com/dashboard>, create a project named `fieldarc`, region closest to İstanbul (`eu-central-1`). From *Project Settings → API*, copy the Project URL, the `anon` public key and the `service_role` secret key. From *Project Settings → General*, copy the Reference ID.

- [ ] **Step 2: Write `.env.local.example`**

```
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_KEY=
SUPABASE_PROJECT_REF=
```

- [ ] **Step 3: Create `.env.local` with the real values and confirm it is ignored**

```bash
cp .env.local.example .env.local
# paste the four values into .env.local
printf '\n# Secrets: keys for the Supabase project\n.env.local\nnode_modules/\n' >> .gitignore
git check-ignore -v .env.local
```

Expected: prints a line naming `.gitignore`. If it prints nothing, stop — the file is not ignored.

- [ ] **Step 4: Write `package.json`**

```json
{
  "name": "fieldarc",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test --env-file=.env.local \"tests/**/*.test.mjs\"",
    "check": "node check-html.js index.html && node check-html.js diag.html",
    "db:apply": "node --env-file=.env.local tools/sql.mjs",
    "db:query": "node --env-file=.env.local tools/sql.mjs --query",
    "migrate:archive": "node --env-file=.env.local tools/migrate-archive.mjs"
  },
  "devDependencies": {
    "@supabase/supabase-js": "^2.45.0"
  }
}
```

- [ ] **Step 5: Write the client factories**

These live outside any `*.test.mjs` file on purpose. `node --test` treats each test file as its own run, so exporting helpers from a test file would re-register and re-run that file's tests inside every file importing it.

```js
// tests/clients.mjs
import { createClient } from "@supabase/supabase-js";

export const anon = () =>
  createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY,
               { auth: { persistSession: false } });

export const service = () =>
  createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY,
               { auth: { persistSession: false } });
```

- [ ] **Step 6: Write the failing connection test**

```js
// tests/connection.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { anon } from "./clients.mjs";

test("the three keys are present", () => {
  for (const k of ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_KEY"]) {
    assert.ok(process.env[k], `${k} missing from .env.local`);
  }
});

test("features table exists and anon cannot select it", async () => {
  const { error } = await anon().from("features").select("id").limit(1);
  assert.ok(error, "anon must not be able to select features at all");
});
```

- [ ] **Step 7: Install and run it, expecting the second test to fail**

```bash
npm install
npm test
```

Expected: the key test passes; `features table exists` FAILS, because no table exists yet and the error shape is not what a locked table gives. This is the failing state Task 2 and Task 5 close.

- [ ] **Step 8: Link the CLI to the project**

```bash
npx --yes supabase@latest link --project-ref "$SUPABASE_PROJECT_REF"
```

Expected: prompts for the database password (Project Settings → Database), then reports the project is linked.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json .env.local.example .gitignore tests/clients.mjs tests/connection.test.mjs
git commit -m "A test harness that can reach the database, and keys that cannot reach the repo"
```

---

### Task 2: The features table

**Files:**
- Create: `supabase/migrations/0001_features.sql`, `tests/features.test.mjs`

**Interfaces:**
- Consumes: `anon()` and `service()` from `tests/clients.mjs`.
- Produces: table `public.features` with columns `id uuid`, `place text`, `kind text`, `geometry jsonb`, `properties jsonb`, `created_by uuid`, `created_at timestamptz`, `updated_at timestamptz`, `deleted_at timestamptz`.

- [ ] **Step 1: Write the failing test**

```js
// tests/features.test.mjs
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
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
npm test
```

Expected: FAIL — `relation "public.features" does not exist`.

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/0001_features.sql
-- The app already speaks GeoJSON and already carries a route's patch inside its
-- properties. Storing that shape verbatim makes migration a copy and keeps one format
-- in one place; re-modelling it would buy nothing and cost a translation layer.

create table if not exists public.features (
  id          uuid primary key default gen_random_uuid(),
  place       text not null,
  kind        text not null check (kind in ('point', 'route')),
  geometry    jsonb not null,
  properties  jsonb not null default '{}'::jsonb,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

-- Every listener read is "this place, published, not deleted".
create index if not exists features_place_idx
  on public.features (place) where deleted_at is null;

create index if not exists features_published_idx
  on public.features (place)
  where deleted_at is null and (properties->>'published')::boolean is true;

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists features_touch on public.features;
create trigger features_touch before update on public.features
  for each row execute function public.touch_updated_at();
```

- [ ] **Step 4: Push and run the tests**

```bash
npm run db:apply
npm test
```

Expected: both `features.test.mjs` tests PASS. `connection.test.mjs`'s "anon cannot select" still FAILS — RLS is Task 5.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0001_features.sql tests/features.test.mjs
git commit -m "The archive gets a table shaped like the archive"
```

---

### Task 3: Setters, recordings and an audit that cannot be rewritten

**Files:**
- Create: `supabase/migrations/0002_setters_recordings_audit.sql`, `tests/audit.test.mjs`

**Interfaces:**
- Consumes: `service()`.
- Produces: tables `public.setters`, `public.recordings`, `public.audit`. `audit.action` is constrained to `sign_in | create | update | delete | publish | unpublish`.

- [ ] **Step 1: Write the failing test**

```js
// tests/audit.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { service } from "./clients.mjs";

const db = service();
after(async () => { await db.from("audit").delete().eq("target_id", "probe"); });

test("an audit row records an action against a target", async () => {
  const { error } = await db.from("audit")
    .insert({ action: "publish", target_id: "probe", detail: { note: "probe" } });
  assert.equal(error, null, error?.message);

  const { data } = await db.from("audit").select("*").eq("target_id", "probe");
  assert.equal(data.length, 1);
  assert.ok(data[0].at, "every audit row is stamped");
});

test("an unknown action is refused", async () => {
  const { error } = await db.from("audit")
    .insert({ action: "vandalise", target_id: "probe" });
  assert.ok(error, "the set of actions is closed");
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
npm test
```

Expected: FAIL — `relation "public.audit" does not exist`.

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/0002_setters_recordings_audit.sql

create table if not exists public.setters (
  id          uuid primary key references auth.users (id) on delete cascade,
  name        text not null,
  invited_at  timestamptz not null default now()
);

-- One row per attached file. `peaks` is the ~200-point waveform summary the B1 envelope
-- bridge already reads as a control curve, so it must survive the move to a server.
create table if not exists public.recordings (
  id            uuid primary key default gen_random_uuid(),
  feature_id    uuid not null references public.features (id) on delete cascade,
  storage_path  text not null unique,
  mime          text not null,
  bytes         bigint not null check (bytes > 0),
  duration_s    double precision,
  peaks         jsonb,
  descriptors   jsonb,
  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists recordings_feature_idx on public.recordings (feature_id);

-- Append-only by construction as well as by policy: no update or delete policy is ever
-- written for this table, so even a setter cannot revise the record of what they did.
create table if not exists public.audit (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  setter_id  uuid references auth.users (id) on delete set null,
  action     text not null check (action in
               ('sign_in', 'create', 'update', 'delete', 'publish', 'unpublish')),
  target_id  text,
  detail     jsonb not null default '{}'::jsonb
);

create index if not exists audit_at_idx on public.audit (at desc);
```

- [ ] **Step 4: Push and run the tests**

```bash
npm run db:apply
npm test
```

Expected: both `audit.test.mjs` tests PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0002_setters_recordings_audit.sql tests/audit.test.mjs
git commit -m "Who was invited, what they attached, and a record they cannot rewrite"
```

---

### Task 4: The fuzz, and the only thing an anonymous reader may select

**Files:**
- Create: `supabase/migrations/0003_fuzz.sql`, `supabase/migrations/0004_public_view.sql`, `tests/fuzz.test.mjs`

**Interfaces:**
- Consumes: `service()`, `public.features`.
- Produces: `public.fuzz_point(g jsonb, fid uuid, radius_m double precision) returns jsonb`; view `public.public_features` with columns `id, place, kind, geometry, properties, created_at`.

- [ ] **Step 1: Write the failing test**

```js
// tests/fuzz.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { service } from "./clients.mjs";

const db = service();
const TRUE_LON = 28.9925, TRUE_LAT = 41.1855;
const ids = {
  open:      "00000000-0000-4000-8000-0000000000a1",
  sensitive: "00000000-0000-4000-8000-0000000000a2",
  draft:     "00000000-0000-4000-8000-0000000000a3",
  sensRoute: "00000000-0000-4000-8000-0000000000a4"
};
const metres = (a, b) => {
  const kx = Math.cos((TRUE_LAT * Math.PI) / 180);
  return Math.hypot((a[0] - b[0]) * kx, a[1] - b[1]) * 111320;
};

before(async () => {
  await db.from("features").delete().in("id", Object.values(ids));
  await db.from("features").insert([
    { id: ids.open, place: "T", kind: "point",
      geometry: { type: "Point", coordinates: [TRUE_LON, TRUE_LAT] },
      properties: { published: true, sensitive: false } },
    { id: ids.sensitive, place: "T", kind: "point",
      geometry: { type: "Point", coordinates: [TRUE_LON, TRUE_LAT] },
      properties: { published: true, sensitive: true, fuzz_m: 200 } },
    { id: ids.draft, place: "T", kind: "point",
      geometry: { type: "Point", coordinates: [TRUE_LON, TRUE_LAT] },
      properties: { published: false, sensitive: false } },
    { id: ids.sensRoute, place: "T", kind: "route",
      geometry: { type: "LineString", coordinates: [[TRUE_LON, TRUE_LAT], [29.0, 41.19]] },
      properties: { published: true, sensitive: true } }
  ]);
});
after(async () => { await db.from("features").delete().in("id", Object.values(ids)); });

test("an open published point is returned exactly", async () => {
  const { data } = await db.from("public_features").select("*").eq("id", ids.open).single();
  assert.deepEqual(data.geometry.coordinates, [TRUE_LON, TRUE_LAT]);
});

test("a sensitive point is moved, but stays within its radius", async () => {
  const { data } = await db.from("public_features").select("*").eq("id", ids.sensitive).single();
  const d = metres(data.geometry.coordinates, [TRUE_LON, TRUE_LAT]);
  assert.ok(d > 1, `expected the point to move, moved ${d.toFixed(1)}m`);
  assert.ok(d <= 200, `expected within the 200m radius, was ${d.toFixed(1)}m`);
});

test("the same sensitive point reads the same every time", async () => {
  const reads = [];
  for (let i = 0; i < 5; i++) {
    const { data } = await db.from("public_features").select("geometry").eq("id", ids.sensitive).single();
    reads.push(JSON.stringify(data.geometry.coordinates));
  }
  assert.equal(new Set(reads).size, 1, "a re-randomised offset averages out to the truth");
});

test("the fuzz radius is not disclosed, but the fact of fuzzing is", async () => {
  const { data } = await db.from("public_features").select("properties").eq("id", ids.sensitive).single();
  assert.equal(data.properties.fuzz_m, undefined, "fuzz_m narrows the search");
  assert.equal(data.properties.sensitive, undefined, "the flag itself is internal");
  assert.equal(data.properties.fuzzed, true, "a listener is told the position is approximate");
});

test("an unpublished feature is not in the view", async () => {
  const { data } = await db.from("public_features").select("id").eq("id", ids.draft);
  assert.equal(data.length, 0);
});

test("a sensitive route publishes as drawn", async () => {
  const { data } = await db.from("public_features").select("*").eq("id", ids.sensRoute).single();
  assert.deepEqual(data.geometry.coordinates[0], [TRUE_LON, TRUE_LAT],
    "routes are not fuzzed — decided 2026-09-10, a caution can come later");
  assert.equal(data.properties.fuzzed, undefined, "and it must not claim to be fuzzed");
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
npm test
```

Expected: FAIL — `relation "public.public_features" does not exist`.

- [ ] **Step 3: Write the fuzz migration**

```sql
-- supabase/migrations/0003_fuzz.sql
-- `sensitive` used to fuzz a position in the client, which is a promise the client makes to
-- itself: if the true coordinate reaches the browser, the flag is decoration and a den is
-- one devtools panel away. The offset is computed here and the truth never leaves.
--
-- Stable, because an offset re-rolled per request averages out to the true point over
-- repeated reads. Salted with a secret the reader does not have, because an offset derived
-- from the id alone can be recomputed by anyone holding the id — which is every reader.

create schema if not exists private;
revoke all on schema private from anon, authenticated;

create table if not exists private.config (
  key    text primary key,
  value  text not null
);

create or replace function public.fuzz_point(g jsonb, fid uuid, radius_m double precision)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private, pg_temp
as $$
declare
  salt text;
  h    bigint;
  ang  double precision;
  r    double precision;
  lon  double precision;
  lat  double precision;
begin
  if g->>'type' <> 'Point' then
    return null;   -- callers must not publish a fuzzed non-point; see the view
  end if;

  select value into salt from private.config where key = 'fuzz_salt';
  if salt is null or length(salt) < 16 then
    -- Failing closed. An error here hides a position; a fallback would expose one.
    raise exception 'fuzz salt missing or too short';
  end if;

  h   := abs(hashtextextended(fid::text || salt, 0));
  ang := ((h % 36000)::double precision / 36000.0) * 2 * pi();
  -- sqrt so the offset is uniform over the disc rather than crowding the centre, which
  -- would make the true point the most likely guess.
  r   := sqrt((((h / 36000) % 100000))::double precision / 100000.0) * radius_m;

  lon := (g->'coordinates'->>0)::double precision;
  lat := (g->'coordinates'->>1)::double precision;

  return jsonb_build_object(
    'type', 'Point',
    'coordinates', jsonb_build_array(
      round((lon + (r * sin(ang)) / (111320.0 * cos(radians(lat))))::numeric, 6),
      round((lat + (r * cos(ang)) / 111320.0)::numeric, 6)
    )
  );
end $$;

revoke all on function public.fuzz_point(jsonb, uuid, double precision) from anon, authenticated;
```

- [ ] **Step 4: Set the salt (manual, and never committed)**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Paste the value into the Supabase SQL editor, once:

```sql
insert into private.config (key, value) values ('fuzz_salt', '<paste>')
on conflict (key) do nothing;
```

Changing this salt later moves every sensitive point. That is acceptable — it is a rotation, not a corruption — but it is not reversible, so record that it happened.

- [ ] **Step 5: Write the view migration**

```sql
-- supabase/migrations/0004_public_view.sql
-- The only object an anonymous reader is ever granted. It reads the table as its owner, so
-- the table itself stays unreadable and every anonymous read passes through these rules.

create or replace view public.public_features
with (security_invoker = off) as
select
  f.id,
  f.place,
  f.kind,
  -- Points only. A route marked sensitive publishes as drawn: offsetting every vertex would
  -- either destroy the walk or leave the true path recoverable from its shape, so there is
  -- no useful middle. Decided 2026-09-10; a caution in the UI can come later if it matters.
  case
    when (f.properties->>'sensitive')::boolean is true and f.kind = 'point'
      then public.fuzz_point(f.geometry, f.id,
             coalesce((f.properties->>'fuzz_m')::double precision, 200))
    else f.geometry
  end as geometry,
  (f.properties - 'sensitive' - 'fuzz_m')
    || case when (f.properties->>'sensitive')::boolean is true and f.kind = 'point'
            then jsonb_build_object('fuzzed', true) else '{}'::jsonb end
    as properties,
  f.created_at
from public.features f
where f.deleted_at is null
  and (f.properties->>'published')::boolean is true;

grant select on public.public_features to anon, authenticated;
```

- [ ] **Step 6: Push and run the tests**

```bash
npm run db:apply
npm test
```

Expected: all six `fuzz.test.mjs` tests PASS.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/0003_fuzz.sql supabase/migrations/0004_public_view.sql tests/fuzz.test.mjs
git commit -m "A den's position stops being a promise the client makes to itself"
```

---

### Task 5: Authority — what anon and a setter may actually do

**Files:**
- Create: `supabase/migrations/0005_rls.sql`, `tests/authority.test.mjs`
- Modify: none. The second test in `tests/connection.test.mjs` starts passing on its own.

**Interfaces:**
- Consumes: everything above.
- Produces: RLS enabled on all four tables; `anon` may select only `public_features`.

- [ ] **Step 1: Write the failing test**

```js
// tests/authority.test.mjs
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
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
npm test
```

Expected: FAIL — anon currently reads `features` freely, because RLS is not yet enabled.

- [ ] **Step 3: Write the migration**

```sql
-- supabase/migrations/0005_rls.sql
-- Anonymous readers get exactly one object: public_features. Everything else is closed, and
-- closed by default rather than by a policy that could be edited into openness.

alter table public.features   enable row level security;
alter table public.setters    enable row level security;
alter table public.recordings enable row level security;
alter table public.audit      enable row level security;

revoke all on public.features   from anon;
revoke all on public.setters    from anon;
revoke all on public.recordings from anon;
revoke all on public.audit      from anon;

grant select, insert, update, delete on public.features   to authenticated;
grant select, insert, update, delete on public.recordings to authenticated;
grant select                        on public.setters     to authenticated;
grant select, insert                on public.audit       to authenticated;
grant usage, select on sequence public.audit_id_seq to authenticated;

-- A setter is anyone with a row in setters. Being authenticated is not enough on its own,
-- so a stray account cannot write to the archive.
create or replace function public.is_setter()
returns boolean language sql stable security definer
set search_path = public, pg_temp as $$
  select exists (select 1 from public.setters s where s.id = auth.uid());
$$;

drop policy if exists features_setter_all on public.features;
create policy features_setter_all on public.features
  for all to authenticated
  using (public.is_setter()) with check (public.is_setter());

drop policy if exists recordings_setter_all on public.recordings;
create policy recordings_setter_all on public.recordings
  for all to authenticated
  using (public.is_setter()) with check (public.is_setter());

drop policy if exists setters_read on public.setters;
create policy setters_read on public.setters
  for select to authenticated using (public.is_setter());

-- Insert and select only. No update policy and no delete policy exists, so both are refused
-- for every role: the record of what was done cannot be revised by the person who did it.
drop policy if exists audit_insert on public.audit;
create policy audit_insert on public.audit
  for insert to authenticated with check (setter_id = auth.uid() and public.is_setter());

drop policy if exists audit_read on public.audit;
create policy audit_read on public.audit
  for select to authenticated using (public.is_setter());
```

- [ ] **Step 4: Push and run the whole suite**

```bash
npm run db:apply
npm test
```

Expected: every test in `connection`, `features`, `audit`, `fuzz` and `authority` PASSES. Record the output — this is the security verification the spec requires before anything depends on it.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0005_rls.sql tests/authority.test.mjs
git commit -m "Anonymous gets one view and nothing else, proved by asking as anonymous"
```

---

### Task 6: Move the existing archive in

**Files:**
- Create: `tools/migrate-archive.mjs`
- Test: run against `archive-backup-2026-09-04.geojson` before the live export

**Interfaces:**
- Consumes: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`.
- Produces: rows in `public.features`. Idempotent — running twice does not duplicate.

- [ ] **Step 1: Take a fresh export from the running app**

Open the deployed app, press **Export .geojson**, and save it as `archive-export.geojson` in the repo root. It is gitignored by Task 1's `node_modules`/secrets line only, so add it explicitly:

```bash
printf 'archive-export.geojson\n' >> .gitignore
```

The export carries features but **not** audio. Confirm whether any feature has audio before assuming this is a complete copy:

```bash
node -e "const fc=require('fs').readFileSync('archive-export.geojson','utf8');const j=JSON.parse(fc);console.log('features',j.features.length,'with audio',j.features.filter(f=>f.properties.has_audio).length)"
```

Expected at the time of writing: `with audio 0`. If it is not 0, stop and raise it — audio migration is stage 2's upload path, and this tool does not carry blobs.

- [ ] **Step 2: Write the tool**

```js
// tools/migrate-archive.mjs
// Copies a GeoJSON export from the browser archive into public.features.
// Idempotent: features keep their existing ids, so a second run updates rather than
// duplicates. Audio is not carried — see the plan, Task 6, step 1.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const file = process.argv[2] ?? "archive-export.geojson";
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false }
});

const fc = JSON.parse(readFileSync(file, "utf8"));
if (fc.type !== "FeatureCollection") { throw new Error(`${file} is not a FeatureCollection`); }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const rows = fc.features.map((f) => {
  const p = { ...f.properties };
  const id = UUID.test(p.id ?? "") ? p.id : crypto.randomUUID();
  const place = p.place;
  const kind = p.kind;
  if (!place) { throw new Error(`feature ${p.id} has no place`); }
  if (kind !== "point" && kind !== "route") { throw new Error(`feature ${p.id} has kind ${kind}`); }
  // id, place and kind become columns; everything else stays in properties, unchanged.
  delete p.id; delete p.place; delete p.kind;
  return {
    id, place, kind,
    geometry: f.geometry,
    properties: p,
    created_at: p.created_at ?? new Date().toISOString()
  };
});

const { error, data } = await db.from("features").upsert(rows, { onConflict: "id" }).select("id");
if (error) { throw new Error(error.message); }
console.log(`migrated ${data.length} of ${fc.features.length} features from ${file}`);

const { count } = await db.from("features").select("id", { count: "exact", head: true });
console.log(`features table now holds ${count} rows`);
```

- [ ] **Step 3: Dry-run against the committed backup**

```bash
node --env-file=.env.local tools/migrate-archive.mjs archive-backup-2026-09-04.geojson
```

Expected: `migrated 16 of 16 features`. Run it a second time and confirm the table count does not change — that is the idempotency check.

- [ ] **Step 4: Verify a listener sees only what they should**

```bash
node --env-file=.env.local -e "
import('@supabase/supabase-js').then(async ({createClient})=>{
  const a=createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const {data}=await a.from('public_features').select('id,kind,properties');
  console.log('anon sees', data.length, 'features');
  console.log('any unpublished leaked:', data.some(f=>f.properties.published!==true));
  console.log('any sensitive flag leaked:', data.some(f=>'sensitive' in f.properties));
});"
```

Expected: the count matches the number of features with `published: true`, and both leak checks print `false`.

- [ ] **Step 5: Run the real export and the full suite**

```bash
node --env-file=.env.local tools/migrate-archive.mjs archive-export.geojson
npm test
npm run check
```

- [ ] **Step 6: Commit**

```bash
git add tools/migrate-archive.mjs .gitignore
git commit -m "The archive exists in two places now, and the copy is idempotent"
```

---

## Done when

- `npm test` passes every test in the five files, and the authority suite's output is recorded in the stage-1 commit message or a note beside it.
- An anonymous client can select `public_features` and nothing else.
- A sensitive point reads the same offset position on every request, within its radius, and its true coordinate appears in no anonymous response.
- The existing archive is in `features`, and re-running the tool changes no counts.
- `index.html` is byte-identical to its state at `v1.5-the-field` — this stage did not touch the app.
