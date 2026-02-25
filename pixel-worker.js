// ─── Pixel Buffer Worker ──────────────────────────────────────────────────────
// Decodes a 16-bit PNG into a raw pixel buffer off the main thread.
// Receives: { arrayBuffer: ArrayBuffer }  (transferred, zero-copy)
// Sends:    { pixels, width, height, samplesPerPixel, transferCharacteristic }
//        or { error: string }

self.onmessage = async (e) => {
    try {
        const result = await decodePixelBuffer(e.data.arrayBuffer);
        if (!result) {
            self.postMessage({ error: 'Not a supported 16-bit PNG' });
            return;
        }
        // Transfer the pixels buffer back zero-copy
        self.postMessage(result, [result.pixels.buffer]);
    } catch (err) {
        self.postMessage({ error: err.message });
    }
};

async function decodePixelBuffer(arrayBuffer) {
    const data = new Uint8Array(arrayBuffer);

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