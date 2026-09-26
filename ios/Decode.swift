// A recording's bytes -> planar 16-bit channels at the engine's rate. The format is read from the
// bytes, never the name: the archive holds MP3s saved as take.webm next to real WebM/Opus.
// WebM goes through core/webm.cpp and Apple's own Opus decoder (iOS cannot open WebM); anything
// else AVAudioFile reads (MP3, WAV, M4A, FLAC) goes through AVAudioFile.
//
// Memory (Kerem's iPhone 8, 2026-09-26: "killed ... using too much memory", 2 launches in 4): the
// decode used to hold a take as growing float arrays, a trimmed copy, a resampled copy and then the
// 16-bit copy - ~700 MB at the peak for a 6 min 40 s stereo take, with up to three decoding at once.
// Now each chunk is written straight into 16-bit buffers of the final size (~77 MB for that take,
// twice that only while resampling, with core/resample.cpp), and decodes run one at a time.
import AVFoundation

enum Decode {
    struct Failure: Error { let reason: String }

    /* Planar 16-bit channels, allocated with UnsafeMutablePointer.allocate; whoever takes them owns
       them (Core.load hands them to the audio thread and frees them when replaced). */
    struct Pcm: @unchecked Sendable {                /* handed from the decode queue to its one owner */
        var planar: [UnsafeMutablePointer<Int16>]
        var frames: Int
        func free() { planar.forEach { $0.deallocate() } }
    }

    /* ponytail: 10 minutes kept per voice (~115 MB at 16-bit stereo); the longest published take is
       6 min 40 s. */
    static let capSeconds = 600.0

    /* One decode at a time, whoever asks (the walk's points and the rhythm points). */
    private static let queue = DispatchQueue(label: "net.keremaltaylar.fieldscape.decode")

    static func pcm16(_ data: Data, sampleRate sr: Double) async throws -> Pcm {
        try await withCheckedThrowingContinuation { cont in
            queue.async {
                do { cont.resume(returning: try decode(data, sampleRate: sr)) } catch { cont.resume(throwing: error) }
            }
        }
    }

    private static func decode(_ data: Data, sampleRate sr: Double) throws -> Pcm {
        let (pcm, rate) = data.starts(with: [0x1A, 0x45, 0xDF, 0xA3]) ? try webmOpus(data) : try file(data)
        return rate == sr ? pcm : resample(pcm, from: rate, to: sr)
    }

    private static func alloc(_ channels: Int, _ frames: Int) -> [UnsafeMutablePointer<Int16>] {
        (0..<channels).map { _ in UnsafeMutablePointer<Int16>.allocate(capacity: max(frames, 1)) }
    }
    @inline(__always) private static func s16(_ v: Float) -> Int16 { Int16(max(-32768, min(32767, (v * 32768).rounded()))) }

