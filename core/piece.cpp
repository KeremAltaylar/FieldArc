/* The piece: the web walk's generative sound, as one device (index.html, bedStart onward).

   What it holds, as the web's `bed` does: a Transport on a sixteenth-note grid; the chord model and
   the three route voices (pad = bass + top, the sector counter-line, the third voice), each through
   drive, warp, filter and its own delay-into-room; the zones' one-shots; the morphs; and the rhythm
   points (hits and grains) through their shared rhythm effects. Every step function is index.html's,
   line for line, with Math.random drawn from one stream (core/tests/piece_test.cpp holds the note
   choices to the JS). The point recordings (stretch) stay in fs_mix slots; this device is one more
   slot, at gain 1, and applies the route's own leash (setSynthLevel) inside.

   Threads: fs_piece_* calls come from one non-audio thread and only touch the inbox, under a mutex;
   the audio thread takes the inbox with try_lock at the start of a block. Everything the audio thread
   needs is allocated by the calling thread (patches, synth instances, buffers); anything it lets go
   of is handed back through the inbox and freed there. */
#include "fieldscape.h"
#include "device.hpp"
#include "json.hpp"
#include "synths.hpp"

#include <cstring>
#include <memory>
#include <mutex>
#include <string>

using namespace tone;

/* ------------------------------------------------------------------ shared tables */
namespace tone {
const Wave &basic_wave(int type) {
    struct W { Wave w[NTYPES]; W() {
        for (int t = 0; t < NTYPES; t++) {
            std::vector<double> b(Wave::MAXP - 1, 0.0);
            for (int n = 1; n < Wave::MAXP; n++) {
                double pf = 2 / (n * PI), v = 0;
                if (t == SINE) v = n <= 1 ? 1 : 0;
                else if (t == SQUARE) v = (n & 1) ? 2 * pf : 0;
                else if (t == SAWTOOTH) v = pf * ((n & 1) ? 1 : -1);
                else v = (n & 1) ? 2 * pf * pf * ((((n - 1) >> 1) & 1) ? -1 : 1) : 0;
                b[n - 1] = v;
            }
            w[t].build(b);
        } } };
    static W w;
    return w.w[type];
}
/* WAVE_TABLES: eight frames of 32 partials (index.html) */
const Wave &custom_wave(int index) {
    struct W { Wave w[8]; W() {
        auto odd = [](int i) { return i % 2 == 1; };
        for (int k = 0; k < 8; k++) {
            std::vector<double> a(32);
            for (int i = 1; i <= 32; i++) {
                double v;
                switch (k) {
                case 0: v = i == 1 ? 1 : 0; break;
                case 1: v = odd(i) ? std::pow(i, -1.35) : 0; break;
                case 2: v = odd(i) ? std::pow(i, -0.85) : 0; break;
                case 3: v = std::pow(i, -0.85) * (odd(i) ? 1 : 0.35); break;
                case 4: v = 1.0 / i; break;
                case 5: v = std::pow(i, -0.5); break;
                case 6: v = (1.0 / i) * (1 + 4 * std::exp(-std::pow(i - 7, 2) / 8)); break;
                default: v = std::pow(i, -0.7) * std::fabs(std::sin(i * 0.9)); break;
                }
                a[i - 1] = v;
            }
            w[k].build(a);     /* the energy normalisation the JS applies washes out in the peak one */
        } } };
    static W w;
    return w.w[index];
}
const std::vector<float> &pink_noise(int ch) {
    struct P { std::vector<float> c[2]; P() {
        uint64_t s = 0x9E3779B97F4A7C15ULL;
        for (int k = 0; k < 2; k++) {
            c[k].resize(44100 * 5);
            double b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
            for (auto &x : c[k]) {
                s ^= s << 13; s ^= s >> 7; s ^= s << 17;
                double white = (s >> 11) * (1.0 / 9007199254740992.0) * 2 - 1;
                b0 = 0.99886 * b0 + white * 0.0555179; b1 = 0.99332 * b1 + white * 0.0750759;
                b2 = 0.969 * b2 + white * 0.153852; b3 = 0.8665 * b3 + white * 0.3104856;
                b4 = 0.55 * b4 + white * 0.5329522; b5 = -0.7616 * b5 - white * 0.016898;
                x = (float)((b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11);
                b6 = white * 0.115926;
            }
        } } };
    static P p;
    return p.c[ch];
}
}  // namespace tone

/* ------------------------------------------------------------------ the patch (patchOf) */
static const struct { const char *name; int n; int iv[6]; } CHORDS[] = {
    { "maj7", 4, { 0, 4, 7, 11 } }, { "maj9", 5, { 0, 4, 7, 11, 14 } }, { "maj7#11", 5, { 0, 4, 6, 11, 14 } },
    { "6/9", 5, { 0, 4, 7, 9, 14 } }, { "m7", 4, { 0, 3, 7, 10 } }, { "m9", 5, { 0, 3, 7, 10, 14 } },
    { "m11", 6, { 0, 3, 7, 10, 14, 17 } }, { "m6", 4, { 0, 3, 7, 9 } }, { "mMaj7", 4, { 0, 3, 7, 11 } },
    { "7", 4, { 0, 4, 7, 10 } }, { "9", 5, { 0, 4, 7, 10, 14 } }, { "13", 6, { 0, 4, 7, 10, 14, 21 } },
    { "7#11", 5, { 0, 4, 6, 10, 14 } }, { "7b9", 5, { 0, 4, 7, 10, 13 } }, { "7alt", 5, { 0, 4, 8, 10, 13 } },
    { "7sus4", 4, { 0, 5, 7, 10 } }, { "m7b5", 4, { 0, 3, 6, 10 } }, { "dim7", 4, { 0, 3, 6, 9 } },
    { "aug", 3, { 0, 4, 8 } }, { "add9", 4, { 0, 4, 7, 14 } }, { "sus2", 3, { 0, 2, 7 } },
    { "sus4", 3, { 0, 5, 7 } }, { "quartal", 4, { 0, 5, 10, 15 } },
};
static const int NCHORDS = sizeof(CHORDS) / sizeof(CHORDS[0]);
enum { Q_M7 = 4, Q_7B9 = 13 };
static bool dom_q(int q) {   /* DOM_Q */
    if (q < 0) return false;
    const char *n = CHORDS[q].name;
    return !std::strcmp(n, "7") || !std::strcmp(n, "9") || !std::strcmp(n, "13") || !std::strcmp(n, "7b9") ||
           !std::strcmp(n, "7alt") || !std::strcmp(n, "7#11") || !std::strcmp(n, "7sus4");
}
static const struct { const char *name; int n; int iv[7]; } MODES[] = {
    { "lydian", 7, { 0, 2, 4, 6, 7, 9, 11 } }, { "dorian", 7, { 0, 2, 3, 5, 7, 9, 10 } },
    { "phrygian", 7, { 0, 1, 3, 5, 7, 8, 10 } }, { "mixolydian", 7, { 0, 2, 4, 5, 7, 9, 10 } },
    { "aeolian", 7, { 0, 2, 3, 5, 7, 8, 10 } }, { "lydian b7", 7, { 0, 2, 4, 6, 7, 9, 10 } },
    { "altered", 7, { 0, 1, 3, 4, 6, 8, 10 } }, { "harmonic minor", 7, { 0, 2, 3, 5, 7, 8, 11 } },
    { "whole tone", 6, { 0, 2, 4, 6, 8, 10 } }, { "pentatonic minor", 5, { 0, 3, 5, 7, 10 } },
    { "in sen", 5, { 0, 1, 5, 7, 10 } }, { "locrian", 7, { 0, 1, 3, 5, 6, 8, 10 } },
};
static const int NMODES = sizeof(MODES) / sizeof(MODES[0]), MODE_DORIAN = 1;
enum MorphDest { M_VOICE_CUTOFF, M_SECT_CUTOFF, M_SECT_INDEX, M_VOICE_GAIN, M_VOICE_INDEX, M_VOICE_HARM, M_VOICE_DRIVE,
                 M_VOICE_WARP, M_SECT_HARM, M_SECT_DRIVE, M_SECT_WARP, M_V3_CUTOFF, M_V3_HARM, M_V3_INDEX, M_V3_DRIVE,
                 M_V3_WARP, NDEST };
static const char *const DEST_KEYS[NDEST] = { "voice.cutoff", "sect.cutoff", "sect.index", "voice.gain", "voice.index",
    "voice.harm", "voice.drive", "voice.warp", "sect.harm", "sect.drive", "sect.warp", "v3.cutoff", "v3.harm",
    "v3.index", "v3.drive", "v3.warp" };
enum Shape { SH_DRIFT, SH_BREATH, SH_PULSE, SH_RAMP, SH_TIDE };

static int find_chord(const std::string &s) { for (int i = 0; i < NCHORDS; i++) if (s == CHORDS[i].name) return i; return -1; }
static int find_mode(const std::string &s) { for (int i = 0; i < NMODES; i++) if (s == MODES[i].name) return i; return -1; }
static int find_synth(const std::string &s, int def) { for (int i = 0; i < NSYNTH; i++) if (s == SYNTH_NAMES[i]) return i; return def; }

/* divSeconds and SECT_STRIDE read the same strings */
struct Div { char s[6] = "8n"; };
static Div div_of(const std::string &s) { Div d; std::strncpy(d.s, s.c_str(), 5); d.s[5] = 0; return d; }
static double div_seconds(const Div &d, double bpm) {
    double beat = 60 / bpm, b = 1;
    std::string s = d.s;
    bool dotted = !s.empty() && s.back() == '.';
    size_t p = s.find('.'); if (p != std::string::npos) s.erase(p, 1);
    if (s == "1n") b = 4; else if (s == "2n") b = 2; else if (s == "4n") b = 1; else if (s == "8n") b = 0.5; else if (s == "16n") b = 0.25;
    return beat * b * (dotted ? 1.5 : 1);
}
static int stride_of(const Div &d, int def) {
    static const struct { const char *s; int n; } T[] = { { "16n", 1 }, { "8n", 2 }, { "8n.", 3 }, { "4n", 4 }, { "4n.", 6 }, { "2n", 8 }, { "2n.", 12 }, { "1n", 16 } };
    for (auto &t : T) if (!std::strcmp(t.s, d.s)) return t.n;
    return def;
}
static const double MAX_DELAY_S = 4;

struct Chord { int r, q, k; bool sd; };
struct Sector { int mode, r; };
struct Morph { bool on; int shape, dest, seed; double period, depth, bias, phase; };
struct FxCfg { Div delayDiv; double delayWet, delayFb, revWet, revDecay; };
struct VoiceCfg { bool on; double gain, density, bass, top, index, harm, drive, warp; int synth; };
struct SectCfg { bool on; int n; double gain; Div rhythm; double chordPull, harm, index, drive, warp; int synth; };
struct V3Cfg { bool on; double gain; Div rhythm; int synth; double harm, index, drive, warp; };
struct RfxCfg { double cutoff, drive; Div delayDiv; double delayWet, delayFb, revWet, revDecay; };
struct Patch {
    double tempo = 72; int key = 50, key2 = 55;
    Chord prog[64]; int nprog = 0;
    bool bed_on = true; int bed_voices = 4;
    VoiceCfg voice; FxCfg fx, fx2, fx3; V3Cfg v3; RfxCfg rfx; SectCfg sect;
    bool zones_on = true, morph_on = true;
    Morph morph[24]; int nmorph = 0;
    Sector sectors[32]; int nsectors = 0;
};

static FxCfg fx_of(const Json *j, const char *div, double wet, double fb, double rw, double rd) {
    FxCfg f;
    f.delayDiv = div_of(j ? j->s("delayDiv", div) : div);
    f.delayWet = j ? j->n("delayWet", wet) : wet; f.delayFb = j ? j->n("delayFb", fb) : fb;
    f.revWet = j ? j->n("revWet", rw) : rw; f.revDecay = j ? j->n("revDecay", rd) : rd;
    return f;
}

/* defaultPatch(), then whatever the feature's patch says over it (patchOf's migrations all end at
   version 17 with these defaults filled in; before version 4, or without a progression, it is the
   default patch). */
static void patch_of(const Json *p, Patch &P) {
    static const struct { int r; const char *q; } PROG[16] = {
        { 0, "m9" }, { 0, "m11" }, { 5, "maj7#11" }, { 5, "6/9" }, { 10, "maj9" }, { 10, "maj7" }, { 3, "maj7#11" }, { 3, "6/9" },
        { 8, "maj9" }, { 8, "13" }, { 1, "maj7" }, { 1, "maj9" }, { 2, "m7b5" }, { 7, "7alt" }, { 0, "m9" }, { 0, "m6" } };
    static const struct { const char *mode; int r; } SECT[7] = {
        { "lydian", 0 }, { "dorian", 5 }, { "lydian b7", 10 }, { "harmonic minor", 2 }, { "altered", 6 }, { "in sen", 1 }, { "pentatonic minor", 9 } };
    static const struct { const char *id, *shape; double period, depth, bias, phase; const char *dest; } MORPHS[6] = {
        { "m1", "tide", 660, 0.85, 0.08, 0, "voice.cutoff" }, { "m2", "drift", 190, 0.70, 0.15, 0.31, "voice.cutoff" },
        { "m3", "breath", 47, 0.55, 0.22, 0.62, "voice.cutoff" }, { "m4", "drift", 310, 0.80, 0.10, 0.17, "sect.index" },
        { "m5", "breath", 97, 0.60, 0.30, 0.44, "sect.cutoff" }, { "m6", "breath", 90, 0.55, 0.30, 0, "voice.gain" } };
    auto shape_of = [](const std::string &s) { return s == "breath" ? SH_BREATH : s == "pulse" ? SH_PULSE : s == "ramp" ? SH_RAMP : s == "tide" ? SH_TIDE : SH_DRIFT; };
    auto dest_of = [](const std::string &s) { for (int i = 0; i < NDEST; i++) if (s == DEST_KEYS[i]) return i; return -1; };
    auto seed_of = [](const std::string &id) { int c = id.empty() ? 'm' : (unsigned char)id.back(); return c ? c : 7; };

    int version = p ? (int)p->n("version", 0) : 0;
    const Json *prog = p ? p->get("prog") : nullptr;
    bool use = p && prog && prog->kind == Json::ARR && prog->size() && version >= 4 && version <= 17;
    if (!use) p = nullptr;

    P.tempo = p ? p->n("tempo", 72) : 72; P.key = p ? (int)p->n("key", 50) : 50; P.key2 = p ? (int)p->n("key2", 55) : 55;
    P.nprog = 0;
    if (p) for (size_t i = 0; i < prog->size() && P.nprog < 64; i++) {
        const Json *c = prog->at(i);
        P.prog[P.nprog++] = Chord{ (int)c->n("r", 0), find_chord(c->s("q", "m7")), (int)c->n("k", 1), c->flag("sd", false) };
    } else for (auto &c : PROG) P.prog[P.nprog++] = Chord{ c.r, find_chord(c.q), 1, false };

    const Json *bed = p ? p->get("bed") : nullptr;
    P.bed_on = bed ? bed->flag("on", true) : true; P.bed_voices = bed ? (int)bed->n("voices", 4) : 4;
    const Json *v = p ? p->get("voice") : nullptr;
    P.voice = VoiceCfg{ v ? v->flag("on", true) : true, v ? v->n("gain", 0.45) : 0.45, v ? v->n("density", 0.5) : 0.5,
        v ? v->n("bass", 0.9) : 0.9, v ? v->n("top", 0.8) : 0.8, v ? v->n("index", 4) : 4, v ? v->n("harm", 1) : 1,
        v ? v->n("drive", 0.12) : 0.12, v ? v->n("warp", 0.1) : 0.1, find_synth(v ? v->s("synth", "fm") : "fm", FM) };
    P.fx = fx_of(p ? p->get("fx") : nullptr, "8n.", 0.75, 0.85, 0.18, 3.4);
    P.fx2 = fx_of(p ? p->get("fx2") : nullptr, "8n", 0.4, 0.55, 0.12, 1.8);
    P.fx3 = fx_of(p ? p->get("fx3") : nullptr, "4n", 0.32, 0.5, 0.26, 5);
    const Json *v3 = p ? p->get("v3") : nullptr;
    P.v3 = V3Cfg{ v3 ? v3->flag("on", true) : true, v3 ? v3->n("gain", 0.55) : 0.55, div_of(v3 ? v3->s("rhythm", "1n") : "1n"),
        find_synth(v3 ? v3->s("synth", "am") : "am", AM), v3 ? v3->n("harm", 1.5) : 1.5, v3 ? v3->n("index", 3) : 3,
        v3 ? v3->n("drive", 0.1) : 0.1, v3 ? v3->n("warp", 0.22) : 0.22 };
    const Json *r = p ? p->get("rfx") : nullptr;
    P.rfx = RfxCfg{ r ? r->n("cutoff", 9000) : 9000, r ? r->n("drive", 0.15) : 0.15, div_of(r ? r->s("delayDiv", "8n") : "8n"),
        r ? r->n("delayWet", 0.22) : 0.22, r ? r->n("delayFb", 0.34) : 0.34, r ? r->n("revWet", 0.14) : 0.14, r ? r->n("revDecay", 1.2) : 1.2 };
    const Json *z = p ? p->get("zones") : nullptr;
    P.zones_on = z ? z->flag("on", true) : true;
    const Json *s = p ? p->get("sect") : nullptr;
    P.sect = SectCfg{ s ? s->flag("on", true) : true, s ? (int)s->n("n", 7) : 7, s ? s->n("gain", 0.8) : 0.8,
        div_of(s ? s->s("rhythm", "4n.") : "4n."), s ? s->n("chordPull", 0.35) : 0.35, s ? s->n("harm", 2.02) : 2.02,
        s ? s->n("index", 7.5) : 7.5, s ? s->n("drive", 0.18) : 0.18, s ? s->n("warp", 0.14) : 0.14,
        find_synth(s ? s->s("synth", "fm") : "fm", FM) };

    const Json *m = p ? p->get("morph") : nullptr;
    P.nmorph = 0;
    if (m) {
        P.morph_on = m->flag("on", true);
        const Json *list = m->get("list");
        for (size_t i = 0; list && i < list->size() && P.nmorph < 24; i++) {
            const Json *e = list->at(i);
            std::string sh = e->s("shape", "drift"), d = e->s("dest", "");
            if (version < 11 && (sh == "field" || !(d == "voice.cutoff" || d == "voice.gain" || d == "sect.cutoff" || d == "sect.index"))) continue;
            P.morph[P.nmorph++] = Morph{ e->flag("on", false), shape_of(sh), dest_of(d), seed_of(e->s("id", "")),
                e->n("period", 60), e->n("depth", 1), e->n("bias", 0), e->n("phase", 0) };
        }
    }
    if (!m || (version < 11 && P.nmorph == 0)) {
        P.morph_on = true; P.nmorph = 0;
        for (auto &d : MORPHS) P.morph[P.nmorph++] = Morph{ true, shape_of(d.shape), dest_of(d.dest), seed_of(d.id), d.period, d.depth, d.bias, d.phase };
    }
    const Json *sec = p ? p->get("sectors") : nullptr;
    P.nsectors = 0;
    for (size_t i = 0; sec && i < sec->size() && P.nsectors < 32; i++) {
        const Json *e = sec->at(i);
        P.sectors[P.nsectors++] = Sector{ find_mode(e->s("mode", "")), (int)e->n("r", 0) };
    }
    if (!P.nsectors) for (auto &e : SECT) P.sectors[P.nsectors++] = Sector{ find_mode(e.mode), e.r };
}

/* ------------------------------------------------------------------ rhythm (rhythmOf) */
static const char *const HIT_SLOTS[4] = { "low", "mid", "high", "rand" };
struct HitCfg { int pulses, rotate; double gain, pitch, crush, drive; Div delayDiv; double delayFb, delayWet, stretch; };
struct GrainCfg { double pulses, rotate, offset, grain, count, spread, scatter, gain, pitch, vary, roam, attack, decay, sustain, release; };
struct Combo { int pulses, rotate; };
struct RhythmCfg {
    bool on = true; int steps = 64; Div div; double gain = 0.85, idiom = 0.35; int sentence_bars = 8;
    HitCfg v[4]; GrainCfg g; Combo sentence[4][4]; bool has_sentence = false;
};

/* ------------------------------------------------------------------ random: one stream */
struct Rng {
    uint64_t s = 0x853c49e6748fea9bULL;
    double (*hook)(void *) = nullptr; void *hook_ctx = nullptr;   /* tests replay the JS's own draws */
    double operator()() {
        if (hook) return hook(hook_ctx);
        s ^= s << 13; s ^= s >> 7; s ^= s << 17;
        return (s >> 11) * (1.0 / 9007199254740992.0);
    }
    static double call(void *self) { return (*(Rng *)self)(); }
};

static int gcd(int a, int b) { while (b) { int t = a % b; a = b; b = t; } return a; }
/* buildSentenceSet / oneComboSet */
static void build_sentence(RhythmCfg &r, int steps, Rng &rnd) {
    static const double BAND[4][2] = { { 0.05, 0.16 }, { 0.16, 0.34 }, { 0.28, 0.55 }, { 0.04, 0.28 } };
    for (int var = 0; var < 4; var++) {
        Combo out[4];
        for (int s = 0; s < 4; s++) {
            int k = (int)std::round(steps * (BAND[s][0] + rnd() * (BAND[s][1] - BAND[s][0])));
            if (k < 1) k = 1;
            for (int tries = 0; tries < 4 && gcd(k, steps) > 1; tries++) {
                int up = k + 1;
                k = (up <= steps && up <= (int)std::ceil(steps * BAND[s][1]) + 1) ? up : k - 1;
                if (k < 1) { k = 1; break; }
            }
            out[s].pulses = k < steps ? k : steps;
            out[s].rotate = rnd() < 0.45 ? 0 : (int)std::floor(rnd() * steps);
        }
        std::vector<std::pair<int, int>> seen;
        for (int s = 0; s < 4; s++) {
            Combo &c = out[s];
            for (auto &q : seen) if (q.first == c.pulses && q.second == c.rotate) { c.rotate = (c.rotate + 1 + (int)std::floor(rnd() * 3)) % steps; break; }
            seen.push_back({ c.pulses, c.rotate });
        }
        for (int s = 0; s < 4; s++) r.sentence[s][var] = out[s];
    }
    r.has_sentence = true;
}

static void rhythm_of(const Json *j, RhythmCfg &r, Rng &rnd) {
    static const HitCfg DV[4] = {
        { 8, 0, 1.00, 0, 0, 0, div_of("8n"), 0, 0, 0 }, { 13, 2, 0.80, 0, 0, 0, div_of("8n"), 0, 0, 0 },
        { 21, 1, 0.65, 0, 0, 0, div_of("8n"), 0, 0, 0 }, { 5, 11, 0.55, 0, 0, 0, div_of("8n"), 0, 0, 0 } };
    r.on = j ? j->flag("on", true) : true;
    r.steps = j ? (int)j->n("steps", 64) : 64;
    r.div = div_of(j ? j->s("div", "16n") : "16n");
    r.gain = j ? j->n("gain", 0.85) : 0.85;
    r.idiom = j ? j->n("idiom", 0.35) : 0.35;
    r.sentence_bars = j ? (int)j->n("sentenceBars", 8) : 8;
    const Json *vs = j ? j->get("voices") : nullptr;
    for (int s = 0; s < 4; s++) {
        const Json *v = vs ? vs->get(HIT_SLOTS[s]) : nullptr;
        const HitCfg &d = DV[s];
        r.v[s] = v ? HitCfg{ (int)v->n("pulses", d.pulses), (int)v->n("rotate", d.rotate), v->n("gain", d.gain), v->n("pitch", 0),
                             v->n("crush", 0), v->n("drive", 0), div_of(v->s("delayDiv", "8n")), v->n("delayFb", 0), v->n("delayWet", 0),
                             v->n("stretch", 0) } : d;
    }
    const Json *ss = j ? j->get("sentenceSet") : nullptr;
    r.has_sentence = false;
    if (ss && ss->kind == Json::OBJ) {
        r.has_sentence = true;
        for (int s = 0; s < 4; s++) {
            const Json *arr = ss->get(HIT_SLOTS[s]);
            for (int k = 0; k < 4; k++) {
                const Json *c = arr ? arr->at(k) : nullptr;
                r.sentence[s][k] = Combo{ c ? (int)c->n("pulses", 1) : r.v[s].pulses, c ? (int)c->n("rotate", 0) : r.v[s].rotate };
            }
        }
    } else build_sentence(r, std::max(4, std::min(64, r.steps)), rnd);
    const Json *g = j ? j->get("grains") : nullptr;
    double attack = g ? g->n("attack", NAN) : NAN, decay = g ? g->n("decay", 0.3) : 0.3, sustain = g ? g->n("sustain", 0.5) : 0.5,
           release = g ? g->n("release", 0.45) : 0.45;
    if (g && std::isnan(attack) && g->get("window")) {          /* the old window/shape pair */
        double w = std::max(0.0, std::min(1.0, g->n("window", 0))), sh = std::max(0.0, std::min(1.0, g->n("shape", 0.2)));
        double span = 0.04 + w * 0.96;
        attack = std::round(span * sh * 1000) / 1000; release = std::round(span * (1 - sh) * 1000) / 1000; decay = 0; sustain = 1;
    }
    if (std::isnan(attack)) attack = 0.04;
    r.g = GrainCfg{ g ? g->n("pulses", 11) : 11, g ? g->n("rotate", 0) : 0, g ? g->n("offset", 0.15) : 0.15, g ? g->n("grain", 90) : 90,
        g ? g->n("count", 6) : 6, g ? g->n("spread", 0.5) : 0.5, g ? g->n("scatter", 0.25) : 0.25, g ? g->n("gain", 0.85) : 0.85,
        g ? g->n("pitch", 0) : 0, g ? g->n("vary", 0.35) : 0.35, g ? g->n("roam", 1) : 1, attack, decay, sustain, release };
}

static void euclid(int k, int n, bool *out) {
    int acc = 0;
    for (int i = 0; i < n; i++) {
        if (k <= 0) out[i] = false;
        else if (k >= n) out[i] = true;
        else { acc += k; if (acc >= n) { acc -= n; out[i] = true; } else out[i] = false; }
    }
}
static bool euclid_at(int k, int n, int rot, int at) {   /* rotated(euclid(k, n), rot)[at] */
    bool p[64]; euclid(k, n, p);
    return p[(((at + rot) % n) + n) % n];
}
static double metric_weight(int at, int steps) {
    if (at == 0) return 1;
    double quarter = steps / 4.0, eighth = steps / 8.0;
    if (quarter == std::floor(quarter) && at % (int)quarter == 0) return 0.6;
    if (eighth == std::floor(eighth) && at % (int)eighth == 0) return 0.35;
    return 0.12;
}

/* ------------------------------------------------------------------ the chains */
static const int SUB = 32;

/* dry -> drive blend (tanh curve) -> warp (Chorus) -> lowpass -> level gains */
struct Layer {
    double sr = 48000;
    Shaper shp;
    float post0 = 0.6f;
    Ctl fade, pre, post, cutoff, g1, g2;
    Chorus warp;
    Biquad lp;
    double q = 1;
    float L[SUB], R[SUB];
    void init(double s, double k, double post_base, double wf, double wdelay, double wdepth, double cut, double a, double b) {
        sr = s; shp.init(k); post0 = (float)post_base;
        fade.init(0); pre.init(1); post.init(post_base); cutoff.init(cut, true); g1.init(a); g2.init(b);
        warp.init(s, wf, wdelay, wdepth, 0);
        lp.type = LOWPASS;
        clear();
    }
    void clear() { std::memset(L, 0, sizeof L); std::memset(R, 0, sizeof R); }
    void drive(double dv, double k1, double k2, double now) {   /* voiceStep's drive block */
        fade.p.linearRampTo(dv, 0.3, now);
        pre.p.linearRampTo(1 + dv * k1, 0.3, now);
        post.p.linearRampTo(post0 / (1 + dv * k2), 0.3, now);
    }
    void process(float *oL, float *oR, int n, double te) {
        fade.block(te); pre.block(te); post.block(te); cutoff.block(te); g1.block(te); g2.block(te);
        for (int i = 0; i < n; i++) {
            float f = fade.at(i, n), pr = pre.at(i, n), po = post.at(i, n);
            L[i] = L[i] * (1 - f) + po * shp.run(pr * L[i]) * f;
            R[i] = R[i] * (1 - f) + po * shp.run(pr * R[i]) * f;
        }
        warp.process(L, R, n, te);
        lp.design(cutoff.a, q, sr);
        for (int i = 0; i < n; i++) {
            float g = g1.at(i, n) * g2.at(i, n);
            oL[i] += lp.run(0, L[i]) * g; oR[i] += lp.run(1, R[i]) * g;
        }
        clear();
    }
};

static double room_size(double decay) { double v = 0.45 + decay * 0.062; return v < 0 ? 0 : (v > 0.95 ? 0.95 : v); }

/* buildFxChain: the input reaches the room dry, and through a high-passed feedback delay and a
   send. The room is Freeverb, the web's own room for a device that cannot afford convolution:
   ponytail: Tone.Reverb's convolution (what a fast browser plays) costs ~7x on a phone; add a
   partitioned convolver if Kerem hears the difference. */
struct FxChain {
    double sr = 48000;
    Biquad hp;
    FeedbackDelay dl;
    Ctl send;
    Freeverb rv;
    float L[SUB], R[SUB];
    void init(double s, const FxCfg &c, double tempo, double hp_hz) {
        sr = s;
        hp.type = HIGHPASS; hp.design(hp_hz, 0.7, s);
        dl.init(s, MAX_DELAY_S, std::min(MAX_DELAY_S - 0.01, div_seconds(c.delayDiv, tempo)), c.delayFb);
        send.init(0);
        rv.init(s, room_size(c.revDecay), 3000);
        rv.wet.p.linearRampTo(c.revWet, 0.3, 0);
        send.p.linearRampTo(c.delayWet, 0.3, 0);
        std::memset(L, 0, sizeof L); std::memset(R, 0, sizeof R);
    }
    void apply(const FxCfg &c, double tempo, double now) {
        dl.time.p.linearRampTo(std::min(MAX_DELAY_S - 0.01, div_seconds(c.delayDiv, tempo)), 0.2, now);
        send.p.linearRampTo(c.delayWet, 0.2, now);
        dl.fb.p.linearRampTo(c.delayFb, 0.2, now);
        rv.wet.p.linearRampTo(c.revWet, 0.2, now);
        rv.room.p.set(room_size(c.revDecay), now);
    }
    void process(float *oL, float *oR, int n, double te) {
        send.block(te);
        float dL[SUB], dR[SUB];
        for (int i = 0; i < n; i++) { dL[i] = hp.run(0, L[i]); dR[i] = hp.run(1, R[i]); }
        dl.process(dL, dR, n, te);
        for (int i = 0; i < n; i++) { float g = send.at(i, n); L[i] += dL[i] * g; R[i] += dR[i] * g; }
        rv.process(L, R, n, te);
        for (int i = 0; i < n; i++) { oL[i] += L[i]; oR[i] += R[i]; }
        std::memset(L, 0, sizeof L); std::memset(R, 0, sizeof R);
    }
};

/* A synth role (pad bass, pad top, sector, third): one instance per instrument it has been asked
   for, made on the calling thread; a replaced one releases and keeps sounding 2.5 s (swapSynth). */
struct Role {
    std::unique_ptr<Synth> inst[NSYNTH];
    double until[NSYNTH] = {};
    int cur = -1;
    Settings st;
    double extra_db = 0;
    Synth *sy() { return cur >= 0 ? inst[cur].get() : nullptr; }
};

/* ------------------------------------------------------------------ rhythm points at run time */
struct Src { short *data = nullptr; int ch = 0; long long frames = 0; };
static inline void src_read(const Src &s, double pos, float &l, float &r) {
    long long i = (long long)pos;
    if (pos < 0 || i >= s.frames) { l = r = 0; return; }
    int c = s.ch > 1 ? 1 : 0;
    const short *a = s.data + i * s.ch;
    if (i + 1 >= s.frames) { l = a[0] / 32768.0f; r = a[c] / 32768.0f; return; }
    const short *b = a + s.ch;
    float f = (float)(pos - i);
    l = (a[0] + (b[0] - a[0]) * f) / 32768.0f;
    r = (a[c] + (b[c] - a[c]) * f) / 32768.0f;
}

struct PlayV { bool on = false; double pos = 0, rate = 1, start = 0, stop = 1e300, fade = 0.02; };
struct GrainSrc { bool on = false; double pos = 0, rate = 1, start = 0, stop = 0, fade_in = 0, fade_out = 0; };
struct HitSlot {
    Src src;
    PlayV pv[3];
    float vol = 1, gp_vol = 1;
    /* GrainPlayer (the hit's stretch) */
    bool gp_on = false; double gp_t0 = 0, gp_stop = 0, gp_grain = 0.2, gp_overlap = 0.1, gp_pr = 1, gp_rate = 1, gp_next = 0; long gp_tick = 0;
    GrainSrc gs[8];
    Ctl stretch_gain, blend;
    /* hit fx */
    Ctl crush_fade, bits, drive_fade, pre, post, delay_fade;
    FeedbackDelay dl;
    Shaper shp;
};
struct GrainV { bool on = false; double pos, rate, at, a, d, hold, s, w, len; };
struct Rhythm {
    bool used = false, dying = false; double free_at = 0;
    bool grains = false;
    RhythmCfg cfg;
    Ctl gain;
    HitSlot hit[4];
    Src gsrc;
    GrainV gv[192];
    long tick = 0; int step = 0;
    bool live = false; Combo lv[4]; int bars = 0, sentence_idx = 0; bool fx_ready = false;
};

/* ------------------------------------------------------------------ the device */
struct Inbox {
    bool walk = false; int route = -1; double t = 0, dist = 1e300;
    bool sector = false; int sector_v = -1;
    bool character = false; double centroid = 2000, onsets = 1;
    int zones[8]; int nzones = 0;
    struct ROp { int op = 0; RhythmCfg cfg; bool grains = false; bool gain = false; float g = 0; Src src[4]; bool src_set[4] = {}; } r[FS_MAX_VOICES];
    std::vector<short *> trash;       /* buffers the audio thread let go of */
    bool freed[FS_MAX_VOICES] = {};
    std::vector<Patch> routes;        /* registered, read by the audio thread only under the lock */
    /* written back by the audio thread: pacer.routeId, its patch's sect.n and bed voices, sect.idx */
    int taken = -1, sect_n = 7, bed_voices = 4, sector_back = -1;
};

struct Piece : Device {
    double sr = 48000;
    long long frame = 0;
    Rng rnd, main_rnd;               /* the audio thread's stream; the calling thread's (rhythmOf) */
    std::mutex mu;
    Inbox in;
    /* calling-thread view */
    bool busy[FS_MAX_VOICES] = {};

