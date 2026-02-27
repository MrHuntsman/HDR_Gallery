// ─── Tonemap Worker ───────────────────────────────────────────────────────────
// Converts a decoded 16-bit PQ PNG pixel buffer to an 8-bit sRGB RGBA buffer
// entirely off the main thread, keeping the UI responsive during heavy images.
//
// Receives: { pixels: Uint8Array, width, height, samplesPerPixel }
//           pixels is transferred (zero-copy) — the sender's buffer is detached.
// Sends:    { sdrBuf: Uint8Array }  (transferred zero-copy)
//        or { error: string }
//
// All color math is self-contained here — no imports needed.

self.onmessage = (e) => {
    try {
        const result = tonemapPQToSDR(e.data);
        self.postMessage(result, [result.sdrBuf.buffer]);
    } catch (err) {
        self.postMessage({ error: err.message ?? String(err) });
    }
};

// ─── PQ / ICtCp constants (mirrors image-processing.js module-level values) ──

const _MAX_PQ = 125.0;          // 10 000 nits / 80 nits per scRGB unit
const _PQ_N   = 2610.0 / 4096.0 / 4.0;
const _PQ_M   = 2523.0 / 4096.0 * 128.0;
const _PQ_C1  = 3424.0 / 4096.0;
const _PQ_C2  = 2413.0 / 4096.0 * 32.0;
const _PQ_C3  = 2392.0 / 4096.0 * 32.0;

function pqOetf(v) {
    const y = Math.max(v, 0) / _MAX_PQ;
    if (y === 0) return 0;
    const ym = Math.pow(y, _PQ_N);
    return Math.pow((_PQ_C1 + _PQ_C2 * ym) / (1.0 + _PQ_C3 * ym), _PQ_M);
}
function pqEotf(v) {
    const vp = Math.pow(Math.max(v, 0), 1.0 / _PQ_M);
    const nd = Math.max(vp - _PQ_C1, 0) / Math.max(_PQ_C2 - _PQ_C3 * vp, 1e-10);
    return Math.pow(nd, 1.0 / _PQ_N) * _MAX_PQ;
}

// 3×3 col-vector matrix multiply
function mat3(m, r, g, b) {
    return [m[0]*r+m[1]*g+m[2]*b, m[3]*r+m[4]*g+m[5]*b, m[6]*r+m[7]*g+m[8]*b];
}

// BT.2020 → BT.709 (exact inverse of the 709→2020 matrix)
const M_2020_TO_709 = [
     1.66049094578, -0.58764109488, -0.07284986467,
    -0.12455046637,  1.13289988028, -0.00834942203,
    -0.01815076427, -0.10057889487,  1.11872966227,
];

// Source matrices — used to compute pre-composed forms below
const _M_709_TO_XYZ = [
    0.412390798330307,  0.357584327459335,  0.180480793118477,
    0.212639003992081,  0.715168654918671,  0.072192318737507,
    0.019330818206072,  0.119194783270359,  0.950532138347626,
];
const _M_XYZ_TO_709 = [
     3.240969896316528, -1.537383198738098, -0.498610764741898,
    -0.969243645668030,  1.875967502593994,  0.041555058211088,
     0.055630080401897, -0.203976958990097,  1.056971549987793,
];
const _M_XYZ_TO_LMS = [
     0.3592,  0.6976, -0.0358,
    -0.1922,  1.1004,  0.0755,
     0.0070,  0.0749,  0.8434,
];
const _M_LMS_TO_XYZ = [
     2.070180056695614, -1.326456876103021,  0.206616006847855,
     0.364988250032657,  0.680467362852235, -0.045421753075853,
    -0.049595542238932, -0.049421161186757,  1.187995941732803,
];

// 3×3 matrix-matrix multiply: result = A · B
function mulMat3(A, B) {
    return [
        A[0]*B[0]+A[1]*B[3]+A[2]*B[6],  A[0]*B[1]+A[1]*B[4]+A[2]*B[7],  A[0]*B[2]+A[1]*B[5]+A[2]*B[8],
        A[3]*B[0]+A[4]*B[3]+A[5]*B[6],  A[3]*B[1]+A[4]*B[4]+A[5]*B[7],  A[3]*B[2]+A[4]*B[5]+A[5]*B[8],
        A[6]*B[0]+A[7]*B[3]+A[8]*B[6],  A[6]*B[1]+A[7]*B[4]+A[8]*B[7],  A[6]*B[2]+A[7]*B[5]+A[8]*B[8],
    ];
}

