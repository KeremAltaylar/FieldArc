/* Fieldscape's port of PaulXStretch — github.com/essej/paulxstretch (GPL-2; Nasca Octavian Paul,
   Xenakios). Every function names what it ports.

   One file, two jobs: the AudioWorklet module the page loads through Tone's context, and the
   module the Node tests import. No `export`: Tone loads worklets through
   standardized-audio-context, which re-evaluates the text inside a wrapper function, where
   `export` is a syntax error (measured in Chrome, 2026-09-18). The API is on globalThis.PaulX. */

/* ---------- Spectral modules: ProcessedStretch.h ---------- */

/* profile() */
function pxProfile(fi, bwi) {
  var x = fi / bwi;
  x *= x;
  if (x > 14.71280603) { return 0; }
  return Math.exp(-x);
}

/* How many bins a heavy loop processes between yields. Measured in Chrome: Spread over 65536 bins
   took 6 ms and Harmonics x100 17 ms in one piece, against a 2.67 ms render quantum. */
var PX_SLICE = 1024;

/* The step generators are what the worklet runs; the plain functions drain them in one go. */
function pxSpread(nfreq, sr, tmp, f1, f2, bandwidth) { pxRun(pxSpreadSteps(nfreq, sr, tmp, f1, f2, bandwidth)); }
function pxTonalVsNoise(nfreq, sr, tmp, f1, f2, bandwidth, preserve) {
  pxRun(pxTonalVsNoiseSteps(nfreq, sr, tmp, f1, f2, bandwidth, preserve));
}
function pxHarmonics(nfreq, sr, tmp, f1, f2, freq, bandwidth, nharmonics, gauss) {
  pxRun(pxHarmonicsSteps(nfreq, sr, tmp, f1, f2, freq, bandwidth, nharmonics, gauss));
}
function pxRatioMix(nfreq, f1, f2, tmp, sum, ratios, levels) {
  pxRun(pxRatioMixSteps(nfreq, f1, f2, tmp, sum, ratios, levels));
}

/* spectrum_spread(). f2 may be tmp itself — Tonal vs Noise calls it that way, and the aliasing
   is the original's, kept. */
function* pxSpreadSteps(nfreq, sr, tmp, f1, f2, bandwidth) {
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
    if (i % PX_SLICE === PX_SLICE - 1) { yield; }
  }
  var n = 2, a = 1 - Math.pow(2, -bandwidth * bandwidth * 10);
  a = Math.pow(a, 8192 / nfreq * n);
  /* Flushed below 1e-30: the recursion decays runs of zeros (left by Tonal vs Noise or
     Harmonics) into denormals, which measured 5.7 ms for one pass at 131072 bins. The original
     runs with the CPU's flush-to-zero set; this is the same thing, done by hand. */
  var v;
  for (k = 0; k < n; k++) {
    tmp[0] = 0;
    for (i = 1; i < nfreq; i++) { v = tmp[i - 1] * a + tmp[i] * (1 - a); tmp[i] = v < 1e-30 ? 0 : v; }
    yield;
    tmp[nfreq - 1] = 0;
    for (i = nfreq - 2; i > 0; i--) { v = tmp[i + 1] * a + tmp[i] * (1 - a); tmp[i] = v < 1e-30 ? 0 : v; }
    yield;
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
    if (i % PX_SLICE === 0) { yield; }
  }
}

/* Cheap per-bin loops yield less often than the exp/log-heavy ones. */
var PX_WIDE = 8192;
function pxCompressor(nfreq, f1, f2, power) { pxRun(pxCompressorSteps(nfreq, f1, f2, power)); }
function pxFreqShift(nfreq, sr, f1, f2, hz) { pxRun(pxFreqShiftSteps(nfreq, sr, f1, f2, hz)); }
function pxPitchShift(nfreq, f1, f2, ratio) { pxRun(pxPitchShiftSteps(nfreq, f1, f2, ratio)); }
function pxFilter(nfreq, sr, f1, f2, low, high, stop, hdamp) {
  pxRun(pxFilterSteps(nfreq, sr, f1, f2, low, high, stop, hdamp));
}