    /* audio-thread state */
    Patch patch;                      /* pacer.patch */
    std::vector<Patch> routes;        /* copied from the inbox as they arrive */
    int route = -1, pending = -1, reported = -1; double pending_at = 0, t_along = 0, route_dist = 1e300;
    int sector = -1;
    double centroid = 2000, onsets = 1;
    double bpm = 72, next_tick = 0; long long ticks = 0;
    double tick_base_t = 0; long long tick_base_k = 0; double tick_bpm = 72;   /* ticks from an index, as Tone's tick->seconds: no drift */
    std::string sect_div = "4n.";
    struct { int idx = -1, chord = -1; bool held = false; bool have_bass = false, have_top = false; int bass = 0, top = 0, topDir = 0; int tones[8]; int ntones = -1; } H;
    struct { bool have_last = false, have_prev2 = false; int last = 0, prev2 = 0, restRun = 0, prevInt = 0, phrase = 0; long tick = 0; } C;
    struct { bool have_last = false; int last = 0; long tick = 0; } T3;

    Role bass, top, sectr, v3r;
    Ctl bass_g, top_g;
    Layer pad, sectL, v3L;
    FxChain fx, fx2, fx3, rfx;
    Layer rdrive;                     /* the rhythm effects' drive and lowpass (no warp) */
    Ctl synth_level;
    struct OneShot { SimpleSynth s; NoiseSynth ns; bool noise = false; double free_at = 0; } shots[6];
    Rhythm rh[FS_MAX_VOICES];
    std::vector<short *> my_trash;
    float oL[SUB], oR[SUB], rL[SUB], rR[SUB];

