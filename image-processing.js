// ─── ImageMagick WASM ────────────────────────────────────────────────────────
// Lazy-loaded on first use. Requires imagemagick.umd.js and magick.wasm.
// Download from:
//   https://cdn.jsdelivr.net/gh/Armster15/imagemagick-wasm-builds@master/lib/imagemagick.umd.js
//   https://cdn.jsdelivr.net/npm/@imagemagick/magick-wasm@0.0.36/dist/magick.wasm
let magickReady = false;
let magickLoading = null;
let _ImageMagick = null;
let _MagickFormat = null;

// Cache key — bump this string whenever magick.wasm is updated so stale bytes
// are evicted and the new version is fetched and re-cached automatically.
const _MAGICK_WASM_URL     = './image-processing/magick.wasm';
const _MAGICK_CACHE_NAME   = 'magick-wasm-v1';

// Retrieves magick.wasm from the Cache Storage API, fetching and caching it on
// first use. Subsequent page loads (and refreshes) are served entirely from the
// cache — no network round-trip, no repeated multi-MB download.
async function _getMagickWasmUrl() {
    let cache;
    try { cache = await caches.open(_MAGICK_CACHE_NAME); } catch (_) { return _MAGICK_WASM_URL; }

    let response = await cache.match(_MAGICK_WASM_URL);
    if (!response) {
        console.log('[getMagick] magick.wasm not in cache — fetching and caching…');
        try {
            const fresh = await fetch(_MAGICK_WASM_URL);
            if (!fresh.ok) throw new Error(`fetch ${fresh.status}`);
            await cache.put(_MAGICK_WASM_URL, fresh.clone());
            response = fresh;
        } catch (err) {
            console.warn('[getMagick] cache store failed, falling back to direct URL:', err);
            return _MAGICK_WASM_URL;
        }
    } else {
        console.log('[getMagick] magick.wasm served from Cache Storage');
    }

    // Convert cached response to a blob URL so ImageMagick can load it without
    // triggering another network request.
    const blob = await response.blob();
    return URL.createObjectURL(blob);
}

async function getMagick() {
    if (magickReady) return { ImageMagick: _ImageMagick, MagickFormat: _MagickFormat };
    if (magickLoading) return magickLoading;

    magickLoading = (async () => {
        await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = './image-processing/imagemagick.umd.js';
            script.onload = resolve;
            script.onerror = () => reject(new Error('Failed to load imagemagick.umd.js — make sure it is in the same folder as index.html'));
            document.head.appendChild(script);
        });

        const wasmUrl = await _getMagickWasmUrl();
        await window.ImageMagick.initializeImageMagick(wasmUrl);

        _ImageMagick = window.ImageMagick.ImageMagick;
        _MagickFormat = window.ImageMagick.MagickFormat;
        magickReady = true;
        return { ImageMagick: _ImageMagick, MagickFormat: _MagickFormat };
    })();

    return magickLoading;
}

// ─── SKIV Color Math ─────────────────────────────────────────────────────────
// Ported from SKIV image.h / image.cpp. Used by the PNG SDR tonemap path
// (convertToSDR) and the JXR HDR/SDR encode path (convertJxrToPNG).
//
// COLOR SPACE CONVENTIONS
//   • All pixel values are linear scRGB (BT.709 primaries, D65 white point).
//     1.0 scRGB = 80 cd/m². MaxPQ = 125 scRGB = 10 000 cd/m².
//   • PQ code values are normalised [0, 1] per ST.2084.
//   • ICtCp uses the Dolby definition (XYZ → LMS → PQ → ICtCp).
//
// MATRIX STORAGE NOTE
//   SKIV stores matrices in XMMATRIX row-major order where each stored row is
//   a *column* of the mathematical transform (because XMVector3Transform does
//   v·M, i.e. row-vector on the left). JS mat3/mat3px compute M·v (col-vector
//   on the right), so every matrix ported from image.h must be transposed: what
//   was stored as row i in the XMMATRIX becomes row i of the JS flat array.
//   Sanity check: for any colour-space transform whose white point is D65,
//   each row of the correctly transposed JS matrix must sum to ~1.0.

const _SKIV_MAX_PQ = 125.0;          // scRGB units at peak PQ (10 000 nits / 80 nits)
const _PQ_N  = 2610.0 / 4096.0 / 4.0;
const _PQ_M  = 2523.0 / 4096.0 * 128.0;
const _PQ_C1 = 3424.0 / 4096.0;
const _PQ_C2 = 2413.0 / 4096.0 * 32.0;
const _PQ_C3 = 2392.0 / 4096.0 * 32.0;

// PQ OETF: linear scRGB → [0,1] PQ code value  (SKIV: SKIV_Image_LinearToPQ)
function pqOetf_global(v) {
    const y = Math.max(v, 0) / _SKIV_MAX_PQ;
    if (y === 0) return 0;
    const ym = Math.pow(y, _PQ_N);
    return Math.pow((_PQ_C1 + _PQ_C2 * ym) / (1.0 + _PQ_C3 * ym), _PQ_M);
}

// PQ EOTF: [0,1] PQ code value → linear scRGB  (SKIV: SKIV_Image_PQToLinear)
function pqEotf_global(v) {
    const vp = Math.pow(Math.max(v, 0), 1.0 / _PQ_M);
    const nd = Math.max(vp - _PQ_C1, 0) / Math.max(_PQ_C2 - _PQ_C3 * vp, 1e-10);
    return Math.pow(nd, 1.0 / _PQ_N) * _SKIV_MAX_PQ;
}

// 3×3 matrix-vector multiply, col-vector convention: result = M · v
function _mat3(m, r, g, b) {
    return [m[0]*r+m[1]*g+m[2]*b, m[3]*r+m[4]*g+m[5]*b, m[6]*r+m[7]*g+m[8]*b];
}

// 3×3 matrix-matrix multiply: result = A · B  (used at startup to pre-compose transform chains)
function _multiplyMat3(A, B) {
    return [
        A[0]*B[0]+A[1]*B[3]+A[2]*B[6],  A[0]*B[1]+A[1]*B[4]+A[2]*B[7],  A[0]*B[2]+A[1]*B[5]+A[2]*B[8],
        A[3]*B[0]+A[4]*B[3]+A[5]*B[6],  A[3]*B[1]+A[4]*B[4]+A[5]*B[7],  A[3]*B[2]+A[4]*B[5]+A[5]*B[8],
        A[6]*B[0]+A[7]*B[3]+A[8]*B[6],  A[6]*B[1]+A[7]*B[4]+A[8]*B[7],  A[6]*B[2]+A[7]*B[5]+A[8]*B[8],
    ];
}

// ── Module-level matrices (transposed from image.h XMMATRIX storage) ─────────

// BT.709 → BT.2020  (SKIV: c_from709to2020)
const _M_709_TO_2020 = [
    0.627403914928436, 0.329283028841019, 0.043313067406416,
    0.069097287952900, 0.919540405273438, 0.011362315155566,
    0.016391439363360, 0.088013306260109, 0.895595252513885,
];
// BT.2020 → BT.709 (exact inverse of _M_709_TO_2020)
const _M_2020_TO_709 = [
     1.66049094578, -0.58764109488, -0.07284986467,
    -0.12455046637,  1.13289988028, -0.00834942203,
    -0.01815076427, -0.10057889487,  1.11872966227,
];
// BT.709 → XYZ D65  (SKIV: c_from709toXYZ)
const _M_709_TO_XYZ = [
    0.412390798330307, 0.357584327459335, 0.180480793118477,
    0.212639003992081, 0.715168654918671, 0.072192318737507,
    0.019330818206072, 0.119194783270359, 0.950532138347626,
];
// XYZ D65 → BT.709  (SKIV: c_fromXYZto709)
const _M_XYZ_TO_709 = [
     3.240969896316528, -1.537383198738098, -0.498610764741898,
    -0.969243645668030,  1.875967502593994,  0.041555058211088,
     0.055630080401897, -0.203976958990097,  1.056971549987793,
];
// XYZ D65 → LMS  (SKIV: c_fromXYZtoLMS — already symmetric enough to be self-transposed)
const _M_XYZ_TO_LMS = [
     0.3592,  0.6976, -0.0358,
    -0.1922,  1.1004,  0.0755,
     0.0070,  0.0749,  0.8434,
];
// LMS → XYZ D65  (SKIV: c_fromLMStoXYZ)
const _M_LMS_TO_XYZ = [
     2.070180056695614, -1.326456876103021,  0.206616006847855,
     0.364988250032657,  0.680467362852235, -0.045421753075853,
    -0.049595542238932, -0.049421161186757,  1.187995941732803,
];
// BT.709 → DCI-P3 D65  (SKIV: c_from709toDCIP3)
const _M_709_TO_P3 = [
    0.822461962699890, 0.177538037300110, 0.000000000000000,
    0.033194199204445, 0.966805815696716, 0.000000000000000,
    0.017082631587982, 0.072397440671921, 0.910519957542419,
];
// PQ-LMS → ICtCp  (SKIV: inline ConvMat in Rec709toICtCp — verified by round-trip
//                  with _M_ICTCP_TO_LMS to < 1e-15 error)
const _M_LMS_TO_ICTCP = [
    0.5000,  0.5000,  0.0000,
    1.6137, -3.3234,  1.7097,
    4.3780, -4.2455, -0.1325,
];
// ICtCp → PQ-LMS  (SKIV: inline ConvMat in ICtCptoRec709)
const _M_ICTCP_TO_LMS = [
    1.0,                   0.00860514569398152,  0.11103560447547328,
    1.0,                  -0.00860514569398152, -0.11103560447547328,
    1.0,                   0.56004885956263900, -0.32063747023212210,
];

// sRGB OETF look-up table: 8192 entries covering linear [0, 1].
// Replaces per-pixel Math.pow calls in the final gamma-encode step.
// 8192 entries → max error ~3e-4, well below the 1/255 ≈ 3.9e-3 quantisation floor.
const _SRGB_LUT = (() => {
    const lut = new Float32Array(8192);
    for (let i = 0; i < 8192; i++) {
        const c = i / 8191;
        lut[i] = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    }
    return lut;
})();
// Inline helper — clamps input to [0,1], linearly interpolates the LUT.
// Lerp eliminates the 1-LSB rounding artefacts that nearest-neighbour lookup can produce.
function _srgbLut(v) {
    const vv = Math.min(Math.max(v, 0), 1) * 8191;
    const lo = vv | 0; // fast floor for non-negative values
    const t  = vv - lo;
    return t === 0 ? _SRGB_LUT[lo] : _SRGB_LUT[lo] + t * (_SRGB_LUT[lo + 1] - _SRGB_LUT[lo]);
}

// Pre-composed matrices — eliminates intermediate XYZ step in the ICtCp round-trip.
//   _M_709_TO_LMS = _M_XYZ_TO_LMS · _M_709_TO_XYZ  (BT.709 → LMS in one multiply)
//   _M_LMS_TO_709 = _M_XYZ_TO_709 · _M_LMS_TO_XYZ  (LMS → BT.709 in one multiply)
// Each reduces rec709ToICtCp / ictcpToRec709 from 2 mat3 calls to 1.
const _M_709_TO_LMS = _multiplyMat3(_M_XYZ_TO_LMS, _M_709_TO_XYZ);
const _M_LMS_TO_709 = _multiplyMat3(_M_XYZ_TO_709, _M_LMS_TO_XYZ);

// SDR white target in PQ: SKIV maps SDR white at 1.5 scRGB = 120 cd/m²
const _SDR_Y_IN_PQ = pqOetf_global(1.5);

// Linear scRGB → ICtCp  (SKIV: SKIV_Image_Rec709toICtCp)
// Uses pre-composed _M_709_TO_LMS to skip the XYZ intermediate step.
function rec709ToICtCp_global(r, g, b) {
    const [L, M, S] = _mat3(_M_709_TO_LMS, r, g, b);
    const Lpq = pqOetf_global(Math.max(L, 0));
    const Mpq = pqOetf_global(Math.max(M, 0));
    const Spq = pqOetf_global(Math.max(S, 0));
    return _mat3(_M_LMS_TO_ICTCP, Lpq, Mpq, Spq);
}

// ICtCp → linear scRGB  (SKIV: SKIV_Image_ICtCptoRec709)
// Uses pre-composed _M_LMS_TO_709 to skip the XYZ intermediate step.
function ictcpToRec709_global(I, Ct, Cp) {
    const [Lpq, Mpq, Spq] = _mat3(_M_ICTCP_TO_LMS, I, Ct, Cp);
    const [L, M, S] = [pqEotf_global(Lpq), pqEotf_global(Mpq), pqEotf_global(Spq)];
    return _mat3(_M_LMS_TO_709, L, M, S);
}

// ICtCp SDR tonemap  (SKIV: TonemapHDR lambda + chroma scaling in TonemapToSDR)
// Maps HDR linear scRGB → SDR linear scRGB using a perceptual Reinhard-like curve
// on the ICtCp intensity channel, with matched chroma desaturation.
// maxYInPQ: content peak in PQ units (99.94th-percentile luminance).
function tonemapICtCp_global(r, g, b, maxYInPQ) {
    const [I, Ct, Cp] = rec709ToICtCp_global(r, g, b);
    const Y_in = Math.max(I, 0);
    if (Y_in === 0) return [0, 0, 0];

    // Reinhard-like curve on I: maps [0, Lc] → [0, Ld]
    const Lc = maxYInPQ, Ld = _SDR_Y_IN_PQ;
    const a = Ld / (Lc * Lc), bv = 1.0 / Ld;
    const Y_out = Y_in * (1.0 + a * Y_in) / (1.0 + bv * Y_in);

    // Chroma scaling: compress Ct/Cp by the ratio of perceptual intensities (pow 1.18 per SKIV)
    const I0 = Math.pow(Y_in, 1.18);
    const I1 = I0 * Math.max(Y_out / Y_in, 0);
    const I_scale = (I0 !== 0 && I1 !== 0) ? Math.min(I0 / I1, I1 / I0) : 0;

    const [ro, go, bo] = ictcpToRec709_global(I1, Ct * I_scale, Cp * I_scale);
    return [Math.max(ro, 0), Math.max(go, 0), Math.max(bo, 0)];
}


// ─── ImageMagick JXR Support Probe ───────────────────────────────────────────
// Returns { supported: bool, method: string, error?: string }.
// JXR support requires a custom ImageMagick WASM build with the WMP/JXR codec
// compiled in — the standard CDN build does not include it.
async function checkJxrSupport() {
    try {
        const { ImageMagick } = await getMagick();

        // Method 1: query the format list directly if the API exposes it
        const formats = ImageMagick.supportedFormats ?? ImageMagick.coderInfoList ?? null;
        if (formats) {
            const hasJxr = [...formats].some(f => {
                const name = (f.format ?? f.name ?? '').toString().toUpperCase();
                return name === 'JXR' || name === 'WDP' || name === 'HDP';
            });
            return { supported: hasJxr, method: 'formatList' };
        }

        // Method 2: try decoding a minimal valid JXR stub (magic bytes: 0x49 0x49 0xBC)
        const stub = new Uint8Array([0x49, 0x49, 0xBC, 0x01, ...new Array(60).fill(0)]);
        let errMsg = '';
        try {
            await new Promise((resolve, reject) => {
                ImageMagick.read(stub, (img) => resolve(img));
                setTimeout(() => reject(new Error('timeout')), 2000);
            });
        } catch (e) {
            errMsg = e.message ?? '';
        }

        const noDelegate = /delegate|no support|unable to open|unable to read/i.test(errMsg);
        return { supported: !noDelegate && errMsg === '', method: 'probeConvert', error: errMsg || null };

    } catch (e) {
        return { supported: false, method: 'error', error: e.message };
    }
}


// ─── jpegxr.js WASM Codec ────────────────────────────────────────────────────
// Lazy-loads jpegxr.js (place jpegxr.js next to index.html).
// The library exposes: jpegxr().then(codec => { let img = codec.decode(bytes); })
// img = { width, height, pixelInfo: { channels, bitDepth, bitsPerPixel, hasAlpha }, bytes: Uint8Array }
let _jpegxrCodec = null;
let _jpegxrLoading = null;

