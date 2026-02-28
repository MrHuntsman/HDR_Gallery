// ─── db.js — Firebase Firestore + Cloudinary storage layer ──────────────────
// Drop-in replacement for the IndexedDB section that was at the top of script.js.
// Exposes identical function signatures so the rest of script.js needs only
// minimal changes (blob references → Cloudinary URL references).
//
// Dependencies (loaded by index.html before this file):
//   firebase-app-compat.js
//   firebase-firestore-compat.js

// ── Firebase ──────────────────────────────────────────────────────────────────
const _firebaseConfig = {
    apiKey:            'AIzaSyBysfg2R3Xo7y7sdXKUkmFGqygHvTpA0E4',
    authDomain:        'hdr-gallery.firebaseapp.com',
    projectId:         'hdr-gallery',
    storageBucket:     'hdr-gallery.firebasestorage.app',
    messagingSenderId: '28459554204',
    appId:             '1:28459554204:web:4d89d50d3feb35a63b2459',
};

const _fbApp = firebase.initializeApp(_firebaseConfig);
const _db    = firebase.firestore();
const _col   = _db.collection('images');

// ── Cloudinary ────────────────────────────────────────────────────────────────
const _CLOUD  = 'djwytlx4j';
const _PRESET = 'hdr-gallery';
const _UP_URL = `https://api.cloudinary.com/v1_1/${_CLOUD}/auto/upload`;

async function _compressToJpeg(blob, quality = 0.92) {
    const url = URL.createObjectURL(blob);
    try {
        const img = await new Promise((res, rej) => {
            const i = new Image();
            i.onload = () => res(i);
            i.onerror = rej;
            i.src = url;
        });
        const canvas = document.createElement('canvas');
        canvas.width  = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        return await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
    } finally {
        URL.revokeObjectURL(url);
    }
}

async function _uploadBlob(blob, filename) {
    if (!blob) return { url: null, publicId: null };
    const fd = new FormData();
    fd.append('file', blob, filename);
    fd.append('upload_preset', _PRESET);
    const res = await fetch(_UP_URL, { method: 'POST', body: fd });
    if (!res.ok) {
        const msg = await res.text().catch(() => res.statusText);
        throw new Error(`Cloudinary upload failed (${res.status}): ${msg}`);
    }
    const j = await res.json();
    return { url: j.secure_url, publicId: j.public_id };
}

// ── Public helpers ────────────────────────────────────────────────────────────

function generateBatchId() {
    return `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Upload all three blobs to Cloudinary, then store the URLs + metadata in Firestore.
// Returns the new Firestore document ID (string).
async function addImageFile(file, metadata = null, sdrBlob = null, hdrType = null, batchId = null, thumbBlob = null, gameName = null) {
    const base = file.name.replace(/\.[^.]+$/, '');

    const [hdr, sdr, thumb] = await Promise.all([
        _uploadBlob(file,      file.name),
        (async () => {
            if (!sdrBlob) return { url: null, publicId: null };
            // Recompress SDR to JPEG to stay within Cloudinary's 10 MB free-tier limit.
            // Quality 0.92 is visually lossless for an SDR preview image.
            const compressed = await _compressToJpeg(sdrBlob, 0.92);
            return _uploadBlob(compressed, base + '_sdr.jpg');
        })(),
        _uploadBlob(thumbBlob, base + '_thumb.webp'),
    ]);

    const ref = await _col.add({
        name:          file.name,
        type:          file.type || '',
        created:       Date.now(),
        metadata:      metadata  ?? null,
        hdrType:       hdrType   ?? null,
        batchId:       batchId   ?? null,
        gameName:      gameName  ?? null,
        hdrUrl:        hdr.url,
        hdrPublicId:   hdr.publicId,
        sdrUrl:        sdr.url,
        sdrPublicId:   sdr.publicId,
        thumbUrl:      thumb.url,
        thumbPublicId: thumb.publicId,
    });

    return ref.id;
}

// Returns all image documents ordered by upload time (oldest first).
// Each object has { id, name, type, created, metadata, hdrType, batchId,
//                   gameName, hdrUrl, sdrUrl, thumbUrl, … }.
async function getAllImageFiles() {
    const snap = await _col.orderBy('created', 'asc').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// Fetch a single document by Firestore ID.
async function getImageFile(id) {
    const snap = await _col.doc(id).get();
    return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

async function deleteImageFile(id) {
    // Note: Cloudinary blobs are not deleted here — they can be cleaned up via
    // the Cloudinary dashboard. Client-side deletion requires a signed request.
    await _col.doc(id).delete();
}

async function deleteBatchImageFiles(ids) {
    const batch = _db.batch();
    ids.forEach(id => batch.delete(_col.doc(id)));
    await batch.commit();
}

async function updateImageMetadata(id, metadata) {
    await _col.doc(id).update({ metadata });
}

async function updateImageHdrType(id, hdrType) {
    await _col.doc(id).update({ hdrType });
}

async function updateBatchGameName(batchId, gameName) {
    const snap = await _col.where('batchId', '==', batchId).get();
    const batch = _db.batch();
    snap.docs.forEach(d => batch.update(d.ref, { gameName }));
    await batch.commit();
}

async function clearAllImageFiles() {
    const snap = await _col.get();
    const batch = _db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
}