/* The whole walk in one object (fs_engine): the four stretch slots, the piece, the mix and its
   limiter, and the walk logic that drives them - index.html's worldMove / updateBed / ensureVoice /
   updateRhythms / pacerCheckZones / sectorUpdate / localCharacter, over the core's place functions.
   A host hands it the published features once, then positions; it answers with the recordings it
   needs (fs_engine_step's list) and takes them back decoded (fs_engine_source).

   Threads: every call from one thread - the web's AudioWorklet calls all of them from the audio
   thread, between fs_engine_process calls. (iOS and Android keep their own walk code for now.) */
#include "fieldscape.h"
#include "json.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <string>
#include <vector>

namespace {

const int SLOTS = 4;

std::string dump(const Json *j) {   /* back to text for the piece's own parser */
    if (!j) return "{}";
    switch (j->kind) {
    case Json::NUL: return "null";
    case Json::BOOL: return j->b ? "true" : "false";
    case Json::NUM: { char b[32]; std::snprintf(b, sizeof b, "%.17g", j->num); return b; }
    case Json::STR: { std::string o = "\""; for (char c : j->str) { if (c == '"' || c == '\\') o += '\\'; o += c; } return o + "\""; }
    case Json::ARR: { std::string o = "["; for (size_t i = 0; i < j->arr.size(); i++) { if (i) o += ","; o += dump(&j->arr[i]); } return o + "]"; }
    default: {
        std::string o = "{";
        for (size_t i = 0; i < j->obj.size(); i++) { if (i) o += ","; Json k; k.kind = Json::STR; k.str = j->obj[i].first; o += dump(&k) + ":" + dump(&j->obj[i].second); }
        return o + "}";
    }
    }
}
std::string esc(const std::string &s) { Json k; k.kind = Json::STR; k.str = s; return dump(&k); }

struct Point {                        /* a soundscape recording: a stretch voice */
    std::string id, name, path;
    double lon, lat, radius, gain, brightest;
    float stretch, window_s, grit, freeze, onset;
    bool sounds;
};
struct Spot { std::string icon; double lon, lat, radius, zoneR, centroid, onsets; bool audio, plain; fs_zone_state zone{}; };
struct Beat { std::string id, name; double lon, lat, radius, gain; bool grains; std::string json; std::vector<std::string> paths; };
struct Park { std::string name; std::vector<std::vector<double>> rings; double area; };
struct Slot {
    fs_device *dev = nullptr;
    std::string id;                   /* the point whose recording it holds, "" none */
    bool active = false;              /* sounding for that point now; else idle, kept VOICE_RELEASE s */
    bool loaded = false;
    float earned = 0;
    double released_at = -1e9;
    short *planar[2] = { nullptr, nullptr };
};

}

struct fs_engine {
    float sr = 48000;
    fs_mix *mix = nullptr;
    fs_device *piece = nullptr;
    Slot slot[SLOTS];
    std::vector<Point> points;
    std::vector<fs_route *> routes; std::vector<std::string> route_names;
    std::vector<Spot> spots; std::vector<Beat> beats; std::vector<Park> parks;
    std::map<std::string, int> handle;
    fs_sections *sections = nullptr;
    int park = -1; double place_lon = 1e9, place_lat = 1e9;
    long long frames = 0;
    std::string loads, state;
    std::vector<std::string> rhythm_names;
    std::string route_name;
    double now() const { return (double)frames / sr; }
};

static void free_slot_source(Slot &s) {
    fs_set_source_i16(s.dev, 0, 0, nullptr);
    for (auto &p : s.planar) { std::free(p); p = nullptr; }
}

