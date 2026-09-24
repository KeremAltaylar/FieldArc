/* stretch: the Paulstretch mechanism (SPEC.md) as a real-time device.

   Each frame: read N samples at the read position, window, FFT, keep magnitudes, draw random
   phases, inverse FFT, window again, overlap-add at hop H = N/2. Both channels go through one
   complex FFT (left in the real part, right in the imaginary part) and are separated in the
   spectrum, so a stereo frame costs one forward and one inverse transform.

   Real time: a Voice plays one hop while it computes the next. The next frame's work is split into
   weighted stages and spread over the first half of the current hop, so no single callback carries
   a whole frame (see NOTES.md). A window or shape change starts a second Voice at the new size and
   crossfades to it; nothing allocates after prepare. */
#include "../device.hpp"
#include "fft.hpp"
#include <cstdint>
#include <cstring>

static const float TWO_PI = 6.2831853f;

/* PCG32 (O'Neill): one per voice, seeded from the device's, so output is repeatable per seed. */
struct Pcg32 {
    uint64_t state = 0, inc = 1;
    void seed(uint64_t s, uint64_t seq) { state = 0; inc = (seq << 1) | 1; next(); state += s; next(); }
    uint32_t next() {
        uint64_t old = state;
        state = old * 6364136223846793005ULL + inc;
        uint32_t x = (uint32_t)(((old >> 18) ^ old) >> 27), rot = (uint32_t)(old >> 59);
        return (x >> rot) | (x << ((32 - rot) & 31));
    }
    float uniform() { return (next() >> 8) * (1.0f / 16777216.0f); }   /* [0, 1) */
};

/* Smallest even N >= n0 whose only prime factors are 2, 3, 5 (SPEC 1). */
static int window_size(int n0) {
    for (int n = n0 + (n0 & 1);; n += 2) {
        int m = n;
        while (m % 2 == 0) m /= 2;
        while (m % 3 == 0) m /= 3;
        while (m % 5 == 0) m /= 5;
        if (m == 1) return n;
    }
}

struct Source { const float *ch[2] = { nullptr, nullptr }; int len = 0; };

/* What the device hands a voice at each frame. */
struct Controls { double log_s; bool freeze; float onset, width; };

enum Stage { S_WIN, S_TWID, S_GAIN, S_READ, S_FWD, S_MAG, S_ONSET, S_PHASE, S_INV, S_OUT, S_FINISH };
static const int BANDS = 32;

struct Voice {
    int N = 0, H = 0, shape = 0;
    float scale = 0;                 /* normalisation gain / N (the 1/N of the inverse FFT folded in) */
    FFT fft;
    Pcg32 rng;
    const Source *src = nullptr;
    double sr = 48000;
    std::vector<float> win, hc, ar, ai, br, bi, mag[2], prev[2], tail[2], hop[2][2];

    double pos = 0, log_s = 0;       /* read position of the next frame; smoothed log stretch */
    int cur = 0, play = 0;           /* hop[cur] is playing, at index play */
    long long frames = 0;
    int wraps = 0, late = 0;
    bool onset_on = false, get_next = true, have_mag = false, reading = false;
    double tau = 0, credit = 0;
    float bands[BANDS], old_bands[BANDS];
    float width = 0, theta = 1;
    bool freeze = false;

    struct Step { int stage, pass, count, weight; };
    Step plan[160];
    int nsteps = 0, si = 0, item = 0;
    long long total = 0, done = 0;
    bool setup = false;

    void reserve(int nmax, double sample_rate) {
        sr = sample_rate;
        fft.reserve(nmax);
        for (auto *v : { &win, &ar, &ai, &br, &bi }) v->assign(nmax, 0.0f);
        hc.assign(nmax / 2, 0.0f);
        for (int c = 0; c < 2; c++) {
            mag[c].assign(nmax / 2 + 1, 0.0f); prev[c].assign(nmax / 2 + 1, 0.0f);
            tail[c].assign(nmax / 2, 0.0f); hop[0][c].assign(nmax / 2, 0.0f); hop[1][c].assign(nmax / 2, 0.0f);
        }
    }

