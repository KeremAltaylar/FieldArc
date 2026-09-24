// iOS host: plays the core's "stretch" device on a bundled recording (stretch.wav) through
// AVAudioEngine. The controls are generated from the device's own parameter list, so any device
// gets a UI without hand-built screens; the stats line is spec test 8 measured on the phone.
import AVFoundation
import SwiftUI

final class Core: ObservableObject {
    struct Param: Identifiable { let id: Int; let key, name, unit: String; let min, max: Float }
    private let engine = AVAudioEngine()
    private let dev = fs_create("stretch")!
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
        fs_prepare(dev, Float(sr), 4096)

        var ps: [Param] = [], vs: [Int: Float] = [:]
        for i in 0..<Int(fs_param_count(dev)) {
            let p = fs_param_info(dev, Int32(i))!.pointee
            let key = String(cString: p.id)
            if key == "seed" { continue }
            ps.append(Param(id: i, key: key, name: String(cString: p.name), unit: String(cString: p.unit), min: p.min, max: p.max))
            vs[i] = p.def
        }
        params = ps
        values = vs

        loadSource(sampleRate: sr)
        let format = AVAudioFormat(standardFormatWithSampleRate: sr, channels: 2)!
        let d = dev
        let node = AVAudioSourceNode(format: format) { _, _, frames, abl -> OSStatus in
            fs_process(d, Int32(frames))
            for (c, b) in UnsafeMutableAudioBufferListPointer(abl).enumerated() {
                b.mData!.copyMemory(from: fs_out(d, Int32(min(c, 1)))!, byteCount: Int(frames) * 4)
            }
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
        source.map { UnsafePointer($0) as UnsafePointer<Float>? }.withUnsafeBufferPointer { fs_set_source(dev, 2, Int32(n), $0.baseAddress) }
        line = String(format: "%.0f s source at %.0f Hz", Double(n) / sr, sr)
    }

    func set(_ i: Int, _ v: Float) { values[i] = v; fs_set_param(dev, Int32(i), v) }

    private func refresh() {
        var s = fs_stats_t()
        fs_stats(dev, &s)
        line = String(format: "worst %.2f ms of %.1f ms (%.0f%%) · late %d · underruns %d · loops %d",
                      s.max_process_ms, bufferMs, Double(s.max_process_ms) / bufferMs * 100, s.late_frames, s.underruns, s.wraps)
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
