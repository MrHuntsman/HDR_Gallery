// ─── ImageMagick WASM ───────────────────────────────────────────────────────────
// Lazy-loaded on first conversion. Requires imagemagick.umd.js and magick.wasm in the same folder as index.html
// Download from:
//   https://cdn.jsdelivr.net/gh/Armster15/imagemagick-wasm-builds@master/lib/imagemagick.umd.js
//   https://cdn.jsdelivr.net/npm/@imagemagick/magick-wasm@0.0.36/dist/magick.wasm
let magickReady = false;
let magickLoading = null;
let _ImageMagick = null;
let _MagickFormat = null;

async function getMagick() {
    if (magickReady) return { ImageMagick: _ImageMagick, MagickFormat: _MagickFormat };
    if (magickLoading) return magickLoading;

    magickLoading = (async () => {
        showStatusMessage('Loading image converter (one-time download)...', 'info');

        await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = './image-processing/imagemagick.umd.js';
            script.onload = resolve;
            script.onerror = () => reject(new Error('Failed to load imagemagick.umd.js — make sure it is in the same folder as index.html'));
            document.head.appendChild(script);
        });

        await window.ImageMagick.initializeImageMagick('./image-processing/magick.wasm');

        _ImageMagick = window.ImageMagick.ImageMagick;
        _MagickFormat = window.ImageMagick.MagickFormat;
        magickReady = true;
        showStatusMessage('Converter ready', 'success');
        return { ImageMagick: _ImageMagick, MagickFormat: _MagickFormat };
    })();

    return magickLoading;
}

// ─── Format Conversion ───────────────────────────────────────────────────────────

async function convertToPNG(file) {
    const { ImageMagick, MagickFormat } = await getMagick();
    const arrayBuffer = await file.arrayBuffer();
    const inputData = new Uint8Array(arrayBuffer);
    const outputName = file.name.replace(/\.[^.]+$/, '.png');
    const ext = getFileExtension(file.name);

    // Extract cICP from source before conversion
    let cicp = null;
    if (ext === '.avif') cicp = parseAVIFCICP(inputData);

    const imageInfo = await new Promise((resolve, reject) => {
        try {
            ImageMagick.read(inputData, (image) => {
                const w = image.width, h = image.height;
                image.depth = 16;
                // MagickFormat.Png is locked to 8-bit in this WASM build.
                // Use raw RGBA to get true 16-bit data, then build the PNG ourselves.
                image.write((data) => {
                    const raw = new Uint8Array(data);
                    const bytesPerPx = raw.length / (w * h);
                    resolve({ w, h, raw, bytesPerPx });
                }, MagickFormat.Rgba);
            });
        } catch(err) { reject(err); }
    });

    const finalData = await buildPNG16(imageInfo.raw, imageInfo.w, imageInfo.h, imageInfo.bytesPerPx, cicp);
    const blob = new Blob([finalData], { type: 'image/png' });
    return new File([blob], outputName, { type: 'image/png' });
}

// ─── AVIF / PNG Binary Parsers ───────────────────────────────────────────────────

// Extract cICP primaries + transfer from AVIF nclx colr box (recursive scan)
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
                    const result = {
                        primaries: (data[offset+12] << 8) | data[offset+13],
                        transfer:  (data[offset+14] << 8) | data[offset+15],
                    };
                    return result;
                }
            }

            // Recurse into container boxes.
            // 'meta'/'iinf' are FullBoxes: 4 extra bytes (version+flags) before children.
            const containers = ['moov','trak','mdia','minf','stbl','stsd','av01','avio','ipco','iprp','moof','traf'];
            const fullBoxContainers = ['meta','iinf'];
            if (containers.includes(boxType)) {
                const result = scanBoxes(data, offset + 8, offset + boxSize);
                if (result) return result;
            } else if (fullBoxContainers.includes(boxType)) {
                const result = scanBoxes(data, offset + 12, offset + boxSize);
                if (result) return result;
            }

            if (boxType === 'mdat') break;
            offset += boxSize;
        }
        return null;
    }
    return scanBoxes(data, 0, Math.min(data.length, 200000));
}

// Build a 16-bit PNG from raw RGBA data returned by ImageMagick's RGBA format write.
// ImageMagick WASM outputs 16-bit channels as little-endian; PNG requires big-endian.
async function buildPNG16(rawPixels, width, height, bytesPerPx, cicp) {
    const is16      = bytesPerPx >= 6;
    const hasAlpha  = (bytesPerPx === 4 || bytesPerPx === 8);
    const inChans   = hasAlpha ? 4 : 3;
    const colorType = hasAlpha ? 6 : 2; // PNG: 2=RGB, 6=RGBA
    const outBytesPerPx = inChans * 2;
    const scale = is16 ? 1 : 257; // scale 8-bit -> 16-bit if needed

    const rowBytes = width * outBytesPerPx;
    const raw = new Uint8Array(height * (1 + rowBytes));
    for (let y = 0; y < height; y++) {
        const rowStart = y * (1 + rowBytes);
        raw[rowStart] = 0; // PNG filter type None
        for (let x = 0; x < width; x++) {
            const inBase  = (y * width + x) * bytesPerPx;
            const outBase = rowStart + 1 + x * outBytesPerPx;
            for (let c = 0; c < inChans; c++) {
                let val;
                if (is16) {
                    // ImageMagick RGBA: little-endian (lo byte, hi byte) -> assemble then write big-endian
                    val = rawPixels[inBase + c*2] | (rawPixels[inBase + c*2 + 1] << 8);
                } else {
                    val = rawPixels[inBase + c] * scale;
                }
                raw[outBase + c*2]     = (val >> 8) & 0xff;
                raw[outBase + c*2 + 1] = val & 0xff;
            }
        }
    }

    const compressed = await deflateRaw(raw);

    const ihdr = new Uint8Array(13);
    const dvIhdr = new DataView(ihdr.buffer);
    dvIhdr.setUint32(0, width); dvIhdr.setUint32(4, height);
    ihdr[8] = 16; ihdr[9] = colorType;

    const chunks = [makeChunk('IHDR', ihdr)];
    if (cicp) chunks.push(makeChunk('cICP', new Uint8Array([cicp.primaries, cicp.transfer, 0, 1])));
    chunks.push(makeChunk('IDAT', compressed));
    chunks.push(makeChunk('IEND', new Uint8Array(0)));

    const sig = new Uint8Array([137,80,78,71,13,10,26,10]);
    const out = new Uint8Array(sig.length + chunks.reduce((a,c) => a + c.length, 0));
    let pos = 0;
    out.set(sig, pos); pos += sig.length;
    for (const c of chunks) { out.set(c, pos); pos += c.length; }
    return out;
}

