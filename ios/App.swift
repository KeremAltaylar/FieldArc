// iOS host: the core's mixer with four stretch voices, the walk's slots, and the piece (the route's
// synths, the zones and the rhythm points, core/piece.cpp) on a fifth slot at gain 1. The walk (Walk.swift)
// assigns the nearest points to slots and sets their gains; the Sound test puts the bundled
// recording (stretch.wav) on slot 0 with the sliders, as before. Controls are generated from the
// device's own parameter list.
import AVFoundation
import SwiftUI
import os

/* The test number of this build (docs/TESTS.md): shown first in the developer line, so Kerem can
   see which build he is testing. Bump it with every build handed over. */
let TEST_BUILD = 3

final class Core: ObservableObject {
    struct Param: Identifiable { let id: Int; let key, name, unit: String; let min, max: Float }
    static let slots = 4
    private let engine = AVAudioEngine()
    private let voices = (0..<Core.slots).map { _ in fs_create("stretch")! }
    private let mix = fs_mix_create()!
    /* The route's generative sound. Walk tells it where the walker is (fs_piece_*); it is never
       re-created, so its Transport and chords run on through route changes, as the web's bed does. */
    let piece = fs_create("piece")!
    private let worstMs = UnsafeMutablePointer<Double>.allocate(capacity: 1)
    private let outPower = UnsafeMutablePointer<Double>.allocate(capacity: 1)   /* mean square of the output, smoothed */
    /* What actually leaves the app, not what the gains say (rulebook A-17). */
    var outputDb: Double { 10 * log10(max(outPower.pointee, 1e-12)) }
    let params: [Param]
    let sampleRate: Double
    @Published var values: [Int: Float] = [:]
    @Published var line = "starting"
    @Published var test = false { didSet { testChanged() } }
    /* Why the sound is paused, when it is: shown in the walk panel with a Resume button. */
    @Published var paused: String? = nil
    /* The Sound / Stop button: the whole output fades (the web's SOUND_FADE_IN / OUT), then the
       engine pauses, so a stopped walk costs no battery. */
    @Published var soundOn = true
    private var fadeTimer: Timer?
    func setSound(_ on: Bool) {
        soundOn = on
        fadeTimer?.invalidate()
        let mixer = engine.mainMixerNode
        if on { if paused == nil { restart() } }
        let from = mixer.outputVolume, to: Float = on ? 1 : 0, secs = on ? 2.0 : 1.5, steps = 30
        var k = 0
        fadeTimer = Timer.scheduledTimer(withTimeInterval: secs / Double(steps), repeats: true) { [weak self] t in
            k += 1
            mixer.outputVolume = from + (to - from) * Float(k) / Float(steps)
            if k >= steps { t.invalidate(); if !on { self?.engine.pause() } }
        }
    }
    private var bufferMs = 0.0

    /* Recordings reach the audio thread through `pending`, taken with a try-lock inside the
       render callback (it never waits); buffers it replaced come back through `retired` and are
       freed here on the main thread, never on the audio thread. */
    private final class Handoff {
        /* os_unfair_lock needs a fixed address, which a Swift property does not promise. */
        let lock: UnsafeMutablePointer<os_unfair_lock> = {
            let p = UnsafeMutablePointer<os_unfair_lock>.allocate(capacity: 1); p.initialize(to: os_unfair_lock()); return p
        }()
        var pending: [(slot: Int, ptrs: [UnsafeMutablePointer<Int16>], consts: [UnsafePointer<Int16>?], frames: Int)] = []
        var retired: [UnsafeMutablePointer<Int16>] = []
        var live: [[UnsafeMutablePointer<Int16>]] = Array(repeating: [], count: Core.slots)
        var liveFrames: [Int] = Array(repeating: 0, count: Core.slots)
        init() { pending.reserveCapacity(16); retired.reserveCapacity(64) }
    }
    private let handoff = Handoff()
    private var player: OpaquePointer? = nil

    /* On the render thread before each block: recordings waiting in the handoff go to their voices
       (try-lock: the render thread never waits); what they replace is freed later on the main thread. */
    fileprivate func takeHandoff() {
        let h = handoff
        guard os_unfair_lock_trylock(h.lock) else { return }
        for p in h.pending {
            p.consts.withUnsafeBufferPointer { fs_set_source_i16(voices[p.slot], Int32(p.consts.count), Int32(p.frames), $0.baseAddress) }
            h.retired += h.live[p.slot]
            h.live[p.slot] = p.ptrs
            h.liveFrames[p.slot] = p.frames
        }
        h.pending.removeAll(keepingCapacity: true)
        os_unfair_lock_unlock(h.lock)
    }

