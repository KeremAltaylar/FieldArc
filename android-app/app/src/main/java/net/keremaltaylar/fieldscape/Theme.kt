package net.keremaltaylar.fieldscape

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Design System/Tokens.md, as ios/Theme.swift has it (the web's own OKLCH values, to the digit). */
object T {
    val sunk = Color(0xFF0D1310); val ground = Color(0xFF19211D); val panel = Color(0xFF222B27); val raised = Color(0xFF2E3833); val hairline = Color(0xFF36403B)
    val ink = Color(0xFFE3E7E4); val dim = Color(0xFFB3B9B4); val faint = Color(0xFF9CA49D)
    val accent = Color(0xFFBBCEB5); val lamp = Color(0xFFBAE6B1)

    val display = FontFamily(Font(R.font.cormorant_garamond, FontWeight.SemiBold))
    val body = FontFamily(Font(R.font.newsreader, FontWeight.Normal), Font(R.font.newsreader, FontWeight.Medium))
    val mono = FontFamily(Font(R.font.courier_prime))

    val xs = 10.88.sp; val sm = 12.48.sp; val base = 17.sp; val md = 18.4.sp
    val s1 = 4.dp; val s2 = 8.dp; val s3 = 12.dp; val s4 = 16.dp; val s5 = 24.dp
    val target = 48.dp          // Android's touch target (Material), the M-4 floor here
}