function makeChunk(type, data) {
    const tb = [type.charCodeAt(0),type.charCodeAt(1),type.charCodeAt(2),type.charCodeAt(3)];
    const chunk = new Uint8Array(12 + data.length);
    const dv = new DataView(chunk.buffer);
    dv.setUint32(0, data.length);
    chunk[4]=tb[0]; chunk[5]=tb[1]; chunk[6]=tb[2]; chunk[7]=tb[3];
    chunk.set(data, 8);
    const crcBuf = new Uint8Array(4 + data.length);
    crcBuf[0]=tb[0]; crcBuf[1]=tb[1]; crcBuf[2]=tb[2]; crcBuf[3]=tb[3];
    crcBuf.set(data, 4);
    dv.setUint32(8 + data.length, crc32(crcBuf));
    return chunk;
}

// Compress with native deflate-raw, then wrap in a zlib envelope (required by PNG IDAT)
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

    // Adler-32 of original uncompressed data for zlib trailer
    let s1 = 1, s2 = 0;
    for (let i = 0; i < data.length; i++) { s1=(s1+data[i])%65521; s2=(s2+s1)%65521; }

    // zlib envelope: 2-byte header + deflate payload + 4-byte adler32
    const out = new Uint8Array(2 + deflated.length + 4);
    out[0] = 0x78; out[1] = 0x9c;
    out.set(deflated, 2);
    const t = 2 + deflated.length;
    out[t]=(s2>>8)&0xff; out[t+1]=s2&0xff; out[t+2]=(s1>>8)&0xff; out[t+3]=s1&0xff;
    return out;
}

// ─── PNG Encoding Helpers ────────────────────────────────────────────────────────

function crc32(data) {
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
        crc ^= data[i];
        for (let j = 0; j < 8; j++) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

// ─── Metadata Extraction ─────────────────────────────────────────────────────────

async function getImageMetadata(blob, filename) {
    const extension = getFileExtension(filename);

    // Get basic image properties
    const basicMetadata = await getBasicImageMetadata(blob);

    // Try to extract HDR metadata from file
    let hdrMetadata = null;
    if (extension === '.png') {
        hdrMetadata = await parsePNGMetadata(blob);
    } else if (extension === '.avif') {
        hdrMetadata = await parseAVIFMetadata(blob);
    }

    return {
        ...basicMetadata,
        hdr: hdrMetadata
    };
}

// ─── Aspect Ratio ─────────────────────────────────────────────────────────────
// Returns a friendly aspect ratio label for gaming/TV resolutions.
// Used by both deriveTags() and the details panel in script.js.
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
    // Fallback: reduce to lowest terms
    function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); }
    const d = gcd(w, h);
    return `${w / d}:${h / d}`;
}

// ─── Tag Derivation ───────────────────────────────────────────────────────────
// Returns an array of { label, color, glow? } tag objects derived from image metadata.
// To add a new tag: add a new entry here. script.js never needs to change.
//
// Resolution color scale (prestige, low → high):
//   1080p  #748fac  muted steel blue
//   1440p  #4dabf7  blue
//   4K     #22d3ee  cyan-teal
//   8K     #b197fc  violet  + glow
//
// Nits color scale (heat, cool → hot):
//   100–400    #74c0fc  cool blue
//   600–800    #ffd43b  amber
//   1000–1600  #ff9f43  orange
//   2000–4000  #ff6b6b  red-orange
//   8000–10000 #ffe8cc  white-hot  + glow

function deriveTags(metadata, hdrType = null) {
    if (!metadata) return [];
    const tags = [];

    // ── Resolution class ──────────────────────────────────────────────────────
    const w = metadata.width || 0;
    const h = metadata.height || 0;
    if      (w >= 7680 || h >= 4320) tags.push({ label: '8K',        color: '#f5c518', glow: false, tooltip: `${w}×${h}` });
    else if (w >= 3840 || h >= 2160) tags.push({ label: '4K',        color: '#f5c518', glow: false, tooltip: `${w}×${h}` });
    else if (w >= 2560 || h >= 1440) tags.push({ label: '1440p',     color: '#f5c518', glow: false, tooltip: `${w}×${h}` });
    else if (w >= 1920 || h >= 1080) tags.push({ label: '1080p',     color: '#f5c518', glow: false, tooltip: `${w}×${h}` });
    else if (w > 0)                   tags.push({ label: `${w}×${h}`, color: '#f5c518', glow: false });

    // ── Aspect ratio ──────────────────────────────────────────────────────────
    if (w > 0 && h > 0) {
        tags.push({ label: getAspectRatioLabel(w, h), color: '#4dabf7' });
    }

    // ── Max nits ──────────────────────────────────────────────────────────────
    const maxNits = metadata.luminanceStats?.maxLuminance;
    if (maxNits != null && maxNits > 0) {
        // Snap to nearest real-world display peak brightness target
        const NITS_TARGETS = [100, 200, 400, 600, 800, 1000, 1200, 1400, 1500, 1600, 2000, 2500, 3000, 4000, 8000, 10000];
        const nitsRounded = NITS_TARGETS.reduce((prev, curr) =>
            Math.abs(curr - maxNits) < Math.abs(prev - maxNits) ? curr : prev
        );
        // Flat warm white — evokes light/brightness
        tags.push({ label: `${nitsRounded} nits`, color: '#e8e8e8', glow: false, tooltip: `${maxNits.toFixed(1)} cd/m² (peak luminance)` });
    }

    // ── HDR type ──────────────────────────────────────────────────────────────
    if (hdrType && hdrType !== 'none') {
        // Label is derived from HDR_TYPES in script.js at render time — we just store the id here
        // The tag label mapping lives in script.js HDR_TYPES; here we use a friendly fallback
        const HDR_LABELS = {
            renodx: 'RenoDX', luma: 'Luma', native: 'Native',
            specialk: 'SpecialK', rtxHdr: 'RTX HDR', autoHdr: 'Windows Auto HDR',
            dxvk: 'DXVK HDR', pumboReshade: 'Pumbo ReShade', liliumReshade: 'Lilium ReShade'
        };
        const label = HDR_LABELS[hdrType] || hdrType;
        tags.push({ label, color: '#40c057', glow: false });
    } else if (!hdrType) {
        // Legacy: detect native from transfer characteristic if no hdrType ever set
        const tc = metadata.luminanceStats?.transferCharacteristic;
        if (tc === 16 || tc === 18) {
            tags.push({ label: 'Native HDR', color: '#40c057', glow: false });
        }
    }
    // hdrType === 'none': user explicitly cleared it — show no tag

    return tags;
}