    init() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback)
        try? session.setPreferredIOBufferDuration(1024.0 / 48000.0)
        try? session.setActive(true)
        bufferMs = session.ioBufferDuration * 1000
        let sr = session.sampleRate
        sampleRate = sr
        fs_mix_prepare(mix, Float(sr), 4096, Int32(Core.slots + 1))
        for (i, v) in voices.enumerated() {
            fs_set_param(v, 6, Float(i + 1))            /* seed: each voice its own random phases */
            fs_prepare(v, Float(sr), 4096)
            fs_mix_add(mix, v, Float(sr), 0)
            fs_mix_set_ramp(mix, Int32(i), 350)         /* the web's BED.fade: GPS steps must not be heard */
        }
        fs_prepare(piece, Float(sr), 4096)
        fs_mix_add(mix, piece, Float(sr), 1)
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
        let worst = worstMs, pw = outPower
        /* The mix is rendered ~350 ms ahead on its own real-time thread (core/player.cpp); the
           callback below only copies. Test 2 on the iPhone 8: one callback took 188-243 ms on the
           first screen lock and on a screenshot, every time - 3 underruns, a half-second glitch. */
        player = fs_player_create(mix, Float(sr), 0.35)
        fs_player_on_block(player, { ctx in Unmanaged<Core>.fromOpaque(ctx!).takeUnretainedValue().takeHandoff() },
                           Unmanaged.passUnretained(self).toOpaque())
        fs_player_start(player)
        let pl = player!
        let node = AVAudioSourceNode(format: format) { _, _, frames, abl -> OSStatus in
            let t0 = DispatchTime.now().uptimeNanoseconds
            let bufs = UnsafeMutableAudioBufferListPointer(abl)
            let l = bufs[0].mData!.assumingMemoryBound(to: Float.self)
            let r = bufs[min(1, bufs.count - 1)].mData!.assumingMemoryBound(to: Float.self)
            fs_player_read(pl, l, r, Int32(frames))
            var sq = 0.0
            for i in 0..<Int(frames) { sq += Double(l[i] * l[i]) }
            pw.pointee += (sq / Double(max(frames, 1)) - pw.pointee) * 0.05
            let ms = Double(DispatchTime.now().uptimeNanoseconds - t0) / 1e6
            if ms > worst.pointee { worst.pointee = ms }
            return noErr
        }
        engine.attach(node)
        engine.connect(node, to: engine.mainMixerNode, format: format)
        try? engine.start()
        observeSession()
        Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.refresh() }
        keepWarm()
    }

    /* The loaded recordings, read a page at a time every 2 s off the audio thread. On the first screen
       lock (and on a screenshot) iOS compresses memory the app has not touched lately; the audio
       thread then stalled unpacking a recording's pages - Kerem's iPhone 8, 2026-09-26: one callback
       243 ms of a 21 ms budget, 3 underruns, a half-second glitch, only the first time. Touched
       pages count as in use and are left alone. ponytail: the piece's rhythm recordings are not
       touched (smaller, read as they play); add them if a glitch remains. */
    private func keepWarm() {
        let h = handoff
        DispatchQueue.global(qos: .utility).async {
            var sink: Int16 = 0
            while true {
                os_unfair_lock_lock(h.lock)
                for (slot, chans) in h.live.enumerated() {
                    let n = h.liveFrames[slot]
                    for p in chans { var i = 0; while i < n { sink &+= p[i]; i += 4096 } }   /* 8 KB apart: every 16 KB page, twice */
                }
                os_unfair_lock_unlock(h.lock)
                if sink == 12345 { print("") }             /* keeps the reads from being optimised away */
                Thread.sleep(forTimeInterval: 2)
            }
        }
    }

    /* Rulebook M-6. A call, Siri or an alarm interrupts: when it ends the walk comes back by itself.
       Headphones pulled out: paused, as every iOS player does, rather than suddenly playing out loud
       from the speaker in the street; the panel offers Resume. A hardware change (Bluetooth
       headphones switching rate) stops the engine: it is started again. */
    private func observeSession() {
        let nc = NotificationCenter.default, session = AVAudioSession.sharedInstance()
        nc.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: .main) { [weak self] n in
            guard let self, let raw = n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
            if type == .ended && self.paused == nil { self.restart() }
        }
        nc.addObserver(forName: AVAudioSession.routeChangeNotification, object: session, queue: .main) { [weak self] n in
            guard let self, let raw = n.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
                  AVAudioSession.RouteChangeReason(rawValue: raw) == .oldDeviceUnavailable else { return }
            self.engine.pause()
            self.paused = "Headphones were unplugged."
        }
        nc.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            if self?.paused == nil { self?.restart() }
        }
    }

    func resume() { paused = nil; if soundOn { restart() } }

    private func restart() {
        try? AVAudioSession.sharedInstance().setActive(true)
        if !engine.isRunning { try? engine.start() }
    }

    /* A decoded recording for a slot, stored 16-bit for the audio thread: half the memory of float,
       so a whole recording fits (a 6 min 40 s stereo take is 77 MB). The rounding sits near
       -96 dBFS, below anything a field recording holds. */
    func load(slot: Int, pcm: Decode.Pcm) {          /* takes ownership of pcm's buffers */
        let consts = pcm.planar.map { UnsafePointer($0) as UnsafePointer<Int16>? }
        os_unfair_lock_lock(handoff.lock)
        handoff.pending.append((slot, pcm.planar, consts, pcm.frames))
        os_unfair_lock_unlock(handoff.lock)
    }

    func gain(slot: Int, _ g: Float) { fs_mix_set_gain(mix, Int32(slot), g) }
    func lowpass(slot: Int, _ hz: Float) { fs_mix_set_lowpass(mix, Int32(slot), hz, 350) }   /* BED.fade */
    func grit(slot: Int, _ a: Float) { fs_mix_set_grit(mix, Int32(slot), a) }
    func param(slot: Int, _ i: Int, _ v: Float) { fs_set_param(voices[slot], Int32(i), v) }

    /* Sound test: the sliders drive slot 0, which the walk leaves alone while the test is on. */
    func set(_ i: Int, _ v: Float) { values[i] = v; param(slot: 0, i, v) }

    private func testChanged() {
        if test, let url = Bundle.main.url(forResource: "stretch", withExtension: "wav"), let data = try? Data(contentsOf: url) {
            for (i, v) in values { param(slot: 0, i, v) }
            let sr = sampleRate
            Task { @MainActor [weak self] in
                guard let pcm = try? await Decode.pcm16(data, sampleRate: sr) else { return }
                self?.load(slot: 0, pcm: pcm)
                self?.gain(slot: 0, 1)
            }
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
        /* The output level, twice a second, readable from outside the app (tests read it while the
           walker stands still, when no fix - and so no walk log line - arrives). */
        try? String(format: "%.1f", outputDb).write(to: FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("level.txt"), atomically: true, encoding: .utf8)
        var pu: Int64 = 0, pw: Float = 0, ahead: Float = 0
        if let p = player { fs_player_stats(p, &pu, &pw, &ahead) }
        line = String(format: "Fieldscape · Test %d\nahead %.0f ms · dropouts %lld · render worst %.1f ms · callback worst %.2f ms of %.1f · late %d · limiter %.1f dB · over %lld",
                      TEST_BUILD, ahead, pu, pw, w, bufferMs, late, gr, over)
        _ = under
    }
}

