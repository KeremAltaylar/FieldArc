/* Writes build/place/sections.txt: every place in places.geojson cut into 3, 7 and 12 sections by
   the web app's own functions, plus simulated walks across each, for sections_test.cpp to replay.

     node core/tests/sections_cases.mjs

   Extracted from index.html and run as they are: ringArea, simplify, toPlanar, fromPlanar,
   sectorGeometry, equalAreaSectors, sectorPower, sectorAt, sectorUpdate (its map redraw and toast
   stubbed). setPlaceFrame's frame choice is mirrored line for line (it also drives the map). */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const html = readFileSync("index.html", "utf8").replace(/\r\n/g, "\n");
function src(name) {
  const s = html.indexOf("function " + name + "(");
  if (s < 0) { throw new Error("missing " + name); }
  let i = html.indexOf("{", html.indexOf(")", s)), d = 0;
  for (; i < html.length; i++) { if (html[i] === "{") d++; else if (html[i] === "}") { d--; if (!d) break; } }
  return html.slice(s, i + 1);
}
const web = new Function(
  "var sect = { idx: null }, pacer = null, NOTE_NAMES = ['C'];" +
  "function drawSectors() {} function toast() {}" +
  ["ringArea", "simplify", "toPlanar", "fromPlanar", "sectorGeometry", "equalAreaSectors", "sectorPower", "sectorAt", "sectorUpdate"]
    .map(src).join("\n") +
  "; return { sect, ringArea, simplify, sectorGeometry, sectorAt, sectorUpdate," +
  "  setPacer: function (p) { pacer = p; } };")();

const places = JSON.parse(readFileSync("places.geojson", "utf8")).features;
const f = (x) => x.toPrecision(17);
let seed = 7;
const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const out = [];
let cuts = 0, steps = 0, failed = 0;

function cut(frame, n, label) {
  const S = web.sect;
  S.frame = frame; S.key = null; S.seeds = null; S.idx = null;
  web.sectorGeometry({ coords: [] }, n);
  if (!S.seeds) { out.push(`CUT ${n} 0`); failed++; return; }
  cuts++;
  out.push(`CUT ${n} ${S.seeds.length} ${f(S.width)} ${label}`);
  S.seeds.forEach((s, i) => out.push(`SEED ${f(s[0])} ${f(s[1])} ${f(S.weights[i])}`));
  /* a walk that wanders across the frame's box, one step ~ 1/60 of it */
  let W = 180, E = -180, So = 90, N = -90;
  frame.forEach((c) => { W = Math.min(W, c[0]); E = Math.max(E, c[0]); So = Math.min(So, c[1]); N = Math.max(N, c[1]); });
  let pos = [W + (E - W) * rand(), So + (N - So) * rand()], hd = rand() * 6.283;
  web.setPacer({ pos, patch: { sect: { on: true }, sectors: [{ r: 0, mode: "x" }], key: 0 } });
  for (let k = 0; k < 150; k++, steps++) {
    hd += (rand() - 0.5) * 0.6;
    pos = [Math.min(E, Math.max(W, pos[0] + Math.cos(hd) * (E - W) / 60)), Math.min(N, Math.max(So, pos[1] + Math.sin(hd) * (N - So) / 60))];
    web.setPacer({ pos, patch: { sect: { on: true }, sectors: [{ r: 0, mode: "x" }], key: 0 } });
    const at = web.sectorAt(pos);
    web.sectorUpdate();
    out.push(`STEP ${f(pos[0])} ${f(pos[1])} ${at} ${S.idx}`);
  }
}

for (const p of places) {
  const polys = p.geometry.coordinates;
  out.push(`PLACE ${f(p.properties.area_km2 || 0)} ${polys.length}`);
  polys.forEach((poly) => out.push(`RING ${poly[0].length} ` + poly[0].map((c) => f(c[0]) + " " + f(c[1])).join(" ")));
  /* setPlaceFrame, index.html ~3380 */
  const rings = polys.slice().sort((x, y) => web.ringArea(y[0]) - web.ringArea(x[0]));
  const which = polys.indexOf(rings[0]);
  const frame0 = web.simplify(rings[0][0], p.properties.area_km2 > 5 ? 0.0003 : 0.00008);
  const frame = (frame0.length > 2 && frame0[0][0] === frame0[frame0.length - 1][0] &&
                 frame0[0][1] === frame0[frame0.length - 1][1]) ? frame0.slice(0, -1) : frame0;
  out.push(`FRAME ${which} ${frame.length} ` + frame.map((c) => f(c[0]) + " " + f(c[1])).join(" "));
  for (const n of [3, 7, 12]) { cut(frame, n, "place"); }
}
mkdirSync("build/place", { recursive: true });
writeFileSync("build/place/sections.txt", out.join("\n") + "\n");
console.log(`${places.length} places, ${cuts} cuts (${failed} too small), ${steps} walk steps`);