    /* hooks for the parity test: every note the steps play */
    void (*on_note)(void *, int role, double f, double dur, double t, double vel) = nullptr; void *note_ctx = nullptr;
    double test_walk_s = 0;           /* tests: t along the route = time / this, as the reference harness walks */

    void *cast(const char *kind) override { return std::strcmp(kind, "piece") ? nullptr : this; }
    fs_param dummy[1] = { { "none", "none", "", 0, 1, 0 } };
    const fs_param *params(int &n) override { n = 0; return dummy; }
    void set_param(int, float) override {}

    /* ---- building (calling thread) ---- */
    Synth *make(int type) {
        Synth *s;
        switch (type) {
        case AM: { auto *m = new ModSynth(); m->am = true; s = m; break; }
        case DUO: s = new DuoSynth(); break;
        case MONO: s = new MonoSynth(); break;
        case SIMPLE: s = new SimpleSynth(); break;
        case PLUCK: { auto *p = new PluckSynth(); p->rnd = Rng::call; p->rnd_ctx = &rnd; s = p; break; }
        case METAL: s = new MetalSynth(); break;
        case MEMBRANE: s = new MembraneSynth(); break;
        case WAVETABLE: s = new WavetableVoice(); break;
        case COMB: { auto *c = new CombVoice(); c->rnd = Rng::call; c->rnd_ctx = &rnd; s = c; break; }
        case FORMANT: s = new FormantVoice(); break;
        default: s = new ModSynth(); break;
        }
        s->init(sr);
        return s;
    }
    void need(Role &r, int type) { if (!r.inst[type]) r.inst[type].reset(make(type)); }
    void need_all(const Patch &p) { need(bass, p.voice.synth); need(top, p.voice.synth); need(sectr, p.sect.synth); need(v3r, p.v3.synth); }

