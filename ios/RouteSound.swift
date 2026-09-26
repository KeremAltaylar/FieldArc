// The piece's side of the walk (core/piece.cpp): which route and how far along it, the section
// underfoot, the plain points' zones, the character of the recordings in reach, and the rhythm
// points. index.html's worldMove, sectorUpdate, pacerCheckZones, localCharacter and updateRhythms,
// over the core's place functions; the piece makes every sound choice itself.
import Foundation

final class RouteSound {
    private struct Spot {
        let icon: String, lon: Double, lat: Double, radius: Double, zoneR: Double
        let centroid: Double, onsets: Double, audio: Bool, plain: Bool
        var zone = fs_zone_state()
    }
    private struct Beat { let id: String, name: String, lon: Double, lat: Double, radius: Double, gain: Double, grains: Bool, json: String, paths: [String?] }

    private let core: Core
    private var piece: OpaquePointer { core.piece }
    private var routes: [OpaquePointer?] = []
    private var routeNames: [String] = []
    private var spots: [Spot] = []
    private var beats: [Beat] = []
    private var handle: [String: Int32] = [:]          /* rhythm point id -> the piece's handle */
    private var sections: OpaquePointer? = nil
    private let t0 = Date()
    /* what the walk panel shows */
    private(set) var routeName: String? = nil
    /* every route and where it starts: the panel's Go to buttons */
    private(set) var routeStarts: [(name: String, lon: Double, lat: Double)] = []
    private(set) var rhythmNames: [String] = []

    init(core: Core) { self.core = core }
    deinit { routes.forEach { fs_route_destroy($0) }; if let s = sections { fs_sections_destroy(s) } }

    func start(features: [[String: Any]]) {
        for f in features {
            guard let g = f["geometry"] as? [String: Any], let p = f["properties"] as? [String: Any] else { continue }
            if g["type"] as? String == "LineString", p["kind"] as? String == "route",
               let c = g["coordinates"] as? [[Double]], !c.isEmpty {
                var flat = c.flatMap { [$0[0], $0[1]] }
                guard let r = fs_route_create(&flat, Int32(c.count)), fs_route_length(r) > 0 else { continue }
                routes.append(r)
                routeNames.append(p["name"] as? String ?? "Route")
                routeStarts.append((p["name"] as? String ?? "Route", c[0][0], c[0][1]))
                _ = fs_piece_add_route(piece, RouteSound.json(p["patch"]))
            } else if g["type"] as? String == "Point", let c = g["coordinates"] as? [Double], c.count >= 2 {
                let q = p["sound"] as? [String: Any] ?? [:], a = p["audio"] as? [String: Any] ?? [:]
                let mode = p["audio_mode"] as? String
                let hits = p["hits"] as? [String: Any] ?? [:]
                let slots = ["low", "mid", "high", "rand"].map { ((hits[$0] as? [String: Any])?["storage_path"] as? String) }
                let hasHits = slots.contains { $0 != nil }
                let hasAudio = p["has_audio"] as? Bool ?? false
                let radius = (q["radius"] as? Double) ?? 140, gain = (q["gain"] as? Double) ?? 0.9
                spots.append(Spot(icon: p["icon"] as? String ?? "", lon: c[0], lat: c[1], radius: radius, zoneR: (q["zoneR"] as? Double) ?? 25,
                                  centroid: (a["centroid_hz"] as? Double) ?? 0, onsets: (a["onset_rate"] as? Double) ?? -1,
                                  audio: hasAudio, plain: !hasAudio && !hasHits && mode != "hits" && mode != "grains"))
                let id = p["id"] as? String ?? UUID().uuidString, name = p["name"] as? String ?? "Unnamed point"
                if mode == "hits" && hasHits {
                    beats.append(Beat(id: id, name: name, lon: c[0], lat: c[1], radius: radius, gain: gain, grains: false, json: RouteSound.json(p["rhythm"]), paths: slots))
                } else if mode == "grains" && hasAudio {
                    beats.append(Beat(id: id, name: name, lon: c[0], lat: c[1], radius: radius, gain: gain, grains: true, json: RouteSound.json(p["rhythm"]), paths: [p["storage_path"] as? String]))
                }
            }
        }
    }

    /* How many soundscape points the playing patch lets sound (bed.on / bed.voices). */
    var bedVoices: Int { Int(fs_piece_bed_voices(piece)) }

    /* The park underfoot changed: its sections, with the playing patch's count (sectorGeometry). */
    func placeChanged(rings: [[Double]]?, area: Double) {
        if let s = sections { fs_sections_destroy(s); sections = nil }
        if let rings, !rings.isEmpty {
            let n = rings.map { $0.count / 2 }
            var out = [Double](repeating: 0, count: (n.max() ?? 0) * 2 + 8), which: Int32 = 0
            let k = withPtrs(rings) { fs_place_frame($0, n.map { Int32($0) }, Int32(rings.count), area, &out, &which) }
            if k >= 3 { sections = fs_sections_create(out, k, fs_piece_sect_n(piece)) }
        }
        fs_piece_sector(piece, -1)
    }

