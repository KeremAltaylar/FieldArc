// C++ side of the stretch checks; tests/run.py drives it and prints the table.
// It includes stretch.cpp directly (not linked separately) so check 9 can step a Voice stage by stage.
//   stretch_test fft                                  FFT vs direct DFT
//   stretch_test render IN CH OUT SECONDS [k=v ...]   raw float32 in (CH interleaved) -> stereo out
//   stretch_test sweep IN OUT SECONDS                 check 4: stretch/window/width swept live
//   stretch_test checks                               checks 2, 7, 8, 9
#include "../devices/stretch.cpp"
#include <cstdio>
#include <cstdlib>
#include <string>

static const float SR = 48000;

static std::vector<float> noise(int n, uint64_t seed, float amp) {
    Pcg32 r; r.seed(seed, 7);
    std::vector<float> x(n);
    for (auto &s : x) s = amp * (2 * r.uniform() - 1);
    return x;
}

static int param_index(fs_device *d, const char *id) {
    for (int i = 0; i < fs_param_count(d); i++) if (std::string(fs_param_info(d, i)->id) == id) return i;
    std::fprintf(stderr, "unknown param %s\n", id); std::exit(2);
}

struct Rig {
    fs_device *d;
    std::vector<float> ch[2];
    const float *ptr[2];
    Rig(const std::vector<float> &l, const std::vector<float> &r, int block, std::vector<std::pair<std::string, float>> params) {
        d = fs_create("stretch");
        for (auto &p : params) fs_set_param(d, param_index(d, p.first.c_str()), p.second);
        fs_prepare(d, SR, block);
        ch[0] = l; ch[1] = r; ptr[0] = ch[0].data(); ptr[1] = ch[1].data();
        fs_set_source(d, 2, (int)ch[0].size(), ptr);
    }
    ~Rig() { fs_destroy(d); }
    void set(const char *id, float v) { fs_set_param(d, param_index(d, id), v); }
    void run(int frames, std::vector<float> *out = nullptr) {
        fs_process(d, frames);
        if (out) for (int i = 0; i < frames; i++) { out->push_back(fs_out(d, 0)[i]); out->push_back(fs_out(d, 1)[i]); }
    }
    fs_stats_t stats() { fs_stats_t s; fs_stats(d, &s); return s; }
};

static std::vector<float> read_f32(const char *path) {
    FILE *f = std::fopen(path, "rb");
    if (!f) { std::fprintf(stderr, "cannot open %s\n", path); std::exit(2); }
    std::vector<float> x;
    float buf[4096]; size_t n;
    while ((n = std::fread(buf, sizeof(float), 4096, f)) > 0) x.insert(x.end(), buf, buf + n);
    std::fclose(f);
    return x;
}

static void write_f32(const char *path, const std::vector<float> &x) {
    FILE *f = std::fopen(path, "wb");
    std::fwrite(x.data(), sizeof(float), x.size(), f);
    std::fclose(f);
}

static void load_source(const char *path, int channels, std::vector<float> &l, std::vector<float> &r) {
    std::vector<float> x = read_f32(path);
    int n = (int)x.size() / channels;
    l.resize(n); r.resize(n);
    for (int i = 0; i < n; i++) { l[i] = x[i * channels]; r[i] = x[i * channels + channels - 1]; }
}

static int fft_check() {
    const int sizes[] = { 16, 30, 48, 60, 90, 120, 250, 480, 750, 1000, 1350, 2400 };
    double worst = 0;
    for (int n : sizes) {
        FFT f; f.reserve(n); f.plan(n); f.twiddles(0, n);
        std::vector<float> ar = noise(n, n, 1), ai = noise(n, n + 1, 1), br(n), bi(n);
        std::vector<double> xr(ar.begin(), ar.end()), xi(ai.begin(), ai.end());
        int which = f.forward(ar.data(), ai.data(), br.data(), bi.data());
        const float *rr = which ? br.data() : ar.data(), *ri = which ? bi.data() : ai.data();
        double err = 0, mx = 0;
        for (int k = 0; k < n; k++) {
            double sr = 0, si = 0;
            for (int t = 0; t < n; t++) {
                double a = -6.283185307179586 * (double)((long long)t * k % n) / n;
                sr += xr[t] * std::cos(a) - xi[t] * std::sin(a);
                si += xr[t] * std::sin(a) + xi[t] * std::cos(a);
            }
            err = std::fmax(err, std::hypot(sr - rr[k], si - ri[k]));
            mx = std::fmax(mx, std::hypot(sr, si));
        }
        worst = std::fmax(worst, err / mx);
    }
    std::printf("RESULT fft_rel_err %.3g\n", worst);
    return 0;
}