async function getJpegXrCodec() {
    if (_jpegxrCodec) return _jpegxrCodec;
    if (_jpegxrLoading) return _jpegxrLoading;

    _jpegxrLoading = (async () => {
        if (typeof window.jpegxr === 'undefined') {
            await new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = './image-processing/jpegxr.js';
                script.onload = resolve;
                script.onerror = () => reject(new Error('Failed to load jpegxr.js — make sure it is in the same folder as index.html'));
                document.head.appendChild(script);
            });
        }
        _jpegxrCodec = await window.jpegxr();
        return _jpegxrCodec;
    })();

    return _jpegxrLoading;
}

// ─── JXR → PNG Conversion ────────────────────────────────────────────────────
// Decodes a JXR file via jpegxr.js and produces three outputs in one pass:
//
//   hdrFile   — 16-bit PNG, BT.2020 primaries, PQ transfer, tagged with cICP.
//               Raw scRGB floats are converted BT.709→BT.2020, then PQ-encoded.
//               Also carries a _jxrGamut property with gamut coverage stats.
//
//   sdrBlob   — 8-bit sRGB PNG, tone-mapped via SKIV's ICtCp operator directly
//               from the raw scRGB floats. Never touches the browser canvas so
//               there is no risk of the browser pre-tone-mapping the PQ signal.
//
//   thumbBlob — Downscaled (≤1280px) 16-bit PQ PNG for gallery display.
//
// Pixel format handling:
//   '16Float' / '32Float' — main HDR path; full colour pipeline.
//   '16' (integer)        — pass-through, no colour conversion.
//   8-bit fallback        — values scaled 8→16-bit, pass-through.
async function convertJxrToPNG(file) {
    const codec = await getJpegXrCodec();
    const arrayBuffer = await file.arrayBuffer();
    const inputBytes = new Uint8Array(arrayBuffer);

    let decoded;
    try {
        decoded = codec.decode(inputBytes);
    } catch (err) {
        throw new Error(`jpegxr decode failed: ${err.message || err}`);
    }

    const { width, height, pixelInfo, bytes: rawBytes } = decoded;
    const { bitDepth, channels } = pixelInfo;
    const outputName = file.name.replace(/\.[^.]+$/, '.png');

    // ── Helpers ───────────────────────────────────────────────────────────────

    // IEEE 754 binary16 → float64
    function f16ToF32(h) {
        const s = (h >>> 15) ? -1 : 1;
        const e = (h >>> 10) & 0x1f;
        const m =  h & 0x03ff;
        if (e === 0)  return s * Math.pow(2, -14) * (m / 1024);
        if (e === 31) return m ? NaN : s * Infinity;
        return s * Math.pow(2, e - 15) * (1 + m / 1024);
    }

    // Color math uses the module-level constants and functions directly:
    // pqOetf_global, pqEotf_global, _mat3, _M_709_TO_2020, _M_709_TO_P3,
    // _M_LMS_TO_ICTCP, _M_ICTCP_TO_LMS, _M_709_TO_LMS, _M_LMS_TO_709,
    // tonemapICtCp_global, _SKIV_MAX_PQ, _SDR_Y_IN_PQ.

    // ── Float path: '16Float' (half) or '32Float' (single precision) ─────────
    if (bitDepth === '16Float' || bitDepth === '32Float') {
        const numPixels = width * height;
        const is32 = bitDepth === '32Float';

        // Copy rawBytes into a new aligned buffer before constructing a typed view,
        // since rawBytes may not satisfy the alignment requirement for Float32Array.
        const safeBuf = new ArrayBuffer(rawBytes.length);
        new Uint8Array(safeBuf).set(rawBytes);
        const srcView = is32 ? new Float32Array(safeBuf) : new Uint16Array(safeBuf);

        // getLinear(i): sample index → linear scRGB float
        const getLinear = is32
            ? (i) => srcView[i]
            : (i) => f16ToF32(srcView[i]);

        // Output buffers
        const hdrBytesPerPx = 8; // 4 channels × 2 bytes (16-bit LE)
        const hdrBuf = new Uint8Array(numPixels * hdrBytesPerPx);
        const sdrBuf = new Uint8ClampedArray(numPixels * 4); // 8-bit RGBA

        // ── 99.94th-percentile luminance for tone-map peak (mirrors SKIV) ────
        // Single pass in PQ space — no min/max pre-scan needed (fixed [0,1] histogram range).
        const pqLumaFreq = new Uint32Array(65536);
        let maxPQseen = 0;
        for (let i = 0; i < numPixels; i++) {
            const fi = i * channels;
            const Y = Math.max(0.212639 * getLinear(fi) + 0.715169 * getLinear(fi+1) + 0.072192 * getLinear(fi+2), 0);
            const pq = pqOetf_global(Math.min(_SKIV_MAX_PQ, Y));
            const bin = Math.min(Math.round(pq * 65535), 65535);
            pqLumaFreq[bin]++;
            if (pq > maxPQseen) maxPQseen = pq;
        }
        let maxYInPQ_pct = maxPQseen;
        { let pct = 100.0; for (let i = 65535; i >= 0; i--) { pct -= 100.0 * pqLumaFreq[i] / numPixels; if (pct <= 99.94) { maxYInPQ_pct = i / 65535; break; } } }
        // Cap at SKIV's MaxPQ ceiling (10 000 nits) and clamp to at least SDR white
        const maxYInPQ = Math.max(_SDR_Y_IN_PQ, maxYInPQ_pct);

        // ── Per-pixel encode + gamut classification (single combined pass) ──────
        // Gamut stats are computed on the original BT.709 floats alongside the encode
        // so we avoid a 4th scan over the pixel data.
        const FP16_MIN = 0.0005;
        let g709 = 0, gP3 = 0, g2020 = 0, gTotal = 0;
        for (let i = 0; i < numPixels; i++) {
            const fi = i * channels;
            const hi = i * hdrBytesPerPx;
            const si = i * 4;

            const r = getLinear(fi);
            const g = getLinear(fi + 1);
            const b = getLinear(fi + 2);
            // Note: JXR screenshots carry alpha=0 even though the image is fully opaque — ignore it.

            // HDR PNG: convert BT.709 → BT.2020, then PQ-encode to 16-bit LE.
            // The cICP chunk (primaries=9, transfer=16) accurately describes the result.
            const [r2020, g2020c, b2020] = _mat3(_M_709_TO_2020, r, g, b);
            const pq0 = Math.round(pqOetf_global(r2020) * 65535);
            const pq1 = Math.round(pqOetf_global(g2020c) * 65535);
            const pq2 = Math.round(pqOetf_global(b2020) * 65535);
            hdrBuf[hi]   =  pq0 & 0xff;  hdrBuf[hi+1] = (pq0 >> 8) & 0xff;
            hdrBuf[hi+2] =  pq1 & 0xff;  hdrBuf[hi+3] = (pq1 >> 8) & 0xff;
            hdrBuf[hi+4] =  pq2 & 0xff;  hdrBuf[hi+5] = (pq2 >> 8) & 0xff;
            hdrBuf[hi + 6] = 0xff; // alpha hi
            hdrBuf[hi + 7] = 0xff; // alpha lo  (= 65535, opaque)

            // SDR PNG: tonemap in BT.709 linear space, then apply sRGB gamma via LUT.
            // Stays in BT.709 throughout — no primary conversion needed.
            const [rt, gt, bt] = tonemapICtCp_global(r, g, b, maxYInPQ);
            sdrBuf[si]     = Math.round(_srgbLut(rt) * 255);
            sdrBuf[si + 1] = Math.round(_srgbLut(gt) * 255);
            sdrBuf[si + 2] = Math.round(_srgbLut(bt) * 255);
            sdrBuf[si + 3] = 255;

            // Gamut classification on original BT.709 linear values
            const Y = 0.212639 * r + 0.715169 * g + 0.072192 * b;
            gTotal++;
            if ((r >= 0 && g >= 0 && b >= 0) || Y < FP16_MIN) { g709++; continue; }
            const [p3r, p3g, p3b] = _mat3(_M_709_TO_P3, r, g, b);
            if (p3r >= 0 && p3g >= 0 && p3b >= 0) { gP3++; continue; }
            if (r2020 >= 0 && g2020c >= 0 && b2020 >= 0) g2020++;
            // SKIV also classifies AP1/AP0 beyond Rec.2020; omitted here.
        }

        // ── HDR PNG ───────────────────────────────────────────────────────────
        const cicp = { primaries: 9, transfer: 16 }; // BT.2020 / PQ
        const hdrPng = await buildPNG16(hdrBuf, width, height, hdrBytesPerPx, cicp);
        const hdrFile = new File([hdrPng], outputName, { type: 'image/png' });

        if (gTotal > 0) {
            hdrFile._jxrGamut = {
                rec709: (g709  / gTotal * 100).toFixed(4),
                p3:     (gP3   / gTotal * 100).toFixed(4),
                bt2020: (g2020 / gTotal * 100).toFixed(4),
                sourcePrimaries: 'BT.709/scRGB',
            };
        }

        // ── SDR PNG ───────────────────────────────────────────────────────────
        // Written directly from the tone-mapped sRGB buffer — no canvas involved,
        // so pixel values are written verbatim without browser colour management.
        const sdrPng = await buildPNG8(sdrBuf, width, height);
        const sdrFile = new File([sdrPng], outputName.replace('.png', '_SDR.png'), { type: 'image/png' });

        // ── HDR thumbnail (downscaled to ≤1280px, still 16-bit PQ with cICP) ──
        const thumbBlob = await buildHdrThumb(hdrBuf, width, height, cicp, 1280);

        return { hdrFile, sdrBlob: sdrFile, thumbBlob };
    }

    // ── 16-bit integer path ───────────────────────────────────────────────────
    // No colour conversion — pass raw samples straight to the PNG encoder.
    if (bitDepth === '16' || bitDepth === 16) {
        const bytesPerPx = channels * 2;
        const pngData = await buildPNG16(rawBytes, width, height, bytesPerPx, null);
        const hdrFile = new File([pngData], outputName, { type: 'image/png' });
        return { hdrFile, sdrBlob: null, thumbBlob: null };
    }

    // ── 8-bit fallback ────────────────────────────────────────────────────────
    // Scale 8-bit → 16-bit (multiply by 257 = 65535/255) and pass through.
    const bytesPerPx16 = channels * 2;
    const upscaled = new Uint8Array(width * height * bytesPerPx16);
    for (let i = 0; i < rawBytes.length; i++) {
        const val16 = rawBytes[i] * 257;
        upscaled[i * 2]     =  val16 & 0xff;
        upscaled[i * 2 + 1] = (val16 >> 8) & 0xff;
    }
    const pngData8 = await buildPNG16(upscaled, width, height, bytesPerPx16, null);
    const hdrFile = new File([pngData8], outputName, { type: 'image/png' });
    return { hdrFile, sdrBlob: null, thumbBlob: null };
}

// ─── PNG Builders ─────────────────────────────────────────────────────────────

// Build an 8-bit RGBA PNG from a Uint8ClampedArray of sRGB pixel data.
// Bypasses the browser canvas so values are written verbatim — no colour management.
async function buildPNG8(rgba8, width, height) {
    const rowBytes = width * 4;
    const raw = new Uint8Array(height * (1 + rowBytes));
    for (let y = 0; y < height; y++) {
        raw[y * (1 + rowBytes)] = 0; // PNG filter type: None
        raw.set(rgba8.subarray(y * rowBytes, (y + 1) * rowBytes), y * (1 + rowBytes) + 1);
    }
    const compressed = await deflateRaw(raw);
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, width); dv.setUint32(4, height);
    ihdr[8] = 8; ihdr[9] = 6; // bit depth 8, colour type 6 (RGBA)
    const chunks = [makeChunk('IHDR', ihdr), makeChunk('IDAT', compressed), makeChunk('IEND', new Uint8Array(0))];
    const sig = new Uint8Array([137,80,78,71,13,10,26,10]);
    const out = new Uint8Array(sig.length + chunks.reduce((a,c) => a + c.length, 0));
    let pos = 0;
    out.set(sig, pos); pos += sig.length;
    for (const c of chunks) { out.set(c, pos); pos += c.length; }
    return out;
}

// Build a 16-bit PNG from a raw pixel buffer.
// rawPixels layout: little-endian 16-bit samples per channel (as returned by ImageMagick
// WASM's RGBA format write, or by the JXR HDR encode path above).
// bytesPerPx: 6 = RGB, 8 = RGBA.
// cicp: optional { primaries, transfer } for the cICP chunk (HDR metadata).
async function buildPNG16(rawPixels, width, height, bytesPerPx, cicp) {
    const is16      = bytesPerPx >= 6;   // true for 16-bit input, false for 8-bit
    const hasAlpha  = (bytesPerPx === 4 || bytesPerPx === 8);
    const inChans   = hasAlpha ? 4 : 3;
    const colorType = hasAlpha ? 6 : 2;  // PNG colour type: 2=RGB, 6=RGBA
    const outBytesPerPx = inChans * 2;   // output is always 16-bit

    const rowBytes = width * outBytesPerPx;
    const raw = new Uint8Array(height * (1 + rowBytes));
    const dvRaw = new DataView(raw.buffer);

    if (is16) {
        // 16-bit LE input → 16-bit BE output.
        // Read LE uint16 with a manual 2-byte combine (faster than DataView.getUint16 on typed arrays);
        // write BE uint16 via DataView.setUint16(offset, value, false /*big-endian*/).
        for (let y = 0; y < height; y++) {
            const rowStart = y * (1 + rowBytes);
            raw[rowStart] = 0; // PNG filter type: None
            for (let x = 0; x < width; x++) {
                const inBase  = (y * width + x) * bytesPerPx;
                const outBase = rowStart + 1 + x * outBytesPerPx;
                for (let c = 0; c < inChans; c++) {
                    const val = rawPixels[inBase + c*2] | (rawPixels[inBase + c*2 + 1] << 8);
                    dvRaw.setUint16(outBase + c*2, val, false); // write big-endian
                }
            }
        }
    } else {
        // 8-bit input → 16-bit BE output (scale by 257 = 65535/255).
        for (let y = 0; y < height; y++) {
            const rowStart = y * (1 + rowBytes);
            raw[rowStart] = 0;
            for (let x = 0; x < width; x++) {
                const inBase  = (y * width + x) * bytesPerPx;
                const outBase = rowStart + 1 + x * outBytesPerPx;
                for (let c = 0; c < inChans; c++) {
                    dvRaw.setUint16(outBase + c*2, rawPixels[inBase + c] * 257, false);
                }
            }
        }
    }

    const compressed = await deflateRaw(raw);
    const ihdr = new Uint8Array(13);
    const dvIhdr = new DataView(ihdr.buffer);
    dvIhdr.setUint32(0, width); dvIhdr.setUint32(4, height);
    ihdr[8] = 16; ihdr[9] = colorType;

    const chunks = [makeChunk('IHDR', ihdr)];
    if (cicp) {
        chunks.push(makeChunk('cICP', new Uint8Array([cicp.primaries, cicp.transfer, 0, 1])));
    }
    chunks.push(makeChunk('IDAT', compressed));
    chunks.push(makeChunk('IEND', new Uint8Array(0)));

    const sig = new Uint8Array([137,80,78,71,13,10,26,10]);
    const out = new Uint8Array(sig.length + chunks.reduce((a,c) => a + c.length, 0));
    let pos = 0;
    out.set(sig, pos); pos += sig.length;
    for (const c of chunks) { out.set(c, pos); pos += c.length; }
    return out;
}