/* spectrum_do_compressor() */
function* pxCompressorSteps(nfreq, f1, f2, power) {
  var rms = 0, i;
  for (i = 0; i < nfreq; i++) { rms += f1[i] * f1[i]; if (i % PX_WIDE === PX_WIDE - 1) { yield; } }
  rms = Math.sqrt(rms / nfreq) * 0.1;
  if (rms < 1e-3) { rms = 1e-3; }
  var r = Math.pow(rms, -power);
  for (i = 0; i < nfreq; i++) { f2[i] = f1[i] * r; if (i % PX_WIDE === PX_WIDE - 1) { yield; } }
}

/* spectrum_do_tonal_vs_noise() */
function* pxTonalVsNoiseSteps(nfreq, sr, tmp, f1, f2, bandwidth, preserve) {
  yield* pxSpreadSteps(nfreq, sr, tmp, f1, tmp, bandwidth);
  var i, x, s, r, mul;
  if (preserve >= 0) {
    mul = Math.pow(10, preserve) - 1;
    for (i = 0; i < nfreq; i++) {
      x = f1[i]; s = tmp[i] + 1e-6;
      r = x - s * mul;
      f2[i] = r < 0 ? 0 : r;
      if (i % PX_WIDE === PX_WIDE - 1) { yield; }
    }
  } else {
    mul = Math.pow(5, 1 + preserve) - 1;
    for (i = 0; i < nfreq; i++) {
      x = f1[i]; s = tmp[i] + 1e-6;
      r = x - s * mul + 0.1 * mul;
      f2[i] = r < 0 ? x : 0;
      if (i % PX_WIDE === PX_WIDE - 1) { yield; }
    }
  }
}

/* spectrum_do_harmonics(). The profile is exactly 0 once |fi|/bwi exceeds sqrt(14.71280603),
   so each harmonic visits only that window — the same result as visiting every bin. */
function* pxHarmonicsSteps(nfreq, sr, tmp, f1, f2, freq, bandwidth, nharmonics, gauss) {
  var i, nh, f, bwi, fi, lo, hi, reach, done = 0;
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
    for (i = lo; i <= hi; i++) {
      tmp[i] += pxProfile((i / nfreq * 0.5) - fi, bwi);
      if (++done % PX_SLICE === 0) { yield; }
    }
  }
  var max = 0;
  for (i = 1; i < nfreq; i++) { if (tmp[i] > max) { max = tmp[i]; } }
  if (max < 1e-8) { max = 1e-8; }
  yield;
  for (i = 1; i < nfreq; i++) {
    var a = tmp[i] / max;
    if (!gauss) { a = a < 0.368 ? 0 : 1; }
    f2[i] = f1[i] * a;
    if (i % PX_WIDE === 0) { yield; }
  }
}

/* spectrum_do_freq_shift(); the (int) cast truncates toward zero. */
function* pxFreqShiftSteps(nfreq, sr, f1, f2, hz) {
  var i, i2, ifreq = Math.trunc(hz / (sr * 0.5) * nfreq);
  for (i = 0; i < nfreq; i++) { f2[i] = 0; }
  yield;
  for (i = 0; i < nfreq; i++) {
    i2 = ifreq + i;
    if (i2 > 0 && i2 < nfreq) { f2[i2] = f1[i]; }
    if (i % PX_WIDE === PX_WIDE - 1) { yield; }
  }
}

/* spectrum_do_pitch_shift(), with the port's one deviation: the original sums magnitudes going
   down (+6 dB at two octaves) and duplicates bins going up. This sums power down and scales by
   1/sqrt(ratio) up, so pitch never moves the level (rulebook A-18). */
function* pxPitchShiftSteps(nfreq, f1, f2, ratio) {
  var i, i2;
  for (i = 0; i < nfreq; i++) { f2[i] = 0; }
  yield;
  if (ratio < 1) {
    for (i = 0; i < nfreq; i++) {
      i2 = Math.floor(i * ratio);
      if (i2 >= nfreq) { break; }
      f2[i2] += f1[i] * f1[i];
      if (i % PX_WIDE === PX_WIDE - 1) { yield; }
    }
    for (i = 0; i < nfreq; i++) { f2[i] = Math.sqrt(f2[i]); if (i % PX_WIDE === PX_WIDE - 1) { yield; } }
  } else {
    var inv = 1 / ratio, g = 1 / Math.sqrt(ratio);
    for (i = 0; i < nfreq; i++) {
      f2[i] = f1[Math.floor(i * inv)] * g;
      if (i % PX_WIDE === PX_WIDE - 1) { yield; }
    }
  }
}

