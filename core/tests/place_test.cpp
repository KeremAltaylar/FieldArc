// Replays build/place/cases.txt (written by place_cases.mjs from the web app's own JS) through the
// C++ place layer and fails on any disagreement beyond rounding. From the repo root:
//   node core/tests/place_cases.mjs
//   c++ -std=c++17 -O2 core/place.cpp core/tests/place_test.cpp -o pt && ./pt build/place/cases.txt
#include "../fieldscape.h"
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

static std::map<std::string, double> worst;
static std::map<std::string, int> count;
static int bad = 0;

static double num(std::istream &s) { std::string t; s >> t; return t == "inf" ? INFINITY : std::atof(t.c_str()); }

static void near(const char *what, double got, double want) {
    count[what]++;
    if (std::isinf(want) && std::isinf(got)) return;
    double e = std::fabs(got - want) / std::fmax(1.0, std::fabs(want));
    if (e > worst[what]) worst[what] = e;
    if (e > 1e-9 && bad++ < 10) std::printf("MISMATCH %s: c++ %.17g js %.17g\n", what, got, want);
}

static void same(const char *what, long got, long want) {
    count[what]++;
    if (got != want && bad++ < 10) std::printf("MISMATCH %s: c++ %ld js %ld\n", what, got, want);
}

int main(int argc, char **argv) {
    std::ifstream in(argc > 1 ? argv[1] : "build/place/cases.txt");
    if (!in) { std::puts("no cases file: run node core/tests/place_cases.mjs first"); return 2; }
    double margin_z = 0, cooldown = 0, from = 0, leash = 0; int maxv = 0;
    std::vector<fs_route *> routes;
    struct Pt { double lon, lat, radius, zoneR, gain; unsigned char bed; };
    std::vector<Pt> pts;
    std::vector<fs_zone_state> zones;
    std::vector<double> dist;
    double wlon = 0, wlat = 0, now = 0, margin = 0; int current = -1;
    std::string line;
    while (std::getline(in, line)) {
        std::istringstream s(line);
        std::string k; s >> k;
        if (k == "C") { margin_z = num(s); cooldown = num(s); from = num(s); leash = num(s); maxv = (int)num(s); }
        else if (k == "R") {
            int n = (int)num(s); std::vector<double> c(2 * n);
            for (auto &v : c) v = num(s);
            routes.push_back(fs_route_create(c.data(), n));
        } else if (k == "P") {
            Pt p; p.lon = num(s); p.lat = num(s); p.radius = num(s); p.zoneR = num(s); p.gain = num(s); p.bed = (unsigned char)num(s);
            pts.push_back(p); zones.push_back({ 0, -1e12 });
        } else if (k == "W") {
            wlon = num(s); wlat = num(s); now = num(s); margin = num(s); current = (int)num(s);
            dist.assign(pts.size(), 0);
            for (size_t i = 0; i < pts.size(); i++) dist[i] = fs_geo_distance(wlon, wlat, pts[i].lon, pts[i].lat);
        } else if (k == "E") {
            std::string e; s >> e;
            if (e == "proj") {
                int i = (int)num(s); fs_projection p = fs_route_project(routes[i], wlon, wlat);
                near("project dist", p.dist, num(s)); near("project t", p.t, num(s)); near("project along", p.along, num(s));
            } else if (e == "along") {
                int i = (int)num(s); double t = num(s), lon, lat;
                fs_route_point_along(routes[i], t, &lon, &lat);
                near("point along", lon, num(s)); near("point along", lat, num(s));
            } else if (e == "near") {
                fs_projection p{};
                int got = fs_nearest_route(routes.data(), (int)routes.size(), wlon, wlat, current, margin, &p);
                int want = (int)num(s); double wd = num(s), wt = num(s);
                same("nearest route", got, want);
                if (got >= 0) { near("nearest route dist", p.dist, wd); near("nearest route t", p.t, wt); }
                current = got;
            } else if (e == "level") {
                fs_projection p{};
                int r = fs_nearest_route(routes.data(), (int)routes.size(), wlon, wlat, current, margin, &p);
                near("walk level", fs_walk_level(r >= 0 ? p.dist : INFINITY, from, leash), num(s));
            } else if (e == "gain") {
                int i = (int)num(s);
                near("point distance", dist[i], num(s));
                near("point gain", fs_point_gain(dist[i], pts[i].radius, pts[i].gain), num(s));
            } else if (e == "zone") {
                int i = (int)num(s);
                same("zone event", fs_zone_step(&zones[i], dist[i], pts[i].zoneR, now, margin_z, cooldown), (long)num(s));
            } else if (e == "pick0" || e == "pick1") {
                std::vector<double> rad(pts.size()); std::vector<unsigned char> el(pts.size()); std::vector<int> out(pts.size());
                for (size_t i = 0; i < pts.size(); i++) { rad[i] = pts[i].radius; el[i] = pts[i].bed; }
                int n = fs_pick_voices(dist.data(), rad.data(), el.data(), (int)pts.size(), maxv, e == "pick1", out.data());
                int want = (int)num(s);
                same(e == "pick0" ? "bed voices" : "rhythm voices", n, want);
                for (int j = 0; j < want && j < n; j++) same("voice order", out[j], (long)num(s));
            }
        }
    }
    for (auto &c : count) std::printf("%-20s %6d compared, worst relative error %.2g\n", c.first.c_str(), c.second, worst[c.first]);

    /* The case the walks never hit: 4 nearer points outside their radii crowd out a 5th whose own
       radius reaches the walker. The bed order (radius last) loses it; the rhythm order keeps it. */
    const double d[5] = { 10, 20, 30, 40, 150 }, r[5] = { 5, 5, 5, 5, 200 };
    const unsigned char el[5] = { 1, 1, 1, 1, 1 };
    int o[5];
    int n0 = fs_pick_voices(d, r, el, 5, 4, 0, o);
    int n1 = fs_pick_voices(d, r, el, 5, 4, 1, o);
    std::printf("crowded: bed order picks %d, rhythm order picks %d (point %d)\n", n0, n1, n1 ? o[0] : -1);
    if (n0 != 0 || n1 != 1 || o[0] != 4) bad++;

    for (auto *rt : routes) fs_route_destroy(rt);
    std::puts(bad ? "FAIL" : "PASS");
    return bad ? 1 : 0;
}
