/* The C++ side of core/tests/piece_ref.mjs: the same patch, the same random draws, the same walk
   (start to end of the route over the render, synth level 1) and the same zones, written out as a
   WAV and a notes list for core/tests/piece_compare.py to hold against the web's.

     piece_compare <patch.json|-> <seconds> <draws> <out-prefix> [rhythm.json source.wav hits|grains]        -> <out-prefix>.cpp.wav, .cpp-notes.txt */
#include "../fieldscape.h"
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

static short *read_wav(const char *path, int &ch, long long &frames) {   /* 16-bit PCM */
    std::string s = slurp(path);
    if (s.size() < 44 || s.compare(0, 4, "RIFF")) return nullptr;
    size_t p = 12; ch = 1;
    while (p + 8 <= s.size()) {
        std::string id = s.substr(p, 4); unsigned len; std::memcpy(&len, &s[p + 4], 4);
        if (id == "fmt ") { unsigned short c; std::memcpy(&c, &s[p + 10], 2); ch = c; }
        if (id == "data") {
            frames = len / (2 * ch);
            short *out = fs_alloc_i16((size_t)frames * ch);
            std::memcpy(out, &s[p + 8], (size_t)frames * ch * 2);
            return out;
        }
        p += 8 + len + (len & 1);
    }
    return nullptr;
}

struct Draws { std::vector<double> v; size_t i = 0; };
static double next_draw(void *p) { Draws *d = (Draws *)p; return d->i < d->v.size() ? d->v[d->i++] : 0.5; }
static FILE *notes;
static void on_note(void *, int role, double f, double dur, double t, double vel) {
    if (role <= 3 || role >= 10) std::fprintf(notes, "%d %.12g %.12g %.12g %.12g\n", role, f, dur, t, vel);
}

int main(int argc, char **argv) {
    if (argc < 5) return 1;
    const int SR = 48000, BLOCK = 128;
    std::string patch = std::strcmp(argv[1], "-") ? slurp(argv[1]) : "{}";
    double seconds = std::atof(argv[2]);
    Draws dr;
    std::string raw = slurp(argv[3]);
    dr.v.resize(raw.size() / 8);
    std::memcpy(dr.v.data(), raw.data(), dr.v.size() * 8);
    std::string pre = argv[4];
    notes = std::fopen((pre + ".cpp-notes.txt").c_str(), "w");

    fs_device *d = fs_create("piece");
    fs_prepare(d, SR, BLOCK);
    fs_piece_test_hooks(d, next_draw, &dr, on_note, nullptr);
    fs_piece_test_walk(d, seconds);
    int r = fs_piece_add_route(d, patch.c_str());
    fs_piece_walk(d, r, 0, 0);
    if (argc >= 8) {                  /* one rhythm point, as piece_ref.mjs sets it up */
        std::string rj = slurp(argv[5]);
        int grains = !std::strcmp(argv[7], "grains");
        int h = fs_piece_rhythm_add(d, rj.c_str(), grains);
        for (int slot = 0; slot < (grains ? 1 : 4); slot++) {
            int ch = 0; long long frames = 0;
            short *buf = read_wav(argv[6], ch, frames);
            if (buf) fs_piece_rhythm_source(d, h, slot, ch, frames, buf);
        }
        fs_piece_rhythm_gain(d, h, 0.6f);
    }
    long long total = (long long)(seconds * SR);
    std::vector<short> pcm(total * 2);
    double next_zone = 5.1; int zi = 0;
    for (long long f = 0; f < total; f += BLOCK) {
        double t = (double)f / SR;
        if (t >= next_zone) { fs_piece_zone(d, (int)(next_zone / 20) % 2 ? "water" : "flower"); next_zone += 20; zi++; }
        fs_process(d, BLOCK);
        const float *l = fs_out(d, 0), *rr = fs_out(d, 1);
        for (int i = 0; i < BLOCK && f + i < total; i++) {
            pcm[2 * (f + i)] = (short)std::lround(std::fmax(-1.0, std::fmin(1.0, (double)l[i])) * 32767);
            pcm[2 * (f + i) + 1] = (short)std::lround(std::fmax(-1.0, std::fmin(1.0, (double)rr[i])) * 32767);
        }
    }
    std::fclose(notes);
    FILE *w = std::fopen((pre + ".cpp.wav").c_str(), "wb");
    unsigned bytes = (unsigned)(pcm.size() * 2);
    auto u32 = [&](unsigned v) { std::fwrite(&v, 4, 1, w); };
    auto u16 = [&](unsigned short v) { std::fwrite(&v, 2, 1, w); };
    std::fwrite("RIFF", 1, 4, w); u32(36 + bytes); std::fwrite("WAVEfmt ", 1, 8, w);
    u32(16); u16(1); u16(2); u32(SR); u32(SR * 4); u16(4); u16(16);
    std::fwrite("data", 1, 4, w); u32(bytes);
    std::fwrite(pcm.data(), 2, pcm.size(), w);
    std::fclose(w);
    std::printf("draws used %zu\n", dr.i);
    fs_destroy(d);
    return 0;
}
