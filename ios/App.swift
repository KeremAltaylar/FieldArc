// Phase-3 iOS host: plays the core's "sine" device through AVAudioEngine and shows the level it
// actually measures at the output, so a screenshot proves sound is flowing, not just that it built.
import AVFoundation
import SwiftUI

final class Core: ObservableObject {
    private let engine = AVAudioEngine()
    private let dev = fs_create("sine")!
    @Published var rms: Float = 0
    @Published var bufferMs: Double = 0

    init() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback)
        try? session.setPreferredIOBufferDuration(1024.0 / 48000.0)   // native can ask for more than Safari's 2.7 ms
        try? session.setActive(true)
        bufferMs = session.ioBufferDuration * 1000

        let format = AVAudioFormat(standardFormatWithSampleRate: session.sampleRate, channels: 2)!
        fs_prepare(dev, Float(format.sampleRate), 4096)
        let d = dev
        let node = AVAudioSourceNode(format: format) { _, _, frames, abl -> OSStatus in
            fs_process(d, Int32(frames))
            let bufs = UnsafeMutableAudioBufferListPointer(abl)
            for (c, b) in bufs.enumerated() {
                b.mData!.copyMemory(from: fs_out(d, Int32(min(c, 1)))!, byteCount: Int(frames) * 4)
            }
            return noErr
        }
        engine.attach(node)
        engine.connect(node, to: engine.mainMixerNode, format: format)
        engine.mainMixerNode.installTap(onBus: 0, bufferSize: 4096, format: nil) { [weak self] buf, _ in
            let p = buf.floatChannelData![0]
            var sum: Float = 0
            for i in 0..<Int(buf.frameLength) { sum += p[i] * p[i] }
            let r = (sum / Float(buf.frameLength)).squareRoot()
            DispatchQueue.main.async { self?.rms = r }
        }
        try? engine.start()
    }

    func setLevel(_ v: Float) { fs_set_param(dev, 1, v) }
}

struct ContentView: View {
    @StateObject var core = Core()
    @State var level: Float = 0.2
    var body: some View {
        VStack(spacing: 16) {
            Text("Fieldscape core").font(.title2)
            Text(String(format: "output RMS %.4f", core.rms)).monospacedDigit()
            Text(String(format: "IO buffer %.1f ms", core.bufferMs)).monospacedDigit()
            Slider(value: $level, in: 0...1).onChange(of: level) { core.setLevel($0) }
        }.padding()
    }
}

@main struct FieldscapeApp: App {
    var body: some Scene { WindowGroup { ContentView() } }
}
