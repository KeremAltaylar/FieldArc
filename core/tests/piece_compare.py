"""Holds the C++ piece to the web's Tone.js render of the same patch, draws and walk.

    python core/tests/piece_compare.py <prefix> [window_s]

Reads <prefix>.web.wav / .cpp.wav (piece_ref.mjs, piece_compare.cpp) and the two notes lists.
Reports: notes identical; per-window RMS difference (dB); spectral centroid ratio per window; the
level over the whole render. The two can never be sample-identical (noise, chorus and oscillator
phases start differently; Chrome recomputes biquads per sample), so the checks are on what is heard:
level and brightness, window by window."""
import sys
import numpy as np
import scipy.io.wavfile


def load(p):
    sr, x = scipy.io.wavfile.read(p)
    return sr, x.astype(np.float64) / 32768.0


def notes(p):
    return [list(map(float, l.split())) for l in open(p) if l.strip()]


pre = sys.argv[1]
win = float(sys.argv[2]) if len(sys.argv) > 2 else 2.0
sr, w = load(pre + ".web.wav")
_, c = load(pre + ".cpp.wav")
n = min(len(w), len(c))
w, c = w[:n], c[:n]
nw, nc = notes(pre + ".notes.txt"), notes(pre + ".cpp-notes.txt")
same = len(nw) == len(nc) and all(a[0] == b[0] and abs(a[1] - b[1]) < 1e-6 * a[1] and abs(a[3] - b[3]) < 0.005 for a, b in zip(nw, nc))
print(f"notes: web {len(nw)} cpp {len(nc)} identical {same}")

L = int(win * sr)
rows = []
for k in range(n // L):
    a, b = w[k * L:(k + 1) * L], c[k * L:(k + 1) * L]
    ra, rb = np.sqrt(np.mean(a ** 2)), np.sqrt(np.mean(b ** 2))
    fa = np.abs(np.fft.rfft(a.mean(axis=1) * np.hanning(L)))
    fb = np.abs(np.fft.rfft(b.mean(axis=1) * np.hanning(L)))
    f = np.fft.rfftfreq(L, 1 / sr)
    ca = (f * fa).sum() / max(fa.sum(), 1e-12)
    cb = (f * fb).sum() / max(fb.sum(), 1e-12)
    rows.append((k * win, 20 * np.log10(ra + 1e-12), 20 * np.log10(rb + 1e-12), ca, cb))
rows = np.array(rows)
d = rows[:, 2] - rows[:, 1]
live = rows[:, 1] > -60
print("window  web dB   cpp dB   diff   centroid web / cpp")
for r, dd in zip(rows, d):
    print(f"{r[0]:6.0f} {r[1]:8.1f} {r[2]:8.1f} {dd:6.1f}   {r[3]:6.0f} / {r[4]:6.0f}")
tot_w = 20 * np.log10(np.sqrt(np.mean(w ** 2)))
tot_c = 20 * np.log10(np.sqrt(np.mean(c ** 2)))
ratio = rows[live, 4] / rows[live, 3]
print(f"RESULT overall web {tot_w:.2f} dB cpp {tot_c:.2f} dB diff {tot_c - tot_w:+.2f} dB; "
      f"per-window diff median {np.median(d[live]):+.2f} dB, 90% within {np.percentile(np.abs(d[live]), 90):.2f} dB; "
      f"centroid ratio median {np.median(ratio):.3f} (10-90%: {np.percentile(ratio, 10):.3f}-{np.percentile(ratio, 90):.3f})")
# the envelopes should rise and fall together
env_w = np.array([np.sqrt(np.mean(w[i:i + sr // 10] ** 2)) for i in range(0, n - sr // 10, sr // 10)])
env_c = np.array([np.sqrt(np.mean(c[i:i + sr // 10] ** 2)) for i in range(0, n - sr // 10, sr // 10)])
print(f"RESULT 100 ms envelope correlation {np.corrcoef(env_w, env_c)[0, 1]:.3f}")
