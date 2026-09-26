/* The mix rendered ahead on its own thread into a ring, so the platform's audio callback only copies.
   A walk needs no low latency, and the phones stall now and then for reasons outside the app (iPhone 8:
   one 188-243 ms callback on the first screen lock and on a screenshot, every time; Android: 100-250 ms
   when the app leaves the foreground). With the sound computed ~350 ms ahead, a stall only drains the
   ring. Single producer (this thread), single consumer (the audio callback); nothing allocates after
   fs_player_create. */
#include "fieldscape.h"

#include <atomic>
#include <chrono>
#include <cmath>
#include <thread>
#include <vector>

#if defined(__APPLE__)
#include <mach/mach.h>
#include <mach/mach_time.h>
#include <mach/thread_policy.h>
#endif

struct fs_player {
    fs_mix *mix = nullptr;
    float sr = 48000;
    int size = 0, block = 256;               /* ring frames; frames rendered per step */
    std::vector<float> ring[2];
    std::atomic<long long> wrote{ 0 }, read{ 0 };
    std::atomic<bool> running{ false };
    std::thread th;
    void (*hook)(void *) = nullptr;           /* the host's work before each block (source handoffs) */
    void *hook_ctx = nullptr;
    std::atomic<long long> underruns{ 0 };
    std::atomic<float> worst_ms{ 0 };
};

static void raise_priority(float sr, int block) {
#if defined(__APPLE__)
    /* the time-constraint policy audio threads use: a block's worth of period */
    mach_timebase_info_data_t tb; mach_timebase_info(&tb);
    double ns_per_tick = (double)tb.numer / tb.denom;
    double period_ns = 1e9 * block / sr;
    thread_time_constraint_policy_data_t p;
    p.period = (uint32_t)(period_ns / ns_per_tick);
    p.computation = (uint32_t)(period_ns * 0.5 / ns_per_tick);
    p.constraint = (uint32_t)(period_ns / ns_per_tick);
    p.preemptible = 1;
    thread_policy_set(mach_thread_self(), THREAD_TIME_CONSTRAINT_POLICY, (thread_policy_t)&p, THREAD_TIME_CONSTRAINT_POLICY_COUNT);
#else
    (void)sr; (void)block;
#endif
}

static void run(fs_player *p) {
    raise_priority(p->sr, p->block);
    while (p->running.load()) {
        long long w = p->wrote.load(), r = p->read.load();
        if (p->size - (int)(w - r) < p->block) {           /* full: the consumer is ~350 ms behind */
            std::this_thread::sleep_for(std::chrono::milliseconds(3));
            continue;
        }
        auto t0 = std::chrono::steady_clock::now();
        if (p->hook) p->hook(p->hook_ctx);
        fs_mix_process(p->mix, p->block);
        const float *L = fs_mix_out(p->mix, 0), *R = fs_mix_out(p->mix, 1);
        for (int i = 0; i < p->block; i++) {
            int k = (int)((w + i) % p->size);
            p->ring[0][k] = L[i]; p->ring[1][k] = R[i];
        }
        p->wrote.store(w + p->block);
        float ms = std::chrono::duration<float, std::milli>(std::chrono::steady_clock::now() - t0).count();
        if (ms > p->worst_ms.load()) p->worst_ms.store(ms);
    }
}

extern "C" {

fs_player *fs_player_create(fs_mix *m, float sr, float seconds) {
    fs_player *p = new fs_player();
    p->mix = m; p->sr = sr;
    p->size = (int)(sr * seconds);
    if (p->size < 4 * p->block) p->size = 4 * p->block;
    for (auto &c : p->ring) c.assign(p->size, 0.0f);
    return p;
}

void fs_player_on_block(fs_player *p, void (*fn)(void *), void *ctx) { p->hook = fn; p->hook_ctx = ctx; }

void fs_player_start(fs_player *p) {
    if (p->running.exchange(true)) return;
    p->th = std::thread(run, p);
}

void fs_player_stop(fs_player *p) {
    if (!p->running.exchange(false)) return;
    if (p->th.joinable()) p->th.join();
}

void fs_player_destroy(fs_player *p) { if (!p) return; fs_player_stop(p); delete p; }

/* From the audio callback: copies `frames` into L/R; what the ring cannot give is silence and counts
   as an underrun. Returns the frames it had. */
int fs_player_read(fs_player *p, float *L, float *R, int frames) {
    long long r = p->read.load(), w = p->wrote.load();
    int have = (int)(w - r); if (have > frames) have = frames;
    for (int i = 0; i < have; i++) { int k = (int)((r + i) % p->size); L[i] = p->ring[0][k]; R[i] = p->ring[1][k]; }
    for (int i = have; i < frames; i++) L[i] = R[i] = 0;
    if (have < frames && p->running.load()) p->underruns.fetch_add(1);
    p->read.store(r + have);
    return have;
}

void fs_player_stats(fs_player *p, long long *underruns, float *worst_block_ms, float *ahead_ms) {
    *underruns = p->underruns.load();
    *worst_block_ms = p->worst_ms.load();
    *ahead_ms = 1000.0f * (float)(p->wrote.load() - p->read.load()) / p->sr;
}

}
