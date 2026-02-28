// ─── Pixel Buffer Worker ──────────────────────────────────────────────────────
// Decodes a 16-bit PNG or a 12-bit BT.2020 PQ AVIF into a raw pixel buffer.
// Receives: { arrayBuffer: ArrayBuffer }  (transferred, zero-copy)
// Sends:    { pixels, width, height, samplesPerPixel, transferCharacteristic }
//        or { error: string }
//
// AVIF path: uses @jsquash/avif decode with bitDepth:12, which returns a raw
// Uint16Array of 12-bit PQ values [0–4095] — no canvas, no browser color
// management, no float16 requirement. Values are scaled to 16-bit BE to match
// the PNG path output format so all downstream code is unchanged.
// NOTE: This file must be loaded as a module worker: new Worker(url, { type: 'module' })

import { decode as avifDecode } from 'https://esm.sh/@jsquash/avif';

self.onmessage = async (e) => {
    try {
        const data = new Uint8Array(e.data.arrayBuffer);
        const isPNG  = data[0] === 0x89 && data[1] === 0x50;
        const isAVIF = data.length > 8 &&
            String.fromCharCode(data[4],data[5],data[6],data[7]) === 'ftyp';

        console.log('[pixel-worker] received', { isPNG, isAVIF, byteLength: e.data.arrayBuffer.byteLength });

        let result;
        if (isPNG) {
            result = await decodePNG(data);
        } else if (isAVIF) {
            result = await decodeAVIF(e.data.arrayBuffer);
        }

        if (!result) {
            console.error('[pixel-worker] no result — unsupported format');
            self.postMessage({ error: 'Not a supported 16-bit PNG or AVIF' });
            return;
        }
        console.log('[pixel-worker] success', { width: result.width, height: result.height, transferCharacteristic: result.transferCharacteristic, pixelBytes: result.pixels.byteLength });
        self.postMessage(result, [result.pixels.buffer]);
    } catch (err) {
        console.error('[pixel-worker] caught error:', err);
        self.postMessage({ error: err.message });
    }
};

// ─── AVIF decode via @jsquash/avif ───────────────────────────────────────────
async function decodeAVIF(arrayBuffer) {
    console.log('[pixel-worker] decodeAVIF start, byteLength:', arrayBuffer.byteLength);
    const { data, width, height } = await avifDecode(arrayBuffer, { bitDepth: 12 });
    console.log('[pixel-worker] avifDecode result', { width, height, dataType: data.constructor.name, dataLength: data.length });
    const numPixels = width * height;
    const samplesPerPixel = 4;
    const pixels = new Uint8Array(numPixels * samplesPerPixel * 2);
    for (let i = 0; i < numPixels * samplesPerPixel; i++) {
        const v12 = data[i] & 0x0fff;
        const u16 = (v12 << 4) | (v12 >> 8);
        pixels[i * 2]     = (u16 >> 8) & 0xff;
        pixels[i * 2 + 1] =  u16       & 0xff;
    }
    return { pixels, width, height, samplesPerPixel, transferCharacteristic: 16 };
}

// ─── PNG decode via canvas (fallback for browsers without @jsquash/avif) ─────
async function decodePNGViaCanvas(bitmap) {
    const { width, height } = bitmap;

    // Read pixels as float16 RGBA in the image's native color space.
    // 'rgba16float' is the only format that preserves HDR headroom (values > 1).
    const canvas = new OffscreenCanvas(width, height);
    let ctx;
    let ctxColorSpace = 'rec2100-pq'; // track what we actually got
    try {
        ctx = canvas.getContext('2d', {
            colorSpace: 'rec2100-pq',
            pixelFormat: 'float16',
        });
        ctxColorSpace = 'rec2100-pq';
    } catch(e) {
        // Fallback: some browsers don't support rec2100-pq context yet.
        // Use display-p3 float16 — still better than srgb for HDR.
        try {
            ctx = canvas.getContext('2d', {
                colorSpace: 'display-p3',
                pixelFormat: 'float16',
            });
            ctxColorSpace = 'display-p3';
        } catch(e2) {
            ctx = canvas.getContext('2d');
            ctxColorSpace = 'srgb';
        }
    }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    const imageData = ctx.getImageData(0, 0, width, height, { colorSpace: ctxColorSpace });

    const srcData = imageData.data;
    // BYTES_PER_ELEMENT === 2 → Float16Array (PQ signal intact).
    // BYTES_PER_ELEMENT === 1 → Uint8ClampedArray (8-bit sRGB, HDR lost).
    // Chrome silently returns 8-bit without throwing — try/catch is unreliable.
    const ctxIsFloat16 = srcData.BYTES_PER_ELEMENT === 2;

    console.log('[pixel-worker decodeAVIF]', {
        ctxColorSpace, ctxIsFloat16,
        dataType: srcData.constructor.name,
        sample0: srcData[0], sample1: srcData[1], sample2: srcData[2],
    });

    const numPixels = width * height;
    const samplesPerPixel = 4; // RGBA
    const pixels = new Uint8Array(numPixels * samplesPerPixel * 2); // 16-bit BE output

    if (ctxIsFloat16) {
        // Float16Array: PQ-encoded values in [0,1]. Convert to uint16 big-endian.
        for (let i = 0; i < numPixels; i++) {
            const srcBase = i * 4;
            const dstBase = i * 8;
            for (let c = 0; c < 4; c++) {
                const u16 = Math.round(Math.max(0, Math.min(1, srcData[srcBase + c])) * 65535);
                pixels[dstBase + c*2]     = (u16 >> 8) & 0xff;
                pixels[dstBase + c*2 + 1] =  u16       & 0xff;
            }
        }
        return { pixels, width, height, samplesPerPixel, transferCharacteristic: 16 };
    } else {
        // 8-bit sRGB fallback — HDR signal is lost. Scale 0-255 to 0-65535.
        // transferCharacteristic must be null so getNitsAtPixel does NOT apply PQ EOTF
        // to sRGB data — that would produce ~100 nit readings for everything.
        console.warn('[pixel-worker decodeAVIF] float16 canvas unavailable — nit readout will be inaccurate.');
        for (let i = 0; i < numPixels; i++) {
            const srcBase = i * 4;
            const dstBase = i * 8;
            for (let c = 0; c < 4; c++) {
                const u16 = srcData[srcBase + c] * 257;
                pixels[dstBase + c*2]     = (u16 >> 8) & 0xff;
                pixels[dstBase + c*2 + 1] =  u16       & 0xff;
            }
        }
        return { pixels, width, height, samplesPerPixel, transferCharacteristic: null };
    }
}

