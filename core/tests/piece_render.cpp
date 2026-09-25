/* Renders the piece along a walk and reports what it measures: level per 10 s, peak, NaN, and the
   time it took against the audio it made.

     piece_render <patch.json|-> <seconds> <out.wav> [rhythm.json hits.wav|grains.wav]

   The walk goes from the start of the route to its end at 8 m off it; halfway through it steps
   150 m away (the leash) and back, and a zone fires every 20 s. */
#include "../fieldscape.h"
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

static std::string slurp(const char *path) {
    FILE *f = std::fopen(path, "rb");
    if (!f) return "";
    std::string s; static char buf[65536]; size_t n;
    while ((n = std::fread(buf, 1, sizeof buf, f)) > 0) s.append(buf, n);
    std::fclose(f);
    return s;
}

static void wav(const char *path, const std::vector<float> &L, const std::vector<float> &R, int sr) {
    FILE *f = std::fopen(path, "wb");
    if (!f) return;
    int n = (int)L.size(), bytes = n * 4;
    auto u32 = [&](unsigned v) { std::fwrite(&v, 4, 1, f); };
    auto u16 = [&](unsigned short v) { std::fwrite(&v, 2, 1, f); };
    std::fwrite("RIFF", 1, 4, f); u32(36 + bytes); std::fwrite("WAVEfmt ", 1, 8, f);
    u32(16); u16(1); u16(2); u32(sr); u32(sr * 4); u16(4); u16(16);
    std::fwrite("data", 1, 4, f); u32(bytes);
    for (int i = 0; i < n; i++) {
        short a = (short)std::lround(std::fmax(-1.0f, std::fmin(1.0f, L[i])) * 32767);
        short b = (short)std::lround(std::fmax(-1.0f, std::fmin(1.0f, R[i])) * 32767);
        u16(a); u16(b);
    }
    std::fclose(f);
}

/* a 16-bit mono/stereo WAV (the hit recordings are WAVs) */
static short *read_wav(const char *path, int &ch, long long &frames) {
    std::string s = slurp(path);
    if (s.size() < 44 || s.compare(0, 4, "RIFF")) return nullptr;
    size_t p = 12; ch = 1; int bits = 16;
    while (p + 8 <= s.size()) {
        std::string id = s.substr(p, 4); unsigned len; std::memcpy(&len, &s[p + 4], 4);
        if (id == "fmt ") { unsigned short c, b; std::memcpy(&c, &s[p + 10], 2); std::memcpy(&b, &s[p + 22], 2); ch = c; bits = b; }
        if (id == "data") {
            if (bits != 16) return nullptr;
            frames = len / (2 * ch);
            short *out = fs_alloc_i16((size_t)frames * ch);
            std::memcpy(out, &s[p + 8], (size_t)frames * ch * 2);
            return out;
        }
        p += 8 + len + (len & 1);
    }
    return nullptr;
}

int main(int argc, char **argv) {
    if (argc < 4) { std::fprintf(stderr, "usage: piece_render patch.json seconds out.wav [rhythm.json source.wav grains]\n"); return 1; }
    const int SR = 48000, BLOCK = 128;
    std::string patch = std::strcmp(argv[1], "-") ? slurp(argv[1]) : "{}";
    double seconds = std::atof(argv[2]);
    fs_device *d = fs_create("piece");
    auto t0 = std::chrono::steady_clock::now();
    fs_prepare(d, SR, BLOCK);
    auto t1 = std::chrono::steady_clock::now();
    int r = fs_piece_add_route(d, patch.c_str());
    int rh = -1;
    if (argc >= 6) {
        std::string rj = slurp(argv[4]);
        int grains = argc >= 7 && !std::strcmp(argv[6], "grains");
        rh = fs_piece_rhythm_add(d, rj.c_str(), grains);
        int ch = 0; long long frames = 0;
        for (int slot = 0; slot < (grains ? 1 : 4); slot++) {
            short *buf = read_wav(argv[5], ch, frames);
            if (buf) fs_piece_rhythm_source(d, rh, slot, ch, frames, buf);
        }
        fs_piece_rhythm_gain(d, rh, 0.6f);
    }
    long long total = (long long)(seconds * SR);
    std::vector<float> L(total), R(total);
    double peak = 0; long long nan = 0;
    std::vector<double> sums((size_t)(seconds / 10) + 1, 0.0);
    double proc_ms = 0, worst = 0;
    for (long long f = 0; f < total; f += BLOCK) {
        double t = (double)f / SR;
        double u = t / seconds;
        double dist = (u > 0.45 && u < 0.55) ? 150 : 8;
        if (f % (SR / 2) == 0) {
            fs_piece_walk(d, r, u, dist);
            if (f % (SR * 20) == SR * 5) fs_piece_zone(d, (f / (SR * 20)) % 2 ? "water" : "flower");
        }
        auto a = std::chrono::steady_clock::now();
        fs_process(d, BLOCK);
        double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - a).count();
        proc_ms += ms; if (ms > worst) worst = ms;
        const float *l = fs_out(d, 0), *rr = fs_out(d, 1);
        for (int i = 0; i < BLOCK && f + i < total; i++) {
            float x = l[i], y = rr[i];
            if (std::isnan(x) || std::isnan(y)) { nan++; x = y = 0; }
            L[f + i] = x; R[f + i] = y;
            peak = std::fmax(peak, std::fmax(std::fabs(x), std::fabs(y)));
            sums[(size_t)(t / 10)] += x * x + y * y;
        }
    }
    std::printf("prepare %.0f ms; route %d rhythm %d\n", std::chrono::duration<double, std::milli>(t1 - t0).count(), r, rh);
    for (size_t k = 0; k < sums.size() && k * 10 < seconds; k++)
        std::printf("RESULT window %zu rms_db %.1f\n", k, 10 * std::log10(sums[k] / (2.0 * 10 * SR) + 1e-20));
    std::printf("RESULT peak_db %.2f nan %lld cpu_pct %.2f worst_block_ms %.3f block_ms %.3f\n", 20 * std::log10(peak + 1e-20), nan,
                100 * proc_ms / (seconds * 1000), worst, 1000.0 * BLOCK / SR);
    wav(argv[3], L, R, SR);
    fs_destroy(d);
    return 0;
}