// Downscale a 16-bit LE RGBA pixel buffer and encode as an HDR PNG with cICP.
// Uses nearest-neighbour sampling (sufficient for thumbnail use). No ImageMagick needed.
async function buildHdrThumb(hdrBuf, srcW, srcH, cicp, maxPx = 1280) {
    const scale = Math.min(1, maxPx / Math.max(srcW, srcH));
    const dstW = Math.max(1, Math.round(srcW * scale));
    const dstH = Math.max(1, Math.round(srcH * scale));

    if (scale >= 1) {
        // Already within target size — re-encode as-is
        return new Blob([await buildPNG16(hdrBuf, srcW, srcH, 8, cicp)], { type: 'image/png' });
    }

    const srcBytesPerPx = 8; // 4 ch × 2 bytes LE
    const dstBuf = new Uint8Array(dstW * dstH * srcBytesPerPx);

    // Sample a single source pixel (LE uint16 per channel)
    function sampleSrc(sx, sy, ch) {
        const x = Math.min(Math.max(Math.round(sx), 0), srcW - 1);
        const y = Math.min(Math.max(Math.round(sy), 0), srcH - 1);
        const base = (y * srcW + x) * srcBytesPerPx + ch * 2;
        return hdrBuf[base] | (hdrBuf[base + 1] << 8);
    }

    for (let dy = 0; dy < dstH; dy++) {
        for (let dx = 0; dx < dstW; dx++) {
            const di = (dy * dstW + dx) * srcBytesPerPx;
            for (let c = 0; c < 4; c++) {
                const v = sampleSrc(dx / scale, dy / scale, c);
                dstBuf[di + c * 2]     =  v & 0xff;
                dstBuf[di + c * 2 + 1] = (v >> 8) & 0xff;
            }
        }
    }

    const png = await buildPNG16(dstBuf, dstW, dstH, srcBytesPerPx, cicp);
    return new Blob([png], { type: 'image/png' });
}

// ─── Non-JXR → PNG (via ImageMagick WASM) ────────────────────────────────────
// For all formats other than JXR, delegates to ImageMagick for decoding, then
// re-encodes to a true 16-bit PNG in pure JS (the WASM build's Png format write
// is locked to 8-bit). Preserves cICP from AVIF sources.
// ─── HDR / EXR → PNG conversion ──────────────────────────────────────────────
// Both formats are decoded in pure JS without ImageMagick:
//   .hdr — Radiance RGBE, decoded by _decodeRGBE.
//   .exr — OpenEXR, decoded by _decodeEXR. Supports scan-line files with NONE,
//           ZIPS (1-line), or ZIP (16-line) compression. EXR ZIP uses zlib-wrapped
//           deflate; the inflate helper auto-detects zlib vs raw deflate from the
//           first two bytes. Channel types: HALF (16-bit float) and FLOAT (32-bit).
//           ImageMagick WASM cannot be used for EXR: MagickFormat.Rgbaf outputs
//           uint16 quantum integers (not half-floats), and MagickFormat.Hdr clips
//           all values to [0,1], losing HDR headroom above 80 nits in both cases.
// Both paths produce floats[] as Float32Array, stride 3 (R,G,B linear scRGB).

// IEEE 754 binary16 → float32
function _f16ToF32(h) {
    const s = (h >>> 15) ? -1 : 1;
    const e = (h >>> 10) & 0x1f;
    const m =  h & 0x03ff;
    if (e === 0)  return s * Math.pow(2, -14) * (m / 1024);
    if (e === 31) return m ? NaN : s * Infinity;
    return s * Math.pow(2, e - 15) * (1 + m / 1024);
}

// Radiance RGBE (.hdr) pure-JS decoder → Float32Array stride 3 (R,G,B).
// Handles the new-RLE scanline format used by all modern .hdr writers.
function _decodeRGBE(data) {
    let pos = 0;
    while (pos < data.length) {
        const eol = data.indexOf(0x0a, pos);
        if (eol === -1) throw new Error('HDR: unterminated header');
        const line = String.fromCharCode(...data.slice(pos, eol));
        pos = eol + 1;
        if (line === '') break;
    }
    const sizeEol = data.indexOf(0x0a, pos);
    const sizeLine = String.fromCharCode(...data.slice(pos, sizeEol));
    pos = sizeEol + 1;
    const sizeMatch = sizeLine.match(/[-+]Y\s+(\d+)\s+[-+]X\s+(\d+)/);
    if (!sizeMatch) throw new Error(`HDR: unrecognised size line: "${sizeLine}"`);
    const height = parseInt(sizeMatch[1], 10);
    const width  = parseInt(sizeMatch[2], 10);
    const floats = new Float32Array(width * height * 3);
    let outIdx = 0;
    function rgbeToFloat(r, g, b, e) {
        if (e === 0) return [0, 0, 0];
        const scale = Math.pow(2, e - 128 - 8);
        return [r * scale, g * scale, b * scale];
    }
    for (let y = 0; y < height; y++) {
        if (pos + 4 <= data.length &&
            data[pos] === 0x02 && data[pos+1] === 0x02 &&
            ((data[pos+2] << 8) | data[pos+3]) === width) {
            pos += 4;
            const scanline = new Uint8Array(4 * width);
            for (let ch = 0; ch < 4; ch++) {
                let x = 0;
                while (x < width) {
                    const code = data[pos++];
                    if (code > 128) {
                        const count = code - 128, val = data[pos++];
                        for (let k = 0; k < count; k++) scanline[ch * width + x++] = val;
                    } else {
                        for (let k = 0; k < code; k++) scanline[ch * width + x++] = data[pos++];
                    }
                }
            }
            for (let x = 0; x < width; x++) {
                const [fr, fg, fb] = rgbeToFloat(
                    scanline[x], scanline[width+x], scanline[2*width+x], scanline[3*width+x]);
                floats[outIdx++] = fr; floats[outIdx++] = fg; floats[outIdx++] = fb;
            }
        } else {
            for (let x = 0; x < width; x++) {
                const [fr, fg, fb] = rgbeToFloat(data[pos], data[pos+1], data[pos+2], data[pos+3]);
                pos += 4;
                floats[outIdx++] = fr; floats[outIdx++] = fg; floats[outIdx++] = fb;
            }
        }
    }
    return { width, height, floats };
}

// OpenEXR pure-JS decoder → Float32Array stride 3 (R,G,B).
// Supports scan-line files with NONE (0), ZIPS (2, 1-line), ZIP (3, 16-line) compression.
// Channel types: HALF (1, 16-bit float) and FLOAT (2, 32-bit). UINT channels are skipped.
async function _decodeEXR(data) {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let pos = 0;
    function readI32() { const v = dv.getInt32(pos, true);  pos += 4; return v; }
    function readU32() { const v = dv.getUint32(pos, true); pos += 4; return v; }
    function readU64() { const lo=dv.getUint32(pos,true), hi=dv.getUint32(pos+4,true); pos+=8; return lo+hi*4294967296; }
    function readStr() { let e=pos; while(data[e]!==0)e++; const s=String.fromCharCode(...data.slice(pos,e)); pos=e+1; return s; }

    if (readU32() !== 0x01312F76) throw new Error('Not an OpenEXR file');
    const version = readU32();
    if (version & 0x200) throw new Error('Tiled EXR not supported — only scan-line EXR');

    // ── Parse header attributes ───────────────────────────────────────────────
    const channels = [];
    let compression = 0, width = 0, height = 0, dataWinMinX = 0, dataWinMinY = 0;
    while (true) {
        const attrName = readStr(); if (attrName === '') break;
        const attrType = readStr();
        const attrSize = readI32(), attrStart = pos;
        if (attrName === 'compression') {
            compression = data[pos++];
        } else if (attrName === 'dataWindow') {
            dataWinMinX = readI32(); dataWinMinY = readI32();
            width  = readI32() - dataWinMinX + 1;
            height = readI32() - dataWinMinY + 1;
        } else if (attrName === 'channels') {
            // chlist: { name\0, type(i32), pLinear+pad(4 bytes), xSamp(i32), ySamp(i32) } repeated, terminated by \0
            while (data[pos] !== 0) {
                const name = readStr(), type = readI32();
                pos += 4; readI32(); readI32(); // skip pLinear/pad, xSampling, ySampling
                channels.push({ name, type });
            }
            pos++; // terminating \0
        } else {
            pos = attrStart + attrSize;
        }
    }
    if (!width || !height) throw new Error('EXR: missing dataWindow attribute');
    if (compression !== 0 && compression !== 2 && compression !== 3)
        throw new Error(`EXR: unsupported compression type ${compression} (only NONE/ZIPS/ZIP supported)`);

    // Channels are stored alphabetically in the file
    channels.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    function findCh(names) {
        for (const n of names) {
            const i = channels.findIndex(c => c.name === n || c.name.toLowerCase() === n.toLowerCase());
            if (i !== -1) return i;
        }
        return -1;
    }
    const rIdx = findCh(['R', 'r', 'Red', 'red']);
    const gIdx = findCh(['G', 'g', 'Green', 'green', 'Y']);
    const bIdx = findCh(['B', 'b', 'Blue', 'blue']);
    function bps(t) { return t === 2 ? 4 : 2; } // FLOAT=4 bytes, HALF=2 bytes

    // ── Offset table (one 8-byte file offset per chunk) ───────────────────────
    const linesPerChunk = (compression === 3) ? 16 : 1; // ZIP=16, ZIPS/NONE=1
    const numChunks = Math.ceil(height / linesPerChunk);
    const offsets = []; for (let i = 0; i < numChunks; i++) offsets.push(readU64());

    // Auto-detect zlib vs raw deflate from the first two bytes of compressed data.
    // EXR ZIP uses zlib (0x78xx header) per the reference implementation.
    async function inflate(compressed) {
        const isZlib = compressed[0] === 0x78 &&
            (compressed[1] === 0x9C || compressed[1] === 0x01 ||
             compressed[1] === 0xDA || compressed[1] === 0x5E);
        const ds = new DecompressionStream(isZlib ? 'deflate' : 'deflate-raw');
        const w2 = ds.writable.getWriter(); w2.write(compressed); w2.close();
        const chunks = []; const r = ds.readable.getReader();
        while (true) { const {done,value} = await r.read(); if (done) break; chunks.push(value); }
        const out = new Uint8Array(chunks.reduce((a,c)=>a+c.length,0));
        let p = 0; for (const c of chunks) { out.set(c,p); p+=c.length; }
        return out;
    }

    // Undo EXR ZIP predictor (ImfZipCompressor.cpp):
    //   compress: interleave bytes → delta encode → deflate
    //   decompress: inflate → undo delta → deinterleave
    // Delta undo: p[i] = (stored[i] + p[i-1] - 128) & 0xFF  (p[0] unchanged)
    // Deinterleave: stored as [ceil(n/2) even-position bytes | floor(n/2) odd-position bytes]
    function exrUnpredict(raw) {
        const n = raw.length;
        let prev = raw[0];
        for (let i = 1; i < n; i++) { const v = (raw[i] + prev - 128) & 0xFF; prev = v; raw[i] = v; }
        const tmp = new Uint8Array(raw), half = Math.ceil(n / 2);
        for (let i = 0; i < half; i++)             raw[i*2]   = tmp[i];
        for (let i = 0; i < Math.floor(n/2); i++)  raw[i*2+1] = tmp[half+i];
        return raw;
    }

    function readSample(buf, off, type) {
        if (type === 1) return _f16ToF32(buf[off] | (buf[off+1] << 8)); // HALF
        const ab = new ArrayBuffer(4); new Uint8Array(ab).set(buf.slice(off, off+4));
        return new DataView(ab).getFloat32(0, true); // FLOAT
    }

    // ── Decode all scan-line chunks ───────────────────────────────────────────
    // Chunk layout: [4-byte yStart][4-byte dataSize][compressed pixel data]
    // Pixel data layout (after decompression+unpredict):
    //   for each scan line in chunk: for each channel (alphabetical): width samples packed
    const floats = new Float32Array(width * height * 3);
    for (let chunk = 0; chunk < numChunks; chunk++) {
        pos = offsets[chunk];
        const yStart       = readI32();
        const chunkDataSize = readI32();
        const rawBytes     = data.slice(pos, pos + chunkDataSize);
        const linesInChunk = Math.min(linesPerChunk, height - (yStart - dataWinMinY));

        const pixelData = compression === 0 ? rawBytes : exrUnpredict(await inflate(rawBytes));

        let pOff = 0;
        for (let li = 0; li < linesInChunk; li++) {
            const y = (yStart - dataWinMinY) + li; if (y >= height) break;
            const lineSamples = {};
            for (let ci = 0; ci < channels.length; ci++) {
                const ch = channels[ci], stride = bps(ch.type);
                const s = new Float32Array(width);
                for (let x = 0; x < width; x++) s[x] = readSample(pixelData, pOff + x*stride, ch.type);
                lineSamples[ci] = s; pOff += width * stride;
            }
            const yOff = y * width * 3;
            for (let x = 0; x < width; x++) {
                floats[yOff + x*3]   = rIdx >= 0 ? lineSamples[rIdx][x] : 0;
                floats[yOff + x*3+1] = gIdx >= 0 ? lineSamples[gIdx][x] : 0;
                floats[yOff + x*3+2] = bIdx >= 0 ? lineSamples[bIdx][x] : 0;
            }
        }
    }
    return { width, height, floats };
}