static int render(int argc, char **argv) {
    std::vector<float> l, r;
    load_source(argv[2], std::atoi(argv[3]), l, r);
    double seconds = std::atof(argv[5]);
    std::vector<std::pair<std::string, float>> params;
    int block = 128;
    for (int i = 6; i < argc; i++) {
        std::string a = argv[i]; size_t eq = a.find('=');
        if (a.substr(0, eq) == "block") block = std::atoi(a.c_str() + eq + 1);
        else params.push_back({ a.substr(0, eq), (float)std::atof(a.c_str() + eq + 1) });
    }
    Rig rig(l, r, block, params);
    std::vector<float> out;
    long long total = (long long)(seconds * SR);
    for (long long done = 0; done < total; done += block) rig.run((int)std::min<long long>(block, total - done), &out);
    write_f32(argv[4], out);
    fs_stats_t s = rig.stats();
    std::printf("RESULT late %d underruns %d max_ms %.4f frames %lld wraps %d\n", s.late_frames, s.underruns, s.max_process_ms, s.frames, s.wraps);
    return 0;
}

/* Check 4: every callback the host moves stretch, window and width along slow LFOs. */
static int sweep(char **argv) {
    std::vector<float> l, r;
    load_source(argv[2], 1, l, r);
    const int B = 128;
    Rig rig(l, r, B, {});
    std::vector<float> out;
    long long total = (long long)(std::atof(argv[4]) * SR);
    for (long long t = 0; t < total; t += B) {
        double sec = t / SR;
        rig.set("stretch", (float)(0.5 - 0.5 * std::cos(6.283185307179586 * sec / 23.0)));
        rig.set("window", (float)(0.02 * std::pow(100.0, 0.5 - 0.5 * std::cos(6.283185307179586 * sec / 31.0))));
        rig.set("width", (float)(0.5 - 0.5 * std::cos(6.283185307179586 * sec / 11.0)));
        rig.run(B, &out);
    }
    write_f32(argv[3], out);
    fs_stats_t s = rig.stats();
    std::printf("RESULT late %d underruns %d max_ms %.4f\n", s.late_frames, s.underruns, s.max_process_ms);
    return 0;
}

static double rms(const float *x, size_t n) { double s = 0; for (size_t i = 0; i < n; i++) s += (double)x[i] * x[i]; return std::sqrt(s / (n ? n : 1)); }

