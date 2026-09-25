package net.keremaltaylar.fieldscape

import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.util.Log
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * A recording file -> interleaved 16-bit PCM as decoded (channels, rate). Android's own decoders
 * read what the archive holds (WebM/Opus, and the MP3s saved as take.webm); the format comes from
 * the file, not its name. The native side splits, resamples and hands it over (Core.loadInterleaved).
 * The decoded audio is cached next to the download: decoding is the slow step (a 6 min 40 s Opus
 * take took 107 s on the emulator), and a second visit then only reads a file.
 *
 * The samples live in a direct (native) buffer from the decoder to the audio thread: the Java heap
 * is capped (~192 MB on the emulator) and two 77 MB recordings plus a copy of one ran out of it.
 */
object Decode {
    class Pcm(val data: ByteBuffer, val channels: Int, val rate: Int, val frames: Int)   // data: direct, 16-bit native order, interleaved

    /** ponytail: 10 minutes kept per voice (~115 MB 16-bit stereo), as on iOS. */
    private const val CAP_SECONDS = 600

    fun pcm(file: File): Pcm {
        val cache = File(file.path + ".pcm")
        if (cache.exists()) runCatching { return read(cache) }
        val t0 = System.nanoTime()
        val p = decode(file)
        Log.i("fieldscape", "decode ${file.name}: ${p.frames} frames at ${p.rate} Hz x${p.channels} in ${(System.nanoTime() - t0) / 1_000_000} ms")
        runCatching { write(p, cache) }
        return p
    }

    private fun decode(file: File): Pcm {
        val ex = MediaExtractor()
        ex.setDataSource(file.path)
        val track = (0 until ex.trackCount).first { ex.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true }
        ex.selectTrack(track)
        val fmt = ex.getTrackFormat(track)
        val codec = MediaCodec.createDecoderByType(fmt.getString(MediaFormat.KEY_MIME)!!)
        codec.configure(fmt, null, null, 0)
        codec.start()
        var rate = fmt.getInteger(MediaFormat.KEY_SAMPLE_RATE)
        var channels = fmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
        /* One buffer sized from the declared duration (grown if it is wrong), filled by bulk copies. */
        val seconds = if (fmt.containsKey(MediaFormat.KEY_DURATION)) fmt.getLong(MediaFormat.KEY_DURATION) / 1e6 else 60.0
        var out = direct(((minOf(seconds, CAP_SECONDS.toDouble()) + 1) * rate * channels).toInt())
        var total = 0                                  // samples written
        val info = MediaCodec.BufferInfo()
        var inputDone = false
        var outputDone = false
        while (!outputDone) {
            var moved = false
            while (!inputDone) {                      // every input the decoder will take, without waiting
                val i = codec.dequeueInputBuffer(0)
                if (i < 0) break
                val n = ex.readSampleData(codec.getInputBuffer(i)!!, 0)
                if (n < 0) { codec.queueInputBuffer(i, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM); inputDone = true }
                else { codec.queueInputBuffer(i, 0, n, ex.sampleTime, 0); ex.advance() }
                moved = true
            }
            while (true) {                            // every output that is ready
                val o = codec.dequeueOutputBuffer(info, if (moved) 0 else 2_000)
                if (o == MediaCodec.INFO_TRY_AGAIN_LATER) break
                if (o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    rate = codec.outputFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE)
                    channels = codec.outputFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
                    continue
                }
                if (o < 0) continue
                moved = true
                if (info.size > 0) {
                    val src = codec.getOutputBuffer(o)!!
                    val n = src.remaining() / 2
                    if ((total + n) * 2 > out.capacity()) {
                        val bigger = direct(maxOf(out.capacity() / 2 * 3 / 2, total + n))
                        out.position(0).limit(total * 2); bigger.put(out); out = bigger
                    }
                    out.position(total * 2); out.put(src)
                    total += n
                }
                codec.releaseOutputBuffer(o, false)
                if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) { outputDone = true; break }
            }
            if (total / channels > CAP_SECONDS * rate) break
        }
        codec.stop(); codec.release(); ex.release()
        return Pcm(out, channels, rate, minOf(total / channels, CAP_SECONDS * rate))
    }

    private fun direct(samples: Int): ByteBuffer = ByteBuffer.allocateDirect(samples * 2).order(ByteOrder.nativeOrder())

    private fun write(p: Pcm, f: File) {
        val tmp = File(f.path + ".part")
        RandomAccessFile(tmp, "rw").channel.use { ch ->
            val head = ByteBuffer.allocate(12).order(ByteOrder.nativeOrder()).putInt(p.channels).putInt(p.rate).putInt(p.frames)
            head.flip(); ch.write(head)
            val body = p.data.duplicate(); body.position(0); body.limit(p.frames * p.channels * 2)
            while (body.hasRemaining()) ch.write(body)
        }
        tmp.renameTo(f)
    }

    private fun read(f: File): Pcm = RandomAccessFile(f, "r").channel.use { ch ->
        val head = ByteBuffer.allocate(12).order(ByteOrder.nativeOrder())
        ch.read(head); head.flip()
        val channels = head.int; val rate = head.int; val frames = head.int
        val data = direct(frames * channels)
        while (data.hasRemaining() && ch.read(data) > 0) {}
        Pcm(data, channels, rate, frames)
    }
}
