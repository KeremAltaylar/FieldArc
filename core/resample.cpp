/* Sample-rate conversion for a whole recording, once, at load: the host's job by the stretch spec
   (the device never resamples). iOS has AVAudioConverter; Android has no resampler in its SDK, so
   the core carries one: windowed sinc, 32 taps a side, a Blackman-Harris window, cutoff at the
   lower of the two Nyquists (x 0.95) so downsampling does not alias. 16-bit in, 16-bit out. */
#include "fieldscape.h"

#include <cmath>
#include <vector>

extern "C" long long fs_resample_length(long long frames, double from_rate, double to_rate) {
    return (long long)std::floor((double)frames * to_rate / from_rate);
}

extern "C" void fs_resample_i16(const short *in, long long frames, double from_rate, short *out, double to_rate) {
    const int TAPS = 32;
    const double PI = 3.141592653589793;
    const double step = from_rate / to_rate;                          /* input samples per output sample */
    const double fc = 0.95 * std::min(1.0, to_rate / from_rate);     /* cutoff, as a fraction of input Nyquist */
    const long long n_out = fs_resample_length(frames, from_rate, to_rate);
    auto window = [&](double x) {                                    /* Blackman-Harris over [-TAPS, TAPS] */
        double t = (x + TAPS) / (2.0 * TAPS);
        if (t < 0 || t > 1) return 0.0;
        return 0.35875 - 0.48829 * std::cos(2 * PI * t) + 0.14128 * std::cos(4 * PI * t) - 0.01168 * std::cos(6 * PI * t);
    };
    for (long long j = 0; j < n_out; j++) {
        const double pos = j * step;
        const long long c = (long long)std::floor(pos);
        const double frac = pos - c;
        double acc = 0, norm = 0;
        for (int k = -TAPS + 1; k <= TAPS; k++) {
            const double x = k - frac;                               /* distance from the ideal position, input samples */
            const double arg = PI * fc * x;
            const double h = fc * (x == 0 ? 1.0 : std::sin(arg) / arg) * window(x);
            norm += h;
            const long long idx = c + k;
            if (idx >= 0 && idx < frames) acc += h * in[idx];
        }
        double v = norm != 0 ? acc / norm : 0;
        v = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
        out[j] = (short)std::lround(v);
    }
}
