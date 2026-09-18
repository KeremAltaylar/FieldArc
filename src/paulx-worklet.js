/* FieldArc's port of PaulXStretch — github.com/essej/paulxstretch (GPL-2; Nasca Octavian Paul,
   Xenakios). One file, two jobs: the AudioWorklet module the page loads through Tone's context,
   and a plain ES module the Node tests import. Every function names what it ports. */

/* ---------- Spectral modules: ProcessedStretch.h ---------- */

/* profile() */
export function pxProfile(fi, bwi) {
  var x = fi / bwi;
  x *= x;
  if (x > 14.71280603) { return 0; }
  return Math.exp(-x);
}

/* spectrum_spread(). f2 may be tmp itself — Tonal vs Noise calls it that way, and the aliasing
   is the original's, kept. */
export function pxSpread(nfreq, sr, tmp, f1, f2, bandwidth) {
  var minfreq = 20, maxfreq = 0.5 * sr, lmin = Math.log(minfreq), lmax = Math.log(maxfreq);
  var i, k, x, x0, x1, xp, y;
  for (i = 0; i < nfreq; i++) {
    x = Math.exp(lmin + (i / nfreq) * (lmax - lmin)) / maxfreq * nfreq;
    y = 0;
    x0 = Math.floor(x); if (x0 >= nfreq) { x0 = nfreq - 1; }
    x1 = x0 + 1; if (x1 >= nfreq) { x1 = nfreq - 1; }
    xp = x - x0;
    if (x < nfreq) { y = f1[x0] * (1 - xp) + f1[x1] * xp; }
    tmp[i] = y;
  }
  var n = 2, a = 1 - Math.pow(2, -bandwidth * bandwidth * 10);
  a = Math.pow(a, 8192 / nfreq * n);
  for (k = 0; k < n; k++) {
    tmp[0] = 0;
    for (i = 1; i < nfreq; i++) { tmp[i] = tmp[i - 1] * a + tmp[i] * (1 - a); }
    tmp[nfreq - 1] = 0;
    for (i = nfreq - 2; i > 0; i--) { tmp[i] = tmp[i + 1] * a + tmp[i] * (1 - a); }
  }
  f2[0] = 0;
  var ld = Math.log(maxfreq / minfreq);
  for (i = 1; i < nfreq; i++) {
    x = Math.log(((i / nfreq) * maxfreq) / minfreq) / ld * nfreq;
    y = 0;
    if (x > 0 && x < nfreq) {
      x0 = Math.floor(x); if (x0 >= nfreq) { x0 = nfreq - 1; }
      x1 = x0 + 1; if (x1 >= nfreq) { x1 = nfreq - 1; }
      xp = x - x0;
      y = tmp[x0] * (1 - xp) + tmp[x1] * xp;
    }
    f2[i] = y;
  }
}

/* spectrum_do_compressor() */
export function pxCompressor(nfreq, f1, f2, power) {
  var rms = 0, i;
  for (i = 0; i < nfreq; i++) { rms += f1[i] * f1[i]; }
  rms = Math.sqrt(rms / nfreq) * 0.1;
  if (rms < 1e-3) { rms = 1e-3; }
  var r = Math.pow(rms, -power);
  for (i = 0; i < nfreq; i++) { f2[i] = f1[i] * r; }
}

/* spectrum_do_tonal_vs_noise() */
export function pxTonalVsNoise(nfreq, sr, tmp, f1, f2, bandwidth, preserve) {
  pxSpread(nfreq, sr, tmp, f1, tmp, bandwidth);
  var i, x, s, r, mul;
  if (preserve >= 0) {
    mul = Math.pow(10, preserve) - 1;
    for (i = 0; i < nfreq; i++) {
      x = f1[i]; s = tmp[i] + 1e-6;
      r = x - s * mul;
      f2[i] = r < 0 ? 0 : r;
    }
  } else {
    mul = Math.pow(5, 1 + preserve) - 1;
    for (i = 0; i < nfreq; i++) {
      x = f1[i]; s = tmp[i] + 1e-6;
      r = x - s * mul + 0.1 * mul;
      f2[i] = r < 0 ? x : 0;
    }
  }
}

/* spectrum_do_harmonics(). The profile is exactly 0 once |fi|/bwi exceeds sqrt(14.71280603),
   so each harmonic visits only that window — the same result as visiting every bin. */
export function pxHarmonics(nfreq, sr, tmp, f1, f2, freq, bandwidth, nharmonics, gauss) {
  var i, nh, f, bwi, fi, lo, hi, reach;
  if (freq < 10) { freq = 10; }
  for (i = 0; i < nfreq; i++) { tmp[i] = 0; }
  for (nh = 1; nh <= nharmonics; nh++) {
    f = nh * freq;
    if (f >= sr / 2) { break; }
    bwi = (Math.pow(2, bandwidth / 1200) - 1) * f / (2 * sr);
    fi = f / sr;
    reach = 3.8358 * bwi;
    lo = Math.max(1, Math.floor((fi - reach) * 2 * nfreq));
    hi = Math.min(nfreq - 1, Math.ceil((fi + reach) * 2 * nfreq));
    for (i = lo; i <= hi; i++) { tmp[i] += pxProfile((i / nfreq * 0.5) - fi, bwi); }
  }
  var max = 0;
  for (i = 1; i < nfreq; i++) { if (tmp[i] > max) { max = tmp[i]; } }
  if (max < 1e-8) { max = 1e-8; }
  for (i = 1; i < nfreq; i++) {
    var a = tmp[i] / max;
    if (!gauss) { a = a < 0.368 ? 0 : 1; }
    f2[i] = f1[i] * a;
  }
}