async function getBasicImageMetadata(blob) {
    const ext = getFileExtension(blob.name || '');

    const dims = await new Promise((resolve) => {
        const img = new Image();
        const url = URL.createObjectURL(blob);
        img.onload = () => { URL.revokeObjectURL(url); resolve({ width: img.width, height: img.height }); };
        img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
        img.src = url;
    });

    const width = dims ? dims.width : 0;
    const height = dims ? dims.height : 0;

    let luminanceStats = null;
    try {
        luminanceStats = await analyze16BitPNG(blob);
    } catch(e) {
        // fall through, will show n/a
    }

    let gamutCoverage = null;
    try {
        gamutCoverage = await analyzeGamutCoverage(blob);
    } catch(e) {}

    return {
        width,
        height,
        resolution: `${width}×${height}`,
        aspectRatio: width && height ? (width / height).toFixed(2) : 'N/A',
        luminanceStats,
        gamutCoverage,
        fileSize: blob.size
    };
}

// ─── HDR → SDR Tone Mapping ──────────────────────────────────────────────────────

async function convertToSDR(blob, filename) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(blob);

        img.onload = async () => {
            URL.revokeObjectURL(url);

            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d', { 
                willReadFrequently: true,
                colorSpace: 'srgb'
            });

            ctx.drawImage(img, 0, 0);

            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const data = imageData.data;

            // Process each pixel
            const exposureBias = 2.0;
            const whiteScale   = 1.0 / uncharted2ToneMap(11.2); // constant — hoist out of loop

            for (let i = 0; i < data.length; i += 4) {
                // sRGB decode → linear → exposure → filmic TM → normalize → sRGB re-encode
                let r = sRGBtoLinear(data[i]     / 255) * exposureBias;
                let g = sRGBtoLinear(data[i + 1] / 255) * exposureBias;
                let b = sRGBtoLinear(data[i + 2] / 255) * exposureBias;
                r = linearToSRGB(uncharted2ToneMap(r) * whiteScale);
                g = linearToSRGB(uncharted2ToneMap(g) * whiteScale);
                b = linearToSRGB(uncharted2ToneMap(b) * whiteScale);
                // Clamp and convert back to 0-255
                data[i] = Math.max(0, Math.min(255, Math.round(r * 255)));
                data[i + 1] = Math.max(0, Math.min(255, Math.round(g * 255)));
                data[i + 2] = Math.max(0, Math.min(255, Math.round(b * 255)));
            }

            ctx.putImageData(imageData, 0, 0);

            canvas.toBlob((sdrBlob) => {
                if (sdrBlob) {
                    const sdrFilename = filename.replace(/\.(png|avif|jxr|exr|hdr|tiff|tif|heic|heif)$/i, '_SDR.png');
                    resolve(new File([sdrBlob], sdrFilename, { type: 'image/png' }));
                } else {
                    reject(new Error('Failed to convert to SDR'));
                }
            }, 'image/png');
        };

        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('Failed to load image for SDR conversion'));
        };

        img.src = url;
    });
}

// ─── HDR Thumbnail Generation ─────────────────────────────────────────────────
// Generates a compressed WebP thumbnail from an HDR PNG/image blob.
// Uses createImageBitmap with high-quality downscaling — Chromium preserves
// the HDR color profile through this pipeline, so the output WebP is still HDR.
// maxWidth: longest edge target in pixels (default 1280)

async function generateThumb(blob, maxWidth = 1280) {
    const { ImageMagick, MagickFormat } = await getMagick();
    const arrayBuffer = await blob.arrayBuffer();
    const inputData = new Uint8Array(arrayBuffer);

    // Extract cICP from source PNG so we can re-inject it after ImageMagick processes it
    // (ImageMagick may strip the cICP chunk during resize)
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
                // Skip if already smaller than target
                if (image.width <= maxWidth && image.height <= maxWidth) {
                    resolve(null);
                    return;
                }

                // Resize to fit within maxWidth, preserving aspect ratio
                if (image.width >= image.height) {
                    image.resize(maxWidth, Math.round(maxWidth * image.height / image.width));
                } else {
                    image.resize(Math.round(maxWidth * image.width / image.height), maxWidth);
                }

                image.depth = 16;

                // Try lossless WebP first, fall back to 16-bit PNG
                // For WebP: ImageMagick uses quality=0 as a signal for lossless
                const tryWebP = () => {
                    try {
                        image.quality = 0; // lossless WebP in ImageMagick
                        image.write((data) => {
                            resolve(new Blob([data], { type: 'image/webp' }));
                        }, MagickFormat.WebP);
                    } catch (e) {
                        tryPNG();
                    }
                };

                // PNG fallback: re-inject cICP chunk so HDR metadata is preserved
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

                tryWebP();
            });
        } catch (err) {
            reject(err);
        }
    });
}

