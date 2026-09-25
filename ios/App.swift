// iOS host: three "stretch" devices on a bundled recording (stretch.wav) through the core's mixer
// and limiter, into AVAudioEngine. All three always run, so the stats line is the worst case (spec
// test 8, plan step 5.1); the toggle only makes voices 2 and 3 audible. The controls are generated
// from the device's own parameter list and drive every voice; each voice has its own seed.
import AVFoundation
import SwiftUI

final class Core: ObservableObject {
    struct Param: Identifiable { let id: Int; let key, name, unit: String; let min, max: Float }
    private let engine = AVAudioEngine()
    private let voices = (0..<3).map { _ in fs_create("stretch")! }
    private let mix = fs_mix_create()!
    private let worstMs = UnsafeMutablePointer<Double>.allocate(capacity: 1)
    @Published var three = false { didSet { for s in 1..<3 { fs_mix_set_gain(mix, Int32(s), three ? 0.7 : 0) } } }
    private var source: [UnsafeMutablePointer<Float>] = []
    let params: [Param]
    @Published var values: [Int: Float] = [:]
    @Published var line = "starting"
    private var bufferMs = 0.0

    init() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback)
        try? session.setPreferredIOBufferDuration(1024.0 / 48000.0)
        try? session.setActive(true)
        bufferMs = session.ioBufferDuration * 1000
        let sr = session.sampleRate
        fs_mix_prepare(mix, Float(sr), 4096, 4)
        for (i, v) in voices.enumerated() {
            fs_set_param(v, 6, Float(i + 1))            /* seed: each voice its own random phases */
            fs_prepare(v, Float(sr), 4096)
            fs_mix_add(mix, v, Float(sr), i == 0 ? 1 : 0)
        }
        worstMs.pointee = 0

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

        loadSource(sampleRate: sr)
        let format = AVAudioFormat(standardFormatWithSampleRate: sr, channels: 2)!
        let m = mix, worst = worstMs
        let node = AVAudioSourceNode(format: format) { _, _, frames, abl -> OSStatus in
            let t0 = DispatchTime.now().uptimeNanoseconds
            fs_mix_process(m, Int32(frames))
            for (c, b) in UnsafeMutableAudioBufferListPointer(abl).enumerated() {
                b.mData!.copyMemory(from: fs_mix_out(m, Int32(min(c, 1)))!, byteCount: Int(frames) * 4)
            }
            let ms = Double(DispatchTime.now().uptimeNanoseconds - t0) / 1e6
            if ms > worst.pointee { worst.pointee = ms }
            return noErr
        }
        engine.attach(node)
        engine.connect(node, to: engine.mainMixerNode, format: format)
        try? engine.start()
        Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.refresh() }
    }

    /* The host converts to the engine's rate once (spec: the device never resamples). */
    private func loadSource(sampleRate sr: Double) {
        guard let url = Bundle.main.url(forResource: "stretch", withExtension: "wav"),
              let file = try? AVAudioFile(forReading: url) else { line = "no stretch.wav in the app"; return }
        let out = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sr, channels: 2, interleaved: false)!
        let inBuf = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length))!
        try? file.read(into: inBuf)
        let cap = AVAudioFrameCount(Double(file.length) * sr / file.processingFormat.sampleRate) + 1024
        let outBuf = AVAudioPCMBuffer(pcmFormat: out, frameCapacity: cap)!
        let conv = AVAudioConverter(from: file.processingFormat, to: out)!
        var fed = false
        conv.convert(to: outBuf, error: nil) { _, status in
            if fed { status.pointee = .endOfStream; return nil }
            fed = true; status.pointee = .haveData; return inBuf
        }
        let n = Int(outBuf.frameLength)
        source = (0..<2).map { c in
            let p = UnsafeMutablePointer<Float>.allocate(capacity: n)
            p.update(from: outBuf.floatChannelData![min(c, Int(out.channelCount) - 1)], count: n)
            return p
        }
        source.map { UnsafePointer($0) as UnsafePointer<Float>? }.withUnsafeBufferPointer { ptrs in
            for v in voices { fs_set_source(v, 2, Int32(n), ptrs.baseAddress) }
        }
        line = String(format: "%.0f s source at %.0f Hz", Double(n) / sr, sr)
    }

    func set(_ i: Int, _ v: Float) { values[i] = v; for d in voices { fs_set_param(d, Int32(i), v) } }

    private func refresh() {
        var late: Int32 = 0, under: Int32 = 0
        for v in voices { var s = fs_stats_t(); fs_stats(v, &s); late += s.late_frames; under += s.underruns }
        var gr: Float = 0, over: Int64 = 0
        fs_mix_stats(mix, &gr, &over)
        let w = worstMs.pointee
        line = String(format: "3 voices + mix: worst %.2f ms of %.1f ms (%.0f%%) · late %d · underruns %d · limiter %.1f dB · over %lld",
                      w, bufferMs, w / bufferMs * 100, late, under, gr, over)
    }
}

struct ContentView: View {
    @StateObject var core = Core()
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Fieldscape · stretch").font(.title2)
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
            Toggle("Hear 3 voices", isOn: $core.three)
            Text(core.line).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
        }.padding()
    }
    func label(_ p: Core.Param, _ v: Float) -> String {
        p.key == "stretch" ? String(format: "%@  %.1f×", p.name, pow(1024, v)) : String(format: "%@  %.2f %@", p.name, v, p.unit)
    }
}

@main struct FieldscapeApp: App {
    var body: some Scene { WindowGroup { ContentView() } }
}
