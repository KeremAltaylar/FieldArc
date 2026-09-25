/* WebM (Matroska) demuxing for Opus audio, just enough to hand the packets to a platform's own
   Opus decoder. iOS decodes Opus but cannot open the WebM container browsers record into (and
   the publish step shrinks big recordings into); Android and browsers read WebM themselves.

   Reads the first A_OPUS track: channels and pre-skip from its OpusHead (CodecPrivate), then every
   SimpleBlock/Block of that track in file order. Handles the unknown-size Segment and Cluster
   that browsers' MediaRecorder writes. Laced blocks are refused rather than mis-split: no
   recorder in use writes them. */
#include "fieldscape.h"

#include <cstring>

namespace {

struct Reader {
    const unsigned char *b; size_t n;
    int track = -1, channels = 0, pre_skip = 0;
    int count = 0, max = 0, error = 0;
    long long samples = 0;
    unsigned *offsets = nullptr, *sizes = nullptr;

    /* EBML variable-length integer at p: value and length; keep_marker for element IDs. */
    bool vint(size_t p, bool keep_marker, unsigned long long &v, int &len) {
        if (p >= n) return false;
        unsigned char f = b[p]; len = 1;
        while (len <= 8 && !(f & (0x80 >> (len - 1)))) len++;
        if (len > 8 || p + len > n) return false;
        v = keep_marker ? f : (f & ((0x80 >> (len - 1)) - 1));
        for (int i = 1; i < len; i++) v = (v << 8) | b[p + i];
        return true;
    }
    unsigned long long uint_at(size_t p, size_t s) {
        unsigned long long v = 0;
        for (size_t i = 0; i < s && i < 8; i++) v = (v << 8) | b[p + i];
        return v;
    }

    void block(size_t p, size_t s) {
        unsigned long long tn; int l;
        if (!vint(p, false, tn, l) || s < (size_t)l + 3) return;
        if ((int)tn != track) return;
        unsigned char flags = b[p + l + 2];
        if (flags & 0x06) { error = -3; return; }           /* lacing */
        size_t off = p + l + 3, len = s - (l + 3);
        samples += opus_samples(b + off, len);
        if (count < max) { offsets[count] = (unsigned)off; sizes[count] = (unsigned)len; }
        count++;
    }

    /* Samples at 48 kHz in one Opus packet, from its TOC byte (RFC 6716 3.1). */
    static long long opus_samples(const unsigned char *p, size_t len) {
        if (!len) return 0;
        static const int silk[4] = { 480, 960, 1920, 2880 }, celt[4] = { 120, 240, 480, 960 };
        const int config = p[0] >> 3;
        const int per = config < 12 ? silk[config & 3]                   /* SILK 10-60 ms */
                      : config < 16 ? ((config & 1) ? 960 : 480)          /* hybrid 10/20 ms */
                      : celt[config & 3];                                 /* CELT 2.5-20 ms; samples per frame at 48 kHz */
        int frames = (p[0] & 3) == 0 ? 1 : (p[0] & 3) < 3 ? 2 : (len > 1 ? (p[1] & 0x3F) : 0);
        return (long long)per * frames;
    }

    void track_entry(size_t p, size_t end) {
        int number = -1; bool opus = false; size_t priv = 0, priv_len = 0;
        while (p < end) {
            unsigned long long id, s; int a, c;
            if (!vint(p, true, id, a) || !vint(p + a, false, s, c)) return;
            size_t d = p + a + c;
            if (d + s > end) return;
            if (id == 0xD7) number = (int)uint_at(d, s);
            else if (id == 0x86) opus = s == 6 && !std::memcmp(b + d, "A_OPUS", 6);
            else if (id == 0x63A2) { priv = d; priv_len = s; }
            p = d + s;
        }
        if (opus && track < 0 && priv_len >= 19 && !std::memcmp(b + priv, "OpusHead", 8)) {
            track = number;
            channels = b[priv + 9];
            pre_skip = b[priv + 10] | (b[priv + 11] << 8);
        }
    }

    /* Walk elements in [p, end); masters are entered, an unknown size runs to `end`. */
    void walk(size_t p, size_t end) {
        while (p < end && !error) {
            unsigned long long id, s; int a, c;
            if (!vint(p, true, id, a) || !vint(p + a, false, s, c)) return;
            size_t d = p + a + c;
            bool unknown = s == (1ULL << (7 * c)) - 1;
            size_t e = unknown || d + s > end ? end : d + s;
            switch (id) {
            case 0x18538067: case 0x1654AE6B: case 0x1F43B675: case 0xA0:   /* Segment Tracks Cluster BlockGroup */
                walk(d, e);
                break;
            case 0xAE: track_entry(d, e); break;
            case 0xA3: case 0xA1: block(d, e - d); break;                    /* SimpleBlock, Block */
            default: break;
            }
            if (unknown) return;
            p = e;
        }
    }
};

}

extern "C" int fs_opus_packet_samples(const unsigned char *packet, size_t len) { return (int)Reader::opus_samples(packet, len); }

extern "C" int fs_webm_opus(const unsigned char *data, size_t n, fs_webm_info *info,
                            unsigned *offsets, unsigned *sizes, int max) {
    if (n < 4 || data[0] != 0x1A || data[1] != 0x45 || data[2] != 0xDF || data[3] != 0xA3) return -1;
    Reader r{ data, n };
    r.offsets = offsets; r.sizes = sizes; r.max = max;
    r.walk(0, n);
    if (r.error) return r.error;
    if (r.track < 0) return -2;
    info->channels = r.channels;
    info->pre_skip = r.pre_skip;
    info->sample_rate = 48000;                 /* Opus always decodes at 48 kHz */
    info->total_samples = r.samples;
    return r.count;
}
