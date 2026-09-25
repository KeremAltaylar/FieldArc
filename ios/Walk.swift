// The walk: GPS -> the core's place layer -> which points sound, how loud -> recordings fetched,
// cached, decoded into the Core's slots. The same rules as the web's open world, from the C++ the
// parity test holds to index.html: points by their own radius, prox^1.5 x gain, the nearest four
// soundscape points (updateBed's order), a fix worse than 40 m holds the walk where it was.
import CoreLocation
import Foundation

final class Walk: NSObject, ObservableObject, CLLocationManagerDelegate {
    struct Point {
        let id: String, name: String, lon: Double, lat: Double
        let radius: Double, gain: Double, stretch: Float, windowSamples: Double
        let path: String?, sounds: Bool
    }
    @Published var status = "Walk: waiting for location"
    private let core: Core
    private let loc = CLLocationManager()
    private var points: [Point] = []
    private var slotOf: [String: Int] = [:]          /* point id -> slot */
    private var loaded: Set<String> = []
    private var releasedAt: [Int: Date] = [:]         /* slot -> when its point left (fade before reuse) */
    private let log: URL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("walk.log")

    init(core: Core) {
        self.core = core
        super.init()
        loc.delegate = self
        loc.desiredAccuracy = kCLLocationAccuracyBest
        loc.distanceFilter = 2
    }

    func start(features: [String: Any]) {
        points = ((features["features"] as? [[String: Any]]) ?? []).compactMap { f in
            guard let g = f["geometry"] as? [String: Any], g["type"] as? String == "Point",
                  let c = g["coordinates"] as? [Double], c.count >= 2,
                  let p = f["properties"] as? [String: Any] else { return nil }
            let q = p["sound"] as? [String: Any] ?? [:], px = q["px"] as? [String: Any] ?? [:]
            let mode = p["audio_mode"] as? String
            let fft = (px["fft"] as? Double) ?? 0.7                          /* pxDefaults */
            return Point(id: p["id"] as? String ?? UUID().uuidString, name: p["name"] as? String ?? "point",
                         lon: c[0], lat: c[1], radius: (q["radius"] as? Double) ?? 140, gain: (q["gain"] as? Double) ?? 0.9,
                         stretch: Float((q["stretch"] as? Double) ?? 0),
                         windowSamples: pow(2, (7 + 10 * max(0, min(1, fft))).rounded()),   /* pxBufsize */
                         path: p["storage_path"] as? String,
                         sounds: (p["has_audio"] as? Bool ?? false) && mode != "hits" && mode != "grains")
        }
        loc.requestWhenInUseAuthorization()
        loc.startUpdatingLocation()
    }

    func locationManager(_ m: CLLocationManager, didChangeAuthorization s: CLAuthorizationStatus) {
        if s == .denied || s == .restricted { status = "Walk: location is off for Fieldscape (Settings → Privacy)" }
    }

    func locationManager(_ m: CLLocationManager, didUpdateLocations locs: [CLLocation]) {
        guard let l = locs.last else { return }
        if l.horizontalAccuracy < 0 || l.horizontalAccuracy > Double(FS_GPS_ACC_MAX) {
            status = String(format: "Walk: holding · fix ±%.0f m", l.horizontalAccuracy); return
        }
        step(lon: l.coordinate.longitude, lat: l.coordinate.latitude, acc: l.horizontalAccuracy)
    }

