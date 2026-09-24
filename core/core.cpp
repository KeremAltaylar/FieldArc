/* The device base, the registry, and the C interface over them. */
#include "fieldscape.h"
#include "device.hpp"

#include <cstring>

Device *make_passthrough();
Device *make_sine();

static const struct { const char *id; Device *(*make)(); } REGISTRY[] = {
    { "passthrough", make_passthrough },
    { "sine", make_sine },
};

struct fs_device { Device *impl; };

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
    d->impl->process(frames);
}

}