/* spectrum_do_ratiomix() */
function* pxRatioMixSteps(nfreq, f1, f2, tmp, sum, ratios, levels) {
  var i, k, lv, ra, total = 0.01;
  for (i = 0; i < nfreq; i++) { sum[i] = 0; }
  for (k = 0; k < ratios.length; k++) {
    lv = levels[k]; ra = ratios[k];
    total += lv;
    if (lv > 1e-3 && ra > 0) {
      yield* pxPitchShiftSteps(nfreq, f1, tmp, ra);
      for (i = 0; i < nfreq; i++) { sum[i] += tmp[i] * lv; if (i % PX_WIDE === PX_WIDE - 1) { yield; } }
    }
  }
  if (total < 0.5) { total = 0.5; }
  for (i = 0; i < nfreq; i++) { f2[i] = sum[i] / total; if (i % PX_WIDE === PX_WIDE - 1) { yield; } }
}

/* spectrum_do_filter() */
function* pxFilterSteps(nfreq, sr, f1, f2, low, high, stop, hdamp) {
  var lo = low, hi = high, i, a;
  if (!(low < high)) { lo = high; hi = low; }
  var ilow = Math.trunc(lo / sr * nfreq * 2), ihigh = Math.trunc(hi / sr * nfreq * 2);
  var dmp = 1, dmprap = 1 - Math.pow((hdamp || 0) * 0.5, 4);
  for (i = 0; i < nfreq; i++) {
    a = (i >= ilow && i < ihigh) ? 1 : 0;
    if (stop) { a = 1 - a; }
    f2[i] = f1[i] * a * dmp;
    dmp *= dmprap + 1e-8;
    if (i % PX_WIDE === PX_WIDE - 1) { yield; }
  }
}

/* ProcessedStretch::process_spectrum() in PaulXStretch's default module order (Free filter
   omitted). Each enabled module reads a copy and writes back into freq; bins it does not write
   keep their value, as in the original. Yields after each module. */
var PX_CHAIN = ["harmonics", "tonal", "fshift", "pitch", "ratios", "spread", "filter", "compress"];
function* pxChainSteps(ws, nfreq, sr, p, freq) {
  var m = p.mods || {}, inf = ws.infreq, k, c;
  for (k = 0; k < PX_CHAIN.length; k++) {
    c = m[PX_CHAIN[k]];
    if (!c || !c.on) { continue; }
    inf.set(freq);
    switch (PX_CHAIN[k]) {
      case "harmonics": yield* pxHarmonicsSteps(nfreq, sr, ws.tmp, inf, freq, c.freq, c.bw, c.n, c.gauss); break;
      case "tonal": yield* pxTonalVsNoiseSteps(nfreq, sr, ws.tmp, inf, freq, c.bw, c.preserve); break;
      case "fshift": yield* pxFreqShiftSteps(nfreq, sr, inf, freq, c.hz); break;
      case "pitch": yield* pxPitchShiftSteps(nfreq, inf, freq, Math.pow(2, c.st / 12)); break;
      case "ratios": yield* pxRatioMixSteps(nfreq, inf, freq, ws.tmp, ws.sum, c.r, c.l); break;
      case "spread": yield* pxSpreadSteps(nfreq, sr, ws.tmp, inf, freq, c.bw); break;
      case "filter": yield* pxFilterSteps(nfreq, sr, inf, freq, c.low, c.high, c.stop, 0); break;
      case "compress": yield* pxCompressorSteps(nfreq, inf, freq, c.power); break;
    }
    yield;
  }
}

/* ---------- The engine: Stretch.cpp ---------- */

/* Drains a generator. The worklet steps the same generators a few at a time instead. */
function pxRun(gen) {
  var r, steps = 0;
  do { r = gen.next(); steps++; } while (!r.done);
  return { value: r.value, steps: steps };
}

/* FFT::applywindow() W_HAMMING — the plugin's windowing type 1. */
function pxHamming(n) {
  var w = new Float64Array(n);
  for (var i = 0; i < n; i++) { w[i] = 0.53836 - 0.46164 * Math.cos(2 * Math.PI * i / (n + 1)); }
  return w;
}