extern "C" {

fs_engine *fs_engine_create(float sr, int max_block) {
    fs_engine *e = new fs_engine();
    e->sr = sr;
    e->mix = fs_mix_create();
    fs_mix_prepare(e->mix, sr, max_block, SLOTS + 1);
    for (int i = 0; i < SLOTS; i++) {
        e->slot[i].dev = fs_create("stretch");
        fs_set_param(e->slot[i].dev, 6, (float)(i + 1));    /* seed: each voice its own phases */
        fs_prepare(e->slot[i].dev, sr, max_block);
        fs_mix_add(e->mix, e->slot[i].dev, sr, 0);
        fs_mix_set_ramp(e->mix, i, 350);                     /* BED.fade */
    }
    e->piece = fs_create("piece");
    fs_prepare(e->piece, sr, max_block);
    fs_mix_add(e->mix, e->piece, sr, 1);
    return e;
}

void fs_engine_destroy(fs_engine *e) {
    if (!e) return;
    for (auto &s : e->slot) { free_slot_source(s); fs_destroy(s.dev); }
    fs_destroy(e->piece);
    fs_mix_destroy(e->mix);
    for (auto *r : e->routes) fs_route_destroy(r);
    if (e->sections) fs_sections_destroy(e->sections);
    delete e;
}

/* The published features (a FeatureCollection; properties carry id and kind). */
void fs_engine_features(fs_engine *e, const char *geojson) {
    Json fc = Json::parse(geojson);
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
            e->routes.push_back(r); e->route_names.push_back(p->s("name", "Route"));
            fs_piece_add_route(e->piece, dump(p->get("patch")).c_str());
        } else if (type == "Point" && c && c->size() >= 2) {
            const Json *q = p->get("sound"), *a = p->get("audio"), *hits = p->get("hits"), *px = q ? q->get("px") : nullptr;
            std::string mode = p->s("audio_mode", ""), id = p->s("id", ""), name = p->s("name", "Unnamed point");
            std::vector<std::string> slots;
            bool has_hits = false;
            for (const char *k : { "low", "mid", "high", "rand" }) {
                const Json *h = hits ? hits->get(k) : nullptr;
                std::string path = h ? h->s("storage_path", "") : "";
                has_hits |= !path.empty(); slots.push_back(path);
            }
            bool audio = p->flag("has_audio", false);
            double lon = c->at(0)->num, lat = c->at(1)->num, radius = q ? q->n("radius", 140) : 140, gain = q ? q->n("gain", 0.9) : 0.9;
            double centroid = a ? a->n("centroid_hz", 2000) : 2000;
            double fft = px ? std::max(0.0, std::min(1.0, px->n("fft", 0.7))) : 0.7;
            e->points.push_back(Point{ id, name, p->s("storage_path", ""), lon, lat, radius, gain,
                std::max(600.0, std::min(14000.0, (centroid > 0 ? centroid : 2000) * 2.2)),
                (float)(q ? q->n("stretch", 0) : 0), (float)(std::pow(2.0, std::round(7 + 10 * fft)) / e->sr),   /* pxBufsize */
                (float)(q ? q->n("grit", 0) : 0), (float)(px && px->flag("freeze", false) ? 1 : 0), (float)(px ? px->n("onset", 0) : 0),
                audio && mode != "hits" && mode != "grains" });
            e->spots.push_back({ p->s("icon", ""), lon, lat, radius, q ? q->n("zoneR", 25) : 25, a ? a->n("centroid_hz", 0) : 0,
                                 a ? a->n("onset_rate", -1) : -1, audio, !audio && !has_hits && mode != "hits" && mode != "grains" });
            if (mode == "hits" && has_hits) e->beats.push_back({ id, name, lon, lat, radius, gain, false, dump(p->get("rhythm")), slots });
            else if (mode == "grains" && audio) e->beats.push_back({ id, name, lon, lat, radius, gain, true, dump(p->get("rhythm")), { p->s("storage_path", "") } });
        }
    }
}