static int checks() {
    /* 2: output length when the read position first passes the end, vs input x S */
    {
        std::vector<float> x = noise(3 * 48000 + 17, 3, 0.3f);
        double worst = 0;
        for (double S : { 1.0, 2.5, 8.0, 64.0 }) {
            float v = (float)(std::log(S) / std::log(1024.0));
            Rig rig(x, x, 128, { { "stretch", v }, { "window", 0.25f } });
            while (rig.stats().wraps == 0) rig.run(128);
            double s_actual = std::pow(1024.0, (double)v);
            int H = window_size(12000) / 2;
            double len = (double)rig.stats().frames * H, want = x.size() * s_actual;
            std::printf("RESULT len S=%g frames=%lld out=%.0f want=%.0f hop=%d diff_hops=%.3f\n", S, rig.stats().frames, len, want, H, (len - want) / H);
            worst = std::fmax(worst, std::fabs(len - want) / H);
        }
        std::printf("RESULT len_worst_hops %.3f\n", worst);
    }
    /* 7: same seed twice -> bit-identical, with live changes; also a different callback size */
    {
        std::vector<float> x = noise(5 * 48000, 4, 0.3f), y = noise(5 * 48000, 5, 0.3f);
        auto go = [&](int seed, int block) {
            Rig rig(x, y, block, { { "seed", (float)seed }, { "stretch", 0.3f }, { "width", 0.5f } });
            std::vector<float> out;
            for (long long t = 0; t < 20 * 48000; t += block) {
                if (t >= 5 * 48000 && t < 5 * 48000 + block) { rig.set("window", 0.1f); rig.set("onset", 0.5f); }
                if (t >= 12 * 48000 && t < 12 * 48000 + block) { rig.set("shape", 1); rig.set("freeze", 1); }
                rig.run(block, &out);
            }
            return out;
        };
        auto a = go(1, 128), b = go(1, 128), c = go(2, 128), d = go(1, 480);
        size_t n = std::min(a.size(), d.size());
        std::printf("RESULT seed_same %d seed_blocksize %d seed_other_differs %d samples %zu\n",
                    a == b, std::equal(a.begin(), a.begin() + n, d.begin()), a != c, a.size());
    }
    /* 8: worst process() time, 128 frames at 48 kHz */
    {
        std::vector<float> x = noise(10 * 48000, 6, 0.3f);
        for (float T : { 0.34f, 2.0f }) {
            Rig rig(x, x, 128, { { "window", T }, { "stretch", 0.3f } });
            for (long long t = 0; t < 40 * 48000; t += 128) rig.run(128);
            fs_stats_t s = rig.stats();
            std::printf("RESULT cpu T=%g max_ms %.4f late %d underruns %d\n", T, s.max_process_ms, s.late_frames, s.underruns);
        }
        Rig rig(x, x, 128, { { "window", 0.34f }, { "stretch", 0.3f } });
        for (long long t = 0; t < 20 * 48000; t += 128) { if (t == 128 * 100) rig.set("window", 2.0f); rig.run(128); }
        fs_stats_t s = rig.stats();
        std::printf("RESULT cpu change max_ms %.4f late %d underruns %d\n", s.max_process_ms, s.late_frames, s.underruns);
    }
    /* 9: signal after each stage of one frame, 440 Hz sine */
    {
        std::vector<float> x(48000);
        for (int i = 0; i < 48000; i++) x[i] = 0.5f * std::sin(6.283185307179586 * 440 * i / 48000);
        Source src; src.ch[0] = src.ch[1] = x.data(); src.len = (int)x.size();
        Voice v; v.reserve(16384, SR); v.src = &src;
        v.start(16384, 0, 0.0, 9, Controls{ 0, false, 0, 1 });
        const char *names[] = { "fft", "phase", "ifft", "overlap-add" };
        double level[4] = { 0, 0, 0, 0 };
        for (int frame = 0; frame < 3; frame++) {   /* third frame: overlap-add has a partner */
            for (; v.si < v.nsteps; v.si++) {
                const Voice::Step s = v.plan[v.si];
                v.run(s.stage, s.pass, 0, s.count);
                if (frame < 2) continue;
                bool last = v.si + 1 == v.nsteps || v.plan[v.si + 1].stage != s.stage;
                if (s.stage == S_FWD && last) level[0] = rms(v.res_r(), v.N);
                if (s.stage == S_PHASE) level[1] = rms(v.ar.data(), v.N);
                if (s.stage == S_INV && last) level[2] = rms(v.res_r(), v.N);
                if (s.stage == S_OUT) level[3] = rms(v.hop[v.cur ^ 1][0].data(), v.H);
            }
            v.cur ^= 1; v.begin_job(Controls{ 0, false, 0, 1 });
        }
        Rig rig(x, x, 128, {});
        std::vector<float> out;
        for (int t = 0; t < 2 * 48000; t += 128) rig.run(128, &out);
        double out_rms = rms(out.data() + 48000, out.size() - 48000);
        const char *silent = "none";
        for (int i = 3; i >= 0; i--) if (!(level[i] > 1e-6)) silent = names[i];
        if (!(out_rms > 1e-6) && std::string(silent) == "none") silent = "output";
        std::printf("RESULT stages fft %.4g phase %.4g ifft %.4g ola %.4g output %.4g first_silent %s\n",
                    level[0], level[1], level[2], level[3], out_rms, silent);
    }
    return 0;
}

int main(int argc, char **argv) {
    std::string mode = argc > 1 ? argv[1] : "";
    if (mode == "fft") return fft_check();
    if (mode == "render" && argc >= 6) return render(argc, argv);
    if (mode == "sweep" && argc >= 5) return sweep(argv);
    if (mode == "checks") return checks();
    std::fprintf(stderr, "usage: see top of stretch_test.cpp\n");
    return 2;
}
