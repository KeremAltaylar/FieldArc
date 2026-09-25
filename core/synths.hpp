/* The route's instruments: index.html's makeSynth, each built the way Tone.js 15 builds it (the
   source lines are Tone's classes; WavetableVoice, CombVoice and FormantVoice are index.html's own).
   Every synth renders stereo, adding into the buffers it is given, scaled by its volume (the
   level-matching trim). Times are seconds on the piece's clock. */
#pragma once
#include "tone.hpp"

namespace tone {

enum SynthType { FM, AM, DUO, MONO, SIMPLE, PLUCK, METAL, MEMBRANE, WAVETABLE, COMB, FORMANT, NSYNTH };
static const char *const SYNTH_NAMES[NSYNTH] = { "fm", "am", "duo", "mono", "simple", "pluck", "metal", "membrane", "wavetable", "comb", "formant" };
/* SYNTH_TRIM, dB */
static const double SYNTH_TRIM[NSYNTH] = { 0, 5.5, -14.5, -10, -11, -9, -2, -12.5, -9, -0.5, -2 };
static const bool PERCUSSIVE[NSYNTH] = { 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0 };
static const bool SELF_VOICED[NSYNTH] = { 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1 };

/* SYNTH_PARAMS: each instrument's two timbre controls (range for the morphs to span). */
struct TimbreRange { double min, max; };
static const TimbreRange SYNTH_PARAMS[NSYNTH][2] = {
    { { 0.25, 4 }, { 0, 16 } },      /* fm: ratio, depth */
    { { 0.25, 4 }, { 0, 16 } },      /* am: ratio, depth (AMSynth has no depth: it moves nothing) */
    { { 0.25, 4 }, { 0, 1 } },       /* duo: detune (harmonicity), vibrato */
    { { 0.5, 14 }, { 0, 7 } },       /* mono: resonance, filter env octaves */
    { { -24, 24 }, { 0.2, 6 } },     /* simple: detune cents, release */
    { { 300, 8000 }, { 0.5, 0.99 } },/* pluck: damping, resonance */
    { { 1, 12 }, { 0.4, 4 } },       /* metal: harmonicity, octaves */
    { { 0.01, 0.4 }, { 1, 8 } },     /* membrane: pitch decay, octaves */
    { { 0, 1 }, { 0, 1 } },          /* wavetable: table, brightness */
    { { 0, 1 }, { 0, 1 } },          /* comb: damping, resonance */
    { { 0, 1 }, { 0, 1 } },          /* formant: vowel, shift */
};

struct EnvSpec { double a, d, s, r; bool aexp, rexp; };
/* What swapSynth hands set(): the patch's two numbers, the oscillator and modulator types, the two
   envelopes. SELF_VOICED types take only the two numbers. */
struct Settings { double harm, index; int osc, mod; EnvSpec env, menv; };

inline double mtof(double m) { return 440 * std::pow(2.0, (m - 69) / 12); }

struct Synth {
    double sr = 48000;
    float vol = 1;                    /* Instrument.volume, as a gain */
    virtual ~Synth() {}
    virtual void init(double s) { sr = s; }
    virtual void set(const Settings &) {}
    virtual void attack(double f, double t, double vel) = 0;
    virtual void release(double t) = 0;
    void attack_release(double f, double dur, double t, double vel) { attack(f, t, vel); release(t + dur); }
    /* applyTimbre's destinations: which 0 = harm, 1 = index */
    virtual void timbre(int which, double v, double ramp, double now) = 0;
    virtual void render(float *L, float *R, int n, double t0) = 0;
};

/* ---- ModulationSynth / FMSynth / AMSynth: carrier and modulator Synths at -10 dB each ---- */
struct ModSynth : Synth {
    bool am = false;
    Osc car, mod;
    Envelope env, menv;
    Param freq;
    Ctl harm, index;
    void init(double s) override {
        Synth::init(s);
        env.init(s); menv.init(s);
        env.set(0.01, 0.01, 1, 0.5); menv.set(0.5, 0, 1, 0.5);
        car.w = &basic_wave(SINE); mod.w = &basic_wave(SQUARE);
        freq.reset(440); freq.exp_units = true;
        harm.init(3); index.init(am ? 0 : 10);
    }
    void set(const Settings &st) override {
        harm.p.set(st.harm, 0); harm.a = harm.b = (float)st.harm;
        if (!am) { index.p.set(st.index, 0); index.a = index.b = (float)st.index; }
        car.w = &basic_wave(st.osc); mod.w = &basic_wave(st.mod);
        env.set(st.env.a, st.env.d, st.env.s, st.env.r, st.env.aexp, st.env.rexp);
        menv.set(st.menv.a, st.menv.d, st.menv.s, st.menv.r, st.menv.aexp, st.menv.rexp);
    }
    void attack(double f, double t, double vel) override { env.triggerAttack(t, vel); menv.triggerAttack(t, vel); freq.setValueAtTime(f, t); }
    void release(double t) override { env.triggerRelease(t); menv.triggerRelease(t); }
    void timbre(int which, double v, double ramp, double now) override {
        if (which == 0) harm.p.linearRampTo(v, ramp, now);
        else if (!am) index.p.linearRampTo(v, ramp, now);
    }
    void render(float *L, float *R, int n, double t0) override {
        double te = t0 + n / sr;
        harm.block(te); index.block(te);
        if (env.idle(t0)) { env.sig.render(te); menv.sig.render(te); freq.render(te); return; }
        const float g = 0.31622777f;
        for (int i = 0; i < n; i++) {
            double t = t0 + i / sr, f = freq.render(t);
            float e = (float)env.sig.render(t), me = (float)menv.sig.render(t);
            float m = mod.tick(f * harm.at(i, n), sr) * me * g, y;
            if (am) y = car.tick(f, sr) * e * g * ((m + 1) * 0.5f);
            else y = car.tick(f + f * index.at(i, n) * m, sr) * e * g;
            y *= vol; L[i] += y; R[i] += y;
        }
    }
};

/* ---- MonoSynth: oscillator -> lowpass (driven by a FrequencyEnvelope) -> amplitude envelope ---- */
struct MonoSynth : Synth {
    Osc osc;
    Envelope env, fenv;
    Param freq;
    Ctl Q, detune;
    Biquad bq;
    double base = 200, octaves = 3, exponent = 2;
    void init(double s) override {
        Synth::init(s);
        env.init(s); fenv.init(s);
        env.set(0.005, 0.1, 0.9, 1); fenv.set(0.6, 0.2, 0.5, 2);
        osc.w = &basic_wave(SAWTOOTH);
        freq.reset(440); freq.exp_units = true;
        Q.init(1); detune.init(0);
        bq.type = LOWPASS;
    }
    void set(const Settings &st) override {
        osc.w = &basic_wave(st.osc);
        env.set(st.env.a, st.env.d, st.env.s, st.env.r, st.env.aexp, st.env.rexp);
    }
    void attack(double f, double t, double vel) override { env.triggerAttack(t, vel); fenv.triggerAttack(t); freq.setValueAtTime(f, t); }
    void release(double t) override { env.triggerRelease(t); fenv.triggerRelease(t); }
    void timbre(int which, double v, double ramp, double now) override {
        if (which == 0) Q.p.linearRampTo(v, ramp, now);
        else octaves = v;
    }
    /* adds this voice's mono output, before volume, into y (DuoSynth shares it) */
    void voice(float *y, int n, double t0, double hmul = 1, const float *cents = nullptr) {
        double te = t0 + n / sr;
        Q.block(te); detune.block(te);
        double fe = fenv.sig.render(t0);
        double cutoff = base + (base * std::pow(2.0, octaves) - base) * std::pow(fe < 0 ? 0 : fe, exponent);
        bq.design(cutoff, Q.a, sr);
        if (env.idle(t0)) { env.sig.render(te); freq.render(te); return; }
        for (int i = 0; i < n; i++) {
            double t = t0 + i / sr, f = freq.render(t) * hmul;
            double c = detune.at(i, n) + (cents ? cents[i] : 0);
            if (c != 0) f *= std::pow(2.0, c / 1200);
            float e = (float)env.sig.render(t);
            y[i] += bq.run(0, osc.tick(f, sr)) * e;
        }
    }
    void render(float *L, float *R, int n, double t0) override {
        float y[64] = {};
        voice(y, n, t0);
        for (int i = 0; i < n; i++) { L[i] += y[i] * vol; R[i] += y[i] * vol; }
    }
};

/* ---- DuoSynth: two sawtooth MonoSynths, the second at harmonicity x, a 5 Hz +-50 cent vibrato ---- */
struct DuoSynth : Synth {
    MonoSynth v0, v1;
    Ctl harm, amount;
    double lfo = 0;
    void init(double s) override {
        Synth::init(s);
        for (MonoSynth *v : { &v0, &v1 }) {
            v->init(s);
            v->env.set(0.01, 0, 1, 0.5); v->fenv.set(0.01, 0, 1, 0.5);
        }
        harm.init(1.5); amount.init(0.5);
    }
    void set(const Settings &st) override { harm.p.set(st.harm, 0); harm.a = harm.b = (float)st.harm; }
    void attack(double f, double t, double vel) override {
        v0.env.triggerAttack(t, vel); v0.fenv.triggerAttack(t); v1.env.triggerAttack(t, vel); v1.fenv.triggerAttack(t);
        v0.freq.setValueAtTime(f, t); v1.freq.setValueAtTime(f, t);
    }
    void release(double t) override { v0.release(t); v1.release(t); }
    void timbre(int which, double v, double ramp, double now) override {
        if (which == 0) harm.p.linearRampTo(v, ramp, now); else amount.p.linearRampTo(v, ramp, now);
    }
    void render(float *L, float *R, int n, double t0) override {
        double te = t0 + n / sr;
        harm.block(te); amount.block(te);
        float cents[64], y[64] = {};
        for (int i = 0; i < n; i++) {
            cents[i] = (float)(50 * std::sin(2 * PI * lfo)) * amount.at(i, n);
            lfo += 5 / sr; if (lfo >= 1) lfo -= 1;
        }
        v0.voice(y, n, t0, 1, cents);
        v1.voice(y, n, t0, harm.a, cents);
        for (int i = 0; i < n; i++) { L[i] += y[i] * vol; R[i] += y[i] * vol; }
    }
};

/* ---- Tone.Synth: an oscillator through an amplitude envelope (also the zones' one-shot) ---- */
struct SimpleSynth : Synth {
    Osc osc;
    Envelope env;
    Param freq;
    Ctl detune;
    void init(double s) override {
        Synth::init(s);
        env.init(s); env.set(0.005, 0.1, 0.3, 1);
        osc.w = &basic_wave(TRIANGLE);
        freq.reset(440); freq.exp_units = true; detune.init(0);
    }
    void set(const Settings &st) override {
        osc.w = &basic_wave(st.osc);
        env.set(st.env.a, st.env.d, st.env.s, st.env.r, st.env.aexp, st.env.rexp);
    }
    void attack(double f, double t, double vel) override { env.triggerAttack(t, vel); freq.setValueAtTime(f, t); }
    void release(double t) override { env.triggerRelease(t); }
    void timbre(int which, double v, double ramp, double now) override {
        if (which == 0) detune.p.linearRampTo(v, ramp, now); else env.release = v;
    }
    void render(float *L, float *R, int n, double t0) override {
        double te = t0 + n / sr;
        detune.block(te);
        if (env.idle(t0)) { env.sig.render(te); freq.render(te); return; }
        for (int i = 0; i < n; i++) {
            double t = t0 + i / sr, f = freq.render(t), c = detune.at(i, n);
            if (c != 0) f *= std::pow(2.0, c / 1200);
            float y = osc.tick(f, sr) * (float)env.sig.render(t) * vol;
            L[i] += y; R[i] += y;
        }
    }
};

/* Tone.Noise("pink"): a looping stereo buffer read from a random point, gated on and off. */
struct Noise {
    const std::vector<float> *ch[2] = { nullptr, nullptr };
    double start = 1e300, stop = 1e300;
    size_t pos = 0;
    void init() { ch[0] = &pink_noise(0); ch[1] = &pink_noise(1); }
    void gate(double t0, double t1, double rnd) { start = t0; stop = t1; pos = (size_t)(rnd * (ch[0]->size() - 1)); }
    void tick(double t, float &l, float &r) {
        if (t < start || t >= stop) { l = r = 0; return; }
        l = (*ch[0])[pos]; r = (*ch[1])[pos];
        if (++pos >= ch[0]->size()) pos = 0;
    }
};

/* NoiseSynth: pink noise through an amplitude envelope (the water zone) */
struct NoiseSynth : Synth {
    Noise noise;
    Envelope env;
    double (*rnd)(void *) = nullptr; void *rnd_ctx = nullptr;
    void init(double s) override { Synth::init(s); env.init(s); noise.init(); }
    void attack(double, double t, double vel) override { env.triggerAttack(t, vel); noise.gate(t, 1e300, rnd(rnd_ctx)); }
    void release(double t) override { env.triggerRelease(t); noise.stop = t + env.release; }
    void timbre(int, double, double, double) override {}
    void render(float *L, float *R, int n, double t0) override {
        if (env.idle(t0)) { env.sig.render(t0 + n / sr); return; }
        for (int i = 0; i < n; i++) {
            double t = t0 + i / sr; float l, r, e = (float)env.sig.render(t) * vol;
            noise.tick(t, l, r);
            L[i] += l * e; R[i] += r * e;
        }
    }
};

/* ---- PluckSynth: a burst of pink noise into a lowpass-comb tuned to the note ---- */
struct PluckSynth : Synth {
    Noise noise;
    LowpassComb lfcf;
    double attack_noise = 1.2, resonance = 0.92, release_s = 1, dampening = 3200;
    double (*rnd)(void *) = nullptr; void *rnd_ctx = nullptr;
    void init(double s) override {
        Synth::init(s); noise.init();
        lfcf.init(s, 0.1, 0.92, 3200);
    }
    void attack(double f, double t, double) override {
        double d = 1 / f;
        lfcf.delay.p.setValueAtTime(d, t);
        noise.gate(t, t + d * attack_noise, rnd(rnd_ctx));
        lfcf.resonance.p.cancelScheduledValues(t);
        lfcf.resonance.p.setValueAtTime(resonance, t);
    }
    void release(double t) override { lfcf.resonance.p.linearRampTo(0, release_s, t); }
    void timbre(int which, double v, double, double) override {
        if (which == 0) { dampening = v; lfcf.lp.set(v, sr); } else resonance = v;
    }
    void render(float *L, float *R, int n, double t0) override {
        lfcf.block(t0 + n / sr);
        for (int i = 0; i < n; i++) {
            float l, r; noise.tick(t0 + i / sr, l, r);
            L[i] += lfcf.run(0, l, i, n) * vol; R[i] += lfcf.run(1, r, i, n) * vol;
        }
    }
};

/* ---- MetalSynth: six square FM oscillators at inharmonic ratios, through a highpass swept by
   the envelope ---- */
struct MetalSynth : Synth {
    Osc car[6], mod[6];
    Envelope env;
    Param freq;
    Biquad hp[2];
    double harmonicity = 5.1, modulationIndex = 32, resonance = 4000, octaves = 1.5;
    void init(double s) override {
        Synth::init(s);
        for (int i = 0; i < 6; i++) { car[i].w = &basic_wave(SQUARE); mod[i].w = &basic_wave(SQUARE); }
        env.init(s); env.set(0.004, 1.8, 0, 2.6);        /* makeSynth's envelope, sustain forced 0 */
        harmonicity = 4.1; modulationIndex = 18; resonance = 3500; octaves = 1.2;
        freq.reset(440); freq.exp_units = true;
        hp[0].type = hp[1].type = HIGHPASS;
    }
    void set(const Settings &st) override { harmonicity = st.harm; modulationIndex = st.index; }
    void attack(double f, double t, double vel) override { env.triggerAttack(t, vel); freq.setValueAtTime(f, t); }
    void release(double t) override { env.triggerRelease(t); }
    void timbre(int which, double v, double, double) override { if (which == 0) harmonicity = v; else octaves = v; }
    void render(float *L, float *R, int n, double t0) override {
        static const double R_[6] = { 1.0, 1.483, 1.932, 2.546, 2.63, 3.897 };
        double te = t0 + n / sr;
        if (env.idle(t0)) { env.sig.render(te); freq.render(te); return; }
        double e0 = env.sig.value(t0);
        hp[0].design(resonance + (resonance * std::pow(2.0, octaves) - resonance) * e0, 0, sr);
        for (int i = 0; i < n; i++) {
            double t = t0 + i / sr, f = freq.render(t);
            float e = (float)env.sig.render(t), sum = 0;
            for (int k = 0; k < 6; k++) {
                double fk = f * R_[k];
                float m = mod[k].tick(fk * harmonicity, sr);
                sum += car[k].tick(fk + fk * modulationIndex * m, sr);
            }
            float y = hp[0].run(0, sum) * e * vol;
            L[i] += y; R[i] += y;
        }
    }
};

/* ---- MembraneSynth: a sine whose pitch falls from note x 2^octaves to the note ---- */
struct MembraneSynth : SimpleSynth {
    double pitch_decay = 0.12, octaves = 3.2;
    void init(double s) override {
        SimpleSynth::init(s);
        osc.w = &basic_wave(SINE);
        env.set(0.006, 1, 0.02, 2, true, true);
    }
    void set(const Settings &) override {}
    void attack(double f, double t, double vel) override {
        env.triggerAttack(t, vel);
        freq.setValueAtTime(f * std::pow(2.0, octaves), t);
        freq.exponentialRampToValueAtTime(f, t + pitch_decay);
    }
    void timbre(int which, double v, double, double) override {
        /* Tone asserts these ranges and throws outside them; clamped here instead */
        if (which == 0) pitch_decay = v < 0 ? 0 : (v > 0.5 ? 0.5 : v);
        else octaves = v < 0.5 ? 0.5 : (v > 8 ? 8 : v);
    }
};

/* ---- index.html's three: a harmonicity and a modulationIndex Signal each, read every 120 ms ---- */
struct Followed : Synth {
    Ctl harmonicity, modulationIndex;
    double next_follow = 0;
    void set(const Settings &st) override {
        harmonicity.p.set(st.harm, 0); harmonicity.a = harmonicity.b = (float)st.harm;
        modulationIndex.p.set(st.index, 0); modulationIndex.a = modulationIndex.b = (float)st.index;
    }
    void timbre(int which, double v, double ramp, double now) override {
        (which == 0 ? harmonicity : modulationIndex).p.linearRampTo(v, ramp, now);
    }
    virtual void follow(double now) = 0;
    void tick_follow(double t0) {
        if (t0 >= next_follow) { follow(t0); next_follow = t0 + 0.12; }
    }
    static double clamp01(double v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
};

static const double WAVE_GAIN[8] = { 0.704, 0.575, 0.774, 1.012, 1.000, 2.100, 1.458, 1.347 };

struct WavetableVoice : Followed {
    Osc a, b;
    Ctl ga, gb;
    Envelope env;
    Param freq;
    Filter tone;
    int idx = -1;
    void init(double s) override {
        Synth::init(s);
        env.init(s); env.set(0.06, 0.4, 0.62, 2);
        tone.init(LOWPASS, 6000, 0.6);
        a.w = b.w = &basic_wave(SINE);
        ga.init(1); gb.init(0);
        freq.reset(220); freq.exp_units = true;
        harmonicity.init(0.35); modulationIndex.init(0.5);
        follow(0);
    }
    void follow(double now) override {
        double pos = clamp01(harmonicity.p.value(now));
        int span = 7; double x = pos * span;
        int i = (int)std::floor(x); if (i > span - 1) i = span - 1;
        double f = x - i;
        if (i != idx) { idx = i; a.w = &custom_wave(i); b.w = &custom_wave(i + 1); }
        ga.p.linearRampTo((1 - f) * WAVE_GAIN[i], 0.12, now);
        gb.p.linearRampTo(f * WAVE_GAIN[i + 1], 0.12, now);
        double br = clamp01(modulationIndex.p.value(now));
        tone.freq.p.exponentialRampTo(500 + br * 9000, 0.15, now);
    }
    void attack(double f, double t, double vel) override { freq.setValueAtTime(f, t); env.triggerAttack(t, vel); }
    void release(double t) override { env.triggerRelease(t); }
    void render(float *L, float *R, int n, double t0) override {
        double te = t0 + n / sr;
        tick_follow(t0);
        harmonicity.block(te); modulationIndex.block(te); ga.block(te); gb.block(te); tone.block(te, sr);
        if (env.idle(t0)) { env.sig.render(te); freq.render(te); return; }
        for (int i = 0; i < n; i++) {
            double t = t0 + i / sr, f = freq.render(t);
            float y = (a.tick(f, sr) * ga.at(i, n) + b.tick(f, sr) * gb.at(i, n)) * (float)env.sig.render(t);
            y = tone.bq.run(0, y) * vol;
            L[i] += y; R[i] += y;
        }
    }
};

struct CombVoice : Followed {
    Noise noise;
    Filter exc;
    Envelope env;
    LowpassComb comb;
    double (*rnd)(void *) = nullptr; void *rnd_ctx = nullptr;
    void init(double s) override {
        Synth::init(s);
        noise.init(); noise.gate(0, 1e300, 0.37);
        exc.init(BANDPASS, 900, 0.9);
        env.init(s); env.set(0.14, 0.5, 0.5, 1.8);
        comb.init(s, 0.005, 0.85, 3000);
        harmonicity.init(0.4); modulationIndex.init(0.5);
        follow(0);
    }
    void follow(double now) override {
        comb.lp.set(600 + clamp01(harmonicity.p.value(now)) * 7000, sr);
        comb.resonance.p.linearRampTo(0.55 + clamp01(modulationIndex.p.value(now)) * 0.42, 0.15, now);
    }
    void attack(double f, double t, double vel) override {
        double dt = 1 / (f < 20 ? 20 : (f > 4000 ? 4000 : f));
        comb.delay.p.setValueAtTime(dt, t);
        exc.freq.p.setValueAtTime(f * 3 < 9000 ? f * 3 : 9000, t);
        env.triggerAttack(t, vel);
    }
    void release(double t) override { env.triggerRelease(t); }
    void render(float *L, float *R, int n, double t0) override {
        double te = t0 + n / sr;
        tick_follow(t0);
        harmonicity.block(te); modulationIndex.block(te); exc.block(te, sr); comb.block(te);
        for (int i = 0; i < n; i++) {
            double t = t0 + i / sr; float l, r;
            noise.tick(t, l, r);
            float e = (float)env.sig.render(t);
            l = exc.bq.run(0, l) * e; r = exc.bq.run(1, r) * e;
            L[i] += comb.run(0, l, i, n) * vol; R[i] += comb.run(1, r, i, n) * vol;
        }
    }
};

struct FormantVoice : Followed {
    struct F { double f[5], a[5], b[5]; };
    Osc osc;
    Filter tilt, bp[5];
    Ctl g[5], sum;
    Envelope env;
    Param freq;
    void init(double s) override {
        Synth::init(s);
        osc.w = &basic_wave(SAWTOOTH);
        tilt.init(LOWPASS, 1400, 0);
        env.init(s); env.set(0.08, 0.4, 0.65, 2.2);
        for (int k = 0; k < 5; k++) { bp[k].init(BANDPASS, formants()[2].f[k], 8); g[k].init(0); }
        sum.init(0.5);
        freq.reset(220); freq.exp_units = true;
        harmonicity.init(0.5); modulationIndex.init(0.5);
        follow(0);
    }
    static const F *formants() {
        static const F T[5] = {
            { { 350, 600, 2700, 2900, 3300 }, { 0, -20, -17, -14, -26 }, { 40, 60, 100, 120, 120 } },
            { { 400, 800, 2600, 2800, 3000 }, { 0, -10, -12, -12, -26 }, { 70, 80, 100, 130, 135 } },
            { { 650, 1080, 2650, 2900, 3250 }, { 0, -6, -7, -8, -22 }, { 80, 90, 120, 130, 140 } },
            { { 400, 1700, 2600, 3200, 3580 }, { 0, -14, -12, -14, -20 }, { 70, 80, 100, 120, 120 } },
            { { 290, 1870, 2800, 3250, 3540 }, { 0, -15, -18, -20, -30 }, { 40, 90, 100, 120, 120 } },
        };
        return T;
    }
    double source_at(double hz, double now) const {
        double f0 = freq.value(now);
        if (!(f0 > 0) || hz < f0) return 0;
        double fc = tilt.freq.p.value(now);
        double tl = 1 / std::sqrt(1 + std::pow(hz / (fc > 20 ? fc : 20), 4));
        return (f0 / hz) * tl;
    }
    void follow(double now) override {
        double v = clamp01(harmonicity.p.value(now)), sh = clamp01(modulationIndex.p.value(now));
        double shift = 0.7 + sh * 0.9;
        int span = 4; double x = v * span;
        int i = (int)std::floor(x); if (i > span - 1) i = span - 1;
        double f = x - i;
        const F &A = formants()[i], &B = formants()[i + 1];
        double power = 0;
        for (int k = 0; k < 5; k++) {
            double hz = std::exp((1 - f) * std::log(A.f[k]) + f * std::log(B.f[k])) * shift;
            double bw = std::exp((1 - f) * std::log(A.b[k]) + f * std::log(B.b[k])) * shift;
            double db = (1 - f) * A.a[k] + f * B.a[k];
            double q = hz / bw > 1 ? hz / bw : 1, gg = std::pow(10.0, db / 20);
            bp[k].freq.p.exponentialRampTo(hz < 15000 ? hz : 15000, 0.12, now);
            bp[k].Q.p.linearRampTo(q, 0.12, now);
            g[k].p.linearRampTo(gg, 0.12, now);
            double a = source_at(hz, now);
            power += gg * gg * a * a * (hz / q);
        }
        double norm = power > 1e-12 ? 1.8 / std::sqrt(power) : 0;
        sum.p.linearRampTo(norm < 12 ? norm : 12, 0.15, now);
    }
    void attack(double f, double t, double vel) override {
        freq.setValueAtTime(f, t);
        double c = f * 6; c = c < 500 ? 500 : (c > 4000 ? 4000 : c);
        tilt.freq.p.setValueAtTime(c, t);
        env.triggerAttack(t, vel);
    }
    void release(double t) override { env.triggerRelease(t); }
    void render(float *L, float *R, int n, double t0) override {
        double te = t0 + n / sr;
        tick_follow(t0);
        harmonicity.block(te); modulationIndex.block(te); tilt.block(te, sr); sum.block(te);
        for (int k = 0; k < 5; k++) { bp[k].block(te, sr); g[k].block(te); }
        if (env.idle(t0)) { env.sig.render(te); freq.render(te); return; }
        for (int i = 0; i < n; i++) {
            double t = t0 + i / sr, f = freq.render(t);
            float x = tilt.bq.run(0, osc.tick(f, sr)) * (float)env.sig.render(t), y = 0;
            for (int k = 0; k < 5; k++) y += bp[k].bq.run(0, x) * g[k].at(i, n);
            y *= sum.at(i, n) * vol;
            L[i] += y; R[i] += y;
        }
    }
};

}  // namespace tone
