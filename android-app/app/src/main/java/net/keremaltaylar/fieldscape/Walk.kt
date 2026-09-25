package net.keremaltaylar.fieldscape

import android.annotation.SuppressLint
import android.content.Context
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * The walk, as the iOS app's Walk.swift: GPS -> the core's place layer -> which points sound and how
 * loud -> recordings fetched, cached, decoded into the engine's slots. Points by their own radius,
 * prox^1.5 x gain, the four nearest soundscape points (updateBed's order), the proximity low-pass,
 * placeAt for the park underfoot; a fix worse than 40 m holds the walk (A-15). Compose reads the
 * state below.
 */
class Walk(private val context: Context, private val engineRate: Double) : LocationListener {
    data class Point(val id: String, val name: String, val lon: Double, val lat: Double, val radius: Double, val gain: Double,
                     val stretch: Float, val windowSamples: Double, val brightest: Double, val path: String?, val sounds: Boolean)
    sealed interface Phase { data object Playing : Phase; data object Decoding : Phase; data class Downloading(val fraction: Double, val bytes: Long) : Phase }
    data class Row(val id: String, val name: String, val level: Double, val dist: Double, val phase: Phase)
    sealed interface Mode { data object Waiting : Mode; data object Denied : Mode; data class Live(val accuracy: Double) : Mode; data class Holding(val accuracy: Double) : Mode }
    data class Nearest(val name: String, val dist: Double, val direction: String)

    var mode by mutableStateOf<Mode>(Mode.Waiting)
    var rows by mutableStateOf(listOf<Row>())
    var place by mutableStateOf<String?>(null)
    var nearest by mutableStateOf<Nearest?>(null)
    var failure by mutableStateOf<String?>(null)
    var here by mutableStateOf<Pair<Double, Double>?>(null)

    private val main = Handler(Looper.getMainLooper())
    private var points = listOf<Point>()
    private val slotOf = HashMap<String, Int>()
    private val phase = HashMap<String, Phase>()
    private val loaded = HashSet<String>()
    private val released = HashMap<Int, Long>()
    private val earned = HashMap<String, Float>()          // the level each point last earned: applied when it loads
    private val parks = ArrayList<Pair<String, List<DoubleArray>>>()
    private var placeCheckedAt: Pair<Double, Double>? = null

    init { loadParks() }

    fun start(features: JSONObject) {
        val fs = features.getJSONArray("features")
        points = (0 until fs.length()).mapNotNull { i ->
            val f = fs.getJSONObject(i)
            val g = f.optJSONObject("geometry") ?: return@mapNotNull null
            if (g.optString("type") != "Point") return@mapNotNull null
            val c = g.getJSONArray("coordinates")
            val p = f.getJSONObject("properties")
            val q = p.optJSONObject("sound") ?: JSONObject()
            val px = q.optJSONObject("px") ?: JSONObject()
            val mode = p.optString("audio_mode", "")
            val centroid = p.optJSONObject("audio")?.optDouble("centroid_hz", 2000.0) ?: 2000.0
            Point(id = p.optString("id"), name = p.optString("name", "Unnamed point").ifEmpty { "Unnamed point" },
                  lon = c.getDouble(0), lat = c.getDouble(1), radius = q.optDouble("radius", 140.0), gain = q.optDouble("gain", 0.9),
                  stretch = q.optDouble("stretch", 0.0).toFloat(),
                  windowSamples = 2.0.pow((7 + 10 * px.optDouble("fft", 0.7).coerceIn(0.0, 1.0)).roundToInt().toDouble()),  // pxBufsize
                  brightest = (if (centroid.isNaN()) 2000.0 else centroid).times(2.2).coerceIn(600.0, 14000.0),
                  path = p.optString("storage_path").ifEmpty { null },
                  sounds = p.optBoolean("has_audio") && mode != "hits" && mode != "grains")
        }
    }

    @SuppressLint("MissingPermission")
    fun listen() {
        val lm = context.getSystemService(LocationManager::class.java)
        runCatching { lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000L, 2f, this, Looper.getMainLooper()) }
            .onFailure { mode = Mode.Denied }
    }

    fun denied() { mode = Mode.Denied }

    override fun onLocationChanged(l: Location) {
        val acc = l.accuracy.toDouble()
        here = l.longitude to l.latitude
        if (acc > Core.GPS_ACC_MAX) { mode = Mode.Holding(acc); return }
        mode = Mode.Live(acc)
        step(l.longitude, l.latitude)
    }

    fun step(lon: Double, lat: Double) {
        val n = points.size
        val dist = DoubleArray(n) { Core.geoDistance(lon, lat, points[it].lon, points[it].lat) }
        val radius = DoubleArray(n) { points[it].radius }
        val eligible = BooleanArray(n) { points[it].sounds }
        val chosen = Core.pickVoices(dist, radius, eligible, Core.SLOTS, false).toList()
        val want = chosen.map { points[it].id }.toSet()
        for ((id, slot) in slotOf.toMap()) if (id !in want) {                // left: fade, free after the ramp
            Core.gain(slot, 0f)
            slotOf.remove(id); loaded.remove(id); phase.remove(id); earned.remove(id); released[slot] = System.currentTimeMillis()
        }
        for (j in chosen) {
            val p = points[j]
            if (p.id !in slotOf) freeSlot()?.let { slotOf[p.id] = it; begin(p, it) }
            val slot = slotOf[p.id] ?: continue
            earned[p.id] = Core.pointGain(dist[j], p.radius, p.gain).toFloat()
            Core.gain(slot, if (p.id in loaded) earned[p.id]!! else 0f)
            Core.lowpass(slot, (300 + (p.brightest - 300) * Core.pointProximity(dist[j], p.radius)).toFloat())   // ensureVoice
        }
        rows = chosen.map { j -> val p = points[j]; Row(p.id, p.name, Core.pointGain(dist[j], p.radius, 1.0), dist[j], phaseOf(p.id)) }
        nearest = if (rows.isEmpty()) (0 until n).filter { points[it].sounds }.minByOrNull { dist[it] }?.let {
            Nearest(points[it].name, dist[it], direction(lon, lat, points[it].lon, points[it].lat)) } else null
        updatePlace(lon, lat)
        Core.collect()
    }

    private fun phaseOf(id: String) = if (id in loaded) Phase.Playing else phase[id] ?: Phase.Decoding
    private fun refreshRows() { rows = rows.map { it.copy(phase = phaseOf(it.id)) } }

    private fun freeSlot(): Int? = (0 until Core.SLOTS).firstOrNull { s ->
        s !in slotOf.values && (released[s]?.let { System.currentTimeMillis() - it > 1200 } ?: true)
    }

    /** The point's own settings, then its recording: cache, else download, decode, hand over. */
    private fun begin(p: Point, slot: Int) {
        Core.param(slot, 0, p.stretch)
        Core.param(slot, 1, (p.windowSamples / engineRate).toFloat())
        val path = p.path ?: return
        Thread {
            try {
                val file = recording(path, p.id)
                main.post { phase[p.id] = Phase.Decoding; refreshRows() }
                val pcm = Decode.pcm(file)
                main.post {
                    if (slotOf[p.id] != slot) return@post
                    Core.loadInterleaved(slot, pcm.data, pcm.channels, pcm.frames, pcm.rate.toDouble())
                    loaded += p.id; phase.remove(p.id)
                    Core.gain(slot, earned[p.id] ?: 0f)              // sounds now, even standing still
                    refreshRows()
                }
            } catch (e: Exception) {
                main.post { failure = "Could not load ${p.name}: ${e.message}"; phase.remove(p.id); refreshRows() }
            }
        }.start()
    }

    /** Downloaded once, kept in the cache (the web keeps them in IndexedDB); progress reported. */
    private fun recording(path: String, id: String): File {
        val dir = File(context.cacheDir, "recordings").apply { mkdirs() }
        val file = File(dir, path.replace("/", "__"))
        if (file.exists() && file.length() > 0) return file
        val c = URL("${Supa.URL}/storage/v1/object/authenticated/recordings/$path").openConnection() as HttpURLConnection
        c.setRequestProperty("apikey", Supa.ANON); c.setRequestProperty("Authorization", "Bearer ${Supa.ANON}")
        if (c.responseCode != 200) throw IllegalStateException("HTTP ${c.responseCode}")
        val size = c.contentLengthLong
        val part = File(dir, file.name + ".part")
        c.inputStream.use { input -> part.outputStream().use { out ->
            val buf = ByteArray(64 * 1024); var got = 0L; var last = 0L
            while (true) {
                val k = input.read(buf); if (k < 0) break
                out.write(buf, 0, k); got += k
                if (got - last > 256 * 1024) { last = got; val f = if (size > 0) got.toDouble() / size else 0.0
                    main.post { phase[id] = Phase.Downloading(f, size); refreshRows() } }
            } } }
        part.renameTo(file)
        return file
    }

    /** The park underfoot (placeAt), re-asked only after a few metres (the web's PLACE_CHECK_M). */
    private fun updatePlace(lon: Double, lat: Double) {
        placeCheckedAt?.let { if (Core.geoDistance(it.first, it.second, lon, lat) < 5) return }
        placeCheckedAt = lon to lat
        place = parks.firstOrNull { (_, rings) -> rings.any { Core.pointInRing(lon, lat, it) } }?.first
    }

    private fun loadParks() {
        val fc = JSONObject(context.assets.open("places.geojson").bufferedReader().readText())
        val fs = fc.getJSONArray("features")
        for (i in 0 until fs.length()) {
            val f = fs.getJSONObject(i)
            val polys = f.getJSONObject("geometry").getJSONArray("coordinates")
            val rings = (0 until polys.length()).map { k ->
                val ring = polys.getJSONArray(k).getJSONArray(0)
                DoubleArray(ring.length() * 2) { m -> ring.getJSONArray(m / 2).getDouble(m % 2) }
            }
            parks += f.getJSONObject("properties").optString("name") to rings
        }
    }

    override fun onProviderEnabled(provider: String) {}
    override fun onProviderDisabled(provider: String) {}

    companion object {
        fun direction(lon1: Double, lat1: Double, lon2: Double, lat2: Double): String {
            val r = Math.PI / 180
            val y = sin((lon2 - lon1) * r) * cos(lat2 * r)
            val x = cos(lat1 * r) * sin(lat2 * r) - sin(lat1 * r) * cos(lat2 * r) * cos((lon2 - lon1) * r)
            val deg = (Math.toDegrees(atan2(y, x)) + 360) % 360
            return listOf("north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west")[((deg + 22.5) / 45).toInt() % 8]
        }
    }
}

/** The public Supabase project, with the anon key the web app ships. */
object Supa {
    const val URL = "https://ujdygmcpqsbyeysggypc.supabase.co"
    const val ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVqZHlnbWNwcXNieWV5c2dneXBjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwNDE4NDIsImV4cCI6MjEwNDYxNzg0Mn0.SJlrNKQftKxdM0G6f18e6PsRCvdhIH8fco5tW3CktwM"

    /** Published features as a GeoJSON FeatureCollection, id folded into properties as the web has it. */
    fun published(): JSONObject {
        val c = URL("$URL/rest/v1/public_features?select=id,kind,geometry,properties").openConnection() as HttpURLConnection
        c.setRequestProperty("apikey", ANON); c.setRequestProperty("Authorization", "Bearer $ANON")
        val rows = JSONArray(c.inputStream.bufferedReader().readText())
        val out = JSONArray()
        for (i in 0 until rows.length()) {
            val r = rows.getJSONObject(i)
            val p = r.optJSONObject("properties") ?: JSONObject()
            p.put("id", r.getString("id"))
            out.put(JSONObject().put("type", "Feature").put("geometry", r.get("geometry")).put("properties", p))
        }
        return JSONObject().put("type", "FeatureCollection").put("features", out)
    }
}
