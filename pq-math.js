// ─── pq-math.js — Shared PQ / ICtCp color math ───────────────────────────────
// Imported by tonemap-worker.js (and any future module workers that need it).
// image-processing.js is a classic script so it keeps its own copy for now.
//
// All values in linear scRGB: 1.0 scRGB = 80 cd/m², MaxPQ = 125 = 10 000 cd/m².

export const MAX_PQ = 125.0;

const PQ_N  = 2610.0 / 4096.0 / 4.0;
const PQ_M  = 2523.0 / 4096.0 * 128.0;
const PQ_C1 = 3424.0 / 4096.0;
const PQ_C2 = 2413.0 / 4096.0 * 32.0;
const PQ_C3 = 2392.0 / 4096.0 * 32.0;

/** Linear scRGB → [0,1] PQ code value (OETF / ST.2084 encode) */
export function pqOetf(v) {
    const y = Math.max(v, 0) / MAX_PQ;
    if (y === 0) return 0;
    const ym = Math.pow(y, PQ_N);
    return Math.pow((PQ_C1 + PQ_C2 * ym) / (1.0 + PQ_C3 * ym), PQ_M);
}

/** [0,1] PQ code value → linear scRGB (EOTF / ST.2084 decode) */
export function pqEotf(v) {
    const vp = Math.pow(Math.max(v, 0), 1.0 / PQ_M);
    const nd = Math.max(vp - PQ_C1, 0) / Math.max(PQ_C2 - PQ_C3 * vp, 1e-10);
    return Math.pow(nd, 1.0 / PQ_N) * MAX_PQ;
}

/** 3×3 matrix × column vector: result = M · [r, g, b] */
export function mat3(m, r, g, b) {
    return [
        m[0]*r + m[1]*g + m[2]*b,
        m[3]*r + m[4]*g + m[5]*b,
        m[6]*r + m[7]*g + m[8]*b,
    ];
}

/** 3×3 matrix × 3×3 matrix: result = A · B */
export function mulMat3(A, B) {
    return [
        A[0]*B[0]+A[1]*B[3]+A[2]*B[6], A[0]*B[1]+A[1]*B[4]+A[2]*B[7], A[0]*B[2]+A[1]*B[5]+A[2]*B[8],
        A[3]*B[0]+A[4]*B[3]+A[5]*B[6], A[3]*B[1]+A[4]*B[4]+A[5]*B[7], A[3]*B[2]+A[4]*B[5]+A[5]*B[8],
        A[6]*B[0]+A[7]*B[3]+A[8]*B[6], A[6]*B[1]+A[7]*B[4]+A[8]*B[7], A[6]*B[2]+A[7]*B[5]+A[8]*B[8],
    ];
}

// ── Common colour-space matrices ──────────────────────────────────────────────

/** BT.2020 → BT.709 */
export const M_2020_TO_709 = [
     1.66049094578, -0.58764109488, -0.07284986467,
    -0.12455046637,  1.13289988028, -0.00834942203,
    -0.01815076427, -0.10057889487,  1.11872966227,
];

const _M_709_TO_XYZ = [
    0.412390798330307, 0.357584327459335, 0.180480793118477,
    0.212639003992081, 0.715168654918671, 0.072192318737507,
    0.019330818206072, 0.119194783270359, 0.950532138347626,
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

/** BT.709 → LMS (pre-composed: XYZ_TO_LMS · 709_TO_XYZ) */
export const M_709_TO_LMS = mulMat3(_M_XYZ_TO_LMS, _M_709_TO_XYZ);

/** LMS → BT.709 (pre-composed: XYZ_TO_709 · LMS_TO_XYZ) */
export const M_LMS_TO_709 = mulMat3(_M_XYZ_TO_709, _M_LMS_TO_XYZ);

export const M_LMS_TO_ICTCP = [
    0.5000,  0.5000,  0.0000,
    1.6137, -3.3234,  1.7097,
    4.3780, -4.2455, -0.1325,
];

export const M_ICTCP_TO_LMS = [
    1.0,  0.00860514569398152,  0.11103560447547328,
    1.0, -0.00860514569398152, -0.11103560447547328,
    1.0,  0.56004885956263900, -0.32063747023212210,
];