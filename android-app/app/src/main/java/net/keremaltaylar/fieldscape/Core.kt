package net.keremaltaylar.fieldscape

/** The shared C++ core (core/fieldscape.h) and the Android audio engine (jni.cpp), over JNI. */
object Core {
    init { System.loadLibrary("fieldscape") }
    const val SLOTS = 4
    const val GPS_ACC_MAX = 40.0          // FS_GPS_ACC_MAX: a worse fix holds the walk

    @JvmStatic external fun selfTestRms(): Double
    /** Starts the engine; returns its sample rate, the rate every recording is converted to. */
    @JvmStatic external fun start(): Double
    @JvmStatic external fun gain(slot: Int, g: Float)
    @JvmStatic external fun lowpass(slot: Int, hz: Float)
    @JvmStatic external fun param(slot: Int, index: Int, value: Float)
    @JvmStatic external fun load(slot: Int, left: ShortArray, right: ShortArray)
    @JvmStatic external fun loadInterleaved(slot: Int, interleaved: java.nio.ByteBuffer, channels: Int, frames: Int, rate: Double)
    @JvmStatic external fun collect()
    @JvmStatic external fun outputDb(): Double
    @JvmStatic external fun worstMs(): Float
    @JvmStatic external fun bufferFrames(): Int
    @JvmStatic external fun xruns(): Int

    @JvmStatic external fun geoDistance(lon1: Double, lat1: Double, lon2: Double, lat2: Double): Double
    @JvmStatic external fun pointGain(dist: Double, radius: Double, gain: Double): Double
    @JvmStatic external fun pointProximity(dist: Double, radius: Double): Double
    @JvmStatic external fun pickVoices(dist: DoubleArray, radius: DoubleArray, eligible: BooleanArray, max: Int, radiusFirst: Boolean): IntArray
    @JvmStatic external fun pointInRing(lon: Double, lat: Double, ring: DoubleArray): Boolean
    @JvmStatic external fun resample(input: ShortArray, from: Double, to: Double): ShortArray
}
