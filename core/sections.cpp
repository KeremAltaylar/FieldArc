/* Sections: a place divided into n equal-area parts, and which part the walker is in. Ported from
   index.html (ringArea, simplify, setPlaceFrame's frame, sectorGeometry, equalAreaSectors,
   sectorPower, sectorAt, sectorUpdate) with the operations in the same order, so the parity test
   (core/tests/sections_test.cpp) can hold it to the JS on all 90 places in places.geojson.

   The frame is the largest polygon's outer ring, simplified; the sections are a power diagram cut
   from it, weights tuned until every cell holds 1/n of the area. Planar coordinates are
   [lon * kx, lat], kx the cosine of the frame's mean latitude, as the web's toPlanar. */
#include "fieldscape.h"

/* JavaScript rounds a*b+c twice; clang fuses it into one rounding on ARM by default. The ported
   code must round as the JS does, or iterative results drift from the web app's. */
#if defined(__clang__)
#pragma clang fp contract(off)
#endif

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <vector>

namespace {

const double PI = 3.141592653589793;
struct P { double x, y; };
typedef std::vector<P> Poly;

Poly clip(const Poly &poly, double nx, double ny, double d) {
    Poly out;
    for (size_t k = 0; k < poly.size(); k++) {
        const P &p = poly[k], &q = poly[(k + 1) % poly.size()];
        double dp = nx * p.x + ny * p.y - d, dq = nx * q.x + ny * q.y - d;
        if (dp <= 0) out.push_back(p);
        if ((dp <= 0) != (dq <= 0)) {
            double t = dp / (dp - dq);
            out.push_back({ p.x + (q.x - p.x) * t, p.y + (q.y - p.y) * t });
        }
    }
    return out;
}

double area(const Poly &p) {
    double s = 0;
    for (size_t k = 0; k < p.size(); k++) {
        const P &a = p[k], &b = p[(k + 1) % p.size()];
        s += a.x * b.y - b.x * a.y;
    }
    return s / 2;
}

bool centroid(const Poly &p, P &out) {
    double A = 0, cx = 0, cy = 0;
    for (size_t k = 0; k < p.size(); k++) {
        const P &a = p[k], &b = p[(k + 1) % p.size()];
        double c = a.x * b.y - b.x * a.y;
        A += c; cx += (a.x + b.x) * c; cy += (a.y + b.y) * c;
    }
    if (std::fabs(A) < 1e-18) return false;
    out = { cx / (3 * A), cy / (3 * A) };
    return true;
}

bool inside(const P &pt, const Poly &p) {
    bool c = false;
    for (size_t k = 0, j = p.size() - 1; k < p.size(); j = k++) {
        if ((p[k].y > pt.y) != (p[j].y > pt.y) &&
            pt.x < (p[j].x - p[k].x) * (pt.y - p[k].y) / (p[j].y - p[k].y) + p[k].x) c = !c;
    }
    return c;
}

/* cos as V8's Math.cos computes it: fdlibm (Sun, freely distributable), which V8 ships. Libm's
   cos differs in the last bit for 11 of the 90 places' mean latitudes, and the 600-pass solver
   grows that bit into different seeds and weights. Covers |x| < 3pi/4, i.e. any latitude; beyond
   that it falls back to libm. */
double js_cos(double x) {
    auto hi = [](double v) { uint64_t b; std::memcpy(&b, &v, 8); return (int32_t)(b >> 32); };
    auto kcos = [&](double x, double y) {
        const double C1 = 4.16666666666666019037e-02, C2 = -1.38888888888741095749e-03, C3 = 2.48015872894767294178e-05,
                     C4 = -2.75573143513906633035e-07, C5 = 2.08757232129817482790e-09, C6 = -1.13596475577881948265e-11;
        int32_t ix = hi(x) & 0x7fffffff;
        if (ix < 0x3e400000 && (int)x == 0) return 1.0;
        double z = x * x, r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
        if (ix < 0x3FD33333) return 1.0 - (0.5 * z - (z * r - x * y));
        double qx;
        if (ix > 0x3fe90000) qx = 0.28125;
        else { uint64_t b = (uint64_t)(uint32_t)(ix - 0x00200000) << 32; std::memcpy(&qx, &b, 8); }
        double hz = 0.5 * z - qx, a = 1.0 - qx;
        return a - (hz - (z * r - x * y));
    };
    auto ksin = [](double x, double y) {           /* __kernel_sin with iy = 1 */
        const double S1 = -1.66666666666666324348e-01, S2 = 8.33333333332248946124e-03, S3 = -1.98412698298579493134e-04,
                     S4 = 2.75573137070700676789e-06, S5 = -2.50507602534068634195e-08, S6 = 1.58969099521155010221e-10;
        double z = x * x, v = z * x, r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
        return x - ((z * (0.5 * y - v * r) - y) - v * S1);
    };
    int32_t hx = hi(x), ix = hx & 0x7fffffff;
    if (ix <= 0x3fe921fb) return kcos(x, 0.0);                          /* |x| <= pi/4 */
    if (ix >= 0x4002d97c) return std::cos(x);                            /* past 3pi/4: not a latitude */
    const double pio2_1 = 1.57079632673412561417e+00, pio2_1t = 6.07710050650619224932e-11,
                 pio2_2 = 6.07710050630396597660e-11, pio2_2t = 2.02226624879595063154e-21;
    double z, y0, y1;                                                    /* __ieee754_rem_pio2, n = +-1 */
    if (hx > 0) {
        z = x - pio2_1;
        if (ix != 0x3ff921fb) { y0 = z - pio2_1t; y1 = (z - y0) - pio2_1t; }
        else { z -= pio2_2; y0 = z - pio2_2t; y1 = (z - y0) - pio2_2t; }
        return -ksin(y0, y1);
    }
    z = x + pio2_1;
    if (ix != 0x3ff921fb) { y0 = z + pio2_1t; y1 = (z - y0) + pio2_1t; }
    else { z += pio2_2; y0 = z + pio2_2t; y1 = (z - y0) + pio2_2t; }
    return ksin(y0, y1);
}

double d2(const P &p, const P &q) { double dx = p.x - q.x, dy = p.y - q.y; return dx * dx + dy * dy; }

Poly cell(const Poly &ring, const std::vector<P> &seeds, const std::vector<double> &w, size_t i) {
    Poly poly = ring;
    const P &a = seeds[i];
    for (size_t j = 0; j < seeds.size() && poly.size(); j++) {
        if (j == i) continue;
        const P &b = seeds[j];
        double nx = b.x - a.x, ny = b.y - a.y;
        double d = (b.x * b.x + b.y * b.y - a.x * a.x - a.y * a.y + w[i] - w[j]) / 2;
        poly = clip(poly, nx, ny, d);
    }
    return poly;
}

}

