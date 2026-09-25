/* Fieldscape sound core: the one C interface the web (WASM), iOS (Swift) and Android (JNI) hosts
   call. Every device - point devices (stretch, grains, rhythm) and route/zone devices (generative
   synths) - sits behind it, so a new device is one file plus one line in the registry, and no
   host changes. Devices never see GPS or the map: the place layer hands them plain 0-1 numbers
   through fs_set_param.

   Buffers are planar, FS_CHANNELS channels of up to maxBlock frames, owned by the device.
   The host writes input into fs_in(), calls fs_process(), and reads fs_out(). */
#ifndef FIELDSCAPE_H
#define FIELDSCAPE_H

#include <stddef.h>

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
void fs_mix_set_ramp(fs_mix *m, int slot, float ms);                      /* slower ramps, e.g. GPS-driven fades */
void fs_mix_process(fs_mix *m, int frames);
float *fs_mix_out(fs_mix *m, int channel);
/* Deepest gain reduction since the last call (dB, 0 = none) and samples ever over the ceiling. */
void fs_mix_stats(fs_mix *m, float *min_gain_db, long long *over_ceiling);

/* The place layer (core/place.cpp): position -> the numbers the mix and devices hear. Ported
   from index.html; core/tests/place_test.cpp holds it to the JS. Coordinates are lon, lat. */
#define FS_ZONE_MARGIN 1.3        /* leave a point at 130% of its radius (A-14) */
#define FS_ZONE_COOLDOWN_MS 8000  /* before the same point can be entered again */
#define FS_GPS_ACC_MAX 40         /* metres of reported accuracy a fix must beat */
#define FS_GPS_FADE_FROM 60       /* metres off the route where the walk starts to fade */
#define FS_GPS_LEASH 120          /* metres off the route where it is silent */
#define FS_MAX_VOICES 4           /* recordings sounding at once (BED.maxVoices) */

typedef struct fs_route fs_route;
typedef struct { double dist, t, along, lon, lat; } fs_projection;   /* metres, 0-1, metres, point */
typedef struct { int inside; double fired_at_ms; } fs_zone_state;

double fs_geo_distance(double lon1, double lat1, double lon2, double lat2);   /* haversine, metres */
fs_route *fs_route_create(const double *lonlat, int n);                       /* n points, lon/lat pairs */
void fs_route_destroy(fs_route *r);
double fs_route_length(const fs_route *r);
fs_projection fs_route_project(const fs_route *r, double lon, double lat);
void fs_route_point_along(const fs_route *r, double t, double *lon, double *lat);
int fs_nearest_route(const fs_route *const *routes, int n, double lon, double lat, int current,
                     double margin, fs_projection *out);
double fs_walk_level(double dist, double from, double leash);
double fs_point_proximity(double dist, double radius);
double fs_point_gain(double dist, double radius, double gain);
int fs_zone_step(fs_zone_state *z, double dist, double radius, double now_ms, double margin, double cooldown_ms);
int fs_pick_voices(const double *dist, const double *radius, const unsigned char *eligible, int n,
                   int max_voices, int radius_first, int *out);

/* WebM/Opus demuxing (core/webm.cpp) for platforms that decode Opus but cannot open WebM (iOS).
   Returns the packet count (writing at most `max` offsets/sizes into the data; call once with
   max 0 to size the arrays), or -1 not WebM, -2 no Opus track, -3 laced blocks. Trim pre_skip
   samples from the start of the decoded audio, less whatever the decoder already dropped
   (total_samples minus what it returned). */
typedef struct { int channels, pre_skip, sample_rate; long long total_samples; } fs_webm_info;   /* samples: all packets, before pre-skip */
int fs_webm_opus(const unsigned char *data, size_t n, fs_webm_info *info, unsigned *offsets, unsigned *sizes, int max);
int fs_opus_packet_samples(const unsigned char *packet, size_t len);   /* 48 kHz samples, from the TOC byte */

#ifdef __cplusplus
}
#endif

#endif