    /* Begin at size n, reading from p. The first hop is silence while the first frame is built. */
    void start(int n, int shp, double p, uint64_t seed, const Controls &c) {
        N = n; H = n / 2; shape = shp; pos = p; log_s = c.log_s;
        fft.plan(N);
        rng.seed(seed, 54);
        for (int k = 0; k < 2; k++) {
            std::fill(tail[k].begin(), tail[k].end(), 0.0f);
            std::fill(hop[0][k].begin(), hop[0][k].end(), 0.0f);
        }
        cur = 0; play = 0; frames = 0; wraps = 0;
        onset_on = false; have_mag = false; get_next = true; tau = 0; credit = 0;
        std::memset(bands, 0, sizeof bands);
        setup = true;
        begin_job(c);
    }

    void add(int stage, int pass, int count, int weight) {
        plan[nsteps++] = { stage, pass, count, weight };
        total += (long long)count * weight;
    }

    /* Plan the next frame. Weights are rough per-item costs so the spread is even in time. */
    void begin_job(const Controls &c) {
        nsteps = si = item = 0; total = done = 0;
        if (setup) { add(S_WIN, 0, N, 8); add(S_TWID, 0, N, 8); add(S_GAIN, 0, 1, 2 * N); setup = false; }
        log_s += (c.log_s - log_s) * (1.0 - std::exp(-H / (0.1 * sr)));   /* 100 ms per-frame smoothing */
        freeze = c.freeze; width = c.width; theta = 1.0f - c.onset;
        bool want = c.onset > 0;
        if (want && !onset_on) { tau = 0; credit = 0; get_next = true; }
        onset_on = want;
        reading = !onset_on || get_next;
        if (reading) {
            add(S_READ, 0, N, 2);
            for (int p = 0; p < fft.passes; p++) add(S_FWD, p, fft.butterflies(p), 3 * fft.radix[p]);
            add(S_MAG, 0, N / 2 + 1, 6);
            std::memcpy(old_bands, bands, sizeof bands);
            std::memset(bands, 0, sizeof bands);
            if (onset_on) add(S_ONSET, 0, 1, 64);
        }
        add(S_PHASE, 0, N / 2 + 1, 20);
        for (int p = 0; p < fft.passes; p++) add(S_INV, p, fft.butterflies(p), 3 * fft.radix[p]);
        add(S_OUT, 0, H, 6);
        add(S_FINISH, 0, 1, 1);
    }

    /* Result buffers after the forward or inverse passes. */
    float *res_r() { return fft.passes % 2 ? br.data() : ar.data(); }
    float *res_i() { return fft.passes % 2 ? bi.data() : ai.data(); }

