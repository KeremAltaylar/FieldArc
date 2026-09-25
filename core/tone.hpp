/* The building blocks the web's route sound is made of, as Tone.js 15 and the Web Audio spec define
   them: automation timelines, envelopes, band-limited oscillators, biquads, the comb and delay lines,
   Freeverb, Chorus, the drive curve and the bit crusher. Ported from Tone's source (MIT, (c) Yotam
   Mann) and the Web Audio spec so the piece (piece.cpp) plays the patches Kerem wrote on the web as
   they sound there. Main thread builds, audio thread runs; nothing allocates after construction. */
#pragma once
#include <cmath>
#include <cstdint>
#include <cstring>
#include <vector>

namespace tone {

static const double PI = 3.141592653589793;

/* ---- An AudioParam's automation timeline, with Tone's helpers on top (Param.ts) ----
   value(t) answers any time; render(t) is the audio thread's monotonic read, which also drops
   events it has passed. */
struct Param {
    enum Type : uint8_t { SET, LIN, EXP, TARGET };
    struct Ev { double t, v, tc, vs; Type type; };
    static const int CAP = 40;
    Ev ev[CAP];
    int n = 0, cur = -1;
    double base = 0;
    bool exp_units = false;          /* frequency, bpm, decibels: rampTo is exponential */

    void reset(double v) { n = 0; cur = -1; base = v; }

    void insert(Type ty, double t, double v, double tc = 0) {
        if (n == CAP) {               /* full: fold the oldest event into the base value */
            base = ev[0].type == TARGET ? ev[0].v : ev[0].v;
            std::memmove(ev, ev + 1, (n - 1) * sizeof(Ev)); n--; if (cur >= 0) cur--;
        }
        int i = n;
        while (i > 0 && ev[i - 1].t > t) i--;
        std::memmove(ev + i + 1, ev + i, (n - i) * sizeof(Ev));
        ev[i] = Ev{ t, v, tc, NAN, ty };
        n++;
        if (i <= cur) cur = i - 1;
    }
    int last_at(double t) const { int i = -1; while (i + 1 < n && ev[i + 1].t <= t) i++; return i; }
    double start_value(int i) const {          /* the value a TARGET starts from */
        if (!std::isnan(ev[i].vs)) return ev[i].vs;
        int j = i - 1;
        if (j < 0) return base;
        if (ev[j].type == TARGET) return ev[j].v + (start_value(j) - ev[j].v) * std::exp(-(ev[i].t - ev[j].t) / ev[j].tc);
        return ev[j].v;
    }
    double eval(int i, double t) const {
        if (i + 1 < n && (ev[i + 1].type == LIN || ev[i + 1].type == EXP)) {
            const Ev &b = ev[i + 1];
            double t0 = i >= 0 ? ev[i].t : b.tc, v0 = i >= 0 ? (ev[i].type == TARGET ? start_value(i) : ev[i].v) : base;
            if (b.t <= t0) return v0;
            double f = (t - t0) / (b.t - t0);
            if (b.type == LIN) return v0 + (b.v - v0) * f;
            if (v0 * b.v <= 0) return v0;
            return v0 * std::pow(b.v / v0, f);
        }
        if (i < 0) return base;
        if (ev[i].type == TARGET) return ev[i].v + (start_value(i) - ev[i].v) * std::exp(-(t - ev[i].t) / ev[i].tc);
        return ev[i].v;
    }
    double value(double t) const { return eval(last_at(t), t); }
    double render(double t) {
        if (cur >= n) cur = n - 1;
        if (cur >= 0 && ev[cur].t > t) cur = last_at(t);
        while (cur + 1 < n && ev[cur + 1].t <= t) cur++;
        if (cur > 0) {                 /* nothing before the current event matters any more */
            if (ev[cur].type == TARGET) ev[cur].vs = start_value(cur);
            std::memmove(ev, ev + cur, (n - cur) * sizeof(Ev));
            n -= cur; cur = 0;
        }
        return eval(cur, t);
    }