    /* One position through the place layer. */
    func step(lon: Double, lat: Double, acc: Double) {
        let n = points.count
        var dist = points.map { fs_geo_distance(lon, lat, $0.lon, $0.lat) }
        var radius = points.map { $0.radius }
        var eligible = points.map { UInt8($0.sounds ? 1 : 0) }
        var picked = [Int32](repeating: 0, count: max(n, 1))
        let k = Int(fs_pick_voices(&dist, &radius, &eligible, Int32(n), Int32(Core.slots - (core.test ? 1 : 0)), 0, &picked))
        let want = Set(picked.prefix(k).map { points[Int($0)].id })

        for (id, slot) in slotOf where !want.contains(id) {               /* left: fade, free after the ramp */
            core.gain(slot: slot, 0)
            slotOf[id] = nil; loaded.remove(id); releasedAt[slot] = Date()
        }
        for j in picked.prefix(k).map({ Int($0) }) {
            let p = points[j]
            if slotOf[p.id] == nil, let slot = freeSlot() { slotOf[p.id] = slot; begin(p, slot: slot) }
            guard let slot = slotOf[p.id] else { continue }
            core.gain(slot: slot, loaded.contains(p.id) ? Float(fs_point_gain(dist[j], p.radius, p.gain)) : 0)
        }
        let heard = picked.prefix(k).map { j -> String in
            let p = points[Int(j)]
            return String(format: "%@ %.0f%%%@", p.name, 100 * fs_point_gain(dist[Int(j)], p.radius, p.gain) / max(p.gain, 0.001),
                          loaded.contains(p.id) ? "" : " (loading)")
        }
        status = String(format: "Walk ±%.0f m · ", acc) + (heard.isEmpty ? "no point in range" : heard.joined(separator: ", "))
        append(String(format: "%.6f %.6f %.0f out %.1f dBFS | %@", lon, lat, acc, core.outputDb, heard.joined(separator: ", ")))
    }

    private func freeSlot() -> Int? {
        let used = Set(slotOf.values)
        return (0..<Core.slots).first { s in
            !used.contains(s) && !(core.test && s == 0) && (releasedAt[s].map { Date().timeIntervalSince($0) > 1.2 } ?? true)
        }
    }

    /* The point's own settings, then its recording: cache, else download, decode, hand over. */
    private func begin(_ p: Point, slot: Int) {
        core.param(slot: slot, 0, p.stretch)
        core.param(slot: slot, 1, Float(p.windowSamples / core.sampleRate))
        guard let path = p.path else { return }
        let sr = core.sampleRate
        Task.detached(priority: .userInitiated) { [weak self] in
            do {
                let data = try await Walk.recording(path)
                var ch = try Decode.pcm(data, sampleRate: sr)
                /* ponytail: 3 minutes kept per voice (~69 MB stereo float) so four fit an iPhone 8;
                   the full file needs a compact (int16) source format in the core. */
                let cap = Int(180 * sr)
                if (ch.first?.count ?? 0) > cap { ch = ch.map { Array($0.prefix(cap)) } }
                let decoded = ch
                await MainActor.run { [weak self] in
                    guard let self, self.slotOf[p.id] == slot else { return }
                    self.core.load(slot: slot, channels: decoded)
                    self.loaded.insert(p.id)
                }
            } catch {
                let why = error.localizedDescription
                await MainActor.run { [weak self] in self?.status = "Walk: could not load \(p.name): \(why)" }
            }
        }
    }

    /* Downloaded once, kept in Caches (the web keeps them in IndexedDB the same way). */
    static func recording(_ path: String) async throws -> Data {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("recordings")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent(path.replacingOccurrences(of: "/", with: "__"))
        if let d = try? Data(contentsOf: file) { return d }
        var req = URLRequest(url: URL(string: Supa.url + "/storage/v1/object/authenticated/recordings/" + path)!)
        req.setValue(Supa.anon, forHTTPHeaderField: "apikey")
        req.setValue("Bearer " + Supa.anon, forHTTPHeaderField: "Authorization")
        let (d, r) = try await URLSession.shared.data(for: req)
        guard (r as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
        try d.write(to: file)
        return d
    }

    private func append(_ line: String) {
        let s = ISO8601DateFormatter().string(from: Date()) + " " + line + "\n"
        if let h = try? FileHandle(forWritingTo: log) { h.seekToEndOfFile(); h.write(s.data(using: .utf8)!); try? h.close() }
        else { try? s.data(using: .utf8)!.write(to: log) }
    }
}