    static Settings role_settings(double harm, double index, int osc, int mod, EnvSpec env, EnvSpec menv) { return Settings{ harm, index, osc, mod, env, menv }; }
    void settings_for(const Patch &p) {
        bass.st = role_settings(p.voice.harm, p.voice.index, SINE, TRIANGLE, { 0.06, 0.5, 0.55, 2.4, false, true }, { 1.8, 2.4, 0.5, 3, false, true });
        top.st = role_settings(p.voice.harm, p.voice.index, SINE, SQUARE, { 0.03, 0.4, 0.22, 1.6, false, true }, { 0.05, 0.6, 0.25, 1.2, false, true });
        sectr.st = role_settings(p.sect.harm, p.sect.index, SINE, TRIANGLE, { 0.012, 0.35, 0.18, 1.1, false, true }, { 0.04, 0.5, 0.1, 0.8, false, true });
        v3r.st = role_settings(p.v3.harm, p.v3.index, TRIANGLE, SINE, { 0.5, 1.2, 0.6, 3.2, false, true }, { 1.2, 1.6, 0.4, 2.4, false, true });
    }
    /* swapSynth */
    void swap(Role &r, int type, double now) {
        if (r.cur == type && r.cur >= 0) return;
        if (r.cur >= 0) { r.inst[r.cur]->release(now); r.until[r.cur] = now + 2.5; }
        Synth *s = r.inst[type].get();
        if (!s) return;
        s->set(r.st);              /* a SELF_VOICED synth reads only the two numbers */
        s->vol = (float)db_to_gain(SYNTH_TRIM[type] + r.extra_db);
        r.cur = type;
        r.until[type] = 0;
    }

    void prepare(float s, int) override {
        sr = s;
        basic_wave(SINE); custom_wave(0); pink_noise(0);
        Patch d; patch_of(nullptr, d);
        patch = d;
        need_all(d);
        for (auto &o : shots) { o.s.init(sr); o.ns.init(sr); o.ns.rnd = Rng::call; o.ns.rnd_ctx = &rnd; }
        build_voice(d);
        routes.reserve(64); my_trash.reserve(64);
        transport_start();
        main_rnd.s = 0x2545F4914F6CDD1DULL;
    }

    /* buildVoice + buildRhythmFx, from a patch */
    void build_voice(const Patch &p) {
        settings_for(p);
        sectr.extra_db = 3;
        fx.init(sr, p.fx, p.tempo, 170); fx2.init(sr, p.fx2, p.tempo, 170); fx3.init(sr, p.fx3, p.tempo, 170);
        pad.init(sr, 2.6, 0.62, 0.55, 5.5, 0.6, 1200, 1, p.voice.gain);
        sectL.init(sr, 3.2, 0.58, 1.7, 3, 0.7, 9000, p.sect.gain, 0.78);
        v3L.init(sr, 2.8, 0.6, 0.35, 7, 0.5, 7000, 1, p.v3.gain);
        bass_g.init(0.9); top_g.init(0.8);
        swap(bass, p.voice.synth, 0); swap(top, p.voice.synth, 0); swap(sectr, p.sect.synth, 0); swap(v3r, p.v3.synth, 0);
        /* buildRhythmFx */
        FxCfg rc{ p.rfx.delayDiv, p.rfx.delayWet, p.rfx.delayFb, p.rfx.revWet, p.rfx.revDecay };
        rfx.init(sr, rc, p.tempo, 220);
        rdrive.init(sr, 3, 0.6, 1, 0, 0, p.rfx.cutoff, 1, 1);
        rdrive.q = 1.1;
        apply_rhythm_fx(p, 0);
        synth_level.init(1);
        bpm = p.tempo;
        for (auto &r : rh) { r.gain.init(0); init_hits(r, true); }
    }
    void init_hits(Rhythm &r, bool alloc) {
        for (auto &h : r.hit) {
            h.stretch_gain.init(1); h.blend.init(0);
            h.crush_fade.init(0); h.bits.init(16); h.drive_fade.init(0); h.pre.init(1); h.post.init(0.6); h.delay_fade.init(0);
            if (alloc) { h.dl.init(sr, MAX_DELAY_S, 0.2, 0); h.shp.init(3); }
            else { h.dl.time.init(0.2); h.dl.fb.init(0); for (auto &d : h.dl.dl) std::fill(d.buf.begin(), d.buf.end(), 0.0f); }
        }
    }

    /* applyRhythmFx */
    void apply_rhythm_fx(const Patch &p, double now) {
        const RfxCfg &c = p.rfx;
        rdrive.cutoff.p.exponentialRampTo(c.cutoff, 0.2, now);
        rdrive.fade.p.linearRampTo(c.drive, 0.2, now);
        rdrive.pre.p.linearRampTo(1 + c.drive * 12, 0.2, now);
        rdrive.post.p.linearRampTo(0.6 / (1 + c.drive * 3.4), 0.2, now);
        rfx.dl.time.p.linearRampTo(std::min(MAX_DELAY_S - 0.01, div_seconds(c.delayDiv, p.tempo)), 0.2, now);
        rfx.dl.fb.p.linearRampTo(c.delayFb, 0.2, now);
        rfx.send.p.linearRampTo(c.delayWet, 0.2, now);
        rfx.rv.wet.p.linearRampTo(c.revWet, 0.2, now);
    }
    /* applyHitFx */
    void apply_hit_fx(Rhythm &R, double now) {
        for (int s = 0; s < 4; s++) {
            const HitCfg &c = R.cfg.v[s]; HitSlot &h = R.hit[s];
            h.crush_fade.p.linearRampTo(c.crush, 0.2, now);
            h.bits.p.linearRampTo(std::max(2.0, std::round(16 - c.crush * 14)), 0.2, now);
            h.drive_fade.p.linearRampTo(c.drive, 0.2, now);
            h.pre.p.linearRampTo(1 + c.drive * 12, 0.2, now);
            h.post.p.linearRampTo(0.6 / (1 + c.drive * 3.4), 0.2, now);
            h.dl.time.p.linearRampTo(std::min(MAX_DELAY_S - 0.01, div_seconds(c.delayDiv, patch.tempo)), 0.2, now);
            h.dl.fb.p.linearRampTo(c.delayFb, 0.2, now);
            h.delay_fade.p.linearRampTo(c.delayWet, 0.2, now);
        }
    }

    /* applyPatchToVoice */
    void apply_patch(double now) {
        const Patch &p = patch;
        bpm = p.tempo;
        pad.g2.p.linearRampTo(p.voice.on ? p.voice.gain : 0, 0.2, now);
        bass_g.p.linearRampTo(p.voice.bass, 0.2, now);
        top_g.p.linearRampTo(p.voice.top, 0.2, now);
        sectL.g1.p.linearRampTo(p.sect.on ? p.sect.gain : 0, 0.2, now);
        fx.apply(p.fx, p.tempo, now);
        v3L.g2.p.linearRampTo(p.v3.on ? p.v3.gain : 0, 0.2, now);
        fx3.apply(p.fx3, p.tempo, now);
        /* applySynths */
        settings_for(p);
        if (bass.cur != p.voice.synth) { swap(bass, p.voice.synth, now); swap(top, p.voice.synth, now); H.held = false; }
        if (sectr.cur != p.sect.synth) swap(sectr, p.sect.synth, now);
        if (v3r.cur != p.v3.synth) swap(v3r, p.v3.synth, now);
        fx2.apply(p.fx2, p.tempo, now);
        if (sect_div != p.sect.rhythm.s) { sect_div = p.sect.rhythm.s; C.tick = 0; }
        apply_rhythm_fx(p, now);
        for (auto &R : rh) if (R.used) apply_hit_fx(R, now);
    }

