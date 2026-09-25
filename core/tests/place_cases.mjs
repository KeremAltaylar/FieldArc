/* Writes build/place/cases.txt: simulated walks through the published routes and points, with the
   web app's own answers at every step, for core/tests/place_test.cpp to replay through the C++.

     node core/tests/place_cases.mjs          (then build and run place_test, see its header)

   The functions that exist on their own in index.html (segment, routeMetrics, projectToRoute,
   pointAlong, nearestRoute, walkLevel) are extracted and run as they are. Zone entry/exit and the
   voice pickers live inline in pacerCheckZones / updateBed / updateRhythms, so they are mirrored
   here line for line, with the source line they copy. Published features come from the public
   view with the anon key the app itself ships; synthetic routes add the edge cases. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const html = readFileSync("index.html", "utf8").replace(/\r\n/g, "\n");
function src(name) {
  const s = html.indexOf("function " + name + "(");
  if (s < 0) { throw new Error("missing " + name); }
  let i = html.indexOf("{", html.indexOf(")", s)), d = 0;
  for (; i < html.length; i++) { if (html[i] === "{") d++; else if (html[i] === "}") { d--; if (!d) break; } }
  return html.slice(s, i + 1);
}
const js = new Function(["segment", "routeMetrics", "projectToRoute", "pointAlong", "nearestRoute", "walkLevel"]
  .map(src).join("\n") + "; return { segment, routeMetrics, projectToRoute, pointAlong, nearestRoute, walkLevel };")();

/* The constants, read from the page rather than retyped. */
const num = (re) => +re.exec(html)[1];
const ZONE_MARGIN = num(/var ZONE_MARGIN = ([\d.]+)/), ZONE_COOLDOWN = num(/var ZONE_COOLDOWN = (\d+)/);
const FADE_FROM = num(/var GPS_FADE_FROM = (\d+)/), LEASH = num(/var GPS_LEASH = (\d+)/);
const MAX_VOICES = num(/var BED = \{[^}]*maxVoices: (\d+)/);

