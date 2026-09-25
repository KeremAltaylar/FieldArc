/* Fieldscape sound core: the one C interface the web (WASM), iOS (Swift) and Android (JNI) hosts
   call. Every device - point devices (stretch, grains, rhythm) and route/zone devices (generative
   synths) - sits behind it, so a new device is one file plus one line in the registry, and no
   host changes. Devices never see GPS or the map: the place layer hands them plain 0-1 numbers
   through fs_set_param.

   Buffers are planar, FS_CHANNELS channels of up to maxBlock frames, owned by the device.
   The host writes input into fs_in(), calls fs_process(), and reads fs_out(). */
#ifndef FIELDSCAPE_H
#define FIELDSCAPE_H

#ifdef __cplusplus
extern "C" {
#endif

#define FS_CHANNELS 2

typedef struct fs_device fs_device;

typedef struct {
    const char *id, *name, *unit;
    float min, max, def;
} fs_param;

/* NULL for an unknown id. */
fs_device *fs_create(const char *device_id);
void fs_destroy(fs_device *d);

/* Allocates everything the audio thread will need; nothing allocates after this. */
void fs_prepare(fs_device *d, float sample_rate, int max_block);

/* Smoothed inside the device, so a jump from the host never clicks (rulebook A-2). */
void fs_set_param(fs_device *d, int index, float value);

int fs_param_count(const fs_device *d);
const fs_param *fs_param_info(const fs_device *d, int index);

/* Source material for devices that play a recording (stretch). Host-owned memory, planar, valid
   until replaced; channels 1 feeds both outputs, beyond FS_CHANNELS the rest is ignored. Must be
   at the engine's sample rate. Call it from the audio thread or while stopped. Devices without a
   source ignore it. frames = 0 or samples = NULL clears it (silence). */
void fs_set_source(fs_device *d, int channels, int frames, const float *const *samples);

typedef struct {
    int late_frames;        /* frames not ready when their hop began (had to finish in that call) */
    int underruns;          /* fs_process calls that took longer than the audio they produced */
    float max_process_ms;   /* slowest fs_process call */
    long long frames;       /* stretch: frames synthesised by the active window */
    int wraps;              /* stretch: times the read position wrapped past the end of the source */
} fs_stats_t;
void fs_stats(fs_device *d, fs_stats_t *out);

float *fs_in(fs_device *d, int channel);
float *fs_out(fs_device *d, int channel);
void fs_process(fs_device *d, int frames);

/* The master bus: devices summed with smoothed per-slot gains (the walk's fades), then a 5 ms
   lookahead limiter at -1 dBFS, so the output never passes the ceiling (rulebook A-6). The mix
   calls fs_process on its devices; it does not own them. */
typedef struct fs_mix fs_mix;
fs_mix *fs_mix_create(void);
void fs_mix_destroy(fs_mix *m);
void fs_mix_prepare(fs_mix *m, float sample_rate, int max_block, int max_slots);
int fs_mix_add(fs_mix *m, fs_device *d, float sample_rate, float gain);   /* slot, or -1 when full */
void fs_mix_set_gain(fs_mix *m, int slot, float gain);                    /* ramped over ~30 ms */
void fs_mix_process(fs_mix *m, int frames);
float *fs_mix_out(fs_mix *m, int channel);
/* Deepest gain reduction since the last call (dB, 0 = none) and samples ever over the ceiling. */
void fs_mix_stats(fs_mix *m, float *min_gain_db, long long *over_ceiling);

#ifdef __cplusplus
}
#endif

#endif