/* Radix-2 complex FFT in place: forward unnormalised like FFTW, inverse divided by n (the
   original's HC2R followed by 1/nsamples). Twiddles come from a per-size table. It yields every
   4096 butterflies, so a large transform spreads across many render quanta. */
var pxTwiddles = {};
function pxTwiddle(n) {
  var t = pxTwiddles[n];
  if (!t) {
    t = { c: new Float64Array(n / 2), s: new Float64Array(n / 2) };
    for (var k = 0; k < n / 2; k++) { t.c[k] = Math.cos(2 * Math.PI * k / n); t.s[k] = Math.sin(2 * Math.PI * k / n); }
    pxTwiddles[n] = t;
  }
  return t;
}
function* pxFftSteps(re, im, inverse) {
  var n = re.length, i, j, bit, t, len, half, step, start, k, tw = pxTwiddle(n), ops = 0;
  var sgn = inverse ? 1 : -1, cr, ci, ur, ui, vr, vi, a, b;
  for (i = 1, j = 0; i < n; i++) {
    bit = n >> 1;
    for (; j & bit; bit >>= 1) { j ^= bit; }
    j ^= bit;
    if (i < j) { t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    if ((i & 8191) === 0) { yield; }
  }
  yield;
  for (len = 2; len <= n; len <<= 1) {
    half = len >> 1; step = n / len;
    for (start = 0; start < n; start += len) {
      for (k = 0; k < half; k++) {
        cr = tw.c[k * step]; ci = sgn * tw.s[k * step];
        a = start + k; b = a + half;
        vr = re[b] * cr - im[b] * ci; vi = re[b] * ci + im[b] * cr;
        ur = re[a]; ui = im[a];
        re[a] = ur + vr; im[a] = ui + vi;
        re[b] = ur - vr; im[b] = ui - vi;
      }
      ops += half;
      if (ops >= 4096) { ops = 0; yield; }
    }
  }
  if (inverse) {
    for (i = 0; i < n; i++) {
      re[i] /= n; im[i] /= n;
      if ((i & 16383) === 16383) { yield; }
    }
  }
}

/* Stretch::do_detect_onset(). osincold is never reset inside the loop — as in the original. */
function pxOnset(bufsize, sr, now, old, sens) {
  if (!(sens > 1e-3)) { return 0; }
  var os = 0, osinc = 0, osincold = 1e-5, maxk = 1 + Math.trunc(bufsize * 500 / (sr * 0.5)), k = 0, i;
  for (i = 0; i < bufsize; i++) {
    osinc += now[i] - old[i];
    osincold += old[i];
    if (k >= maxk) { k = 0; os += osinc / osincold; osinc = 0; }
    k++;
  }
  os += osinc;
  if (os < 0) { os = 0; }
  var st = Math.pow(20, 1 - sens) - 1, sth = st * 0.75, r = 0;
  if (os > sth) { r = (os - sth) / (st - sth); if (r > 1) { r = 1; } }
  return r;
}

/* Stretch::process(), "make the output buffer": the new frame's second half crossfaded with the
   previous frame's first half, the power dip of two uncorrelated signals at the midpoint
   corrected, and ampfactor 2. */
function pxOutputHop(bufsize, cur, old, out) {
  var t = Math.PI / bufsize, h = 0.853553390593, i, a, o;
  for (i = 0; i < bufsize; i++) {
    a = 0.5 + 0.5 * Math.cos(i * t);
    o = cur[i + bufsize] * (1 - a) + old[i] * a;
    out[i] = o * (h - (1 - h) * Math.cos(i * 2 * t)) * 2;
  }
}

/* The original draws each phase as a 15-bit integer times pi/16384; a seeded xorshift keeps the
   tests reproducible. */
function PxRng(seed) { this.s = (seed >>> 0) || 1; }
PxRng.prototype.next = function () {
  var x = this.s;
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
  this.s = x >>> 0;
  return this.s;
};
PxRng.prototype.phase = function () { return (this.next() & 32767) * (Math.PI / 16384); };
PxRng.prototype.unit = function () { return this.next() / 4294967296; };

/* The input file, with the plugin's play range and loop crossfade. Over the last xf samples
   before the end, the tail fades out under the head [start, start + xf), and playback resumes at
   start + xf — a loop with no seam. */
/* The source may arrive as Float32 or as Int16. Int16 halves what a voice holds — 146 MB to
   73 MB for a 6m40s stereo recording — which is the difference between a phone playing two
   points and a phone stalling its audio thread (measured 2026-09-21, Koşuyolu). The samples are
   scaled back to ±1 on the way out, and everything downstream is float64 as before, so the only
   cost is the source's own quantisation: a noise floor near -96 dBFS under material that peaks
   at -0.8. `scale` is derived from the array type rather than passed, so a caller cannot get it
   wrong. */
function PxReader(data, sr) {
  this.data = data; this.sr = sr; this.pos = 0; this.s0 = 0; this.s1 = data.length; this.xf = 0;
  this.scale = (typeof Int16Array !== "undefined" && data instanceof Int16Array) ? 1 / 32768 : 1;
}
PxReader.prototype.setRange = function (start, end, xfadeS) {
  var len = this.data.length, a = Math.max(0, Math.min(1, start)), b = Math.max(0, Math.min(1, end)), t;
  if (b < a) { t = a; a = b; b = t; }
  var s0 = Math.floor(a * len), s1 = Math.min(len, Math.max(s0 + 1, Math.floor(b * len)));
  if (s0 >= s1) { s0 = Math.max(0, s1 - 1); }
  this.s0 = s0; this.s1 = s1;
  this.xf = Math.max(0, Math.min(Math.floor((xfadeS || 0) * this.sr), Math.floor((s1 - s0) / 2)));
  if (this.pos < s0 || this.pos >= s1) { this.pos = s0; }
};
PxReader.prototype.next = function () {
  var p = this.pos, d = this.data, v = d[p] * this.scale, z = this.s1 - this.xf;
  if (this.xf > 0 && p >= z) {
    var t = (p - z) / this.xf;
    v = v * (1 - t) + d[this.s0 + (p - z)] * this.scale * t;
  }
  p++;
  if (p >= this.s1) { p = this.s0 + this.xf; }
  this.pos = p;
  return v;
};
PxReader.prototype.read = function (out) { for (var i = 0; i < out.length; i++) { out[i] = this.next(); } };
PxReader.prototype.skip = function (n) { for (var i = 0; i < n; i++) { this.next(); } };

/* Stretch: the three-chunk input window, the fractional start, skip and onset credit, freeze.
   bufsize is PaulXStretch's "FFT size" — the hop; the transform itself is 2 * bufsize. */
function PxStretcher(bufsize, sr, seed) {
  var N = 2 * bufsize;
  this.bufsize = bufsize; this.sr = sr; this.N = N;
  this.win = pxHamming(N);
  this.veryOld = new Float64Array(bufsize); this.old = new Float64Array(bufsize);
  this.nw = new Float64Array(bufsize); this.chunk = new Float64Array(bufsize);
  this.inFreq = new Float64Array(bufsize); this.oldFreq = new Float64Array(bufsize);
  this.freq = new Float64Array(bufsize);
  this.re = new Float64Array(N); this.im = new Float64Array(N);
  this.oldOut = new Float64Array(N);
  this.ws = { infreq: new Float64Array(bufsize), tmp: new Float64Array(bufsize), sum: new Float64Array(bufsize) };
  this.rng = new PxRng(seed); this.jit = new PxRng((seed ^ 0x9e3779b9) >>> 0);
  /* pxOutputHop's two curves, computed once per size instead of two cosines per sample. */
  this.xa = new Float64Array(bufsize); this.xg = new Float64Array(bufsize);
  var t = Math.PI / bufsize, h = 0.853553390593;
  for (var i = 0; i < bufsize; i++) {
    this.xa[i] = 0.5 + 0.5 * Math.cos(i * t);
    this.xg[i] = (h - (1 - h) * Math.cos(i * 2 * t)) * 2;
  }
  this.remained = 0; this.requireNew = false; this.skip = 0; this.credit = 0; this.inFreqValid = false;
}

/* Stretch::do_analyse_inbuf(): the spectrum of [old | new chunk], used only for onsets. */
PxStretcher.prototype.analyse = function* (a, b, dst) {
  var n = this.bufsize, re = this.re, im = this.im, w = this.win, i;
  for (i = 0; i < n; i++) { re[i] = a[i] * w[i]; re[i + n] = b[i] * w[i + n]; }
  for (i = 0; i < this.N; i++) { im[i] = 0; }
  yield* pxFftSteps(re, im, false);
  dst[0] = 0;
  for (i = 1; i < n; i++) { dst[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]); }
};

