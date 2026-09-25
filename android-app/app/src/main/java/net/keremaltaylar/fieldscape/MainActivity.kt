package net.keremaltaylar.fieldscape

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import org.json.JSONObject
import org.maplibre.android.MapLibre
import org.maplibre.android.camera.CameraUpdateFactory
import org.maplibre.android.geometry.LatLng
import org.maplibre.android.geometry.LatLngBounds
import org.maplibre.android.maps.MapView
import org.maplibre.android.maps.Style
import org.maplibre.android.style.sources.GeoJsonSource
import java.io.File

/** The map fills the screen; the walk panel lies over its foot and hugs its content, as on iOS. */
class MainActivity : ComponentActivity() {
    private lateinit var walk: Walk
    private var features by mutableStateOf<JSONObject?>(null)
    private var failed by mutableStateOf<String?>(null)

    private val ask = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { r ->
        if (r.values.any { it }) walk.listen() else walk.denied()
    }

    override fun onCreate(saved: Bundle?) {
        super.onCreate(saved)
        MapLibre.getInstance(this)
        walk = Walk(this, Core.start())
        Thread {
            runCatching { Supa.published() }
                .onSuccess { f -> runOnUiThread { features = f; walk.start(f); locate() } }
                .onFailure { e -> runOnUiThread { failed = "The map could not load: ${e.message}. Check the connection and reopen the app." } }
        }.start()
        setContent { Screen() }
    }

