/* The two phase-3 devices: they prove each platform can build the core and hear it, nothing more.
   passthrough copies input to output; sine plays a tone with a smoothed level. */
#include "../device.hpp"
#include <cstring>

static const double TAU = 6.283185307179586;

struct Passthrough : Device {
    void prepare(float, int) override {}
    const fs_param *params(int &n) override { n = 0; return nullptr; }
    void set_param(int, float) override {}
    void process(int frames) override {
        for (int c = 0; c < FS_CHANNELS; c++)
            std::memcpy(out[c].data(), in[c].data(), sizeof(float) * frames);
    }
};

static const fs_param SINE_PARAMS[] = {
    { "freq", "Frequency", "Hz", 20.0f, 20000.0f, 440.0f },
    { "gain", "Level", "", 0.0f, 1.0f, 0.2f },
};

struct Sine : Device {
    double phase = 0, sr = 48000;
    Smoothed freq, gain;
    void prepare(float sample_rate, int) override {
        sr = sample_rate;
        freq.setup(sample_rate, 20, SINE_PARAMS[0].def);
        gain.setup(sample_rate, 20, SINE_PARAMS[1].def);
    }
    const fs_param *params(int &n) override { n = 2; return SINE_PARAMS; }
    void set_param(int i, float v) override { (i == 0 ? freq : gain).target = v; }
    void process(int frames) override {
        for (int i = 0; i < frames; i++) {
            float s = gain.next() * (float)std::sin(phase);
            phase += TAU * freq.next() / sr;
            if (phase > TAU) phase -= TAU;
            for (int c = 0; c < FS_CHANNELS; c++) out[c][i] = s;
        }
    }
};

Device *make_passthrough() { return new Passthrough(); }
Device *make_sine() { return new Sine(); }