/* The places (places.geojson): placeAt, and the sections of the one underfoot. */
void fs_engine_places(fs_engine *e, const char *geojson) {
    Json fc = Json::parse(geojson);
    const Json *fs = fc.get("features");
    for (size_t i = 0; fs && i < fs->size(); i++) {
        const Json *f = fs->at(i), *g = f->get("geometry"), *p = f->get("properties");
        if (!g) continue;
        Park pk; pk.name = p ? p->s("name", "") : ""; pk.area = p ? p->n("area_km2", 0) : 0;
        std::string type = g->s("type", "");
        const Json *c = g->get("coordinates");
        auto ring = [&](const Json *r) { std::vector<double> v; for (size_t k = 0; r && k < r->size(); k++) { v.push_back(r->at(k)->at(0)->num); v.push_back(r->at(k)->at(1)->num); } return v; };
        if (type == "Polygon" && c && c->size()) pk.rings.push_back(ring(c->at(0)));
        else if (type == "MultiPolygon") for (size_t k = 0; c && k < c->size(); k++) if (c->at(k)->size()) pk.rings.push_back(ring(c->at(k)->at(0)));
        if (!pk.rings.empty()) e->parks.push_back(std::move(pk));
    }
}

/* One position (worldMove). Returns the recordings to fetch, one per line:
   "S <slot> <id> <path>" for a soundscape point, "R <handle> <slot> <id> <path>" for a rhythm point. */