async function convertHdrExrToPNG(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    const arrayBuffer = await file.arrayBuffer();
    const inputData = new Uint8Array(arrayBuffer);
    const outputName = file.name.replace(/\.[^.]+$/, '.png');

    let w, h, floats;
    if (ext === 'hdr') {
        const d = _decodeRGBE(inputData);
        w = d.width; h = d.height; floats = d.floats;
    } else {
        const d = await _decodeEXR(inputData);
        w = d.width; h = d.height; floats = d.floats;
    }

    const numPixels = w * h, channels = 3;

    // ── 99.94th-percentile luminance for tone-map peak (PQ-space histogram) ──────
    // Computed in PQ space so extreme scene-linear outliers don't collapse the
    // histogram and force maxYInPQ to the PQ ceiling, which would over-compress SDR.
    const pqFreq = new Uint32Array(65536); let maxPQseen = 0;
    for (let i = 0; i < numPixels; i++) {
        const fi = i * channels, r = floats[fi], g = floats[fi+1], b = floats[fi+2];
        if (!isFinite(r) || !isFinite(g) || !isFinite(b)) continue;
        const Y = Math.max(0.212639*r + 0.715169*g + 0.072192*b, 0);
        const pq = pqOetf_global(Math.min(_SKIV_MAX_PQ, Y));
        pqFreq[Math.min(Math.max(Math.round(pq*65535),0),65535)]++;
        if (pq > maxPQseen) maxPQseen = pq;
    }
    let maxYInPQ = maxPQseen;
    { let pct = 100.0; for (let i = 65535; i >= 0; i--) { pct -= 100.0*pqFreq[i]/numPixels; if (pct <= 99.94) { maxYInPQ = i/65535; break; } } }
    maxYInPQ = Math.max(_SDR_Y_IN_PQ, maxYInPQ);

    // ── Per-pixel encode + gamut classification (single combined pass) ──────────
    const hdrBytesPerPx = 8; // 4 ch × 2 bytes (16-bit LE)
    const hdrBuf = new Uint8Array(numPixels * hdrBytesPerPx);
    const sdrBuf = new Uint8ClampedArray(numPixels * 4);
    const FP16_MIN = 0.0005;
    let g709 = 0, gP3 = 0, g2020 = 0, gTotal = 0;

    for (let i = 0; i < numPixels; i++) {
        const fi = i * channels;
        const hi = i * hdrBytesPerPx;
        const si = i * 4;

        const r = Math.max(isFinite(floats[fi])   ? floats[fi]   : 0, 0);
        const g = Math.max(isFinite(floats[fi+1]) ? floats[fi+1] : 0, 0);
        const b = Math.max(isFinite(floats[fi+2]) ? floats[fi+2] : 0, 0);

        // HDR PNG: BT.709 linear → BT.2020, then PQ-encode to 16-bit LE
        const [r2020, g2020c, b2020] = _mat3(_M_709_TO_2020, r, g, b);
        const pq0 = Math.round(pqOetf_global(r2020)  * 65535);
        const pq1 = Math.round(pqOetf_global(g2020c) * 65535);
        const pq2 = Math.round(pqOetf_global(b2020)  * 65535);
        hdrBuf[hi]   =  pq0 & 0xff;  hdrBuf[hi+1] = (pq0 >> 8) & 0xff;
        hdrBuf[hi+2] =  pq1 & 0xff;  hdrBuf[hi+3] = (pq1 >> 8) & 0xff;
        hdrBuf[hi+4] =  pq2 & 0xff;  hdrBuf[hi+5] = (pq2 >> 8) & 0xff;
        hdrBuf[hi + 6] = 0xff; // alpha lo
        hdrBuf[hi + 7] = 0xff; // alpha hi (= 65535 opaque)

        // SDR PNG: ICtCp tonemap → sRGB gamma via LUT
        const [rt, gt, bt] = tonemapICtCp_global(r, g, b, maxYInPQ);
        sdrBuf[si]     = Math.round(_srgbLut(rt) * 255);
        sdrBuf[si + 1] = Math.round(_srgbLut(gt) * 255);
        sdrBuf[si + 2] = Math.round(_srgbLut(bt) * 255);
        sdrBuf[si + 3] = 255;

        // Gamut classification on original BT.709 linear values (reuses r2020/g2020c/b2020)
        if (!isFinite(floats[fi]) || !isFinite(floats[fi+1]) || !isFinite(floats[fi+2])) continue;
        const Y = 0.212639 * r + 0.715169 * g + 0.072192 * b;
        gTotal++;
        if ((r >= 0 && g >= 0 && b >= 0) || Y < FP16_MIN) { g709++; continue; }
        const [p3r, p3g, p3b] = _mat3(_M_709_TO_P3, r, g, b);
        if (p3r >= 0 && p3g >= 0 && p3b >= 0) { gP3++; continue; }
        if (r2020 >= 0 && g2020c >= 0 && b2020 >= 0) g2020++;
    }

    // ── HDR PNG with cICP (BT.2020 primaries, PQ transfer) ───────────────────
    const cicp = { primaries: 9, transfer: 16 };
    const hdrPng = await buildPNG16(hdrBuf, w, h, hdrBytesPerPx, cicp);
    const hdrFile = new File([hdrPng], outputName, { type: 'image/png' });

    if (gTotal > 0) {
        hdrFile._jxrGamut = {
            rec709: (g709  / gTotal * 100).toFixed(4),
            p3:     (gP3   / gTotal * 100).toFixed(4),
            bt2020: (g2020 / gTotal * 100).toFixed(4),
            sourcePrimaries: 'BT.709/scRGB',
        };
    }

    // ── SDR PNG ───────────────────────────────────────────────────────────────
    const sdrPng = await buildPNG8(sdrBuf, w, h);
    const sdrFile = new File([sdrPng], outputName.replace('.png', '_SDR.png'), { type: 'image/png' });

    // ── Thumbnail (downscaled HDR PNG, ≤1280px) ───────────────────────────────
    const thumbBlob = await buildHdrThumb(hdrBuf, w, h, cicp, 1280);

    return { hdrFile, sdrBlob: sdrFile, thumbBlob };
}

// ─── AVIF Encoder Helpers ─────────────────────────────────────────────────────

let _avifEncode = null;
async function _getAvifEncoder() {
    if (_avifEncode) return _avifEncode;
    const mod = await import('https://esm.sh/@jsquash/avif');
    _avifEncode = mod.encode;
    return _avifEncode;
}

let _avifDecode = null;
async function _getAvifDecoder() {
    if (_avifDecode) return _avifDecode;
    const mod = await import('https://esm.sh/@jsquash/avif');
    _avifDecode = mod.decode;
    return _avifDecode;
}

// Encodes a Uint16Array of 12-bit BT.2020 PQ RGBA pixels → AVIF blob.
// Patches the colr box to BT.2020 primaries / PQ transfer / full-range.
async function _encodeToAVIF(u16pq, width, height) {
    const encode = await _getAvifEncoder();
    const avifBuf = await encode({ data: u16pq, width, height }, {
        bitDepth: 12, quality: 80, yuvFormat: 'YUV444', matrixCoefficients: 9, speed: 8,
    });
    const data = new Uint8Array(avifBuf);
    const view = new DataView(avifBuf);
    function patchColr(d, v, start, end) {
        let off = start;
        while (off + 8 <= end) {
            const size = v.getUint32(off); if (size < 8) break;
            const type = String.fromCharCode(d[off+4],d[off+5],d[off+6],d[off+7]);
            if (type === 'colr') {
                v.setUint16(off+12, 9); v.setUint16(off+14, 16);
                v.setUint16(off+16, 9); d[off+18] = 0x80; return;
            }
            const cs = type === 'meta' ? off+12 : off+8;
            if (['meta','iprp','ipco'].includes(type)) patchColr(d, v, cs, off+size);
            off += size;
        }
    }
    patchColr(data, view, 0, data.length);
    return new Blob([data], { type: 'image/avif' });
}

// Compute luminance stats and gamut from a 12-bit BT.2020 PQ u16pq buffer.
// This runs immediately after encoding so we never have to re-decode the AVIF.
function _statsFromU12PQ(u16pq, width, height) {
    const numPixels = width * height;
    const sampleStep = numPixels > 8000000 ? Math.ceil(numPixels / 4000000) : 1;

    // PQ EOTF: 12-bit code value [0,4095] → cd/m²
    function pqNits(v) {
        const n = v / 4095;
        const vp = Math.pow(Math.max(n,0), 1/78.84375);
        return 10000 * Math.pow(Math.max(vp-0.8359375,0) / Math.max(18.8515625-18.6875*vp, 1e-10), 1/0.1593017578125);
    }
    // PQ EOTF → linear light (normalised, 1.0 = 10000 nits)
    function pqLinear(v) {
        const n = v / 4095;
        const vp = Math.pow(Math.max(n,0), 1/_PQ_M);
        return Math.pow(Math.max(vp-_PQ_C1,0) / Math.max(_PQ_C2-_PQ_C3*vp,1e-10), 1/_PQ_N) * _SKIV_MAX_PQ;
    }

    // BT.2020 → BT.709
    const M=[1.66049094578,-0.58764109488,-0.07284986467,-0.12455046637,1.13289988028,-0.00834942203,-0.01815076427,-0.10057889487,1.11872966227];
    const M_709_TO_P3=[0.822461962699890,0.177538037300110,0,0.033194199204445,0.966805815696716,0,0.017082631587982,0.072397440671921,0.910519957542419];
    const M_709_TO_2020=[0.627403914928436,0.329283028841019,0.043313067406416,0.069097287952900,0.919540405273438,0.011362315155566,0.016391439363360,0.088013306260109,0.895595252513885];
    function m3(m,r,g,b){return[m[0]*r+m[1]*g+m[2]*b,m[3]*r+m[4]*g+m[5]*b,m[6]*r+m[7]*g+m[8]*b];}

    let maxLum=0, minLum=Infinity, totalLum=0, maxChan=0;
    let g709=0, gP3=0, g2020=0, gTotal=0;
    const FP16_MIN=0.0005;

    for (let i=0; i<numPixels; i+=sampleStep) {
        const r12=u16pq[i*4], g12=u16pq[i*4+1], b12=u16pq[i*4+2];
        const rN=pqNits(r12), gN=pqNits(g12), bN=pqNits(b12);
        const lum=0.2126*rN+0.7152*gN+0.0722*bN;
        if(lum>maxLum)maxLum=lum; if(lum<minLum)minLum=lum; totalLum+=lum;
        const ch=Math.max(rN,gN,bN); if(ch>maxChan)maxChan=ch;

        // Gamut: decode to linear BT.2020, convert to BT.709 scRGB, classify
        const rL=pqLinear(r12), gL=pqLinear(g12), bL=pqLinear(b12);
        const [r,g,b]=m3(M,rL,gL,bL); // BT.2020 → BT.709
        const Y=0.212639*r+0.715169*g+0.072192*b; gTotal++;
        if((r>=0&&g>=0&&b>=0)||Y<FP16_MIN){g709++;continue;}
        const[p3r,p3g,p3b]=m3(M_709_TO_P3,r,g,b); if(p3r>=0&&p3g>=0&&p3b>=0){gP3++;continue;}
        const[r20,g20,b20]=m3(M_709_TO_2020,r,g,b); if(r20>=0&&g20>=0&&b20>=0){g2020++;}
    }

    const sampleCount = Math.ceil(numPixels / sampleStep);
    return {
        luminanceStats: {
            maxCLL: maxChan,
            maxLuminance: maxLum,
            avgLuminance: totalLum / sampleCount,
            minLuminance: minLum === Infinity ? 0 : minLum,
            bitDepth: 12,
            transferCharacteristic: 16,
        },
        gamutCoverage: gTotal > 0 ? {
            rec709:  (g709/gTotal*100).toFixed(4),
            p3:      (gP3/gTotal*100).toFixed(4),
            bt2020:  (g2020/gTotal*100).toFixed(4),
            sourcePrimaries: 'BT.2020',
        } : null,
    };
}

// ─── Any Format → AVIF ────────────────────────────────────────────────────────
// Converts any supported HDR format directly to a 12-bit BT.2020 PQ AVIF.
// Returns { hdrFile, sdrBlob, thumbBlob } — same shape as convertToPNG.
// hdrFile has _avifStats attached so getBasicImageMetadata never needs to re-decode.
async function convertToAVIF(file) {
    const ext = getFileExtension(file.name);
    const outputName = file.name.replace(/\.[^.]+$/, '.avif');

    // ── PNG: already BT.2020 PQ 16-bit — decode via pixel-worker, shift 16→12 ─
    if (ext === '.png') {
        const ab = await file.arrayBuffer();
        const pixelData = await new Promise((resolve, reject) => {
            const worker = new Worker('./pixel-worker.js', { type: 'module' });
            worker.postMessage({ arrayBuffer: ab }, [ab]);
            worker.onmessage = e => { worker.terminate(); resolve(e.data); };
            worker.onerror   = e => { worker.terminate(); reject(new Error(e.message)); };
        });
        if (pixelData.error) throw new Error('pixel-worker: ' + pixelData.error);

        const { pixels, width, height, samplesPerPixel } = pixelData;
        const u16pq = new Uint16Array(width * height * 4);
        for (let i=0, p=0; i<width*height; i++) {
            const base = i * samplesPerPixel * 2;
            u16pq[p++] = ((pixels[base]  <<8)|pixels[base+1]) >> 4;
            u16pq[p++] = ((pixels[base+2]<<8)|pixels[base+3]) >> 4;
            u16pq[p++] = ((pixels[base+4]<<8)|pixels[base+5]) >> 4;
            u16pq[p++] = samplesPerPixel===4 ? ((pixels[base+6]<<8)|pixels[base+7])>>4 : 4095;
        }

        const avifBlob = await _encodeToAVIF(u16pq, width, height);
        const hdrFile  = new File([avifBlob], outputName, { type: 'image/avif' });
        hdrFile._avifStats = _statsFromU12PQ(u16pq, width, height);
        if (file._jxrGamut) hdrFile._avifStats.gamutCoverage = file._jxrGamut;

        const sdrBlob   = await convertToSDR(file, file.name);
        const thumbBlob = await generateThumb(file, 1280);
        return { hdrFile, sdrBlob, thumbBlob };
    }

    // ── JXR / EXR / HDR: decode to linear scRGB floats ───────────────────────
    if (ext === '.jxr' || ext === '.exr' || ext === '.hdr') {
        let getLinear, channels, width, height;

        if (ext === '.jxr') {
            const codec = await getJpegXrCodec();
            const decoded = codec.decode(new Uint8Array(await file.arrayBuffer()));
            width = decoded.width; height = decoded.height;
            channels = decoded.pixelInfo.channels;
            const { bitDepth } = decoded.pixelInfo;
            if (bitDepth !== '16Float' && bitDepth !== '32Float') {
                // Integer JXR — go via PNG path
                const r = await convertJxrToPNG(file);
                return convertToAVIF(r.hdrFile);
            }
            const is32 = bitDepth === '32Float';
            const safeBuf = new ArrayBuffer(decoded.bytes.length);
            new Uint8Array(safeBuf).set(decoded.bytes);
            const sv = is32 ? new Float32Array(safeBuf) : new Uint16Array(safeBuf);
            function f16(h){const s=(h>>>15)?-1:1,e=(h>>>10)&0x1f,m=h&0x03ff;if(e===0)return s*Math.pow(2,-14)*(m/1024);if(e===31)return m?NaN:s*Infinity;return s*Math.pow(2,e-15)*(1+m/1024);}
            getLinear = is32 ? i=>sv[i] : i=>f16(sv[i]);
        } else {
            const inputData = new Uint8Array(await file.arrayBuffer());
            const decoded = ext === '.hdr' ? _decodeRGBE(inputData) : await _decodeEXR(inputData);
            width = decoded.width; height = decoded.height; channels = 3;
            getLinear = i => decoded.floats[i];
        }

        return _floatsToAVIF(getLinear, channels, width, height, outputName);
    }

    // ── AVIF input: re-encode at 12-bit ──────────────────────────────────────
    if (ext === '.avif') {
        const r = await convertToPNG(file);
        return convertToAVIF(r.hdrFile);
    }

    throw new Error(`convertToAVIF: unsupported format "${ext}"`);
}

// Shared float→AVIF path for JXR / EXR / HDR.
// getLinear(sampleIndex) returns a BT.709 linear scRGB float.
async function _floatsToAVIF(getLinear, channels, width, height, outputName) {
    const numPixels = width * height;

    // 99.94th-percentile for SDR tonemap peak
    const pqFreq = new Uint32Array(65536); let maxPQseen=0;
    for (let i=0; i<numPixels; i++) {
        const fi=i*channels;
        const Y=Math.max(0.212639*getLinear(fi)+0.715169*getLinear(fi+1)+0.072192*getLinear(fi+2),0);
        const pq=pqOetf_global(Math.min(_SKIV_MAX_PQ,Y));
        pqFreq[Math.min(Math.round(pq*65535),65535)]++;
        if(pq>maxPQseen)maxPQseen=pq;
    }
    let maxYInPQ=maxPQseen;
    {let pct=100;for(let i=65535;i>=0;i--){pct-=100*pqFreq[i]/numPixels;if(pct<=99.94){maxYInPQ=i/65535;break;}}}
    maxYInPQ=Math.max(_SDR_Y_IN_PQ,maxYInPQ);

    const u16pq  = new Uint16Array(numPixels*4);
    const sdrBuf = new Uint8ClampedArray(numPixels*4);

    for (let i=0; i<numPixels; i++) {
        const fi=i*channels;
        const r=Math.max(isFinite(getLinear(fi))  ?getLinear(fi)  :0,0);
        const g=Math.max(isFinite(getLinear(fi+1))?getLinear(fi+1):0,0);
        const b=Math.max(isFinite(getLinear(fi+2))?getLinear(fi+2):0,0);
        const [r20,g20,b20]=_mat3(_M_709_TO_2020,r,g,b);
        u16pq[i*4]  =Math.round(pqOetf_global(Math.max(r20,0))*4095);
        u16pq[i*4+1]=Math.round(pqOetf_global(Math.max(g20,0))*4095);
        u16pq[i*4+2]=Math.round(pqOetf_global(Math.max(b20,0))*4095);
        u16pq[i*4+3]=4095;
        const[rt,gt,bt]=tonemapICtCp_global(r,g,b,maxYInPQ);
        sdrBuf[i*4]=Math.round(_srgbLut(rt)*255); sdrBuf[i*4+1]=Math.round(_srgbLut(gt)*255);
        sdrBuf[i*4+2]=Math.round(_srgbLut(bt)*255); sdrBuf[i*4+3]=255;
    }

    const avifBlob = await _encodeToAVIF(u16pq, width, height);
    const hdrFile  = new File([avifBlob], outputName, { type: 'image/avif' });
    hdrFile._avifStats = _statsFromU12PQ(u16pq, width, height);

    const sdrPng   = await buildPNG8(sdrBuf, width, height);
    const sdrBlob  = new File([sdrPng], outputName.replace('.avif','_SDR.png'), { type:'image/png' });

    // Thumb: build a small HDR PNG from the 12-bit buffer (shift up to 16-bit LE)
    const hdrBuf16 = new Uint8Array(numPixels*8);
    for (let i=0; i<numPixels; i++) {
        const v0=u16pq[i*4]<<4, v1=u16pq[i*4+1]<<4, v2=u16pq[i*4+2]<<4;
        hdrBuf16[i*8]=v0&0xff; hdrBuf16[i*8+1]=(v0>>8)&0xff;
        hdrBuf16[i*8+2]=v1&0xff; hdrBuf16[i*8+3]=(v1>>8)&0xff;
        hdrBuf16[i*8+4]=v2&0xff; hdrBuf16[i*8+5]=(v2>>8)&0xff;
        hdrBuf16[i*8+6]=0xff; hdrBuf16[i*8+7]=0xff;
    }
    const thumbBlob = await buildHdrThumb(hdrBuf16, width, height, {primaries:9,transfer:16}, 1280);

    return { hdrFile, sdrBlob, thumbBlob };
}

