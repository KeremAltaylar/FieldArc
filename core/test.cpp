// The core's self-check. Build and run on any platform:
//   c++ -std=c++17 -O2 core/core.cpp core/devices/*.cpp core/test.cpp -o fs_test && ./fs_test
#include "fieldscape.h"
#include <cassert>
#include <cmath>
#include <cstdio>

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

    std::printf("core ok\n");
    return 0;
}
