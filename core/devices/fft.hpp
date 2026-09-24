/* Mixed-radix complex FFT (radices 4, 2, 3, 5), Stockham autosort, split real/imaginary arrays.
   Forward transform: X[k] = sum_n x[n] exp(-2 pi i n k / N), unscaled.

   Each pass reads one buffer and writes the other, output in natural order. A pass is a set of
   independent butterflies, so a caller can run any butterfly range [a, b) of it and spread one
   transform over several audio callbacks. Pass p reads buffer (p even ? A : B) and writes the
   other, so after all passes the result is in (passes odd ? B : A).

   Derivation (one pass): with n = N/s the current sub-length, r the radix, m = n/r, write the input
   index l = p + k*m and the output index K = r*K2 + j. Then
     X[r*K2 + j] = sum_p w_m^(p*K2) * [ w_n^(p*j) * sum_k x[p + k*m] w_r^(k*j) ],
   i.e. an r-point DFT, a twiddle, then s*r interleaved DFTs of length m for the next pass. */
#pragma once
#include <cmath>
#include <vector>

struct FFT {
    int n = 0, passes = 0, radix[64], stride[64];
    std::vector<float> twr, twi;   /* exp(-2 pi i k / n), k < n */

    void reserve(int nmax) { twr.assign(nmax, 0.0f); twi.assign(nmax, 0.0f); }

    /* Factorise; false if size has a prime factor other than 2, 3, 5. Twiddles still need building. */
    bool plan(int size) {
        n = size; passes = 0;
        int m = size, s = 1;
        while (m > 1) {
            int r = m % 4 == 0 ? 4 : m % 2 == 0 ? 2 : m % 3 == 0 ? 3 : m % 5 == 0 ? 5 : 0;
            if (!r) return false;
            radix[passes] = r; stride[passes] = s; passes++;
            s *= r; m /= r;
        }
        return true;
    }

    void twiddles(int a, int b) {
        for (int k = a; k < b; k++) {
            double t = -6.283185307179586 * k / n;
            twr[k] = (float)std::cos(t); twi[k] = (float)std::sin(t);
        }
    }

    int butterflies(int p) const { return n / radix[p]; }

    void pass(int p, const float *xr, const float *xi, float *yr, float *yi, int a, int b) const {
        const int r = radix[p], s = stride[p], m = n / (r * s), wr = n / r;
        float ar[5], ai[5], br[5], bi[5];
        for (int i = a; i < b;) {
            const int pp = i / s;
            int q = i % s;
            const int qe = q + (b - i) < s ? q + (b - i) : s;
            for (; q < qe; q++, i++) {
                for (int k = 0; k < r; k++) { ar[k] = xr[q + s * (pp + k * m)]; ai[k] = xi[q + s * (pp + k * m)]; }
                if (r == 2) {
                    br[0] = ar[0] + ar[1]; bi[0] = ai[0] + ai[1];
                    br[1] = ar[0] - ar[1]; bi[1] = ai[0] - ai[1];
                } else if (r == 4) {
                    float t0r = ar[0] + ar[2], t0i = ai[0] + ai[2], t1r = ar[0] - ar[2], t1i = ai[0] - ai[2];
                    float t2r = ar[1] + ar[3], t2i = ai[1] + ai[3], t3r = ar[1] - ar[3], t3i = ai[1] - ai[3];
                    br[0] = t0r + t2r; bi[0] = t0i + t2i;
                    br[2] = t0r - t2r; bi[2] = t0i - t2i;
                    br[1] = t1r + t3i; bi[1] = t1i - t3r;   /* t1 - i*t3 */
                    br[3] = t1r - t3i; bi[3] = t1i + t3r;   /* t1 + i*t3 */
                } else {                                     /* 3 or 5: plain r-point DFT */
                    for (int j = 0; j < r; j++) {
                        float sr = 0, si = 0;
                        for (int k = 0; k < r; k++) {
                            int t = (j * k) % r * wr;
                            sr += ar[k] * twr[t] - ai[k] * twi[t];
                            si += ar[k] * twi[t] + ai[k] * twr[t];
                        }
                        br[j] = sr; bi[j] = si;
                    }
                }
                const int o = q + s * r * pp;
                yr[o] = br[0]; yi[o] = bi[0];
                for (int j = 1; j < r; j++) {
                    int t = pp * j * s;
                    yr[o + s * j] = br[j] * twr[t] - bi[j] * twi[t];
                    yi[o + s * j] = br[j] * twi[t] + bi[j] * twr[t];
                }
            }
        }
    }

    /* Whole forward transform in one go (tests). Returns which buffer holds the result: 0 = A, 1 = B. */
    int forward(float *Ar, float *Ai, float *Br, float *Bi) const {
        for (int p = 0; p < passes; p++) {
            if (p % 2 == 0) pass(p, Ar, Ai, Br, Bi, 0, butterflies(p));
            else pass(p, Br, Bi, Ar, Ai, 0, butterflies(p));
        }
        return passes % 2;
    }
};