    void run(int stage, int pass, int a, int b) {
        switch (stage) {
        case S_WIN:
            for (int k = a; k < b; k++) {
                if (shape == 0) {
                    double t = -1.0 + 2.0 * k / (N - 1);
                    win[k] = (float)std::pow(1.0 - t * t, 1.25);
                } else {
                    win[k] = (float)(0.5 - 0.5 * std::cos(6.283185307179586 * k / (N - 1)));
                }
                if (k < H) {
                    const double A = (1.0 + std::sqrt(0.5)) / 2.0;
                    hc[k] = shape == 0 ? 1.0f : (float)(2.0 * (A - (1.0 - A) * std::cos(6.283185307179586 * k / H)) / A);
                }
            }
            break;
        case S_TWID: fft.twiddles(a, b); break;
        case S_GAIN: {
            /* Random phases spread a frame's energy sum(b^2) evenly over N samples; windowing again
               and overlap-adding two independent frames gives mean output power
               sigma^2 * (sum w^2 / N) * (1/H) sum_m (w[m]^2 + w[m+H]^2) h[m]^2. Undo that. */
            double sw = 0, so = 0;
            for (int k = 0; k < N; k++) sw += (double)win[k] * win[k];
            for (int m = 0; m < H; m++)
                so += ((double)win[m] * win[m] + (double)win[m + H] * win[m + H]) * hc[m] * hc[m];
            scale = (float)(1.0 / std::sqrt(sw / N * so / H) / N);
            break;
        }
        case S_READ: {
            const int len = src ? src->len : 0;
            if (!len) {
                std::fill(ar.begin() + a, ar.begin() + b, 0.0f);
                std::fill(ai.begin() + a, ai.begin() + b, 0.0f);
                break;
            }
            const float *x0 = src->ch[0], *x1 = src->ch[1];
            long long idx = ((long long)pos + a) % len;
            for (int k = a; k < b; k++) {
                ar[k] = x0[idx] * win[k];
                ai[k] = x1[idx] * win[k];
                if (++idx == len) idx = 0;
            }
            break;
        }
        case S_FWD:
        case S_INV:
            if (pass % 2 == 0) fft.pass(pass, ar.data(), ai.data(), br.data(), bi.data(), a, b);
            else fft.pass(pass, br.data(), bi.data(), ar.data(), ai.data(), a, b);
            break;
        case S_MAG: {
            /* Z = FFT(left + i right): left_j = (Z_j + conj Z_{N-j}) / 2, right_j = (Z_j - conj Z_{N-j}) / 2i */
            const float *zr = res_r(), *zi = res_i();
            const int div = (N / 2 + 1) / BANDS;
            for (int j = a; j < b; j++) {
                const int k = j ? N - j : 0;
                float m0 = 0.5f * std::sqrt((zr[j] + zr[k]) * (zr[j] + zr[k]) + (zi[j] - zi[k]) * (zi[j] - zi[k]));
                float m1 = 0.5f * std::sqrt((zr[j] - zr[k]) * (zr[j] - zr[k]) + (zi[j] + zi[k]) * (zi[j] + zi[k]));
                prev[0][j] = have_mag ? mag[0][j] : m0; prev[1][j] = have_mag ? mag[1][j] : m1;
                mag[0][j] = m0; mag[1][j] = m1;
                if (div && j < div * BANDS) bands[j / div] += 0.5f * (m0 + m1) / div;
            }
            break;
        }
        case S_ONSET: {
            /* SPEC onset measure: m = clamp(2 mean(B_t - B_t-1) / (mean|B_t-1| + 0.001), 0, 1) */
            const float *old = have_mag ? old_bands : bands;
            float d = 0, o = 0;
            for (int i = 0; i < BANDS; i++) { d += bands[i] - old[i]; o += std::fabs(old[i]); }
            float m = 2.0f * (d / BANDS) / (o / BANDS + 0.001f);
            m = m < 0 ? 0 : m > 1 ? 1 : m;
            if (m > theta) { tau = 1; credit += 1; }
            break;
        }
        case S_PHASE:
            /* Width: every bin gets a shared phase; each channel adds its own offset in
               [-pi, pi) scaled by width. Magnitudes are untouched at any width, so level is too. */
            for (int j = a; j < b; j++) {
                float A0 = mag[0][j], A1 = mag[1][j];
                if (onset_on) { const float t = (float)tau; A0 = prev[0][j] + (A0 - prev[0][j]) * t; A1 = prev[1][j] + (A1 - prev[1][j]) * t; }
                float ps = TWO_PI * rng.uniform();
                float p0 = ps + width * TWO_PI * (rng.uniform() - 0.5f);
                float p1 = ps + width * TWO_PI * (rng.uniform() - 0.5f);
                /* Build conj(W), W = Y0 + i Y1, so the forward passes compute the inverse transform. */
                if (j == 0) { ar[0] = ai[0] = 0; continue; }                     /* DC removed */
                if (j == N / 2) {                                               /* Nyquist: random sign */
                    ar[j] = std::cos(p0) < 0 ? -A0 : A0;
                    ai[j] = -(std::cos(p1) < 0 ? -A1 : A1);
                    continue;
                }
                float y0r = A0 * std::cos(p0), y0i = A0 * std::sin(p0);
                float y1r = A1 * std::cos(p1), y1i = A1 * std::sin(p1);
                ar[j] = y0r - y1i;     ai[j] = -(y0i + y1r);
                ar[N - j] = y0r + y1i; ai[N - j] = y0i - y1r;
            }
            break;
        case S_OUT: {
            /* fft(conj W) = N conj(y0 + i y1): left = Re, right = -Im. Window, overlap-add, hann fix. */
            const float *rr = res_r(), *ri = res_i();
            float *o0 = hop[cur ^ 1][0].data(), *o1 = hop[cur ^ 1][1].data();
            for (int m = a; m < b; m++) {
                float w0 = scale * win[m], w1 = scale * win[m + H], h = hc[m];
                o0[m] = (rr[m] * w0 + tail[0][m]) * h;
                o1[m] = (-ri[m] * w0 + tail[1][m]) * h;
                tail[0][m] = rr[m + H] * w1;
                tail[1][m] = -ri[m + H] * w1;
            }
            break;
        }
        case S_FINISH: {
            frames++;
            if (reading) have_mag = true;
            const double inc = freeze ? 0.0 : std::exp(-log_s);   /* 1/S */
            if (!onset_on) {
                pos += H * inc;
            } else {                                              /* SPEC onset mode */
                if (reading) { pos += H; get_next = false; }
                const double step = inc < 1 ? inc : 1;
                if (credit <= 0) tau += step;
                else {
                    credit -= 0.5 * step;
                    if (credit < 0) credit = 0;
                    tau += 0.5 * step;
                }
                if (tau >= 1) { tau = std::fmod(tau, 1.0); get_next = true; }
            }
            const int len = src ? src->len : 0;
            if (len && pos >= len) { wraps += (int)(pos / len); pos = std::fmod(pos, (double)len); }
            break;
        }
        }
    }

