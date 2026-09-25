// The walk: GPS -> the core's place layer -> which points sound, how loud -> recordings fetched,
// cached, decoded into the Core's slots. The same rules as the web's open world, from the C++ the
// parity tests hold to index.html: points by their own radius, prox^1.5 x gain, the four nearest
// soundscape points (updateBed's order), placeAt for the park underfoot, and a fix worse than
// 40 m holds the walk where it was (A-15). It publishes what the walk screen shows.
import CoreLocation
import Foundation

final class Walk: NSObject, ObservableObject, CLLocationManagerDelegate {
    struct Point {
        let id: String, name: String, lon: Double, lat: Double
        let radius: Double, gain: Double, stretch: Float, windowSamples: Double
        let path: String?, sounds: Bool
    }
    enum Phase: Equatable { case playing, downloading(fraction: Double, bytes: Int64), decoding }
    struct Row: Identifiable, Equatable { let id: String, name: String; let level: Double, dist: Double; let phase: Phase }
    enum Mode: Equatable { case waiting, denied, live(accuracy: Double), holding(accuracy: Double) }

    @Published var mode = Mode.waiting
    @Published var rows: [Row] = []
    @Published var place: String? = nil
    @Published var nearest: (name: String, dist: Double, direction: String)? = nil
    @Published var failure: String? = nil

    private let core: Core
    private let loc = CLLocationManager()
    private var points: [Point] = []
    private var slotOf: [String: Int] = [:]           /* point id -> slot */
    private var phase: [String: Phase] = [:] { didSet { refreshRows() } }   /* points still arriving */
    private var loaded: Set<String> = [] { didSet { refreshRows() } }
    private var releasedAt: [Int: Date] = [:]          /* slot -> when its point left (fade before reuse) */
    private var parks: [(name: String, rings: [[Double]])] = []
    private var placeCheckedAt: (Double, Double)? = nil
    private let log: URL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("walk.log")

    init(core: Core) {
        self.core = core
        super.init()
        loc.delegate = self
        loc.desiredAccuracy = kCLLocationAccuracyBest
        loc.distanceFilter = 2
        loadParks()
    }