    /* ---- the chord model ---- */
    int chord_index(double t) {
        int n = patch.nprog;
        double raw = t * n;
        if (H.idx < 0) H.idx = std::max(0, std::min(n - 1, (int)std::floor(raw)));
        else if (raw > H.idx + 1.25 || raw < H.idx - 0.25) H.idx = std::max(0, std::min(n - 1, (int)std::floor(raw)));
        return H.idx;
    }
    int chord_root(int step) {
        const Chord &c = step < patch.nprog ? patch.prog[step] : patch.prog[0];
        int base = (c.k == 2 ? patch.key2 : patch.key) + c.r;
        if (!c.sd) return base;
        const Chord &nx = patch.prog[(step + 1) % patch.nprog];
        return (nx.k == 2 ? patch.key2 : patch.key) + nx.r + 7;
    }
    int chord_quality(int step) {
        const Chord &c = step < patch.nprog ? patch.prog[step] : patch.prog[0];
        if (c.sd && !dom_q(c.q)) return Q_7B9;
        return c.q;
    }
    int chord_tones(int step, int *out) {
        int q = chord_quality(step);
        if (q < 0) q = Q_M7;
        int root = chord_root(step);
        for (int i = 0; i < CHORDS[q].n; i++) out[i] = root + CHORDS[q].iv[i];
        return CHORDS[q].n;
    }
    static int lead_to(bool have_prev, int prev, const int *tones, int nt, int lo, int hi) {
        bool found = false; int bm = 0; double bd = 0;
        for (int k = 0; k < nt; k++)
            for (int oct = -3; oct <= 3; oct++) {
                int m = tones[k] + oct * 12;
                if (m < lo || m > hi) continue;
                double d = !have_prev ? std::fabs(m - (lo + hi) / 2.0) : std::abs(m - prev);
                if (!found || d < bd) { found = true; bm = m; bd = d; }
            }
        return found ? bm : tones[0];
    }
    static int pc(int m) { return ((m % 12) + 12) % 12; }
    static int sgn(int x) { return (x > 0) - (x < 0); }

    /* ---- morphs ---- */
    static double hash01(double n, double seed) { double x = std::sin(n * 127.1 + seed * 311.7) * 43758.5453; return x - std::floor(x); }
    static double morph_shape(int shape, double u, double seed) {
        double TAU = 2 * PI, p = u - std::floor(u);
        if (shape == SH_RAMP) return p;
        if (shape == SH_PULSE) { double s = std::sin(PI * p); return std::pow(s < 0 ? 0 : s, 12); }
        if (shape == SH_BREATH) { double w = p < 0.35 ? (p / 0.35) * 0.5 : 0.5 + ((p - 0.35) / 0.65) * 0.5; return 0.5 - 0.5 * std::cos(TAU * w); }
        if (shape == SH_TIDE) return 0.5 + (std::sin(TAU * u) + std::sin(TAU * u * 1.6180339887)) / 4;
        double x = u * 5; int i = (int)std::floor(x); double f = x - i;
        double a = hash01(i, seed), b = hash01(i + 1, seed);
        return a + (b - a) * (f * f * (3 - 2 * f));
    }
    bool morph(int dest, double t, double &out) {
        if (!patch.morph_on) return false;
        int n = 0; double sum = 0;
        for (int i = 0; i < patch.nmorph; i++) {
            const Morph &m = patch.morph[i];
            if (!m.on || m.dest != dest) continue;
            double ph = t / std::max(4.0, m.period ? m.period : 60) + m.phase;
            double v = m.bias + m.depth * morph_shape(m.shape, ph, m.seed);
            sum += v < 0 ? 0 : (v > 1 ? 1 : v); n++;
        }
        if (!n) return false;
        out = sum / n;
        return true;
    }
    /* applyTimbre */
    void timbre(Synth *sy, int type, double ph, int mh_dest, double pi, int mi_dest, double ramp, double t) {
        if (!sy) return;
        double m;
        sy->timbre(0, morph(mh_dest, t, m) ? SYNTH_PARAMS[type][0].min + m * (SYNTH_PARAMS[type][0].max - SYNTH_PARAMS[type][0].min) : ph, ramp, t);
        sy->timbre(1, morph(mi_dest, t, m) ? SYNTH_PARAMS[type][1].min + m * (SYNTH_PARAMS[type][1].max - SYNTH_PARAMS[type][1].min) : pi, ramp, t);
    }
    void note(int role, Synth *sy, double f, double dur, double t, double vel) {
        if (on_note) on_note(note_ctx, role, f, dur, t, vel);
        if (!sy) return;
        if (dur < 0) sy->attack(f, t, vel); else sy->attack_release(f, dur, t, vel);
    }

    /* ---- harmonyBar ---- */
    void harmony_bar(double time) {
        int step = chord_index(t_along);
        int tones[8]; int nt = chord_tones(step, tones);
        bool changed = H.chord != step;
        H.chord = step;
        int b = lead_to(H.have_bass, H.bass, tones, 1, patch.key - 24, patch.key - 5);
        if (changed || !H.held || PERCUSSIVE[patch.voice.synth]) {
            note(0, bass.sy(), mtof(b), -1, time, 0.5);
            H.bass = b; H.have_bass = true; H.held = true;
        }
        std::memcpy(H.tones, tones, sizeof tones); H.ntones = nt;
    }

    /* ---- voiceStep ---- */
    void voice_step(double time) {
        if (H.ntones < 0) return;
        const Patch &p = patch;
        double density = std::max(0.05, std::min(0.95, p.voice.density * (0.35 + std::min(2.5, onsets) / 2.5)));
        double T = time, m;
        pad.g1.p.linearRampTo(morph(M_VOICE_GAIN, T, m) ? 0.25 + 0.75 * m : 1, 0.25, T);
        timbre(bass.sy(), p.voice.synth, p.voice.harm, M_VOICE_HARM, p.voice.index, M_VOICE_INDEX, 0.4, T);
        timbre(top.sy(), p.voice.synth, p.voice.harm, M_VOICE_HARM, p.voice.index, M_VOICE_INDEX, 0.4, T);
        pad.drive(morph(M_VOICE_DRIVE, T, m) ? m : p.voice.drive, 11, 3.2, T);
        double wp = morph(M_VOICE_WARP, T, m) ? m : p.voice.warp;
        pad.warp.wet.p.linearRampTo(wp * 0.85, 0.3, T); pad.warp.depth = (float)(0.15 + wp * 0.85);
        double cut = std::max(300.0, std::min(12000.0, centroid * 1.6));
        if (morph(M_VOICE_CUTOFF, T, m)) cut = std::max(180.0, std::min(14000.0, cut * 0.35 * std::pow(6.3, m)));
        pad.cutoff.p.exponentialRampTo(cut, 0.25, T);
        if (rnd() > density) return;
        int pool[8], np = 0;
        for (int i = H.ntones > 3 ? 2 : 0; i < H.ntones; i++) pool[np++] = H.tones[i];
        int pick = pool[(int)std::floor(rnd() * np)];
        int mm = lead_to(H.have_top, H.top, &pick, 1, p.key + 7, p.key + 31);
        H.topDir = !H.have_top ? 0 : sgn(mm - H.top);
        H.top = mm; H.have_top = true;
        double drift = 1 + (rnd() - 0.5) * 0.006;
        double dur = 0.35 + rnd() * 0.55;
        double f = mtof(mm) * drift;
        note(1, top.sy(), f, dur, time, 0.22 + rnd() * 0.16);
    }

    /* ---- keyCollection ---- */
    int key_collection(int *pcs, int *stable, int &nstable) {
        int count[12] = {};
        for (int i = 0; i < patch.nprog; i++) {
            int tones[8], nt = chord_tones(i, tones);
            for (int j = 0; j < nt; j++) count[pc(tones[j])] += j == 0 ? 2 : 1;
        }
        int all[12], na = 0;
        for (int k = 0; k < 12; k++) if (count[k]) all[na++] = k;
        for (int i = 1; i < na; i++) { int v = all[i], j = i; while (j > 0 && count[all[j - 1]] < count[v]) { all[j] = all[j - 1]; j--; } all[j] = v; }   /* stable */
        int n = na < 7 ? na : 7;
        std::memcpy(pcs, all, n * sizeof(int));
        int tonic = pc(patch.key); nstable = 0; stable[nstable++] = tonic;
        for (int iv : { 3, 4, 7 }) { int q = (tonic + iv) % 12; for (int k = 0; k < n; k++) if (pcs[k] == q) { stable[nstable++] = q; break; } }
        return n;
    }

    /* ---- sectorStep ---- */
    void sector_step(double time) {
        const Patch &p = patch;
        if (!p.sect.on) return;
        double T = time, m;
        sectL.cutoff.p.exponentialRampTo(morph(M_SECT_CUTOFF, T, m) ? 900 * std::pow(10, m) : 9000, 0.2, T);
        timbre(sectr.sy(), p.sect.synth, p.sect.harm, M_SECT_HARM, p.sect.index, M_SECT_INDEX, 0.3, T);
        sectL.drive(morph(M_SECT_DRIVE, T, m) ? m : p.sect.drive, 13, 3.6, T);
        double w2 = morph(M_SECT_WARP, T, m) ? m : p.sect.warp;
        sectL.warp.wet.p.linearRampTo(w2 * 0.85, 0.3, T); sectL.warp.depth = (float)(0.2 + w2 * 0.8);
        int stride = stride_of(p.sect.rhythm, 4);
        C.tick++;
        if ((C.tick - 1) % stride != 0) return;
        int i = sector < 0 ? 0 : sector;
        const Sector &sc = p.sectors[i % p.nsectors];
        int mode = sc.mode < 0 ? MODE_DORIAN : sc.mode;
        if (C.restRun > 0) { C.restRun--; return; }
        if (rnd() < 0.18) { C.restRun = 1 + (int)std::floor(rnd() * 2); return; }
        int keyPcs[12], stable[4], nstable; int nk = key_collection(keyPcs, stable, nstable);
        bool chordSet[256] = {}, chordPc[12] = {};
        for (int k = 0; k < (H.ntones > 0 ? H.ntones : 0); k++) {
            chordPc[pc(H.tones[k])] = true;
            for (int o = -3; o <= 3; o++) { int v = H.tones[k] + o * 12; if (v >= 0 && v < 256) chordSet[v] = true; }
        }
        auto in_key = [&](int q) { for (int k = 0; k < nk; k++) if (keyPcs[k] == q) return true; return false; };
        int lo = p.key + 2, hi = p.key + 26, pool[128], np = 0;
        for (int oct = -2; oct <= 3; oct++)
            for (int k = 0; k < MODES[mode].n; k++) {
                int mm = p.key + MODES[mode].iv[k] + oct * 12;
                if (mm < lo || mm > hi) continue;
                if (in_key(pc(mm)) || chordPc[pc(mm)]) pool[np++] = mm;
            }
        if (np < 4) {
            np = 0;
            for (int oc = -2; oc <= 3; oc++)
                for (int q = 0; q < nk; q++) { int nn = p.key - pc(p.key) + keyPcs[q] + oc * 12; if (nn >= lo && nn <= hi) pool[np++] = nn; }
        }
        if (!np) return;
        int prev = C.have_last ? C.last : p.key + 12;
        int leadDir = H.topDir;
        double pull = p.sect.chordPull, centre = (lo + hi) / 2.0;
        C.phrase++;
        bool atRest = C.phrase >= 5 + (int)std::floor(rnd() * 4);
        int lastInt = C.prevInt;
        bool owing = std::abs(lastInt) > 4;
        bool found = false; int bm = 0; double bs = 0;
        for (int k = 0; k < np; k++) {
            int mm = pool[k], d = mm - prev, step = std::abs(d);
            if (step == 0) continue;
            double score = -std::min(step, 14) * 0.6;
            if (owing) {
                if (sgn(d) == -sgn(lastInt) && step <= 2) score += 4;
                else if (sgn(d) == sgn(lastInt)) score -= 2.2;
            }
            if (leadDir != 0 && sgn(d) == -leadDir) score += 1.8;
            if (mm >= 0 && mm < 256 && chordSet[mm]) score += pull * 6;
            if (step > 9) score -= 2.5;
            if (C.have_prev2 && mm == C.prev2) score -= 1.9;
            if (atRest) for (int s = 0; s < nstable; s++) if (stable[s] == pc(mm)) { score += 3.2; break; }
            score -= std::fabs(mm - centre) * 0.07;
            score += (rnd() - 0.5) * 1.5;
            if (!found || score > bs) { found = true; bm = mm; bs = score; }
        }
        if (!found) return;
        C.prev2 = prev; C.have_prev2 = true;
        C.prevInt = bm - prev;
        if (atRest) { C.phrase = 0; C.restRun = 1 + (int)std::floor(rnd() * 2); }
        C.last = bm; C.have_last = true;
        double drift = 1 + (rnd() - 0.5) * 0.005;
        double dur = 0.28 + rnd() * 0.6;
        double f = mtof(bm) * drift;
        note(2, sectr.sy(), f, dur, time, 0.42 + rnd() * 0.2);
    }