/* get_nsamples_for_fill(): three chunks up front, so a high stretch starts on sound. */
PxStretcher.prototype.prime = function (reader) {
  for (var k = 0; k < 3; k++) {
    reader.read(this.chunk);
    this.veryOld.set(this.old); this.old.set(this.nw); this.nw.set(this.chunk);
  }
  this.remained = 0; this.requireNew = false; this.skip = 0; this.credit = 0; this.inFreqValid = false;
};

PxStretcher.prototype.hopJob = function* (reader, p, out) {
  var b = this.bufsize, N = this.N, re = this.re, im = this.im, w = this.win, f = this.freq, i, onset = 0;
  if (!p.freeze && this.requireNew) {
    if (this.skip) { reader.skip(this.skip); }
    for (i = 0; i < b; i++) {
      this.chunk[i] = reader.next();
      if ((i & 16383) === 16383) { yield; }
    }
    if (p.onset > 1e-3) {
      this.oldFreq.set(this.inFreq);
      yield* this.analyse(this.old, this.chunk, this.inFreq);
      if (this.inFreqValid) { onset = pxOnset(b, this.sr, this.inFreq, this.oldFreq, p.onset); }
      this.inFreqValid = true;
    } else {
      this.inFreqValid = false;
    }
    this.veryOld.set(this.old); this.old.set(this.nw); this.nw.set(this.chunk);
  }
  var start = Math.floor(this.remained * b);
  if (start >= b) { start = b - 1; }
  /* Fieldscape extra "field": the analysis frame wanders around its true position. */
  if (p.field > 0) {
    start += Math.round((this.jit.unit() - 0.5) * p.field * b);
    start = Math.max(0, Math.min(b - 1, start));
  }
  yield;
  for (i = 0; i < b - start; i++) { re[i] = this.veryOld[i + start]; }
  for (i = 0; i < b; i++) { re[b - start + i] = this.old[i]; }
  for (i = 0; i < start; i++) { re[2 * b - start + i] = this.nw[i]; }
  for (i = 0; i < N; i++) { re[i] *= w[i]; im[i] = 0; }
  yield;
  yield* pxFftSteps(re, im, false);
  f[0] = 0;
  for (i = 1; i < b; i++) { f[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]); }
  yield* pxChainSteps(this.ws, b, this.sr, p, f);
  /* Fieldscape extra "warp": the whole spectrum drifts by a few Hz; vacated bins stay empty. */
  var shift = Math.round((p.warpHz || 0) / (this.sr / N));
  if (shift) {
    var tmp = this.ws.tmp;
    tmp.set(f);
    for (i = 1; i < b; i++) { var s = i - shift; f[i] = (s >= 1 && s < b) ? tmp[s] : 0; }
  }
  /* FFT::freq2smp(): random phase on bins 1..b-1, DC and Nyquist zero, real output. The
     original's FFTW layout also zeroes the imaginary part of bin b-1; kept. */
  re[0] = 0; im[0] = 0; re[b] = 0; im[b] = 0;
  for (i = 1; i < b; i++) {
    var ph = this.rng.phase(), m = f[i];
    re[i] = m * Math.cos(ph); im[i] = m * Math.sin(ph);
    if ((i & 2047) === 0) { yield; }
  }
  im[b - 1] = 0;
  for (i = 1; i < b; i++) { re[N - i] = re[i]; im[N - i] = -im[i]; }
  yield* pxFftSteps(re, im, true);
  /* pxOutputHop, from the precomputed curves, in slices. */
  var xa = this.xa, xg = this.xg, old = this.oldOut;
  for (i = 0; i < b; i++) {
    out[i] = (re[i + b] * (1 - xa[i]) + old[i] * xa[i]) * xg[i];
    if ((i & 16383) === 16383) { yield; }
  }
  old.set(re);
  if (!p.freeze) {
    var r = (1 + (p.morph || 0)) / Math.max(1, p.stretch);
    if (this.credit > 0) {
      var cg = 0.5 * r;
      this.credit -= cg; if (this.credit < 0) { this.credit = 0; }
      r -= cg;
    }
    this.remained += r;
    if (this.remained >= 1) {
      this.skip = Math.floor(this.remained - 1) * b;
      this.remained -= Math.floor(this.remained);
      this.requireNew = true;
    } else {
      this.requireNew = false;
    }
    /* Stretch::here_is_onset() */
    if (onset > 0.5) { this.requireNew = true; this.credit += 1 - this.remained; this.remained = 0; this.skip = 0; }
  }
  return onset;
};