async function convertToPNG(file) {
    const ext = getFileExtension(file.name);

    // JXR is handled by convertJxrToPNG — forward its full result including sdrBlob/thumbBlob
    if (ext === '.jxr') {
        return await convertJxrToPNG(file);
    }

    // HDR (Radiance RGBE) and EXR (OpenEXR) contain linear HDR values above 1.0.
    // ImageMagick's standard RGBA output clips to [0,1], losing all HDR headroom.
    // Route them through convertHdrExrToPNG which reads as float32 to preserve it.
    if (ext === '.hdr' || ext === '.exr') {
        return await convertHdrExrToPNG(file);
    }

    const { ImageMagick, MagickFormat } = await getMagick();
    const arrayBuffer = await file.arrayBuffer();
    const inputData = new Uint8Array(arrayBuffer);
    const outputName = file.name.replace(/\.[^.]+$/, '.png');

    // Extract cICP from source before handing off to ImageMagick (which may strip it)
    let cicp = null;
    if (ext === '.avif') cicp = parseAVIFCICP(inputData);

    const imageInfo = await new Promise((resolve, reject) => {
        try {
            ImageMagick.read(inputData, (image) => {
                const w = image.width, h = image.height;
                image.depth = 16;
                // Write raw RGBA to get true 16-bit samples; MagickFormat.Png is 8-bit in this build.
                image.write((data) => {
                    const raw = new Uint8Array(data);
                    const bytesPerPx = raw.length / (w * h);
                    resolve({ w, h, raw, bytesPerPx });
                }, MagickFormat.Rgba);
            });
        } catch(err) { reject(err); }
    });

    const finalData = await buildPNG16(imageInfo.raw, imageInfo.w, imageInfo.h, imageInfo.bytesPerPx, cicp);
    const hdrBlob = new Blob([finalData], { type: 'image/png' });
    const hdrFile = new File([hdrBlob], outputName, { type: 'image/png' });

    // ── SDR blob for PQ AVIF sources ──────────────────────────────────────────
    // We can't use the ImageMagick raw RGBA buffer for tone-mapping: ImageMagick clips
    // linear light to [0, 1] when decoding, losing all HDR headroom above 80 nits.
    // Instead, run the freshly-built HDR PNG (PQ-encoded, BT.2020, with cICP) through
    // the same pure-JS pipeline that convertToSDR uses for 16-bit PQ PNGs — this is
    // the only path that correctly reconstructs the full HDR luminance range.
    let sdrBlob = null;
    if (cicp && cicp.transfer === 16) {
        sdrBlob = await convertToSDR(hdrFile, outputName);
    }

    return { hdrFile, sdrBlob, thumbBlob: null };
}

// ─── Binary Parsers ───────────────────────────────────────────────────────────

// Extract cICP primaries + transfer characteristic from an AVIF file by scanning
// the ISOBMFF box tree for a 'colr' box with colour type 'nclx'.
function parseAVIFCICP(data) {
    function scanBoxes(data, start, end) {
        let offset = start;
        while (offset < end - 8) {
            const boxSize = (data[offset] << 24 | data[offset+1] << 16 | data[offset+2] << 8 | data[offset+3]) >>> 0;
            if (boxSize < 8 || offset + boxSize > end) break;
            const boxType = String.fromCharCode(data[offset+4], data[offset+5], data[offset+6], data[offset+7]);

            if (boxType === 'colr' && offset + 16 <= end) {
                const ct = String.fromCharCode(data[offset+8], data[offset+9], data[offset+10], data[offset+11]);
                if (ct === 'nclx') {
                    return {
                        primaries: (data[offset+12] << 8) | data[offset+13],
                        transfer:  (data[offset+14] << 8) | data[offset+15],
                    };
                }
            }

            // Recurse into container boxes.
            // 'meta' and 'iinf' are FullBoxes: skip 4 extra bytes (version + flags) before children.
            const containers     = ['moov','trak','mdia','minf','stbl','stsd','av01','avio','ipco','iprp','moof','traf'];
            const fullContainers = ['meta','iinf'];
            if (containers.includes(boxType)) {
                const result = scanBoxes(data, offset + 8, offset + boxSize);
                if (result) return result;
            } else if (fullContainers.includes(boxType)) {
                const result = scanBoxes(data, offset + 12, offset + boxSize);
                if (result) return result;
            }

            if (boxType === 'mdat') break; // pixel data — stop scanning
            offset += boxSize;
        }
        return null;
    }
    return scanBoxes(data, 0, Math.min(data.length, 200000));
}

// Re-inject a cICP chunk into a PNG immediately after the IHDR chunk.
// ImageMagick strips cICP during processing; this restores it.
// PNG structure: sig(8) + IHDR(4+4+13+4=25) = insert at byte 33.
function reinjectCICP(pngData, cicp) {
    const cicpChunk = makeChunk('cICP', new Uint8Array([cicp.primaries, cicp.transfer, 0, 1]));
    const insertAt = 33; // right after IHDR
    const out = new Uint8Array(pngData.length + cicpChunk.length);
    out.set(pngData.slice(0, insertAt), 0);
    out.set(cicpChunk, insertAt);
    out.set(pngData.slice(insertAt), insertAt + cicpChunk.length);
    return out;
}

// ─── PNG Chunk Helpers ────────────────────────────────────────────────────────

function makeChunk(type, data) {
    const tb = [type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)];
    const chunk = new Uint8Array(12 + data.length);
    const dv = new DataView(chunk.buffer);
    dv.setUint32(0, data.length);
    chunk[4]=tb[0]; chunk[5]=tb[1]; chunk[6]=tb[2]; chunk[7]=tb[3];
    chunk.set(data, 8);
    // CRC32 covers type bytes + data — computed in two segments to avoid allocating a combined buffer.
    // crc32(data, seed) chains: first run over the 4-byte type, then continue over the payload.
    const crcType = crc32(new Uint8Array(tb));
    dv.setUint32(8 + data.length, crc32(data, crcType));
    return chunk;
}

// Compress data with the native deflate-raw stream, then wrap in a zlib envelope
// (2-byte header + deflated payload + 4-byte Adler-32), as required by PNG IDAT.
async function deflateRaw(data) {
    const cs = new CompressionStream('deflate-raw');
    const writer = cs.writable.getWriter();
    writer.write(data);
    writer.close();
    const chunks = [];
    const reader = cs.readable.getReader();
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
    }
    const deflated = new Uint8Array(chunks.reduce((a,c) => a + c.length, 0));
    let off = 0;
    for (const c of chunks) { deflated.set(c, off); off += c.length; }

    // Adler-32 of the original uncompressed data for the zlib trailer
    let s1 = 1, s2 = 0;
    for (let i = 0; i < data.length; i++) { s1=(s1+data[i])%65521; s2=(s2+s1)%65521; }

    const out = new Uint8Array(2 + deflated.length + 4);
    out[0] = 0x78; out[1] = 0x9c; // zlib header (deflate, default compression)
    out.set(deflated, 2);
    const t = 2 + deflated.length;
    out[t]=(s2>>8)&0xff; out[t+1]=s2&0xff; out[t+2]=(s1>>8)&0xff; out[t+3]=s1&0xff;
    return out;
}

// Precomputed CRC-32 table — eliminates the 8-iteration bit-loop per byte.
// Built once at module load; ~1KB, negligible cost.
const _CRC32_TABLE = (() => {
    const t = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        t[i] = c;
    }
    return t;
})();

// crc32(data, seed?) — seed lets callers chain multiple buffers without allocating
// a combined array. Default seed is 0 (equivalent to the standard 0xffffffff start).
function crc32(data, seed = 0) {
    let crc = ~seed; // ~0 === 0xffffffff; ~previous_result re-opens the running CRC
    for (let i = 0; i < data.length; i++) crc = _CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

// ─── Tonemap Worker Helper ────────────────────────────────────────────────────
// Offloads the PQ→SDR pixel loop to tonemap-worker.js so the main thread stays
// responsive during heavy images.  A new worker is created per call so concurrent
// conversions (multiple uploads at once) never share state.
function _tonemapOnWorker(pixels, width, height, samplesPerPixel) {
    return new Promise((resolve, reject) => {
        const worker = new Worker('./tonemap-worker.js');
        worker.onmessage = (e) => {
            worker.terminate();
            if (e.data.error) reject(new Error(e.data.error));
            else resolve(new Uint8ClampedArray(e.data.sdrBuf));
        };
        worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message)); };
        // Transfer pixels zero-copy — the Uint8Array's buffer is detached after this call.
        worker.postMessage({ pixels, width, height, samplesPerPixel }, [pixels.buffer]);
    });
}

// ─── HDR → SDR Tone Mapping ───────────────────────────────────────────────────
// Converts any supported HDR image blob to an 8-bit sRGB PNG using SKIV's
// ICtCp tone-map operator.
//
// For 16-bit PQ PNGs (cICP transfer=16): the browser canvas is bypassed entirely.
// Chrome tone-maps PQ→SDR when drawing into an sRGB canvas context, producing
// already-crushed SDR pixels before our tone-mapper could run. Instead we decode
// the PNG in pure JS (decodePixelBuffer), apply the PQ EOTF, convert BT.2020→BT.709,
// compute the 99.94th-percentile peak with a luminance histogram (matching
// SKIV_Image_TonemapToSDR), then tone-map and encode via buildPNG8.
//
// For sRGB / non-PQ images: the canvas path is safe and used as a fallback.
async function convertToSDR(blob, filename) {
    const sdrFilename = filename.replace(/\.(png|avif|jxr|exr|hdr)$/i, '_SDR.png');

    // ── Pure-JS path for 16-bit PQ PNGs ──────────────────────────────────────
    let pixelBuf = null;
    try { pixelBuf = await decodePixelBuffer(blob); } catch(_) {}

    if (pixelBuf && pixelBuf.transferCharacteristic === 16) {
        const { pixels, width, height, samplesPerPixel } = pixelBuf;
        const numPixels  = width * height;
        const bytesPerPx = samplesPerPixel * 2; // 16-bit big-endian per sample

        // PQ EOTF look-up table: 16-bit code value → linear scRGB in BT.2020 primaries
        const lut = new Float32Array(65536);
        for (let i = 0; i < 65536; i++) lut[i] = pqEotf_global(i / 65535);

        // BT.2020 → BT.709 (exact inverse of _M_709_TO_2020)
        const M_2020_TO_709 = [
             1.66049094578, -0.58764109488, -0.07284986467,
            -0.12455046637,  1.13289988028, -0.00834942203,
            -0.01815076427, -0.10057889487,  1.11872966227,
        ];

        function mat3local(m, r, g, b) {
            return [m[0]*r+m[1]*g+m[2]*b, m[3]*r+m[4]*g+m[5]*b, m[6]*r+m[7]*g+m[8]*b];
        }

        // ── Offload histogram + tonemap to worker, freeing the main thread ─────
        // pixels is transferred zero-copy; the Uint8Array is detached after the call.
        const sdrBuf = await _tonemapOnWorker(pixels, width, height, samplesPerPixel);

        const sdrPng = await buildPNG8(sdrBuf, width, height);
        return new File([sdrPng], sdrFilename, { type: 'image/png' });
    }

    // ── Canvas fallback for sRGB / non-PQ images ──────────────────────────────
    return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(blob);
        img.onload = async () => {
            URL.revokeObjectURL(url);
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
            ctx.drawImage(img, 0, 0);
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const data = imageData.data;
            // Assume a modest HDR peak for sRGB sources (1000 cd/m² = 12.5 scRGB)
            const ASSUMED_PEAK_SCRGB = 1000 / 80;
            const maxYInPQ_sdr = Math.max(_SDR_Y_IN_PQ, pqOetf_global(ASSUMED_PEAK_SCRGB));
            for (let i = 0; i < data.length; i += 4) {
                const r = sRGBtoLinear(data[i]     / 255);
                const g = sRGBtoLinear(data[i + 1] / 255);
                const b = sRGBtoLinear(data[i + 2] / 255);
                const [rt, gt, bt] = tonemapICtCp_global(r, g, b, maxYInPQ_sdr);
                data[i]     = Math.max(0, Math.min(255, Math.round(_srgbLut(rt) * 255)));
                data[i + 1] = Math.max(0, Math.min(255, Math.round(_srgbLut(gt) * 255)));
                data[i + 2] = Math.max(0, Math.min(255, Math.round(_srgbLut(bt) * 255)));
            }
            ctx.putImageData(imageData, 0, 0);
            canvas.toBlob((sdrBlob) => {
                if (sdrBlob) resolve(new File([sdrBlob], sdrFilename, { type: 'image/png' }));
                else         reject(new Error('Failed to convert to SDR'));
            }, 'image/png');
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to load image for SDR conversion')); };
        img.src = url;
    });
}

// ─── HDR Thumbnail Generation ─────────────────────────────────────────────────
// Downscales an HDR PNG to ≤maxWidth px on the longest edge via ImageMagick,
// then re-injects the cICP chunk (which ImageMagick strips during resize).
// Tries lossless WebP first; falls back to 16-bit PNG.
async function generateThumb(blob, maxWidth = 1280) {
    const { ImageMagick, MagickFormat } = await getMagick();
    const arrayBuffer = await blob.arrayBuffer();
    const inputData = new Uint8Array(arrayBuffer);

    // Preserve cICP before ImageMagick processes the file
    let cicp = null;
    {
        const d = inputData;
        let o = 8;
        while (o < d.length - 8) {
            const len = (d[o]<<24|d[o+1]<<16|d[o+2]<<8|d[o+3])>>>0;
            const t = String.fromCharCode(d[o+4],d[o+5],d[o+6],d[o+7]);
            if (t === 'cICP') { cicp = { primaries: d[o+8], transfer: d[o+9] }; break; }
            if (t === 'IDAT' || t === 'IEND') break;
            o += 12 + len;
        }
    }

    return new Promise((resolve, reject) => {
        try {
            ImageMagick.read(inputData, (image) => {
                if (image.width <= maxWidth && image.height <= maxWidth) {
                    resolve(null); // already small enough
                    return;
                }

                // Resize to fit within maxWidth, preserving aspect ratio
                if (image.width >= image.height) {
                    image.resize(maxWidth, Math.round(maxWidth * image.height / image.width));
                } else {
                    image.resize(Math.round(maxWidth * image.width / image.height), maxWidth);
                }
                image.depth = 16;

                // Try lossless WebP; fall back to PNG if the codec isn't available.
                // For PQ/HLG sources always use PNG — WebP has no standardised cICP
                // support, so ImageMagick strips the HDR metadata, producing an SDR blob.
                const isHDR = cicp && (cicp.transfer === 16 || cicp.transfer === 18);
                const tryWebP = () => {
                    try {
                        image.quality = 0; // signals lossless in ImageMagick
                        image.write((data) => {
                            resolve(new Blob([data], { type: 'image/webp' }));
                        }, MagickFormat.WebP);
                    } catch (e) {
                        tryPNG();
                    }
                };

                const tryPNG = () => {
                    try {
                        image.write(async (data) => {
                            try {
                                const withCicp = cicp
                                    ? await reinjectCICP(new Uint8Array(data), cicp)
                                    : data;
                                resolve(new Blob([withCicp], { type: 'image/png' }));
                            } catch (e) {
                                resolve(new Blob([data], { type: 'image/png' }));
                            }
                        }, MagickFormat.Png);
                    } catch (e) {
                        reject(e);
                    }
                };

                if (isHDR) tryPNG(); else tryWebP();
            });
        } catch (err) {
            reject(err);
        }
    });
}

