import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { anon, service } from "./clients.mjs";

const html = readFileSync("index.html", "utf8").replace(/\r\n/g, "\n");
const ID = "0f0e0d0c-0b0a-4009-8008-700600500400";
const db = service();
const EMAIL = "free-point-probe@fieldarc.test";
const PASSWORD = "probe-" + "z".repeat(16);
let userId = null;

/* I7: the round-trip below used to run entirely through service(), which bypasses RLS — as
   tests/clients.mjs's own comment says, that proves nothing about what a real setter or a real
   listener can reach. The insert now goes through a signed-in setter (features_setter_all,
   0005_rls.sql, checks is_setter() — membership in public.setters — not created_by, so any
   registered setter may upsert any row), and the "visible to a listener" read goes through
   anon(), which was exported and unused. service() is kept only for the table-level, RLS-blind
   check (place holds NULL, not a sentinel string) and for setup/teardown, exactly as clients.mjs
   says it should be. */
before(async () => {
  await db.from("features").delete().eq("id", ID);
  const { data, error } = await db.auth.admin.createUser({
    email: EMAIL, password: PASSWORD, email_confirm: true
  });
  assert.equal(error, null, error?.message);
  userId = data.user.id;
  await db.from("setters").insert({ id: userId, name: "free point probe" });
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

test("a point with no place publishes and comes back published", async () => {
  const c = await asSetter();
  const { error } = await c.from("features").upsert({
    id: ID, place: null, kind: "point",
    geometry: { type: "Point", coordinates: [29.02, 41.01] },
    properties: { name: "free point probe", published: true }, deleted_at: null
  }, { onConflict: "id" });
  assert.equal(error, null, error?.message);

  const row = await db.from("features").select("place").eq("id", ID).single();
  assert.equal(row.error, null, "select should succeed");
  assert.equal(row.data.place, null, "the column holds NULL, not a sentinel string");

  const pub = await anon().from("public_features").select("id,place").eq("id", ID).single();
  assert.equal(pub.error, null, "a free point is visible to a listener");
  assert.equal(pub.data.place, null);
});

test("marking in open world makes a free point, and the card offers to attach it", () => {
  const matches = html.match(/place: worldOn\(\) \? null : \(place \? place\.properties\.id : DEFAULT_PLACE\)/g);
  assert.ok(matches, "a point marked in open world belongs to no park");
  assert.equal(matches.length, 2,
    "exactly the two genuine marking sites (map click, GPS mark) get this treatment — a route " +
    "must keep its park, and an audio import matched to a known trace is not marking (I6)");
  assert.match(html, /<button type="button" class="ghost" id="f-attach" hidden>/);
  const click = html.slice(html.indexOf('$("#f-attach").addEventListener'));
  assert.match(click.slice(0, 500), /f\.properties\.place = p\.properties\.id/);
  assert.match(click.slice(0, 500), /claimEdit\(f\)/, "attaching is an edit like any other");
});

/* All three normalisation pieces below are extracted verbatim from index.html and executed for
   real — not re-implemented — so a future edit that reverts any of them back to a truthiness
   check (`!f.properties.place`) is caught here rather than only in a code review. This is
   deliberately brittle against a semantically-identical rewrite: the point is to fail loudly the
   moment the guarded source text changes shape, not to tolerate refactors quietly. Neither
   placeUnset() nor either call site touches the DOM, localStorage or fc directly, so all three
   are extractable as plain functions. */

function extractPlaceUnset() {
  const stmt = 'return !("place" in f.properties) || f.properties.place === "";';
  assert.ok(html.includes(stmt),
    "the placeUnset() body was not found verbatim — did it change shape?");
  return new Function("f", stmt);
}

test("placeUnset() rescues a missing key and an empty string, but not an explicit null", () => {
  const placeUnset = extractPlaceUnset();
  assert.equal(placeUnset({ properties: {} }), true, "a key that was never set means nobody has said");
  assert.equal(placeUnset({ properties: { place: "" } }), true,
    "an empty string from a foreign .geojson export also means nobody has said");
  assert.equal(placeUnset({ properties: { place: null } }), false,
    "an explicit null is a free point's deliberate statement of belonging to nothing");
  assert.equal(placeUnset({ properties: { place: "R8845862" } }), false, "a real place is left alone");
});

test("the load-time normalisation keys off placeUnset(), not a bare truthiness check", () => {
  const stmt = "if (placeUnset(f)) { f.properties.place = DEFAULT_PLACE; }";
  assert.ok(html.includes(stmt),
    "the load-time normalisation statement was not found verbatim — did it change shape?");
  const placeUnset = extractPlaceUnset();
  const normalise = new Function("f", "DEFAULT_PLACE", "placeUnset", stmt);

  const free = { properties: { place: null } };
  normalise(free, "R8845862", placeUnset);
  assert.equal(free.properties.place, null,
    "a deliberate free point (place: null) must survive every reload, not just the first one");

  const legacy = { properties: {} };
  normalise(legacy, "R8845862", placeUnset);
  assert.equal(legacy.properties.place, "R8845862",
    "a legacy feature with no place key at all still gets the default");

  const empty = { properties: { place: "" } };
  normalise(empty, "R8845862", placeUnset);
  assert.equal(empty.properties.place, "R8845862",
    "an empty string means nobody has said, not a deliberate free point — it gets the default");
});

test("the .geojson import path applies the identical missing/empty/null rule", () => {
  const stmt = "if (placeUnset(f)) { f.properties.place = place ? place.properties.id : DEFAULT_PLACE; }";
  assert.ok(html.includes(stmt),
    "the import normalisation statement was not found verbatim — did it change shape?");
  const placeUnset = extractPlaceUnset();
  const normalise = new Function("f", "place", "DEFAULT_PLACE", "placeUnset", stmt);

  const free = { properties: { place: null } };
  normalise(free, null, "R8845862", placeUnset);
  assert.equal(free.properties.place, null,
    "an imported free point must not be adopted into whatever park happens to be open");

  const legacy = { properties: {} };
  normalise(legacy, null, "R8845862", placeUnset);
  assert.equal(legacy.properties.place, "R8845862",
    "a legacy imported feature with no place key still gets the fallback");

  const empty = { properties: { place: "" } };
  normalise(empty, null, "R8845862", placeUnset);
  assert.equal(empty.properties.place, "R8845862",
    "an imported feature with place: \"\" also gets the fallback, not a free pass");
});

/* I5: a route always belongs to a park — never null — so it cannot use the worldOn() ? null : …
   rule the point-marking sites use. In open world the picker's `place` is stale (it is not
   necessarily the park the setter is standing in and drawing over); pacer.placeId, kept current
   by worldMove every time the walker crosses a boundary, is. Extracted verbatim and executed for
   real, the same way placeUnset() is above, so a future rewrite back to a bare `place` is caught
   here rather than only in review. */
function extractRoutePlace() {
  const expr = "(pacer && pacer.world && pacer.placeId) || (place ? place.properties.id : DEFAULT_PLACE)";
  /* The full "place: …," form, not the bare expression: I6's fallback chain below embeds this
     same expression as its own second link, so counting the bare expression would find three. */
  const full = "place: " + expr + ",";
  const count = html.split(full).length - 1;
  assert.equal(count, 2,
    "exactly the two route-creation sites (map-drawn finishRoute, GPS-traced stopTrack) must " +
    "resolve the park this way — a route can never be a free point");
  return new Function("pacer", "place", "DEFAULT_PLACE", "return " + expr + ";");
}

test("a route drawn or recorded in open world belongs to the park underfoot, not the stale selected park", () => {
  const routePlace = extractRoutePlace();
  assert.equal(routePlace({ world: true, placeId: "PARK_B" }, { properties: { id: "PARK_A" } }, "DEFAULT"),
    "PARK_B", "open world: the park the walker is standing in wins over the picker's selection");
  assert.equal(routePlace(null, { properties: { id: "PARK_A" } }, "DEFAULT"),
    "PARK_A", "place mode (no world pacer): the selected place, exactly as before");
  assert.equal(routePlace({ world: false, placeId: "PARK_B" }, { properties: { id: "PARK_A" } }, "DEFAULT"),
    "PARK_A", "a place-mode pacer (pacer.world falsy) must not leak placeId into the fallback");
  assert.equal(routePlace(null, null, "DEFAULT"),
    "DEFAULT", "no pacer and no place: the last-resort default, same as always");
});

test("audio import attributes a matched recording to the trace's own park, not null and not the stale picker", () => {
  const start = html.indexOf("place: (trace && trace.properties.place) ||");
  assert.ok(start !== -1, "the matched trace's own place must be tried first — this is not marking, the park is known");
  const end = html.indexOf("created_at:", start);
  const expr = html.slice(start, end).replace(/^place:\s*/, "").replace(/,\s*$/, "");
  assert.doesNotMatch(html.slice(start, end), /worldOn\(\) \? null/,
    "I6: the free-point rule does not apply to an import matched to an existing trace");
  const importPlace = new Function("trace", "pacer", "place", "DEFAULT_PLACE", "return " + expr + ";");
  assert.equal(
    importPlace({ properties: { place: "PARK_C" } }, { world: true, placeId: "PARK_B" },
      { properties: { id: "PARK_A" } }, "DEFAULT"),
    "PARK_C", "the trace's own park always wins when it has one");
  assert.equal(
    importPlace({ properties: {} }, { world: true, placeId: "PARK_B" },
      { properties: { id: "PARK_A" } }, "DEFAULT"),
    "PARK_B", "a placeless trace in open world falls back to the park underfoot, never to null");
});
