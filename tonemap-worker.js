// ─── Tonemap Worker ───────────────────────────────────────────────────────────
// Converts a decoded 16-bit PQ PNG pixel buffer to an 8-bit sRGB RGBA buffer
// entirely off the main thread, keeping the UI responsive during heavy images.
//
// Receives: { pixels: Uint8Array, width, height, samplesPerPixel }
//           pixels is transferred (zero-copy) — the sender's buffer is detached.
// Sends:    { sdrBuf: Uint8Array }  (transferred zero-copy)
//        or { error: string }
//
// NOTE: Must be loaded as a module worker: new Worker(url, { type: 'module' })

import { MAX_PQ, pqOetf, pqEotf, mat3, M_2020_TO_709, M_709_TO_LMS, M_LMS_TO_709, M_LMS_TO_ICTCP, M_ICTCP_TO_LMS } from './pq-math.js';

self.onmessage = (e) => {
    try {
        const result = tonemapPQToSDR(e.data);
        self.postMessage(result, [result.sdrBuf.buffer]);
    } catch (err) {
        self.postMessage({ error: err.message ?? String(err) });
    }
};

// SDR white in PQ: 1.5 scRGB = 120 cd/m²
const _SDR_Y_IN_PQ = pqOetf(1.5);

// ─── sRGB OETF look-up table (16384 entries, linear interpolation) ────────────
// 16384 entries → max interpolation error ~7e-5, well below 1/255 ≈ 3.9e-3.
// Size is +1 so the lerp at index 16383 can safely read [16383] and [16384]=1.0.
const _SRGB_LUT_SIZE = 16384;
const _SRGB_LUT = (() => {
    const lut = new Float32Array(_SRGB_LUT_SIZE + 1);
    for (let i = 0; i <= _SRGB_LUT_SIZE; i++) {
        const c = i / _SRGB_LUT_SIZE;
        lut[i] = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    }
    return lut;
})();
function srgbLut(v) {
    const vv = Math.min(Math.max(v, 0), 1) * _SRGB_LUT_SIZE;
    const lo = vv | 0;
    const t  = vv - lo;
    return t === 0 ? _SRGB_LUT[lo] : _SRGB_LUT[lo] + t * (_SRGB_LUT[lo + 1] - _SRGB_LUT[lo]);
}

// ─── 4×4 Bayer ordered dither ─────────────────────────────────────────────────
// Values are pre-scaled to ±0.47 LSB on a 0–255 scale so they can be added
// directly to (srgbLut(c) * 255) before rounding.  Three phase-shifted variants
// (R, G, B) prevent all three channels from rounding in the same direction,
// which would manifest as colour-tinted structure in near-neutral gradients.
//
//  base index: (y & 3) * 4 + (x & 3)
//  R uses base + 0,  G uses base + 1 (mod 4, same row),  B uses base + 2 (mod 4, same row)
const _BAYER_RAW = new Float32Array([
     0, 8, 2,10,
    12, 4,14, 6,
     3,11, 1, 9,
    15, 7,13, 5,
]);
// Three rotated 4×4 tables — same matrix, columns shifted by 0 / 1 / 2.
const _BAYER_R = new Float32Array(16);
const _BAYER_G = new Float32Array(16);
const _BAYER_B = new Float32Array(16);
for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
        const v = (_BAYER_RAW[row * 4 + col] - 7.5) / 16.0; // range ≈ ±0.47
        _BAYER_R[row * 4 + col]           = v;
        _BAYER_G[row * 4 + ((col + 1) & 3)] = v;
        _BAYER_B[row * 4 + ((col + 2) & 3)] = v;
    }
}