/* ---------- Binaural beats: BinauralBeats.h / .cpp ---------- */

var PX_HL = [0.6923877778065, 0.9360654322959, 0.9882295226860, 0.9987488452737];
var PX_HR = [0.4021921162426, 0.8561710882420, 0.9722909545651, 0.9952884791278];

/* AP */
function PxAllpass(a) { this.a = a * a; this.i1 = 0; this.i2 = 0; this.o1 = 0; this.o2 = 0; }
PxAllpass.prototype.run = function (x) {
  var o = this.a * (x + this.o2) - this.i2;
  this.i2 = this.i1; this.i1 = x; this.o2 = this.o1; this.o1 = o;
  return o;
};

/* Hilbert: two allpass chains 90 degrees apart, one sample of delay on the first. */
function PxHilbert() {
  this.l = PX_HL.map(function (a) { return new PxAllpass(a); });
  this.r = PX_HR.map(function (a) { return new PxAllpass(a); });
  this.old = 0; this.h1 = 0; this.h2 = 0;
}
PxHilbert.prototype.run = function (x) {
  var a = this.old, b = x;
  for (var k = 0; k < 4; k++) { a = this.l[k].run(a); b = this.r[k].run(b); }
  this.old = x; this.h1 = a; this.h2 = b;
};

/* BinauralBeats::process(): mix the channels by `power`, then shift left down and right up by
   half the beat frequency (single-sideband, via the Hilbert pair). Modes 0/1/2 are
   left-right, right-left and symmetric. */