    /* ---- thirdStep ---- */
    void third_step(double time) {
        const Patch &p = patch;
        if (!p.v3.on) return;
        double T = time, m;
        Synth *sy = v3r.sy();
        timbre(sy, p.v3.synth, p.v3.harm, M_V3_HARM, p.v3.index, M_V3_INDEX, 0.4, T);
        v3L.drive(morph(M_V3_DRIVE, T, m) ? m : p.v3.drive, 11, 3.2, T);
        double wv = morph(M_V3_WARP, T, m) ? m : p.v3.warp;
        v3L.warp.wet.p.linearRampTo(wv * 0.85, 0.3, T); v3L.warp.depth = (float)(0.15 + wv * 0.85);
        v3L.cutoff.p.exponentialRampTo(morph(M_V3_CUTOFF, T, m) ? 500 * std::pow(18, m) : 7000, 0.3, T);
        int stride = stride_of(p.v3.rhythm, 16);
        T3.tick++;
        if ((T3.tick - 1) % stride != 0) return;
        if (H.ntones <= 0 || !sy) return;
        bool taken[12] = {};
        if (H.have_bass) taken[pc(H.bass)] = true;
        if (C.have_last) taken[pc(C.last)] = true;
        int lo = p.key - 7, hi = p.key + 12;
        struct Cand { int m, idx; } pool[64]; int np = 0;
        for (int idx = 0; idx < H.ntones; idx++)
            for (int o = -2; o <= 2; o++) { int mm = H.tones[idx] + o * 12; if (mm >= lo && mm <= hi) pool[np++] = { mm, idx }; }
        if (!np) return;
        int prev = T3.have_last ? T3.last : p.key + 2;
        bool found = false; int bm = 0; double bs = 0;
        for (int k = 0; k < np; k++) {
            double score = -std::abs(pool[k].m - prev) * 0.32;
            if (taken[pc(pool[k].m)]) score -= 3.2;
            if (pool[k].idx == 1 || pool[k].idx == 3) score += 2.2;
            if (pool[k].m == prev) score -= 2.4;
            score += (rnd() - 0.5) * 1.2;
            if (!found || score > bs) { found = true; bm = pool[k].m; bs = score; }
        }
        if (!found) return;
        T3.last = bm; T3.have_last = true;
        double beat = 60 / p.tempo;
        double dur = beat * (1.5 + rnd() * 2.5);
        double f = mtof(bm) * (1 + (rnd() - 0.5) * 0.004);
        note(3, sy, f, dur, time, 0.36 + rnd() * 0.16);
    }

    /* ---- zoneFire ---- */
    void zone_fire(int icon, double at) {
        static const struct { int osc; int oct; double dur; } TIM[7] = {
            { TRIANGLE, -1, 2.4 }, { SAWTOOTH, 0, 1.1 }, { SINE, 1, 1.8 }, { SQUARE, 2, 0.22 }, { SINE, -1, 3.2 }, { TRIANGLE, -2, 3.6 }, { -1, 0, 2.6 } };
        const auto &tim = TIM[icon >= 0 && icon < 7 ? icon : 0];
        int tones[8], nt;
        if (H.ntones >= 0) { nt = H.ntones; std::memcpy(tones, H.tones, sizeof tones); }
        else nt = chord_tones(chord_index(t_along), tones);
        int midi = tones[(int)std::floor(rnd() * nt)] + tim.oct * 12;
        OneShot *o = &shots[0];
        for (auto &s : shots) if (s.free_at < o->free_at) o = &s;   /* the oldest (ponytail: 6 at once, then the oldest is reused) */
        o->free_at = at + tim.dur + 3;
        if (tim.osc < 0) {
            o->noise = true;
            o->ns.env.set(0.08, 0.6, 0.2, tim.dur);
            if (on_note) on_note(note_ctx, 4, 0, tim.dur, at, 0.35);
            o->ns.attack(0, at, 0.35); o->ns.release(at + tim.dur);
            return;
        }
        o->noise = false;
        o->s.osc.w = &basic_wave(tim.osc);
        o->s.env.set(0.02, 0.5, 0.3, tim.dur);
        note(5, &o->s, mtof(midi), tim.dur, at, 0.4);
    }

    /* ---- rhythmStep ---- */
    void fire_grains(Rhythm &R, double time, double step_secs) {
        Src &b = R.gsrc;
        if (!b.data || !b.frames) return;
        GrainCfg g = R.cfg.g;
        double v = std::max(0.0, std::min(1.0, g.vary)), roam = std::max(0.0, std::min(1.0, g.roam));
        if (!(v <= 0 && roam <= 0)) {           /* variedGrains */
            auto r = [&]() { return (rnd() - 0.5) * 2; };
            auto cl = [](double x, double lo, double hi) { return x < lo ? lo : (x > hi ? hi : x); };
            auto wrap = [](double x) { return std::fmod(std::fmod(x, 1) + 1, 1); };
            GrainCfg o = g;
            o.offset = wrap(g.offset + r() * roam * 0.5);
            o.grain = cl((g.grain ? g.grain : 90) * std::pow(2, r() * v * 1.4), 20, 500);
            o.count = std::round(cl((g.count ? g.count : 6) * (1 + r() * v * 1.1), 1, 32));
            o.spread = cl(g.spread + r() * v * 0.6, 0, 1);
            o.scatter = cl(g.scatter + r() * v * 0.5, 0, 1);
            o.pitch = g.pitch + std::round(r() * v * 7);
            o.gain = cl(g.gain * (1 + r() * v * 0.45), 0.02, 1);
            o.attack = cl(g.attack * (1 + r() * v * 0.6), 0.002, 1);
            o.decay = cl(g.decay + r() * v * 0.35, 0, 1);
            o.sustain = cl(g.sustain + r() * v * 0.4, 0, 1);
            o.release = cl(g.release * (1 + r() * v * 0.5), 0.02, 1);
            g = o;
        }
        int n = std::max(1, std::min(32, (int)g.count));
        double grainSec = std::max(0.01, std::min(2.0, (g.grain ? g.grain : 90) / 1000));
        /* grainEnvelope */
        auto c01 = [](double x) { return std::max(0.0, std::min(1.0, x)); };
        double a = c01(g.attack), d = c01(g.decay), rr = c01(g.release), sus = c01(g.sustain);
        double floor_ = std::min(0.0008, grainSec / 8);
        double aS = std::max(floor_, a * grainSec), dS = std::max(floor_, d * grainSec), rS = std::max(floor_, rr * grainSec);
        double sum = aS + dS + rS;
        if (sum > grainSec) { double k = grainSec / sum; aS *= k; dS *= k; rS *= k; }
        double hold = std::max(0.0, grainSec - aS - dS - rS);
        double spread = c01(g.spread) * step_secs, scatter = c01(g.scatter);
        double dur = (double)b.frames / sr, base = c01(g.offset) * dur, lvl = std::max(0.02, g.gain);
        for (int i = 0; i < n; i++) {
            double at = time + (n == 1 ? 0 : ((double)i / n) * spread);
            double off = base + (rnd() - 0.5) * scatter * dur;
            off = std::max(0.0, std::min(std::max(0.0, dur - grainSec), off));
            double rate = std::pow(2, g.pitch / 12) * (1 + (rnd() - 0.5) * 0.02);
            GrainV *gv = nullptr;
            for (auto &x : R.gv) if (!x.on) { gv = &x; break; }
            if (!gv) continue;                  /* ponytail: 192 grains at once per point */
            double w = lvl * (1 - 0.35 * ((double)i / std::max(1, n)));
            *gv = GrainV{ true, off * sr, rate, at, aS, dS, hold, sus, w, grainSec };
            if (on_note) on_note(note_ctx, 20, rate, off, at, 0);
        }
    }
    static double stretch_rate(double a) { a = a < 0 ? 0 : (a > 1 ? 1 : a); return 1 - a * 0.85; }
    void rhythm_step(double time) {
        for (auto &R : rh) {
            if (!R.used || R.dying) continue;
            RhythmCfg &r = R.cfg;
            if (!r.on) continue;
            if (!R.live) { R.live = true; for (int s = 0; s < 4; s++) R.lv[s] = Combo{ r.v[s].pulses, r.v[s].rotate }; }
            if (!R.fx_ready && !R.grains) { apply_hit_fx(R, time); R.fx_ready = true; }
            int stride = stride_of(r.div, 1);
            R.tick++;
            if (!R.grains && (R.tick - 1) % 16 == 0) {           /* advanceSentence */
                R.bars++;
                if (R.bars >= std::max(1, r.sentence_bars) && r.has_sentence) {
                    R.bars = 0;
                    R.sentence_idx = (R.sentence_idx + 1) % 4;
                    int steps = std::max(1, std::min(64, r.steps));
                    for (int s = 0; s < 4; s++) { const Combo &c = r.sentence[s][R.sentence_idx]; R.lv[s] = Combo{ std::min(c.pulses, steps), c.rotate % steps }; }
                }
            }
            if ((R.tick - 1) % stride != 0) continue;
            int steps = std::max(1, std::min(64, r.steps));
            int at = R.step % steps;
            R.step = (R.step + 1) % steps;
            if (R.grains) {
                const GrainCfg &g = r.g;
                if (g.pulses > 0 && euclid_at(std::min((int)g.pulses, steps), steps, (int)g.rotate, at))
                    fire_grains(R, time, div_seconds(r.div, patch.tempo) * stride);
                continue;
            }
            for (int s = 0; s < 4; s++) {
                const HitCfg &cfg = r.v[s]; HitSlot &h = R.hit[s];
                if (!h.src.data || R.lv[s].pulses <= 0) continue;
                if (!euclid_at(std::min(R.lv[s].pulses, steps), steps, R.lv[s].rotate, at)) continue;
                double rate = std::pow(2, cfg.pitch / 12) * (1 + (rnd() - 0.5) * 0.012);
                double accent = r.idiom * metric_weight((int)((R.tick - 1) % 16), 16) * 4;
                double vol = 20 * std::log10(std::max(0.02, cfg.gain)) + (rnd() - 0.5) * 1.5 + accent;
                h.vol = (float)db_to_gain(vol);
                if (on_note) on_note(note_ctx, 10 + s, rate, vol, time, 0);
                /* Player.start: the one playing stops with its 20 ms fade; all take the new rate */
                for (auto &pv : h.pv) if (pv.on) { pv.rate = rate; if (pv.stop > time) pv.stop = time; }
                PlayV *nv = &h.pv[0];
                for (auto &pv : h.pv) if (!pv.on) { nv = &pv; break; }
                *nv = PlayV{ true, 0, rate, time, 1e300, 0.02 };
                if (cfg.stretch > 0) {
                    double a = std::max(0.0, std::min(1.0, cfg.stretch));
                    double pr = stretch_rate(a), gs = 0.06 + a * 0.24, period = gs / pr;
                    h.gp_vol = (float)db_to_gain(vol);
                    h.gp_rate = std::pow(2, cfg.pitch / 12);
                    h.gp_pr = pr; h.gp_grain = gs; h.gp_overlap = period * (0.35 + a * 0.4);
                    double stopAt = time + 1.5;
                    h.stretch_gain.p.cancelScheduledValues(time);
                    h.stretch_gain.p.setValueAtTime(1, time);
                    h.stretch_gain.p.setValueAtTime(1, stopAt - 0.025);
                    h.stretch_gain.p.linearRampToValueAtTime(0, stopAt);
                    h.gp_on = true; h.gp_t0 = time; h.gp_stop = stopAt; h.gp_tick = 0; h.gp_next = time;
                }
            }
        }
    }

