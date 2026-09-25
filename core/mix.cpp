/* The master bus: every sounding device summed with its own smoothed gain, then a lookahead
   limiter so the output never passes the ceiling (rulebook A-6). The walk's fades (distance,
   route crossfade, the GPS leash) arrive as slot gains; devices never see them.

   Limiter: the signal is delayed by L = 5 ms. For each sample the gain it would need to stay under
   the ceiling is computed; a running minimum over L+1 samples, then a running average of
   that over L samples, gives a gain that is smooth (no step, so no click) and is already at or
   below what each peak needs when that peak leaves the delay line - every value averaged covers
   the peak. Release is a one-pole rise (100 ms). Nothing allocates after fs_mix_prepare. */
#include "fieldscape.h"
#include "device.hpp"

#include <cmath>
#include <vector>

/* A slot's low-pass: the web voice's Tone.Filter(lowpass), i.e. a Web Audio BiquadFilterNode, -12 dB
   per octave, Q 1 - coefficients from the Web Audio spec (Q in dB for lowpass). The cutoff glides in
   log frequency, as Tone's rampTo does for a frequency; coefficients are refreshed every 32 samples.
   Off until a cutoff is first set, so a slot without one passes bit-exact. */
struct Lowpass {
    bool on = false;
    double logf = 0, target = 0, coef = 0;
    double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
    double x1[2] = {}, x2[2] = {}, y1[2] = {}, y2[2] = {};
    void design(double f, double sr) {
        const double PI = 3.141592653589793, Q = 1.0;
        double w0 = 2 * PI * f / sr, alpha = std::sin(w0) / (2 * std::pow(10.0, Q / 20)), c = std::cos(w0);
        double a0 = 1 + alpha;
        b0 = (1 - c) / 2 / a0; b1 = (1 - c) / a0; b2 = b0; a1 = -2 * c / a0; a2 = (1 - alpha) / a0;
    }
};

struct Slot { fs_device *dev = nullptr; Smoothed gain; Lowpass lp; };

struct fs_mix {
    std::vector<Slot> slots;
    int max_block = 0, L = 1;
    float sr = 48000;
    float ceiling = 0.891251f;                 /* -1 dBFS, as the web app's Tone.Limiter(-1) */
    float release = 0;
    std::vector<float> sum[FS_CHANNELS], out[FS_CHANNELS], delay[FS_CHANNELS];
    std::vector<float> need, avg;              /* rings: required gain (for the min), min values (for the average) */
    std::vector<long long> dq;                 /* monotonic deque of sample times, for the running min */
    int dq_head = 0, dq_n = 0;
    long long t = 0;
    double avg_sum = 0;
    float g = 1, min_gain = 1;
    long long over = 0;
};