const char *fs_engine_step(fs_engine *e, double lon, double lat) {
    e->loads.clear();
    double now = e->now();
    /* the park underfoot (placeAt, re-asked every few metres) and its sections */
    if (fs_geo_distance(e->place_lon, e->place_lat, lon, lat) >= 5) {
        e->place_lon = lon; e->place_lat = lat;
        int here = -1;
        for (int i = 0; i < (int)e->parks.size() && here < 0; i++)
            for (auto &r : e->parks[i].rings) if (fs_point_in_ring(lon, lat, r.data(), (int)r.size() / 2)) { here = i; break; }
        if (here != e->park) {
            e->park = here;
            if (e->sections) { fs_sections_destroy(e->sections); e->sections = nullptr; }
            if (here >= 0) {
                auto &pk = e->parks[here];
                std::vector<const double *> ptrs; std::vector<int> counts; size_t most = 0;
                for (auto &r : pk.rings) { ptrs.push_back(r.data()); counts.push_back((int)r.size() / 2); most = std::max(most, r.size()); }
                std::vector<double> out(most + 8); int which = 0;
                int k = fs_place_frame(ptrs.data(), counts.data(), (int)ptrs.size(), pk.area, out.data(), &which);
                if (k >= 3) e->sections = fs_sections_create(out.data(), k, fs_piece_sect_n(e->piece));
            }
            fs_piece_sector(e->piece, -1);
        }
    }
    /* the route */
    fs_projection proj{};
    int r = fs_nearest_route(e->routes.data(), (int)e->routes.size(), lon, lat, fs_piece_route(e->piece), fs_sections_hold(e->sections), &proj);
    fs_piece_walk(e->piece, r, proj.t, r >= 0 ? proj.dist : INFINITY);
    if (e->sections) {
        int cur = fs_piece_sector_now(e->piece), next = fs_sections_step(e->sections, cur, lon, lat);
        if (next != cur) fs_piece_sector(e->piece, next);
    }
    /* the soundscape points (updateBed + ensureVoice) */
    size_t np = e->points.size();
    std::vector<double> d(np), rad(np); std::vector<unsigned char> el(np); std::vector<int> picked(std::max<size_t>(np, 1));
    for (size_t i = 0; i < np; i++) { d[i] = fs_geo_distance(lon, lat, e->points[i].lon, e->points[i].lat); rad[i] = e->points[i].radius; el[i] = e->points[i].sounds; }
    int voices = std::min(SLOTS, fs_piece_bed_voices(e->piece));
    int k = fs_pick_voices(d.data(), rad.data(), el.data(), (int)np, voices, 0, picked.data());
    std::map<std::string, int> want;
    for (int i = 0; i < k; i++) want[e->points[picked[i]].id] = picked[i];
    /* a point that leaves goes idle: faded out, its recording kept VOICE_RELEASE (45 s) in case the
       walker turns back (releaseIdleVoices), then freed */
    for (int s = 0; s < SLOTS; s++) {
        Slot &sl = e->slot[s];
        if (sl.active && !want.count(sl.id)) { fs_mix_set_gain(e->mix, s, 0); sl.active = false; sl.released_at = now; }
        if (!sl.active && !sl.id.empty() && now - sl.released_at > 45) { free_slot_source(sl); sl.id.clear(); sl.loaded = false; }
    }
    for (int i = 0; i < k; i++) {
        const Point &p = e->points[picked[i]];
        int s = -1;
        for (int j = 0; j < SLOTS; j++) if (e->slot[j].id == p.id) s = j;
        if (s >= 0) e->slot[s].active = true;
        else {
            /* an empty slot, else the longest-idle one; never one still fading out (1.2 s) */
            for (int j = 0; j < SLOTS && s < 0; j++) if (e->slot[j].id.empty() && now - e->slot[j].released_at > 1.2) s = j;
            for (int j = 0; j < SLOTS; j++)
                if (s < 0 || !e->slot[s].id.empty())
                    if (!e->slot[j].active && !e->slot[j].id.empty() && now - e->slot[j].released_at > 1.2 &&
                        (s < 0 || e->slot[j].released_at < e->slot[s].released_at)) s = j;
            if (s < 0) continue;
            Slot &sl = e->slot[s];
            sl.id = p.id; sl.active = true; sl.loaded = false;
            free_slot_source(sl);
            fs_set_param(sl.dev, 0, p.stretch); fs_set_param(sl.dev, 1, p.window_s);
            fs_set_param(sl.dev, 2, p.freeze); fs_set_param(sl.dev, 3, p.onset);
            fs_mix_set_grit(e->mix, s, p.grit);
            if (!p.path.empty()) e->loads += "S " + std::to_string(s) + " " + p.id + " " + p.path + "\n";
        }
        Slot &sl = e->slot[s];
        sl.earned = (float)fs_point_gain(d[picked[i]], p.radius, p.gain);
        fs_mix_set_gain(e->mix, s, sl.loaded ? sl.earned : 0);
        fs_mix_set_lowpass(e->mix, s, (float)(300 + (p.brightest - 300) * fs_point_proximity(d[picked[i]], p.radius)), 350);
    }
    /* zones and the recordings' character */
    std::vector<double> cd, cr, cc, co;
    for (auto &sp : e->spots) {
        double dist = fs_geo_distance(lon, lat, sp.lon, sp.lat);
        if (sp.audio) { cd.push_back(dist); cr.push_back(sp.radius); cc.push_back(sp.centroid); co.push_back(sp.onsets); }
        if (dist > sp.radius * FS_ZONE_MARGIN) { sp.zone = fs_zone_state{}; continue; }
        if (fs_zone_step(&sp.zone, dist, sp.zoneR, now * 1000, FS_ZONE_MARGIN, FS_ZONE_COOLDOWN_MS) == 1 && sp.plain) fs_piece_zone(e->piece, sp.icon.c_str());
    }
    fs_piece_character(e->piece, (int)cd.size(), cd.data(), cr.data(), cc.data(), co.data());
    /* rhythm points (updateRhythms) */
    size_t nb = e->beats.size();
    std::vector<double> bd(nb), br(nb); std::vector<unsigned char> bel(nb, 1); std::vector<int> bp(std::max<size_t>(nb, 1));
    for (size_t i = 0; i < nb; i++) { bd[i] = fs_geo_distance(lon, lat, e->beats[i].lon, e->beats[i].lat); br[i] = e->beats[i].radius; }
    int kb = fs_pick_voices(bd.data(), br.data(), bel.data(), (int)nb, std::min(FS_MAX_VOICES, std::max(fs_piece_bed_voices(e->piece), 1)), 1, bp.data());
    std::map<std::string, bool> bwant;
    for (int i = 0; i < kb; i++) bwant[e->beats[bp[i]].id] = true;
    for (auto it = e->handle.begin(); it != e->handle.end();) {
        if (!bwant.count(it->first)) { fs_piece_rhythm_remove(e->piece, it->second); it = e->handle.erase(it); } else ++it;
    }
    e->rhythm_names.clear();
    for (int i = 0; i < kb; i++) {
        const Beat &b = e->beats[bp[i]];
        e->rhythm_names.push_back(b.name);
        if (!e->handle.count(b.id)) {
            int h = fs_piece_rhythm_add(e->piece, b.json.c_str(), b.grains);
            if (h < 0) continue;
            e->handle[b.id] = h;
            for (size_t s = 0; s < b.paths.size(); s++)
                if (!b.paths[s].empty()) e->loads += "R " + std::to_string(h) + " " + std::to_string(s) + " " + b.id + " " + b.paths[s] + "\n";
        }
        fs_piece_rhythm_gain(e->piece, e->handle[b.id], (float)fs_point_gain(bd[bp[i]], b.radius, b.gain));
    }
    /* what the screen shows */
    /* the route underfoot (its sound crossfades in over 1.5 s), named only within the leash */
    e->route_name = r >= 0 && r < (int)e->route_names.size() && proj.dist <= FS_GPS_LEASH ? e->route_names[r] : "";
    std::string rows;
    for (int i = 0; i < k; i++) {
        const Point &p = e->points[picked[i]];
        bool loaded = false;
        for (auto &sl : e->slot) if (sl.id == p.id && sl.active) loaded = sl.loaded;
        char b[96]; std::snprintf(b, sizeof b, ",\"level\":%.4f,\"dist\":%.1f,\"loaded\":%s}", fs_point_gain(d[picked[i]], p.radius, 1), d[picked[i]], loaded ? "true" : "false");
        rows += (rows.empty() ? "" : ",") + std::string("{\"id\":") + esc(p.id) + ",\"name\":" + esc(p.name) + b;
    }
    std::string rh;
    for (auto &n : e->rhythm_names) rh += (rh.empty() ? "" : ",") + esc(n);
    e->state = "{\"route\":" + esc(e->route_name) + ",\"place\":" + esc(e->park >= 0 ? e->parks[e->park].name : "") +
               ",\"rows\":[" + rows + "],\"rhythms\":[" + rh + "]}";
    return e->loads.c_str();
}