function PxBinaural(sr) { this.sr = sr; this.t = 0; this.hl = new PxHilbert(); this.hr = new PxHilbert(); }
PxBinaural.prototype.process = function (L, R, bb) {
  var n = L.length, mono = bb.power * 0.5, freq = bb.hz * 0.5, i, l, r, x, c, s, ol1, ol2, or1, or2;
  for (i = 0; i < n; i++) { l = L[i]; r = R[i]; L[i] = l * (1 - mono) + r * mono; R[i] = r * (1 - mono) + l * mono; }
  for (i = 0; i < n; i++) {
    this.t = (this.t + freq / this.sr) % 1;
    x = this.t * 2 * Math.PI; c = Math.cos(x); s = Math.sin(x);
    this.hl.run(L[i]);
    ol1 = this.hl.h1 * c + this.hl.h2 * s; ol2 = this.hl.h1 * c - this.hl.h2 * s;
    this.hr.run(R[i]);
    or1 = this.hr.h1 * c - this.hr.h2 * s; or2 = this.hr.h1 * c + this.hr.h2 * s;
    if (bb.mode === 1) { L[i] = ol1; R[i] = or1; }
    else if (bb.mode === 2) { L[i] = (ol1 + or1) * 0.5; R[i] = (ol2 + or2) * 0.5; }
    else { L[i] = ol2; R[i] = or2; }
  }
};

/* ---------- The processor ---------- */