// Re-inject a cICP chunk into a PNG after the IHDR chunk.
// ImageMagick strips cICP during processing; this restores it.
function reinjectCICP(pngData, cicp) {
    const cicpData = new Uint8Array([cicp.primaries, cicp.transfer, 0, 1]);
    const cicpChunk = makeChunk('cICP', cicpData);

    // Find end of IHDR chunk (sig=8 + len=4 + type=4 + data=13 + crc=4 = 33)
    const insertAt = 33;

    const out = new Uint8Array(pngData.length + cicpChunk.length);
    out.set(pngData.slice(0, insertAt), 0);
    out.set(cicpChunk, insertAt);
    out.set(pngData.slice(insertAt), insertAt + cicpChunk.length);
    return out;
}

// Uncharted 2 (Hable) filmic tone mapping — preserves highlight detail better than other operators
function uncharted2ToneMap(x) {
    const A = 0.15; // Shoulder strength
    const B = 0.50; // Linear strength
    const C = 0.10; // Linear angle
    const D = 0.20; // Toe strength
    const E = 0.02; // Toe numerator
    const F = 0.30; // Toe denominator

    return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
}

// ─── Transfer Function Math ───────────────────────────────────────────────────────

// sRGB ↔ Linear
function sRGBtoLinear(C) {
    if (C <= 0.04045) {
        return C / 12.92;
    } else {
        return Math.pow((C + 0.055) / 1.055, 2.4);
    }
}

function linearToSRGB(C) {
    if (C <= 0.0031308) {
        return C * 12.92;
    } else {
        return 1.055 * Math.pow(C, 1.0 / 2.4) - 0.055;
    }
}

// ─── Luminance Analysis ──────────────────────────────────────────────────────────

// Decompress 16-bit PNG and compute luminance stats (MaxCLL, max/avg/min)
async function analyze16BitPNG(blob) {
    const arrayBuffer = await blob.arrayBuffer();
    const data = new Uint8Array(arrayBuffer);

    // Verify PNG signature
    if (data[0] !== 0x89 || data[1] !== 0x50) return null;

    // Parse IHDR
    let width = 0, height = 0, bitDepth = 0, colorType = 0;
    let offset = 8;
    {
        const len = (data[offset] << 24 | data[offset+1] << 16 | data[offset+2] << 8 | data[offset+3]) >>> 0;
        const type = String.fromCharCode(data[offset+4], data[offset+5], data[offset+6], data[offset+7]);
        if (type === 'IHDR') {
            width =  (data[offset+8]  << 24 | data[offset+9]  << 16 | data[offset+10] << 8 | data[offset+11]) >>> 0;
            height = (data[offset+12] << 24 | data[offset+13] << 16 | data[offset+14] << 8 | data[offset+15]) >>> 0;
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
        const len = (data[offset] << 24 | data[offset+1] << 16 | data[offset+2] << 8 | data[offset+3]) >>> 0;
        const type = String.fromCharCode(data[offset+4], data[offset+5], data[offset+6], data[offset+7]);
        if (type === 'IDAT') idatChunks.push(data.slice(offset + 8, offset + 8 + len));
        if (type === 'IEND') break;
        offset += 12 + len;
    }

    if (idatChunks.length === 0) return null;

    // Concatenate and decompress
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
    const totalLen = rawChunks.reduce((a, c) => a + c.length, 0);
    const raw = new Uint8Array(totalLen);
    let rpos = 0;
    for (const c of rawChunks) { raw.set(c, rpos); rpos += c.length; }

    // Parse scanlines (each row has a 1-byte filter type prefix)
    const bytesPerPixel = samplesPerPixel * 2; // 16-bit = 2 bytes per sample
    const stride = 1 + width * bytesPerPixel;

    // Reconstruct filtered scanlines (PNG filter types 0-4)
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
            const raw_byte = rowIn[x];
            const a = x >= bytesPerPixel ? rowOut[x - bytesPerPixel] : 0;
            const b = prevRow ? prevRow[x] : 0;
            const c = (x >= bytesPerPixel && prevRow) ? prevRow[x - bytesPerPixel] : 0;
            switch (filterType) {
                case 0: rowOut[x] = raw_byte; break;
                case 1: rowOut[x] = (raw_byte + a) & 0xff; break;
                case 2: rowOut[x] = (raw_byte + b) & 0xff; break;
                case 3: rowOut[x] = (raw_byte + Math.floor((a + b) / 2)) & 0xff; break;
                case 4: rowOut[x] = (raw_byte + paethPredictor(a, b, c)) & 0xff; break;
                default: rowOut[x] = raw_byte;
            }
        }
    }

    // Parse cICP to get transfer function
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

    // PQ (ST.2084) inverse EOTF — converts encoded value [0,1] to linear nits
    function pqToNits(v) {
        const m1 = 0.1593017578125, m2 = 78.84375;
        const c1 = 0.8359375, c2 = 18.8515625, c3 = 18.6875;
        const vp = Math.pow(Math.max(v, 0), 1 / m2);
        const num = Math.max(vp - c1, 0);
        const den = c2 - c3 * vp;
        return 10000 * Math.pow(num / den, 1 / m1);
    }

    // HLG inverse EOTF — converts encoded value [0,1] to display linear (relative, peak=1000 nits typical)
    function hlgToNits(v) {
        const a = 0.17883277, b = 0.28466892, c = 0.55991073;
        let lin;
        if (v <= 0.5) {
            lin = (v * v) / 3;
        } else {
            lin = (Math.exp((v - c) / a) + b) / 12;
        }
        return lin * 1000; // assume 1000 nit display
    }

    // For linear scRGB (transfer=8 or none): 1.0 = 80 cd/m²
    function linearToNits(v) {
        return v * 80;
    }

    let eotf;
    if (transferCharacteristic === 16) {
        eotf = pqToNits;
    } else if (transferCharacteristic === 18) {
        eotf = hlgToNits;
    } else {
        eotf = linearToNits;
    }

    let maxLum = 0, minLum = Infinity, totalLum = 0;
    let maxR_scrgb = 0;
    const pixelCount = width * height;

    // Sample every pixel (may be slow for huge images; sample if >8MP)
    const sampleStep = pixelCount > 8000000 ? Math.ceil(pixelCount / 4000000) : 1;

    for (let i = 0; i < pixelCount; i += sampleStep) {
        const base = i * bytesPerPixel;
        const r16 = (pixels[base]     << 8 | pixels[base + 1]);
        const g16 = (pixels[base + 2] << 8 | pixels[base + 3]);
        const b16 = (pixels[base + 4] << 8 | pixels[base + 5]);

        // Apply EOTF per channel: encoded [0,1] → nits
        const rNits = eotf(r16 / 65535);
        const gNits = eotf(g16 / 65535);
        const bNits = eotf(b16 / 65535);

        // Luminance: weighted sum of linear-light channels
        const lum = 0.2126 * rNits + 0.7152 * gNits + 0.0722 * bNits;
        if (lum > maxLum) maxLum = lum;
        if (lum < minLum) minLum = lum;
        totalLum += lum;

        // MaxCLL = peak single-channel nit value across all pixels
        const maxChan = Math.max(rNits, gNits, bNits);
        if (maxChan > maxR_scrgb) maxR_scrgb = maxChan;
    }

    const avgLum = totalLum / (pixelCount / sampleStep);

    return {
        maxCLL: maxR_scrgb,
        maxLuminance: maxLum,
        avgLuminance: avgLum,
        minLuminance: minLum === Infinity ? 0 : minLum,
        bitDepth: 16,
        transferCharacteristic
    };
}

