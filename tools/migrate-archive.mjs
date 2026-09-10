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
