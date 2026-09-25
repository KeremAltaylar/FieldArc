// Times every fs_process call while the window moves the way a slider drag moves it, to find the
// callback that took 164 ms on the iPhone 8 (2026-09-24). Build from the repo root:
//   c++ -std=c++17 -O2 core/core.cpp core/mix.cpp core/devices/*.cpp core/tests/window_bench.cpp -o wb && ./wb
#include "../fieldscape.h"
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstdio>
#include <vector>

int main() {
    bool ok = true;
    const float SR = 48000;
    const int B = 1024, SEC = 20;
    std::vector<float> l(SR * 30), r(SR * 30);
    unsigned s = 1;
    for (size_t i = 0; i < l.size(); i++) { s = s * 1664525u + 1013904223u; l[i] = ((s >> 9) / 8388608.0f - 1) * 0.1f; r[i] = -l[i]; }
    const float *ch[2] = { l.data(), r.data() };

    for (int scenario = 0; scenario < 3; scenario++) {
        fs_device *d = fs_create("stretch");
        fs_prepare(d, SR, 4096);
        fs_set_source(d, 2, (int)l.size(), ch);
        fs_set_param(d, 0, 0.45f);
        double worst = 0; int worst_at = -1;
        const int calls = (int)(SR * SEC / B);
        for (int k = 0; k < calls; k++) {
            if (scenario == 1 && k >= 50 && k < 110)     /* drag 0.34 s -> 2 s -> 0.1 s over ~1.3 s */
                fs_set_param(d, 1, k < 80 ? 0.34f + (k - 50) * (1.66f / 30) : 2.0f - (k - 80) * (1.9f / 30));
            if (scenario == 2 && k == 50) fs_set_param(d, 1, 2.0f);   /* one jump to the largest window */
            auto t0 = std::chrono::steady_clock::now();
            fs_process(d, B);
            double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
            if (ms > worst) { worst = ms; worst_at = k; }
        }
        const char *name[] = { "steady 0.34 s", "drag 0.34->2->0.1 s", "jump to 2 s" };
        std::printf("%-22s worst %.3f ms at call %d (budget %.1f ms)\n", name[scenario], worst, worst_at, 1000.0 * B / SR);
        ok = ok && worst < 0.5 * 1000.0 * B / SR;   /* spec test 8 budget: half the callback */
        fs_destroy(d);
    }
    std::puts(ok ? "PASS" : "FAIL");
    return ok ? EXIT_SUCCESS : EXIT_FAILURE;
}
