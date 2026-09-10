// tools/migrate-archive.mjs
// Copies a GeoJSON export from the browser archive into public.features.
// Idempotent: features keep their existing ids, so a second run updates rather than
// duplicates. Audio is not carried — see the plan, Task 6, step 1.
import { readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* Fixed namespace for deriving row ids from legacy (non-UUID) archive ids, e.g. the
   "f-" + Date.now() + ... shape index.html's uid() falls back to when a browser has no
   crypto.randomUUID. Any fixed UUID works as a namespace — what matters is that this one
   never changes, so the same legacy id always derives the same row id (see deriveLegacyId
   below: determinism is the whole point, it is what makes a re-run update instead of
   duplicate). Generated once with crypto.randomUUID() and hard-coded here. */
export const LEGACY_ID_NAMESPACE = "3f5a6b1e-9c2d-4f7a-8e3b-1d2c3b4a5f60";

/* UUIDv5 (namespace + name, sha1-based). Node has no built-in v5, so it's computed by
   hand: sha1(namespace_bytes || name_bytes), then the version nibble is forced to 5 and
   the variant bits to 0b10, per RFC 4122. Deterministic by construction — the same
   (name, namespace) pair always yields the same id, which is why this is safe to use as
   a row id for upsert-by-id idempotency, unlike crypto.randomUUID() (a fresh value every
   call, which was the bug: a legacy id would mint a new row id — and a new row — on
   every run). The legacy id itself is kept separately in properties.legacy_id (see
   toRow) so the identifier the browser knew is not lost, only supplemented. */
export function deriveLegacyId(name, namespace = LEGACY_ID_NAMESPACE) {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const nameBytes = Buffer.from(String(name), "utf8");
  const hash = createHash("sha1").update(Buffer.concat([nsBytes, nameBytes])).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xxxxxx
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/* One archive feature -> one features row. Exported so tests can check id derivation
   and legacy_id fidelity without needing a live database. */
export function toRow(f) {
  const p = { ...f.properties };
  const rawId = p.id;
  const isUuid = UUID.test(rawId ?? "");
  const id = isUuid ? rawId : deriveLegacyId(rawId ?? "");
  const place = p.place;
  const kind = p.kind;
  if (!place) { throw new Error(`feature ${rawId} has no place`); }
  if (kind !== "point" && kind !== "route") { throw new Error(`feature ${rawId} has kind ${kind}`); }
  // id, place and kind become columns; everything else stays in properties, unchanged.
  delete p.id; delete p.place; delete p.kind;
  if (!isUuid) { p.legacy_id = rawId; }
  return {
    id, place, kind,
    geometry: f.geometry,
    properties: p,
    created_at: p.created_at ?? new Date().toISOString()
  };
}

async function main() {
  const file = process.argv[2] ?? "archive-export.geojson";
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false }
  });

  const fc = JSON.parse(readFileSync(file, "utf8"));
  if (fc.type !== "FeatureCollection") { throw new Error(`${file} is not a FeatureCollection`); }

  // Audio is stage 2's upload path, not this tool's — refuse rather than silently
  // pretending a copy is complete when it dropped a feature's audio on the floor.
  const withAudio = fc.features.filter((f) => f.properties?.has_audio);
  if (withAudio.length) {
    throw new Error(
      `${withAudio.length} feature(s) in ${file} carry audio; this tool does not migrate ` +
      `audio — that is stage 2's upload path, not this tool's.`
    );
  }

  const rows = fc.features.map(toRow);

  const { error, data } = await db.from("features").upsert(rows, { onConflict: "id" }).select("id");
  if (error) { throw new Error(error.message); }
  console.log(`migrated ${data.length} of ${fc.features.length} features from ${file}`);

  const { count } = await db.from("features").select("id", { count: "exact", head: true });
  console.log(`features table now holds ${count} rows`);
}

// Run only when executed directly (`node tools/migrate-archive.mjs ...`), not when
// imported by tests for its exports.
const isMain = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) { await main(); }
