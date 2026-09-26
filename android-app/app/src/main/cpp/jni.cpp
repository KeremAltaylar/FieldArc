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
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "fieldscape.h"
#include "json.hpp"

#define LOG(...) __android_log_print(ANDROID_LOG_INFO, "fieldscape", __VA_ARGS__)

namespace {

const int SLOTS = 4, MAX_BLOCK = 4096;

struct Engine {
    fs_mix *mix = nullptr;
    fs_device *voice[SLOTS] = {};
    fs_device *piece = nullptr;          /* the route's synths, zones and rhythm points (core/piece.cpp), slot SLOTS */
    AAudioStream *stream = nullptr;
    double sr = 48000;
    std::mutex lock;
    struct Pending { int slot; short *l, *r; int frames; };
    std::vector<Pending> pending;
    std::vector<short *> retired;
    short *live[SLOTS][2] = {};
    int live_frames[SLOTS] = {};
    std::atomic<double> power{ 0 };
    std::atomic<float> worst_ms{ 0 };
    std::atomic<int> reopens{ 0 };
    /* the Sound / Stop fade: the whole output follows master_target at master_step per sample */
    std::atomic<float> master_target{ 1 }, master_step{ 1 };
    float master = 1;
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
            E->live_frames[p.slot] = p.frames;
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
        const float tgt = E->master_target.load(), st = E->master_step.load();
        for (int i = 0; i < n; i++) {
            E->master = E->master < tgt ? std::min(tgt, E->master + st) : std::max(tgt, E->master - st);
            float g = E->master;
            out[2 * (done + i)] = l[i] * g; out[2 * (done + i) + 1] = r[i] * g; sq += (double)l[i] * l[i] * g * g;
        }
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
    /* low-latency mode for its real-time callback thread, which Android does not throttle when the app
       leaves the foreground; the big buffer below is what gives the walk its stability */
    AAudioStreamBuilder_setPerformanceMode(b, AAUDIO_PERFORMANCE_MODE_LOW_LATENCY);
    /* ~350 ms of headroom: going to the Home screen (or the screen going off) stalls the callback for
       100-250 ms while Android demotes the app; a 90 ms buffer ran dry every time (emulator: 14
       dropouts in 5 Home round trips). Nothing in a walk needs low latency; Stop fades anyway. */
    AAudioStreamBuilder_setBufferCapacityInFrames(b, (int)(E->sr * 0.35));
    AAudioStreamBuilder_setDataCallback(b, render, nullptr);
    AAudioStreamBuilder_setErrorCallback(b, on_error, nullptr);
    aaudio_result_t r = AAudioStreamBuilder_openStream(b, &E->stream);
    AAudioStreamBuilder_delete(b);
    if (r != AAUDIO_OK) { LOG("openStream failed: %s", AAudio_convertResultToText(r)); return false; }
    AAudioStream_setBufferSizeInFrames(E->stream, AAudioStream_getBufferCapacityInFrames(E->stream));   /* use all of it */
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
    fs_mix_prepare(E->mix, (float)E->sr, MAX_BLOCK, SLOTS + 1);
    for (int i = 0; i < SLOTS; i++) {
        E->voice[i] = fs_create("stretch");
        fs_set_param(E->voice[i], 6, (float)(i + 1));   /* seed: each voice its own phases */
        fs_prepare(E->voice[i], (float)E->sr, MAX_BLOCK);
        fs_mix_add(E->mix, E->voice[i], (float)E->sr, 0);
        fs_mix_set_ramp(E->mix, i, 350);                  /* the web's BED.fade */
    }
    E->piece = fs_create("piece");
    fs_prepare(E->piece, (float)E->sr, MAX_BLOCK);
    fs_mix_add(E->mix, E->piece, (float)E->sr, 1);
    open_stream();
    /* The loaded recordings, read a page at a time every 2 s off the audio thread, as on iOS: when the
       app leaves the foreground Android reclaims memory it has not touched lately, and the callback
       stalled reading those pages back. */
    std::thread([] {
        volatile short sink = 0;
        for (;;) {
            std::this_thread::sleep_for(std::chrono::seconds(2));
            std::lock_guard<std::mutex> g(E->lock);
            for (int s = 0; s < SLOTS; s++)
                for (short *p : E->live[s]) if (p) for (int i = 0; i < E->live_frames[s]; i += 2048) sink = sink + p[i];
        }
    }).detach();
    /* the stream's health in logcat every 2 s (adb logcat -s fieldscape): dropouts are measured, not guessed */
    std::thread([] {
        for (;;) {
            std::this_thread::sleep_for(std::chrono::seconds(2));
            AAudioStream *s = E->stream;
            if (s) LOG("engine xruns %d worst %.2f ms buffer %d of %d frames burst %d", AAudioStream_getXRunCount(s), E->worst_ms.load(),
                       AAudioStream_getBufferSizeInFrames(s), AAudioStream_getBufferCapacityInFrames(s), AAudioStream_getFramesPerBurst(s));
        }
    }).detach();
    return E->sr;
}

/* Audio focus lost (a call, another player) or headphones unplugged: the stream pauses; it resumes
   when focus comes back or the listener presses Resume. */
JNIEXPORT void JNICALL FN(pause)(JNIEnv *, jclass) { if (E && E->stream) AAudioStream_requestPause(E->stream); }
JNIEXPORT void JNICALL FN(resume)(JNIEnv *, jclass) { if (E && E->stream) AAudioStream_requestStart(E->stream); }

/* Sound / Stop: fade the whole output to `to` over `seconds` (linear) */
JNIEXPORT void JNICALL FN(master)(JNIEnv *, jclass, jfloat to, jfloat seconds) {
    if (!E) return;
    E->master_step.store(1.0f / std::max(1.0f, seconds * (float)E->sr));
    E->master_target.store(to);
}
JNIEXPORT void JNICALL FN(gain)(JNIEnv *, jclass, jint slot, jfloat g) { fs_mix_set_gain(E->mix, slot, g); }
JNIEXPORT void JNICALL FN(lowpass)(JNIEnv *, jclass, jint slot, jfloat hz) { fs_mix_set_lowpass(E->mix, slot, hz, 350); }
JNIEXPORT void JNICALL FN(grit)(JNIEnv *, jclass, jint slot, jfloat a) { fs_mix_set_grit(E->mix, slot, a); }
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

/* Decode buffers in native memory: a direct ByteBuffer from allocateDirect counts against the Java
   heap here (~192 MB), and three recordings decoding at once ran out of it. Freed once handed over. */
JNIEXPORT jobject JNICALL FN(allocDirect)(JNIEnv *env, jclass, jlong bytes) {
    void *p = std::malloc((size_t)std::max<jlong>(bytes, 1));
    return p ? env->NewDirectByteBuffer(p, bytes) : nullptr;
}
JNIEXPORT void JNICALL FN(freeDirect)(JNIEnv *env, jclass, jobject buf) { if (buf) std::free(env->GetDirectBufferAddress(buf)); }

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


/* ---- The piece's side of the walk, as ios/RouteSound.swift: which route and how far along it, the
   section underfoot, the plain points' zones, the recordings' character, the rhythm points. Kotlin
   hands over the features once and each fix; it fetches and decodes the rhythm recordings this asks
   for (pieceStep's list) and passes them back through pieceSource. */
namespace {
struct Walker {
    struct Spot { std::string icon; double lon, lat, radius, zoneR, centroid, onsets; bool audio, plain; fs_zone_state zone{}; };
    struct Beat { std::string id, name; double lon, lat, radius, gain; bool grains; std::string json; std::vector<std::string> paths; };
    std::vector<fs_route *> routes; std::vector<std::string> route_names;
    std::vector<Spot> spots; std::vector<Beat> beats;
    std::map<std::string, int> handle;
    fs_sections *sections = nullptr;
    std::vector<std::string> rhythm_names;
    std::string route_name;
    std::chrono::steady_clock::time_point t0 = std::chrono::steady_clock::now();
};
Walker *W = nullptr;

std::string dump(const Json *j) {   /* back to text for the piece's own parser */
    if (!j) return "{}";
    switch (j->kind) {
    case Json::NUL: return "null";
    case Json::BOOL: return j->b ? "true" : "false";
    case Json::NUM: { char b[32]; snprintf(b, sizeof b, "%.17g", j->num); return b; }
    case Json::STR: { std::string o = "\""; for (char c : j->str) { if (c == '"' || c == '\\') o += '\\'; o += c; } return o + "\""; }
    case Json::ARR: { std::string o = "["; for (size_t i = 0; i < j->arr.size(); i++) { if (i) o += ","; o += dump(&j->arr[i]); } return o + "]"; }
    default: {
        std::string o = "{";
        for (size_t i = 0; i < j->obj.size(); i++) { if (i) o += ","; Json k; k.kind = Json::STR; k.str = j->obj[i].first; o += dump(&k) + ":" + dump(&j->obj[i].second); }
        return o + "}";
    }
    }
}
std::string jstr(JNIEnv *env, jstring s) { const char *c = env->GetStringUTFChars(s, nullptr); std::string o(c); env->ReleaseStringUTFChars(s, c); return o; }
}

JNIEXPORT void JNICALL FN(pieceStart)(JNIEnv *env, jclass, jstring features) {
    if (!E || W) return;
    W = new Walker();
    Json fc = Json::parse(jstr(env, features).c_str());
    const Json *fs = fc.get("features");
    for (size_t i = 0; fs && i < fs->size(); i++) {
        const Json *f = fs->at(i), *g = f->get("geometry"), *p = f->get("properties");
        if (!g || !p) continue;
        std::string type = g->s("type", "");
        const Json *c = g->get("coordinates");
        if (type == "LineString" && p->s("kind", "") == "route" && c && c->size()) {
            std::vector<double> flat;
            for (size_t k = 0; k < c->size(); k++) { flat.push_back(c->at(k)->at(0)->num); flat.push_back(c->at(k)->at(1)->num); }
            fs_route *r = fs_route_create(flat.data(), (int)c->size());
            if (!r || fs_route_length(r) <= 0) { if (r) fs_route_destroy(r); continue; }
            W->routes.push_back(r); W->route_names.push_back(p->s("name", "Route"));
            fs_piece_add_route(E->piece, dump(p->get("patch")).c_str());
        } else if (type == "Point" && c && c->size() >= 2) {
            const Json *q = p->get("sound"), *a = p->get("audio"), *hits = p->get("hits");
            std::string mode = p->s("audio_mode", "");
            std::vector<std::string> slots;
            bool has_hits = false;
            for (const char *k : { "low", "mid", "high", "rand" }) {
                const Json *h = hits ? hits->get(k) : nullptr;
                std::string path = h ? h->s("storage_path", "") : "";
                has_hits |= !path.empty(); slots.push_back(path);
            }
            bool audio = p->flag("has_audio", false);
            double lon = c->at(0)->num, lat = c->at(1)->num, radius = q ? q->n("radius", 140) : 140, gain = q ? q->n("gain", 0.9) : 0.9;
            W->spots.push_back({ p->s("icon", ""), lon, lat, radius, q ? q->n("zoneR", 25) : 25, a ? a->n("centroid_hz", 0) : 0,
                                 a ? a->n("onset_rate", -1) : -1, audio, !audio && !has_hits && mode != "hits" && mode != "grains" });
            std::string id = p->s("id", ""), name = p->s("name", "Unnamed point");
            if (mode == "hits" && has_hits) W->beats.push_back({ id, name, lon, lat, radius, gain, false, dump(p->get("rhythm")), slots });
            else if (mode == "grains" && audio) W->beats.push_back({ id, name, lon, lat, radius, gain, true, dump(p->get("rhythm")), { p->s("storage_path", "") } });
        }
    }
}

JNIEXPORT jint JNICALL FN(pieceBedVoices)(JNIEnv *, jclass) { return E ? fs_piece_bed_voices(E->piece) : 4; }

/* The park underfoot changed (null: none): its sections at the playing patch's count. */
JNIEXPORT void JNICALL FN(piecePlace)(JNIEnv *env, jclass, jobjectArray rings, jdouble area) {
    if (!W) return;
    if (W->sections) { fs_sections_destroy(W->sections); W->sections = nullptr; }
    if (rings) {
        jsize n = env->GetArrayLength(rings);
        std::vector<std::vector<double>> rs(n); std::vector<const double *> ptrs(n); std::vector<int> counts(n); size_t most = 0;
        for (jsize i = 0; i < n; i++) {
            auto a = (jdoubleArray)env->GetObjectArrayElement(rings, i);
            rs[i].resize(env->GetArrayLength(a)); env->GetDoubleArrayRegion(a, 0, (jsize)rs[i].size(), rs[i].data());
            ptrs[i] = rs[i].data(); counts[i] = (int)rs[i].size() / 2; most = std::max(most, rs[i].size());
            env->DeleteLocalRef(a);
        }
        std::vector<double> out(most + 8); int which = 0;
        int k = n ? fs_place_frame(ptrs.data(), counts.data(), n, area, out.data(), &which) : 0;
        if (k >= 3) W->sections = fs_sections_create(out.data(), k, fs_piece_sect_n(E->piece));
    }
    fs_piece_sector(E->piece, -1);
}

/* One fix (worldMove). Returns the rhythm recordings to fetch: "handle slot id path" per line. */
JNIEXPORT jstring JNICALL FN(pieceStep)(JNIEnv *env, jclass, jdouble lon, jdouble lat) {
    if (!W) return env->NewStringUTF("");
    fs_projection proj{};
    int r = fs_nearest_route(W->routes.data(), (int)W->routes.size(), lon, lat, fs_piece_route(E->piece), fs_sections_hold(W->sections), &proj);
    fs_piece_walk(E->piece, r, proj.t, r >= 0 ? proj.dist : INFINITY);
    /* the route underfoot (its sound crossfades in over 1.5 s), named only within the leash */
    W->route_name = r >= 0 && r < (int)W->route_names.size() && proj.dist <= FS_GPS_LEASH ? W->route_names[r] : "";
    if (W->sections) {
        int cur = fs_piece_sector_now(E->piece), next = fs_sections_step(W->sections, cur, lon, lat);
        if (next != cur) fs_piece_sector(E->piece, next);
    }
    double now = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - W->t0).count();
    std::vector<double> d, rad, cen, ons;
    for (auto &s : W->spots) {
        double dist = fs_geo_distance(lon, lat, s.lon, s.lat);
        if (s.audio) { d.push_back(dist); rad.push_back(s.radius); cen.push_back(s.centroid); ons.push_back(s.onsets); }
        if (dist > s.radius * FS_ZONE_MARGIN) { s.zone = fs_zone_state{}; continue; }
        if (fs_zone_step(&s.zone, dist, s.zoneR, now, FS_ZONE_MARGIN, FS_ZONE_COOLDOWN_MS) == 1 && s.plain) fs_piece_zone(E->piece, s.icon.c_str());
    }
    fs_piece_character(E->piece, (int)d.size(), d.data(), rad.data(), cen.data(), ons.data());
    size_t nb = W->beats.size();
    std::vector<double> bd(nb), br(nb); std::vector<unsigned char> el(nb, 1); std::vector<int> picked(std::max<size_t>(nb, 1));
    for (size_t i = 0; i < nb; i++) { bd[i] = fs_geo_distance(lon, lat, W->beats[i].lon, W->beats[i].lat); br[i] = W->beats[i].radius; }
    int k = fs_pick_voices(bd.data(), br.data(), el.data(), (int)nb, std::min(FS_MAX_VOICES, std::max(fs_piece_bed_voices(E->piece), 1)), 1, picked.data());
    std::map<std::string, bool> want;
    for (int i = 0; i < k; i++) want[W->beats[picked[i]].id] = true;
    for (auto it = W->handle.begin(); it != W->handle.end();) {
        if (!want.count(it->first)) { fs_piece_rhythm_remove(E->piece, it->second); it = W->handle.erase(it); } else ++it;
    }
    std::string loads;
    W->rhythm_names.clear();
    for (int i = 0; i < k; i++) {
        const auto &b = W->beats[picked[i]];
        W->rhythm_names.push_back(b.name);
        if (!W->handle.count(b.id)) {
            int h = fs_piece_rhythm_add(E->piece, b.json.c_str(), b.grains);
            if (h < 0) continue;
            W->handle[b.id] = h;
            for (size_t s = 0; s < b.paths.size(); s++)
                if (!b.paths[s].empty()) loads += std::to_string(h) + " " + std::to_string(s) + " " + b.id + " " + b.paths[s] + "\n";
        }
        fs_piece_rhythm_gain(E->piece, W->handle[b.id], (float)fs_point_gain(bd[picked[i]], b.radius, b.gain));
    }
    return env->NewStringUTF(loads.c_str());
}

