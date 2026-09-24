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

float *fs_in(fs_device *d, int channel);
float *fs_out(fs_device *d, int channel);
void fs_process(fs_device *d, int frames);

#ifdef __cplusplus
}
#endif

#endif
