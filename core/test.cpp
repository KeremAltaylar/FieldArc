// The core's self-check. Build and run on any platform:
//   c++ -std=c++17 -O2 core/core.cpp core/mix.cpp core/place.cpp core/sections.cpp core/webm.cpp core/devices/*.cpp core/test.cpp -o fs_test && ./fs_test
#include "fieldscape.h"
#include <cassert>
#include <cmath>
#include <cstdio>
#include <vector>

int main() {
    const float SR = 48000;
    const int B = 128;

    assert(fs_create("nope") == nullptr);

    /* passthrough is bit-exact */
    fs_device *p = fs_create("passthrough");
    fs_prepare(p, SR, B);
    for (int i = 0; i < B; i++) { fs_in(p, 0)[i] = std::sin(i * 0.1f); fs_in(p, 1)[i] = -0.5f; }
    fs_process(p, B);
    for (int i = 0; i < B; i++) { assert(fs_out(p, 0)[i] == fs_in(p, 0)[i]); assert(fs_out(p, 1)[i] == -0.5f); }
    fs_destroy(p);

    /* sine: 1 s at 440 Hz, level 0.2 -> RMS 0.2/sqrt(2), 880 zero crossings */
    fs_device *s = fs_create("sine");
    fs_prepare(s, SR, B);
    assert(fs_param_count(s) == 2);
    fs_set_param(s, 1, 5.0f);                        /* clamped to 1 */
    fs_set_param(s, 1, 0.2f);
    double sum = 0; int crossings = 0; float prev = 0;
    for (int b = 0; b < SR / B; b++) {
        fs_process(s, B);
        for (int i = 0; i < B; i++) {
            float v = fs_out(s, 0)[i];
            sum += v * v;
            if ((prev < 0) != (v < 0)) crossings++;
            prev = v;
        }
    }
    double rms = std::sqrt(sum / (SR / B * B));
    std::printf("sine rms %.4f (want %.4f), crossings %d (want ~880)\n", rms, 0.2 / std::sqrt(2.0), crossings);
    assert(std::fabs(rms - 0.2 / std::sqrt(2.0)) < 0.002);
    assert(crossings >= 876 && crossings <= 884);

    /* A-2: a level jump 0.2 -> 1.0 must ramp, not step. The largest sample-to-sample change stays
       near the sine's own slope (2*pi*440/48000 ~ 0.058 at full level). */
    fs_set_param(s, 1, 1.0f);
    float maxstep = 0; prev = fs_out(s, 0)[B - 1];
    for (int b = 0; b < 20; b++) {
        fs_process(s, B);
        for (int i = 0; i < B; i++) { float v = fs_out(s, 0)[i]; maxstep = std::fmax(maxstep, std::fabs(v - prev)); prev = v; }
    }
    std::printf("level jump: max step %.4f (limit 0.07)\n", maxstep);
    assert(maxstep < 0.07f);
    fs_destroy(s);

    /* mix: quiet material passes bit-exact, only delayed by the 5 ms lookahead */
    {
        fs_device *a = fs_create("sine"), *ref = fs_create("sine");
        fs_prepare(a, SR, B); fs_prepare(ref, SR, B);
        fs_mix *m = fs_mix_create();
        fs_mix_prepare(m, SR, B, 4);
        assert(fs_mix_add(m, a, SR, 1.0f) == 0);
        const int L = (int)(0.005f * SR);
        std::vector<float> want, got;
        for (int b = 0; b < 40; b++) {
            fs_mix_process(m, B); fs_process(ref, B);
            for (int i = 0; i < B; i++) { got.push_back(fs_mix_out(m, 0)[i]); want.push_back(fs_out(ref, 0)[i]); }
        }
        for (size_t i = L; i < got.size(); i++) assert(got[i] == want[i - L]);
        float gr; long long over; fs_mix_stats(m, &gr, &over);
        assert(gr == 0.0f && over == 0);
        fs_mix_destroy(m); fs_destroy(a); fs_destroy(ref);
    }

    /* mix: two full-level sines (peaks to 2.0) never pass -1 dBFS, and a slot's gain ramps */
    {
        fs_device *a = fs_create("sine"), *b2 = fs_create("sine");
        fs_prepare(a, SR, B); fs_prepare(b2, SR, B);
        fs_set_param(a, 1, 1.0f); fs_set_param(b2, 1, 1.0f); fs_set_param(b2, 0, 443.0f);
        fs_mix *m = fs_mix_create();
        fs_mix_prepare(m, SR, B, 4);
        fs_mix_add(m, a, SR, 1.0f);
        int s2 = fs_mix_add(m, b2, SR, 0.0f);
        fs_mix_set_gain(m, s2, 1.0f);                      /* fade the second in: must ramp */
        float peak = 0, maxstep = 0, prev = 0;
        for (int b = 0; b < 375 * 3; b++) {
            fs_mix_process(m, B);
            for (int i = 0; i < B; i++) {
                float v = fs_mix_out(m, 0)[i];
                peak = std::fmax(peak, std::fabs(v));
                maxstep = std::fmax(maxstep, std::fabs(v - prev)); prev = v;
            }
        }
        float gr; long long over; fs_mix_stats(m, &gr, &over);
        std::printf("mix: 2 sines peak %.4f (ceiling 0.8913), reduction %.1f dB, over %lld, max step %.4f\n", peak, gr, over, maxstep);
        assert(peak <= 0.8913f && over == 0 && gr < -5.0f);
        assert(maxstep < 0.13f);                           /* two sines' own slope ~0.116: no step from the fade or the limiter */
        fs_mix_destroy(m); fs_destroy(a); fs_destroy(b2);
    }

    /* mix: a burst from silence to 2.0 is caught before it arrives */
    {
        fs_device *p2 = fs_create("passthrough");
        fs_prepare(p2, SR, B);
        fs_mix *m = fs_mix_create();
        fs_mix_prepare(m, SR, B, 2);
        fs_mix_add(m, p2, SR, 1.0f);
        unsigned r = 1; float peak = 0;
        for (int b = 0; b < 200; b++) {
            for (int i = 0; i < B; i++) {
                r = r * 1664525u + 1013904223u;
                float v = b < 50 ? 0.0f : 2.0f * ((r >> 9) / 8388608.0f - 1.0f);
                fs_in(p2, 0)[i] = v; fs_in(p2, 1)[i] = -v;
            }
            fs_mix_process(m, B);
            for (int i = 0; i < B; i++) peak = std::fmax(peak, std::fabs(fs_mix_out(m, 0)[i]));
        }
        float gr; long long over; fs_mix_stats(m, &gr, &over);
        std::printf("mix: burst 0 -> 2.0 peak %.4f, reduction %.1f dB, over %lld\n", peak, gr, over);
        assert(peak <= 0.8913f && over == 0);
        fs_mix_destroy(m); fs_destroy(p2);
    }

    /* stretch: a 16-bit source plays bit-identically to the float source holding the same samples */
    {
        const int n = 48000 * 3;
        std::vector<short> q(n); std::vector<float> fq(n);
        unsigned r = 5;
        for (int i = 0; i < n; i++) { r = r * 1664525u + 1013904223u; q[i] = (short)((int)(r >> 16) - 32768); fq[i] = q[i] * (1.0f / 32768.0f); }
        const short *qs[1] = { q.data() }; const float *fs[1] = { fq.data() };
        fs_device *a = fs_create("stretch"), *b = fs_create("stretch");
        fs_prepare(a, SR, B); fs_prepare(b, SR, B);
        fs_set_source_i16(a, 1, n, qs); fs_set_source(b, 1, n, fs);
        fs_set_param(a, 0, 0.3f); fs_set_param(b, 0, 0.3f);
        long diff = 0; double energy = 0;
        for (int k = 0; k < 48000 * 4 / B; k++) {
            fs_process(a, B); fs_process(b, B);
            for (int c = 0; c < 2; c++) for (int i = 0; i < B; i++) { diff += fs_out(a, c)[i] != fs_out(b, c)[i]; energy += fs_out(a, c)[i] * fs_out(a, c)[i]; }
        }
        std::printf("stretch int16 vs float source: %ld differing samples (signal energy %.1f)\n", diff, energy);
        assert(diff == 0 && energy > 1);
        fs_destroy(a); fs_destroy(b);
    }

    std::printf("core ok\n");
    return 0;
}