// ─── Transfer Function Helpers ────────────────────────────────────────────────

// sRGB EOTF: gamma-encoded [0,1] → linear [0,1]
function sRGBtoLinear(C) {
    return C <= 0.04045 ? C / 12.92 : Math.pow((C + 0.055) / 1.055, 2.4);
}

// sRGB OETF: linear [0,1] → gamma-encoded [0,1]
function linearToSRGB(C) {
    return C <= 0.0031308 ? C * 12.92 : 1.055 * Math.pow(C, 1.0 / 2.4) - 0.055;
}

// ─── Luminance Analysis ───────────────────────────────────────────────────────
// Decompresses a 16-bit PNG in pure JS and computes MaxCLL / MaxFALL / peak / avg
// luminance, respecting the transfer function declared in the cICP chunk.
async function analyze16BitPNG(blob) {
    const arrayBuffer = await blob.arrayBuffer();
    const data = new Uint8Array(arrayBuffer);

    if (data[0] !== 0x89 || data[1] !== 0x50) return null; // not a PNG

    // Parse IHDR
    let width = 0, height = 0, bitDepth = 0, colorType = 0;
    let offset = 8;
    {
        const len = (data[offset]<<24|data[offset+1]<<16|data[offset+2]<<8|data[offset+3])>>>0;
        const type = String.fromCharCode(data[offset+4],data[offset+5],data[offset+6],data[offset+7]);
        if (type === 'IHDR') {
            width  = (data[offset+8] <<24|data[offset+9] <<16|data[offset+10]<<8|data[offset+11])>>>0;
            height = (data[offset+12]<<24|data[offset+13]<<16|data[offset+14]<<8|data[offset+15])>>>0;
            bitDepth  = data[offset+16];
            colorType = data[offset+17];
        }
        offset += 12 + len;
    }

    // Only handle 16-bit RGB (colorType 2) or RGBA (colorType 6)
    if (bitDepth !== 16 || (colorType !== 2 && colorType !== 6)) return null;
    const samplesPerPixel = colorType === 6 ? 4 : 3;

    // Collect all IDAT chunks
    const idatChunks = [];
    offset = 8;
    while (offset < data.length - 8) {
        const len = (data[offset]<<24|data[offset+1]<<16|data[offset+2]<<8|data[offset+3])>>>0;
        const type = String.fromCharCode(data[offset+4],data[offset+5],data[offset+6],data[offset+7]);
        if (type === 'IDAT') idatChunks.push(data.slice(offset + 8, offset + 8 + len));
        if (type === 'IEND') break;
        offset += 12 + len;
    }
    if (idatChunks.length === 0) return null;

    // Decompress
    const combined = new Uint8Array(idatChunks.reduce((a,c) => a + c.length, 0));
    let pos = 0;
    for (const c of idatChunks) { combined.set(c, pos); pos += c.length; }
    const ds = new DecompressionStream('deflate');
    const writer = ds.writable.getWriter();
    writer.write(combined); writer.close();
    const rawChunks = [];
    const reader = ds.readable.getReader();
    while (true) { const { done, value } = await reader.read(); if (done) break; rawChunks.push(value); }
    const raw = new Uint8Array(rawChunks.reduce((a,c) => a + c.length, 0));
    let rpos = 0;
    for (const c of rawChunks) { raw.set(c, rpos); rpos += c.length; }

    // Reconstruct PNG-filtered scanlines (filter types 0–4)
    const bytesPerPixel = samplesPerPixel * 2;
    const stride = 1 + width * bytesPerPixel;
    const pixels = new Uint8Array(width * height * bytesPerPixel);

    function paethPredictor(a, b, c) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }

    for (let y = 0; y < height; y++) {
        const ft = raw[y * stride];
        const rowIn  = raw.subarray(y * stride + 1, y * stride + 1 + width * bytesPerPixel);
        const rowOut = pixels.subarray(y * width * bytesPerPixel, (y + 1) * width * bytesPerPixel);
        const prevRow = y > 0 ? pixels.subarray((y-1) * width * bytesPerPixel, y * width * bytesPerPixel) : null;
        for (let x = 0; x < rowIn.length; x++) {
            const rb = rowIn[x];
            const a = x >= bytesPerPixel ? rowOut[x - bytesPerPixel] : 0;
            const b = prevRow ? prevRow[x] : 0;
            const c = (x >= bytesPerPixel && prevRow) ? prevRow[x - bytesPerPixel] : 0;
            switch (ft) {
                case 0: rowOut[x] = rb;                                         break;
                case 1: rowOut[x] = (rb + a) & 0xff;                            break;
                case 2: rowOut[x] = (rb + b) & 0xff;                            break;
                case 3: rowOut[x] = (rb + Math.floor((a + b) / 2)) & 0xff;      break;
                case 4: rowOut[x] = (rb + paethPredictor(a, b, c)) & 0xff;      break;
                default: rowOut[x] = rb;
            }
        }
    }

    // Read cICP transfer characteristic from PNG chunks
    let transferCharacteristic = null;
    {
        let o = 8;
        while (o < data.length - 8) {
            const len = (data[o]<<24|data[o+1]<<16|data[o+2]<<8|data[o+3])>>>0;
            const t = String.fromCharCode(data[o+4],data[o+5],data[o+6],data[o+7]);
            if (t === 'cICP') { transferCharacteristic = data[o + 9]; break; }
            if (t === 'IDAT' || t === 'IEND') break;
            o += 12 + len;
        }
    }

    // EOTF: encoded sample [0,1] → cd/m²
    // PQ (ST.2084)
    function pqToNits(v) {
        const m1 = 0.1593017578125, m2 = 78.84375;
        const c1 = 0.8359375, c2 = 18.8515625, c3 = 18.6875;
        const vp = Math.pow(Math.max(v, 0), 1 / m2);
        return 10000 * Math.pow(Math.max(vp - c1, 0) / Math.max(c2 - c3 * vp, 1e-10), 1 / m1);
    }
    // HLG — assumes a 1000 cd/m² display (typical)
    function hlgToNits(v) {
        const a = 0.17883277, b = 0.28466892, c = 0.55991073;
        const lin = v <= 0.5 ? (v * v) / 3 : (Math.exp((v - c) / a) + b) / 12;
        return lin * 1000;
    }
    // Linear scRGB: 1.0 = 80 cd/m²
    function linearToNits(v) { return v * 80; }

    const eotf = transferCharacteristic === 16 ? pqToNits
               : transferCharacteristic === 18 ? hlgToNits
               : linearToNits;

    let maxLum = 0, minLum = Infinity, totalLum = 0, maxChan = 0;
    const pixelCount = width * height;
    // Thin to ~4M samples for very large images
    const sampleStep = pixelCount > 8000000 ? Math.ceil(pixelCount / 4000000) : 1;

    for (let i = 0; i < pixelCount; i += sampleStep) {
        const base = i * bytesPerPixel;
        const rNits = eotf((pixels[base]     << 8 | pixels[base + 1]) / 65535);
        const gNits = eotf((pixels[base + 2] << 8 | pixels[base + 3]) / 65535);
        const bNits = eotf((pixels[base + 4] << 8 | pixels[base + 5]) / 65535);
        const lum   = 0.2126 * rNits + 0.7152 * gNits + 0.0722 * bNits;
        if (lum  > maxLum)  maxLum  = lum;
        if (lum  < minLum)  minLum  = lum;
        totalLum += lum;
        const ch = Math.max(rNits, gNits, bNits);
        if (ch > maxChan) maxChan = ch;
    }

    return {
        maxCLL: maxChan,
        maxLuminance: maxLum,
        avgLuminance: totalLum / (pixelCount / sampleStep),
        minLuminance: minLum === Infinity ? 0 : minLum,
        bitDepth: 16,
        transferCharacteristic,
    };
}

// ─── PNG Metadata Parser ──────────────────────────────────────────────────────
// Reads HDR-relevant PNG chunks: IHDR, cICP, gAMA, cHRM, iCCP, cLLi, mDCv.
async function parsePNGMetadata(blob) {
    try {
        const arrayBuffer = await blob.arrayBuffer();
        const data = new Uint8Array(arrayBuffer);

        if (data[0] !== 0x89 || data[1] !== 0x50 || data[2] !== 0x4E || data[3] !== 0x47) return null;

        let offset = 8;
        let bitDepth = null, colorType = null;
        let hasGAMA = false, hasCHRM = false, hasICCP = false;
        let gamma = null;
        let maxCLL = null, maxFALL = null;
        let maxLuminance = null, minLuminance = null;
        let cicpColorPrimaries = null, cicpTransferFunction = null;
        let cicpMatrixCoefficients = null, cicpFullRange = null;

        while (offset < data.length - 8) {
            const length = (data[offset]<<24|data[offset+1]<<16|data[offset+2]<<8|data[offset+3]) >>> 0;
            const type = String.fromCharCode(data[offset+4],data[offset+5],data[offset+6],data[offset+7]);

            if (type === 'IHDR') {
                bitDepth  = data[offset + 16];
                colorType = data[offset + 17];
            } else if (type === 'gAMA') {
                hasGAMA = true;
                const gammaInt = (data[offset+8]<<24|data[offset+9]<<16|data[offset+10]<<8|data[offset+11]) >>> 0;
                gamma = (100000 / gammaInt).toFixed(2);
            } else if (type === 'cHRM') {
                hasCHRM = true;
            } else if (type === 'cICP' && length >= 4) {
                cicpColorPrimaries     = data[offset + 8];
                cicpTransferFunction   = data[offset + 9];
                cicpMatrixCoefficients = data[offset + 10];
                cicpFullRange          = data[offset + 11];
            } else if (type === 'iCCP') {
                hasICCP = true;
            } else if (type === 'cLLi' && length >= 8) {
                // Content Light Level: MaxCLL and MaxFALL in cd/m²
                maxCLL  = (data[offset+8] <<24|data[offset+9] <<16|data[offset+10]<<8|data[offset+11]) >>> 0;
                maxFALL = (data[offset+12]<<24|data[offset+13]<<16|data[offset+14]<<8|data[offset+15]) >>> 0;
            } else if (type === 'mDCv' && length >= 24) {
                // Mastering Display Color Volume: max/min luminance in units of 0.0001 cd/m²
                const base = offset + 8 + 20; // skip 20 bytes of display primaries
                maxLuminance = ((data[base]  <<24|data[base+1]<<16|data[base+2]<<8|data[base+3]) >>> 0) / 10000;
                minLuminance = ((data[base+4]<<24|data[base+5]<<16|data[base+6]<<8|data[base+7]) >>> 0) / 10000;
            } else if (type === 'IEND') {
                break;
            }

            offset += 12 + length;
        }

        const colorTypeNames = { 0:'Grayscale', 2:'RGB', 3:'Indexed', 4:'Grayscale + Alpha', 6:'RGBA' };
        const cicpPrimariesNames = { 1:'BT.709', 9:'BT.2020', 12:'P3-D65', 11:'P3-DCI' };
        const cicpTransferNames  = {
            1:'BT.709', 13:'sRGB', 14:'BT.2100 Linear',
            16:'PQ (HDR10 / ST.2084)', 18:'HLG (Hybrid Log-Gamma)',
        };

        return {
            bitDepth:  `${bitDepth}-bit`,
            colorType: colorTypeNames[colorType] || 'Unknown',
            gamma:     gamma ? `${gamma}` : 'Not specified',
            hasColorProfile:  hasICCP,
            hasChromaInfo:    hasCHRM,
            transferFunction: cicpTransferFunction !== null
                ? (cicpTransferNames[cicpTransferFunction] || `Transfer ID ${cicpTransferFunction}`)
                : hasGAMA ? 'Gamma corrected' : 'Not specified',
            colorPrimaries: cicpColorPrimaries !== null
                ? (cicpPrimariesNames[cicpColorPrimaries] || `Primaries ID ${cicpColorPrimaries}`)
                : null,
            fullRange: cicpFullRange !== null ? (cicpFullRange ? 'Full' : 'Limited') : null,
            maxContentLightLevel:       maxCLL  !== null ? `${maxCLL} nits`               : null,
            maxFrameAverageLightLevel:  maxFALL !== null ? `${maxFALL} nits`              : null,
            maxLuminance: maxLuminance  !== null ? `${maxLuminance.toFixed(2)} nits`      : null,
            minLuminance: minLuminance  !== null ? `${minLuminance.toFixed(4)} nits`      : null,
        };
    } catch (error) {
        console.error('PNG parsing error:', error);
        return null;
    }
}

// ─── AVIF Metadata Parser ─────────────────────────────────────────────────────
// Recursively walks the ISOBMFF box tree. colr/pixi/clli/mdcv are nested inside
// meta → iprp → ipco — a flat top-level scan misses them entirely.
async function parseAVIFMetadata(blob) {
    try {
        const arrayBuffer = await blob.arrayBuffer();
        const data = new Uint8Array(arrayBuffer);
        if (data.length < 12) return null;
        if (String.fromCharCode(data[4],data[5],data[6],data[7]) !== 'ftyp') return null;

        let bitDepth = '12-bit';
        let colorPrimaries = null, transferCharacteristic = null;
        let maxCLL = null, maxFALL = null;
        let maxLuminance = null, minLuminance = null;

        const CONTAINERS      = new Set(['moov','trak','mdia','minf','stbl','stsd','av01','avio','ipco','iprp','moof','traf']);
        const FULL_CONTAINERS = new Set(['meta','iinf']); // FullBoxes: 4-byte version+flags prefix

        function walk(start, end) {
            let off = start;
            while (off + 8 <= end) {
                const size = (data[off]<<24|data[off+1]<<16|data[off+2]<<8|data[off+3]) >>> 0;
                if (size < 8 || off + size > end) break;
                const type = String.fromCharCode(data[off+4],data[off+5],data[off+6],data[off+7]);

                if (type === 'colr' && off + 18 <= end) {
                    const ct = String.fromCharCode(data[off+8],data[off+9],data[off+10],data[off+11]);
                    if (ct === 'nclx') {
                        colorPrimaries         = (data[off+12]<<8)|data[off+13];
                        transferCharacteristic = (data[off+14]<<8)|data[off+15];
                    }
                } else if (type === 'pixi' && off + 14 <= end) {
                    // pixi = FullBox: [4 size][4 type][1 version][3 flags][1 num_channels][1+ bpc...]
                    // off+8=version, off+9..11=flags, off+12=num_channels, off+13=bpc[0]
                    const bpc = data[off + 13];
                    if (bpc > 0) bitDepth = `${bpc}-bit`;
                } else if (type === 'clli' && off + 12 <= end) {
                    maxCLL  = (data[off+8] <<8)|data[off+9];
                    maxFALL = (data[off+10]<<8)|data[off+11];
                } else if (type === 'mdcv' && off + 40 <= end) {
                    const base = off + 8 + 24; // skip 3×(x,y) primary pairs = 24 bytes
                    maxLuminance = ((data[base]  <<24|data[base+1]<<16|data[base+2]<<8|data[base+3])>>>0) / 10000;
                    minLuminance = ((data[base+4]<<24|data[base+5]<<16|data[base+6]<<8|data[base+7])>>>0) / 10000;
                } else if (type === 'mdat') {
                    break; // pixel data — stop
                }

                if (CONTAINERS.has(type))           walk(off + 8,  off + size);
                else if (FULL_CONTAINERS.has(type)) walk(off + 12, off + size);

                off += size;
            }
        }
        walk(0, Math.min(data.length, 300000));

        const tcNames = {16:'PQ (HDR10 / ST.2084)',18:'HLG (Hybrid Log-Gamma)',1:'sRGB / BT.709',13:'sRGB / BT.709'};
        const cpNames = {1:'BT.709',9:'BT.2020',12:'P3-D65',11:'P3-DCI'};
        const transferFunction = transferCharacteristic !== null
            ? (tcNames[transferCharacteristic] || `Transfer ID ${transferCharacteristic}`)
            : 'Not specified';

        return {
            bitDepth,
            colorType: 'RGB/RGBA',
            colorPrimaries: colorPrimaries !== null ? (cpNames[colorPrimaries] || `Primaries ID ${colorPrimaries}`) : null,
            gamma: transferFunction.includes('sRGB') ? '2.2 (sRGB)' : 'HDR transfer function',
            hasColorProfile: transferCharacteristic !== null,
            transferFunction,
            format: 'AVIF (AV1 Image)',
            maxContentLightLevel:      maxCLL  != null ? `${maxCLL} nits`              : null,
            maxFrameAverageLightLevel: maxFALL != null ? `${maxFALL} nits`             : null,
            maxLuminance: maxLuminance != null ? `${maxLuminance.toFixed(2)} nits`     : null,
            minLuminance: minLuminance != null ? `${minLuminance.toFixed(4)} nits`     : null,
        };
    } catch (error) {
        console.error('AVIF parsing error:', error);
        return null;
    }
}

