// A recording's bytes -> planar float channels at the engine's rate. The format is read from the
// bytes, never the name: the archive holds MP3s saved as take.webm next to real WebM/Opus.
// WebM goes through core/webm.cpp and Apple's own Opus decoder (iOS cannot open WebM); anything
// else AVAudioFile reads (MP3, WAV, M4A, FLAC) goes through AVAudioFile.
import AVFoundation

enum Decode {
    struct Failure: Error { let reason: String }

    static func pcm(_ data: Data, sampleRate sr: Double) throws -> [[Float]] {
        if data.starts(with: [0x1A, 0x45, 0xDF, 0xA3]) { return try webmOpus(data, sampleRate: sr) }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try data.write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let file = try AVAudioFile(forReading: url)
        let buf = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length))!
        try file.read(into: buf)
        return try resample(buf, to: sr)
    }

    private static func webmOpus(_ data: Data, sampleRate sr: Double) throws -> [[Float]] {
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

        let maxSize = Int(sizes.max() ?? 1)
        var next = 0
        var out: [[Float]] = Array(repeating: [], count: Int(info.channels))
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
            if let e = err { throw e }
            for c in 0..<out.count { out[c].append(contentsOf: UnsafeBufferPointer(start: chunk.floatChannelData![c], count: Int(chunk.frameLength))) }
            if status == .endOfStream || status == .error || chunk.frameLength == 0 { break }
        }
        /* Apple's decoder already drops its own delay (120 samples measured) before the pre-skip is
           applied, which Chrome's does not: trim only what it left of the pre-skip, measured from
           the samples the packets declare. Publish-shrunk files (pre-skip 312) then match Chrome to
           the sample; Chrome's own MediaRecorder writes pre-skip 0, so iOS starts 120 samples in -
           2.5 ms that were silence in Chrome's decode too (measured, peak 0.000). */
        let dropped = Int(info.total_samples) - (out.first?.count ?? 0)
        let skip = max(0, min(Int(info.pre_skip) - dropped, out.first?.count ?? 0))
        out = out.map { Array($0[skip...]) }
        if sr == 48000 { return out }
        let buf = AVAudioPCMBuffer(pcmFormat: pcmFmt, frameCapacity: AVAudioFrameCount(out[0].count))!
        buf.frameLength = AVAudioFrameCount(out[0].count)
        for c in 0..<out.count { out[c].withUnsafeBufferPointer { buf.floatChannelData![c].update(from: $0.baseAddress!, count: $0.count) } }
        return try resample(buf, to: sr)
    }

    /* One conversion to the engine's rate and float planar; the device never resamples. */
    private static func resample(_ inBuf: AVAudioPCMBuffer, to sr: Double) throws -> [[Float]] {
        let ch = Int(inBuf.format.channelCount)
        let fmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sr, channels: AVAudioChannelCount(ch), interleaved: false)!
        let cap = AVAudioFrameCount(Double(inBuf.frameLength) * sr / inBuf.format.sampleRate) + 4096
        let outBuf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: cap)!
        let conv = AVAudioConverter(from: inBuf.format, to: fmt)!
        var fed = false, err: NSError?
        conv.convert(to: outBuf, error: &err) { _, st in
            if fed { st.pointee = .endOfStream; return nil }
            fed = true; st.pointee = .haveData; return inBuf
        }
        if let e = err { throw e }
        return (0..<ch).map { Array(UnsafeBufferPointer(start: outBuf.floatChannelData![$0], count: Int(outBuf.frameLength))) }
    }
}