    /* ---- the Transport ----
       Tone keeps every scheduleRepeat two occurrences ahead in one timeline: an occurrence is
       inserted when the one two intervals before it fires, after anything already at its time. So
       callbacks sharing a tick run in the order their occurrences were inserted - on a bar,
       harmonyBar (inserted two bars back) before voiceStep (inserted a quarter back). This keeps
       the same timeline, in sixteenths: voiceStep 8n, harmonyBar 1m, sectorStep, rhythmStep,
       thirdStep 16n, scheduled in that order at start. */
    struct Due { long long tick, seq; int id; };
    Due due[16]; int ndue = 0; long long seq = 0;
    static int interval(int id) { return id == 0 ? 2 : id == 1 ? 16 : 1; }
    void schedule(long long tick, int id) { due[ndue++] = Due{ tick, seq++, id }; }
    void transport_start() { ndue = 0; for (int id = 0; id < 5; id++) { schedule(0, id); schedule(interval(id), id); } }
    void tick(double time) {
        if (test_walk_s > 0) t_along = std::min(1.0, time / test_walk_s);
        long long k = ticks++;
        for (;;) {
            int best = -1;
            for (int i = 0; i < ndue; i++) if (due[i].tick == k && (best < 0 || due[i].seq < due[best].seq)) best = i;
            if (best < 0) break;
            int id = due[best].id;
            due[best] = due[--ndue];
            schedule(k + 2 * interval(id), id);
            switch (id) {
            case 0: voice_step(time); break;
            case 1: harmony_bar(time); break;
            case 2: sector_step(time); break;
            case 3: rhythm_step(time); break;
            default: third_step(time); break;
            }
        }
    }

    /* ---- world walking: worldMove's route part, worldSwap, setSynthLevel ---- */
    void synth_to(double level, double now) { synth_level.p.linearRampTo(level, 0.35, now); }
    static double walk_level(double d) { return fs_walk_level(d, FS_GPS_FADE_FROM, FS_GPS_LEASH); }
    void take(double now) {
        int near = pending;
        pending = -1;
        if (reported != near || near < 0 || near >= (int)routes.size()) return;
        route = near;
        patch = routes[near];
        apply_patch(now);
        H.idx = -1; H.chord = -1; H.ntones = -1;
        sector = -1;
        synth_to(walk_level(route_dist), now);
    }
    void walk(int r, double t, double dist, double now) {
        reported = r;
        if (r >= 0) {
            if (r != route && r != pending) {
                bool was_running = route >= 0;
                synth_to(0, now);
                pending = r;
                if (!was_running) { route_dist = dist; t_along = t; take(now); }
                else pending_at = now + 1.5;
            }
            t_along = t; route_dist = dist;
            if (r == route) synth_to(walk_level(dist), now);
        } else { route_dist = 1e300; synth_to(0, now); }
    }

    /* ---- the inbox ---- */
    void take_inbox(double now) {
        if (!mu.try_lock()) return;
        while (routes.size() < in.routes.size()) routes.push_back(in.routes[routes.size()]);
        if (in.walk) { in.walk = false; walk(in.route, in.t, in.dist, now); }
        if (in.sector) { in.sector = false; sector = in.sector_v; }
        if (in.character) { in.character = false; centroid = in.centroid; onsets = in.onsets; }
        for (int i = 0; i < in.nzones; i++) if (patch.zones_on) zone_fire(in.zones[i], now + 0.008);
        in.nzones = 0;
        for (int h = 0; h < FS_MAX_VOICES; h++) {
            auto &op = in.r[h]; Rhythm &R = rh[h];
            if (op.op == 1) {
                R.used = true; R.dying = false; R.cfg = op.cfg; R.grains = op.grains;
                R.tick = 0; R.step = 0; R.live = false; R.bars = 0; R.sentence_idx = 0; R.fx_ready = false;
                R.gain.init(0);
                for (auto &g : R.gv) g.on = false;
                init_hits(R, false);
                for (auto &hs : R.hit) { for (auto &pv : hs.pv) pv.on = false; hs.gp_on = false; for (auto &g : hs.gs) g.on = false; }
            } else if (op.op == 2 && R.used && !R.dying) {
                R.dying = true; R.free_at = now + 0.4;
                R.gain.p.linearRampTo(0, 0.25, now);
            }
            op.op = 0;
            if (op.gain) { op.gain = false; R.gain.p.linearRampTo(op.g * (R.cfg.on ? R.cfg.gain : 0), 0.35, now); }
            for (int s = 0; s < 4; s++) if (op.src_set[s]) {
                op.src_set[s] = false;
                Src &dst = R.grains ? R.gsrc : R.hit[s].src;
                if (dst.data) my_trash.push_back(dst.data);
                dst = op.src[s];
                if (!R.grains) {       /* ensureRhythm: the stretch blend at the slot's amount */
                    double amt = R.cfg.v[s].stretch;
                    R.hit[s].blend.p.linearRampTo(amt, 0.2, now);
                }
            }
        }
        for (int h = 0; h < FS_MAX_VOICES; h++) {
            Rhythm &R = rh[h];
            if (R.used && R.dying && now >= R.free_at) {
                R.used = false; R.dying = false;
                for (auto &hs : R.hit) if (hs.src.data) { my_trash.push_back(hs.src.data); hs.src = Src(); }
                if (R.gsrc.data) { my_trash.push_back(R.gsrc.data); R.gsrc = Src(); }
                in.freed[h] = true;
            }
        }
        size_t kept = 0;
        for (short *p : my_trash) { if (in.trash.size() < in.trash.capacity()) in.trash.push_back(p); else my_trash[kept++] = p; }
        my_trash.resize(kept);
        in.taken = route; in.sect_n = patch.sect.n; in.bed_voices = patch.bed_on ? patch.bed_voices : 0;
        if (!in.sector) in.sector_back = sector;
        mu.unlock();
    }

    /* ---- rendering ---- */
    void render_rhythm(Rhythm &R, float *L, float *Rr, int n, double t0) {
        double te = t0 + n / sr;
        R.gain.block(te);
        float bl[SUB] = {}, br[SUB] = {};
        if (R.grains) {
            for (auto &g : R.gv) {
                if (!g.on) continue;
                for (int i = 0; i < n; i++) {
                    double t = t0 + i / sr;
                    if (t < g.at) continue;
                    double u = t - g.at, e;
                    if (u >= g.len) { g.on = false; break; }
                    if (u < g.a) e = g.w * u / g.a;
                    else if (u < g.a + g.d) e = g.w + (g.w * g.s - g.w) * (u - g.a) / g.d;
                    else if (u < g.a + g.d + g.hold) e = g.w * g.s;
                    else { double rl = g.len - (g.a + g.d + g.hold); e = rl > 0 ? g.w * g.s * (1 - (u - g.a - g.d - g.hold) / rl) : 0; }
                    float l, r; src_read(R.gsrc, g.pos, l, r);
                    g.pos += g.rate;
                    bl[i] += l * (float)e; br[i] += r * (float)e;
                }
            }
        } else {
            for (auto &h : R.hit) {
                if (!h.src.data) continue;
                h.stretch_gain.block(te); h.blend.block(te); h.crush_fade.block(te); h.bits.block(te);
                h.drive_fade.block(te); h.pre.block(te); h.post.block(te); h.delay_fade.block(te);
                float xl[SUB] = {}, xr[SUB] = {}, sl[SUB] = {}, sr_[SUB] = {};
                for (auto &pv : h.pv) {
                    if (!pv.on) continue;
                    for (int i = 0; i < n; i++) {
                        double t = t0 + i / sr;
                        if (t < pv.start) continue;
                        double g = 1;
                        if (t >= pv.stop) { g = 1 - (t - pv.stop) / pv.fade; if (g <= 0) { pv.on = false; break; } }
                        if (pv.pos >= h.src.frames) { pv.on = false; break; }
                        float l, r; src_read(h.src, pv.pos, l, r);
                        pv.pos += pv.rate;
                        xl[i] += l * (float)g * h.vol; xr[i] += r * (float)g * h.vol;
                    }
                }
                if (h.gp_on) {         /* GrainPlayer: a grain every grainSize / playbackRate, reading grainSize further on */
                    for (int i = 0; i < n; i++) {
                        double t = t0 + i / sr;
                        if (t >= h.gp_stop) { h.gp_on = false; for (auto &g : h.gs) g.on = false; break; }
                        while (h.gp_on && h.gp_next <= t) {
                            double off = h.gp_tick * h.gp_grain;
                            if (off > (double)h.src.frames / sr) { h.gp_stop = h.gp_next; break; }
                            for (auto &g : h.gs) if (!g.on) {
                                g = GrainSrc{ true, off * sr, h.gp_rate, h.gp_next, h.gp_next + h.gp_grain / h.gp_pr, off < h.gp_overlap ? 0 : h.gp_overlap, h.gp_overlap };
                                break;
                            }
                            h.gp_tick++;
                            h.gp_next = h.gp_t0 + h.gp_tick * h.gp_grain / h.gp_pr;
                        }
                        for (auto &g : h.gs) {
                            if (!g.on || t < g.start) continue;
                            double e = 1;
                            if (g.fade_in > 0 && t - g.start < g.fade_in) e = (t - g.start) / g.fade_in;
                            if (t >= g.stop) { e = g.fade_out > 0 ? 1 - (t - g.stop) / g.fade_out : 0; if (e <= 0) { g.on = false; continue; } }
                            float l, r; src_read(h.src, g.pos, l, r);
                            g.pos += g.rate;
                            sl[i] += l * (float)e * h.gp_vol; sr_[i] += r * (float)e * h.gp_vol;
                        }
                    }
                }
                float yl[SUB], yr[SUB];
                for (int i = 0; i < n; i++) {
                    float b = h.blend.at(i, n), sg = h.stretch_gain.at(i, n);
                    float l = xl[i] * (1 - b) + sl[i] * sg * b, r = xr[i] * (1 - b) + sr_[i] * sg * b;
                    float cf = h.crush_fade.at(i, n), bits = h.bits.at(i, n);
                    l = l * (1 - cf) + crush(l, bits) * cf; r = r * (1 - cf) + crush(r, bits) * cf;
                    float df = h.drive_fade.at(i, n), pr = h.pre.at(i, n), po = h.post.at(i, n);
                    l = l * (1 - df) + po * h.shp.run(pr * l) * df; r = r * (1 - df) + po * h.shp.run(pr * r) * df;
                    yl[i] = l; yr[i] = r;
                }
                float dl_[SUB], dr_[SUB];
                std::memcpy(dl_, yl, sizeof(float) * n); std::memcpy(dr_, yr, sizeof(float) * n);
                h.dl.process(dl_, dr_, n, te);
                for (int i = 0; i < n; i++) {
                    float w = h.delay_fade.at(i, n);
                    bl[i] += yl[i] * (1 - w) + dl_[i] * w; br[i] += yr[i] * (1 - w) + dr_[i] * w;
                }
            }
        }
        for (int i = 0; i < n; i++) { float g = R.gain.at(i, n); L[i] += bl[i] * g; Rr[i] += br[i] * g; }
    }

