// iOS host: the core's mixer with four stretch voices, the walk's slots. The walk (Walk.swift)
// assigns the nearest points to slots and sets their gains; the Sound test puts the bundled
// recording (stretch.wav) on slot 0 with the sliders, as before. Controls are generated from the
// device's own parameter list.
import AVFoundation
import SwiftUI
import os

final class Core: ObservableObject {
    struct Param: Identifiable { let id: Int; let key, name, unit: String; let min, max: Float }
    static let slots = 4
    private let engine = AVAudioEngine()
    private let voices = (0..<Core.slots).map { _ in fs_create("stretch")! }
    private let mix = fs_mix_create()!
    private let worstMs = UnsafeMutablePointer<Double>.allocate(capacity: 1)
    private let outPower = UnsafeMutablePointer<Double>.allocate(capacity: 1)   /* mean square of the output, smoothed */
    /* What actually leaves the app, not what the gains say (rulebook A-17). */
    var outputDb: Double { 10 * log10(max(outPower.pointee, 1e-12)) }
    let params: [Param]
    let sampleRate: Double
    @Published var values: [Int: Float] = [:]
    @Published var line = "starting"
    @Published var test = false { didSet { testChanged() } }
    private var bufferMs = 0.0

    /* Recordings reach the audio thread through `pending`, taken with a try-lock inside the
       render callback (it never waits); buffers it replaced come back through `retired` and are
       freed here on the main thread, never on the audio thread. */
    private final class Handoff {
        /* os_unfair_lock needs a fixed address, which a Swift property does not promise. */
        let lock: UnsafeMutablePointer<os_unfair_lock> = {
            let p = UnsafeMutablePointer<os_unfair_lock>.allocate(capacity: 1); p.initialize(to: os_unfair_lock()); return p
        }()
        var pending: [(slot: Int, ptrs: [UnsafeMutablePointer<Float>], consts: [UnsafePointer<Float>?], frames: Int)] = []
        var retired: [UnsafeMutablePointer<Float>] = []
        var live: [[UnsafeMutablePointer<Float>]] = Array(repeating: [], count: Core.slots)
        init() { pending.reserveCapacity(16); retired.reserveCapacity(64) }
    }
    private let handoff = Handoff()

    init() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback)
        try? session.setPreferredIOBufferDuration(1024.0 / 48000.0)
        try? session.setActive(true)
        bufferMs = session.ioBufferDuration * 1000
        let sr = session.sampleRate
        sampleRate = sr
        fs_mix_prepare(mix, Float(sr), 4096, Int32(Core.slots))
        for (i, v) in voices.enumerated() {
            fs_set_param(v, 6, Float(i + 1))            /* seed: each voice its own random phases */
            fs_prepare(v, Float(sr), 4096)
            fs_mix_add(mix, v, Float(sr), 0)
            fs_mix_set_ramp(mix, Int32(i), 350)         /* the web's BED.fade: GPS steps must not be heard */
        }
        worstMs.pointee = 0
        outPower.pointee = 0

        var ps: [Param] = [], vs: [Int: Float] = [:]
        let first = voices[0]
        for i in 0..<Int(fs_param_count(first)) {
            let p = fs_param_info(first, Int32(i))!.pointee
            let key = String(cString: p.id)
            if key == "seed" { continue }
            ps.append(Param(id: i, key: key, name: String(cString: p.name), unit: String(cString: p.unit), min: p.min, max: p.max))
            vs[i] = p.def
        }
        params = ps
        values = vs

        let format = AVAudioFormat(standardFormatWithSampleRate: sr, channels: 2)!
        let m = mix, worst = worstMs, h = handoff, vv = voices, pw = outPower
        let node = AVAudioSourceNode(format: format) { _, _, frames, abl -> OSStatus in
            let t0 = DispatchTime.now().uptimeNanoseconds
            /* ponytail: handing a recording over appends to two small reserved arrays here; it happens a
               few times per walk, not per callback. A lock-free ring if it ever shows in the stats. */
            if os_unfair_lock_trylock(h.lock) {
                for p in h.pending {
                    p.consts.withUnsafeBufferPointer {
                        fs_set_source(vv[p.slot], Int32(p.consts.count), Int32(p.frames), $0.baseAddress)
                    }
                    h.retired += h.live[p.slot]
                    h.live[p.slot] = p.ptrs
                }
                h.pending.removeAll(keepingCapacity: true)
                os_unfair_lock_unlock(h.lock)
            }
            fs_mix_process(m, Int32(frames))
            for (c, b) in UnsafeMutableAudioBufferListPointer(abl).enumerated() {
                b.mData!.copyMemory(from: fs_mix_out(m, Int32(min(c, 1)))!, byteCount: Int(frames) * 4)
            }
            let o = fs_mix_out(m, 0)!
            var sq = 0.0
            for i in 0..<Int(frames) { sq += Double(o[i] * o[i]) }
            pw.pointee += (sq / Double(max(frames, 1)) - pw.pointee) * 0.05
            let ms = Double(DispatchTime.now().uptimeNanoseconds - t0) / 1e6
            if ms > worst.pointee { worst.pointee = ms }
            return noErr
        }
        engine.attach(node)
        engine.connect(node, to: engine.mainMixerNode, format: format)
        try? engine.start()
        Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.refresh() }
    }

    /* A decoded recording for a slot. Copied into memory the audio thread will own. */
    func load(slot: Int, channels: [[Float]]) {
        let n = channels.first?.count ?? 0
        let ptrs: [UnsafeMutablePointer<Float>] = channels.prefix(2).map { ch in
            let p = UnsafeMutablePointer<Float>.allocate(capacity: max(n, 1))
            ch.withUnsafeBufferPointer { p.update(from: $0.baseAddress!, count: n) }
            return p
        }
        let consts = ptrs.map { UnsafePointer($0) as UnsafePointer<Float>? }
        os_unfair_lock_lock(handoff.lock)
        handoff.pending.append((slot, ptrs, consts, n))
        os_unfair_lock_unlock(handoff.lock)
    }

    func gain(slot: Int, _ g: Float) { fs_mix_set_gain(mix, Int32(slot), g) }
    func param(slot: Int, _ i: Int, _ v: Float) { fs_set_param(voices[slot], Int32(i), v) }

    /* Sound test: the sliders drive slot 0, which the walk leaves alone while the test is on. */
    func set(_ i: Int, _ v: Float) { values[i] = v; param(slot: 0, i, v) }

    private func testChanged() {
        if test, let url = Bundle.main.url(forResource: "stretch", withExtension: "wav"),
           let data = try? Data(contentsOf: url), let ch = try? Decode.pcm(data, sampleRate: sampleRate) {
            for (i, v) in values { param(slot: 0, i, v) }
            load(slot: 0, channels: ch)
            gain(slot: 0, 1)
        } else {
            gain(slot: 0, 0)
        }
    }

    private func refresh() {
        os_unfair_lock_lock(handoff.lock)
        let free = handoff.retired
        handoff.retired.removeAll(keepingCapacity: true)
        os_unfair_lock_unlock(handoff.lock)
        free.forEach { $0.deallocate() }

        var late: Int32 = 0, under: Int32 = 0
        for v in voices { var s = fs_stats_t(); fs_stats(v, &s); late += s.late_frames; under += s.underruns }
        var gr: Float = 0, over: Int64 = 0
        fs_mix_stats(mix, &gr, &over)
        let w = worstMs.pointee
        line = String(format: "4 voices + mix: worst %.2f ms of %.1f ms (%.0f%%) · late %d · underruns %d · limiter %.1f dB · over %lld",
                      w, bufferMs, w / bufferMs * 100, late, under, gr, over)
    }
}