extern "C" {

fs_mix *fs_mix_create(void) { return new fs_mix(); }
void fs_mix_destroy(fs_mix *m) { delete m; }

void fs_mix_prepare(fs_mix *m, float sr, int max_block, int max_slots) {
    m->max_block = max_block;
    m->sr = sr;
    m->L = (int)(0.005f * sr);
    m->release = 1.0f - std::exp(-1.0f / (0.1f * sr));
    m->slots.clear();
    m->slots.reserve(max_slots);
    for (int c = 0; c < FS_CHANNELS; c++) {
        m->sum[c].assign(max_block, 0.0f);
        m->out[c].assign(max_block, 0.0f);
        m->delay[c].assign(m->L, 0.0f);
    }
    m->need.assign(m->L + 1, 1.0f);
    m->avg.assign(m->L, 1.0f);
    m->dq.assign(m->L + 1, 0);
    m->dq_head = m->dq_n = 0;
    m->t = 0; m->avg_sum = m->L; m->g = 1; m->min_gain = 1; m->over = 0;
}

/* The mix does not own the device. Returns the slot index, or -1 when max_slots is reached. */
int fs_mix_add(fs_mix *m, fs_device *d, float sr, float gain) {
    if ((int)m->slots.size() == (int)m->slots.capacity()) return -1;
    Slot s; s.dev = d; s.gain.setup(sr, 30, gain);
    m->slots.push_back(s);
    return (int)m->slots.size() - 1;
}

void fs_mix_set_gain(fs_mix *m, int slot, float gain) {
    if (slot >= 0 && slot < (int)m->slots.size()) m->slots[slot].gain.target = gain < 0 ? 0 : gain;
}

/* A slot's low-pass cutoff in Hz, gliding over ~ramp_ms in log frequency. The first call switches the
   filter on and starts at that cutoff. */
void fs_mix_set_lowpass(fs_mix *m, int slot, float hz, float ramp_ms) {
    if (slot < 0 || slot >= (int)m->slots.size() || hz <= 0) return;
    Lowpass &f = m->slots[slot].lp;
    const double nyq = m->sr * 0.49;
    const double lf = std::log(std::min((double)hz, nyq));
    f.coef = 1 - std::exp(-32.0 / (std::max(1.0f, ramp_ms) * 0.001 * m->sr / 3));   /* ~95% in ramp_ms */
    if (!f.on) { f.on = true; f.logf = lf; f.design(std::exp(lf), m->sr); }
    f.target = lf;
}

/* How long a slot's gain takes to follow a new target (~63% in `ms`); 30 ms by default. */
void fs_mix_set_ramp(fs_mix *m, int slot, float ms) {
    if (slot < 0 || slot >= (int)m->slots.size() || ms <= 0) return;
    Smoothed &g = m->slots[slot].gain;
    float v = g.value, t = g.target;
    g.setup(m->sr, ms, v);
    g.target = t;
}

float *fs_mix_out(fs_mix *m, int c) { return m->out[c].data(); }

void fs_mix_process(fs_mix *m, int frames) {
    if (frames > m->max_block) frames = m->max_block;
    for (int c = 0; c < FS_CHANNELS; c++) std::fill(m->sum[c].begin(), m->sum[c].begin() + frames, 0.0f);
    for (Slot &s : m->slots) {
        fs_process(s.dev, frames);
        const float *a = fs_out(s.dev, 0), *b = fs_out(s.dev, 1);
        Lowpass &f = s.lp;
        for (int i = 0; i < frames; i++) {
            float g = s.gain.next();
            float l = a[i], r = b[i];
            if (f.on) {
                if ((i & 31) == 0) { f.logf += (f.target - f.logf) * f.coef; f.design(std::exp(f.logf), m->sr); }
                float in[2] = { l, r }, out[2];
                for (int c = 0; c < 2; c++) {
                    double y = f.b0 * in[c] + f.b1 * f.x1[c] + f.b2 * f.x2[c] - f.a1 * f.y1[c] - f.a2 * f.y2[c];
                    f.x2[c] = f.x1[c]; f.x1[c] = in[c]; f.y2[c] = f.y1[c]; f.y1[c] = y;
                    out[c] = (float)y;
                }
                l = out[0]; r = out[1];
            }
            m->sum[0][i] += l * g;
            m->sum[1][i] += r * g;
        }
    }
    const int L = m->L, W = L + 1;   /* min over L+1 samples: then every averaged min covers the sample leaving the delay */
    for (int i = 0; i < frames; i++, m->t++) {
        const long long t = m->t;
        const int k = (int)(t % L);
        /* gain this incoming sample needs */
        float pk = std::fmax(std::fabs(m->sum[0][i]), std::fabs(m->sum[1][i]));
        float nd = pk > m->ceiling ? m->ceiling / pk : 1.0f;
        m->need[t % W] = nd;
        /* running min over [t-L, t]: a monotonic deque of times, increasing need from front to back */
        if (m->dq_n && m->dq[m->dq_head] <= t - W) { m->dq_head = (m->dq_head + 1) % W; m->dq_n--; }   /* expire first: at most W live */
        while (m->dq_n && m->need[m->dq[(m->dq_head + m->dq_n - 1) % W] % W] >= nd) m->dq_n--;
        m->dq[(m->dq_head + m->dq_n) % W] = t; m->dq_n++;
        float mn = m->need[m->dq[m->dq_head] % W];
        /* running average of the min over L samples */
        m->avg_sum += mn - m->avg[k];
        m->avg[k] = mn;
        float target = (float)(m->avg_sum / L);
        m->g = target < m->g ? target : m->g + (target - m->g) * m->release;
        if (m->g < m->min_gain) m->min_gain = m->g;
        /* output the sample that entered L samples ago */
        for (int c = 0; c < FS_CHANNELS; c++) {
            float y = m->delay[c][k] * m->g;
            m->delay[c][k] = m->sum[c][i];
            if (std::fabs(y) > m->ceiling * 1.0001f) m->over++;
            m->out[c][i] = y;
        }
    }
}

void fs_mix_stats(fs_mix *m, float *min_gain_db, long long *over_ceiling) {
    *min_gain_db = 20.0f * std::log10(m->min_gain);
    *over_ceiling = m->over;
    m->min_gain = 1;
}

}