/* The map fills the screen; the walk panel lies over its foot and hugs its content (C-10), so the
   map keeps whatever height the panel gives back. A long-press on the place name opens Developer. */
struct ContentView: View {
    @StateObject var core: Core
    @StateObject var walk: Walk
    @State var features: [String: Any]? = nil
    @State var failed: String? = nil
    @State var developer = false
    init() {
        let c = Core()
        _core = StateObject(wrappedValue: c)
        _walk = StateObject(wrappedValue: Walk(core: c))
    }
    var body: some View {
        ZStack(alignment: .bottom) {
            T.ground.ignoresSafeArea()
            if let f = features { MapView(features: f, walk: walk).ignoresSafeArea() }
            else { Text(failed ?? "Loading the map…").font(T.body(T.sm)).foregroundStyle(T.dim).frame(maxHeight: .infinity) }
            VStack(alignment: .leading, spacing: T.s5) {
                Capsule().fill(T.hairline).frame(width: 38, height: 4).frame(maxWidth: .infinity)
                /* the long-press lives on the place name alone: on the whole panel it swallowed its
                   buttons' taps (Go to did nothing on the simulator, 2026-09-26) */
                WalkPanel(walk: walk, core: core, onLongPress: { withAnimation(.easeOut(duration: 0.18)) { developer.toggle() } })
                if developer {
                    ScrollView { DeveloperPanel(core: core, open: true) }.frame(maxHeight: 360)
                }
            }
            .padding(.horizontal, T.s4).padding(.top, T.s2).padding(.bottom, T.s5)
            .background { UnevenRoundedRectangle(topLeadingRadius: 20, topTrailingRadius: 20).fill(T.panel).ignoresSafeArea(edges: .bottom) }
            .overlay(alignment: .top) { Rectangle().fill(T.hairline).frame(height: 1).padding(.horizontal, 20) }
            .animation(.easeOut(duration: 0.18), value: walk.rows)
        }
        .preferredColorScheme(.dark)
        .task {
            do {
                let f = try await Supa.published()
                features = f
                walk.start(features: f)
            } catch { failed = "The map could not load: " + error.localizedDescription + ". Check the connection and reopen the app." }
        }
    }
}

@main struct FieldscapeApp: App {
    var body: some Scene { WindowGroup { ContentView() } }
}
