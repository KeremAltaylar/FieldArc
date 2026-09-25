// JNI bridge: the Kotlin app's door into the shared core (core/fieldscape.h), and the Android audio
// engine - an AAudio stream running the core's mix of four stretch slots, as the iOS Core does.
// Recordings reach the audio thread through a try-lock handoff (the callback never waits); the
// buffers they replace are freed on the Kotlin side's thread by collect(). A disconnected stream
// (headphones in or out, a route change) is reopened from a helper thread, never the callback.
#include <aaudio/AAudio.h>
#include <android/log.h>
#include <jni.h>

#include <atomic>
#include <chrono>
#include <cmath>
#include <mutex>
#include <thread>
#include <vector>

#include "fieldscape.h"

#define LOG(...) __android_log_print(ANDROID_LOG_INFO, "fieldscape", __VA_ARGS__)

namespace {

const int SLOTS = 4, MAX_BLOCK = 4096;

struct Engine {
    fs_mix *mix = nullptr;
    fs_device *voice[SLOTS] = {};
    AAudioStream *stream = nullptr;
    double sr = 48000;
    std::mutex lock;
    struct Pending { int slot; short *l, *r; int frames; };
    std::vector<Pending> pending;
    std::vector<short *> retired;
    short *live[SLOTS][2] = {};
    std::atomic<double> power{ 0 };
    std::atomic<float> worst_ms{ 0 };
    std::atomic<int> reopens{ 0 };
};
Engine *E = nullptr;

aaudio_data_callback_result_t render(AAudioStream *, void *, void *data, int32_t frames) {
    auto t0 = std::chrono::steady_clock::now();
    if (E->lock.try_lock()) {
        for (auto &p : E->pending) {
            const short *ch[2] = { p.l, p.r };
            fs_set_source_i16(E->voice[p.slot], 2, p.frames, ch);
            for (short *old : E->live[p.slot]) if (old) E->retired.push_back(old);
            E->live[p.slot][0] = p.l; E->live[p.slot][1] = p.r;
        }
        E->pending.clear();
        E->lock.unlock();
    }
    float *out = (float *)data;
    double sq = 0;
    for (int done = 0; done < frames;) {
        int n = std::min(frames - done, MAX_BLOCK);
        fs_mix_process(E->mix, n);
        const float *l = fs_mix_out(E->mix, 0), *r = fs_mix_out(E->mix, 1);
        for (int i = 0; i < n; i++) { out[2 * (done + i)] = l[i]; out[2 * (done + i) + 1] = r[i]; sq += (double)l[i] * l[i]; }
        done += n;
    }
    double p = E->power.load();
    E->power.store(p + (sq / std::max(frames, 1) - p) * 0.05);
    float ms = std::chrono::duration<float, std::milli>(std::chrono::steady_clock::now() - t0).count();
    if (ms > E->worst_ms.load()) E->worst_ms.store(ms);
    return AAUDIO_CALLBACK_RESULT_CONTINUE;
}

bool open_stream();

void on_error(AAudioStream *, void *, aaudio_result_t err) {
    if (err != AAUDIO_ERROR_DISCONNECTED) return;
    std::thread([] {                                   /* not from the callback's own thread */
        if (E->stream) { AAudioStream_close(E->stream); E->stream = nullptr; }
        E->reopens++;
        open_stream();
    }).detach();
}

bool open_stream() {
    AAudioStreamBuilder *b;
    if (AAudio_createStreamBuilder(&b) != AAUDIO_OK) return false;
    AAudioStreamBuilder_setFormat(b, AAUDIO_FORMAT_PCM_FLOAT);
    AAudioStreamBuilder_setChannelCount(b, 2);
    AAudioStreamBuilder_setSampleRate(b, (int)E->sr);
    AAudioStreamBuilder_setPerformanceMode(b, AAUDIO_PERFORMANCE_MODE_NONE);   /* a walk wants stability, not latency */
    AAudioStreamBuilder_setDataCallback(b, render, nullptr);
    AAudioStreamBuilder_setErrorCallback(b, on_error, nullptr);
    aaudio_result_t r = AAudioStreamBuilder_openStream(b, &E->stream);
    AAudioStreamBuilder_delete(b);
    if (r != AAUDIO_OK) { LOG("openStream failed: %s", AAudio_convertResultToText(r)); return false; }
    AAudioStream_requestStart(E->stream);
    return true;
}

}