    void render(float *outL, float *outR, int n, double t0) {
        double te = t0 + n / sr;
        std::memset(oL, 0, sizeof oL); std::memset(oR, 0, sizeof oR);
        /* the route: synths into their layers, layers into their chains, chains into the synth bus */
        bass_g.block(te); top_g.block(te);
        float bL[SUB] = {}, bR[SUB] = {}, tL[SUB] = {}, tR[SUB] = {};
        auto run_role = [&](Role &r, float *L, float *R) {
            for (int k = 0; k < NSYNTH; k++) if ((k == r.cur || r.until[k] > t0) && r.inst[k]) r.inst[k]->render(L, R, n, t0);
        };
        run_role(bass, bL, bR); run_role(top, tL, tR);
        for (int i = 0; i < n; i++) {
            pad.L[i] += bL[i] * bass_g.at(i, n) + tL[i] * top_g.at(i, n);
            pad.R[i] += bR[i] * bass_g.at(i, n) + tR[i] * top_g.at(i, n);
        }
        run_role(sectr, sectL.L, sectL.R);
        run_role(v3r, v3L.L, v3L.R);
        pad.process(fx.L, fx.R, n, te);
        sectL.process(fx2.L, fx2.R, n, te);
        v3L.process(fx3.L, fx3.R, n, te);
        for (auto &o : shots) if (o.free_at > t0) { if (o.noise) o.ns.render(fx.L, fx.R, n, t0); else o.s.render(fx.L, fx.R, n, t0); }
        fx.process(oL, oR, n, te); fx2.process(oL, oR, n, te); fx3.process(oL, oR, n, te);
        synth_level.block(te);
        for (int i = 0; i < n; i++) { float g = synth_level.at(i, n); oL[i] *= g; oR[i] *= g; }
        /* the rhythm points, through the rhythm effects, beside the route (bed.master, not bed.synth) */
        bool any = false;
        for (auto &R : rh) if (R.used) { any = true; render_rhythm(R, rdrive.L, rdrive.R, n, t0); }
        (void)any;
        rdrive.process(rfx.L, rfx.R, n, te);
        rfx.process(oL, oR, n, te);
        for (int i = 0; i < n; i++) { outL[i] = oL[i]; outR[i] = oR[i]; }
    }

    void process(int frames) override {
        float *L = out[0].data(), *R = out[1].data();
        int done = 0;
        while (done < frames) {
            int n = std::min(SUB, frames - done);
            double t0 = (double)frame / sr, te = (double)(frame + n) / sr;
            take_inbox(t0);
            if (pending >= 0 && t0 >= pending_at) take(t0);
            while (next_tick < te) {
                tick(next_tick);
                if (bpm != tick_bpm) { tick_base_t = next_tick; tick_base_k = ticks - 1; tick_bpm = bpm; }
                next_tick = tick_base_t + (double)(ticks - tick_base_k) * 60.0 / tick_bpm / 4;
            }
            render(L + done, R + done, n, t0);
            frame += n; done += n;
        }
    }
};

Device *make_piece() { return new Piece(); }

/* ------------------------------------------------------------------ the C interface */
static Piece *P(fs_device *d) { return d ? (Piece *)fs_device_impl(d)->cast("piece") : nullptr; }

extern "C" {

static void sweep(Piece *p) {    /* under the lock: free what the audio thread let go of */
    for (short *b : p->in.trash) std::free(b);
    p->in.trash.clear();
    for (int h = 0; h < FS_MAX_VOICES; h++) if (p->in.freed[h]) { p->in.freed[h] = false; p->busy[h] = false; }
    if (p->in.trash.capacity() < 64) p->in.trash.reserve(64);
}

int fs_piece_add_route(fs_device *d, const char *patch_json) {
    Piece *p = P(d); if (!p) return -1;
    Json j = Json::parse(patch_json);
    Patch pt; patch_of(&j, pt);
    std::lock_guard<std::mutex> g(p->mu); sweep(p);
    p->need_all(pt);
    if (p->in.routes.capacity() < 64) p->in.routes.reserve(64);
    if (p->in.routes.size() >= 64) return -1;     /* ponytail: 64 routes; the vector must not move under the audio thread */
    p->in.routes.push_back(pt);
    return (int)p->in.routes.size() - 1;
}

void fs_piece_walk(fs_device *d, int route, double t, double dist) {
    Piece *p = P(d); if (!p) return;
    std::lock_guard<std::mutex> g(p->mu); sweep(p);
    p->in.walk = true; p->in.route = route; p->in.t = t; p->in.dist = dist;
}

int fs_piece_route(fs_device *d) { Piece *p = P(d); if (!p) return -1; std::lock_guard<std::mutex> g(p->mu); return p->in.taken; }
int fs_piece_sect_n(fs_device *d) { Piece *p = P(d); if (!p) return 7; std::lock_guard<std::mutex> g(p->mu); return p->in.sect_n; }
int fs_piece_bed_voices(fs_device *d) { Piece *p = P(d); if (!p) return 4; std::lock_guard<std::mutex> g(p->mu); return p->in.bed_voices; }

void fs_piece_sector(fs_device *d, int sector) {
    Piece *p = P(d); if (!p) return;
    std::lock_guard<std::mutex> g(p->mu); sweep(p);
    p->in.sector = true; p->in.sector_v = sector;
}
int fs_piece_sector_now(fs_device *d) {
    Piece *p = P(d); if (!p) return -1;
    std::lock_guard<std::mutex> g(p->mu);
    return p->in.sector ? p->in.sector_v : p->in.sector_back;
}

/* localCharacter */
void fs_piece_character(fs_device *d, int n, const double *dist, const double *radius, const double *centroid_hz, const double *onset_rate) {
    Piece *p = P(d); if (!p) return;
    double sc = 0, so = 0, w = 0;
    for (int i = 0; i < n; i++) {
        if (dist[i] > radius[i]) continue;
        double k = std::max(0.0, 1 - dist[i] / radius[i]);
        sc += (centroid_hz[i] > 0 ? centroid_hz[i] : 2000) * k;
        so += (onset_rate[i] >= 0 ? onset_rate[i] : 1) * k;
        w += k;
    }
    std::lock_guard<std::mutex> g(p->mu); sweep(p);
    p->in.character = true;
    p->in.centroid = w > 0 ? sc / w : 2000; p->in.onsets = w > 0 ? so / w : 1;
}

void fs_piece_zone(fs_device *d, const char *icon) {
    static const char *const ICONS[7] = { "tree", "animal", "flower", "insect", "fish", "soil", "water" };
    Piece *p = P(d); if (!p) return;
    int k = 0;
    for (int i = 0; i < 7; i++) if (icon && !std::strcmp(icon, ICONS[i])) k = i;
    std::lock_guard<std::mutex> g(p->mu); sweep(p);
    if (p->in.nzones < 8) p->in.zones[p->in.nzones++] = k;
}

int fs_piece_rhythm_add(fs_device *d, const char *rhythm_json, int grains) {
    Piece *p = P(d); if (!p) return -1;
    Json j = Json::parse(rhythm_json);
    std::lock_guard<std::mutex> g(p->mu); sweep(p);
    for (int h = 0; h < FS_MAX_VOICES; h++) if (!p->busy[h]) {
        p->busy[h] = true;
        auto &op = p->in.r[h];
        rhythm_of(j.kind == Json::OBJ ? &j : nullptr, op.cfg, p->main_rnd);   /* rhythmOf's sentence draw */
        op.op = 1; op.grains = grains != 0; op.gain = false;
        for (auto &s : op.src_set) s = false;
        return h;
    }
    return -1;
}
void fs_piece_rhythm_gain(fs_device *d, int h, float gain) {
    Piece *p = P(d); if (!p || h < 0 || h >= FS_MAX_VOICES) return;
    std::lock_guard<std::mutex> g(p->mu); sweep(p);
    p->in.r[h].gain = true; p->in.r[h].g = gain;
}
short *fs_alloc_i16(size_t n) { return (short *)std::malloc(n * sizeof(short) + 1); }
void fs_piece_rhythm_source(fs_device *d, int h, int slot, int channels, long long frames, short *interleaved) {
    Piece *p = P(d);
    if (!p || h < 0 || h >= FS_MAX_VOICES || slot < 0 || slot > 3) { std::free(interleaved); return; }
    std::lock_guard<std::mutex> g(p->mu); sweep(p);
    auto &op = p->in.r[h];
    if (op.src_set[slot] && op.src[slot].data) std::free(op.src[slot].data);
    op.src[slot] = Src{ interleaved, channels < 1 ? 1 : channels, frames };
    op.src_set[slot] = true;
}
void fs_piece_rhythm_remove(fs_device *d, int h) {
    Piece *p = P(d); if (!p || h < 0 || h >= FS_MAX_VOICES) return;
    std::lock_guard<std::mutex> g(p->mu); sweep(p);
    auto &op = p->in.r[h];
    for (int s = 0; s < 4; s++) if (op.src_set[s]) { std::free(op.src[s].data); op.src_set[s] = false; }
    op.op = 2;
}

void fs_piece_test_hooks(fs_device *d, double (*rnd)(void *), void *rnd_ctx,
                         void (*on_note)(void *, int, double, double, double, double), void *note_ctx) {
    Piece *p = P(d); if (!p) return;
    p->rnd.hook = rnd; p->rnd.hook_ctx = rnd_ctx; p->on_note = on_note; p->note_ctx = note_ctx;
}
void fs_piece_test_walk(fs_device *d, double seconds) { Piece *p = P(d); if (p) p->test_walk_s = seconds; }

}

