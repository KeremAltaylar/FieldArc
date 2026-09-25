// Replays build/place/sections.txt (sections_cases.mjs, the web app's own JS) through the C++
// sections and fails on any disagreement beyond rounding. From the repo root:
//   node core/tests/sections_cases.mjs
//   c++ -std=c++17 -O2 core/sections.cpp core/tests/sections_test.cpp -o st && ./st build/place/sections.txt
#include "../fieldscape.h"
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

static std::map<std::string, double> worst;
static std::map<std::string, long> count;
static int bad = 0;

static void near(const char *what, double got, double want, double scale = 1) {
    count[what]++;
    double e = std::fabs(got - want) / std::fmax(scale, std::fabs(want));
    if (e > worst[what]) worst[what] = e;
    if (e > 1e-9 && bad++ < 10) std::printf("MISMATCH %s: c++ %.17g js %.17g\n", what, got, want);
}
static void same(const char *what, long got, long want) {
    count[what]++;
    if (got != want && bad++ < 10) std::printf("MISMATCH %s: c++ %ld js %ld\n", what, got, want);
}

int main(int argc, char **argv) {
    std::ifstream in(argc > 1 ? argv[1] : "build/place/sections.txt");
    if (!in) { std::puts("no cases: run node core/tests/sections_cases.mjs first"); return 2; }
    std::vector<std::vector<double>> rings;
    double area_km2 = 0;
    std::vector<double> frame;
    fs_sections *s = nullptr;
    int current = -1, seed_i = 0;
    std::string line;
    while (std::getline(in, line)) {
        std::istringstream ss(line);
        std::string k; ss >> k;
        if (k == "PLACE") { int n; ss >> area_km2 >> n; rings.clear(); }
        else if (k == "RING") {
            int n; ss >> n; std::vector<double> r(2 * n);
            for (auto &v : r) ss >> v;
            rings.push_back(r);
        } else if (k == "FRAME") {
            int which, n; ss >> which >> n;
            std::vector<double> want(2 * n);
            for (auto &v : want) ss >> v;
            std::vector<const double *> ptrs; std::vector<int> counts; size_t most = 0;
            for (auto &r : rings) { ptrs.push_back(r.data()); counts.push_back((int)r.size() / 2); most = std::max(most, r.size()); }
            frame.assign(most, 0);
            int got_which = -1;
            int m = fs_place_frame(ptrs.data(), counts.data(), (int)rings.size(), area_km2, frame.data(), &got_which);
            same("frame ring chosen", got_which, which);
            same("frame points", m, n);
            for (int i = 0; i < std::min(m, n) * 2; i++) near("frame coords", frame[i], want[i]);
            frame.resize(2 * m);
        } else if (k == "CUT") {
            int n, got; ss >> n >> got;
            if (s) fs_sections_destroy(s);
            s = fs_sections_create(frame.data(), (int)frame.size() / 2, n);
            same("cut succeeds", s != nullptr, got > 0);
            if (!s) continue;
            double width; ss >> width;
            same("section count", fs_sections_count(s), got);
            near("section width", fs_sections_width(s), width);
            current = -1; seed_i = 0;
        } else if (k == "SEED" && s) {
            double lon, lat, w, glon, glat; ss >> lon >> lat >> w;
            fs_sections_seed(s, seed_i, &glon, &glat);
            near("seed", glon, lon); near("seed", glat, lat);
            near("weight", fs_sections_weight(s, seed_i), w, 1e-6);   /* weights are deg^2: compare against a floor */
            seed_i++;
        } else if (k == "STEP" && s) {
            double lon, lat; int at, idx; ss >> lon >> lat >> at >> idx;
            same("section at", fs_sections_at(s, lon, lat), at);
            current = fs_sections_step(s, current, lon, lat);
            same("section held", current, idx);
        }
    }
    if (s) fs_sections_destroy(s);
    for (auto &c : count) std::printf("%-18s %7ld compared, worst relative error %.2g\n", c.first.c_str(), c.second, worst[c.first]);
    std::puts(bad ? "FAIL" : "PASS");
    return bad ? 1 : 0;
}