// ─── Per-pixel Nit Inspection ─────────────────────────────────────────────────
// Decompresses a 16-bit PNG into a raw pixel buffer for per-pixel nit reads.
// Returns { pixels, width, height, samplesPerPixel, transferCharacteristic } or null.
async function decodePixelBuffer(blob) {
    const arrayBuffer = await blob.arrayBuffer();
    const data = new Uint8Array(arrayBuffer);

    const isPNG  = data[0] === 0x89 && data[1] === 0x50;
    const isAVIF = data.length > 8 &&
        String.fromCharCode(data[4], data[5], data[6], data[7]) === 'ftyp';

    if (!isPNG && !isAVIF) return null;

    // ── AVIF path: decode via OffscreenCanvas (mirrors pixel-worker.js) ───────
    if (isAVIF) {
        // Use @jsquash/avif decode with bitDepth:12 to get raw 12-bit PQ values [0–4095].
        // This bypasses browser canvas color management entirely — no float16 requirement,
        // no silent sRGB fallback, HDR precision is always preserved.
        const avifDecode = await _getAvifDecoder();
        const arrayBuffer = blob instanceof ArrayBuffer ? blob : await blob.arrayBuffer();
        const { data, width, height } = await avifDecode(arrayBuffer, { bitDepth: 12 });
        // data: Uint16Array, RGBA interleaved, 12-bit values [0–4095]
        // Scale to 16-bit BE to match PNG path output format.
        const numPixels = width * height;
        const samplesPerPixel = 4;
        const pixels = new Uint8Array(numPixels * samplesPerPixel * 2);
        for (let i = 0; i < numPixels * samplesPerPixel; i++) {
            const v12 = data[i] & 0x0fff;
            const u16 = (v12 << 4) | (v12 >> 8);   // 12-bit → 16-bit bit-replication
            pixels[i * 2]     = (u16 >> 8) & 0xff;
            pixels[i * 2 + 1] =  u16       & 0xff;
        }
        return { pixels, width, height, samplesPerPixel, transferCharacteristic: 16 };
    }

    // ── PNG path ──────────────────────────────────────────────────────────────

    // Parse IHDR
    let width = 0, height = 0, bitDepth = 0, colorType = 0;
    let offset = 8;
    {
        const len = (data[offset]<<24|data[offset+1]<<16|data[offset+2]<<8|data[offset+3])>>>0;
        if (String.fromCharCode(data[offset+4],data[offset+5],data[offset+6],data[offset+7]) !== 'IHDR') return null;
        width  = (data[offset+8] <<24|data[offset+9] <<16|data[offset+10]<<8|data[offset+11])>>>0;
        height = (data[offset+12]<<24|data[offset+13]<<16|data[offset+14]<<8|data[offset+15])>>>0;
        bitDepth  = data[offset+16];
        colorType = data[offset+17];
        offset += 12 + len;
    }
    if (bitDepth !== 16 || (colorType !== 2 && colorType !== 6)) return null;
    const samplesPerPixel = colorType === 6 ? 4 : 3;

    // Parse cICP transfer characteristic
    let transferCharacteristic = null;
    {
        let o = 8;
        while (o < data.length - 8) {
            const len = (data[o]<<24|data[o+1]<<16|data[o+2]<<8|data[o+3])>>>0;
            const t = String.fromCharCode(data[o+4],data[o+5],data[o+6],data[o+7]);
            if (t === 'cICP') { transferCharacteristic = data[o + 9]; break; }
            if (t === 'IDAT' || t === 'IEND') break;
            o += 12 + len;
        }
    }

    // Collect and decompress IDAT
    const idatChunks = [];
    offset = 8;
    while (offset < data.length - 8) {
        const len = (data[offset]<<24|data[offset+1]<<16|data[offset+2]<<8|data[offset+3])>>>0;
        const t = String.fromCharCode(data[offset+4],data[offset+5],data[offset+6],data[offset+7]);
        if (t === 'IDAT') idatChunks.push(data.slice(offset + 8, offset + 8 + len));
        if (t === 'IEND') break;
        offset += 12 + len;
    }
    if (idatChunks.length === 0) return null;

    const combined = new Uint8Array(idatChunks.reduce((a,c) => a + c.length, 0));
    let pos = 0;
    for (const c of idatChunks) { combined.set(c, pos); pos += c.length; }
    const ds = new DecompressionStream('deflate');
    const writer = ds.writable.getWriter();
    writer.write(combined); writer.close();
    const rawChunks = [];
    const reader = ds.readable.getReader();
    while (true) { const { done, value } = await reader.read(); if (done) break; rawChunks.push(value); }
    const raw = new Uint8Array(rawChunks.reduce((a,c) => a + c.length, 0));
    let rpos = 0;
    for (const c of rawChunks) { raw.set(c, rpos); rpos += c.length; }

    // Reconstruct PNG-filtered scanlines
    const bytesPerPixel = samplesPerPixel * 2;
    const stride = 1 + width * bytesPerPixel;
    const pixels = new Uint8Array(width * height * bytesPerPixel);

    function paethPredictor(a, b, c) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }

    for (let y = 0; y < height; y++) {
        const ft = raw[y * stride];
        const rowIn  = raw.subarray(y * stride + 1, y * stride + 1 + width * bytesPerPixel);
        const rowOut = pixels.subarray(y * width * bytesPerPixel, (y + 1) * width * bytesPerPixel);
        const prevRow = y > 0 ? pixels.subarray((y-1) * width * bytesPerPixel, y * width * bytesPerPixel) : null;
        for (let x = 0; x < rowIn.length; x++) {
            const rb = rowIn[x];
            const a = x >= bytesPerPixel ? rowOut[x - bytesPerPixel] : 0;
            const b = prevRow ? prevRow[x] : 0;
            const c = (x >= bytesPerPixel && prevRow) ? prevRow[x - bytesPerPixel] : 0;
            switch (ft) {
                case 0: rowOut[x] = rb;                                    break;
                case 1: rowOut[x] = (rb + a) & 0xff;                       break;
                case 2: rowOut[x] = (rb + b) & 0xff;                       break;
                case 3: rowOut[x] = (rb + Math.floor((a + b) / 2)) & 0xff; break;
                case 4: rowOut[x] = (rb + paethPredictor(a, b, c)) & 0xff; break;
                default: rowOut[x] = rb;
            }
        }
    }

    return { pixels, width, height, samplesPerPixel, transferCharacteristic };
}

// Given a decoded pixel buffer and image coordinates, return per-channel nits and luminance.
function getNitsAtPixel(pixelBuffer, imgX, imgY) {
    const { pixels, width, height, samplesPerPixel, transferCharacteristic } = pixelBuffer;
    const px = Math.max(0, Math.min(width  - 1, Math.floor(imgX)));
    const py = Math.max(0, Math.min(height - 1, Math.floor(imgY)));
    const bytesPerPixel = samplesPerPixel * 2;
    const base = (py * width + px) * bytesPerPixel;

    const r16 = pixels[base]     << 8 | pixels[base + 1];
    const g16 = pixels[base + 2] << 8 | pixels[base + 3];
    const b16 = pixels[base + 4] << 8 | pixels[base + 5];

    // Select EOTF based on cICP transfer characteristic
    let eotf;
    if (transferCharacteristic === 16) {
        // PQ (ST.2084)
        eotf = v => {
            const m1 = 0.1593017578125, m2 = 78.84375;
            const c1 = 0.8359375, c2 = 18.8515625, c3 = 18.6875;
            const vp = Math.pow(Math.max(v, 0), 1 / m2);
            return 10000 * Math.pow(Math.max(vp - c1, 0) / Math.max(c2 - c3 * vp, 1e-10), 1 / m1);
        };
    } else if (transferCharacteristic === 18) {
        // HLG
        eotf = v => {
            const a = 0.17883277, b = 0.28466892, c = 0.55991073;
            return (v <= 0.5 ? (v * v) / 3 : (Math.exp((v - c) / a) + b) / 12) * 1000;
        };
    } else {
        // Linear scRGB: 1.0 = 80 cd/m²
        eotf = v => v * 80;
    }

    const rNits = eotf(r16 / 65535);
    const gNits = eotf(g16 / 65535);
    const bNits = eotf(b16 / 65535);

    // ── Per-pixel gamut classification ───────────────────────────────────────
    // Get linear scRGB values (1.0 = 80 nits).
    const rLin = rNits / 80, gLin = gNits / 80, bLin = bNits / 80;

    // Gamut is determined by chromaticity (sign of primaries in a given color space), NOT luminance.
    // rLin/gLin/bLin are in the *source* primaries: BT.2020 for PQ (TC=16) and HLG (TC=18) content,
    // BT.709/scRGB for the linear fallback. We must convert to BT.709 primaries first so that
    // out-of-gamut components become negative — exactly what the hierarchy test detects.
    let rScRGB = rLin, gScRGB = gLin, bScRGB = bLin;
    if (transferCharacteristic === 16 || transferCharacteristic === 18) {
        [rScRGB, gScRGB, bScRGB] = _mat3(_M_2020_TO_709, rLin, gLin, bLin);
    }

    let gamut = 'Rec. 709';
    const Y = 0.2126 * rScRGB + 0.7152 * gScRGB + 0.0722 * bScRGB;
    if (Y >= 0.0001) {
        if (rScRGB >= 0 && gScRGB >= 0 && bScRGB >= 0) {
            // All BT.709 channels non-negative → within Rec.709 gamut
            gamut = 'Rec. 709';
        } else {
            // Some negative BT.709 component → outside Rec.709. Test P3.
            const [p3r, p3g, p3b] = _mat3(_M_709_TO_P3, rScRGB, gScRGB, bScRGB);
            if (p3r >= 0 && p3g >= 0 && p3b >= 0) {
                gamut = 'DCI-P3'; // fits in P3 but not Rec.709
            } else {
                // Outside P3. Test BT.2020.
                const [r20, g20, b20] = _mat3(_M_709_TO_2020, rScRGB, gScRGB, bScRGB);
                gamut = (r20 >= 0 && g20 >= 0 && b20 >= 0) ? 'BT.2020' : 'BT.2020+';
            }
        }
    }

    return {
        rNits,
        gNits,
        bNits,
        luminance: 0.2126 * rNits + 0.7152 * gNits + 0.0722 * bNits,
        gamut,
    };
}

// ─── Image Metadata ───────────────────────────────────────────────────────────

async function getImageMetadata(blob, filename) {
    const extension = getFileExtension(filename);
    const basicMetadata = await getBasicImageMetadata(blob);
    let hdrMetadata = null;
    if (extension === '.png')       hdrMetadata = await parsePNGMetadata(blob);
    else if (extension === '.avif') hdrMetadata = await parseAVIFMetadata(blob);
    return { ...basicMetadata, hdr: hdrMetadata };
}

async function getBasicImageMetadata(blob) {
    const dims = await new Promise((resolve) => {
        const img = new Image();
        const url = URL.createObjectURL(blob);
        img.onload  = () => { URL.revokeObjectURL(url); resolve({ width: img.width, height: img.height }); };
        img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
        img.src = url;
    });

    const width  = dims ? dims.width  : 0;
    const height = dims ? dims.height : 0;

    let luminanceStats = null;
    let gamutCoverage  = null;

    // If this blob came from convertToAVIF, the stats are pre-computed and attached
    // directly on the File object — no re-decode needed and always accurate.
    if (blob._avifStats) {
        luminanceStats = blob._avifStats.luminanceStats;
        gamutCoverage  = blob._avifStats.gamutCoverage;
    } else {
        // PNG path (or legacy)
        try { luminanceStats = await analyze16BitPNG(blob); } catch(_) {}
        try { gamutCoverage  = blob._jxrGamut ?? await analyzeGamutCoverage(blob); } catch(_) {}
    }

    return {
        width, height,
        resolution:  `${width}×${height}`,
        aspectRatio: width && height ? (width / height).toFixed(2) : 'N/A',
        luminanceStats,
        gamutCoverage,
        fileSize: blob.size,
    };
}

// ─── Aspect Ratio ─────────────────────────────────────────────────────────────
function getAspectRatioLabel(w, h) {
    const ratio = w / h;
    const RATIOS = [
        { label: '16:9',  value: 16/9,  tolerance: 0.02 },
        { label: '21:9',  value: 21/9,  tolerance: 0.05 },
        { label: '32:9',  value: 32/9,  tolerance: 0.05 },
        { label: '16:10', value: 16/10, tolerance: 0.02 },
        { label: '4:3',   value: 4/3,   tolerance: 0.02 },
        { label: '1:1',   value: 1,     tolerance: 0.02 },
    ];
    const match = RATIOS.find(r => Math.abs(ratio - r.value) < r.tolerance);
    if (match) return match.label;
    function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); }
    const d = gcd(w, h);
    return `${w / d}:${h / d}`;
}

// ─── Tag Derivation ───────────────────────────────────────────────────────────
// Returns an array of { label, color, glow?, tooltip? } tag objects derived from
// image metadata. Add new tags here; script.js never needs to change.
function deriveTags(metadata, hdrType = null) {
    if (!metadata) return [];
    const tags = [];
    const w = metadata.width || 0;
    const h = metadata.height || 0;

    // Resolution
    if      (w >= 7680 || h >= 4320) tags.push({ label: '8K',        color: '#f5c518', tooltip: `${w}×${h}` });
    else if (w >= 3840 || h >= 2160) tags.push({ label: '4K',        color: '#f5c518', tooltip: `${w}×${h}` });
    else if (w >= 2560 || h >= 1440) tags.push({ label: '1440p',     color: '#f5c518', tooltip: `${w}×${h}` });
    else if (w >= 1920 || h >= 1080) tags.push({ label: '1080p',     color: '#f5c518', tooltip: `${w}×${h}` });
    else if (w > 0)                   tags.push({ label: `${w}×${h}`, color: '#f5c518' });

    // Aspect ratio
    if (w > 0 && h > 0) tags.push({ label: getAspectRatioLabel(w, h), color: '#4dabf7' });

    // Peak nits (snapped to common display brightness targets)
    const maxNits = metadata.luminanceStats?.maxLuminance;
    if (maxNits != null && maxNits > 0) {
        const NITS_TARGETS = [100,200,400,600,800,1000,1200,1400,1500,1600,2000,2500,3000,4000,8000,10000];
        const nitsRounded = NITS_TARGETS.reduce((prev, curr) =>
            Math.abs(curr - maxNits) < Math.abs(prev - maxNits) ? curr : prev);
        tags.push({ label: `${nitsRounded} nits`, color: '#e8e8e8', tooltip: `${maxNits.toFixed(1)} cd/m² (peak luminance)` });
    }

    // HDR type
    if (hdrType && hdrType !== 'none') {
        const HDR_LABELS = {
            renodx: 'RenoDX', luma: 'Luma', native: 'Native',
            specialk: 'SpecialK', rtxHdr: 'RTX HDR', autoHdr: 'Windows Auto HDR',
            dxvk: 'DXVK HDR', pumboReshade: 'Pumbo ReShade', liliumReshade: 'Lilium ReShade',
        };
        tags.push({ label: HDR_LABELS[hdrType] || hdrType, color: '#40c057' });
    } else if (!hdrType) {
        // Legacy: infer from transfer characteristic if hdrType was never set
        const tc = metadata.luminanceStats?.transferCharacteristic;
        if (tc === 16 || tc === 18) tags.push({ label: 'Native HDR', color: '#40c057' });
    }
    // hdrType === 'none': user explicitly cleared it — no tag shown

    return tags;
}