/* The map fills the screen; the sound test is a panel pulled up from the bottom (phase 5.4). */
struct ContentView: View {
    @StateObject var core: Core
    @StateObject var walk: Walk
    init() {
        let c = Core()
        _core = StateObject(wrappedValue: c)
        _walk = StateObject(wrappedValue: Walk(core: c))
    }
    @State var features: [String: Any]? = nil
    @State var failed: String? = nil
    @State var panel = true
    var body: some View {
        ZStack {
            Color(red: 0.05, green: 0.075, blue: 0.063).ignoresSafeArea()
            if let f = features { MapView(features: f).ignoresSafeArea() }
            else { Text(failed ?? "Loading the map…").foregroundStyle(.secondary) }
        }
        .task {
            do {
                let f = try await Supa.published()
                features = f
                walk.start(features: f)
            } catch { failed = "Could not load: " + error.localizedDescription }
        }
        .sheet(isPresented: $panel) {
            SoundPanel(core: core, walk: walk)
                .presentationDetents([.height(90), .medium, .large])
                .presentationBackgroundInteraction(.enabled(upThrough: .medium))
                .interactiveDismissDisabled()
        }
    }
}

struct SoundPanel: View {
    @ObservedObject var core: Core
    @ObservedObject var walk: Walk
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text(walk.status).font(.callout)
                Toggle("Sound test (bundled recording)", isOn: $core.test)
                Text(core.line).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                ForEach(core.params) { p in
                    let v = core.values[p.id] ?? p.min
                    if p.max == 1 && (p.key == "freeze" || p.key == "shape") {
                        Toggle(p.key == "shape" ? "Hann window" : p.name, isOn: Binding(get: { v > 0.5 }, set: { core.set(p.id, $0 ? 1 : 0) }))
                    } else {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(label(p, v)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                            Slider(value: Binding(get: { v }, set: { core.set(p.id, $0) }), in: p.min...p.max)
                        }
                    }
                }
            }.padding()
        }
    }
    func label(_ p: Core.Param, _ v: Float) -> String {
        p.key == "stretch" ? String(format: "%@  %.1f×", p.name, pow(1024, v)) : String(format: "%@  %.2f %@", p.name, v, p.unit)
    }
}

@main struct FieldscapeApp: App {
    var body: some Scene { WindowGroup { ContentView() } }
}