async function parsePNGMetadata(blob) {
    try {
        const arrayBuffer = await blob.arrayBuffer();
        const data = new Uint8Array(arrayBuffer);

        // PNG signature check
        if (data[0] !== 0x89 || data[1] !== 0x50 || data[2] !== 0x4E || data[3] !== 0x47) {
            return null;
        }

        let offset = 8; // Skip PNG signature
        let bitDepth = null;
        let colorType = null;
        let hasGAMA = false;
        let hasCHRM = false;
        let hasICCP = false;
        let gamma = null;
        let maxCLL = null;  // Max Content Light Level
        let maxFALL = null; // Max Frame Average Light Level
        let maxLuminance = null;
        let minLuminance = null;
        let cicpColorPrimaries = null;
        let cicpTransferFunction = null;
        let cicpMatrixCoefficients = null;
        let cicpFullRange = null;

        // Parse chunks
        while (offset < data.length - 8) {
            const length = (data[offset] << 24) | (data[offset + 1] << 16) | 
                          (data[offset + 2] << 8) | data[offset + 3];
            const type = String.fromCharCode(data[offset + 4], data[offset + 5], 
                                            data[offset + 6], data[offset + 7]);
            if (type === 'IHDR') {
                bitDepth = data[offset + 16];
                colorType = data[offset + 17];
            } else if (type === 'gAMA') {
                hasGAMA = true;
                const gammaInt = (data[offset + 8] << 24) | (data[offset + 9] << 16) | 
                                (data[offset + 10] << 8) | data[offset + 11];
                gamma = (100000 / gammaInt).toFixed(2);
            } else if (type === 'cHRM') {
                hasCHRM = true;
            } else if (type === 'cICP') {
                // Coding-Independent Code Points (HDR transfer function info)
                if (length >= 4) {
                    cicpColorPrimaries = data[offset + 8];
                    cicpTransferFunction = data[offset + 9];
                    cicpMatrixCoefficients = data[offset + 10];
                    cicpFullRange = data[offset + 11];
                }
            } else if (type === 'iCCP') {
                hasICCP = true;
            } else if (type === 'cLLi') {
                // Content Light Level Information
                if (length >= 8) {
                    maxCLL = (data[offset + 8] << 24) | (data[offset + 9] << 16) | 
                            (data[offset + 10] << 8) | data[offset + 11];
                    maxFALL = (data[offset + 12] << 24) | (data[offset + 13] << 16) | 
                             (data[offset + 14] << 8) | data[offset + 15];
                }
            } else if (type === 'mDCv') {
                // Mastering Display Color Volume
                if (length >= 24) {
                    // Max and min luminance are at the end of the chunk
                    const maxLumOffset = offset + 8 + 20; // Skip display primaries
                    maxLuminance = (data[maxLumOffset] << 24) | (data[maxLumOffset + 1] << 16) | 
                                  (data[maxLumOffset + 2] << 8) | data[maxLumOffset + 3];
                    minLuminance = (data[maxLumOffset + 4] << 24) | (data[maxLumOffset + 5] << 16) | 
                                  (data[maxLumOffset + 6] << 8) | data[maxLumOffset + 7];
                    // These values are typically in units of 0.0001 cd/m²
                    maxLuminance = maxLuminance / 10000;
                    minLuminance = minLuminance / 10000;
                }
            } else if (type === 'IEND') {
                break;
            }

            offset += 12 + length; // 4 (length) + 4 (type) + data + 4 (CRC)
        }

        const colorTypeNames = {
            0: 'Grayscale',
            2: 'RGB',
            3: 'Indexed',
            4: 'Grayscale + Alpha',
            6: 'RGBA'
        };

        const cicpPrimariesNames = {
            1: 'BT.709', 9: 'BT.2020', 12: 'P3-D65', 11: 'P3-DCI'
        };
        const cicpTransferNames = {
            1: 'BT.709', 13: 'sRGB', 14: 'BT.2100 Linear',
            16: 'PQ (HDR10 / ST.2084)', 18: 'HLG (Hybrid Log-Gamma)'
        };

        const transferFunction = cicpTransferFunction !== null
            ? (cicpTransferNames[cicpTransferFunction] || `Transfer ID ${cicpTransferFunction}`)
            : hasGAMA ? 'Gamma corrected' : 'Not specified';

        const colorPrimaries = cicpColorPrimaries !== null
            ? (cicpPrimariesNames[cicpColorPrimaries] || `Primaries ID ${cicpColorPrimaries}`)
            : null;

        return {
            bitDepth: `${bitDepth}-bit`,
            colorType: colorTypeNames[colorType] || 'Unknown',
            gamma: gamma ? `${gamma}` : 'Not specified',
            hasColorProfile: hasICCP,
            hasChromaInfo: hasCHRM,
            transferFunction: transferFunction,
            colorPrimaries: colorPrimaries,
            fullRange: cicpFullRange !== null ? (cicpFullRange ? 'Full' : 'Limited') : null,
            maxContentLightLevel: maxCLL !== null ? `${maxCLL} nits` : null,
            maxFrameAverageLightLevel: maxFALL !== null ? `${maxFALL} nits` : null,
            maxLuminance: maxLuminance !== null ? `${maxLuminance.toFixed(2)} nits` : null,
            minLuminance: minLuminance !== null ? `${minLuminance.toFixed(4)} nits` : null
        };
    } catch (error) {
        console.error('PNG parsing error:', error);
        return null;
    }
}

