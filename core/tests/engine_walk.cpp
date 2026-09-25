/* A walk through the published features with fs_engine: along the Koşuyolu route and back, every
   recording it asks for given as the same synthetic stand-in (source.wav). Prints what it asked
   for, the screen state and the output level every 10 s.
     engine_walk <features.json> <places.geojson> <source.wav> <seconds> */
#include "../fieldscape.h"
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <sstream>

static std::string slurp(const char *path) {
    FILE *f = std::fopen(path, "rb"); if (!f) return "";
    std::string s; static char buf[65536]; size_t n;
    while ((n = std::fread(buf, 1, sizeof buf, f)) > 0) s.append(buf, n);
    std::fclose(f); return s;
}
static short *read_wav(const std::string &s, int &ch, long long &frames) {
    size_t p = 12; ch = 1;
    while (p + 8 <= s.size()) {
        std::string id = s.substr(p, 4); unsigned len; std::memcpy(&len, &s[p + 4], 4);
        if (id == "fmt ") { unsigned short c; std::memcpy(&c, &s[p + 10], 2); ch = c; }
        if (id == "data") { frames = len / (2 * ch); short *o = fs_alloc_i16((size_t)frames * ch); std::memcpy(o, &s[p + 8], (size_t)frames * ch * 2); return o; }
        p += 8 + len + (len & 1);
    }
    return nullptr;
}

int main(int argc, char **argv) {
    if (argc < 5) return 1;
    const int SR = 48000, B = 128;
    std::string rows = slurp(argv[1]), wav = slurp(argv[3]);
    /* the REST rows -> a FeatureCollection with id and kind in properties, as the apps build it */
    std::string fc = "{\"type\":\"FeatureCollection\",\"features\":" + rows + "}";
    fs_engine *e = fs_engine_create(SR, B);
    fs_engine_features(e, fc.c_str());
    std::string places = slurp(argv[2]);
    fs_engine_places(e, places.c_str());
    double secs = std::atof(argv[4]);
    /* Koşuyolu's route runs 29.038879,41.00771 -> 29.039326,41.008222 and on; walk its first 300 m and back */
    double lon0 = 29.038879, lat0 = 41.00771, lon1 = 29.0412, lat1 = 41.0102;
    double sum = 0, peak = 0; long long n = 0;
    for (long long f = 0; f < (long long)(secs * SR); f += B) {
        double t = (double)f / SR;
        if (f % SR == 0) {
            double u = t / secs; u = u < 0.5 ? u * 2 : 2 - u * 2;
            const char *need = fs_engine_step(e, lon0 + (lon1 - lon0) * u, lat0 + (lat1 - lat0) * u);
            std::istringstream in(need); std::string line;
            while (std::getline(in, line)) {
                std::istringstream l(line); char kind; int a, b = 0; std::string id, path;
                l >> kind >> a; if (kind == 'R') l >> b; l >> id >> path;
                std::printf("t=%5.1f need %s\n", t, line.c_str());
                int ch; long long frames; short *pcm = read_wav(wav, ch, frames);
                fs_engine_source(e, kind, a, b, id.c_str(), ch, frames, pcm);
            }
            if ((long long)t % 10 == 0) std::printf("t=%5.1f state %s\n", t, fs_engine_state(e));
        }
        fs_engine_process(e, B);
        for (int c = 0; c < 2; c++) for (int i = 0; i < B; i++) { float v = fs_engine_out(e, c)[i]; sum += v * v; n++; peak = std::fmax(peak, std::fabs(v)); }
        if ((f + B) % (SR * 10) < B) { std::printf("t=%5.1f level %.1f dB\n", t, 10 * std::log10(sum / n + 1e-20)); sum = 0; n = 0; }
    }
    std::printf("RESULT peak %.3f\n", peak);
    fs_engine_destroy(e);
    return 0;
}