const cfg = /url: "(https:\/\/[^"]+)",\s*anonKey: "([^"]+)"/.exec(html);
const res = await fetch(cfg[1] + "/rest/v1/public_features?select=id,kind,geometry,properties",
  { headers: { apikey: cfg[2], Authorization: "Bearer " + cfg[2] } });
const features = res.ok ? await res.json() : [];

const routes = features.filter((f) => f.kind === "route" && f.geometry.type === "LineString")
  .map((f) => ({ id: f.id, c: f.geometry.coordinates }));
const base = routes.length ? routes[0].c[0] : [29.05, 41.17];
const off = (dx, dy) => [base[0] + dx, base[1] + dy];
routes.push(
  { id: "zigzag", c: [off(0, 0.002), off(0.001, 0.0025), off(0.002, 0.002), off(0.003, 0.0025), off(0.004, 0.002)] },
  { id: "one-point", c: [off(0.002, -0.002)] },
  { id: "repeats", c: [off(-0.002, 0), off(-0.002, 0), off(-0.0015, 0.0005), off(-0.0015, 0.0005)] },
  { id: "parallel-a", c: [off(0, -0.003), off(0.003, -0.003)] },
  { id: "parallel-b", c: [off(0, -0.0032), off(0.003, -0.0032)] });

const points = features.filter((f) => f.kind === "point" && f.geometry.type === "Point").map((f) => {
  const q = f.properties.sound || {}, p = f.properties;
  return { id: f.id, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1],
           radius: q.radius === undefined ? 140 : q.radius, zoneR: q.zoneR === undefined ? 25 : q.zoneR,
           gain: q.gain === undefined ? 0.9 : q.gain,
           bed: !!p.has_audio && !(p.audio_mode === "hits" || p.audio_mode === "grains") };
});
for (let i = 0; i < 4; i++) {   /* synthetic points so the pickers have crowding to sort out */
  points.push({ id: "syn" + i, lon: base[0] + 0.0005 * i, lat: base[1] + 0.0003, radius: [30, 60, 200, 140][i],
                zoneR: 25, gain: 0.9, bed: i !== 2 });
}

let seed = 42;
const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const f = (x) => (Number.isFinite(x) ? x.toPrecision(17) : "inf");
const out = [];
out.push(`C ${ZONE_MARGIN} ${ZONE_COOLDOWN} ${FADE_FROM} ${LEASH} ${MAX_VOICES}`);
routes.forEach((r) => out.push(`R ${r.c.length} ` + r.c.map((p) => f(p[0]) + " " + f(p[1])).join(" ")));
points.forEach((p) => out.push(`P ${f(p.lon)} ${f(p.lat)} ${f(p.radius)} ${f(p.zoneR)} ${f(p.gain)} ${p.bed ? 1 : 0}`));

const metrics = routes.map((r) => js.routeMetrics({ geometry: { coordinates: r.c } }));
const list = routes.map((r, i) => ({ id: r.id, f: null, m: metrics[i] }));
const zones = points.map(() => ({ inside: false, firedAt: -1e12 }));
let steps = 0;

for (let walk = 0; walk < 6; walk++) {
  /* a continuous walk: 5 m-ish steps, starting on a random route vertex, drifting off and back */
  const r0 = routes[walk % routes.length].c;
  let pos = [...r0[Math.floor(rand() * r0.length)]], heading = rand() * 2 * Math.PI, now = walk * 1e7;
  let current = null;
  for (let s = 0; s < 700; s++, steps++) {
    heading += (rand() - 0.5) * 0.8;
    const k = Math.cos(pos[1] * Math.PI / 180);
    pos = [pos[0] + 0.00006 * Math.cos(heading) / k, pos[1] + 0.00006 * Math.sin(heading)];
    now += 1000;
    const margin = 8 + rand() * 32;   /* sectorHold's range, 8-40 m */
    out.push(`W ${f(pos[0])} ${f(pos[1])} ${f(now)} ${f(margin)} ${current === null ? -1 : list.findIndex((x) => x.id === current)}`);
    metrics.forEach((m, i) => {
      const p = js.projectToRoute(m, pos);
      out.push(`E proj ${i} ${f(p.dist)} ${f(p.t)} ${f(p.along)}`);
      const t = rand(), q = js.pointAlong(m, t);
      out.push(`E along ${i} ${f(t)} ${f(q[0])} ${f(q[1])}`);
    });
    const near = js.nearestRoute(list, pos, current, margin);
    out.push(`E near ${near ? list.findIndex((x) => x.id === near.id) : -1} ${f(near ? near.dist : 0)} ${f(near ? near.t : 0)}`);
    current = near ? near.id : null;
    out.push(`E level ${f(js.walkLevel(near ? near.dist : Infinity, FADE_FROM, LEASH))}`);
    const d = points.map((p) => js.segment(pos, [p.lon, p.lat]));
    points.forEach((p, i) => {
      const prox = Math.max(0, 1 - d[i] / p.radius);                 /* ensureVoice, index.html ~9692 */
      out.push(`E gain ${i} ${f(d[i])} ${f(Math.pow(prox, 1.5) * p.gain)}`);
      const z = zones[i];                                            /* pacerCheckZones, ~7251 */
      let ev = 0;
      const dz = js.segment(pos, [p.lon, p.lat]);
      if (!z.inside && dz <= p.zoneR && now - z.firedAt > ZONE_COOLDOWN) { z.inside = true; z.firedAt = now; ev = 1; }
      else if (z.inside && dz > p.zoneR * ZONE_MARGIN) { z.inside = false; ev = -1; }
      out.push(`E zone ${i} ${ev}`);
    });
    const tagged = points.map((p, i) => ({ i, d: d[i], p }));
    const bed = tagged.filter((x) => x.p.bed).sort((a, b) => a.d - b.d)           /* updateBed, ~10808 */
      .slice(0, MAX_VOICES).filter((x) => x.d <= x.p.radius).map((x) => x.i);
    const rhy = tagged.filter((x) => x.p.bed).filter((x) => x.d <= x.p.radius)       /* updateRhythms, ~10840 */
      .sort((a, b) => a.d - b.d).slice(0, MAX_VOICES).map((x) => x.i);
    out.push(`E pick0 ${bed.length} ${bed.join(" ")}`.trim());
    out.push(`E pick1 ${rhy.length} ${rhy.join(" ")}`.trim());
  }
}
/* placeAt over places.geojson: the park underfoot, first match in file order (index.html ~6946). */
const places = JSON.parse(readFileSync("places.geojson", "utf8")).features;
const placeAt = new Function("places", src("pointInRing") + src("placeAt") + "; return placeAt;")(places);
places.forEach((p) => out.push(`L ${p.geometry.coordinates.length} ` + p.geometry.coordinates.map((poly) =>
  poly[0].length + " " + poly[0].map((c) => f(c[0]) + " " + f(c[1])).join(" ")).join(" ")));
let W = 180, E = -180, S = 90, N = -90;
places.forEach((p) => p.geometry.coordinates.forEach((poly) => poly[0].forEach((c) => {
  W = Math.min(W, c[0]); E = Math.max(E, c[0]); S = Math.min(S, c[1]); N = Math.max(N, c[1]); })));
let placeHits = 0;
for (let i = 0; i < 2000; i++) {
  const pos = [W + (E - W) * rand(), S + (N - S) * rand()], hit = placeAt(pos);
  if (hit) { placeHits++; }
  out.push(`A ${f(pos[0])} ${f(pos[1])} ${hit ? places.indexOf(hit) : -1}`);
}
console.log(`placeAt: 2000 positions, ${placeHits} inside a park`);
mkdirSync("build/place", { recursive: true });
writeFileSync("build/place/cases.txt", out.join("\n") + "\n");
console.log(`${routes.length} routes (${features.filter((x) => x.kind === "route").length} published), ${points.length} points (${features.filter((x) => x.kind === "point").length} published), ${steps} steps`);