// ─── ICtCp tonemap ─────────────────────────────────────────────────────────────
function rec709ToICtCp(r, g, b) {
    const [L, M, S] = mat3(M_709_TO_LMS, r, g, b);
    const Lpq = pqOetf(Math.max(L, 0));
    const Mpq = pqOetf(Math.max(M, 0));
    const Spq = pqOetf(Math.max(S, 0));
    return mat3(M_LMS_TO_ICTCP, Lpq, Mpq, Spq);
}
function ictcpToRec709(I, Ct, Cp) {
    const [Lpq, Mpq, Spq] = mat3(M_ICTCP_TO_LMS, I, Ct, Cp);
    return mat3(M_LMS_TO_709, pqEotf(Lpq), pqEotf(Mpq), pqEotf(Spq));
}
function tonemapICtCp(r, g, b, maxYInPQ) {
    const [I, Ct, Cp] = rec709ToICtCp(r, g, b);
    const Y_in = Math.max(I, 0);
    if (Y_in === 0) return [0, 0, 0];
    const Lc = maxYInPQ, Ld = _SDR_Y_IN_PQ;
    const a  = Ld / (Lc * Lc), bv = 1.0 / Ld;
    const Y_out = Y_in * (1.0 + a * Y_in) / (1.0 + bv * Y_in);
    const I0 = Math.pow(Y_in, 1.18);
    const I1 = I0 * Math.max(Y_out / Y_in, 0);
    const I_scale = (I0 !== 0 && I1 !== 0) ? Math.min(I0 / I1, I1 / I0) : 0;
    const [ro, go, bo] = ictcpToRec709(I1, Ct * I_scale, Cp * I_scale);
    return [Math.max(ro, 0), Math.max(go, 0), Math.max(bo, 0)];
}

// ─── Main tonemap function ────────────────────────────────────────────────────
function tonemapPQToSDR({ pixels, width, height, samplesPerPixel }) {
    const numPixels  = width * height;
    const bytesPerPx = samplesPerPixel * 2; // 16-bit big-endian per sample

    // PQ EOTF look-up table: maps 16-bit code value → linear light in BT.2020 primaries.
    const pqLut = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) pqLut[i] = pqEotf(i / 65535);

    // ── Single-pass PQ histogram → 99.94th-percentile peak ───────────────────
    const pqLumaFreq = new Uint32Array(65536);
    let maxPQseen = 0;
    for (let i = 0; i < numPixels; i++) {
        const base = i * bytesPerPx;
        const [r, g, b] = mat3(M_2020_TO_709,
            pqLut[(pixels[base]   << 8) | pixels[base+1]],
            pqLut[(pixels[base+2] << 8) | pixels[base+3]],
            pqLut[(pixels[base+4] << 8) | pixels[base+5]]);
        const Y = Math.max(0, 0.212639*r + 0.715169*g + 0.072192*b);
        const pq = pqOetf(Math.min(MAX_PQ, Y));
        const bin = Math.min(Math.round(pq * 65535), 65535);
        pqLumaFreq[bin]++;
        if (pq > maxPQseen) maxPQseen = pq;
    }
    let maxYInPQ = maxPQseen;
    { let pct = 100.0; for (let i = 65535; i >= 0; i--) { pct -= 100.0 * pqLumaFreq[i] / numPixels; if (pct <= 99.94) { maxYInPQ = i / 65535; break; } } }
    maxYInPQ = Math.max(_SDR_Y_IN_PQ, maxYInPQ);

    // ── Tonemap pass → 8-bit RGBA (with Bayer ordered dithering) ─────────────
    // Dithering eliminates the visible contour bands that 8-bit quantisation
    // produces in dark, low-saturation gradients. Each channel uses a phase-
    // shifted Bayer table so R/G/B round independently — prevents colour fringing
    // on near-neutral ramps.
    const sdrBuf = new Uint8Array(numPixels * 4);
    for (let i = 0; i < numPixels; i++) {
        const x = i % width;
        const y = (i / width) | 0;
        const bi = (y & 3) * 4 + (x & 3);
        const dr = _BAYER_R[bi], dg = _BAYER_G[bi], db = _BAYER_B[bi];

        const base = i * bytesPerPx;
        const [r, g, b] = mat3(M_2020_TO_709,
            pqLut[(pixels[base]   << 8) | pixels[base+1]],
            pqLut[(pixels[base+2] << 8) | pixels[base+3]],
            pqLut[(pixels[base+4] << 8) | pixels[base+5]]);
        const [rt, gt, bt] = tonemapICtCp(r, g, b, maxYInPQ);
        sdrBuf[i*4]   = Math.min(255, Math.max(0, Math.round(srgbLut(rt) * 255 + dr)));
        sdrBuf[i*4+1] = Math.min(255, Math.max(0, Math.round(srgbLut(gt) * 255 + dg)));
        sdrBuf[i*4+2] = Math.min(255, Math.max(0, Math.round(srgbLut(bt) * 255 + db)));
        sdrBuf[i*4+3] = 255;
    }

    return { sdrBuf };
}