    /* MP3, WAV, M4A, FLAC: read a second at a time into the final buffers. */
    private static func file(_ data: Data) throws -> (Pcm, Double) {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try data.write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let f = try AVAudioFile(forReading: url)
        let fmt = f.processingFormat, rate = fmt.sampleRate
        let ch = min(Int(fmt.channelCount), 2)
        let total = Int(min(Double(f.length), capSeconds * rate))
        var pcm = Pcm(planar: alloc(ch, total), frames: 0)
        let chunk = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(rate))!
        while pcm.frames < total {
            try f.read(into: chunk, frameCount: AVAudioFrameCount(min(Int(rate), total - pcm.frames)))
            let n = Int(chunk.frameLength)
            if n == 0 { break }
            for c in 0..<ch { let src = chunk.floatChannelData![c], dst = pcm.planar[c] + pcm.frames; for i in 0..<n { dst[i] = s16(src[i]) } }
            pcm.frames += n
        }
        return (pcm, rate)
    }

    private static func webmOpus(_ data: Data) throws -> (Pcm, Double) {
        var info = fs_webm_info()
        let bytes = [UInt8](data)
        let n = Int(fs_webm_opus(bytes, bytes.count, &info, nil, nil, 0))
        guard n > 0 else { throw Failure(reason: "WebM without an Opus track (\(n))") }
        var offs = [UInt32](repeating: 0, count: n), sizes = [UInt32](repeating: 0, count: n)
        _ = fs_webm_opus(bytes, bytes.count, &info, &offs, &sizes, Int32(n))

        /* Packet length varies by recorder (20 ms from ffmpeg/libopus, 60 ms from Chrome's
           MediaRecorder); the decoder must be told the real one. */
        let perPacket = bytes.withUnsafeBufferPointer { Int(fs_opus_packet_samples($0.baseAddress! + Int(offs[0]), Int(sizes[0]))) }
        var asbd = AudioStreamBasicDescription(mSampleRate: 48000, mFormatID: kAudioFormatOpus, mFormatFlags: 0,
            mBytesPerPacket: 0, mFramesPerPacket: UInt32(perPacket), mBytesPerFrame: 0, mChannelsPerFrame: UInt32(info.channels),
            mBitsPerChannel: 0, mReserved: 0)
        guard let inFmt = AVAudioFormat(streamDescription: &asbd),
              let pcmFmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: AVAudioChannelCount(info.channels), interleaved: false),
              let conv = AVAudioConverter(from: inFmt, to: pcmFmt) else { throw Failure(reason: "no Opus decoder") }

        let ch = min(Int(info.channels), 2)
        let cap = Int(min(Double(info.total_samples), capSeconds * 48000))
        var pcm = Pcm(planar: alloc(ch, cap), frames: 0)
        var produced = 0                                  /* all the decoder gave, for the pre-skip below */
        let maxSize = Int(sizes.max() ?? 1)
        var next = 0
        let chunk = AVAudioPCMBuffer(pcmFormat: pcmFmt, frameCapacity: AVAudioFrameCount(perPacket * 64))!
        while true {
            chunk.frameLength = 0
            var err: NSError?
            let status = conv.convert(to: chunk, error: &err) { _, st in
                if next >= n { st.pointee = .endOfStream; return nil }
                let k = min(32, n - next)
                let cb = AVAudioCompressedBuffer(format: inFmt, packetCapacity: AVAudioPacketCount(k), maximumPacketSize: maxSize)
                var pos = 0
                for j in 0..<k {
                    let o = Int(offs[next + j]), s = Int(sizes[next + j])
                    bytes.withUnsafeBufferPointer { cb.data.advanced(by: pos).copyMemory(from: $0.baseAddress! + o, byteCount: s) }
                    cb.packetDescriptions![j] = AudioStreamPacketDescription(mStartOffset: Int64(pos), mVariableFramesInPacket: 0, mDataByteSize: UInt32(s))
                    pos += s
                }
                cb.packetCount = AVAudioPacketCount(k)
                cb.byteLength = UInt32(pos)
                next += k
                st.pointee = .haveData
                return cb
            }
            if let e = err { pcm.free(); throw e }
            let got = Int(chunk.frameLength), room = min(got, cap - pcm.frames)
            if room > 0 {
                for c in 0..<ch { let src = chunk.floatChannelData![c], dst = pcm.planar[c] + pcm.frames; for i in 0..<room { dst[i] = s16(src[i]) } }
                pcm.frames += room
            }
            produced += got
            if status == .endOfStream || status == .error || got == 0 || pcm.frames >= cap { break }
        }
        /* Apple's decoder already drops its own delay (120 samples measured) before the pre-skip is
           applied, which Chrome's does not: trim only what it left of the pre-skip, measured from
           the samples the packets declare. Publish-shrunk files (pre-skip 312) then match Chrome to
           the sample; Chrome's own MediaRecorder writes pre-skip 0, so iOS starts 120 samples in -
           2.5 ms that were silence in Chrome's decode too (measured, peak 0.000). */
        let dropped = Int(info.total_samples) - produced
        let skip = max(0, min(Int(info.pre_skip) - dropped, pcm.frames))
        if skip > 0 {
            for c in 0..<ch { (pcm.planar[c]).update(from: pcm.planar[c] + skip, count: pcm.frames - skip) }
            pcm.frames -= skip
        }
        return (pcm, 48000)
    }

    /* One conversion to the engine's rate (core/resample.cpp, windowed sinc); the device never resamples. */
    private static func resample(_ p: Pcm, from: Double, to: Double) -> Pcm {
        let m = Int(fs_resample_length(Int64(p.frames), from, to))
        let out = alloc(p.planar.count, m)
        for c in 0..<p.planar.count { fs_resample_i16(p.planar[c], Int64(p.frames), from, out[c], to) }
        p.free()
        return Pcm(planar: out, frames: m)
    }
}