#define FN(name) Java_net_keremaltaylar_fieldscape_Core_##name

extern "C" {

JNIEXPORT jdouble JNICALL FN(selfTestRms)(JNIEnv *, jclass) {
    fs_device *d = fs_create("sine");
    fs_prepare(d, 48000, 128);
    fs_set_param(d, 1, 0.2f);
    double sum = 0;
    for (int b = 0; b < 375; b++) { fs_process(d, 128); for (int i = 0; i < 128; i++) sum += fs_out(d, 0)[i] * fs_out(d, 0)[i]; }
    fs_destroy(d);
    return std::sqrt(sum / (375 * 128));
}

/* Starts the engine; returns its sample rate (the rate every recording is converted to). */
JNIEXPORT jdouble JNICALL FN(start)(JNIEnv *, jclass) {
    if (E) return E->sr;
    E = new Engine();
    E->pending.reserve(16); E->retired.reserve(64);
    E->mix = fs_mix_create();
    fs_mix_prepare(E->mix, (float)E->sr, MAX_BLOCK, SLOTS);
    for (int i = 0; i < SLOTS; i++) {
        E->voice[i] = fs_create("stretch");
        fs_set_param(E->voice[i], 6, (float)(i + 1));   /* seed: each voice its own phases */
        fs_prepare(E->voice[i], (float)E->sr, MAX_BLOCK);
        fs_mix_add(E->mix, E->voice[i], (float)E->sr, 0);
        fs_mix_set_ramp(E->mix, i, 350);                  /* the web's BED.fade */
    }
    open_stream();
    return E->sr;
}

/* Audio focus lost (a call, another player) or headphones unplugged: the stream pauses; it resumes
   when focus comes back or the listener presses Resume. */
JNIEXPORT void JNICALL FN(pause)(JNIEnv *, jclass) { if (E && E->stream) AAudioStream_requestPause(E->stream); }
JNIEXPORT void JNICALL FN(resume)(JNIEnv *, jclass) { if (E && E->stream) AAudioStream_requestStart(E->stream); }

JNIEXPORT void JNICALL FN(gain)(JNIEnv *, jclass, jint slot, jfloat g) { fs_mix_set_gain(E->mix, slot, g); }
JNIEXPORT void JNICALL FN(lowpass)(JNIEnv *, jclass, jint slot, jfloat hz) { fs_mix_set_lowpass(E->mix, slot, hz, 350); }
JNIEXPORT void JNICALL FN(param)(JNIEnv *, jclass, jint slot, jint i, jfloat v) { fs_set_param(E->voice[slot], i, v); }

/* A decoded stereo recording (16-bit, engine rate) for a slot; copied into native memory. */
JNIEXPORT void JNICALL FN(load)(JNIEnv *env, jclass, jint slot, jshortArray l, jshortArray r) {
    jsize n = env->GetArrayLength(l);
    short *a = new short[std::max(n, 1)], *b = new short[std::max(n, 1)];
    env->GetShortArrayRegion(l, 0, n, a);
    env->GetShortArrayRegion(r, 0, n, b);
    std::lock_guard<std::mutex> g(E->lock);
    E->pending.push_back({ slot, a, b, n });
}

/* A decoded recording as the decoder gives it - interleaved 16-bit, any channel count and rate - split,
   resampled to the engine rate when it differs, and handed to a slot. Native, because doing this a
   sample at a time in Kotlin stalled a 38 M-sample recording on the emulator. */
JNIEXPORT void JNICALL FN(loadInterleaved)(JNIEnv *env, jclass, jint slot, jobject inter, jint channels, jint frames, jdouble rate) {
    const short *x = (const short *)env->GetDirectBufferAddress(inter);   /* a direct buffer: no copy, no Java heap */
    if (!x) return;
    std::vector<short> l(std::max(frames, 1)), r(std::max(frames, 1));
    for (int i = 0; i < frames; i++) { l[i] = x[(long long)i * channels]; r[i] = x[(long long)i * channels + (channels > 1 ? 1 : 0)]; }
    long long n = frames;
    short *a, *b;
    if (rate != E->sr) {
        n = fs_resample_length(frames, rate, E->sr);
        a = new short[std::max(n, 1LL)]; b = new short[std::max(n, 1LL)];
        fs_resample_i16(l.data(), frames, rate, a, E->sr);
        fs_resample_i16(r.data(), frames, rate, b, E->sr);
    } else {
        a = new short[std::max(n, 1LL)]; b = new short[std::max(n, 1LL)];
        std::copy(l.begin(), l.begin() + n, a); std::copy(r.begin(), r.begin() + n, b);
    }
    std::lock_guard<std::mutex> g(E->lock);
    E->pending.push_back({ slot, a, b, (int)n });
}

/* Frees what the audio thread let go of; call now and then from the app. */
JNIEXPORT void JNICALL FN(collect)(JNIEnv *, jclass) {
    std::vector<short *> free;
    { std::lock_guard<std::mutex> g(E->lock); free.swap(E->retired); E->retired.reserve(64); }
    for (short *p : free) delete[] p;
}

JNIEXPORT jdouble JNICALL FN(outputDb)(JNIEnv *, jclass) { return 10 * std::log10(std::max(E->power.load(), 1e-12)); }
JNIEXPORT jfloat JNICALL FN(worstMs)(JNIEnv *, jclass) { return E->worst_ms.load(); }
JNIEXPORT jint JNICALL FN(bufferFrames)(JNIEnv *, jclass) { return E->stream ? AAudioStream_getFramesPerBurst(E->stream) : 0; }
JNIEXPORT jint JNICALL FN(xruns)(JNIEnv *, jclass) { return E->stream ? AAudioStream_getXRunCount(E->stream) : -1; }

/* The place layer, as the iOS app calls it. */
JNIEXPORT jdouble JNICALL FN(geoDistance)(JNIEnv *, jclass, jdouble a, jdouble b, jdouble c, jdouble d) { return fs_geo_distance(a, b, c, d); }
JNIEXPORT jdouble JNICALL FN(pointGain)(JNIEnv *, jclass, jdouble d, jdouble r, jdouble g) { return fs_point_gain(d, r, g); }
JNIEXPORT jdouble JNICALL FN(pointProximity)(JNIEnv *, jclass, jdouble d, jdouble r) { return fs_point_proximity(d, r); }

JNIEXPORT jintArray JNICALL FN(pickVoices)(JNIEnv *env, jclass, jdoubleArray dist, jdoubleArray radius, jbooleanArray eligible, jint max, jboolean radiusFirst) {
    jsize n = env->GetArrayLength(dist);
    std::vector<double> d(n), r(n); std::vector<jboolean> e(n); std::vector<unsigned char> el(n); std::vector<int> out(std::max(n, 1));
    env->GetDoubleArrayRegion(dist, 0, n, d.data());
    env->GetDoubleArrayRegion(radius, 0, n, r.data());
    env->GetBooleanArrayRegion(eligible, 0, n, e.data());
    for (int i = 0; i < n; i++) el[i] = e[i] ? 1 : 0;
    int k = fs_pick_voices(d.data(), r.data(), el.data(), n, max, radiusFirst ? 1 : 0, out.data());
    jintArray res = env->NewIntArray(k);
    env->SetIntArrayRegion(res, 0, k, out.data());
    return res;
}

JNIEXPORT jboolean JNICALL FN(pointInRing)(JNIEnv *env, jclass, jdouble lon, jdouble lat, jdoubleArray ring) {
    jsize n = env->GetArrayLength(ring);
    std::vector<double> r(n);
    env->GetDoubleArrayRegion(ring, 0, n, r.data());
    return fs_point_in_ring(lon, lat, r.data(), n / 2) != 0;
}

JNIEXPORT jshortArray JNICALL FN(resample)(JNIEnv *env, jclass, jshortArray in, jdouble from, jdouble to) {
    jsize n = env->GetArrayLength(in);
    std::vector<short> a(n);
    env->GetShortArrayRegion(in, 0, n, a.data());
    long long m = fs_resample_length(n, from, to);
    std::vector<short> b(m);
    fs_resample_i16(a.data(), n, from, b.data(), to);
    jshortArray res = env->NewShortArray((jsize)m);
    env->SetShortArrayRegion(res, 0, (jsize)m, b.data());
    return res;
}

}
