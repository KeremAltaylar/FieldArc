/* The place layer: how a position becomes the plain numbers the mix and the devices hear. Ported
   from the web app's index.html (segment, routeMetrics, projectToRoute, pointAlong, nearestRoute,
   walkLevel, the bed/rhythm proximity law, pacerCheckZones) so every platform walks the same
   piece; core/tests/place_test.cpp holds it to the JS on the same inputs. Doubles throughout,
   the same operations in the same order as the JS, so results agree to rounding. */
#include "fieldscape.h"

/* JavaScript rounds a*b+c twice; clang fuses it into one rounding on ARM by default. The ported
   code must round as the JS does, or iterative results drift from the web app's. */
#if defined(__clang__)
#pragma clang fp contract(off)
#endif

#include <algorithm>
#include <cmath>
#include <vector>

static const double PI = 3.141592653589793;

extern "C" double fs_geo_distance(double lon1, double lat1, double lon2, double lat2) {
    const double R = 6371000, r = PI / 180;
    double dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
    double la1 = lat1 * r, la2 = lat2 * r;
    double h = std::sin(dLat / 2) * std::sin(dLat / 2) +
               std::cos(la1) * std::cos(la2) * std::sin(dLon / 2) * std::sin(dLon / 2);
    return 2 * R * std::asin(std::sqrt(h));
}

struct fs_route { std::vector<double> x, y, cum; double total = 0; };

extern "C" {

fs_route *fs_route_create(const double *lonlat, int n) {
    if (n < 1 || !lonlat) return nullptr;
    fs_route *r = new fs_route();
    for (int i = 0; i < n; i++) { r->x.push_back(lonlat[2 * i]); r->y.push_back(lonlat[2 * i + 1]); }
    r->cum.push_back(0);
    for (int i = 1; i < n; i++) {
        r->total += fs_geo_distance(r->x[i - 1], r->y[i - 1], r->x[i], r->y[i]);
        r->cum.push_back(r->total);
    }
    return r;
}

void fs_route_destroy(fs_route *r) { delete r; }
double fs_route_length(const fs_route *r) { return r->total; }

/* Nearest point on the polyline (an equirectangular projection per segment, as the JS), and how
   far along the route that is, in metres and as a 0-1 fraction. */
fs_projection fs_route_project(const fs_route *m, double px0, double py0) {
    fs_projection best = { INFINITY, 0, 0, m->x[0], m->y[0] };
    for (size_t i = 1; i < m->x.size(); i++) {
        const double ax = m->x[i - 1], ay = m->y[i - 1], bx0 = m->x[i], by0 = m->y[i];
        const double kx = std::cos(ay * PI / 180);
        const double bx = (bx0 - ax) * kx, by = by0 - ay;
        const double px = (px0 - ax) * kx, py = py0 - ay;
        const double L = bx * bx + by * by;
        const double u = L ? std::max(0.0, std::min(1.0, (px * bx + py * by) / L)) : 0;
        const double qx = ax + (bx0 - ax) * u, qy = ay + (by0 - ay) * u;
        const double d = fs_geo_distance(qx, qy, px0, py0);
        if (d < best.dist) {
            best.dist = d; best.lon = qx; best.lat = qy;
            best.along = m->cum[i - 1] + fs_geo_distance(ax, ay, qx, qy);
        }
    }
    best.t = m->total ? best.along / m->total : 0;
    return best;
}

void fs_route_point_along(const fs_route *m, double t, double *lon, double *lat) {
    const double d = std::max(0.0, std::min(1.0, t)) * m->total;
    for (size_t i = 1; i < m->x.size(); i++) {
        if (m->cum[i] >= d) {
            const double seg = m->cum[i] - m->cum[i - 1];
            const double u = seg ? (d - m->cum[i - 1]) / seg : 0;
            *lon = m->x[i - 1] + (m->x[i] - m->x[i - 1]) * u;
            *lat = m->y[i - 1] + (m->y[i] - m->y[i - 1]) * u;
            return;
        }
    }
    *lon = m->x.back(); *lat = m->y.back();
}

/* Which route the walker hears. The current one keeps the walk until another is nearer by more
   than `margin` metres (hysteresis, rulebook A-14). -1 when there are no routes. */
int fs_nearest_route(const fs_route *const *routes, int n, double lon, double lat, int current,
                     double margin, fs_projection *out) {
    int best = -1; fs_projection bp{}, cp{};
    for (int i = 0; i < n; i++) {
        fs_projection p = fs_route_project(routes[i], lon, lat);
        if (best < 0 || p.dist < bp.dist) { best = i; bp = p; }
        if (i == current) cp = p;
    }
    if (best < 0) return -1;
    if (current >= 0 && current < n && best != current && cp.dist - bp.dist < margin) { *out = cp; return current; }
    *out = bp;
    return best;
}

/* Full level until `from` metres off the route, silent at `leash`, a cosine between. */
double fs_walk_level(double dist, double from, double leash) {
    if (!(dist > from)) return 1;
    if (dist >= leash) return 0;
    return (1 + std::cos(PI * (dist - from) / (leash - from))) / 2;
}

double fs_point_proximity(double dist, double radius) { return std::max(0.0, 1 - dist / radius); }
double fs_point_gain(double dist, double radius, double gain) { return std::pow(fs_point_proximity(dist, radius), 1.5) * gain; }

/* Entering at the radius, leaving at radius x margin, re-entering only after a cooldown:
   asymmetric so a fix jittering on the boundary does not retrigger. +1 enter, -1 exit, 0 none. */
int fs_zone_step(fs_zone_state *z, double dist, double radius, double now_ms, double margin, double cooldown_ms) {
    if (!z->inside && dist <= radius && now_ms - z->fired_at_ms > cooldown_ms) {
        z->inside = 1; z->fired_at_ms = now_ms; return 1;
    }
    if (z->inside && dist > radius * margin) { z->inside = 0; return -1; }
    return 0;
}

/* pointInRing: the even-odd ray cast placeAt uses to find the park underfoot. */
int fs_point_in_ring(double lon, double lat, const double *ring, int n) {
    int c = 0;
    for (int k = 0, j = n - 1; k < n; j = k++) {
        const double kx = ring[2 * k], ky = ring[2 * k + 1], jx = ring[2 * j], jy = ring[2 * j + 1];
        if ((ky > lat) != (jy > lat) && lon < (jx - kx) * (lat - ky) / (jy - ky) + kx) c = !c;
    }
    return c;
}

/* Which points sound: eligible ones, nearest first, at most max_voices, within their radius.
   radius_first = 0 is the web bed's order (nearest max_voices, then drop those outside their
   radius); 1 is the rhythm order (drop first, then nearest max_voices). Writes indices into out,
   returns how many. Stable for equal distances, like Array.prototype.sort. */
int fs_pick_voices(const double *dist, const double *radius, const unsigned char *eligible, int n,
                   int max_voices, int radius_first, int *out) {
    std::vector<int> idx;
    for (int i = 0; i < n; i++)
        if (eligible[i] && (!radius_first || dist[i] <= radius[i])) idx.push_back(i);
    std::stable_sort(idx.begin(), idx.end(), [&](int a, int b) { return dist[a] < dist[b]; });
    if ((int)idx.size() > max_voices) idx.resize(max_voices);
    int k = 0;
    for (int i : idx) if (radius_first || dist[i] <= radius[i]) out[k++] = i;
    return k;
}

}