    func start(features: [String: Any]) {
        points = ((features["features"] as? [[String: Any]]) ?? []).compactMap { f in
            guard let g = f["geometry"] as? [String: Any], g["type"] as? String == "Point",
                  let c = g["coordinates"] as? [Double], c.count >= 2,
                  let p = f["properties"] as? [String: Any] else { return nil }
            let q = p["sound"] as? [String: Any] ?? [:], px = q["px"] as? [String: Any] ?? [:]
            let mode = p["audio_mode"] as? String
            let fft = (px["fft"] as? Double) ?? 0.7                          /* pxDefaults */
            return Point(id: p["id"] as? String ?? UUID().uuidString, name: p["name"] as? String ?? "Unnamed point",
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
        if s == .denied || s == .restricted { mode = .denied }
        else if mode == .denied { mode = .waiting; loc.startUpdatingLocation() }
    }

    func locationManager(_ m: CLLocationManager, didUpdateLocations locs: [CLLocation]) {
        guard let l = locs.last, l.horizontalAccuracy >= 0 else { return }
        if l.horizontalAccuracy > Double(FS_GPS_ACC_MAX) { mode = .holding(accuracy: l.horizontalAccuracy); return }
        mode = .live(accuracy: l.horizontalAccuracy)
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
        let chosen = picked.prefix(k).map { Int($0) }
        let want = Set(chosen.map { points[$0].id })

        for (id, slot) in slotOf where !want.contains(id) {                /* left: fade, free after the ramp */
            core.gain(slot: slot, 0)
            slotOf[id] = nil; loaded.remove(id); phase[id] = nil; releasedAt[slot] = Date()
        }
        for j in chosen {
            let p = points[j]
            if slotOf[p.id] == nil, let slot = freeSlot() { slotOf[p.id] = slot; begin(p, slot: slot) }
            guard let slot = slotOf[p.id] else { continue }
            core.gain(slot: slot, loaded.contains(p.id) ? Float(fs_point_gain(dist[j], p.radius, p.gain)) : 0)
        }
        rows = chosen.map { j in
            let p = points[j]
            return Row(id: p.id, name: p.name, level: fs_point_gain(dist[j], p.radius, 1), dist: dist[j],
                       phase: loaded.contains(p.id) ? .playing : (phase[p.id] ?? .decoding))
        }
        if rows.isEmpty, let j = (0..<n).filter({ points[$0].sounds }).min(by: { dist[$0] < dist[$1] }) {
            nearest = (points[j].name, dist[j], Walk.direction(lon, lat, points[j].lon, points[j].lat))
        } else { nearest = nil }
        updatePlace(lon: lon, lat: lat)
        append(String(format: "%.6f %.6f %.0f out %.1f dBFS | %@", lon, lat, acc, core.outputDb,
                      rows.map { String(format: "%@ %.0f%%", $0.name, $0.level * 100) }.joined(separator: ", ")))
    }

    /* Progress between fixes: a download moves while the walker stands still. */
    private func refreshRows() {
        rows = rows.map { r in Row(id: r.id, name: r.name, level: r.level, dist: r.dist,
                                   phase: loaded.contains(r.id) ? .playing : (phase[r.id] ?? .decoding)) }
    }

    /* The park underfoot (placeAt), re-asked only after a few metres (the web's PLACE_CHECK_M). */
    private func updatePlace(lon: Double, lat: Double) {
        if let c = placeCheckedAt, fs_geo_distance(c.0, c.1, lon, lat) < 5 { return }
        placeCheckedAt = (lon, lat)
        place = parks.first { park in park.rings.contains { r in r.withUnsafeBufferPointer { fs_point_in_ring(lon, lat, $0.baseAddress, Int32(r.count / 2)) != 0 } } }?.name
    }

    private func loadParks() {
        guard let url = Bundle.main.url(forResource: "places", withExtension: "geojson"),
              let data = try? Data(contentsOf: url),
              let fc = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        for f in (fc["features"] as? [[String: Any]]) ?? [] {
            guard let g = f["geometry"] as? [String: Any], let polys = g["coordinates"] as? [[[[Double]]]] else { continue }
            let rings = polys.compactMap { $0.first?.flatMap { $0 } }
            parks.append(((f["properties"] as? [String: Any])?["name"] as? String ?? "", rings))
        }
    }

    static func direction(_ lon1: Double, _ lat1: Double, _ lon2: Double, _ lat2: Double) -> String {
        let r = Double.pi / 180
        let y = sin((lon2 - lon1) * r) * cos(lat2 * r)
        let x = cos(lat1 * r) * sin(lat2 * r) - sin(lat1 * r) * cos(lat2 * r) * cos((lon2 - lon1) * r)
        let deg = (atan2(y, x) / r + 360).truncatingRemainder(dividingBy: 360)
        return ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][Int((deg + 22.5) / 45) % 8]
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
        Task { @MainActor [weak self] in
            do {
                guard let data = try await self?.recording(path, for: p.id) else { return }
                self?.phase[p.id] = .decoding
                let decoded = try await Task.detached(priority: .userInitiated) { () -> [[Float]] in
                    var ch = try Decode.pcm(data, sampleRate: sr)
                    /* ponytail: 3 minutes kept per voice (~69 MB stereo float) so four fit an iPhone 8;
                       the full file needs a compact (int16) source format in the core. */
                    let cap = Int(180 * sr)
                    if (ch.first?.count ?? 0) > cap { ch = ch.map { Array($0.prefix(cap)) } }
                    return ch
                }.value
                guard let self, self.slotOf[p.id] == slot else { return }
                self.core.load(slot: slot, channels: decoded)
                self.loaded.insert(p.id)
                self.phase[p.id] = nil
            } catch {
                self?.failure = "Could not load \(p.name): \(error.localizedDescription)"
                self?.phase[p.id] = nil
            }
        }
    }

    /* Downloaded once, kept in Caches (the web keeps them in IndexedDB the same way); progress
       is reported so the screen can say what is arriving. */
    @MainActor private func recording(_ path: String, for id: String) async throws -> Data {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("recordings")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent(path.replacingOccurrences(of: "/", with: "__"))
        if let d = try? Data(contentsOf: file) { return d }
        var req = URLRequest(url: URL(string: Supa.url + "/storage/v1/object/authenticated/recordings/" + path)!)
        req.setValue(Supa.anon, forHTTPHeaderField: "apikey")
        req.setValue("Bearer " + Supa.anon, forHTTPHeaderField: "Authorization")
        phase[id] = .downloading(fraction: 0, bytes: 0)
        return try await withCheckedThrowingContinuation { cont in
            var watch: NSKeyValueObservation?
            let task = URLSession.shared.downloadTask(with: req) { tmp, resp, err in
                watch?.invalidate()
                guard let tmp, (resp as? HTTPURLResponse)?.statusCode == 200 else {
                    cont.resume(throwing: err ?? URLError(.badServerResponse)); return
                }
                do { try? FileManager.default.removeItem(at: file); try FileManager.default.moveItem(at: tmp, to: file)
                     cont.resume(returning: try Data(contentsOf: file)) } catch { cont.resume(throwing: error) }
            }
            watch = task.progress.observe(\.fractionCompleted) { [weak self, weak task] pr, _ in
                let bytes = task?.countOfBytesExpectedToReceive ?? 0
                DispatchQueue.main.async { self?.phase[id] = .downloading(fraction: pr.fractionCompleted, bytes: bytes) }
            }
            task.resume()
        }
    }

    private func append(_ line: String) {
        let s = ISO8601DateFormatter().string(from: Date()) + " " + line + "\n"
        if let h = try? FileHandle(forWritingTo: log) { h.seekToEndOfFile(); h.write(s.data(using: .utf8)!); try? h.close() }
        else { try? s.data(using: .utf8)!.write(to: log) }
    }
}
