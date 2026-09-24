"""Every stretch check, one command:   python core/tests/run.py

Builds the core self-check and tests/stretch_test.cpp (em++ + node by default; set CXX=c++ to build
natively instead), generates the inputs, runs the public-domain reference for check 1, analyses the
renders and prints a pass/fail table with the measured numbers. Exit code 0 only if all pass.

Inputs are synthetic (SPEC): 440 Hz sine, pink noise, a formant buzz with gaps standing in for
speech, decaying noise bursts standing in for sharp attacks. Real recordings come later."""
import math, os, re, shutil, subprocess, sys
import numpy as np
import scipy.io.wavfile   # scipy.signal is blocked by an Application Control policy here; numpy only

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # repo root
BUILD = os.path.join(ROOT, "build", "stretch-tests")
SR = 48000
EMSDK = "C:/Users/kerem/tools/emsdk"   # fallback when em++ is not on PATH
rng = np.random.default_rng(12345)
rows = []


def row(num, name, measured, limit, ok):
    rows.append((str(num), name, measured, limit, "PASS" if ok else "FAIL"))


# ---------------------------------------------------------------- build and run the C++ side
def build():
    os.makedirs(BUILD, exist_ok=True)
    with open(os.path.join(BUILD, "package.json"), "w") as f:
        f.write('{"type": "commonjs"}')  # the repo's package.json says "module"; em++ output is CommonJS
    env = dict(os.environ)
    native = "CXX" in env
    if native:
        cxx, flags, ext = [env["CXX"]], ["-std=c++17", "-O2", "-Wall", "-Wextra"], ".exe" if os.name == "nt" else ""
    else:
        em = EMSDK + "/upstream/emscripten/em++"
        env.setdefault("EM_CONFIG", EMSDK + "/.emscripten")
        cxx = [sys.executable, em + ".py"]   # em++ is a shell script; its .py runs everywhere
        flags, ext = ["-std=c++17", "-O2", "-Wall", "-Wextra", "-sNODERAWFS=1", "-sALLOW_MEMORY_GROWTH=1"], ".js"
    devices = [os.path.join("core", "devices", f) for f in os.listdir(os.path.join(ROOT, "core", "devices")) if f.endswith(".cpp")]
    targets = {
        "core_test": ["core/core.cpp", *devices, "core/test.cpp"],
        "stretch_test": ["core/core.cpp", "core/devices/test_devices.cpp", "core/tests/stretch_test.cpp"],
    }
    exe = {}
    for name, srcs in targets.items():
        out = os.path.join(BUILD, name + ext)
        r = subprocess.run(cxx + flags + srcs + ["-o", out], cwd=ROOT, env=env, capture_output=True, text=True)
        if r.returncode:
            sys.exit(f"build of {name} failed:\n{r.stdout}{r.stderr}")
        exe[name] = [out] if native else ["node", out]
    return exe


def run(cmd, *args):
    r = subprocess.run(cmd + [str(a) for a in args], cwd=ROOT, capture_output=True, text=True)
    if r.returncode:
        sys.exit(f"{' '.join(cmd + [str(a) for a in args])} failed:\n{r.stdout}{r.stderr}")
    return r.stdout


def results(text):
    """RESULT lines -> list of dicts of key/value tokens."""
    out = []
    for line in text.splitlines():
        if line.startswith("RESULT "):
            t = line.split()[1:]
            d = {}
            for tok in t:
                if "=" in tok:
                    k, v = tok.split("=", 1); d[k] = v
            for i in range(0, len(t) - 1):
                if "=" not in t[i] and "=" not in t[i + 1]:
                    d.setdefault(t[i], t[i + 1])
            out.append(d)
    return out


def f32(path, x):
    np.asarray(x, dtype=np.float32).tofile(path)


def render(exe, x, seconds, **params):
    """Mono float input -> stereo output (frames, 2) from the stretch device."""
    src, dst = os.path.join(BUILD, "in.f32"), os.path.join(BUILD, "out.f32")
    f32(src, x)
    stats = results(run(exe, "render", src, 1, dst, seconds, *[f"{k}={v}" for k, v in params.items()]))[0]
    return np.fromfile(dst, dtype=np.float32).reshape(-1, 2).astype(np.float64), stats


# ---------------------------------------------------------------- inputs
def pink(seconds, rms=0.1, lo=20.0):
    n = int(seconds * SR)
    spec = np.fft.rfft(rng.standard_normal(n))
    f = np.fft.rfftfreq(n, 1 / SR)
    spec *= np.where(f >= lo, 1 / np.sqrt(np.maximum(f, 1)), 0)
    x = np.fft.irfft(spec, n)
    return x * rms / np.sqrt(np.mean(x ** 2))