    /* Advance the current job until `target` weighted units are done. */
    void work(long long target) {
        while (done < target && si < nsteps) {
            const Step &s = plan[si];
            long long need = (target - done + s.weight - 1) / s.weight;
            int b = (int)(item + need < s.count ? item + need : s.count);
            run(s.stage, s.pass, item, b);
            done += (long long)(b - item) * s.weight;
            item = b;
            if (item == s.count) { si++; item = 0; }
        }
    }

    /* Play n samples; the next frame's work is spread over the first half of each hop. */
    void render(float *o0, float *o1, int n, const Controls &c) {
        for (int i = 0; i < n;) {
            if (play == H) {
                if (si < nsteps) { work(total); late++; }
                cur ^= 1; play = 0;
                begin_job(c);
            }
            int k = n - i < H - play ? n - i : H - play;
            work(2 * (play + k) >= H ? total : total * 2 * (play + k) / H);
            std::memcpy(o0 + i, hop[cur][0].data() + play, sizeof(float) * k);
            std::memcpy(o1 + i, hop[cur][1].data() + play, sizeof(float) * k);
            play += k; i += k;
        }
    }
};

static const fs_param STRETCH_PARAMS[] = {
    { "stretch", "Stretch", "", 0.0f, 1.0f, 0.0f },
    { "window", "Window", "s", 0.02f, 2.0f, 0.34f },
    { "freeze", "Freeze", "", 0.0f, 1.0f, 0.0f },
    { "onset", "Onset sensitivity", "", 0.0f, 1.0f, 0.0f },
    { "width", "Width", "", 0.0f, 1.0f, 0.0f },
    { "shape", "Window shape", "", 0.0f, 1.0f, 0.0f },
    { "seed", "Seed", "", 0.0f, 16777216.0f, 1.0f },
};
enum { P_STRETCH, P_WINDOW, P_FREEZE, P_ONSET, P_WIDTH, P_SHAPE, P_SEED, P_COUNT };

