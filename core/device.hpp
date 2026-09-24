/* What a device implements. core.cpp owns the buffers and the C interface. */
#pragma once
#include "fieldscape.h"
#include <cmath>
#include <vector>

struct Device {
    std::vector<float> in[FS_CHANNELS], out[FS_CHANNELS];
    virtual ~Device() {}
    virtual void prepare(float sample_rate, int max_block) = 0;
    virtual const fs_param *params(int &count) = 0;
    virtual void set_param(int index, float value) = 0;
    virtual void process(int frames) = 0;
    virtual void set_source(int, int, const float *const *) {}
    virtual void stats(fs_stats_t &) {}   /* device-specific fields; core fills timing */
};

/* One-pole smoother reaching ~63% of a jump in `ms`: the A-2 ramp every device parameter uses. */
struct Smoothed {
    float value = 0, target = 0, coef = 0;
    void setup(float sample_rate, float ms, float v) { coef = 1.0f - std::exp(-1000.0f / (ms * sample_rate)); value = target = v; }
    float next() { value += (target - value) * coef; return value; }
};