    private fun locate() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) walk.listen()
        else ask.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
    }

    @Composable
    private fun Screen() {
        var developer by remember { mutableStateOf(false) }
        Box(Modifier.fillMaxSize().background(T.ground)) {
            features?.let { Map(it) } ?: Text(failed ?: "Loading the map…", Modifier.align(Alignment.Center), color = T.dim,
                                              style = TextStyle(fontFamily = T.body, fontSize = T.sm))
            Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth()
                .clip(RoundedCornerShape(topStart = 20.dp_, topEnd = 20.dp_)).background(T.panel)
                .navigationBarsPadding().padding(start = T.s4, end = T.s4, top = T.s2, bottom = T.s5),
                verticalArrangement = Arrangement.spacedBy(T.s3)) {
                Box(Modifier.align(Alignment.CenterHorizontally).size(38.dp_, 4.dp_).clip(CircleShape).background(T.hairline))
                Panel(onLongPress = { developer = !developer })
                if (developer) Text(String.format("engine: worst %.2f ms per burst of %d frames · xruns %d · out %.1f dBFS",
                    Core.worstMs(), Core.bufferFrames(), Core.xruns(), Core.outputDb()), color = T.faint,
                    style = TextStyle(fontFamily = T.mono, fontSize = T.xs))
            }
        }
    }

    @Composable
    private fun Panel(onLongPress: () -> Unit) {
        val mode = walk.mode
        Row(Modifier.fillMaxWidth().pointerInput(Unit) { detectTapGestures(onLongPress = { onLongPress() }) },
            verticalAlignment = Alignment.CenterVertically) {
            Text(if (mode == Walk.Mode.Denied) "Location is off" else walk.place ?: "Fieldscape", Modifier.weight(1f),
                 color = T.ink, style = TextStyle(fontFamily = T.display, fontSize = T.md), maxLines = 1)
            when (mode) {
                is Walk.Mode.Live -> Chip(String.format("±%.0f m", mode.accuracy))
                is Walk.Mode.Holding -> Chip(String.format("±%.0f m · HOLDING", mode.accuracy))
                else -> {}
            }
        }
        when (mode) {
            Walk.Mode.Denied -> {
                Note("Fieldscape plays the recordings placed around you, so it needs to know where you are while the app is open.")
                Box(Modifier.fillMaxWidth().heightIn(min = T.target).clip(RoundedCornerShape(10.dp_)).background(T.raised)
                    .border(1.dp_, T.hairline, RoundedCornerShape(10.dp_))
                    .clickable { startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null))) },
                    contentAlignment = Alignment.Center) {
                    Text("Open Settings", color = T.ink, style = TextStyle(fontFamily = T.body, fontSize = T.sm))
                }
                Note("Settings → Apps → Fieldscape → Permissions → Location → Allow only while using the app")
            }
            Walk.Mode.Waiting -> Note("Finding where you are…")
            else -> Hearing()
        }
        walk.failure?.let { Note(it) }
    }

    @Composable
    private fun Hearing() {
        val rows = walk.rows
        if (rows.isEmpty()) {
            val n = walk.nearest
            if (n != null) Text(buildAnnotatedString {
                withStyle(SpanStyle(color = T.ink)) { append("Nothing in range here. ") }
                append("The nearest recording is ")
                withStyle(SpanStyle(color = T.ink)) { append(n.name) }
                append(", ")
                withStyle(SpanStyle(fontFamily = T.mono)) { append(String.format("%.0f m", n.dist)) }
                append(" ${n.direction}.")
            }, color = T.dim, style = TextStyle(fontFamily = T.body, fontSize = T.sm))
            else Note("No recordings are published yet.")
        } else {
            Column {
                rows.forEachIndexed { i, r ->
                    if (i > 0) Box(Modifier.fillMaxWidth().height(1.dp_).background(T.hairline))
                    RowView(r)
                }
            }
            if (rows.any { it.phase is Walk.Phase.Downloading }) Note("First time here: each recording downloads once, then plays offline.")
        }
        if (walk.mode is Walk.Mode.Holding) Note("GPS is too rough here, so the sound holds where you last were until the fix is better than 40 m.")
    }

    @Composable
    private fun RowView(r: Walk.Row) {
        val (detail, fill, color) = when (val p = r.phase) {
            Walk.Phase.Playing -> Triple(String.format("%.0f m", r.dist), r.level.coerceIn(0.0, 1.0), T.accent)
            Walk.Phase.Decoding -> Triple("Preparing", 1.0, T.faint.copy(alpha = 0.6f))
            is Walk.Phase.Downloading -> Triple(if (p.bytes > 0) String.format("Downloading · %.1f MB", p.bytes / 1048576.0) else "Downloading",
                                                p.fraction, T.faint.copy(alpha = 0.6f))
        }
        Column(Modifier.fillMaxWidth().heightIn(min = T.target).padding(vertical = T.s2), verticalArrangement = Arrangement.spacedBy(T.s1)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(9.dp_).clip(CircleShape).background(T.lamp))
                Spacer(Modifier.width(T.s2))
                Text(r.name, Modifier.weight(1f), color = T.ink, style = TextStyle(fontFamily = T.body, fontSize = T.base), maxLines = 1)
                Text(detail, color = T.dim, style = TextStyle(fontFamily = T.mono, fontSize = T.sm))
            }
            Box(Modifier.fillMaxWidth().height(5.dp_).clip(CircleShape).background(T.raised)) {
                Box(Modifier.fillMaxWidth(fill.toFloat()).fillMaxHeight().clip(CircleShape).background(color))
            }
        }
    }

    @Composable private fun Chip(s: String) = Text(s, Modifier.border(1.dp_, T.hairline, RoundedCornerShape(5.dp_)).padding(horizontal = 6.dp_, vertical = 4.dp_),
        color = T.faint, style = TextStyle(fontFamily = T.mono, fontSize = T.xs))
    @Composable private fun Note(s: String) = Text(s, color = T.dim, style = TextStyle(fontFamily = T.body, fontSize = T.sm))

    /** MapLibre with the web's style (index.html "Map"), the published features inline, and the walker. */
    @Composable
    private fun Map(fc: JSONObject) {
        val here = walk.here
        val state = remember { object { var style: Style? = null; var map: org.maplibre.android.maps.MapLibreMap? = null; var centredAt: Pair<Double, Double>? = null } }
        AndroidView(factory = { ctx ->
            MapView(ctx).apply {
                onCreate(null); onStart(); onResume()
                getMapAsync { map ->
                    state.map = map
                    map.uiSettings.isLogoEnabled = false
                    map.uiSettings.attributionGravity = android.view.Gravity.TOP or android.view.Gravity.START
                    map.uiSettings.setAttributionTintColor(android.graphics.Color.rgb(0x9c, 0xa4, 0x9d))   // T.faint
                    map.setStyle(Style.Builder().fromJson(styleJson(fc))) { style ->
                        state.style = style
                        bounds(fc)?.let { map.moveCamera(CameraUpdateFactory.newLatLngBounds(it, 80)) }
                    }
                }
            }
        }, Modifier.fillMaxSize(), update = {
            val style = state.style ?: return@AndroidView
            here?.let { (lon, lat) ->
                (style.getSource("me") as? GeoJsonSource)?.setGeoJson("""{"type":"Point","coordinates":[$lon,$lat]}""")
                /* Street level on the walker; again if a fix lands far from there (a stale first fix,
                   or the emulator's default position, would otherwise keep the map in the wrong city). */
                val c = state.centredAt
                if (c == null || Core.geoDistance(c.first, c.second, lon, lat) > 1000) {
                    state.centredAt = lon to lat
                    state.map?.animateCamera(CameraUpdateFactory.newLatLngZoom(LatLng(lat, lon), 15.5))
                }
            }
        })
    }

    private fun styleJson(fc: JSONObject) = """
    {"version":8,"sources":{
      "base-sat":{"type":"raster","tileSize":256,"maxzoom":19,"attribution":"Imagery © Esri",
                  "tiles":["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"]},
      "features":{"type":"geojson","data":$fc},
      "me":{"type":"geojson","data":{"type":"FeatureCollection","features":[]}}},
     "layers":[
      {"id":"ground","type":"background","paint":{"background-color":"#0d1310"}},
      {"id":"base-sat","type":"raster","source":"base-sat"},
      {"id":"route-casing","type":"line","source":"features","filter":["==",["geometry-type"],"LineString"],
       "paint":{"line-color":"#0d1310","line-opacity":0.8,"line-width":8},"layout":{"line-cap":"round","line-join":"round"}},
      {"id":"route-line","type":"line","source":"features","filter":["==",["geometry-type"],"LineString"],
       "paint":{"line-color":"#ffffff","line-width":3},"layout":{"line-cap":"round","line-join":"round"}},
      {"id":"point-halo","type":"circle","source":"features","filter":["==",["geometry-type"],"Point"],
       "paint":{"circle-radius":["interpolate",["linear"],["zoom"],10,["case",["has","icon"],8,6],13,["case",["has","icon"],17,12]],
                "circle-color":"#0d1310","circle-opacity":0.22,"circle-blur":0.7}},
      {"id":"point-dot","type":"circle","source":"features","filter":["==",["geometry-type"],"Point"],
       "paint":{"circle-radius":["interpolate",["linear"],["zoom"],10,["case",["has","icon"],5.5,3.5],13,["case",["has","icon"],11.5,6.5]],
                "circle-color":["case",["==",["get","has_audio"],true],"#bae6b1","#0d1310"],
                "circle-stroke-width":["interpolate",["linear"],["zoom"],10,1.2,13,2.2],
                "circle-stroke-color":["case",["==",["get","has_audio"],true],"#0d1310","#e3e7e4"]}},
      {"id":"me","type":"circle","source":"me","paint":{"circle-radius":8,"circle-color":"#3b82f6","circle-stroke-width":2.5,"circle-stroke-color":"#ffffff"}}
     ]}"""

    private fun bounds(fc: JSONObject): LatLngBounds? {
        val b = LatLngBounds.Builder(); var n = 0
        fun add(c: Any?) {
            if (c is org.json.JSONArray) {
                if (c.length() >= 2 && c.opt(0) is Number) { b.include(LatLng(c.getDouble(1), c.getDouble(0))); n++ }
                else for (i in 0 until c.length()) add(c.get(i))
            }
        }
        val fs = fc.getJSONArray("features")
        for (i in 0 until fs.length()) add(fs.getJSONObject(i).optJSONObject("geometry")?.opt("coordinates"))
        return if (n >= 2) b.build() else null
    }
}

/* dp for literal sizes that are drawings rather than tokens (the grip, a dot, a hairline). */
private val Int.dp_ get() = androidx.compose.ui.unit.Dp(this.toFloat())
private val Double.dp_ get() = androidx.compose.ui.unit.Dp(this.toFloat())