def speech_standin(seconds):
    """Buzz at 110-140 Hz, harmonics shaped by three formants that change every 400 ms syllable,
    250 ms voiced then 150 ms gap (additive synthesis)."""
    n = int(seconds * SR)
    t = np.arange(n) / SR
    f0 = 125 + 15 * np.sin(2 * np.pi * 0.7 * t)
    ph = 2 * np.pi * np.cumsum(f0 / SR)
    vowels = np.array([(700, 1200, 2600), (300, 2300, 3000), (500, 900, 2400), (400, 1900, 2600)])
    fmts = vowels[(np.arange(n) // int(0.4 * SR)) % 4]
    y = np.zeros(n)
    for h in range(1, 64):
        f = h * f0
        amp = sum(1 / np.sqrt(1 + ((f - fmts[:, i]) / bw) ** 2) for i, bw in enumerate((80, 100, 150)))
        y += amp * np.sin(h * ph) / h ** 0.5
    pos = (np.arange(n) % int(0.4 * SR)) / SR
    y *= np.where(pos < 0.25, np.sin(np.pi * np.minimum(pos, 0.25) / 0.25) ** 0.5, 0)
    return 0.3 * y / np.max(np.abs(y))


def lowpass(x, fc):
    spec = np.fft.rfft(x)
    spec[np.fft.rfftfreq(len(x), 1 / SR) > fc] = 0
    return np.fft.irfft(spec, len(x))


def bursts(seconds, at):
    x = np.zeros(int(seconds * SR))
    n = int(0.3 * SR)
    burst = rng.standard_normal(n) * np.exp(-np.arange(n) / SR / 0.03)
    s = int(at * SR)
    x[s:s + n] = 0.5 * burst / np.max(np.abs(burst))
    return x


# ---------------------------------------------------------------- measures
def window_n(T):
    n0 = max(16, int(math.floor(T * SR)))
    n = n0 + (n0 & 1)
    while True:
        m = n
        for p in (2, 3, 5):
            while m % p == 0:
                m //= p
        if m == 1:
            return n
        n += 2


def norm_gain(T, shape=0):
    """The derived normalisation (same formula as stretch.cpp's S_GAIN, written independently)."""
    N = window_n(T); H = N // 2; k = np.arange(N)
    if shape == 0:
        w = (1 - np.linspace(-1, 1, N) ** 2) ** 1.25
        h = np.ones(H)
    else:
        w = 0.5 - 0.5 * np.cos(2 * np.pi * k / (N - 1))
        a = (1 + math.sqrt(0.5)) / 2
        h = 2 * (a - (1 - a) * np.cos(2 * np.pi * np.arange(H) / H)) / a
    return 1 / math.sqrt(np.sum(w ** 2) / N * np.sum((w[:H] ** 2 + w[H:] ** 2) * h ** 2) / H)


def db(x):
    return 20 * math.log10(max(x, 1e-12))


def rms(x):
    return math.sqrt(np.mean(np.square(x)))


def psd(x, nper=16384):
    """Averaged Hann periodogram (Welch, 50% overlap), channels averaged. Returns (freqs, power)."""
    x = x.reshape(len(x), -1)
    w = np.hanning(nper)
    starts = range(0, len(x) - nper + 1, nper // 2)
    p = np.mean([np.abs(np.fft.rfft(x[s:s + nper] * w[:, None], axis=0)) ** 2 for s in starts], axis=(0, 2))
    return np.fft.rfftfreq(nper, 1 / SR), p


def third_octaves(x):
    """Long-term third-octave band levels (dB, relative), 31.5 Hz .. 16 kHz."""
    f, p = psd(x)
    out = []
    for k in range(-15, 13):
        fc = 1000 * 2 ** (k / 3)
        sel = (f >= fc * 2 ** (-1 / 6)) & (f < fc * 2 ** (1 / 6))
        out.append(10 * math.log10(np.sum(p[sel]) + 1e-30))
    return np.array(out)


def high_band_blocks(y, fc=10000, hop=480, nper=1024):
    """RMS (linear, full scale) above fc in 10 ms steps: Blackman-Harris frames (sidelobes ~-92 dB),
    power from the bins above fc via Parseval, channels averaged."""
    y = y.reshape(len(y), -1)
    k = np.arange(nper)
    w = 0.35875 - 0.48829 * np.cos(2 * np.pi * k / nper) + 0.14128 * np.cos(4 * np.pi * k / nper) - 0.01168 * np.cos(6 * np.pi * k / nper)
    sel = np.fft.rfftfreq(nper, 1 / SR) > fc
    out = []
    for s in range(0, len(y) - nper + 1, hop):
        X = np.fft.rfft(y[s:s + nper] * w[:, None], axis=0)[sel]
        out.append(math.sqrt(2 * np.sum(np.abs(X) ** 2) / (nper * np.sum(w ** 2)) / y.shape[1]))
    return np.array(out)


def envelope(y, ms=10, smooth=5):
    b = int(SR * ms / 1000)
    e = np.sqrt(np.mean(y[: len(y) // b * b].reshape(-1, b, 2) ** 2, axis=(1, 2)))
    return np.convolve(e, np.ones(smooth) / smooth, mode="same")


# ---------------------------------------------------------------- checks
def main():
    exe = build()
    out = run(exe["core_test"])
    row(0, "core self-check (core/test.cpp)", out.strip().splitlines()[-1], "exits 0", "core ok" in out)

    e = float(results(run(exe["stretch_test"], "fft"))[0]["fft_rel_err"])
    row("F", "FFT vs direct DFT, 12 sizes 16..2400", f"rel err {e:.2g}", "< 1e-5", e < 1e-5)

    # 1: against the reference, S = 8, T = 0.25, ours at original shape, width 1, gain divided out
    src = open(os.path.join(ROOT, "core", "tests", "reference", "paulstretch_stereo.py")).read()
    for a, b in (("ravel(1)", 'ravel(order="F")'), (".tostring()", ".tobytes()")):
        assert src.count(a) == 1
        src = src.replace(a, b)
    ref = os.path.join(BUILD, "ref_stereo.py")
    open(ref, "w").write(src)
    S, T = 8.0, 0.25
    for name, x in (("pink noise", pink(10)), ("speech stand-in", speech_standin(10))):
        q = np.round(x * 32767).astype(np.int16)
        scipy.io.wavfile.write(os.path.join(BUILD, "ref_in.wav"), SR, q)
        subprocess.run([sys.executable, ref, "-s", str(S), "-w", str(T),
                        os.path.join(BUILD, "ref_in.wav"), os.path.join(BUILD, "ref_out.wav")],
                       cwd=BUILD, capture_output=True, check=True)
        _, r = scipy.io.wavfile.read(os.path.join(BUILD, "ref_out.wav"))
        r = r.astype(np.float64) / 32768
        ours, _ = render(exe["stretch_test"], q / 32768.0, len(r) / SR,
                         stretch=math.log(S) / math.log(1024), window=T, width=1, shape=0)
        ours /= norm_gain(T)
        cut = SR  # drop the first and last second (start-up, the reference's end fade)
        a, b = third_octaves(ours[cut:-cut]), third_octaves(r[cut:-cut])
        use = b > b.max() - 50
        d = np.abs(a - b)[use]
        row(1, f"3rd-octave vs reference, {name} ({use.sum()} bands)", f"max |diff| {d.max():.2f} dB", "<= 1 dB", d.max() <= 1)

    # 2: output length when the read position first passes the end
    chk = run(exe["stretch_test"], "checks")
    res = results(chk)
    lens = [d for d in res if "diff_hops" in d]
    worst = max(abs(float(d["diff_hops"])) for d in lens)
    row(2, "output length vs input x S (S 1, 2.5, 8, 64)", f"worst {worst:.3f} hop", "< 1 hop", worst < 1)

    # 3: level across S x T and width, one derived gain. "RMS in" is the input span the frames
    # actually read (at S = 1024 that is a few thousand samples, whose local level differs from the
    # whole file's); the whole-file figure is printed alongside.
    x = pink(10)
    rin = rms(x)
    worst, worst_whole, where = 0.0, 0.0, ""
    for T in (0.05, 0.25, 1, 2):
        for S in (1, 2, 8, 64, 1024):
            N, secs = window_n(T), 20 + 6 * T
            y, _ = render(exe["stretch_test"], x, secs, stretch=math.log(S) / math.log(1024), window=T)
            span = min(len(x), int(secs * SR / S) + N)
            d = db(rms(y[2 * N:]) / rms(x[:span]))
            worst_whole = max(worst_whole, abs(db(rms(y[2 * N:]) / rin)))
            if abs(d) > abs(worst):
                worst, where = d, f"S={S} T={T}"
    row(3, "RMS out/in (span read), S {1..1024} x T {0.05..2}", f"worst {worst:+.2f} dB ({where}); vs whole file {worst_whole:.2f} dB",
        "within +-1 dB", abs(worst) <= 1)
    worst_w, spread = 0.0, []
    for wd in (0, 0.25, 0.5, 0.75, 1):
        y, _ = render(exe["stretch_test"], x, 26, stretch=0.3, window=0.25, width=wd)
        d = db(rms(y[2 * window_n(0.25):]) / rin)
        spread.append(d)
        worst_w = d if abs(d) > abs(worst_w) else worst_w
    row(3, "RMS out/in across width 0..1 (S=8, T=0.25)", f"worst {worst_w:+.2f} dB, range {max(spread) - min(spread):.2f} dB", "within +-1 dB", abs(worst_w) <= 1)
    y, _ = render(exe["stretch_test"], x, 26, stretch=0.3, window=0.25, shape=1)
    d = db(rms(y[2 * window_n(0.25):]) / rin)
    row(3, "RMS out/in, hann shape (S=8, T=0.25)", f"{d:+.2f} dB", "within +-1 dB", abs(d) <= 1)

    # 4: low-passed input, live sweeps, energy above 10 kHz
    lp = lowpass(pink(20), 4000)
    f32(os.path.join(BUILD, "in.f32"), lp)
    sw = results(run(exe["stretch_test"], "sweep", os.path.join(BUILD, "in.f32"), os.path.join(BUILD, "out.f32"), 90))[0]
    y = np.fromfile(os.path.join(BUILD, "out.f32"), dtype=np.float32).reshape(-1, 2).astype(np.float64)
    blocks = high_band_blocks(y)
    hin = high_band_blocks(lp).max()
    row(4, "sweep stretch/window/width 90 s: >10 kHz, 10 ms blocks",
        f"max {db(blocks.max()):.1f} dBFS (signal {db(rms(y)):.1f}, input {db(hin):.1f})", "< -60 dBFS", db(blocks.max()) < -60)

    # 5: freeze for 60 s
    y, _ = render(exe["stretch_test"], pink(10), 62, freeze=1, window=0.34)
    sec = [db(rms(y[i * SR:(i + 1) * SR])) for i in range(2, 62)]
    fine = envelope(y[2 * SR:], ms=10, smooth=1)
    drop = db(fine.min() / fine.mean())
    row(5, "freeze 60 s: RMS of 1 s blocks", f"range {max(sec) - min(sec):.2f} dB; worst 10 ms block {drop:.1f} dB vs mean",
        "< 1 dB; no dropout (> -20 dB)", max(sec) - min(sec) < 1 and drop > -20)

    # 6: sharp attack at S = 8, onset off vs on
    rise = {}
    for onset in (0, 0.5):
        y, _ = render(exe["stretch_test"], bursts(8, 2.0), 26, stretch=0.3, window=0.34, onset=onset)
        e = envelope(y)
        pk = int(np.argmax(e))
        st = pk
        while st > 0 and e[st - 1] >= 0.1 * e[pk]:
            st -= 1
        rise[onset] = (pk - st) * 0.01
    ratio = rise[0] / max(rise[0.5], 0.01)
    row(6, "attack rise (-20 dB to peak), S=8, onset off/on",
        f"off {rise[0]:.2f} s, on {rise[0.5]:.2f} s, {ratio:.1f}x", ">= 4x faster", ratio >= 4)

    # 7, 8, 9 from the C++ side
    s7 = next(d for d in res if "seed_same" in d)
    row(7, "same seed twice, live changes (20 s)", f"identical {s7['seed_same'] == '1'}; block 128 vs 480 identical {s7['seed_blocksize'] == '1'}; seed 2 differs {s7['seed_other_differs'] == '1'}",
        "bit-identical", s7["seed_same"] == "1" and s7["seed_other_differs"] == "1")
    limit = 0.5 * 128 / SR * 1000
    for line in chk.splitlines():
        m = re.match(r"RESULT cpu (\S+) max_ms (\S+) late (\d+) underruns (\d+)", line)
        if m:
            what = {"T=0.34": "T=0.34 s", "T=2": "T=2 s", "change": "window 0.34 -> 2 s mid-render"}[m[1]]
            ms = float(m[2])
            row(8, f"worst process(), 128 @ 48k, {what}", f"{ms:.3f} ms, late {m[3]}, underruns {m[4]}", f"< {limit:.2f} ms", ms < limit and m[3] == "0")
    s9 = next(d for d in res if "first_silent" in d)
    row(9, "signal after fft/phase/ifft/overlap-add/output", f"rms {s9['fft']}/{s9['phase']}/{s9['ifft']}/{s9['ola']}/{s9['output']}; first silent: {s9['first_silent']}",
        "none silent", s9["first_silent"] == "none")

    w = [max(len(r[i]) for r in rows + [("#", "test", "measured", "limit", "result")]) for i in range(5)]
    for r in [("#", "test", "measured", "limit", "result")] + rows:
        print("  ".join(c.ljust(w[i]) for i, c in enumerate(r)))
    failed = sum(r[4] == "FAIL" for r in rows)
    print(f"\n{len(rows) - failed}/{len(rows)} passed (runtime: {'native ' + os.environ['CXX'] if 'CXX' in os.environ else 'em++ / node wasm'})")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