    /* Web Audio's scheduling calls */
    void setValueAtTime(double v, double t) { insert(SET, t, v); }
    void linearRampToValueAtTime(double v, double t) { insert(LIN, t, v); }
    void exponentialRampToValueAtTime(double v, double t) { insert(EXP, t, v == 0 ? 1e-7 : v); }
    void setTargetAtTime(double v, double t, double tc) { insert(TARGET, t, v, tc); }
    void cancelScheduledValues(double t) {
        int k = 0;
        for (int i = 0; i < n; i++) if (ev[i].t < t) ev[k++] = ev[i];
        n = k; if (cur >= n) cur = n - 1;
    }
    /* Tone's cancelAndHoldAtTime */
    void cancelAndHoldAtTime(double t) {
        double v = value(t);
        int b = last_at(t), a = b + 1 < n ? b + 1 : -1;
        if (b >= 0 && ev[b].t == t) {
            if (a >= 0) cancelScheduledValues(ev[a].t);
        } else if (a >= 0) {
            Type ty = ev[a].type;
            cancelScheduledValues(ev[a].t);
            if (ty == LIN) linearRampToValueAtTime(v, t);
            else if (ty == EXP) exponentialRampToValueAtTime(v, t);
        }
        setValueAtTime(v, t);
    }
    /* Tone's helpers */
    void setRampPoint(double t) {
        double v = value(t);
        cancelAndHoldAtTime(t);
        if (v == 0) v = 1e-7;
        setValueAtTime(v, t);
    }
    void linearRampTo(double v, double dur, double t) { setRampPoint(t); linearRampToValueAtTime(v, t + dur); }
    void exponentialRampTo(double v, double dur, double t) { setRampPoint(t); exponentialRampToValueAtTime(v, t + dur); }
    void exponentialApproachValueAtTime(double v, double t, double dur) {
        double tc = std::log(dur + 1) / std::log(200.0);
        setTargetAtTime(v, t, tc);
        cancelAndHoldAtTime(t + dur * 0.9);
        linearRampToValueAtTime(v, t + dur);
    }
    void targetRampTo(double v, double dur, double t) { setRampPoint(t); exponentialApproachValueAtTime(v, t, dur); }
    void rampTo(double v, double dur, double t) { if (exp_units) exponentialRampTo(v, dur, t); else linearRampTo(v, dur, t); }
    void set(double v, double now) { cancelScheduledValues(now); setValueAtTime(v, now); }   /* param.value = v */
};

/* A parameter read once per sub-block and interpolated across it: gains, cutoffs, wets. */
struct Ctl {
    Param p;
    float a = 0, b = 0;
    void init(double v, bool exp_units = false) { p.reset(v); p.exp_units = exp_units; a = b = (float)v; }
    void block(double t_end) { a = b; b = (float)p.render(t_end); }
    float at(int i, int n) const { return a + (b - a) * (float)(i + 1) / (float)n; }
};

/* ---- Envelope.ts ---- */
struct Envelope {
    Param sig;
    double attack = 0.01, decay = 0.1, sustain = 0.5, release = 1, sample_time = 1.0 / 48000;
    bool attack_exp = false, release_exp = true;
    void init(double sr) { sample_time = 1.0 / sr; sig.reset(0); }
    void set(double a, double d, double s, double r, bool aexp = false, bool rexp = true) {
        attack = a; decay = d; sustain = s < 0 ? 0 : (s > 1 ? 1 : s); release = r; attack_exp = aexp; release_exp = rexp;
    }
    void triggerAttack(double t, double vel = 1) {
        double a = attack;
        double cv = sig.value(t);
        if (cv > 0) a = (1 - cv) * attack;
        if (a < sample_time) { sig.cancelScheduledValues(t); sig.setValueAtTime(vel, t); }
        else if (!attack_exp) sig.linearRampTo(vel, a, t);
        else sig.targetRampTo(vel, a, t);
        if (decay > 0 && sustain < 1) sig.exponentialApproachValueAtTime(vel * sustain, t + a, decay);
    }
    void triggerRelease(double t) {
        if (sig.value(t) > 0) {
            if (release < sample_time) sig.setValueAtTime(0, t);
            else if (!release_exp) sig.linearRampTo(0, release, t);
            else sig.targetRampTo(0, release, t);
        }
    }
    /* silent at t and nothing scheduled after: the owner may skip its work */
    bool idle(double t) const {
        if (sig.n == 0) return std::fabs(sig.base) < 1e-9;
        const Param::Ev &e = sig.ev[sig.n - 1];
        return e.t <= t && e.type != Param::TARGET && std::fabs(e.v) < 1e-9;
    }
};

/* ---- Band-limited wavetables, as Chrome builds a PeriodicWave: three tables per octave, each
   holding only the partials that fit under Nyquist for its range, all normalised by the peak of the
   fullest one. Values are sin(n x) coefficients (Tone's _getRealImaginary with phase 0). ---- */
struct Wave {
    static const int N = 4096, MAXP = 2048, RANGES = 34;
    std::vector<std::vector<float>> uniq;      /* ranges holding the same partials share a table */
    const float *t[RANGES];
    int partials[RANGES];
    void build(const std::vector<double> &b) {     /* b[k] = coefficient of partial k+1 */
        static std::vector<float> S;
        if (S.empty()) { S.resize(N); for (int i = 0; i < N; i++) S[i] = (float)std::sin(2 * PI * i / N); }
        int last = 0;
        for (int k = 0; k < (int)b.size(); k++) if (b[k] != 0) last = k + 1;
        double norm = 0;
        int prevK = -1;
        uniq.reserve(RANGES);
        for (int r = 0; r < RANGES; r++) {
            int P = (int)std::floor(MAXP * std::pow(2.0, -r / 3.0));
            if (P < 1) P = 1;
            partials[r] = P;
            int K = last < P ? last : P;
            if (K == prevK) { t[r] = t[r - 1]; continue; }
            prevK = K;
            std::vector<double> acc(N, 0.0);
            for (int k = 1; k <= K; k++) {
                double c = b[k - 1];
                if (c == 0) continue;
                for (int i = 0, idx = 0; i < N; i++, idx = (idx + k) & (N - 1)) acc[i] += c * S[idx];
            }
            if (r == 0) { for (double v : acc) norm = std::fmax(norm, std::fabs(v)); if (norm <= 0) norm = 1; }
            uniq.emplace_back(N + 1);
            std::vector<float> &tb = uniq.back();
            for (int i = 0; i < N; i++) tb[i] = (float)(acc[i] / norm);
            tb[N] = tb[0];
            t[r] = tb.data();
        }
    }
    const float *table(double f, double sr) const {
        double af = std::fabs(f), allowed = af > 0 ? (sr * 0.5) / af : MAXP;
        int r = 0;
        while (r < RANGES - 1 && partials[r] > allowed) r++;
        return t[r];
    }
    static float read(const float *tb, double ph) {
        double x = ph * N; int i = (int)x; float fr = (float)(x - i);
        return tb[i] + (tb[i + 1] - tb[i]) * fr;
    }
};

enum OscType { SINE, TRIANGLE, SQUARE, SAWTOOTH, NTYPES };
const Wave &basic_wave(int type);             /* built once, in piece.cpp */
const Wave &custom_wave(int index);            /* the wavetable voice's eight frames */

struct Osc {
    const Wave *w = nullptr;
    double ph = 0;
    float tick(double f, double sr) {
        float y = Wave::read(w->table(f, sr), ph);
        ph += f / sr;
        ph -= std::floor(ph);
        return y;
    }
};

/* ---- BiquadFilterNode, coefficients from the Web Audio spec (Q in dB for lowpass/highpass) ---- */
enum FilterType { LOWPASS, HIGHPASS, BANDPASS, ALLPASS };
struct Biquad {
    int type = LOWPASS;
    double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
    double x1[2] = {}, x2[2] = {}, y1[2] = {}, y2[2] = {};
    void design(double f, double Q, double sr) {
        double nyq = sr / 2;
        if (f > nyq) f = nyq;
        if (f < 1e-3) f = 1e-3;
        double w0 = 2 * PI * f / sr, c = std::cos(w0), s = std::sin(w0), alpha, a0;
        if (f >= nyq) {                 /* the spec's limits */
            if (type == LOWPASS) { b0 = 1; b1 = b2 = a1 = a2 = 0; return; }
            if (type == HIGHPASS || type == BANDPASS) { b0 = b1 = b2 = a1 = a2 = 0; return; }
        }
        switch (type) {
        case LOWPASS:
            alpha = s / (2 * std::pow(10.0, Q / 20)); a0 = 1 + alpha;
            b0 = (1 - c) / 2 / a0; b1 = (1 - c) / a0; b2 = b0; break;
        case HIGHPASS:
            alpha = s / (2 * std::pow(10.0, Q / 20)); a0 = 1 + alpha;
            b0 = (1 + c) / 2 / a0; b1 = -(1 + c) / a0; b2 = b0; break;
        case BANDPASS:
            alpha = s / (2 * (Q > 1e-4 ? Q : 1e-4)); a0 = 1 + alpha;
            b0 = alpha / a0; b1 = 0; b2 = -alpha / a0; break;
        default:
            alpha = s / (2 * (Q > 1e-4 ? Q : 1e-4)); a0 = 1 + alpha;
            b0 = (1 - alpha) / a0; b1 = -2 * c / a0; b2 = (1 + alpha) / a0; break;
        }
        a1 = -2 * c / a0; a2 = (1 - alpha) / a0;
    }
    float run(int ch, float x) {
        double y = b0 * x + b1 * x1[ch] + b2 * x2[ch] - a1 * y1[ch] - a2 * y2[ch];
        x2[ch] = x1[ch]; x1[ch] = x; y2[ch] = y1[ch]; y1[ch] = y;
        if (std::fabs(y) < 1e-25) y = 0;
        return (float)y;
    }
};

/* Tone.Filter: a biquad whose frequency and Q are params (rolloff -12: one stage). */
struct Filter {
    Biquad bq;
    Ctl freq, Q;
    void init(int type, double f, double q) { bq.type = type; freq.init(f, true); Q.init(q); }
    void block(double t_end, double sr) { freq.block(t_end); Q.block(t_end); bq.design(freq.a, Q.a, sr); }
};

/* OnePoleFilter lowpass: IIR [a0, 0] / [1, a0 - 1], a0 = 2 pi f / sr. */
struct OnePole {
    double a0 = 1, y[2] = {};
    void set(double f, double sr) { a0 = 2 * PI * f / sr; }
    float run(int ch, float x) { y[ch] = a0 * x - (a0 - 1) * y[ch]; if (std::fabs(y[ch]) < 1e-25) y[ch] = 0; return (float)y[ch]; }
};

/* FeedbackCombFilter's worklet: a 1 s ring, whole-sample delay, read before write. */
struct FeedbackComb {
    std::vector<float> buf[2];
    int size = 1, w[2] = {};
    void init(double sr) { size = (int)sr; for (auto &b : buf) b.assign(size, 0.0f); w[0] = w[1] = 0; }
    float run(int ch, float x, int D, float fb) {
        int r = w[ch] - D; if (r < 0) r += size;
        float y = buf[ch][r];
        if (++w[ch] >= size) w[ch] = 0;
        float v = x + y * fb;
        buf[ch][w[ch]] = std::fabs(v) < 1e-25f ? 0.0f : v;
        return y;
    }
};

struct LowpassComb {
    OnePole lp;
    FeedbackComb comb;
    Ctl delay, resonance;
    int D = 1;
    double sr = 48000;
    void init(double s, double delay_s, double res, double damp) {
        sr = s; comb.init(s); delay.init(delay_s); resonance.init(res); lp.set(damp, s);
    }
    void block(double t_end) {
        delay.block(t_end); resonance.block(t_end);
        double d = delay.a; if (d < 0) d = 0; if (d > 1) d = 1;
        D = (int)std::floor(d * sr);
    }
    float run(int ch, float x, float fb) {
        if (fb > 0.9999f) fb = 0.9999f; if (fb < 0) fb = 0;
        return comb.run(ch, lp.run(ch, x), D, fb);
    }
    float run(int ch, float x, int i, int n) { return run(ch, x, resonance.at(i, n)); }
};

/* DelayNode: linear interpolation between samples. */
struct DelayLine {
    std::vector<float> buf;
    int size = 1, w = 0;
    void init(int n) { size = n + 4; buf.assign(size, 0.0f); w = 0; }
    void push(float x) { buf[w] = std::fabs(x) < 1e-25f ? 0.0f : x; if (++w >= size) w = 0; }
    float read(double d) const {     /* d samples behind the last pushed */
        if (d < 1) d = 1;
        if (d > size - 2) d = size - 2;
        double p = w - d; if (p < 0) p += size;
        int i = (int)p; float f = (float)(p - i);
        int j = i + 1 >= size ? 0 : i + 1;
        return buf[i] + (buf[j] - buf[i]) * f;
    }
};

/* Equal-power crossfade (CrossFade.ts via a StereoPanner): dry cos, wet sin. */
inline void xfade(float fade, float &dry, float &wet) {
    if (fade < 0) fade = 0; if (fade > 1) fade = 1;
    dry = (float)std::cos(fade * PI / 2); wet = (float)std::sin(fade * PI / 2);
}

/* ---- Freeverb.ts: per side, four lowpass-combs summed into four allpass biquads ---- */
struct Freeverb {
    LowpassComb comb[8];
    Biquad ap[2][4];
    Ctl room, wet;
    void init(double sr, double room_size, double damp) {
        static const double tune[8] = { 1557, 1617, 1491, 1422, 1277, 1356, 1188, 1116 };
        static const double apf[4] = { 225, 556, 441, 341 };
        for (int i = 0; i < 8; i++) comb[i].init(sr, tune[i] / 44100.0, room_size, damp);
        for (int s = 0; s < 2; s++) for (int k = 0; k < 4; k++) { ap[s][k].type = ALLPASS; ap[s][k].design(apf[k], 1, sr); }
        room.init(room_size); wet.init(0);
    }
    void set_damp(double damp, double sr) { for (auto &c : comb) c.lp.set(damp, sr); }
    /* in-place on L/R */
    void process(float *L, float *R, int n, double t_end) {
        room.block(t_end); wet.block(t_end);
        for (auto &c : comb) c.block(t_end);
        for (int i = 0; i < n; i++) {
            float l = L[i], r = R[i], sl = 0, sr_ = 0, fb = room.at(i, n);
            for (int k = 0; k < 4; k++) sl += comb[k].run(0, l, fb);
            for (int k = 4; k < 8; k++) sr_ += comb[k].run(1, r, fb);
            for (int k = 0; k < 4; k++) { sl = ap[0][k].run(0, sl); sr_ = ap[1][k].run(1, sr_); }
            float d, w; xfade(wet.at(i, n), d, w);
            L[i] = l * d + sl * w; R[i] = r * d + sr_ * w;
        }
    }
};

/* ---- Chorus.ts (feedback 0, spread 180): two delays swept by sine LFOs between
   delayTime -/+ depth * delayTime, left at phase 0, right at 180 ---- */
struct Chorus {
    DelayLine dl[2];
    double sr = 48000, phase = 0, freq = 1.5, delay_s = 0.0035;
    float depth = 0.7, depth_prev = 0.7;
    Ctl wet;
    void init(double s, double f, double delay_ms, double d, double w) {
        sr = s; freq = f; delay_s = delay_ms / 1000; depth = depth_prev = (float)d;
        for (auto &x : dl) x.init((int)(sr * 0.05));
        wet.init(w);
    }
    void process(float *L, float *R, int n, double t_end) {
        wet.block(t_end);
        for (int i = 0; i < n; i++) {
            float dp = depth_prev + (depth - depth_prev) * (i + 1) / n;
            double dev = delay_s * dp, lo = delay_s - dev < 0 ? 0 : delay_s - dev, hi = delay_s + dev;
            double s = std::sin(2 * PI * phase);
            double dL = lo + (hi - lo) * (s + 1) / 2, dR = lo + (hi - lo) * (-s + 1) / 2;
            phase += freq / sr; if (phase >= 1) phase -= 1;
            dl[0].push(L[i]); dl[1].push(R[i]);
            float yl = dl[0].read(dL * sr + 1), yr = dl[1].read(dR * sr + 1);
            float d, w; xfade(wet.at(i, n), d, w);
            L[i] = L[i] * d + yl * w; R[i] = R[i] * d + yr * w;
        }
        depth_prev = depth;
    }
};

/* ---- FeedbackDelay.ts at wet 1: y = delay(x + feedback * y) ---- */
struct FeedbackDelay {
    DelayLine dl[2];
    Ctl time, fb;
    double sr = 48000;
    void init(double s, double max_s, double t, double f) { sr = s; for (auto &d : dl) d.init((int)(max_s * s) + 2); time.init(t); fb.init(f); }
    void process(float *L, float *R, int n, double t_end) {
        time.block(t_end); fb.block(t_end);
        for (int i = 0; i < n; i++) {
            double d = time.at(i, n) * sr; float g = fb.at(i, n);
            float yl = dl[0].read(d), yr = dl[1].read(d);
            dl[0].push(L[i] + g * yl); dl[1].push(R[i] + g * yr);
            L[i] = yl; R[i] = yr;
        }
    }
};

/* WaveShaper(x => tanh(k x), 2048): the curve read by the spec's linear interpolation, clamped at +-1. */
struct Shaper {
    float c[2048];
    void init(double k) { for (int i = 0; i < 2048; i++) c[i] = (float)std::tanh(k * ((double)i / 2047 * 2 - 1)); }
    float run(float x) const {
        float v = 1023.5f * (x + 1);
        if (v <= 0) return c[0];
        if (v >= 2047) return c[2047];
        int k = (int)v; float f = v - k;
        return c[k] + (c[k + 1] - c[k]) * f;
    }
};

inline float crush(float x, float bits) { float step = std::pow(0.5f, bits - 1); return step * std::floor(x / step + 0.5f); }

/* Tone.Noise's pink buffer: 220500 frames, two independent channels (Paul Kellet's filter). */
const std::vector<float> &pink_noise(int ch);

inline double db_to_gain(double db) { return std::pow(10.0, db / 20); }

}  // namespace tone