// Pre-composed BT.709 ↔ LMS matrices (same computation as _M_709_TO_LMS / _M_LMS_TO_709 in image-processing.js)
const M_709_TO_LMS = mulMat3(_M_XYZ_TO_LMS, _M_709_TO_XYZ);
const M_LMS_TO_709 = mulMat3(_M_XYZ_TO_709, _M_LMS_TO_XYZ);

const M_LMS_TO_ICTCP = [
    0.5000,  0.5000,  0.0000,
    1.6137, -3.3234,  1.7097,
    4.3780, -4.2455, -0.1325,
];
const M_ICTCP_TO_LMS = [
    1.0,  0.00860514569398152,  0.11103560447547328,
    1.0, -0.00860514569398152, -0.11103560447547328,
    1.0,  0.56004885956263900, -0.32063747023212210,
];

// SDR white in PQ: 1.5 scRGB = 120 cd/m²
const _SDR_Y_IN_PQ = pqOetf(1.5);

// ─── sRGB OETF look-up table (8192 entries, linear interpolation) ─────────────
const _SRGB_LUT = (() => {
    const lut = new Float32Array(8192);
    for (let i = 0; i < 8192; i++) {
        const c = i / 8191;
        lut[i] = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    }
    return lut;
})();
function srgbLut(v) {
    const vv = Math.min(Math.max(v, 0), 1) * 8191;
    const lo = vv | 0;
    const t  = vv - lo;
    return t === 0 ? _SRGB_LUT[lo] : _SRGB_LUT[lo] + t * (_SRGB_LUT[lo + 1] - _SRGB_LUT[lo]);
}

// ─── ICtCp tonemap (mirrors tonemapICtCp_global in image-processing.js) ───────
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
    // Built once per worker invocation (~256 KB Float32Array, negligible vs the pixel work).
    const pqLut = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) pqLut[i] = pqEotf(i / 65535);

    // ── Single-pass PQ histogram → 99.94th-percentile peak ───────────────────
    // Histogram is in PQ space (fixed [0,1] range) so no min/max pre-scan is needed.
    const pqLumaFreq = new Uint32Array(65536);
    let maxPQseen = 0;
    for (let i = 0; i < numPixels; i++) {
        const base = i * bytesPerPx;
        const [r, g, b] = mat3(M_2020_TO_709,
            pqLut[(pixels[base]   << 8) | pixels[base+1]],
            pqLut[(pixels[base+2] << 8) | pixels[base+3]],
            pqLut[(pixels[base+4] << 8) | pixels[base+5]]);
        const Y = Math.max(0, 0.212639*r + 0.715169*g + 0.072192*b);
        const pq = pqOetf(Math.min(_MAX_PQ, Y));
        const bin = Math.min(Math.round(pq * 65535), 65535);
        pqLumaFreq[bin]++;
        if (pq > maxPQseen) maxPQseen = pq;
    }
    let maxYInPQ = maxPQseen;
    { let pct = 100.0; for (let i = 65535; i >= 0; i--) { pct -= 100.0 * pqLumaFreq[i] / numPixels; if (pct <= 99.94) { maxYInPQ = i / 65535; break; } } }
    maxYInPQ = Math.max(_SDR_Y_IN_PQ, maxYInPQ);

    // ── Tonemap pass → 8-bit RGBA ─────────────────────────────────────────────
    const sdrBuf = new Uint8Array(numPixels * 4);
    for (let i = 0; i < numPixels; i++) {
        const base = i * bytesPerPx;
        const [r, g, b] = mat3(M_2020_TO_709,
            pqLut[(pixels[base]   << 8) | pixels[base+1]],
            pqLut[(pixels[base+2] << 8) | pixels[base+3]],
            pqLut[(pixels[base+4] << 8) | pixels[base+5]]);
        const [rt, gt, bt] = tonemapICtCp(r, g, b, maxYInPQ);
        sdrBuf[i*4]   = Math.round(srgbLut(rt) * 255);
        sdrBuf[i*4+1] = Math.round(srgbLut(gt) * 255);
        sdrBuf[i*4+2] = Math.round(srgbLut(bt) * 255);
        sdrBuf[i*4+3] = 255;
    }

    return { sdrBuf };
}