async function parseAVIFMetadata(blob) {
    try {
        const arrayBuffer = await blob.arrayBuffer();
        const data = new Uint8Array(arrayBuffer);

        // Basic AVIF detection (ftyp box)
        if (data.length < 12) return null;

        const ftypCheck = String.fromCharCode(data[4], data[5], data[6], data[7]);
        if (ftypCheck !== 'ftyp') return null;

        // AVIF files can be 10-bit or 12-bit
        let bitDepth = '10-bit (typical)';
        let colorSpace = 'Not specified';
        let transferFunction = 'Not specified';
        let maxCLL = null;
        let maxFALL = null;
        let maxLuminance = null;
        let minLuminance = null;

        // Look for metadata boxes
        let offset = 0;
        while (offset < Math.min(data.length - 8, 50000)) { // Scan first 50KB
            if (offset + 8 > data.length) break;

            const boxSize = (data[offset] << 24) | (data[offset + 1] << 16) | 
                           (data[offset + 2] << 8) | data[offset + 3];

            if (boxSize === 0 || boxSize === 1 || boxSize > data.length - offset) {
                offset += 8;
                continue;
            }

            const boxType = String.fromCharCode(data[offset + 4], data[offset + 5], 
                                               data[offset + 6], data[offset + 7]);

            if (boxType === 'colr') {
                colorSpace = 'Has color information';
                // Parse color type
                if (offset + 12 < data.length) {
                    const colorType = String.fromCharCode(data[offset + 8], data[offset + 9], 
                                                         data[offset + 10], data[offset + 11]);
                    if (colorType === 'nclx') {
                        const transferChar = data[offset + 14];
                        if (transferChar === 16) {
                            transferFunction = 'PQ (HDR10 / ST.2084)';
                        } else if (transferChar === 18) {
                            transferFunction = 'HLG (Hybrid Log-Gamma)';
                        } else if (transferChar === 1 || transferChar === 13) {
                            transferFunction = 'sRGB / BT.709';
                        }
                    }
                }
            } else if (boxType === 'pixi') {
                // Pixel information box - contains bit depth
                if (offset + 12 < data.length) {
                    const bitsPerChannel = data[offset + 12];
                    if (bitsPerChannel > 0) {
                        bitDepth = `${bitsPerChannel}-bit`;
                    }
                }
            } else if (boxType === 'clli') {
                // Content Light Level Information
                if (offset + 16 <= data.length) {
                    maxCLL = (data[offset + 8] << 8) | data[offset + 9];
                    maxFALL = (data[offset + 10] << 8) | data[offset + 11];
                }
            } else if (boxType === 'mdcv') {
                // Mastering Display Color Volume
                if (offset + 32 <= data.length) {
                    // Max and min luminance are at bytes 24-31 (last 8 bytes)
                    const maxLumOffset = offset + 8 + 24;
                    if (maxLumOffset + 8 <= data.length) {
                        maxLuminance = (data[maxLumOffset] << 24) | (data[maxLumOffset + 1] << 16) | 
                                      (data[maxLumOffset + 2] << 8) | data[maxLumOffset + 3];
                        minLuminance = (data[maxLumOffset + 4] << 24) | (data[maxLumOffset + 5] << 16) | 
                                      (data[maxLumOffset + 6] << 8) | data[maxLumOffset + 7];
                        // Values are in units of 0.0001 cd/m²
                        maxLuminance = maxLuminance / 10000;
                        minLuminance = minLuminance / 10000;
                    }
                }
            }

            offset += boxSize;
        }

        return {
            bitDepth: bitDepth,
            colorType: 'RGB/RGBA',
            gamma: transferFunction.includes('sRGB') ? '2.2 (sRGB)' : 'HDR transfer function',
            hasColorProfile: colorSpace !== 'Not specified',
            transferFunction: transferFunction,
            format: 'AVIF (AV1 Image)',
            maxContentLightLevel: maxCLL ? `${maxCLL} nits` : null,
            maxFrameAverageLightLevel: maxFALL ? `${maxFALL} nits` : null,
            maxLuminance: maxLuminance ? `${maxLuminance.toFixed(2)} nits` : null,
            minLuminance: minLuminance ? `${minLuminance.toFixed(4)} nits` : null
        };
    } catch (error) {
        console.error('AVIF parsing error:', error);
        return null;
    }
}
// ─── Per-pixel Nit Inspection ─────────────────────────────────────────────────────

