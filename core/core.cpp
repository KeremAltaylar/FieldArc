/* The device base, the registry, and the C interface over them. */
#include "fieldscape.h"
#include "device.hpp"

#include <chrono>
#include <cstring>

Device *make_passthrough();
Device *make_sine();
Device *make_stretch();
Device *make_piece();

static const struct { const char *id; Device *(*make)(); } REGISTRY[] = {
    { "passthrough", make_passthrough },
    { "sine", make_sine },
    { "stretch", make_stretch },
    { "piece", make_piece },
};

struct fs_device {
    Device *impl;
    float sr = 48000;
    int underruns = 0;
    float max_ms = 0;
};

Device *fs_device_impl(fs_device *d) { return d->impl; }

extern "C" {

fs_device *fs_create(const char *id) {
    for (auto &r : REGISTRY)
        if (std::strcmp(r.id, id) == 0) return new fs_device{ r.make() };
    return nullptr;
}

void fs_destroy(fs_device *d) {
    if (!d) return;
    delete d->impl;
    delete d;
}

void fs_prepare(fs_device *d, float sr, int max_block) {
    d->sr = sr;
    for (int c = 0; c < FS_CHANNELS; c++) {
        d->impl->in[c].assign(max_block, 0.0f);
        d->impl->out[c].assign(max_block, 0.0f);
    }
    d->impl->prepare(sr, max_block);
}

void fs_set_param(fs_device *d, int i, float v) {
    int n = 0;
    const fs_param *p = d->impl->params(n);
    if (i < 0 || i >= n) return;
    d->impl->set_param(i, v < p[i].min ? p[i].min : (v > p[i].max ? p[i].max : v));
}

int fs_param_count(const fs_device *d) { int n = 0; d->impl->params(n); return n; }

const fs_param *fs_param_info(const fs_device *d, int i) {
    int n = 0;
    const fs_param *p = d->impl->params(n);
    return (i >= 0 && i < n) ? &p[i] : nullptr;
}

float *fs_in(fs_device *d, int c) { return d->impl->in[c].data(); }
float *fs_out(fs_device *d, int c) { return d->impl->out[c].data(); }

void fs_process(fs_device *d, int frames) {
    if (frames > (int)d->impl->out[0].size()) frames = (int)d->impl->out[0].size();
    auto t0 = std::chrono::steady_clock::now();
    d->impl->process(frames);
    float ms = std::chrono::duration<float, std::milli>(std::chrono::steady_clock::now() - t0).count();
    if (ms > d->max_ms) d->max_ms = ms;
    if (ms > 1000.0f * frames / d->sr) d->underruns++;
}

void fs_set_source_i16(fs_device *d, int channels, int frames, const short *const *samples) {
    d->impl->set_source_i16(channels, frames, reinterpret_cast<const int16_t *const *>(samples));
}

void fs_set_source(fs_device *d, int channels, int frames, const float *const *samples) {
    d->impl->set_source(channels, frames, samples);
}

void fs_stats(fs_device *d, fs_stats_t *out) {
    *out = fs_stats_t{};
    d->impl->stats(*out);
    out->underruns = d->underruns;
    out->max_process_ms = d->max_ms;
}

}