if (typeof AudioWorkletProcessor !== "undefined") {
  /* The next hop is computed while the current one plays: a job stepped a budget of times per
     128-sample quantum, sized from how many steps the previous hop took, so it finishes inside
     the hop. A quantum that reaches the hop boundary first drains the job — a late frame, never
     a gap. One stretcher per source channel (StretchAudioSource), independent random phase. */
  class PxProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.p = null; this.src = null; this.ch = [];
      this.gain = 1; this.rebuild = false; this.posCount = 0; this.tick = 0;
      this.bb = new PxBinaural(sampleRate);
      this.port.onmessage = (e) => this.onMsg(e.data);
    }
    onMsg(d) {
      if (d.type === "source") { this.src = d.channels; this.build(); return; }
      if (d.type !== "params") { return; }
      var prev = this.p;
      this.p = d.params;
      if (!this.ch.length) { if (this.src) { this.build(); } return; }
      if (prev && prev.bufsize !== this.p.bufsize) { this.rebuild = true; }
      for (var c = 0; c < this.ch.length; c++) { this.ch[c].rd.setRange(this.p.start, this.p.end, this.p.xfade); }
    }
    build() {
      if (!this.p || !this.src) { return; }
      var b = this.p.bufsize, p = this.p;
      this.ch = this.src.map(function (data, k) {
        var rd = new PxReader(data, sampleRate);
        rd.setRange(p.start, p.end, p.xfade);
        var st = new PxStretcher(b, sampleRate, 0x5eed + k * 7919);
        st.prime(rd);
        /* No hop is computed here: build runs on the audio thread, and a whole hop at a large
           size is tens of milliseconds. The first hop plays silence while the job computes the
           next — the sound was fading in from silence anyway. The first estimate is generous
           (two FFTs of 2b points plus the chain), so the first job finishes early, not late. */
        var s = { rd: rd, st: st, cur: new Float64Array(b), nxt: new Float64Array(b),
                  idx: 0, job: null, steps: 0, budget: 1,
                  est: 8 * (2 * b / 4096) * Math.log2(2 * b) + 256 };
        s.job = st.hopJob(rd, p, s.nxt);
        return s;
      });
    }
    swap(s) {
      while (s.job && !s.job.next().done) { s.steps++; }
      if (s.steps) { s.est = s.steps + 1; }
      var t = s.cur; s.cur = s.nxt; s.nxt = t; s.idx = 0; s.steps = 0;
      s.job = s.st.hopJob(s.rd, this.p, s.nxt);
    }
    process(inputs, outputs) {
      var out = outputs[0], L = out[0], R = out[1], n = L.length, i, c, k, s, dst, b;
      if (!this.ch.length) { L.fill(0); if (R) { R.fill(0); } return true; }
      for (c = 0; c < this.ch.length; c++) {
        s = this.ch[c];
        dst = c === 0 ? L : R;
        if (!dst) { continue; }
        b = s.st.bufsize;
        for (i = 0; i < n; i++) {
          if (s.idx >= b) { this.swap(s); }
          dst[i] = s.cur[s.idx++];
        }
        /* Spread what is left evenly over the quanta left in this hop, one quantum spare, rather
           than front-loading: measured in Chrome, a flat 2x budget ran ~7 steps per channel per
           quantum and stacked heavier steps from both channels into 6 ms quanta. The floor of
           10% of the estimate keeps an underestimate from stalling at the end. */
        var left = Math.max(s.est - s.steps, s.est * 0.1), nch = this.ch.length;
        var quantaLeft = (b - s.idx) / n / nch;
        s.budget = Math.ceil(left / Math.max(1, quantaLeft - 1)) + 1;
        /* With two stretchers, each works on alternate quanta, so their heavier steps never
           land in the same one. */
        if (this.tick % nch !== c) { continue; }
        for (k = 0; k < s.budget && s.job; k++) {
          if (s.job.next().done) { s.job = null; } else { s.steps++; }
        }
      }
      this.tick++;
      if (this.ch.length === 1 && R) { R.set(L); }
      if (R && this.p.binaural && this.p.binaural.on) { this.bb.process(L, R, this.p.binaural); }
      /* An FFT-size change rebuilds the stretchers: fade out (time constant 64 samples), rebuild
         at silence, fade back in over the new stretcher's own first crossfade. */
      for (i = 0; i < n; i++) {
        this.gain += ((this.rebuild ? 0 : 1) - this.gain) / 64;
        if (this.rebuild && this.gain < 1e-3) { this.gain = 0; this.rebuild = false; this.build(); }
        L[i] *= this.gain;
        if (R) { R[i] *= this.gain; }
      }
      this.posCount += n;
      if (this.posCount >= 2048) {
        this.posCount = 0;
        this.port.postMessage({ type: "pos", readPos: this.ch[0].rd.pos, sourceLength: this.ch[0].rd.data.length });
      }
      return true;
    }
  }
  registerProcessor("paulx-processor", PxProcessor);
}

globalThis.PaulX = { pxProfile, pxSpread, pxCompressor, pxTonalVsNoise, pxHarmonics, pxFreqShift, pxPitchShift, pxRatioMix, pxFilter, PX_CHAIN, pxChainSteps, pxRun, pxHamming, pxFftSteps, pxOnset, pxOutputHop, PxRng, PxReader, PxStretcher, PxBinaural };