// Decode full pixel buffer from a 16-bit PNG for per-pixel nit reads.
// Returns { pixels, width, height, samplesPerPixel, transferCharacteristic } or null.
async function decodePixelBuffer(blob) {
    const arrayBuffer = await blob.arrayBuffer();
    const data = new Uint8Array(arrayBuffer);

    if (data[0] !== 0x89 || data[1] !== 0x50) return null;

    // Parse IHDR
    let width = 0, height = 0, bitDepth = 0, colorType = 0;
    let offset = 8;
    {
        const len = (data[offset] << 24 | data[offset+1] << 16 | data[offset+2] << 8 | data[offset+3]) >>> 0;
        const type = String.fromCharCode(data[offset+4], data[offset+5], data[offset+6], data[offset+7]);
        if (type !== 'IHDR') return null;
        width =  (data[offset+8]  << 24 | data[offset+9]  << 16 | data[offset+10] << 8 | data[offset+11]) >>> 0;
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
    writer.write(combined); writer.close();
    const rawChunks = [];
    const reader = ds.readable.getReader();
    while (true) { const { done, value } = await reader.read(); if (done) break; rawChunks.push(value); }
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

// Given a decoded pixel buffer and pixel coordinates, return R/G/B nits and luminance.
function getNitsAtPixel(pixelBuffer, imgX, imgY) {
    const { pixels, width, height, samplesPerPixel, transferCharacteristic } = pixelBuffer;
    const px = Math.max(0, Math.min(width  - 1, Math.floor(imgX)));
    const py = Math.max(0, Math.min(height - 1, Math.floor(imgY)));
    const bytesPerPixel = samplesPerPixel * 2;
    const base = (py * width + px) * bytesPerPixel;

    const r16 = (pixels[base]     << 8 | pixels[base + 1]);
    const g16 = (pixels[base + 2] << 8 | pixels[base + 3]);
    const b16 = (pixels[base + 4] << 8 | pixels[base + 5]);

    let eotf;
    if (transferCharacteristic === 16) {
        // PQ (ST.2084)
        eotf = v => {
            const m1 = 0.1593017578125, m2 = 78.84375;
            const c1 = 0.8359375, c2 = 18.8515625, c3 = 18.6875;
            const vp = Math.pow(Math.max(v, 0), 1 / m2);
            return 10000 * Math.pow(Math.max(vp - c1, 0) / (c2 - c3 * vp), 1 / m1);
        };
    } else if (transferCharacteristic === 18) {
        // HLG
        eotf = v => {
            const a = 0.17883277, b = 0.28466892, c = 0.55991073;
            const lin = v <= 0.5 ? (v * v) / 3 : (Math.exp((v - c) / a) + b) / 12;
            return lin * 1000;
        };
    } else {
        // Linear / scRGB: 1.0 = 80 nits
        eotf = v => v * 80;
    }

    const rNits = eotf(r16 / 65535);
    const gNits = eotf(g16 / 65535);
    const bNits = eotf(b16 / 65535);
    const luminance = 0.2126 * rNits + 0.7152 * gNits + 0.0722 * bNits;

    return { rNits, gNits, bNits, luminance };
}

// ─── Gamut Coverage Analysis ─────────────────────────────────────────────────────

// Converts source RGB → XYZ → target gamut RGB. A pixel "fits" a gamut if all
// channels are in [0,1]. Weighted by luminance Y so bright saturated pixels count more.
async function analyzeGamutCoverage(blob) {
    const arrayBuffer = await blob.arrayBuffer();
    const data = new Uint8Array(arrayBuffer);

    if (data[0] !== 0x89 || data[1] !== 0x50) return null;

    // Parse IHDR
    let width = 0, height = 0, bitDepth = 0, colorType = 0;
    let offset = 8;
    {
        const len = (data[offset]<<24|data[offset+1]<<16|data[offset+2]<<8|data[offset+3])>>>0;
        const type = String.fromCharCode(data[offset+4],data[offset+5],data[offset+6],data[offset+7]);
        if (type !== 'IHDR') return null;
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
    { let o = 8;
      while (o < data.length - 8) {
        const len = (data[o]<<24|data[o+1]<<16|data[o+2]<<8|data[o+3])>>>0;
        const t = String.fromCharCode(data[o+4],data[o+5],data[o+6],data[o+7]);
        if (t === 'cICP') { transferCharacteristic = data[o+9]; break; }
        if (t === 'IDAT'||t === 'IEND') break;
        o += 12 + len;
      }
    }

    // Collect + decompress IDAT
    const idatChunks = [];
    offset = 8;
    while (offset < data.length - 8) {
        const len = (data[offset]<<24|data[offset+1]<<16|data[offset+2]<<8|data[offset+3])>>>0;
        const type = String.fromCharCode(data[offset+4],data[offset+5],data[offset+6],data[offset+7]);
        if (type === 'IDAT') idatChunks.push(data.slice(offset+8, offset+8+len));
        if (type === 'IEND') break;
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

    // Reconstruct scanlines
    const bytesPerPixel = samplesPerPixel * 2;
    const stride = 1 + width * bytesPerPixel;
    const pixels = new Uint8Array(width * height * bytesPerPixel);
    function paeth(a,b,c){const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;}
    for (let y = 0; y < height; y++) {
        const ft = raw[y*stride];
        const rowIn  = raw.subarray(y*stride+1, y*stride+1+width*bytesPerPixel);
        const rowOut = pixels.subarray(y*width*bytesPerPixel,(y+1)*width*bytesPerPixel);
        const prev   = y>0?pixels.subarray((y-1)*width*bytesPerPixel,y*width*bytesPerPixel):null;
        for (let x=0;x<rowIn.length;x++){
            const rb=rowIn[x],a=x>=bytesPerPixel?rowOut[x-bytesPerPixel]:0,b=prev?prev[x]:0,c=(x>=bytesPerPixel&&prev)?prev[x-bytesPerPixel]:0;
            switch(ft){case 0:rowOut[x]=rb;break;case 1:rowOut[x]=(rb+a)&0xff;break;case 2:rowOut[x]=(rb+b)&0xff;break;case 3:rowOut[x]=(rb+Math.floor((a+b)/2))&0xff;break;case 4:rowOut[x]=(rb+paeth(a,b,c))&0xff;break;default:rowOut[x]=rb;}
        }
    }

    // Also read primaries from cICP (byte offset +8 from chunk start)
    let cicp_primaries = null;
    { let o = 8;
      while (o < data.length - 8) {
        const len = (data[o]<<24|data[o+1]<<16|data[o+2]<<8|data[o+3])>>>0;
        const t = String.fromCharCode(data[o+4],data[o+5],data[o+6],data[o+7]);
        if (t === 'cICP') { cicp_primaries = data[o+8]; break; }
        if (t === 'IDAT'||t === 'IEND') break;
        o += 12 + len;
      }
    }

    const EPS = 0.001;
    function inGamut([r,g,b]) { return r>=-EPS&&r<=1+EPS&&g>=-EPS&&g<=1+EPS&&b>=-EPS&&b<=1+EPS; }

    // primaries: 1=BT.709/sRGB, 9=BT.2020, 12=P3-D65
    function rgbToXYZ_709(r,g,b)   { return [ 0.412391*r+0.357584*g+0.180481*b, 0.212639*r+0.715169*g+0.072192*b, 0.019331*r+0.119195*g+0.950532*b ]; }
    function rgbToXYZ_P3(r,g,b)    { return [ 0.486571*r+0.265668*g+0.198217*b, 0.228975*r+0.691739*g+0.079287*b, 0.000000*r+0.045113*g+1.043944*b ]; }
    function rgbToXYZ_2020(r,g,b)  { return [ 0.636958*r+0.144617*g+0.168881*b, 0.262700*r+0.677998*g+0.059302*b, 0.000000*r+0.028073*g+1.060985*b ]; }

    let srcToXYZ;
    if (cicp_primaries === 9)       srcToXYZ = rgbToXYZ_2020;
    else if (cicp_primaries === 12) srcToXYZ = rgbToXYZ_P3;
    else                            srcToXYZ = rgbToXYZ_709; // 1, null, or anything else

    // XYZ → target gamut linear RGB (D65)
    function xyzToRec709(X,Y,Z) { return [ 3.240970*X-1.537383*Y-0.498611*Z, -0.969244*X+1.875968*Y+0.041555*Z,  0.055630*X-0.203977*Y+1.056972*Z ]; }
    function xyzToP3(X,Y,Z)     { return [ 2.493497*X-0.931384*Y-0.402711*Z, -0.829489*X+1.762664*Y+0.023625*Z,  0.035845*X-0.076172*Y+0.956885*Z ]; }
    function xyzTo2020(X,Y,Z)   { return [ 1.716651*X-0.355671*Y-0.253366*Z, -0.666684*X+1.616481*Y+0.015769*Z,  0.017640*X-0.042771*Y+0.942103*Z ]; }

    // If source is BT.709/sRGB, gamut breakdown is trivial (all pixels are by definition in 709).
    // Only meaningful for wide-gamut sources (P3 or BT.2020).
    if (cicp_primaries !== 9 && cicp_primaries !== 12) {
        return {
            rec709:  '100.0',
            p3:      '0.0',
            bt2020:  '0.0',
            sourcePrimaries: 'BT.709/sRGB',
            narrowSource: true,
        };
    }

    // Gamut is purely a chromaticity property — we don't need to apply the EOTF.
    // Just use the raw 16-bit values normalized to [0,1] as a proxy for linear light.
    // This correctly preserves the relative RGB ratios that determine which gamut a colour sits in.

    // EOTF to get linear light, then normalize to isolate chromaticity
    let eotf;
    if (transferCharacteristic === 16) {
        eotf = v => { const m1=0.1593017578125,m2=78.84375,c1=0.8359375,c2=18.8515625,c3=18.6875; const vp=Math.pow(Math.max(v,0),1/m2); return Math.pow(Math.max(vp-c1,0)/(c2-c3*vp),1/m1); };
    } else if (transferCharacteristic === 18) {
        eotf = v => { const a=0.17883277,b=0.28466892,c=0.55991073; return v<=0.5?(v*v)/3:(Math.exp((v-c)/a)+b)/12; };
    } else {
        eotf = v => v <= 0.04045 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4);
    }

    // Build EOTF LUT to avoid per-pixel pow() calls
    const lut = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) lut[i] = eotf(i / 65535);

    let w709=0, wP3only=0, w2020only=0, wTotal=0;
    const pixelCount = width * height;

    for (let i = 0; i < pixelCount; i++) {
        const base = i * bytesPerPixel;
        const r = lut[(pixels[base]   << 8) | pixels[base+1]];
        const g = lut[(pixels[base+2] << 8) | pixels[base+3]];
        const b = lut[(pixels[base+4] << 8) | pixels[base+5]];

        // Skip near-black — chromaticity undefined at very low luminance
        const sum = r + g + b;
        if (sum < 1e-6) continue;

        // Normalize to isolate chromaticity (remove luminance scale)
        const rn = r / sum, gn = g / sum, bn = b / sum;

        const xyz = srcToXYZ(rn, gn, bn);

        // Weight by luminance Y so bright saturated pixels count more
        const Y = xyz[1];
        wTotal += Y;

        const rgb709  = xyzToRec709(...xyz);
        const rgbP3   = xyzToP3(...xyz);
        const rgb2020 = xyzTo2020(...xyz);

        if      (inGamut(rgb709))          w709      += Y;
        else if (inGamut(rgbP3))           wP3only   += Y;
        else if (inGamut(rgb2020))         w2020only += Y;
    }

    if (wTotal === 0) return null;
    return {
        rec709:  (w709      / wTotal * 100).toFixed(4),
        p3:      (wP3only   / wTotal * 100).toFixed(4),
        bt2020:  (w2020only / wTotal * 100).toFixed(4),
        sourcePrimaries: cicp_primaries === 9 ? 'BT.2020' : 'P3-D65',
    };
}