/* A recording the engine asked for, decoded: interleaved 16-bit at the engine's rate, in memory from
   fs_alloc_i16, which the engine then owns. kind 'S': index = slot; 'R': index = rhythm handle, sub =
   its slot. Dropped (and freed) if the point has left since. */
void fs_engine_source(fs_engine *e, int kind, int index, int sub, const char *id, int channels, long long frames, short *inter) {
    if (kind == 'S') {
        if (index < 0 || index >= SLOTS || e->slot[index].id != id || !e->slot[index].active || frames <= 0) { std::free(inter); return; }
        Slot &sl = e->slot[index];
        free_slot_source(sl);
        int c = channels > 1 ? 2 : 1;
        for (int k = 0; k < c; k++) {
            sl.planar[k] = fs_alloc_i16((size_t)frames);
            for (long long i = 0; i < frames; i++) sl.planar[k][i] = inter[i * channels + k];
        }
        std::free(inter);
        const short *ch[2] = { sl.planar[0], sl.planar[1] };
        fs_set_source_i16(sl.dev, c, (int)frames, ch);
        sl.loaded = true;
        fs_mix_set_gain(e->mix, index, sl.earned);      /* sounds now, standing still (A-15) */
    } else {
        auto it = e->handle.find(id);
        if (it == e->handle.end() || it->second != index) { std::free(inter); return; }
        fs_piece_rhythm_source(e->piece, index, sub, channels, frames, inter);   /* read with this stride; channels 0-1 */
    }
}

void fs_engine_process(fs_engine *e, int frames) { fs_mix_process(e->mix, frames); e->frames += frames; }
float *fs_engine_out(fs_engine *e, int ch) { return fs_mix_out(e->mix, ch); }
const char *fs_engine_state(fs_engine *e) { return e->state.c_str(); }

}
