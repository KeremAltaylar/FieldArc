package net.keremaltaylar.fieldscape

/** The shared C++ core (core/fieldscape.h), over JNI. */
object Core {
    init { System.loadLibrary("fieldscape") }
    @JvmStatic external fun selfTestRms(): Double
}
