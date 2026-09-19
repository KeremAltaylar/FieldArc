/* How much of the Supabase Free plan FieldArc is using.

     npm run usage

   Database and file sizes are exact, read from Postgres. Downloads are not: the Management
   API exposes no egress figure, and a Free project's logs go back only 24 hours (a wider
   window returns nothing — measured 2026-09-19). So downloads are the last 24 hours, summed
   from response sizes in the edge logs, and the monthly total the plan is billed on lives only
   in the dashboard's Usage page.

   The limits are Supabase's published Free plan figures as of 2026-09-19, except the per-file
   limit, which is read live from this project's storage config. */
import pg from "pg";

const LIMITS = { db: 500 * 1024 ** 2, files: 1024 ** 3, egress: 5 * 1024 ** 3 };
const API = "https://api.supabase.com/v1/projects/" + process.env.SUPABASE_PROJECT_REF;
const H = { Authorization: "Bearer " + process.env.SUPABASE_ACCESS_TOKEN };

const mb = (b) => b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(2) + " GB" : (b / 1024 ** 2).toFixed(1) + " MB";
const pct = (b, lim) => Math.round(100 * b / lim) + "%";
const pad = (s, n) => String(s).padEnd(n);

async function api(path) {
  const r = await fetch(API + path, { headers: H });
  if (!r.ok) { throw new Error(path + ": " + r.status); }
  return r.json();
}

async function logs(sql) {
  const u = new URL(API + "/analytics/endpoints/logs.all");
  u.searchParams.set("sql", sql);
  u.searchParams.set("iso_timestamp_start", new Date(Date.now() - 864e5).toISOString());
  u.searchParams.set("iso_timestamp_end", new Date().toISOString());
  const r = await fetch(u, { headers: H });
  if (!r.ok) { throw new Error("logs: " + r.status); }
  return (await r.json()).result || [];
}

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const { rows: [s] } = await c.query(`select
    pg_database_size(current_database())::bigint db,
    coalesce(sum((metadata->>'size')::bigint), 0)::bigint files,
    count(*)::int n,
    coalesce(max((metadata->>'size')::bigint), 0)::bigint largest
  from storage.objects`);
const { rows: [f] } = await c.query(`select
    count(*) filter (where deleted_at is null)::int live,
    count(*) filter (where deleted_at is null and (properties->>'published')::boolean)::int published
  from public.features`);
await c.end();

const [project, storageCfg, counts] = await Promise.all([
  api(""), api("/config/storage"), api("/analytics/endpoints/usage.api-counts?interval=7day")
]);
const fileLimit = storageCfg.fileSizeLimit;

const [dl] = await logs(`select
    sum(safe_cast(h.content_length as int64)) total,
    sum(if(r.path like '/storage/%', safe_cast(h.content_length as int64), 0)) audio
  from edge_logs cross join unnest(metadata) m cross join unnest(m.request) r
  cross join unnest(m.response) s cross join unnest(s.headers) h
  where r.method = 'GET'`);

const week = (counts.result || []).reduce((a, d) => ({
  rest: a.rest + (d.total_rest_requests || 0),
  storage: a.storage + (d.total_storage_requests || 0),
  auth: a.auth + (d.total_auth_requests || 0)
}), { rest: 0, storage: 0, auth: 0 });

const day = Number(dl && dl.total) || 0, dayAudio = Number(dl && dl.audio) || 0;
const out = [
  "FieldArc — Supabase Free plan usage, " + new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC",
  "project    " + project.status + " (" + project.region + ")",
  "",
  pad("database", 11) + pad(mb(s.db) + " / " + mb(LIMITS.db), 22) + pct(s.db, LIMITS.db),
  pad("files", 11) + pad(mb(s.files) + " / " + mb(LIMITS.files), 22) + pct(s.files, LIMITS.files) +
    "   " + s.n + " files, largest " + mb(s.largest) + " (per-file limit " + mb(fileLimit) + ")",
  pad("downloads", 11) + pad(mb(day) + " last 24 h", 22) + "of which files " + mb(dayAudio) +
    " · a month allows " + mb(LIMITS.egress) + " (≈" + mb(LIMITS.egress / 30) + "/day)",
  "",
  "features   " + f.live + " live, " + f.published + " published",
  "requests   last 7 days: " + week.rest + " data, " + week.storage + " file, " + week.auth + " sign-in",
  "",
  "Monthly download total: dashboard → your organization → Usage (the API does not expose it)."
];
if (project.status !== "ACTIVE_HEALTHY") {
  out.push("", "!! The project is not active — listeners see nothing until it is resumed in the dashboard.");
}
console.log(out.join("\n"));
