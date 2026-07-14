// ─── db.js — Firebase Firestore + Cloudinary storage layer ──────────────────
// Drop-in replacement for the IndexedDB section that was at the top of script.js.
// Exposes identical function signatures so the rest of script.js needs only
// minimal changes (blob references → Cloudinary URL references).
//
// Dependencies (loaded by index.html before this file):
//   firebase-app-compat.js
//   firebase-auth-compat.js
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
const _auth  = firebase.auth();
const _db    = firebase.firestore();
const _col   = _db.collection('images');

// ── Anonymous Auth ────────────────────────────────────────────────────────────
// Signs in anonymously on load — gives every visitor a stable uid without any
// sign-in UI. Firebase persists the auth session (anonymous OR admin) in
// localStorage, so we first wait to see if a session was already restored
// before creating a new anonymous one — otherwise reloading after an admin
// sign-in would immediately get clobbered by a brand new anonymous user.
// _authReady resolves once we have a uid, so upload/delete calls can await it.
const _authReady = new Promise((resolve) => {
    const unsubscribe = _auth.onAuthStateChanged(async (user) => {
        unsubscribe();
        if (user) {
            console.log('[db] restored existing session, uid:', user.uid);
            resolve();
            return;
        }
        try {
            await _auth.signInAnonymously();
            console.log('[db] signed in anonymously, uid:', _auth.currentUser.uid);
        } catch (err) {
            console.error('[db] anonymous auth failed:', err);
        }
        resolve();
    });
});

// Returns the current user's uid, waiting for auth to be ready first.
async function _getUid() {
    await _authReady;
    return _auth.currentUser?.uid ?? null;
}

// ── Cloudinary ────────────────────────────────────────────────────────────────
const _CLOUD  = 'djwytlx4j';
const _PRESET = 'hdr-gallery';
const _UP_URL = `https://api.cloudinary.com/v1_1/${_CLOUD}/auto/upload`;

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
async function addImageFile(file, metadata = null, sdrBlob = null, hdrType = null, batchId = null, thumbBlob = null, gameName = null, spoiler = false, additionalInfo = null, sdrLuminanceStats = null, hidden = false) {
    const uid  = await _getUid();
    const base = file.name.replace(/\.[^.]+$/, '');

    const [hdr, sdr, thumb] = await Promise.all([
        _uploadBlob(file,      file.name),
        _uploadBlob(sdrBlob, sdrBlob?.name ?? null),
        (async () => {
            if (!thumbBlob) return { url: null, publicId: null };
            const thumbExt = thumbBlob.type === 'image/avif' ? '.avif'
                           : thumbBlob.type === 'image/png'  ? '.png'
                           : '.webp';
            return _uploadBlob(thumbBlob, base + '_thumb' + thumbExt);
        })(),
    ]);

    const ref = await _col.add({
        uid:                uid,
        name:               file.name,
        type:               file.type || '',
        created:            Date.now(),
        metadata:           metadata           ?? null,
        hdrType:            hdrType            ?? null,
        batchId:            batchId            ?? null,
        gameName:           gameName           ?? null,
        spoiler:            spoiler            ?? false,
        hidden:             hidden             ?? false,
        additionalInfo:     additionalInfo     ?? null,
        sdrLuminanceStats:  sdrLuminanceStats  ?? null,
        hdrUrl:             hdr.url,
        hdrPublicId:        hdr.publicId,
        sdrUrl:             sdr.url,
        sdrPublicId:        sdr.publicId,
        thumbUrl:           thumb.url,
        thumbPublicId:      thumb.publicId,
    });

    return ref.id;
}

// Returns all image documents ordered by upload time (oldest first).
// Each object has { id, uid, name, type, created, metadata, hdrType, batchId,
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

async function updateAdditionalInfo(id, additionalInfo) {
    await _col.doc(id).update({ additionalInfo: additionalInfo ?? null });
}

async function updateBatchSpoiler(batchId, id, spoiler) {
    if (batchId) {
        const snap = await _col.where('batchId', '==', batchId).get();
        const batch = _db.batch();
        snap.docs.forEach(d => batch.update(d.ref, { spoiler }));
        await batch.commit();
    } else {
        await _col.doc(id).update({ spoiler });
    }
}

async function updateImageHidden(id, hidden) {
    await _col.doc(id).update({ hidden: hidden ?? false });
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

// Returns true if the current user owns the given image document, or is the admin.
// Use this in script.js to decide whether to show edit/delete buttons.
async function isCurrentUserOwner(imageItem) {
    const uid = await _getUid();
    if (uid === null) return false;
    return uid === imageItem.uid || uid === _ADMIN_UID;
}

const _ADMIN_UID = 'Ug1Y9PV7kARmLvGhx1pndiASDpJ3';

// Returns true if the current user is the site admin (used to show/hide upload UI).
async function isAdmin() {
    const uid = await _getUid();
    return uid === _ADMIN_UID;
}