// tests/sectors.test.mjs — a place divided into n sections of equal area.
/* Kerem, 2026-09-19: "if I say 7 sections it should create the seven divisions to the park's
   area, not fixed section size". Until then the sections were cut around the route and
   differed in size on purpose. These run the page's own solver against real boundaries. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8").replace(/\r\n/g, "\n");
function src(name) {
  const s = html.indexOf("function " + name + "(");
  assert.ok(s !== -1, "missing " + name);
  let i = html.indexOf("{", html.indexOf(")", s)), d = 0;
  for (; i < html.length; i++) { if (html[i] === "{") d++; else if (html[i] === "}") { d--; if (!d) break; } }
  return html.slice(s, i + 1);
}
const equalAreaSectors = new Function(src("equalAreaSectors") + "; return equalAreaSectors;")();

const places = JSON.parse(readFileSync("places.geojson", "utf8"));
const shoelace = (r) => {
  let s = 0;
  for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length]; s += a[0] * b[1] - b[0] * a[1]; }
  return Math.abs(s / 2);
};
function ringOf(id) {
  const f = places.features.find((p) => p.properties.id === id || p.properties.name === id);
  assert.ok(f, "no place " + id);
  const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
  let main = polys.map((p) => p[0]).sort((a, b) => shoelace(b) - shoelace(a))[0];
  if (main[0][0] === main.at(-1)[0] && main[0][1] === main.at(-1)[1]) { main = main.slice(0, -1); }
  const lat = main.reduce((s, c) => s + c[1], 0) / main.length, kx = Math.cos(lat * Math.PI / 180);
  return main.map((c) => [c[0] * kx, c[1]]);
}

/* Validebağ and Belgrad are where he walks; Moda Parkı at ten sections is the case a fixed
   weight step stalled on, 10.7 % out, before each section got a step of its own. */
for (const place of ["W153690111", "R8845862", "Moda Parkı"]) {
  test(place + ": every section holds 1/n of the area, for 3 to 12 sections", () => {
    const ring = ringOf(place), total = shoelace(ring);
    for (let n = 3; n <= 12; n++) {
      const r = equalAreaSectors(ring, n);
      assert.ok(r, "solved at n=" + n);
      assert.equal(r.cells.length, n);
      r.areas.forEach((a, i) => assert.ok(Math.abs(a / (total / n) - 1) < 0.005,
        `n=${n} section ${i + 1} is ${((a / (total / n) - 1) * 100).toFixed(2)} % off its share`));
      const sum = r.areas.reduce((x, y) => x + y, 0);
      /* Floating point, not a hole: measured at most 2.5e-6 of Moda's area, a small park where
         the rounding is relatively largest; Belgrad sums to within 1e-10. */
      assert.ok(Math.abs(sum / total - 1) < 1e-5, "the sections cover the whole place, no gaps, no overlap");
    }
  });
}

test("the same place and count always give the same sections", () => {
  const ring = ringOf("W153690111");
  assert.deepEqual(equalAreaSectors(ring, 7).seeds, equalAreaSectors(ring, 7).seeds,
    "a sector's chord must not move between visits");
});

test("the walker's section is chosen by the same weighted distance the sections were cut by", () => {
  assert.match(src("sectorAt"), /sectorPower\(pos, i\)/);
  assert.match(src("sectorPower"), /- sect\.weights\[i\]/);
  assert.match(src("sectorUpdate"), /Math\.max\(8, Math\.min\(40, 0\.06 \* sect\.width\)\)/,
    "a switch needs the walker clearly over the line, in metres");
});

test("the whole place is divided, not a box around the route, and a new place re-cuts", () => {
  const g = src("sectorGeometry");
  assert.match(g, /sect\.frame && sect\.frame\.length > 2 \? sect\.frame : null/);
  assert.match(g, /equalAreaSectors\(ring\.map\(toPlanar\), n\)/);
  assert.match(html, /if \(pacer\) \{ sectorGeometry\(pacer\.m, pacer\.patch\.sect\.n\); sect\.idx = null; \}/);
});

test("the park under the walker is found from the catalogue, and nothing outside one", () => {
  const placeAt = new Function("places",
    src("pointInRing") + src("placeAt") + "; return placeAt;")(places.features);
  const valide = places.features.find((p) => p.properties.id === "W153690111");
  const inside = valide.geometry.type === "Polygon"
    ? valide.geometry.coordinates[0][0] : valide.geometry.coordinates[0][0][0];
  /* A point far out in the Black Sea belongs to no park. [28.5, 40.5], the brief's own choice,
     turned out to lie inside R19349776 (Marmara Denizi ve Adalar Özel Çevre Koruma Bölgesi, a
     12,231 km² catalogue entry covering the whole Marmara Sea and its islands) — confirmed by
     running placeAt against the live catalogue, not assumed. This point sits north of every
     place's bbox (max lat 41.25358 across all 90). */
  assert.equal(placeAt([29.0, 41.6]), null);
  assert.ok(placeAt([29.0434, 41.0155]), "a point inside Validebağ resolves to a park");
});
