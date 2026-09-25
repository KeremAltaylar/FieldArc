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

struct Slot { fs_device *dev = nullptr; Smoothed gain; };

struct fs_mix {
    std::vector<Slot> slots;
    int max_block = 0, L = 1;
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

float *fs_mix_out(fs_mix *m, int c) { return m->out[c].data(); }

void fs_mix_process(fs_mix *m, int frames) {
    if (frames > m->max_block) frames = m->max_block;
    for (int c = 0; c < FS_CHANNELS; c++) std::fill(m->sum[c].begin(), m->sum[c].begin() + frames, 0.0f);
    for (Slot &s : m->slots) {
        fs_process(s.dev, frames);
        const float *a = fs_out(s.dev, 0), *b = fs_out(s.dev, 1);
        for (int i = 0; i < frames; i++) {
            float g = s.gain.next();
            m->sum[0][i] += a[i] * g;
            m->sum[1][i] += b[i] * g;
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