/* A rhythm recording, decoded (interleaved 16-bit, any rate): resampled to the engine's and handed to
   the piece, which owns it - unless the point has left since it was asked for. */
JNIEXPORT void JNICALL FN(pieceSource)(JNIEnv *env, jclass, jint h, jint slot, jstring id, jobject inter, jint channels, jint frames, jdouble rate) {
    if (!W) return;
    auto it = W->handle.find(jstr(env, id));
    if (it == W->handle.end() || it->second != h) return;
    const short *x = (const short *)env->GetDirectBufferAddress(inter);
    if (!x || frames <= 0) return;
    int c = channels > 1 ? 2 : 1;
    std::vector<short> ch[2], rs[2];
    long long n = rate != E->sr ? fs_resample_length(frames, rate, E->sr) : frames;
    for (int k = 0; k < c; k++) {
        ch[k].resize(frames);
        for (int i = 0; i < frames; i++) ch[k][i] = x[(long long)i * channels + k];
        if (rate != E->sr) { rs[k].resize(n); fs_resample_i16(ch[k].data(), frames, rate, rs[k].data(), E->sr); } else rs[k] = ch[k];
    }
    short *mem = fs_alloc_i16((size_t)n * c);
    for (long long i = 0; i < n; i++) for (int k = 0; k < c; k++) mem[i * c + k] = rs[k][i];
    fs_piece_rhythm_source(E->piece, h, slot, c, n, mem);
}

/* every route and where it starts, "name<TAB>lon<TAB>lat" per line: the Go to buttons */
JNIEXPORT jstring JNICALL FN(pieceRouteStarts)(JNIEnv *env, jclass) {
    std::string o;
    if (W) for (size_t i = 0; i < W->routes.size(); i++) {
        double lon, lat; fs_route_point_along(W->routes[i], 0, &lon, &lat);
        char b[64]; snprintf(b, sizeof b, "\t%.7f\t%.7f\n", lon, lat);
        o += W->route_names[i] + b;
    }
    return env->NewStringUTF(o.c_str());
}
JNIEXPORT jstring JNICALL FN(pieceRoute)(JNIEnv *env, jclass) { return env->NewStringUTF(W ? W->route_name.c_str() : ""); }
JNIEXPORT jstring JNICALL FN(pieceRhythms)(JNIEnv *env, jclass) {
    std::string o;
    if (W) for (auto &n : W->rhythm_names) o += (o.empty() ? "" : ", ") + n;
    return env->NewStringUTF(o.c_str());
}

}