// ─── Gamut Coverage Analysis ──────────────────────────────────────────────────
// Decompresses a 16-bit PNG, applies the appropriate EOTF, converts to linear
// scRGB (BT.709), and classifies each pixel into the narrowest gamut that contains
// it: Rec.709 → P3-D65 → Rec.2020 → AP1 → AP0.
// Matches SKIV viewer.cpp gamut classification logic exactly.
async function analyzeGamutCoverage(blob) {
    const arrayBuffer = await blob.arrayBuffer();
    const data = new Uint8Array(arrayBuffer);
    if (data[0] !== 0x89 || data[1] !== 0x50) return null;

    // Parse IHDR
    let width = 0, height = 0, bitDepth = 0, colorType = 0;
    let offset = 8;
    {
        const len = (data[offset]<<24|data[offset+1]<<16|data[offset+2]<<8|data[offset+3])>>>0;
        if (String.fromCharCode(data[offset+4],data[offset+5],data[offset+6],data[offset+7]) !== 'IHDR') return null;
        width  = (data[offset+8] <<24|data[offset+9] <<16|data[offset+10]<<8|data[offset+11])>>>0;
        height = (data[offset+12]<<24|data[offset+13]<<16|data[offset+14]<<8|data[offset+15])>>>0;
        bitDepth  = data[offset+16];
        colorType = data[offset+17];
        offset += 12 + len;
    }
    if (bitDepth !== 16 || (colorType !== 2 && colorType !== 6)) return null;
    const samplesPerPixel = colorType === 6 ? 4 : 3;

    // Parse cICP primaries and transfer characteristic (single scan)
    let transferCharacteristic = null, cicp_primaries = null;
    {
        let o = 8;
        while (o < data.length - 8) {
            const len = (data[o]<<24|data[o+1]<<16|data[o+2]<<8|data[o+3])>>>0;
            const t = String.fromCharCode(data[o+4],data[o+5],data[o+6],data[o+7]);
            if (t === 'cICP') { cicp_primaries = data[o+8]; transferCharacteristic = data[o+9]; break; }
            if (t === 'IDAT' || t === 'IEND') break;
            o += 12 + len;
        }
    }

    // Collect and decompress IDAT
    const idatChunks = [];
    offset = 8;
    while (offset < data.length - 8) {
        const len = (data[offset]<<24|data[offset+1]<<16|data[offset+2]<<8|data[offset+3])>>>0;
        const t = String.fromCharCode(data[offset+4],data[offset+5],data[offset+6],data[offset+7]);
        if (t === 'IDAT') idatChunks.push(data.slice(offset+8, offset+8+len));
        if (t === 'IEND') break;
        offset += 12 + len;
    }
    if (!idatChunks.length) return null;

    const combined = new Uint8Array(idatChunks.reduce((a,c)=>a+c.length,0));
    let pos = 0; for (const c of idatChunks) { combined.set(c,pos); pos+=c.length; }
    const ds = new DecompressionStream('deflate');
    const w = ds.writable.getWriter(); w.write(combined); w.close();
    const rawChunks = []; const r = ds.readable.getReader();
    while (true) { const {done,value} = await r.read(); if (done) break; rawChunks.push(value); }
    const raw = new Uint8Array(rawChunks.reduce((a,c)=>a+c.length,0));
    let rpos=0; for (const c of rawChunks) { raw.set(c,rpos); rpos+=c.length; }

    // Reconstruct PNG-filtered scanlines
    const bytesPerPixel = samplesPerPixel * 2;
    const stride = 1 + width * bytesPerPixel;
    const pixels = new Uint8Array(width * height * bytesPerPixel);
    function paeth(a,b,c){const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;}
    for (let y = 0; y < height; y++) {
        const ft = raw[y*stride];
        const rowIn  = raw.subarray(y*stride+1, y*stride+1+width*bytesPerPixel);
        const rowOut = pixels.subarray(y*width*bytesPerPixel,(y+1)*width*bytesPerPixel);
        const prev   = y > 0 ? pixels.subarray((y-1)*width*bytesPerPixel,y*width*bytesPerPixel) : null;
        for (let x = 0; x < rowIn.length; x++) {
            const rb=rowIn[x], a=x>=bytesPerPixel?rowOut[x-bytesPerPixel]:0, b=prev?prev[x]:0, c=(x>=bytesPerPixel&&prev)?prev[x-bytesPerPixel]:0;
            switch(ft){case 0:rowOut[x]=rb;break;case 1:rowOut[x]=(rb+a)&0xff;break;case 2:rowOut[x]=(rb+b)&0xff;break;case 3:rowOut[x]=(rb+Math.floor((a+b)/2))&0xff;break;case 4:rowOut[x]=(rb+paeth(a,b,c))&0xff;break;default:rowOut[x]=rb;}
        }
    }

    // For plain BT.709/sRGB source — gamut breakdown is trivially 100% Rec.709
    if (cicp_primaries !== 9 && cicp_primaries !== 12) {
        return { rec709: '100.0', p3: '0.0', bt2020: '0.0', sourcePrimaries: 'BT.709/sRGB', narrowSource: true };
    }

    // EOTF: encoded sample [0,1] → linear light
    let eotf;
    if (transferCharacteristic === 16) {
        eotf = v => { const vp=Math.pow(Math.max(v,0),1/_PQ_M); return Math.pow(Math.max(vp-_PQ_C1,0)/Math.max(_PQ_C2-_PQ_C3*vp,1e-10),1/_PQ_N)*_SKIV_MAX_PQ; };
    } else if (transferCharacteristic === 18) {
        eotf = v => { const a=0.17883277,b=0.28466892,c=0.55991073; return v<=0.5?(v*v)/3:(Math.exp((v-c)/a)+b)/12; };
    } else if (transferCharacteristic === 13 || transferCharacteristic === 1) {
        eotf = v => v <= 0.04045 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4);
    } else {
        eotf = v => v;
    }

    // Pre-compute EOTF LUT to avoid per-pixel pow() calls
    const lut = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) lut[i] = eotf(i / 65535);

    const pixelCount = width * height;

    // ── Gamut classification matrices (all transposed from SKIV image.h) ──────

    // BT.2020 → BT.709 (exact inverse of _M_709_TO_2020)
    const M_2020_TO_709 = [
         1.66049094578, -0.58764109488, -0.07284986467,
        -0.12455046637,  1.13289988028, -0.00834942203,
        -0.01815076427, -0.10057889487,  1.11872966227,
    ];
    // P3-D65 → BT.709
    const M_P3_TO_709 = [
         1.22494018557, -0.22494018222,  0.00000000000,
        -0.04205695484,  1.04205693932,  0.00000000000,
        -0.01963755530, -0.07863604151,  1.09827356525,
    ];
    // BT.709 → DCI-P3 D65  (SKIV: c_from709toDCIP3)
    const M_709_TO_P3 = [
        0.822461962699890, 0.177538037300110, 0.000000000000000,
        0.033194199204445, 0.966805815696716, 0.000000000000000,
        0.017082631587982, 0.072397440671921, 0.910519957542419,
    ];
    // BT.709 → BT.2020  (SKIV: c_from709to2020)
    const M_709_TO_2020 = [
        0.627403914928436, 0.329283028841019, 0.043313067406416,
        0.069097287952900, 0.919540405273438, 0.011362315155566,
        0.016391439363360, 0.088013306260109, 0.895595252513885,
    ];
    // BT.709 → AP1 (ACES)  (SKIV: c_from709toAP1)
    const M_709_TO_AP1 = [
        0.617028832435608, 0.333867609500885, 0.049103543162346,
        0.069922320544720, 0.917349696159363, 0.012727967463434,
        0.020549787208438, 0.107552029192448, 0.871898174285889,
    ];
    // BT.709 → AP0 (ACES)  (SKIV: c_from709toAP0)
    const M_709_TO_AP0 = [
        0.433931618928909, 0.376252382993698, 0.189815968275070,
        0.088618390262127, 0.809275329113007, 0.102106288075447,
        0.017750039696693, 0.109447620809078, 0.872802317142487,
    ];

    function mat3px(m, r, g, b) {
        return [m[0]*r+m[1]*g+m[2]*b, m[3]*r+m[4]*g+m[5]*b, m[6]*r+m[7]*g+m[8]*b];
    }

    // Source primaries → linear scRGB (BT.709)
    const srcToScRGB = cicp_primaries === 9 ? M_2020_TO_709 : M_P3_TO_709;

    // Near-black threshold: pixels below this luminance are trivially classified as Rec.709
    // (matches SKIV FP16_MIN — approximately half the smallest positive FP16 normal)
    const FP16_MIN = 0.0005;

    let g709=0, gP3=0, g2020=0, gAP1=0, gAP0=0, gTotal=0;

    for (let i = 0; i < pixelCount; i++) {
        const base = i * bytesPerPixel;
        const rs = lut[(pixels[base]   << 8) | pixels[base+1]];
        const gs = lut[(pixels[base+2] << 8) | pixels[base+3]];
        const bs = lut[(pixels[base+4] << 8) | pixels[base+5]];

        // Convert from source primaries to linear scRGB
        const [r, g, b] = mat3px(srcToScRGB, rs, gs, bs);
        const Y = 0.212639*r + 0.715169*g + 0.072192*b;
        gTotal++;

        // Rec.709: all channels non-negative (no out-of-gamut component)
        if ((r >= 0 && g >= 0 && b >= 0) || Y < FP16_MIN) { g709++; continue; }

        const [p3r, p3g, p3b] = mat3px(M_709_TO_P3, r, g, b);
        if (p3r >= 0 && p3g >= 0 && p3b >= 0) { gP3++; continue; }

        const [r20, g20, b20] = mat3px(M_709_TO_2020, r, g, b);
        if (r20 >= 0 && g20 >= 0 && b20 >= 0) { g2020++; continue; }

        const [ap1r, ap1g, ap1b] = mat3px(M_709_TO_AP1, r, g, b);
        if (ap1r >= 0 && ap1g >= 0 && ap1b >= 0) { gAP1++; continue; }

        const [ap0r, ap0g, ap0b] = mat3px(M_709_TO_AP0, r, g, b);
        if (ap0r >= 0 && ap0g >= 0 && ap0b >= 0) { gAP0++; continue; }
        // Anything beyond AP0 is unclassified (extremely rare)
    }

    if (gTotal === 0) return null;
    return {
        rec709:  (g709  / gTotal * 100).toFixed(4),
        p3:      (gP3   / gTotal * 100).toFixed(4),
        bt2020:  (g2020 / gTotal * 100).toFixed(4),
        ap1:     (gAP1  / gTotal * 100).toFixed(4),
        ap0:     (gAP0  / gTotal * 100).toFixed(4),
        sourcePrimaries: cicp_primaries === 9 ? 'BT.2020' : 'P3-D65',
    };
}

// ─── SDR Detection ────────────────────────────────────────────────────────────
// Quickly checks a batch of files for SDR content by reading only file headers.
// Returns an array of { file, reason } for any file that appears to be SDR.
// EXR, HDR, and JXR are always treated as HDR and pass through unconditionally.
// PNG: rejected if 8-bit.
// AVIF: rejected if transfer function is explicitly sRGB/BT.709, or if no HDR
//       transfer function (PQ/HLG) is present in the colr box.
async function detectSdrFiles(files) {
    const rejected = [];

    for (const file of files) {
        const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();

        // These formats are always HDR by nature — skip check
        if (ext === '.exr' || ext === '.hdr' || ext === '.jxr') continue;

        if (ext === '.png') {
            try {
                // Only need the first 33 bytes (PNG sig 8 + IHDR chunk 25)
                const header = await file.slice(0, 33).arrayBuffer();
                const data = new Uint8Array(header);
                // Verify PNG signature
                if (data[0] !== 0x89 || data[1] !== 0x50 || data[2] !== 0x4E || data[3] !== 0x47) continue;
                const bitDepth = data[24]; // IHDR: sig(8) + length(4) + type(4) + w(4) + h(4) + bitDepth(1)
                if (bitDepth === 8) {
                    rejected.push({ file, reason: '8-bit PNG (SDR)' });
                }
            } catch (_) { /* if we can't read it, let it through */ }
            continue;
        }

        if (ext === '.avif') {
            try {
                // Scan first 50 KB for the colr box — same logic as parseAVIFMetadata
                const chunk = await file.slice(0, Math.min(file.size, 50000)).arrayBuffer();
                const data = new Uint8Array(chunk);
                if (data.length < 12) continue;
                if (String.fromCharCode(data[4],data[5],data[6],data[7]) !== 'ftyp') continue;

                // In AVIF the colr box is nested: meta > iprp > ipco > colr.
                // A flat top-level scan never reaches it, so we need a recursive search.
                // 'meta' is a FullBox and carries a 4-byte version+flags field before its
                // children, so its children start at offset+12 instead of offset+8.
                function findColrTransfer(buf, start, end) {
                    let off = start;
                    while (off + 8 <= end && off + 8 <= buf.length) {
                        const boxSize = (buf[off]<<24|buf[off+1]<<16|buf[off+2]<<8|buf[off+3]) >>> 0;
                        if (boxSize < 8) break;
                        const boxEnd = Math.min(off + boxSize, end, buf.length);
                        const boxType = String.fromCharCode(buf[off+4],buf[off+5],buf[off+6],buf[off+7]);

                        if (boxType === 'colr' && boxEnd >= off + 16) {
                            const ct = String.fromCharCode(buf[off+8],buf[off+9],buf[off+10],buf[off+11]);
                            if (ct === 'nclx') {
                                // transfer_characteristics is a big-endian uint16 at bytes 14-15
                                return (buf[off+14] << 8) | buf[off+15];
                            }
                        }

                        // Descend into known container boxes
                        if (boxType === 'meta') {
                            // meta is a FullBox: 4-byte version+flags precede children
                            const r = findColrTransfer(buf, off + 12, boxEnd);
                            if (r !== null) return r;
                        } else if (boxType === 'iprp' || boxType === 'ipco' ||
                                   boxType === 'moov' || boxType === 'trak' ||
                                   boxType === 'mdia' || boxType === 'minf' ||
                                   boxType === 'stbl' || boxType === 'stsd') {
                            const r = findColrTransfer(buf, off + 8, boxEnd);
                            if (r !== null) return r;
                        }

                        off += boxSize;
                    }
                    return null;
                }

                const transferCode = findColrTransfer(data, 0, data.length);

                // PQ=16, HLG=18 are HDR. Anything else (sRGB=13, BT.709=1, null) is SDR.
                const isHdr = transferCode === 16 || transferCode === 18;
                if (!isHdr) {
                    const label = transferCode === 13 ? 'sRGB transfer function'
                                : transferCode === 1  ? 'BT.709 transfer function'
                                : 'no HDR transfer function (PQ/HLG) detected';
                    rejected.push({ file, reason: `AVIF with ${label}` });
                }
            } catch (_) { /* if we can't read it, let it through */ }
            continue;
        }
    }

    return rejected;
}