    /* One position (worldMove). */
    func step(lon: Double, lat: Double) {
        /* the route: the nearest, held by sectorHold's margin */
        var proj = fs_projection()
        let r = fs_nearest_route(routes, Int32(routes.count), lon, lat, fs_piece_route(piece), fs_sections_hold(sections), &proj)
        fs_piece_walk(piece, r, proj.t, r >= 0 ? proj.dist : .infinity)
        /* the route underfoot (its sound crossfades in over 1.5 s), named only within the leash */
        routeName = r >= 0 && Int(r) < routeNames.count && proj.dist <= Double(FS_GPS_LEASH) ? routeNames[Int(r)] : nil

        /* the section underfoot (sectorUpdate) */
        if let s = sections {
            let cur = fs_piece_sector_now(piece), next = fs_sections_step(s, cur, lon, lat)
            if next != cur { fs_piece_sector(piece, next) }
        }

        /* zones (zonesNear + pacerCheckZones): a plain point speaks as you enter it */
        let now = Date().timeIntervalSince(t0) * 1000
        var dist = [Double](), radius = [Double](), centroid = [Double](), onsets = [Double]()
        for i in spots.indices {
            let d = fs_geo_distance(lon, lat, spots[i].lon, spots[i].lat)
            if spots[i].audio { dist.append(d); radius.append(spots[i].radius); centroid.append(spots[i].centroid); onsets.append(spots[i].onsets) }
            if d > spots[i].radius * Double(FS_ZONE_MARGIN) { spots[i].zone = fs_zone_state(); continue }
            if fs_zone_step(&spots[i].zone, d, spots[i].zoneR, now, Double(FS_ZONE_MARGIN), Double(FS_ZONE_COOLDOWN_MS)) == 1 && spots[i].plain {
                fs_piece_zone(piece, spots[i].icon)
            }
        }
        fs_piece_character(piece, Int32(dist.count), dist, radius, centroid, onsets)

        /* rhythm points (updateRhythms): within their radius, the nearest few */
        var bd = beats.map { fs_geo_distance(lon, lat, $0.lon, $0.lat) }
        var br = beats.map { $0.radius }
        var el = [UInt8](repeating: 1, count: beats.count)
        var picked = [Int32](repeating: 0, count: max(beats.count, 1))
        let k = Int(fs_pick_voices(&bd, &br, &el, Int32(beats.count), Int32(min(Int(FS_MAX_VOICES), max(bedVoices, 1))), 1, &picked))
        let want = Set(picked.prefix(k).map { beats[Int($0)].id })
        for (id, h) in handle where !want.contains(id) { fs_piece_rhythm_remove(piece, h); handle[id] = nil }
        for j in picked.prefix(k).map({ Int($0) }) {
            let b = beats[j]
            if handle[b.id] == nil {
                let h = fs_piece_rhythm_add(piece, b.json, b.grains ? 1 : 0)
                if h < 0 { continue }
                handle[b.id] = h
                load(b, h)
            }
            if let h = handle[b.id] { fs_piece_rhythm_gain(piece, h, Float(fs_point_gain(bd[j], b.radius, b.gain))) }
        }
        rhythmNames = picked.prefix(k).map { beats[Int($0)].name }
    }

    /* Each recording of a rhythm point: fetched and cached as the soundscape's are, decoded at the
       engine's rate, handed to the piece as interleaved 16-bit (it owns and frees the memory). */
    private func load(_ b: Beat, _ h: Int32) {
        let sr = core.sampleRate
        for (slot, path) in b.paths.enumerated() {
            guard let path else { continue }
            Task { @MainActor [weak self] in
                guard let walk = self?.walk, let data = try? await walk.recording(path, for: b.id + "#\(slot)") else { return }
                /* interleaved 16-bit off the main thread; copied into the piece's own memory here */
                guard let pcm = try? await Decode.pcm16(data, sampleRate: sr) else { return }
                guard let self, pcm.frames > 0, self.handle[b.id] == h else { pcm.free(); return }
                /* interleaved into the piece's own memory (it frees it), the planar copy let go at once */
                let c = pcm.planar.count, n = pcm.frames
                let mem = fs_alloc_i16(n * c)!
                for k in 0..<c { let src = pcm.planar[k]; for i in 0..<n { mem[i * c + k] = src[i] } }
                pcm.free()
                fs_piece_rhythm_source(self.piece, h, Int32(slot), Int32(c), Int64(n), mem)
            }
        }
    }

    weak var walk: Walk?

    private static func json(_ v: Any?) -> String {
        guard let v, JSONSerialization.isValidJSONObject(v), let d = try? JSONSerialization.data(withJSONObject: v) else { return "{}" }
        return String(data: d, encoding: .utf8) ?? "{}"
    }

    private func withPtrs<R>(_ rings: [[Double]], _ body: ([UnsafePointer<Double>?]) -> R) -> R {
        let bufs = rings.map { r -> UnsafeMutablePointer<Double> in
            let p = UnsafeMutablePointer<Double>.allocate(capacity: max(r.count, 1)); p.initialize(from: r, count: r.count); return p
        }
        defer { bufs.forEach { $0.deallocate() } }
        return body(bufs.map { UnsafePointer($0) })
    }
}
