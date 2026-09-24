// Phase-3 Android host: a NativeActivity (no Java) that plays the core's "sine" device through
// AAudio and logs the output RMS and buffer size once a second, so logcat proves sound is flowing.
// Kotlin + Oboe replace this in phase 6.
#include "../core/fieldscape.h"
#include <aaudio/AAudio.h>
#include <android/log.h>
#include <android/native_activity.h>
#include <atomic>
#include <cmath>

#define LOG(...) __android_log_print(ANDROID_LOG_INFO, "fieldscape", __VA_ARGS__)

static fs_device *dev;
static AAudioStream *stream;
static std::atomic<int> frames_seen{0};
static double sumsq, rate;

static aaudio_data_callback_result_t render(AAudioStream *s, void *, void *data, int32_t frames) {
    float *out = (float *)data;
    fs_process(dev, frames);
    for (int i = 0; i < frames; i++) {
        float v = fs_out(dev, 0)[i];
        out[2 * i] = v;
        out[2 * i + 1] = fs_out(dev, 1)[i];
        sumsq += v * v;
    }
    if ((frames_seen += frames) >= rate) {
        LOG("output RMS %.4f, burst %d frames, buffer %d frames, xruns %d", std::sqrt(sumsq / frames_seen),
            AAudioStream_getFramesPerBurst(s), AAudioStream_getBufferSizeInFrames(s), AAudioStream_getXRunCount(s));
        sumsq = 0;
        frames_seen = 0;
    }
    return AAUDIO_CALLBACK_RESULT_CONTINUE;
}

static void start(ANativeActivity *) {
    AAudioStreamBuilder *b;
    AAudio_createStreamBuilder(&b);
    AAudioStreamBuilder_setFormat(b, AAUDIO_FORMAT_PCM_FLOAT);
    AAudioStreamBuilder_setChannelCount(b, 2);
    AAudioStreamBuilder_setPerformanceMode(b, AAUDIO_PERFORMANCE_MODE_LOW_LATENCY);
    AAudioStreamBuilder_setDataCallback(b, render, nullptr);
    if (AAudioStreamBuilder_openStream(b, &stream) != AAUDIO_OK) { LOG("openStream failed"); return; }
    AAudioStreamBuilder_delete(b);
    rate = AAudioStream_getSampleRate(stream);
    dev = fs_create("sine");
    fs_prepare(dev, (float)rate, 8192);
    AAudioStream_requestStart(stream);
    LOG("started at %.0f Hz", rate);
}

static void stop(ANativeActivity *) {
    if (stream) { AAudioStream_close(stream); stream = nullptr; }
    fs_destroy(dev);
    dev = nullptr;
}

extern "C" JNIEXPORT void ANativeActivity_onCreate(ANativeActivity *a, void *, size_t) {
    a->callbacks->onResume = start;
    a->callbacks->onPause = stop;
}