// ─── PNG decode (existing path, unchanged) ───────────────────────────────────
async function decodePNG(data) {
    if (data[0] !== 0x89 || data[1] !== 0x50) return null;

    // Parse IHDR
    let width = 0, height = 0, bitDepth = 0, colorType = 0;
    let offset = 8;
    {
        const len = (data[offset] << 24 | data[offset+1] << 16 | data[offset+2] << 8 | data[offset+3]) >>> 0;
        const type = String.fromCharCode(data[offset+4], data[offset+5], data[offset+6], data[offset+7]);
        if (type !== 'IHDR') return null;
        width  = (data[offset+8]  << 24 | data[offset+9]  << 16 | data[offset+10] << 8 | data[offset+11]) >>> 0;
        height = (data[offset+12] << 24 | data[offset+13] << 16 | data[offset+14] << 8 | data[offset+15]) >>> 0;
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
            const len = (data[o] << 24 | data[o+1] << 16 | data[o+2] << 8 | data[o+3]) >>> 0;
            const t = String.fromCharCode(data[o+4], data[o+5], data[o+6], data[o+7]);
            if (t === 'cICP') { transferCharacteristic = data[o + 9]; break; }
            if (t === 'IDAT' || t === 'IEND') break;
            o += 12 + len;
        }
    }

    // Collect IDAT chunks
    const idatChunks = [];
    offset = 8;
    while (offset < data.length - 8) {
        const len = (data[offset] << 24 | data[offset+1] << 16 | data[offset+2] << 8 | data[offset+3]) >>> 0;
        const type = String.fromCharCode(data[offset+4], data[offset+5], data[offset+6], data[offset+7]);
        if (type === 'IDAT') idatChunks.push(data.slice(offset + 8, offset + 8 + len));
        if (type === 'IEND') break;
        offset += 12 + len;
    }
    if (idatChunks.length === 0) return null;

    // Decompress
    const combined = new Uint8Array(idatChunks.reduce((a, c) => a + c.length, 0));
    let pos = 0;
    for (const c of idatChunks) { combined.set(c, pos); pos += c.length; }

    const ds = new DecompressionStream('deflate');
    const writer = ds.writable.getWriter();
    writer.write(combined);
    writer.close();
    const rawChunks = [];
    const reader = ds.readable.getReader();
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        rawChunks.push(value);
    }
    const raw = new Uint8Array(rawChunks.reduce((a, c) => a + c.length, 0));
    let rpos = 0;
    for (const c of rawChunks) { raw.set(c, rpos); rpos += c.length; }

    // Reconstruct filtered scanlines
    const bytesPerPixel = samplesPerPixel * 2;
    const stride = 1 + width * bytesPerPixel;
    const pixels = new Uint8Array(width * height * bytesPerPixel);

    function paethPredictor(a, b, c) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }

    for (let y = 0; y < height; y++) {
        const filterType = raw[y * stride];
        const rowIn  = raw.subarray(y * stride + 1, y * stride + 1 + width * bytesPerPixel);
        const rowOut = pixels.subarray(y * width * bytesPerPixel, (y + 1) * width * bytesPerPixel);
        const prevRow = y > 0 ? pixels.subarray((y-1) * width * bytesPerPixel, y * width * bytesPerPixel) : null;
        for (let x = 0; x < rowIn.length; x++) {
            const rb = rowIn[x];
            const a = x >= bytesPerPixel ? rowOut[x - bytesPerPixel] : 0;
            const b = prevRow ? prevRow[x] : 0;
            const c = (x >= bytesPerPixel && prevRow) ? prevRow[x - bytesPerPixel] : 0;
            switch (filterType) {
                case 0: rowOut[x] = rb; break;
                case 1: rowOut[x] = (rb + a) & 0xff; break;
                case 2: rowOut[x] = (rb + b) & 0xff; break;
                case 3: rowOut[x] = (rb + Math.floor((a + b) / 2)) & 0xff; break;
                case 4: rowOut[x] = (rb + paethPredictor(a, b, c)) & 0xff; break;
                default: rowOut[x] = rb;
            }
        }
    }

    return { pixels, width, height, samplesPerPixel, transferCharacteristic };
}