struct fs_sections {
    double kx = 1, target = 0, worst = 1;
    int iterations = 0;
    std::vector<P> seeds;            /* planar */
    std::vector<double> w;
    std::vector<Poly> cells;         /* planar */
};

extern "C" {

double fs_ring_area(const double *r, int n) {
    double s = 0, rad = PI / 180, R = 6371008.8;
    for (int i = 0; i < n; i++) {
        const double *a = r + 2 * i, *b = r + 2 * ((i + 1) % n);
        s += (b[0] - a[0]) * rad * (2 + std::sin(a[1] * rad) + std::sin(b[1] * rad));
    }
    return std::fabs(s * R * R / 2);
}

/* Douglas-Peucker in a local equirectangular frame, as the web's simplify; out may hold n points. */
int fs_simplify(const double *pts, int n, double tol, double *out) {
    if (n < 3) { for (int i = 0; i < 2 * n; i++) out[i] = pts[i]; return n; }
    const double kx = js_cos(pts[1] * PI / 180);
    auto perp = [&](int p, int a, int b) {
        double px = (pts[2 * p] - pts[2 * a]) * kx, py = pts[2 * p + 1] - pts[2 * a + 1];
        double bx = (pts[2 * b] - pts[2 * a]) * kx, by = pts[2 * b + 1] - pts[2 * a + 1];
        double len = bx * bx + by * by;
        double t = len ? std::max(0.0, std::min(1.0, (px * bx + py * by) / len)) : 0;
        double dx = px - bx * t, dy = py - by * t;
        return std::sqrt(dx * dx + dy * dy);
    };
    std::vector<char> keep(n, 0);
    keep[0] = keep[n - 1] = 1;
    std::vector<std::pair<int, int>> stack{ { 0, n - 1 } };
    while (!stack.empty()) {
        auto seg = stack.back(); stack.pop_back();
        int a = seg.first, z = seg.second, idx = -1; double maxD = 0;
        for (int i = a + 1; i < z; i++) { double d = perp(i, a, z); if (d > maxD) { maxD = d; idx = i; } }
        if (idx > 0 && maxD > tol) { keep[idx] = 1; stack.push_back({ a, idx }); stack.push_back({ idx, z }); }
    }
    int k = 0;
    for (int i = 0; i < n; i++) if (keep[i]) { out[2 * k] = pts[2 * i]; out[2 * k + 1] = pts[2 * i + 1]; k++; }
    return k;
}

/* setPlaceFrame: of a place's polygons (outer rings, closed as GeoJSON has them), the largest by
   area, simplified (0.0003 over 5 km2, else 0.00008), the closing duplicate dropped. Returns the
   frame's point count written to out (room for the largest ring), and which ring it came from. */
int fs_place_frame(const double *const *rings, const int *counts, int nrings, double area_km2, double *out, int *which) {
    int best = 0;
    for (int i = 1; i < nrings; i++)
        if (fs_ring_area(rings[i], counts[i]) > fs_ring_area(rings[best], counts[best])) best = i;
    if (which) *which = best;
    int k = fs_simplify(rings[best], counts[best], area_km2 > 5 ? 0.0003 : 0.00008, out);
    if (k > 2 && out[0] == out[2 * (k - 1)] && out[1] == out[2 * (k - 1) + 1]) k--;
    return k;
}

/* sectorGeometry's stand-in when no place is loaded: the route's box, padded 35%. Writes 4 points. */
void fs_route_frame(const double *lonlat, int n, double *out) {
    double W = 180, S = 90, E = -180, N = -90;
    for (int i = 0; i < n; i++) {
        double x = lonlat[2 * i], y = lonlat[2 * i + 1];
        if (x < W) W = x; if (x > E) E = x; if (y < S) S = y; if (y > N) N = y;
    }
    double padX = std::max((E - W) * 0.35, 0.004), padY = std::max((N - S) * 0.35, 0.003);
    double r[8] = { W - padX, S - padY, E + padX, S - padY, E + padX, N + padY, W - padX, N + padY };
    for (int i = 0; i < 8; i++) out[i] = r[i];
}

/* equalAreaSectors on a frame (open ring, lon/lat). NULL when the place is too small for n. */
fs_sections *fs_sections_create(const double *frame, int n_ring, int n) {
    if (n_ring < 3 || n < 1) return nullptr;
    double lat = 0;
    for (int i = 0; i < n_ring; i++) lat += frame[2 * i + 1];
    double kx = js_cos((lat / n_ring) * PI / 180);
    if (kx == 0) kx = 1e-6;
    Poly ring;
    for (int i = 0; i < n_ring; i++) ring.push_back({ frame[2 * i] * kx, frame[2 * i + 1] });

    const double total = std::fabs(area(ring)), target = total / n;
    const double orient = area(ring) < 0 ? -1 : 1;
    double W = INFINITY, S = INFINITY, E = -INFINITY, N = -INFINITY;
    for (auto &c : ring) { if (c.x < W) W = c.x; if (c.x > E) E = c.x; if (c.y < S) S = c.y; if (c.y > N) N = c.y; }
    const int G = 48;
    std::vector<P> samples;
    for (int gy = 0; gy < G; gy++)
        for (int gx = 0; gx < G; gx++) {
            P pt{ W + (gx + 0.5) / G * (E - W), S + (gy + 0.5) / G * (N - S) };
            if (inside(pt, ring)) samples.push_back(pt);
        }
    if ((int)samples.size() < n) return nullptr;
    P mid;
    if (!centroid(ring, mid)) mid = { (W + E) / 2, (S + N) / 2 };
    P first = samples[0];
    for (size_t k = 1; k < samples.size(); k++) if (d2(samples[k], mid) < d2(first, mid)) first = samples[k];
    std::vector<P> seeds{ first };
    std::vector<double> near(samples.size());
    for (size_t k = 0; k < samples.size(); k++) near[k] = d2(samples[k], seeds[0]);
    while ((int)seeds.size() < n) {
        size_t far = 0;
        for (size_t k = 1; k < samples.size(); k++) if (near[k] > near[far]) far = k;
        seeds.push_back(samples[far]);
        for (size_t k = 0; k < samples.size(); k++) near[k] = std::min(near[k], d2(samples[k], samples[far]));
    }
    for (int it = 0; it < 12; it++) {
        std::vector<double> sx(n, 0), sy(n, 0), sn(n, 0);
        for (auto &s : samples) {
            int best = 0; double bd = INFINITY;
            for (int m = 0; m < n; m++) { double dd = d2(s, seeds[m]); if (dd < bd) { bd = dd; best = m; } }
            sx[best] += s.x; sy[best] += s.y; sn[best]++;
        }
        for (int k = 0; k < n; k++) if (sn[k]) seeds[k] = { sx[k] / sn[k], sy[k] / sn[k] };
    }

    std::vector<double> w(n, 0), gain(n, 2 / PI), lastErr(n, 0), areas;
    std::vector<Poly> cells;
    double worst = 1;
    int it;
    for (it = 0; it < 600; it++) {
        cells.clear(); areas.clear(); worst = 0;
        for (int k = 0; k < n; k++) {
            Poly c = cell(ring, seeds, w, k);
            double a = c.size() > 2 ? orient * area(c) : 0;
            cells.push_back(c); areas.push_back(a);
            worst = std::max(worst, std::fabs(a - target) / target);
        }
        if (worst < 0.005) break;
        for (int k = 0; k < n; k++) {
            double err = target - areas[k];
            if (lastErr[k] != 0 && (err > 0) != (lastErr[k] > 0)) gain[k] *= 0.5;
            else if (lastErr[k] != 0) gain[k] = std::min(gain[k] * 1.15, 4.0);
            lastErr[k] = err;
            w[k] += gain[k] * err;
            if (it < 40) {
                P cc;
                if (cells[k].size() > 2 && centroid(cells[k], cc) && inside(cc, ring))
                    seeds[k] = { seeds[k].x + 0.3 * (cc.x - seeds[k].x), seeds[k].y + 0.3 * (cc.y - seeds[k].y) };
            }
        }
    }
    fs_sections *s = new fs_sections();
    s->kx = kx; s->target = target; s->worst = worst; s->iterations = it;
    s->seeds = seeds; s->w = w; s->cells = cells;
    return s;
}

void fs_sections_destroy(fs_sections *s) { delete s; }
int fs_sections_count(const fs_sections *s) { return (int)s->seeds.size(); }
double fs_sections_width(const fs_sections *s) { return std::sqrt(s->target) * 111320; }   /* metres, ~sqrt of a section's area */
double fs_sections_worst(const fs_sections *s) { return s->worst; }
int fs_sections_iterations(const fs_sections *s) { return s->iterations; }
double fs_sections_weight(const fs_sections *s, int i) { return s->w[i]; }
void fs_sections_seed(const fs_sections *s, int i, double *lon, double *lat) { *lon = s->seeds[i].x / s->kx; *lat = s->seeds[i].y; }

/* A section's outline in lon/lat; returns its point count (writes at most max points). */
int fs_sections_cell(const fs_sections *s, int i, double *out, int max) {
    const Poly &c = s->cells[i];
    for (int k = 0; k < (int)c.size() && k < max; k++) { out[2 * k] = c[k].x / s->kx; out[2 * k + 1] = c[k].y; }
    return (int)c.size();
}

static double power(const fs_sections *s, double lon, double lat, int i) {
    double px = lon * s->kx, py = lat, dx = px - s->seeds[i].x, dy = py - s->seeds[i].y;
    return dx * dx + dy * dy - s->w[i];
}

/* sectorAt: the section whose seed is nearest in power distance. */
int fs_sections_at(const fs_sections *s, double lon, double lat) {
    int best = 0; double bd = INFINITY;
    for (int i = 0; i < (int)s->seeds.size(); i++) { double d = power(s, lon, lat, i); if (d < bd) { bd = d; best = i; } }
    return best;
}

/* sectorUpdate: move to another section only once the walker is past the dividing line by
   6% of a section's width, held between 8 and 40 m. current < 0: no section yet. */
int fs_sections_step(const fs_sections *s, int current, double lon, double lat) {
    int i = fs_sections_at(s, lon, lat);
    if (current < 0 || i == current) return i;
    const P &a = s->seeds[current], &b = s->seeds[i];
    double gap = std::sqrt((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y));
    if (gap == 0) gap = 1e-12;
    double past = (power(s, lon, lat, current) - power(s, lon, lat, i)) / (2 * gap) * 111320;
    double hold = std::max(8.0, std::min(40.0, 0.06 * fs_sections_width(s)));
    return past > hold ? i : current;
}

/* sectorHold, the route-swap margin open world also uses; 200 m width when there are no sections. */
double fs_sections_hold(const fs_sections *s) { return std::max(8.0, std::min(40.0, 0.06 * (s ? fs_sections_width(s) : 200))); }

}