/* spectrum_do_freq_shift(); the (int) cast truncates toward zero. */
export function pxFreqShift(nfreq, sr, f1, f2, hz) {
  var i, i2, ifreq = Math.trunc(hz / (sr * 0.5) * nfreq);
  for (i = 0; i < nfreq; i++) { f2[i] = 0; }
  for (i = 0; i < nfreq; i++) {
    i2 = ifreq + i;
    if (i2 > 0 && i2 < nfreq) { f2[i2] = f1[i]; }
  }
}

/* spectrum_do_pitch_shift(), with the port's one deviation: the original sums magnitudes going
   down (+6 dB at two octaves) and duplicates bins going up. This sums power down and scales by
   1/sqrt(ratio) up, so pitch never moves the level (rulebook A-18). */
export function pxPitchShift(nfreq, f1, f2, ratio) {
  var i, i2;
  for (i = 0; i < nfreq; i++) { f2[i] = 0; }
  if (ratio < 1) {
    for (i = 0; i < nfreq; i++) {
      i2 = Math.floor(i * ratio);
      if (i2 >= nfreq) { break; }
      f2[i2] += f1[i] * f1[i];
    }
    for (i = 0; i < nfreq; i++) { f2[i] = Math.sqrt(f2[i]); }
  } else {
    var inv = 1 / ratio, g = 1 / Math.sqrt(ratio);
    for (i = 0; i < nfreq; i++) { f2[i] = f1[Math.floor(i * inv)] * g; }
  }
}

/* spectrum_do_ratiomix() */
export function pxRatioMix(nfreq, f1, f2, tmp, sum, ratios, levels) {
  var i, k, lv, ra, total = 0.01;
  for (i = 0; i < nfreq; i++) { sum[i] = 0; }
  for (k = 0; k < ratios.length; k++) {
    lv = levels[k]; ra = ratios[k];
    total += lv;
    if (lv > 1e-3 && ra > 0) {
      pxPitchShift(nfreq, f1, tmp, ra);
      for (i = 0; i < nfreq; i++) { sum[i] += tmp[i] * lv; }
    }
  }
  if (total < 0.5) { total = 0.5; }
  for (i = 0; i < nfreq; i++) { f2[i] = sum[i] / total; }
}

/* spectrum_do_filter() */
export function pxFilter(nfreq, sr, f1, f2, low, high, stop, hdamp) {
  var lo = low, hi = high, i, a;
  if (!(low < high)) { lo = high; hi = low; }
  var ilow = Math.trunc(lo / sr * nfreq * 2), ihigh = Math.trunc(hi / sr * nfreq * 2);
  var dmp = 1, dmprap = 1 - Math.pow((hdamp || 0) * 0.5, 4);
  for (i = 0; i < nfreq; i++) {
    a = (i >= ilow && i < ihigh) ? 1 : 0;
    if (stop) { a = 1 - a; }
    f2[i] = f1[i] * a * dmp;
    dmp *= dmprap + 1e-8;
  }
}

/* ProcessedStretch::process_spectrum() in PaulXStretch's default module order (Free filter
   omitted). Each enabled module reads a copy and writes back into freq; bins it does not write
   keep their value, as in the original. Yields after each module. */
export var PX_CHAIN = ["harmonics", "tonal", "fshift", "pitch", "ratios", "spread", "filter", "compress"];
export function* pxChainSteps(ws, nfreq, sr, p, freq) {
  var m = p.mods || {}, inf = ws.infreq, k, c;
  for (k = 0; k < PX_CHAIN.length; k++) {
    c = m[PX_CHAIN[k]];
    if (!c || !c.on) { continue; }
    inf.set(freq);
    switch (PX_CHAIN[k]) {
      case "harmonics": pxHarmonics(nfreq, sr, ws.tmp, inf, freq, c.freq, c.bw, c.n, c.gauss); break;
      case "tonal": pxTonalVsNoise(nfreq, sr, ws.tmp, inf, freq, c.bw, c.preserve); break;
      case "fshift": pxFreqShift(nfreq, sr, inf, freq, c.hz); break;
      case "pitch": pxPitchShift(nfreq, inf, freq, Math.pow(2, c.st / 12)); break;
      case "ratios": pxRatioMix(nfreq, inf, freq, ws.tmp, ws.sum, c.r, c.l); break;
      case "spread": pxSpread(nfreq, sr, ws.tmp, inf, freq, c.bw); break;
      case "filter": pxFilter(nfreq, sr, inf, freq, c.low, c.high, c.stop, 0); break;
      case "compress": pxCompressor(nfreq, inf, freq, c.power); break;
    }
    yield;
  }
}