struct Stretch : Device {
    float value[P_COUNT];
    double sr = 48000;
    Source src;
    Pcg32 rng;
    Voice v[2];
    int active = 0;
    bool fading = false;
    long long fade = 0;              /* samples since the incoming voice started */
    std::vector<float> tmp[2];
    float cached_window = -1; int cached_n = 0;

    Stretch() { for (int i = 0; i < P_COUNT; i++) value[i] = STRETCH_PARAMS[i].def; }

    const fs_param *params(int &n) override { n = P_COUNT; return STRETCH_PARAMS; }
    void set_param(int i, float x) override { value[i] = x; }

    Controls controls() const {
        return { value[P_STRETCH] * std::log(1024.0), value[P_FREEZE] >= 0.5f, value[P_ONSET], value[P_WIDTH] };
    }
    int target_n() {
        if (value[P_WINDOW] != cached_window) {
            cached_window = value[P_WINDOW];
            int n0 = (int)std::floor(cached_window * sr);
            cached_n = window_size(n0 < 16 ? 16 : n0);
        }
        return cached_n;
    }
    uint64_t voice_seed() { return ((uint64_t)rng.next() << 32) | rng.next(); }

    void prepare(float sample_rate, int max_block) override {
        sr = sample_rate;
        rng.seed((uint64_t)value[P_SEED], 1);
        cached_window = -1;
        const int nmax = window_size((int)std::floor(STRETCH_PARAMS[P_WINDOW].max * sr));
        for (auto &x : v) { x.reserve(nmax, sr); x.src = &src; }
        for (auto &t : tmp) t.assign(max_block, 0.0f);
        active = 0; fading = false;
        v[0].start(target_n(), value[P_SHAPE] >= 0.5f, 0.0, voice_seed(), controls());
    }

    void set_source(int channels, int frames, const float *const *s) override {
        if (channels < 1 || frames < 1 || !s) { src = Source(); return; }
        src.ch[0] = s[0]; src.ch[1] = channels > 1 ? s[1] : s[0]; src.len = frames;
        for (auto &x : v) if (x.pos >= frames) x.pos = std::fmod(x.pos, (double)frames);
    }

    void stats(fs_stats_t &st) override {
        st.late_frames = v[0].late + v[1].late;
        st.frames = v[active].frames;
        st.wraps = v[active].wraps;
    }

    void process(int n) override {
        const Controls c = controls();
        Voice &a = v[active], &b = v[active ^ 1];
        const int want_n = target_n(), want_shape = value[P_SHAPE] >= 0.5f;
        if (!fading && (want_n != a.N || want_shape != a.shape)) {
            /* Same frame centre: the new voice reads from where the old one is, re-centred. */
            double p = a.pos + (a.N - want_n) / 2;
            if (src.len) { p = std::fmod(p, (double)src.len); if (p < 0) p += src.len; } else p = 0;
            b.start(want_n, want_shape, p, voice_seed(), c);
            fading = true; fade = 0;
        }
        a.render(out[0].data(), out[1].data(), n, c);
        if (!fading) return;
        b.render(tmp[0].data(), tmp[1].data(), n, c);
        /* The new voice needs one window to reach full overlap (silent hop, then a half-window
           rise); then an equal-power crossfade over one window (the voices are uncorrelated). */
        for (int i = 0; i < n; i++, fade++) {
            double x = (double)(fade - b.N) / b.N;
            x = x < 0 ? 0 : x > 1 ? 1 : x;
            float ga = (float)std::cos(1.5707963267948966 * x), gb = (float)std::sin(1.5707963267948966 * x);
            out[0][i] = out[0][i] * ga + tmp[0][i] * gb;
            out[1][i] = out[1][i] * ga + tmp[1][i] * gb;
        }
        if (fade >= 2LL * b.N) { active ^= 1; fading = false; }
    }
};

Device *make_stretch() { return new Stretch(); }
