package net.keremaltaylar.fieldscape

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Text
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color

class MainActivity : ComponentActivity() {
    override fun onCreate(saved: Bundle?) {
        super.onCreate(saved)
        val rms = Core.selfTestRms()
        setContent {
            Box(Modifier.fillMaxSize().background(Color(0xFF0D1310)), contentAlignment = Alignment.Center) {
                Text("Fieldscape core: sine RMS %.4f".format(rms), color = Color(0xFFE3E7E4))
            }
        }
    }
}
