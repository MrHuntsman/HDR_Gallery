// ─── Storage layer ────────────────────────────────────────────────────────────
// All DB/storage functions are defined in db.js (Firebase Firestore + Cloudinary).
// generateBatchId, addImageFile, getAllImageFiles, getImageFile, deleteImageFile,
// deleteBatchImageFiles, updateImageMetadata, updateImageHdrType,
// updateBatchGameName, clearAllImageFiles are all available as globals from db.js.

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG = {
    zoomScale:  3,    // magnification level when holding down on an image
    zoomInMs:   80,   // transition duration when zooming in  (ms)
    zoomOutMs:  120,  // transition duration when zooming out (ms)
    rawgKey:    '2ed92fc542034b3ea93847700be1043b',
};
// ─── RAWG Banner Cache ────────────────────────────────────────────────────────
// Two-level cache: in-memory Map for the current session, localStorage for
// persistence across page refreshes. Entries expire after 7 days so renamed
// games or updated RAWG artwork eventually get a fresh fetch.
const _BANNER_CACHE_KEY = 'rawgBannerCache_v1';
const _BANNER_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days in ms
const _rawgBannerCache  = new Map(); // in-memory layer

function _loadBannerStore() {
    try { return JSON.parse(localStorage.getItem(_BANNER_CACHE_KEY) || '{}'); } catch { return {}; }
}
function _saveBannerStore(store) {
    try { localStorage.setItem(_BANNER_CACHE_KEY, JSON.stringify(store)); } catch {}
}
function _bannerStoreGet(gameName) {
    const store = _loadBannerStore();
    const entry = store[gameName];
    if (!entry) return undefined;
    if (Date.now() - entry.ts > _BANNER_CACHE_TTL) { delete store[gameName]; _saveBannerStore(store); return undefined; }
    return entry.url; // may be null (cached "no result")
}
function _bannerStoreSet(gameName, url) {
    const store = _loadBannerStore();
    store[gameName] = { url, ts: Date.now() };
    _saveBannerStore(store);
}

async function _fetchRawgBannerImage(gameName) {
    // 1. In-memory hit
    if (_rawgBannerCache.has(gameName)) return _rawgBannerCache.get(gameName);
    // 2. localStorage hit (survives refresh, expires after 7 days)
    const stored = _bannerStoreGet(gameName);
    if (stored !== undefined) { _rawgBannerCache.set(gameName, stored); return stored; }
    // 3. Network fetch
    try {
        const results = await searchRawg(gameName);
        // Prefer an exact name match, otherwise use first result
        const match = results.find(r => r.name.toLowerCase() === gameName.toLowerCase()) || results[0];
        const img = match?.background_image || null;
        _rawgBannerCache.set(gameName, img);
        _bannerStoreSet(gameName, img);
        return img;
    } catch {
        _rawgBannerCache.set(gameName, null);
        return null;
    }
}

// Renders the styled game banner into .gallery-section-header.
// If the URL is already cached (in-memory or localStorage) it renders
// instantly with no skeleton flash. Otherwise shows a skeleton while fetching.
async function _showGameBanner(gameName) {
    const sectionHeader = document.querySelector('.gallery-section-header');
    if (!sectionHeader) return;

    // Check both cache layers synchronously before touching the DOM
    const cachedUrl = _rawgBannerCache.has(gameName) ? _rawgBannerCache.get(gameName) : _bannerStoreGet(gameName);
    const isInstant = cachedUrl !== undefined;

    const bgStyle = (isInstant && cachedUrl) ? `style="background-image:url(${cachedUrl})"` : '';
    sectionHeader.style.display = '';
    sectionHeader.innerHTML = `
        <div class="game-banner-header${isInstant ? '' : ' banner-loading'}" ${bgStyle}>
            <div class="game-banner-overlay"></div>
            <span class="game-banner-title">${gameName}</span>
            <button class="game-banner-close" aria-label="Clear search">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        </div>`;

    sectionHeader.querySelector('.game-banner-close').addEventListener('click', () => {
        gameSearchQuery = '';
        const input   = document.getElementById('gallerySearchInput');
        const clearBtn = document.getElementById('gallerySearchClear');
        if (input)    input.value = '';
        if (clearBtn) clearBtn.style.display = 'none';
        renderGallery(_allGalleryItems);
    });

    if (isInstant) return; // already rendered with correct image

    const bannerEl = sectionHeader.querySelector('.game-banner-header');
    const imgUrl = await _fetchRawgBannerImage(gameName);
    if (bannerEl && imgUrl) {
        bannerEl.classList.remove('banner-loading');
        bannerEl.style.backgroundImage = `url(${imgUrl})`;
    } else if (bannerEl) {
        bannerEl.classList.remove('banner-loading');
    }
}

// ─── HDR Types ────────────────────────────────────────────────────────────────

const HDR_TYPES = [
    { id: 'renodx',        label: 'RenoDX',          group: 'Real HDR' },
    { id: 'luma',          label: 'Luma',             group: 'Real HDR' },
    { id: 'native',        label: 'Native',           group: 'Real HDR' },
    { id: 'specialk',      label: 'SpecialK',         group: 'Inverse Tonemapping' },
    { id: 'rtxHdr',        label: 'RTX HDR',          group: 'Inverse Tonemapping' },
    { id: 'autoHdr',       label: 'Windows Auto HDR', group: 'Inverse Tonemapping' },
    { id: 'dxvk',          label: 'DXVK HDR',         group: 'Inverse Tonemapping' },
    { id: 'pumboReshade',  label: 'Pumbo ReShade',    group: 'Inverse Tonemapping' },
    { id: 'liliumReshade', label: 'Lilium ReShade',   group: 'Inverse Tonemapping' },
];

// ─── Active Filters ───────────────────────────────────────────────────────────

let gameSearchQuery = '';

// Keeps ?game= in the address bar in sync with the active filter.
// Uses replaceState so the back button isn't polluted.
function _syncGameUrl(gameName) {
    const url = new URL(location.href);
    if (gameName) {
        url.searchParams.set('game', gameName);
    } else {
        url.searchParams.delete('game');
    }
    history.replaceState(null, '', url.toString());
}

// ─── Gallery View Mode ────────────────────────────────────────────────────────
// 'batch' = collage cards (default) | 'list' = all images stacked vertically
// 'list' = stacked (default / no game) | 'grid2' = 2-col | 'grid3' = 3-col
// gameViewMode persists the user's preferred grid mode when a game IS selected.
let galleryViewMode = 'list';
let gameViewMode = (() => {
    try { return localStorage.getItem('gameViewMode') || 'grid2'; } catch { return 'grid2'; }
})();

function setGalleryViewMode(mode) {
    // Only grid2/grid3/list when a game is active; always list otherwise
    galleryViewMode = gameSearchQuery.trim() ? mode : 'list';
    if (gameSearchQuery.trim()) {
        gameViewMode = mode;
        try { localStorage.setItem('gameViewMode', mode); } catch {}
    }
    const gallery = document.getElementById('gallery');
    if (gallery) {
        gallery.classList.toggle('gallery-list-mode',  galleryViewMode === 'list');
        gallery.classList.toggle('gallery-grid2-mode', galleryViewMode === 'grid2');
        gallery.classList.toggle('gallery-grid3-mode', galleryViewMode === 'grid3');
    }
    document.querySelectorAll('.view-toggle-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.view === galleryViewMode);
    });
    if (_allGalleryItems.length) {
        buildGalleryCards(_allGalleryItems);
        renderGallery(_allGalleryItems);
    }
}

// ─── File Handling ────────────────────────────────────────────────────────────

// All supported formats go through the AVIF re-encode pipeline on import.
const SUPPORTED_EXTENSIONS = ['.png', '.jxr', '.exr', '.hdr', '.avif'];

// File validation
function getFileExtension(filename) {
    const index = filename.lastIndexOf('.');
    return index >= 0 ? filename.slice(index).toLowerCase() : '';
}

// Thin wrapper around getImageMetadata (image-processing.js) with error handling
async function extractMetadataFromFile(file) {
    try {
        return await getImageMetadata(file, file.name);
    } catch (error) {
        console.error('Error extracting metadata:', error);
        return null;
    }
}

function isAllowedFile(file) {
    const extension = getFileExtension(file?.name ?? '');
    return SUPPORTED_EXTENSIONS.includes(extension);
}

// ─── UI State & Globals ──────────────────────────────────────────────────────

const fileInput = document.getElementById('fileInput');
const galleryContainer = document.getElementById('gallery');
const statusMessage = document.getElementById('statusMessage');
const dropZone = document.getElementById('dropZone');

// Global details toggle state
let globalDetailsEnabled = false;
let currentVisibleImage = null;
let imageWrappers = new Map(); // Map of imageItem.id -> { wrapper, metadata, imageItem }
// Persistent panel positions across image scrolls and page refreshes
const imoPanelPositions = (() => {
    try {
        const saved = localStorage.getItem('imoPanelPositionsSingle');
        return saved ? JSON.parse(saved) : { single: null };
    } catch { return { single: null }; }
})();

function saveImoPanelPositions() {
    try { localStorage.setItem('imoPanelPositionsSingle', JSON.stringify(imoPanelPositions)); } catch {}
}

// Global floating nit tooltip
const cursorTooltip = document.createElement('div');
cursorTooltip.className = 'nit-tooltip';
cursorTooltip.style.display = 'none';
document.body.appendChild(cursorTooltip);

// Rows inside the combined tooltip
const _zoomRow = document.createElement('div');
_zoomRow.className = 'cursor-tooltip-zoom';
_zoomRow.style.display = 'none';
cursorTooltip.appendChild(_zoomRow);

const _nitsRow = document.createElement('div');
_nitsRow.className = 'cursor-tooltip-nits';
_nitsRow.style.display = 'none';
cursorTooltip.appendChild(_nitsRow);

// ─── Nit tooltip HTML helpers ─────────────────────────────────────────────────
function _nitTooltipHTML(rNits, gNits, bNits, luminance, gamut) {
    const fmt = v => v < 10 ? v.toFixed(2) : Math.round(v);
    const gamutClass = gamut === 'SDR' ? 'nit-grid__gamut--sdr' : gamut === 'BT.2020' ? 'nit-grid__gamut--2020' : gamut === 'DCI-P3' ? 'nit-grid__gamut--p3' : 'nit-grid__gamut--709';
    return `<div class="nit-grid"><span>Nits</span><span>:</span><span class="nit-grid__val">${fmt(luminance)}</span><span class="nit-grid__r">R</span><span class="nit-grid__r">:</span><span class="nit-grid__val nit-grid__r">${fmt(rNits)}</span><span class="nit-grid__g">G</span><span class="nit-grid__g">:</span><span class="nit-grid__val nit-grid__g">${fmt(gNits)}</span><span class="nit-grid__b">B</span><span class="nit-grid__b">:</span><span class="nit-grid__val nit-grid__b">${fmt(bNits)}</span><span class="nit-grid__gamut ${gamutClass}">${gamut}</span></div>`;
}
const _NIT_LOADING_HTML = `<div class="nit-loading"><svg class="nit-loading__spinner" xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg><span class="nit-loading__text">Reading pixel data…</span></div>`;

// Compat shims so existing code keeps working
const nitTooltip = {
    _el: cursorTooltip, _row: _nitsRow,
    get style() { return { 
        set display(v) { _nitsRow.style.display = v; cursorTooltip.style.display = (_nitsRow.style.display === 'none' && _zoomRow.style.display === 'none') ? 'none' : 'block'; },
        get display() { return _nitsRow.style.display; }
    }; },
    set innerHTML(v) { _nitsRow.innerHTML = v; },
    set textContent(v) { _nitsRow.textContent = v; },
};
const zoomTooltip = {
    _el: cursorTooltip, _row: _zoomRow,
    get style() { return {
        set display(v) {
            _zoomRow.style.display = v;
            cursorTooltip.classList.toggle('cursor-tooltip-zoom-visible', v !== 'none');
            cursorTooltip.style.display = (_nitsRow.style.display === 'none' && _zoomRow.style.display === 'none') ? 'none' : 'block';
        },
        get display() { return _zoomRow.style.display; }
    }; },
    set textContent(v) { _zoomRow.textContent = v; },
    set innerHTML(v) { _zoomRow.innerHTML = v; },
};

// Always-current cursor position, used to immediately sample pixels when details mode is toggled on
let lastCursorX = 0;
let lastCursorY = 0;

document.addEventListener('mousemove', (e) => {
    lastCursorX = e.clientX;
    lastCursorY = e.clientY;
    const ttW = cursorTooltip.offsetWidth  || 140;
    const ttH = cursorTooltip.offsetHeight || 80;
    const gap = 14;
    const tx = (e.clientX + gap + ttW > window.innerWidth)  ? e.clientX - ttW - gap : e.clientX + gap;
    const ty = (e.clientY + gap + ttH > window.innerHeight) ? e.clientY - ttH - gap : e.clientY + gap;
    cursorTooltip.style.left = tx + 'px';
    cursorTooltip.style.top  = ty + 'px';
});

// ─── Drop Zone ───────────────────────────────────────────────────────────────

dropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', (event) => {
    event.preventDefault();
    dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', async (event) => {
    event.preventDefault();
    dropZone.classList.remove('drag-over');
    
    const droppedFiles = Array.from(event.dataTransfer.files || []);
    
    if (droppedFiles.length === 0) {
        showStatusMessage('No files dropped', 'error');
        return;
    }
    
    await processFiles(droppedFiles);
});

// Click on drop zone to open file dialog
dropZone.addEventListener('click', () => {
    fileInput.click();
});

// ─── Details Overlay (global nit-hunt + metadata panels) ─────────────────────

function toggleGlobalDetailsMode() {
    globalDetailsEnabled = !globalDetailsEnabled;
    
    // Update all detail buttons (in lightbox toolbar)
    updateAllDetailButtons(globalDetailsEnabled);

    if (globalDetailsEnabled) {
        // If lightbox is open, cancel SDR slider first (mutually exclusive with slider only)
        if (lightboxOpen && lightboxSdrActive) {
            const sdrSliderBtn = Array.from(document.querySelectorAll('.lightbox-toolbar button'))
                .find(b => b.classList.contains('button-active') && b.textContent.includes('SDR'));
            if (sdrSliderBtn) sdrSliderBtn.click();
        }
        // If lightbox is open, start pixel decode now and show details
        if (lightboxOpen) {
            const imgEl = document.querySelector('.lightbox-image');
            if (imgEl) imgEl.classList.add('cursor-nit-hunt');
            const container = document.querySelector('.lightbox-image-container');
            if (container) container.classList.add('cursor-nit-hunt');
            const currentItem = lightboxBatch[lightboxIndex];
            if (currentItem) {
                if (lightboxSdrToggleActive) {
                    // In SDR toggle mode — decode SDR buffer and show SDR metadata panel
                    _startSdrPixelDecode(currentItem);
                    if (currentVisibleImage) {
                        const imageData = imageWrappers.get(currentVisibleImage);
                        if (imageData) {
                            const existing = imageData.wrapper.querySelector('.image-meta-overlay');
                            if (existing) existing.remove();
                            _showSdrMetadataOverlay(currentItem, imageData.wrapper);
                        }
                    }
                    lightboxSdrPixelBuffers.get(currentItem.id)?.then(buf => {
                        if (lightboxSdrToggleActive && globalDetailsEnabled) {
                            // find the lbPixelBuffer closure via imageWrappers isn't accessible here,
                            // so we dispatch a synthetic mouseenter to re-prime the tooltip
                            const imgElActive = document.querySelector('.lightbox-image');
                            if (imgElActive) imgElActive.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
                        }
                    });
                } else {
                    // Normal HDR mode
                    _startPixelDecode(currentItem);
                    if (currentVisibleImage) showDetailsForImage(currentVisibleImage);
                    const imgElActive = document.querySelector('.lightbox-image');
                    if (imgElActive && imgElActive.matches(':hover')) {
                        imgElActive.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
                    }
                }
            }
        }
    } else {
        // Remove nit-hunt cursor from lightbox image
        if (lightboxOpen) {
            const imgEl = document.querySelector('.lightbox-image');
            if (imgEl) imgEl.classList.remove('cursor-nit-hunt');
            const container = document.querySelector('.lightbox-image-container');
            if (container) container.classList.remove('cursor-nit-hunt');
        }
        // Hide all details overlays
        hideAllDetailsOverlays();
        nitTooltip.style.display = 'none';
        // If currently zoomed, start the idle-hide timer now that analysis mode is off
        if (lightboxOpen && _lightboxResetZoomIdleTimer) _lightboxResetZoomIdleTimer();
    }
}

function updateAllDetailButtons(isActive) {
    document.querySelectorAll('.detail-button').forEach(button => {
        if (isActive) {
            button.classList.add('button-active');
            button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg><span class="btn-label"> <u>A</u>nalysis Tool</span>';
        } else {
            button.classList.remove('button-active');
            button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" opacity="0.3"></path><circle cx="12" cy="12" r="3"></circle></svg><span class="btn-label"> <u>A</u>nalysis Tool</span>';
        }
    });
}

async function showDetailsForImage(imageId) {
    const imageData = imageWrappers.get(imageId);
    if (!imageData) return;
    
    const { wrapper, imageItem } = imageData;
    let { metadata } = imageData;
    
    // If metadata is not yet loaded, fetch it
    if (!metadata) {
        const freshImageItem = await getImageFile(imageItem.id);
        
        metadata = freshImageItem?.metadata;
        
        // If still no metadata, extract it
        if (!metadata) {
            const resp = await fetch(imageItem.hdrUrl);
            const blob = await resp.blob();
            metadata = await getImageMetadata(blob, imageItem.name);
            
            // Save the extracted metadata to the database
            if (metadata && imageItem.id) {
                try {
                    await updateImageMetadata(imageItem.id, metadata);
                } catch (error) {
                    console.error('Failed to save metadata:', error);
                }
            }
        } else {
            // Recompute gamut if cached data looks stale (old bug produced 100/0/0)
            const gc = metadata.gamutCoverage;
            const isStale = !gc || (gc.rec709 === '100.0' && gc.p3 === '0.0' && gc.bt2020 === '0.0' && !gc.narrowSource);
            if (isStale) {
                try {
                    const blob = imageItem.blob instanceof Blob
                        ? imageItem.blob
                        : new Blob([imageItem.blob], { type: imageItem.type });
                    metadata.gamutCoverage = await analyzeGamutCoverage(blob);
                    await updateImageMetadata(imageItem.id, metadata);
                } catch(e) {}
            }
        }
        
        // Update the cache
        imageData.metadata = metadata;
    }
    
    if (metadata) {
        // Remove any existing overlay first
        const existing = wrapper.querySelector('.image-meta-overlay');
        if (existing) existing.remove();
        
        // Show the overlay without a trigger button (global mode)
        showMetadataOverlay(imageItem.name, metadata, wrapper);
    }
}

function hideAllDetailsOverlays() {
    imageWrappers.forEach((imageData) => {
        const existing = imageData.wrapper.querySelector('.image-meta-overlay');
        if (existing) existing.remove();
    });
}

// Computes SDR luminance stats (max/avg/min in cd/m²) from an 8-bit sRGB blob.
// Uses createImageBitmap + OffscreenCanvas so no worker or network fetch is needed —
// the blob is already in memory at import time.
async function computeSdrLuminanceStats(sdrBlob) {
    try {
        const bitmap = await createImageBitmap(sdrBlob);
        const { width, height } = bitmap;
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        const { data } = ctx.getImageData(0, 0, width, height);
        const total = width * height;
        let maxL = 0, sumL = 0, minL = Infinity;
        for (let i = 0; i < total; i++) {
            const base = i * 4;
            const r = _srgbEotf(data[base]     / 255);
            const g = _srgbEotf(data[base + 1] / 255);
            const b = _srgbEotf(data[base + 2] / 255);
            const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            if (lum > maxL) maxL = lum;
            if (lum < minL) minL = lum;
            sumL += lum;
        }
        return {
            maxLuminance: maxL,
            avgLuminance: sumL / total,
            minLuminance: minL === Infinity ? 0 : minL,
        };
    } catch (e) {
        console.warn('[import] SDR luminance stats failed:', e);
        return null;
    }
}



async function processFiles(selectedFiles) {
    console.log("[processFiles] v2 running, files:", selectedFiles.map(f => f.name));
    let allowedFiles = selectedFiles.filter(isAllowedFile);
    const rejectedFiles = selectedFiles.filter(file => !isAllowedFile(file));

    if (rejectedFiles.length) {
        const rejectedNames = rejectedFiles.map(f => f.name).join(', ');
        alert(`Unsupported format(s): ${rejectedNames}\n\nSupported: .png  .avif  .jxr  .exr  .hdr`);
    }

    if (allowedFiles.length === 0) {
        showStatusMessage('No valid files selected', 'error');
        return;
    }

    // ── SDR detection — runs before the import modal so the user is told immediately ──
    const sdrFiles = await detectSdrFiles(allowedFiles);
    if (sdrFiles.length > 0) {
        const lines = sdrFiles.map(({ file, reason }) => `  • ${file.name} — ${reason}`).join('\n');
        if (sdrFiles.length === allowedFiles.length) {
            // Every file failed — abort entirely
            alert(`No HDR images detected.\n\nAll selected files appear to be SDR:\n${lines}\n\nOnly HDR images are supported.`);
            fileInput.value = '';
            return;
        } else {
            // Some files failed — inform and continue with the rest
            alert(`The following files were skipped because they appear to be SDR:\n${lines}`);
            allowedFiles = allowedFiles.filter(f => !sdrFiles.some(r => r.file === f));
        }
    }

    // Show import modal — user picks HDR type and game name before processing begins
    const importResult = await showImportModal(allowedFiles.length, allowedFiles);
    if (importResult === null) {
        fileInput.value = '';
        return; // User cancelled
    }
    const { hdrType, gameName: importGameName, spoiler: importSpoiler, additionalInfo: importAdditionalInfo } = importResult;

    const toConvert = allowedFiles; // all formats go through the AVIF pipeline

    // ── Per-step timing helpers ──────────────────────────────────────────────────
    const _importT0 = performance.now();
    function _importLog(label, startMs) {
        const elapsed = (performance.now() - startMs).toFixed(0);
        console.log(`[import] ${label}: ${elapsed} ms`);
    }

    try {
        initProgress(allowedFiles.length, toConvert.length > 0);

        const batchId = generateBatchId();
        for (const file of allowedFiles) {
            // Advance the unified file counter once, before any step is set for this file
            advanceProgressFile();

            let hdrFile = file;
            let prebuiltSdr = null;
            let prebuiltThumb = null;

            // Convert to AVIF (all formats go through this pipeline)
            if (true) {
                setProgressStep('convert', file.name);
                try {
                    const _t = performance.now();
                    const result = await convertToAVIF(file);
                    _importLog(`convertToAVIF: ${file.name}`, _t);
                    console.log('[convertToAVIF processFiles] hdrFile:', result.hdrFile?.name, result.hdrFile?.size);
                    console.log('[convertToAVIF processFiles] sdrBlob:', result.sdrBlob?.constructor?.name, result.sdrBlob?.size);
                    console.log('[convertToAVIF processFiles] thumbBlob:', result.thumbBlob?.constructor?.name, result.thumbBlob?.size);
                    hdrFile = result.hdrFile;
                    prebuiltSdr = result.sdrBlob;
                    prebuiltThumb = result.thumbBlob;
                } catch (err) {
                    hideProgress();
                    showStatusMessage(`Failed to convert ${file.name}: ${err.message}`, 'error');
                    console.error('Conversion error:', err);
                    continue;
                }
            }

            setProgressStep('metadata', hdrFile.name);
            const _tMeta = performance.now();
            const metadata = await extractMetadataFromFile(hdrFile);
            _importLog(`extractMetadata: ${hdrFile.name}`, _tMeta);


            setProgressStep('analysing');
            let sdrBlob = prebuiltSdr;
            if (!sdrBlob) {
                _progressFileLabel = `SDR tonemap: ${hdrFile.name}`;
                _renderProgress();
                const _t = performance.now();
                try {
                    sdrBlob = await convertToSDR(hdrFile, hdrFile.name);
                    _importLog(`convertToSDR: ${hdrFile.name}`, _t);
                    console.log('[processFiles] convertToSDR done:', sdrBlob?.size);
                } catch (error) {
                    console.error('SDR conversion failed:', error);
                }
            } else {
                console.log('[processFiles] skipping convertToSDR, using prebuilt:', prebuiltSdr?.size);
            }

            const thumbBlob = prebuiltThumb;

            // Compute SDR luminance stats from the blob — stored in Firestore so the
            // analysis panel can render instantly without re-decoding at view time.
            let sdrLuminanceStats = null;
            if (sdrBlob) {
                const _tSdrStats = performance.now();
                sdrLuminanceStats = await computeSdrLuminanceStats(sdrBlob);
                _importLog(`computeSdrLuminanceStats: ${hdrFile.name}`, _tSdrStats);
            }

            _progressFileLabel = `Saving: ${hdrFile.name}`;
            _renderProgress();
            const _tSave = performance.now();
            console.log('[processFiles] storing — thumb:', thumbBlob?.size, 'sdr:', sdrBlob?.size);
            await addImageFile(hdrFile, metadata, sdrBlob, hdrType, batchId, thumbBlob, importGameName, importSpoiler, importAdditionalInfo, sdrLuminanceStats);
            _importLog(`addImageFile: ${hdrFile.name}`, _tSave);
        }
        _importLog('total import', _importT0);

        fileInput.value = '';
        hideProgress();
        await refreshGallery();
    } catch (error) {
        hideProgress();
        showStatusMessage('Failed to process files: ' + error.message, 'error');
        console.error('Process files error:', error);
    }
}

// ─── Gallery ─────────────────────────────────────────────────────────────────

// Cached list of all items — kept in sync by refreshGallery, read by renderGallery
let _allGalleryItems = [];

// Renders only the gallery grid + status, without touching the search bar.
// Called by refreshGallery (full reload) and directly by the search input (filter-only).
// Map of batchKey -> card DOM element, kept alive across search-filter updates
let _galleryCards = new Map();

// Build (or rebuild) all cards from scratch and render them all visible.
// Called by refreshGallery after a real data change (import / delete / edit).
function buildGalleryCards(allItems) {
    galleryContainer.innerHTML = '';
    imageWrappers.clear();
    currentVisibleImage = null;
    _galleryCards.clear();

    // Apply current view mode classes
    galleryContainer.classList.toggle('gallery-list-mode',  galleryViewMode === 'list');
    galleryContainer.classList.toggle('gallery-grid2-mode', galleryViewMode === 'grid2');
    galleryContainer.classList.toggle('gallery-grid3-mode', galleryViewMode === 'grid3');

    if (!allItems.length) {
        statusMessage.textContent = 'No HDR images yet. Drop or upload PNG, AVIF, JXR, EXR, HDR, TIFF, or HEIC files.';
        return;
    }

    // In grid2/grid3 (game selected) merge all items into one card per game.
    // In list mode keep the original per-batch grouping.
    const _isGameGrouped = galleryViewMode === 'grid2' || galleryViewMode === 'grid3';
    const cardMap = new Map();
    for (const item of allItems) {
        const key = (_isGameGrouped && item.gameName)
            ? `game:${item.gameName}`
            : (item.batchId || `solo_${item.id}`);
        if (!cardMap.has(key)) cardMap.set(key, []);
        cardMap.get(key).push(item);
    }
    for (const [key, groupItems] of cardMap.entries()) {
        const card = createCollageCard(groupItems, _isGameGrouped, galleryViewMode);
        _galleryCards.set(key, card);
        galleryContainer.appendChild(card);
    }

    // statusMessage.textContent = `Found ${allItems.length} image${allItems.length === 1 ? '' : 's'}`;
}

// Detach/re-attach cards to match the current search query.
// Cards stay alive in _galleryCards (blob URLs preserved), only their DOM presence changes.
function renderGallery(allItems) {
    if (!allItems.length) return;

    // Keep the address bar in sync with the active game filter
    _syncGameUrl(gameSearchQuery.trim());

    const hasGame = !!gameSearchQuery.trim();

    // Sync view mode: no game → always list; game → use saved gameViewMode
    const targetMode = hasGame ? gameViewMode : 'list';
    if (galleryViewMode !== targetMode) {
        galleryViewMode = targetMode;
        galleryContainer.classList.toggle('gallery-list-mode',  galleryViewMode === 'list');
        galleryContainer.classList.toggle('gallery-grid2-mode', galleryViewMode === 'grid2');
        galleryContainer.classList.toggle('gallery-grid3-mode', galleryViewMode === 'grid3');
        // Cards need rebuilding when the grouping strategy changes
        buildGalleryCards(allItems);
    }

    // Show/hide view toggle
    const viewToggle = document.querySelector('.view-toggle');
    if (viewToggle) viewToggle.style.display = hasGame ? 'flex' : 'none';
    document.querySelectorAll('.view-toggle-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.view === galleryViewMode);
    });

    const filtered = applyFilters(allItems);

    // Update the count badge in the filter bar
    const _countEl = document.getElementById('filterBarCount');
    if (_countEl) {
        _countEl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>${filtered.length}`;
    }
    const _isGameGrouped = galleryViewMode === 'grid2' || galleryViewMode === 'grid3';
    const visibleKeys = new Set();
    for (const item of filtered) {
        const key = (_isGameGrouped && item.gameName)
            ? `game:${item.gameName}`
            : (item.batchId || `solo_${item.id}`);
        visibleKeys.add(key);
    }

    const fragment = document.createDocumentFragment();
    for (const [key, card] of _galleryCards.entries()) {
        if (visibleKeys.has(key)) {
            fragment.appendChild(card);
        } else {
            if (card.parentNode) card.parentNode.removeChild(card);
        }
    }
    galleryContainer.appendChild(fragment);

    galleryContainer.classList.toggle('gallery-filtered', hasGame);

    // Section header: game banner or "Latest Uploads"
    const sectionHeader = document.querySelector('.gallery-section-header');
    if (sectionHeader) {
        if (hasGame) {
            const exactGame = filtered[0]?.gameName || gameSearchQuery.trim();
            if (exactGame) _showGameBanner(exactGame);
        } else {
            sectionHeader.style.display = 'flex';
            sectionHeader.innerHTML = '<span class="gallery-section-title">Latest Uploads</span>';
        }
    }
}

async function refreshGallery() {
    try {
        const imageFiles = await getAllImageFiles();
        _allGalleryItems = imageFiles.slice().reverse();

        // Rebuild search bar with fresh game names (after import / delete / edit)
        const bar = document.getElementById('filterBar');
        if (bar) { bar.innerHTML = ''; delete bar.dataset.built; }
        buildFilterBar(_allGalleryItems);

        buildGalleryCards(_allGalleryItems);
        renderGallery(_allGalleryItems);
    } catch (error) {
        statusMessage.textContent = 'Error loading gallery. Please refresh the page.';
        console.error('Gallery refresh error:', error);
    }
}

// ─── Collage Card (gallery view) ─────────────────────────────────────────────

function createCollageCard(batchItems, isGameGrouped = false, viewMode = 'list') {
    const card = document.createElement('div');
    card.className = 'collage-card';

    // Header: left spacer | centered game name | HDR type badge
    const header = document.createElement('div');
    header.className = 'collage-header';

    // Left spacer (keeps title visually centered when badge is present)
    header.appendChild(document.createElement('div'));

    const titleEl = document.createElement('span');
    const _titleName = batchItems[0].gameName || 'Unknown Game';
    const _isUnknown = !batchItems[0].gameName;
    const _titleCount = batchItems.length;
    titleEl.className = _isUnknown ? 'collage-title' : 'collage-title collage-title-link';
    titleEl.textContent = _titleName;
    if (!_isUnknown) {
        titleEl.addEventListener('click', (e) => {
            e.stopPropagation();
            const input = document.getElementById('gallerySearchInput');
            const clearBtn = document.getElementById('gallerySearchClear');
            if (input) {
                gameSearchQuery = _titleName;
                input.value = _titleName;
                if (clearBtn) clearBtn.style.display = 'flex';
                renderGallery(_allGalleryItems);
                window.scrollTo({ top: 0, behavior: 'smooth' });
            }
        });
    }
    header.appendChild(titleEl);

    const _countBadge = document.createElement('span');
    _countBadge.className = 'collage-title-count-badge';
    _countBadge.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>${_titleCount}`;
    header.appendChild(_countBadge);

    card.appendChild(header);

    // Collage grid
    const grid = document.createElement('div');
    const n = batchItems.length;
    const _gameCols = viewMode === 'grid3' ? 3 : 2;
    grid.className = isGameGrouped ? `collage-grid collage-grid-game collage-grid-game-${_gameCols}` : `collage-grid collage-grid-${Math.min(n, 5)}`;
    card.appendChild(grid);

    batchItems.forEach((item, idx) => {
        // Use Cloudinary thumbnail URL for gallery display, fall back to full HDR URL
        const url = item.thumbUrl || item.hdrUrl;

        const cell = document.createElement('div');
        cell.className = 'collage-cell';
        if (!isGameGrouped && n >= 4 && idx === 0) cell.className += ' collage-cell-hero';

        const img = document.createElement('img');
        img.src = url;
        img.alt = item.name;
        img.className = 'collage-thumb';
        img.draggable = false;

        cell.appendChild(img);

        // Spoiler overlay — click label to reveal, remembered in localStorage
        if (item.spoiler) {
            const _spoilerKey = `spoiler-revealed:${item.id}`;
            const _alreadyRevealed = localStorage.getItem(_spoilerKey) === '1';
            cell.classList.add('collage-cell-spoiler');
            if (_alreadyRevealed) cell.classList.add('spoiler-revealed');
            const spoilerLabel = document.createElement('div');
            spoilerLabel.className = 'collage-spoiler-label';
            const spoilerSpan = document.createElement('span');
            spoilerSpan.textContent = 'SPOILER';
            spoilerLabel.appendChild(spoilerSpan);
            cell.appendChild(spoilerLabel);
            spoilerLabel.addEventListener('click', (e) => {
                e.stopPropagation();
                cell.classList.add('spoiler-revealed');
                localStorage.setItem(_spoilerKey, '1');
            });
        }

        // On hover, pre-decode the full HDR image so the bitmap is GPU-ready
        // before the user clicks — eliminates the visible decode stall in the lightbox.
        cell.addEventListener('mouseenter', () => {
            if (_decodePromises.has(item.hdrUrl)) return; // already started
            // Use a DOM-connected pool slot if the lightbox is open, otherwise a detached Image.
            // Pool slots are kept in the document so their bitmaps won't be evicted.
            const img = _lbDecodePool ? _poolPrefetch(item.hdrUrl) : (() => {
                const i = new Image(); i.src = item.hdrUrl; return i;
            })();
            if (!img) return;
            const _pt = performance.now();
            const p = img.decode().then(() => {
                console.log(`[lightbox] hover prefetch decode complete for "${item.name}"  +${(performance.now()-_pt).toFixed(1)}ms`);
            }).catch(() => {});
            _decodePromises.set(item.hdrUrl, p);
        });

        cell.addEventListener('click', () => {
            if (galleryViewMode === 'list') {
                // In list mode, the filmstrip should show ALL visible images across every batch
                const visibleItems = applyFilters(_allGalleryItems);
                const globalIdx = visibleItems.findIndex(it => it.id === item.id);
                openLightbox(visibleItems, Math.max(0, globalIdx));
            } else {
                openLightbox(batchItems, idx);
            }
        });
        grid.appendChild(cell);
    });

    header.appendChild(document.createElement('div'));

    return card;
}

// ─── Lightbox ─────────────────────────────────────────────────────────────────

let lightboxOpen = false;
let lightboxBatch = [];
let lightboxIndex = 0;
// _lbOpenTime is set by openLightbox and read by _startPixelDecode for timing logs
let _lbOpenTime = 0;
let lightboxPixelBuffers = new Map(); // imageId → buffer promise (HDR)
let lightboxSdrPixelBuffers = new Map(); // imageId → buffer promise (SDR)
let lightboxSdrActive = false;
let lightboxSdrToggleActive = false; // full SDR view (no slider)
let lightboxBlobUrls = new Map(); // imageId → { url, fullUrl, blob, sdrUrl }
// Hook exposed by openLightbox so toggleGlobalDetailsMode can trigger the idle timer
let _lightboxResetZoomIdleTimer = null;

// Shared decode promise cache — keyed by hdrUrl so hover prefetch and lightbox
// can share the same in-flight promise rather than racing each other.
const _decodePromises = new Map(); // hdrUrl → Promise<void>

// DOM-connected decode pool — keeps decoded bitmaps alive in the browser's live
// image cache so they can't be evicted before navigation.
// Detached Image objects are evicted under memory pressure; elements that are
// actually in the document are treated as "in use" and kept warm.
// The pool is sized to the full batch so decoded images are never evicted mid-session.
let _lbDecodePool = null;       // <div> appended to <body> while lightbox is open
let _lbPoolSlots  = new Map();  // url → dedicated <img> element for that image
const _prefetchedImages = new Map(); // url → pool <img> slot (dedup guard, mirrors _lbPoolSlots)

// Lazily start pixel decode for a single item on demand.
// Called when the analysis tool is enabled or when navigating while it's on.
function _startPixelDecode(item) {
    if (lightboxPixelBuffers.has(item.id)) return;
    const entry = lightboxBlobUrls.get(item.id);
    if (!entry) return;
    const _t0 = _lbOpenTime || performance.now();
    const p = new Promise(resolve => {
        console.log(`[lightbox] pixel worker: creating Worker  +${(performance.now()-_t0).toFixed(1)}ms`);
        const worker = new Worker('./pixel-worker.js', { type: 'module' });
        console.log(`[lightbox] pixel worker: starting fetch  +${(performance.now()-_t0).toFixed(1)}ms`);
        fetch(entry.fullUrl)
            .then(r => {
                console.log(`[lightbox] pixel worker: fetch headers received  +${(performance.now()-_t0).toFixed(1)}ms`);
                return r.arrayBuffer();
            })
            .then(ab => {
                console.log(`[lightbox] pixel worker: arrayBuffer ready (${(ab.byteLength/1024).toFixed(0)} KB), posting to worker  +${(performance.now()-_t0).toFixed(1)}ms`);
                worker.postMessage({ arrayBuffer: ab }, [ab]);
            });
        worker.onmessage = e => {
            console.log(`[lightbox] pixel worker: worker message received (${e.data.error ? 'error' : 'ok'})  +${(performance.now()-_t0).toFixed(1)}ms`);
            worker.terminate();
            resolve(e.data.error ? null : e.data);
        };
        worker.onerror = (err) => {
            console.warn(`[lightbox] pixel worker: worker error  +${(performance.now()-_t0).toFixed(1)}ms`, err);
            worker.terminate();
            resolve(null);
        };
    });
    lightboxPixelBuffers.set(item.id, p);
}

// Lazily start pixel decode for the SDR version of an item.
// The SDR file is 8-bit sRGB AVIF — decoded the same way by pixel-worker,
// but we store it separately so HDR and SDR buffers can coexist.
function _startSdrPixelDecode(item) {
    if (lightboxSdrPixelBuffers.has(item.id)) return;
    const entry = lightboxBlobUrls.get(item.id);
    if (!entry?.sdrUrl) return;
    const _t0 = _lbOpenTime || performance.now();
    const p = new Promise(resolve => {
        const worker = new Worker('./pixel-worker.js', { type: 'module' });
        fetch(entry.sdrUrl)
            .then(r => r.arrayBuffer())
            .then(ab => worker.postMessage({ arrayBuffer: ab }, [ab]));
        worker.onmessage = e => {
            worker.terminate();
            resolve(e.data.error ? null : e.data);
        };
        worker.onerror = () => { worker.terminate(); resolve(null); };
    });
    lightboxSdrPixelBuffers.set(item.id, p);
}

// sRGB EOTF: gamma-encoded [0,1] → linear, then scale to cd/m²
// SDR reference white = 203 cd/m² (IEC 61966-2-1 / HLG mapping)
function _srgbEotf(v) {
    const c = Math.max(0, Math.min(1, v));
    return (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)) * 203;
}

// Like getNitsAtPixel but treats the buffer as 8-bit sRGB (SDR tonemap output).
// The pixel worker scales 8-bit values to 16-bit big-endian, so we divide by 65535.
function _getNitsAtPixelSdr(pixelBuffer, imgX, imgY) {
    const { pixels, width, height, samplesPerPixel } = pixelBuffer;
    const px = Math.max(0, Math.min(width  - 1, Math.floor(imgX)));
    const py = Math.max(0, Math.min(height - 1, Math.floor(imgY)));
    const base = (py * width + px) * samplesPerPixel * 2;
    const r = _srgbEotf((pixels[base]     << 8 | pixels[base + 1]) / 65535);
    const g = _srgbEotf((pixels[base + 2] << 8 | pixels[base + 3]) / 65535);
    const b = _srgbEotf((pixels[base + 4] << 8 | pixels[base + 5]) / 65535);
    return {
        rNits: r, gNits: g, bNits: b,
        luminance: 0.2126 * r + 0.7152 * g + 0.0722 * b,
        gamut: 'SDR',
    };
}

// Assign a dedicated pool slot for a URL (one slot per URL, no eviction).
// Returns the pool <img> element so callers can call .decode() on it.
function _poolPrefetch(url) {
    if (_lbPoolSlots.has(url)) return _lbPoolSlots.get(url); // already has a slot
    if (!_lbDecodePool) return null; // pool not open yet
    const img = document.createElement('img');
    img.src = url;
    _lbDecodePool.appendChild(img);
    _lbPoolSlots.set(url, img);
    _prefetchedImages.set(url, img); // keep _prefetchedImages in sync for legacy references
    return img;
}

function openLightbox(batchItems, startIndex) {
    if (lightboxOpen) closeLightbox();

    const _lbT0 = performance.now();
    _lbOpenTime = _lbT0;
    console.log(`[lightbox] openLightbox() called  +0ms`);

    lightboxOpen = true;
    lightboxBatch = batchItems;
    lightboxIndex = startIndex;
    lightboxSdrActive = false;

    // Create a DOM-connected decode pool sized to the full batch.
    // Each image that gets decoded gets its own permanent <img> slot so the browser
    // can never evict its bitmap mid-session. Slots are added lazily by _poolPrefetch.
    _lbDecodePool = document.createElement('div');
    _lbDecodePool.style.cssText = 'position:fixed;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;z-index:-1;';
    _lbPoolSlots.clear();
    _prefetchedImages.clear();
    document.body.appendChild(_lbDecodePool);

    // Pre-create blob URLs for all images in the batch — reused on every navigation, no re-creation
    lightboxBlobUrls = new Map();
    lightboxBatch.forEach(item => {
        // Use Cloudinary URLs directly — no blob URL creation needed
        const fullUrl    = item.hdrUrl;
        const displayUrl = item.thumbUrl || item.hdrUrl;
        const sdrUrl     = item.sdrUrl   || null;
        lightboxBlobUrls.set(item.id, { url: displayUrl, fullUrl, blob: null, sdrUrl });
    });

    // Prefetch SDR images for the opening item and its neighbours so that
    // clicking the SDR slider / toggle shows the image instantly.
    _sdrPreloadCache.clear();
    _prefetchSdrImages(startIndex);

    // Eagerly decode the entire batch into the DOM pool.    // At ~1MB per AVIF image this is cheap on the network; decoded bitmaps are held
    // by their pool slots and never evicted mid-session.
    // Priority: opened image first, then outward alternating, then the rest.
    const _eagerOrder = [startIndex];
    for (let d = 1; d < lightboxBatch.length; d++) {
        if (startIndex + d < lightboxBatch.length) _eagerOrder.push(startIndex + d);
        if (startIndex - d >= 0)                   _eagerOrder.push(startIndex - d);
    }
    _eagerOrder.forEach((i, slot) => {
        const entry = lightboxBlobUrls.get(lightboxBatch[i]?.id);
        if (!entry?.fullUrl) return;
        // Stagger by 60ms per slot — current image gets a head start, rest trickle in
        // without saturating the codec thread or competing with the first paint.
        setTimeout(() => {
            const poolImg = _poolPrefetch(entry.fullUrl);
            if (!poolImg || _decodePromises.has(entry.fullUrl)) return;
            const _pt = performance.now();
            const promise = poolImg.decode().then(() => {
                console.log(`[lightbox] eager batch decode done: "${lightboxBatch[i].name}" (slot ${slot})  +${(performance.now()-_pt).toFixed(1)}ms`);
            }).catch(() => {});
            _decodePromises.set(entry.fullUrl, promise);
        }, slot * 60);
    });

    // Build overlay
    const overlay = document.createElement('div');
    overlay.id = 'lightbox-overlay';
    overlay.className = 'lightbox-overlay';

    // Track whether mousedown started inside interactive content (IMO panel, SDR slider, etc.)
    // so that a drag released outside doesn't fire a spurious close click.
    let _mousedownInsideContent = false;
    // Expose a setter so child handlers that call stopPropagation (e.g. IMO panel drag)
    // can still mark the flag — call overlay._setMousedownInsideContent(true) from there.
    overlay._setMousedownInsideContent = (val) => { _mousedownInsideContent = val; };
    overlay.addEventListener('mousedown', (e) => {
        // Consider any target that isn't the bare overlay/imageArea/filmstrip/toolbar as "inside content"
        _mousedownInsideContent = (
            e.target !== overlay &&
            e.target !== imageArea &&
            e.target !== filmstrip &&
            e.target !== toolbar &&
            e.target !== toolbarInner &&
            e.target !== toolbarLeft &&
            e.target !== toolbarRight
        );
    });

    // Close on backdrop click — fires when clicking empty black areas.
    // Nav buttons use pointer-events:none when inactive so we check by position too.
    overlay.addEventListener('click', (e) => {
        // If mousedown started inside interactive content (drag released outside), ignore
        if (_mousedownInsideContent) { _mousedownInsideContent = false; return; }
        _mousedownInsideContent = false;

        const inPrev = isInsideRect(e.clientX, e.clientY, prevBtn.getBoundingClientRect());
        const inNext = isInsideRect(e.clientX, e.clientY, nextBtn.getBoundingClientRect());
        if (inPrev || inNext) return;

        if (e.target === overlay || e.target === imageArea) {
            closeLightbox();
            return;
        }

        // Filmstrip: only close if click is outside the horizontal span of all thumbnails
        if (e.target === filmstrip) {
            const thumbs = filmstrip.querySelectorAll('.lightbox-filmstrip-item');
            if (thumbs.length === 0) { closeLightbox(); return; }
            const first = thumbs[0].getBoundingClientRect();
            const last  = thumbs[thumbs.length - 1].getBoundingClientRect();
            if (e.clientX < first.left || e.clientX > last.right) closeLightbox();
        }

        // Toolbar: clicking empty areas does nothing (only explicit close button closes)
    });

    // ── Main image area ──
    const imageArea = document.createElement('div');
    imageArea.className = 'lightbox-image-area';
    overlay.appendChild(imageArea);

    // Image wrapper (hosts zoom + nit-hunt + comparison slider + metadata overlay)
    const imageWrapper = document.createElement('div');
    imageWrapper.className = 'lightbox-image-wrapper';
    imageArea.appendChild(imageWrapper);

    // ── Image header overlay (tags + title above image) ──
    const imageHeader = document.createElement('div');
    imageHeader.className = 'lightbox-image-header';

    const imageHeaderTags = document.createElement('div');
    imageHeaderTags.className = 'lightbox-image-header-tags';

    const imageHeaderTitle = document.createElement('div');
    imageHeaderTitle.className = 'lightbox-image-header-title';

    // Helper — updates title text and link state whenever the image changes.
    function _setLightboxTitle(gameName) {
        const name = gameName || 'Unknown Game';
        imageHeaderTitle.textContent = name;
        if (gameName) {
            imageHeaderTitle.classList.add('lightbox-image-header-title--link');
            imageHeaderTitle.onclick = () => {
                closeLightbox();
                gameSearchQuery = gameName;
                const input    = document.getElementById('gallerySearchInput');
                const clearBtn = document.getElementById('gallerySearchClear');
                if (input)    input.value = gameName;
                if (clearBtn) clearBtn.style.display = 'flex';
                renderGallery(_allGalleryItems);
                window.scrollTo({ top: 0, behavior: 'smooth' });
            };
        } else {
            imageHeaderTitle.classList.remove('lightbox-image-header-title--link');
            imageHeaderTitle.onclick = null;
        }
    }

    _setLightboxTitle(lightboxBatch[startIndex].gameName);

    const imageHeaderSubtitle = document.createElement('div');
    imageHeaderSubtitle.className = 'lightbox-image-header-subtitle';
    const _initAdditionalInfo = lightboxBatch[startIndex].additionalInfo || '';
    imageHeaderSubtitle.textContent = _initAdditionalInfo;
    imageHeaderSubtitle.style.display = _initAdditionalInfo ? '' : 'none';

    const imageHeaderTitleWrap = document.createElement('div');
    imageHeaderTitleWrap.className = 'lightbox-image-header-title-wrap';
    imageHeaderTitleWrap.appendChild(imageHeaderTitle);
    imageHeaderTitleWrap.appendChild(imageHeaderSubtitle);

    imageHeader.appendChild(imageHeaderTags);
    imageHeader.appendChild(imageHeaderTitleWrap);
    const imageHeaderRight = document.createElement('div');
    imageHeader.appendChild(imageHeaderRight);
    imageWrapper.appendChild(imageHeader);

    const imgEl = document.createElement('img');
    imgEl.className = 'lightbox-image';
    const imgContainer = document.createElement('div');
    imgContainer.className = 'lightbox-image-container';
    imgContainer.appendChild(imgEl);
    imageWrapper.appendChild(imgContainer);

    // ── Toolbar ──
    const toolbar = document.createElement('div');
    toolbar.className = 'lightbox-toolbar';
    overlay.appendChild(toolbar);

    // Inner wrapper — constrains buttons to the same width as the image area
    const toolbarInner = document.createElement('div');
    toolbarInner.className = 'lightbox-toolbar-inner';
    toolbar.appendChild(toolbarInner);

    // Left side: view/analysis buttons
    const toolbarLeft = document.createElement('div');
    toolbarLeft.className = 'lightbox-toolbar-left';
    toolbarInner.appendChild(toolbarLeft);

    // Right side: edit/manage buttons
    const toolbarRight = document.createElement('div');
    toolbarRight.className = 'lightbox-toolbar-right';
    toolbarInner.appendChild(toolbarRight);

    // ── Copy Link button (right side) ──
    const copyLinkBtn = document.createElement('button');
    copyLinkBtn.className = 'button-secondary lightbox-copy-link-btn';
    copyLinkBtn.title = 'Copy link';
    copyLinkBtn.dataset.tooltip = 'Copy Link';
    copyLinkBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg><span class="btn-label"> Copy Link</span>';
    copyLinkBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const item = lightboxBatch[lightboxIndex];
        if (!item) return;
        const url = new URL(location.href);
        url.search = '';
        url.searchParams.set('img', item.id);
        navigator.clipboard.writeText(url.toString()).then(() => {
            copyLinkBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg><span class="btn-label"> Copied!</span>';
            copyLinkBtn.classList.add('lightbox-copy-link-btn--copied');
            setTimeout(() => {
                copyLinkBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg><span class="btn-label"> Copy Link</span>';
                copyLinkBtn.classList.remove('lightbox-copy-link-btn--copied');
            }, 2000);
        }).catch(() => {
            const ta = document.createElement('textarea');
            ta.value = url.toString();
            ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
        });
    });
    toolbarRight.appendChild(copyLinkBtn);

    // ── Filmstrip ──
    const filmstrip = document.createElement('div');
    filmstrip.className = 'lightbox-filmstrip';
    overlay.appendChild(filmstrip);

    // ── Filmstrip mousewheel horizontal scroll (smooth) ──
    let _fsTarget = 0;
    let _fsRaf = null;

    function _fsAnimateLerp() {
        const diff = _fsTarget - filmstrip.scrollLeft;
        if (Math.abs(diff) < 0.5) {
            filmstrip.scrollLeft = _fsTarget;
            _fsRaf = null;
            return;
        }
        filmstrip.scrollLeft += diff * 0.18;
        _fsRaf = requestAnimationFrame(_fsAnimateLerp);
    }

    filmstrip.addEventListener('wheel', (e) => {
        e.preventDefault();
        const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
        const maxScroll = filmstrip.scrollWidth - filmstrip.clientWidth;
        _fsTarget = Math.max(0, Math.min(maxScroll, _fsTarget + delta));
        if (!_fsRaf) _fsRaf = requestAnimationFrame(_fsAnimateLerp);
    }, { passive: false });

    // ── Nav arrows ──
    const prevBtn = document.createElement('button');
    prevBtn.className = 'lightbox-nav lightbox-nav-prev';
    prevBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
    prevBtn.addEventListener('click', () => navigateLightbox(-1));
    overlay.appendChild(prevBtn);

    const nextBtn = document.createElement('button');
    nextBtn.className = 'lightbox-nav lightbox-nav-next';
    nextBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
    nextBtn.addEventListener('click', () => navigateLightbox(1));
    overlay.appendChild(nextBtn);

    // ── Close button ──
    const closeBtn = document.createElement('button');
    closeBtn.className = 'lightbox-close';
    closeBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    closeBtn.addEventListener('click', closeLightbox);
    overlay.appendChild(closeBtn);

    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';

    // Trigger fade-in only once the first image is decoded — so image and overlay fade in together
    const firstEntry = lightboxBlobUrls.get(lightboxBatch[startIndex].id);
    const preloader = new Image();
    preloader.src = firstEntry.fullUrl;
    const triggerFade = () => requestAnimationFrame(() => { overlay.style.opacity = '1'; });
    preloader.decode().then(triggerFade).catch(triggerFade); // catch: fade in anyway if decode fails

    // ── LEFT side: Analysis Tool, SDR Slider, SDR Toggle, Save ──
    const detailsBtn = document.createElement('button');
    detailsBtn.className = 'button-secondary detail-button' + (globalDetailsEnabled ? ' button-active' : '');
    detailsBtn.innerHTML = globalDetailsEnabled
        ? '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg><span class="btn-label"> <u>A</u>nalysis Tool</span>'
        : '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" opacity="0.3"></path><circle cx="12" cy="12" r="3"></circle></svg><span class="btn-label"> <u>A</u>nalysis Tool</span>';
    detailsBtn.title = 'Analysis Tool (A)';
    detailsBtn.dataset.tooltip = 'Analysis Tool (A)';
    detailsBtn.onclick = () => toggleGlobalDetailsMode();
    toolbarLeft.appendChild(detailsBtn);

    const sep0 = document.createElement('div');
    sep0.className = 'toolbar-separator';
    toolbarLeft.appendChild(sep0);

    const compareBtn = document.createElement('button');
    compareBtn.className = 'button-secondary';
    compareBtn.title = 'SDR Slider (S)';
    compareBtn.dataset.tooltip = 'SDR Slider (S)';
    compareBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12H3"/><path d="m7 8-4 4 4 4"/><path d="m17 8 4 4-4 4"/></svg><span class="btn-label"> <u>S</u>DR Slider</span>';
    toolbarLeft.appendChild(compareBtn);

    const sdrToggleBtn = document.createElement('div');
    sdrToggleBtn.className = 'sdr-pill-toggle';
    sdrToggleBtn.title = 'SDR Toggle (D)';
    sdrToggleBtn.dataset.tooltip = 'SDR Toggle (D)';
    sdrToggleBtn.innerHTML = '<span class="sdr-pill-seg" data-seg="sdr">SDR</span><span class="sdr-pill-seg sdr-pill-seg--active" data-seg="hdr">HDR</span>';
    toolbarLeft.appendChild(sdrToggleBtn);

    const sep1 = document.createElement('div');
    sep1.className = 'toolbar-separator';
    toolbarLeft.appendChild(sep1);


    // ── RIGHT side: Edit, Copy Link | separator | Delete, Delete All ──
    const editBtn = document.createElement('button');
    editBtn.className = 'button-secondary';
    editBtn.title = 'Edit details';
    editBtn.dataset.tooltip = 'Edit';
    editBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg><span class="btn-label"> Edit</span>';
    toolbarRight.insertBefore(editBtn, copyLinkBtn);

    const sep2 = document.createElement('div');
    sep2.className = 'toolbar-separator';
    toolbarRight.appendChild(sep2);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'button-danger';
    deleteBtn.title = 'Delete image';
    deleteBtn.dataset.tooltip = 'Delete';
    deleteBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg><span class="btn-label"> Delete</span>';
    toolbarRight.appendChild(deleteBtn);

    // ── Hold-to-zoom ──
    let isZooming = false;
    let currentZoomScale = CONFIG.zoomScale;

    // ── Scroll-to-zoom (velocity + friction momentum) ──
    // Uses translate(tx, ty) scale(S) with transformOrigin: 0 0 — the standard
    // Photoshop/Figma model. State: (zoomTx, zoomTy, scrollZoomCurrent).
    // On each scroll event: tx_new = cx - (cx - tx) * (S_new / S_old)
    let scrollZoomCurrent = 1;
    let scrollZoomVelocity = 0;
    let zoomTx = 0, zoomTy = 0;         // translate in viewport-px
    let zoomCursorX = 0, zoomCursorY = 0; // cursor position at last scroll event (px)
    let scrollZoomRaf = null;
    const SCROLL_FRICTION = 0.92;
    let naturalRect = null; // bounding rect of the image before entering zoom (for FLIP animations)

    // Pan drag state
    let isPanning = false;
    let panStartX = 0, panStartY = 0;
    let panStartTx = 0, panStartTy = 0;
    // Pan momentum
    let panVelX = 0, panVelY = 0;
    let panLastX = 0, panLastY = 0;
    let panLastTime = 0;
    let panMomentumRaf = null;
    const PAN_FRICTION = 0.88;

    // Snap gate
    const SNAP_GATE_MS    = 300;
    const SNAP_GATE_TICKS = 2;
    let snapGateActive  = false;
    let snapGateExpiry  = 0;
    let snapGateTicks   = 0;

    function applyTransform() {
        imgEl.style.transformOrigin = '0 0';
        imgEl.style.transform = `translate(${zoomTx}px, ${zoomTy}px) scale(${scrollZoomCurrent})`;
    }

    // Recompute tx/ty so the point (cx, cy) in viewport-px stays fixed
    // when scale changes from oldScale to scrollZoomCurrent.
    function anchorZoomAtCursor(cx, cy, oldScale) {
        zoomTx = cx - (cx - zoomTx) * (scrollZoomCurrent / oldScale);
        zoomTy = cy - (cy - zoomTy) * (scrollZoomCurrent / oldScale);
    }

    // Returns the rendered content rect of the image when position:fixed; width:100vw; height:100vh; object-fit:contain
    function _getFitRect() {
        const natW = imgEl.naturalWidth  || 1;
        const natH = imgEl.naturalHeight || 1;
        // Use clientWidth/clientHeight (excludes scrollbars and mobile browser chrome)
        // rather than window.innerWidth/Height which can include hidden chrome area,
        // causing the 1× fit rect to be taller than the actual visible viewport.
        const vw = document.documentElement.clientWidth;
        const vh = document.documentElement.clientHeight;
        const s  = Math.min(vw / natW, vh / natH);
        const fw = natW * s, fh = natH * s;
        return { left: (vw - fw) / 2, top: (vh - fh) / 2, width: fw, height: fh };
    }

    // Computes translate+scale (transformOrigin:0 0) so that the fixed fullscreen image
    // visually occupies nr (the natural flexbox rect), used for FLIP enter/exit animations.
    function _flipTransform(nr) {
        const f = _getFitRect();
        const s = nr.width / f.width;
        return { tx: nr.left - f.left * s, ty: nr.top - f.top * s, s };
    }

    function scrollZoomTick() {
        imgEl.style.transition = 'none';
        scrollZoomVelocity *= SCROLL_FRICTION;
        const next = scrollZoomCurrent + scrollZoomVelocity;

        if (next <= 1) {
            scrollZoomCurrent = 1;
            scrollZoomVelocity = 0;
            scrollZoomRaf = null;
            zoomTx = 0; zoomTy = 0;
            applyTransform();
            zoomTooltip.innerHTML = `<svg class="zoom-icon" xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>1.0× zoom`;
            return;
        }

        const oldScale = scrollZoomCurrent;
        scrollZoomCurrent = Math.min(10, next);
        if (scrollZoomCurrent >= 10) scrollZoomVelocity = 0;
        anchorZoomAtCursor(zoomCursorX, zoomCursorY, oldScale);

        if (Math.abs(scrollZoomVelocity) < 0.0002) {
            scrollZoomVelocity = 0;
            scrollZoomRaf = null;
            if (scrollZoomCurrent < 1.05) {
                scrollZoomCurrent = 1;
                zoomTx = 0; zoomTy = 0;
                applyTransform();
                imgEl.style.cursor = 'zoom-out';
                zoomTooltip.innerHTML = `<svg class="zoom-icon" xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>1.0× zoom`;
                return;
            }
            applyTransform();
            imgEl.style.cursor = 'grab';
            zoomTooltip.innerHTML = `<svg class="zoom-icon" xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>${scrollZoomCurrent.toFixed(1)}× zoom`;
            return;
        }
        applyTransform();
        zoomTooltip.innerHTML = `<svg class="zoom-icon" xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>${scrollZoomCurrent.toFixed(1)}× zoom`;
        scrollZoomRaf = requestAnimationFrame(scrollZoomTick);
    }

    function startScrollZoomRaf() {
        imgEl.style.transition = 'none';
        imgEl.style.cursor = scrollZoomCurrent > 1 ? 'grab' : 'zoom-out';
        imgEl.classList.add('lightbox-image-zooming');
        if (lbMouseInside) zoomTooltip.style.display = 'block';
        _resetZoomIdleTimer();
        if (!scrollZoomRaf) scrollZoomRaf = requestAnimationFrame(scrollZoomTick);
    }

    // Animate zoom out: FLIP back to natural position, then restore normal layout
    function startZoomExit() {
        if (scrollZoomRaf) { cancelAnimationFrame(scrollZoomRaf); scrollZoomRaf = null; }
        if (panMomentumRaf) { cancelAnimationFrame(panMomentumRaf); panMomentumRaf = null; }
        scrollZoomVelocity = 0;
        const DURATION = 200;
        imgEl.style.cursor = globalDetailsEnabled ? '' : 'zoom-in';
        zoomTooltip.style.display = 'none';
        _clearZoomIdleTimer();

        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            scrollZoomCurrent = 1;
            zoomTx = 0; zoomTy = 0;
            naturalRect = null;
            imgEl.classList.remove('lightbox-image-zooming');
            imgEl.style.transition = '';
            imgEl.style.transform = '';
            imgEl.style.transformOrigin = '';
        };

        if (naturalRect) {
            // FLIP exit: animate current transform → natural image position, then remove class
            const { tx, ty, s } = _flipTransform(naturalRect);
            imgEl.style.transition = `transform ${DURATION}ms cubic-bezier(0.25, 0, 0, 1)`;
            imgEl.style.transformOrigin = '0 0';
            imgEl.style.transform = `translate(${tx}px,${ty}px) scale(${s})`;
            imgEl.addEventListener('transitionend', function h() { finish(); imgEl.removeEventListener('transitionend', h); });
            setTimeout(finish, DURATION + 50);
        } else {
            // Fallback (no naturalRect): snap out instantly
            finish();
        }
    }


    function applyZoom(clientX, clientY, animate) {
        zoomCursorX = clientX;
        zoomCursorY = clientY;
        imgEl.style.transition = animate ? `transform ${CONFIG.zoomInMs}ms cubic-bezier(0.2, 0, 0, 1)` : 'none';
        imgEl.style.cursor = 'zoom-out';
        imgEl.classList.add('lightbox-image-zooming');
        // For hold-zoom, anchor at cursor using currentZoomScale
        const ox = clientX, oy = clientY;
        const tx = ox - ox * currentZoomScale;
        const ty = oy - oy * currentZoomScale;
        imgEl.style.transformOrigin = '0 0';
        imgEl.style.transform = `translate(${tx}px, ${ty}px) scale(${currentZoomScale})`;
        zoomTooltip.innerHTML = `<svg class="zoom-icon" xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>${currentZoomScale.toFixed(1)}× zoom`;
        if (lbMouseInside) zoomTooltip.style.display = 'block';
    }

    function releaseZoom() {
        isZooming = false;
        scrollZoomCurrent = currentZoomScale;
        scrollZoomVelocity = 0;
        currentZoomScale = CONFIG.zoomScale;
        // Sync tx/ty from the hold-zoom position so scroll-zoom picks up seamlessly
        zoomTx = zoomCursorX - zoomCursorX * scrollZoomCurrent;
        zoomTy = zoomCursorY - zoomCursorY * scrollZoomCurrent;
        imgEl.style.transition = 'none';
        applyTransform();
        imgEl.style.cursor = 'zoom-out';
        imgEl.classList.add('lightbox-image-zooming');
        zoomTooltip.innerHTML = `<svg class="zoom-icon" xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>${scrollZoomCurrent.toFixed(1)}× zoom`;
        if (lbMouseInside) zoomTooltip.style.display = 'block';
        _resetZoomIdleTimer();
    }

    function startPanMomentum() {
        if (panMomentumRaf) { cancelAnimationFrame(panMomentumRaf); panMomentumRaf = null; }
        // Scale px/ms velocity to px/frame (~16ms)
        let vx = panVelX * 16;
        let vy = panVelY * 16;
        function tick() {
            vx *= PAN_FRICTION;
            vy *= PAN_FRICTION;
            if (Math.abs(vx) < 0.1 && Math.abs(vy) < 0.1) { panMomentumRaf = null; return; }
            zoomTx += vx;
            zoomTy += vy;
            applyTransform();
            panMomentumRaf = requestAnimationFrame(tick);
        }
        panMomentumRaf = requestAnimationFrame(tick);
    }

    imgEl.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (imageWrapper.querySelector('.inline-comparison-slider')) return;
        if (imgEl.classList.contains('lightbox-image-zooming')) {
            if (scrollZoomCurrent > 1) {
                // Cancel any ongoing pan momentum
                if (panMomentumRaf) { cancelAnimationFrame(panMomentumRaf); panMomentumRaf = null; }
                if (scrollZoomRaf) { cancelAnimationFrame(scrollZoomRaf); scrollZoomRaf = null; }
                scrollZoomVelocity = 0;
                isPanning = true;
                panStartX = e.clientX; panStartY = e.clientY;
                panStartTx = zoomTx;   panStartTy = zoomTy;
                panVelX = 0; panVelY = 0;
                panLastX = e.clientX; panLastY = e.clientY; panLastTime = performance.now();
                imgEl.style.cursor = 'grabbing';
                e.preventDefault();
            } else if (!globalDetailsEnabled) {
                // At 1x — click exits (only outside analysis mode)
                scrollZoomVelocity = 0;
                startZoomExit();
                e.preventDefault();
            }
            return;
        }
        if (globalDetailsEnabled) return;
        // Otherwise enter zoom mode — FLIP enter animation
        isZooming = true;
        currentZoomScale = 1;
        zoomCursorX = e.clientX; zoomCursorY = e.clientY;
        // Reset scroll-zoom state — ensures 1× lands centered with no stale pan offsets,
        // matching the clean state that wheel-entry sets explicitly before entering.
        scrollZoomCurrent = 1;
        zoomTx = 0; zoomTy = 0;
        if (scrollZoomRaf)  { cancelAnimationFrame(scrollZoomRaf);  scrollZoomRaf  = null; }
        if (panMomentumRaf) { cancelAnimationFrame(panMomentumRaf); panMomentumRaf = null; }
        scrollZoomVelocity = 0;

        // Capture natural rect, switch to fixed, apply FLIP inverse instantly
        naturalRect = imgEl.getBoundingClientRect();
        const { tx: ftx, ty: fty, s: fs } = _flipTransform(naturalRect);
        imgEl.classList.add('lightbox-image-zooming');
        imgEl.style.cursor = 'zoom-out';
        imgEl.style.transition = 'none';
        imgEl.style.transformOrigin = '0 0';
        imgEl.style.transform = `translate(${ftx}px,${fty}px) scale(${fs})`;
        zoomTooltip.innerHTML = `<svg class="zoom-icon" xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>1.0× zoom`;
        if (lbMouseInside) zoomTooltip.style.display = 'block';

        // Animate to 1× centered — translate(0,0) scale(1) is identical to the wheel-entry
        // target and guarantees the image fits inside the visible viewport at every screen size.
        // Double-rAF: first frame commits the FLIP inverse, second starts the transition.
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                imgEl.style.transition = `transform 180ms cubic-bezier(0.2, 0, 0, 1)`;
                imgEl.style.transform = 'translate(0px,0px) scale(1)';
                setTimeout(() => {
                    imgEl.style.transition = 'none';
                    startScrollZoomRaf();
                }, 190);
            });
        });
        e.preventDefault();
    });
    imgEl.addEventListener('mousemove', (e) => {
        if (isZooming) { applyZoom(e.clientX, e.clientY, false); return; }
        if (isPanning) {
            zoomTx = panStartTx + (e.clientX - panStartX);
            zoomTy = panStartTy + (e.clientY - panStartY);
            imgEl.style.transition = 'none';
            applyTransform();
            _resetZoomIdleTimer();
            // Track velocity for momentum
            const now = performance.now();
            const dt = now - panLastTime;
            if (dt > 0 && dt < 64) { // ignore big gaps (e.g. tab switch)
                panVelX = (e.clientX - panLastX) / dt;
                panVelY = (e.clientY - panLastY) / dt;
            }
            panLastX = e.clientX; panLastY = e.clientY; panLastTime = now;
            return;
        }
        // Update grab cursor based on zoom level when hovering
        if (imgEl.classList.contains('lightbox-image-zooming') && !globalDetailsEnabled) {
            imgEl.style.cursor = scrollZoomCurrent > 1 ? 'grab' : 'zoom-out';
        }
    });
    imgEl.addEventListener('wheel', (e) => {
        e.preventDefault();
        if (isZooming) {
            // Hold-to-zoom: adjust scale while holding mouse button
            const oldScale = currentZoomScale;
            currentZoomScale = Math.max(1, Math.min(10, currentZoomScale + (e.deltaY > 0 ? -0.5 : 0.5)));
            applyZoom(e.clientX, e.clientY, false);
            zoomTooltip.innerHTML = `<svg class="zoom-icon" xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>${currentZoomScale.toFixed(1)}× zoom`;
        } else {
            // Scroll-to-zoom: inject velocity, RAF loop coasts to stop
            const step = e.deltaY > 0 ? -0.1 : 0.1;
            // Scrolling down at 1x — exit zoom with transition
            if (step < 0 && scrollZoomCurrent <= 1 && imgEl.classList.contains('lightbox-image-zooming')) {
                scrollZoomVelocity = 0;
                snapGateActive = false;
                startZoomExit();
                return;
            }
            // Only zoom in if already in zoom mode or scrolling up (entering zoom)
            if (step < 0 && !imgEl.classList.contains('lightbox-image-zooming')) return;

            // Capture cursor for anchor calculation
            zoomCursorX = e.clientX;
            zoomCursorY = e.clientY;

            // On first scroll-up that enters zoom — FLIP enter animation
            if (!imgEl.classList.contains('lightbox-image-zooming')) {
                snapGateActive = true;
                snapGateExpiry = performance.now() + SNAP_GATE_MS;
                snapGateTicks  = 0;
                zoomTx = 0; zoomTy = 0; scrollZoomCurrent = 1;

                // Capture natural rect, switch to fixed layout, apply FLIP inverse instantly
                naturalRect = imgEl.getBoundingClientRect();
                const { tx: ftx, ty: fty, s: fs } = _flipTransform(naturalRect);
                imgEl.classList.add('lightbox-image-zooming');
                imgEl.style.cursor = 'zoom-out';
                if (lbMouseInside) zoomTooltip.style.display = 'block';
                imgEl.style.transition = 'none';
                imgEl.style.transformOrigin = '0 0';
                imgEl.style.transform = `translate(${ftx}px,${fty}px) scale(${fs})`;

                // Double-rAF: first frame commits the FLIP inverse, second starts the transition
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        imgEl.style.transition = `transform 180ms cubic-bezier(0.2, 0, 0, 1)`;
                        imgEl.style.transform = 'translate(0px,0px) scale(1)';
                        setTimeout(() => {
                            imgEl.style.transition = 'none';
                            startScrollZoomRaf();
                        }, 190);
                    });
                });
                return;
            }

            // While gate is active, eat ticks until user clearly intends to zoom past 1x
            if (snapGateActive) {
                if (performance.now() > snapGateExpiry) {
                    snapGateActive = false;
                } else if (step > 0) {
                    snapGateTicks++;
                    if (snapGateTicks < SNAP_GATE_TICKS) return;
                    snapGateActive = false;
                }
            }

            scrollZoomVelocity += step;
            startScrollZoomRaf();
        }
    }, { passive: false });

    const _mouseUpLightbox = (e) => {
        if (e.button === 0 && isZooming) { releaseZoom(); return; }
        if (e.button === 0 && isPanning) {
            isPanning = false;
            const dist = Math.hypot(e.clientX - panStartX, e.clientY - panStartY);
            if (dist < 5) {
                startZoomExit();
            } else {
                imgEl.style.cursor = scrollZoomCurrent > 1 ? 'grab' : 'zoom-out';
                startPanMomentum();
            }
        }
    };
    document.addEventListener('mouseup', _mouseUpLightbox);

    // ── Per-pixel nit-hunt ──
    let lbPixelBuffer = null;
    let lbSdrMode = false;  // true when SDR toggle is active and we use the SDR pixel buffer
    let lbRafPending = false;
    let lbLastPixelX = -1, lbLastPixelY = -1;

    let lbMouseInside = false;

    // ── Zoom-aware cursor → pixel coordinate mapping ──
    // Invert transform: transformOrigin:0 0, translate(zoomTx,zoomTy) scale(S)
    // viewport point P → pre-transform point: P_pre = (P - translate) / S
    function cursorToPixel(clientX, clientY, buf) {
        const natW = imgEl.naturalWidth  || buf.width;
        const natH = imgEl.naturalHeight || buf.height;

        if (imgEl.classList.contains('lightbox-image-zooming')) {
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const fitScale = Math.min(vw / natW, vh / natH);
            const fitW = natW * fitScale;
            const fitH = natH * fitScale;
            const fitLeft = (vw - fitW) / 2;
            const fitTop  = (vh - fitH) / 2;

            const S = scrollZoomCurrent;
            const preX = (clientX - zoomTx) / S;
            const preY = (clientY - zoomTy) / S;

            return {
                imgX: Math.max(0, Math.min(natW - 1, Math.floor((preX - fitLeft) * (natW / fitW)))),
                imgY: Math.max(0, Math.min(natH - 1, Math.floor((preY - fitTop)  * (natH / fitH)))),
            };
        } else {
            const rect = imgEl.getBoundingClientRect();
            return {
                imgX: Math.max(0, Math.min(natW - 1, Math.floor((clientX - rect.left) * (natW / rect.width)))),
                imgY: Math.max(0, Math.min(natH - 1, Math.floor((clientY - rect.top)  * (natH / rect.height)))),
            };
        }
    }

    // ── Idle cursor/tooltip hide in zoom mode ──
    // After 2s without mouse movement while zoomed (and NOT in analysis mode),
    // hide the cursor and the zoom tooltip. Any movement restores them.
    let _zoomIdleTimer = null;

    function _clearZoomIdleTimer() {
        if (_zoomIdleTimer) { clearTimeout(_zoomIdleTimer); _zoomIdleTimer = null; }
    }

    function _showZoomCursor() {
        imgEl.style.cursor = 'zoom-out';
        if (imgEl.classList.contains('lightbox-image-zooming')) {
            zoomTooltip.style.display = 'block';
        }
    }

    function _hideZoomCursor() {
        imgEl.style.cursor = 'none';
        zoomTooltip.style.display = 'none';
    }

    function _resetZoomIdleTimer() {
        // Only active in zoom mode and NOT in analysis mode
        if (!imgEl.classList.contains('lightbox-image-zooming') || globalDetailsEnabled) return;
        _clearZoomIdleTimer();
        _showZoomCursor();
        _zoomIdleTimer = setTimeout(() => {
            if (imgEl.classList.contains('lightbox-image-zooming') && !globalDetailsEnabled && lbMouseInside) {
                _hideZoomCursor();
            }
        }, 1000);
    }
    _lightboxResetZoomIdleTimer = _resetZoomIdleTimer;

    imgEl.addEventListener('mouseenter', async () => {
        lbMouseInside = true;
        // Restore zoom tooltip if we're currently in zoom mode
        if (imgEl.classList.contains('lightbox-image-zooming')) {
            if (globalDetailsEnabled) {
                _showZoomCursor();
            } else {
                _resetZoomIdleTimer();
            }
        }
        if (!imageWrapper.querySelector('.inline-comparison-slider')) {
            if (globalDetailsEnabled) {
                imgEl.classList.add('cursor-nit-hunt');
                imgContainer.classList.add('cursor-nit-hunt');
            } else {
                imgEl.classList.remove('cursor-nit-hunt');
                imgContainer.classList.remove('cursor-nit-hunt');
            }
        }
        if (!globalDetailsEnabled) return;
        if (lightboxSdrActive) return;  // slider mode — nit tool not usable while slider is open
        const _curItem = lightboxBatch[lightboxIndex];
        if (!lbPixelBuffer) {
            const bufPromise = lbSdrMode
                ? lightboxSdrPixelBuffers.get(_curItem.id)
                : lightboxPixelBuffers.get(_curItem.id);
            if (bufPromise) {
                nitTooltip.style.display = 'block';
                nitTooltip.innerHTML = _NIT_LOADING_HTML;
                lbPixelBuffer = await bufPromise;
            }
        }
        if (!lbPixelBuffer || !lbMouseInside || !globalDetailsEnabled) return;
        nitTooltip.style.display = 'block';
        const { imgX, imgY } = cursorToPixel(lastCursorX, lastCursorY, lbPixelBuffer);
        lbLastPixelX = imgX; lbLastPixelY = imgY;
        const _nitResult = lbSdrMode
            ? _getNitsAtPixelSdr(lbPixelBuffer, imgX, imgY)
            : getNitsAtPixel(lbPixelBuffer, imgX, imgY);
        const { rNits, gNits, bNits, luminance, gamut } = _nitResult;
        nitTooltip.innerHTML = _nitTooltipHTML(rNits, gNits, bNits, luminance, gamut);
    });
    imgEl.addEventListener('mouseleave', () => {
        lbMouseInside = false;
        _clearZoomIdleTimer();
        // Restore cursor style so it's normal outside the image
        imgEl.style.cursor = '';
        nitTooltip.style.display = 'none';
        zoomTooltip.style.display = 'none';
        lbLastPixelX = -1; lbLastPixelY = -1;
    });
    imgEl.addEventListener('mousemove', (e) => {
        // Reset idle timer on any movement in zoom mode (not analysis mode)
        _resetZoomIdleTimer();
        if (!lbPixelBuffer || !globalDetailsEnabled) return;
        if (lightboxSdrActive) return;  // slider mode blocks nit tool
        lbRafPending = true;
        requestAnimationFrame(() => {
            lbRafPending = false;
            const { imgX, imgY } = cursorToPixel(e.clientX, e.clientY, lbPixelBuffer);
            if (imgX === lbLastPixelX && imgY === lbLastPixelY) return;
            lbLastPixelX = imgX; lbLastPixelY = imgY;
            const _nitResult = lbSdrMode
                ? _getNitsAtPixelSdr(lbPixelBuffer, imgX, imgY)
                : getNitsAtPixel(lbPixelBuffer, imgX, imgY);
            const { rNits, gNits, bNits, luminance, gamut } = _nitResult;
            nitTooltip.innerHTML = _nitTooltipHTML(rNits, gNits, bNits, luminance, gamut);
        });
    });

    // ── Touch: swipe navigation, pinch-to-zoom, single-finger pan ──────────────
    let _touchStartX = 0, _touchStartY = 0, _touchStartTime = 0;
    let _touchNavActive = false, _touchNavDirLocked = false, _touchNavDx = 0;
    let _touchPinchActive = false, _touchPinchStartDist = 0, _touchPinchStartScale = 1;
    let _touchPanActive = false;

    const _t2Dist = (a, b) => Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
    const _t2Mid  = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });

    imageArea.addEventListener('touchstart', (e) => {
        // Don't interfere with SDR slider drag or metadata panel drag
        if (e.target.closest('.inline-comparison-slider') || e.target.closest('.imo-panel')) return;

        const tt = e.touches;
        if (tt.length === 2) {
            _touchPinchActive     = true;
            _touchNavActive       = false;
            _touchPanActive       = false;
            isPanning             = false;
            _touchPinchStartDist  = _t2Dist(tt[0], tt[1]);
            _touchPinchStartScale = scrollZoomCurrent > 1 ? scrollZoomCurrent : 1;
            if (panMomentumRaf) { cancelAnimationFrame(panMomentumRaf); panMomentumRaf = null; }
            if (scrollZoomRaf)  { cancelAnimationFrame(scrollZoomRaf);  scrollZoomRaf  = null; }
            scrollZoomVelocity = 0;
            // Enter zoom mode if not already active
            if (!imgEl.classList.contains('lightbox-image-zooming')) {
                naturalRect = imgEl.getBoundingClientRect();
                scrollZoomCurrent = 1; zoomTx = 0; zoomTy = 0;
                _touchPinchStartScale = 1;
                imgEl.classList.add('lightbox-image-zooming');
                imgEl.style.transition      = 'none';
                imgEl.style.transformOrigin = '0 0';
                imgEl.style.transform       = 'translate(0px,0px) scale(1)';
            }
            e.preventDefault();
            return;
        }
        if (tt.length === 1) {
            const t = tt[0];
            _touchStartX       = t.clientX;
            _touchStartY       = t.clientY;
            _touchStartTime    = Date.now();
            _touchNavActive    = false;
            _touchNavDirLocked = false;
            _touchNavDx        = 0;
            _touchPanActive    = false;

            if (imgEl.classList.contains('lightbox-image-zooming') && scrollZoomCurrent > 1) {
                // Single-finger pan while zoomed
                _touchPanActive = true;
                isPanning       = true;
                panStartX = t.clientX; panStartY = t.clientY;
                panStartTx = zoomTx;   panStartTy = zoomTy;
                panVelX = 0; panVelY = 0;
                panLastX = t.clientX; panLastY = t.clientY; panLastTime = performance.now();
                if (panMomentumRaf) { cancelAnimationFrame(panMomentumRaf); panMomentumRaf = null; }
                if (scrollZoomRaf)  { cancelAnimationFrame(scrollZoomRaf);  scrollZoomRaf  = null; }
                scrollZoomVelocity = 0;
                e.preventDefault();
            } else {
                // Potential horizontal swipe for image navigation
                _touchNavActive = true;
            }
        }
    }, { passive: false });

    imageArea.addEventListener('touchmove', (e) => {
        const tt = e.touches;
        if (_touchPinchActive && tt.length === 2) {
            const newDist  = _t2Dist(tt[0], tt[1]);
            const mid      = _t2Mid(tt[0], tt[1]);
            const newScale = Math.max(1, Math.min(10, _touchPinchStartScale * (newDist / _touchPinchStartDist)));
            const oldScale = scrollZoomCurrent;
            scrollZoomCurrent = newScale;
            anchorZoomAtCursor(mid.x, mid.y, oldScale);
            imgEl.style.transition = 'none';
            applyTransform();
            e.preventDefault();
            return;
        }
        if (tt.length !== 1) return;
        const t  = tt[0];
        const dx = t.clientX - _touchStartX;
        const dy = t.clientY - _touchStartY;

        if (_touchPanActive) {
            zoomTx = panStartTx + (t.clientX - panStartX);
            zoomTy = panStartTy + (t.clientY - panStartY);
            imgEl.style.transition = 'none';
            applyTransform();
            const now = performance.now(), _dt = now - panLastTime;
            if (_dt > 0 && _dt < 64) { panVelX = (t.clientX - panLastX) / _dt; panVelY = (t.clientY - panLastY) / _dt; }
            panLastX = t.clientX; panLastY = t.clientY; panLastTime = now;
            e.preventDefault();
            return;
        }
        if (_touchNavActive) {
            if (!_touchNavDirLocked && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
                _touchNavDirLocked = Math.abs(dx) >= Math.abs(dy);
                if (!_touchNavDirLocked) { _touchNavActive = false; return; } // vertical — hand off
            }
            if (_touchNavDirLocked) { _touchNavDx = dx; e.preventDefault(); }
        }
    }, { passive: false });

    imageArea.addEventListener('touchend', (e) => {
        if (_touchPinchActive) {
            _touchPinchActive = false;
            _touchPanActive   = false;
            isPanning         = false;
            if (scrollZoomCurrent <= 1.05) startZoomExit();
            return;
        }
        if (_touchPanActive) {
            _touchPanActive = false;
            isPanning       = false;
            const ct   = e.changedTouches[0];
            const dist = Math.hypot(ct.clientX - panStartX, ct.clientY - panStartY);
            if (dist < 8) startZoomExit(); // tap while zoomed → exit
            else          startPanMomentum();
            return;
        }
        if (_touchNavActive) {
            _touchNavActive    = false;
            _touchNavDirLocked = false;
            if (Math.abs(_touchNavDx) > 50) {
                if (_touchNavDx < 0) navigateLightbox(1);  // swipe left  → next
                else                  navigateLightbox(-1); // swipe right → prev
                e.preventDefault();
            }
            _touchNavDx = 0;
        }
    }, { passive: false });

    // ── Orientation / resize: reset zoom & reposition slider ─────────────────
    function _onLightboxResize() {
        if (imgEl.classList.contains('lightbox-image-zooming')) {
            if (scrollZoomRaf)  { cancelAnimationFrame(scrollZoomRaf);  scrollZoomRaf  = null; }
            if (panMomentumRaf) { cancelAnimationFrame(panMomentumRaf); panMomentumRaf = null; }
            scrollZoomCurrent = 1; scrollZoomVelocity = 0;
            zoomTx = 0; zoomTy = 0; naturalRect = null;
            isPanning = false; _touchPanActive = false; _touchPinchActive = false;
            imgEl.classList.remove('lightbox-image-zooming');
            imgEl.style.transform = ''; imgEl.style.transformOrigin = ''; imgEl.style.transition = '';
            zoomTooltip.style.display = 'none';
            _clearZoomIdleTimer();
        }
        // Reposition the SDR comparison slider if it is open
        const _slider = imageWrapper.querySelector('.inline-comparison-slider');
        if (_slider?._reposition) requestAnimationFrame(_slider._reposition);
        // Keep active filmstrip thumbnail visible
        requestAnimationFrame(() => {
            const _ft = filmstrip.querySelector('.lightbox-filmstrip-thumb-active');
            if (_ft) _ft.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'instant' });
        });
    }

    // ── Render function (called on init and navigation) ──
    async function renderLightboxImage() {
        const item = lightboxBatch[lightboxIndex];
        // Update the page URL so this image has a shareable link
        const _shareUrl = new URL(location.href);
        _shareUrl.searchParams.set('img', item.id);
        // Preserve ?game= if a gallery filter is active
        if (gameSearchQuery.trim()) {
            _shareUrl.searchParams.set('game', gameSearchQuery.trim());
        } else {
            _shareUrl.searchParams.delete('game');
        }
        history.replaceState(null, '', _shareUrl.toString());
        const _t0 = performance.now();
        console.log(`[lightbox] renderLightboxImage() start  +0ms`);
        lbPixelBuffer = null; // reset buffer for new image
        lbSdrMode = false;
        lbLastPixelX = -1; lbLastPixelY = -1;

        // Reset zoom
        isZooming = false;
        scrollZoomCurrent = 1;
        scrollZoomVelocity = 0;
        zoomTx = 0; zoomTy = 0;
        zoomCursorX = 0; zoomCursorY = 0;
        if (scrollZoomRaf) { cancelAnimationFrame(scrollZoomRaf); scrollZoomRaf = null; } 
        imgEl.style.transform = '';
        imgEl.style.transformOrigin = '';
        imgEl.style.transition = '';
        imgEl.classList.remove('lightbox-image-zooming');
        zoomTooltip.style.display = 'none';
        _clearZoomIdleTimer();

        // Close SDR slider if open
        const existingSlider = imageWrapper.querySelector('.inline-comparison-slider');
        if (existingSlider) {
            if (existingSlider._cleanup) existingSlider._cleanup();
            existingSlider.remove();
        }
        lightboxSdrActive = false;
        compareBtn.classList.remove('button-active');
        compareBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12H3"/><path d="m7 8-4 4 4 4"/><path d="m17 8 4 4-4 4"/></svg><span class="btn-label"> <u>S</u>DR Slider</span>';

        // Reset SDR full-view toggle
        lightboxSdrToggleActive = false;
        sdrToggleBtn.classList.remove('sdr-active');
        sdrToggleBtn.querySelectorAll('.sdr-pill-seg').forEach(seg => seg.classList.toggle('sdr-pill-seg--active', seg.dataset.seg === 'hdr'));
        // updateSaveBtn();

        // Remove existing details overlay
        const existingOverlay = imageWrapper.querySelector('.image-meta-overlay');
        if (existingOverlay) existingOverlay.remove();

        // ── Spoiler handling ──────────────────────────────────────────────────
        // Remove any spoiler overlay left from the previous image
        const _prevSpoilerOverlay = imgContainer.querySelector('.lightbox-spoiler-overlay');
        if (_prevSpoilerOverlay) _prevSpoilerOverlay.remove();
        imgContainer.classList.remove('lightbox-spoiler', 'lightbox-spoiler-revealed');

        // Always clear any leftover inline spoiler style from a previous image
        imgEl.style.filter = '';
        imgEl.style.transform = '';
        imgEl.style.transition = '';

        if (item.spoiler) {
            const _spoilerKey = `spoiler-revealed:${item.id}`;
            const _alreadyRevealed = localStorage.getItem(_spoilerKey) === '1';

            if (!_alreadyRevealed) {
                // Apply blur immediately as inline style — no transition, no class, fires
                // before src is set so the bitmap is never visible unblurred even when
                // it was already decoded in the prefetch pool.
                imgEl.style.filter    = 'blur(32px) brightness(0.35)';
                imgEl.style.transform = 'scale(1.06)';
                imgEl.style.transition = 'none';

                const _spoilerOverlay = document.createElement('div');
                _spoilerOverlay.className = 'lightbox-spoiler-overlay';
                _spoilerOverlay.innerHTML = `
                    <div class="lightbox-spoiler-badge">
                        <span>SPOILER</span>
                        <span class="lightbox-spoiler-badge-sub">Click to reveal</span>
                    </div>`;
                imgContainer.appendChild(_spoilerOverlay);

                _spoilerOverlay.addEventListener('click', (e) => {
                    e.stopPropagation();
                    // Smooth reveal transition only on the way out
                    imgEl.style.transition = 'filter 0.35s ease, transform 0.35s ease';
                    imgEl.style.filter = '';
                    imgEl.style.transform = '';
                    _spoilerOverlay.classList.add('lightbox-spoiler-overlay-hidden');
                    localStorage.setItem(_spoilerKey, '1');
                    // Clean up inline styles once the transition finishes
                    imgEl.addEventListener('transitionend', () => {
                        imgEl.style.filter = '';
                        imgEl.style.transform = '';
                        imgEl.style.transition = '';
                    }, { once: true });
                    // Also unblur the filmstrip thumb and remove its SPOILER label
                    const _items = filmstrip.querySelectorAll('.lightbox-filmstrip-item');
                    _items.forEach((_item, _i) => {
                        if (lightboxBatch[_i]?.id === item.id) {
                            _item.querySelector('.lightbox-filmstrip-thumb')?.classList.remove('lightbox-filmstrip-thumb-spoiler');
                            _item.querySelector('.lightbox-filmstrip-spoiler-label')?.remove();
                        }
                    });
                });
            }
        }

        // Update main image — always use full-res original for accurate HDR rendering
        const { url: displayUrl, fullUrl, blob } = lightboxBlobUrls.get(item.id);
        // Only reassign src if the URL actually changed — skipping it avoids a blank
        // flash when the bitmap is already painted (e.g. navigating back to a cached image).
        if (imgEl.src !== fullUrl) {
            console.log(`[lightbox] setting imgEl.src  +${(performance.now()-_t0).toFixed(1)}ms`);
            imgEl.onerror = () => console.warn(`[lightbox] imgEl onerror fired  +${(performance.now()-_t0).toFixed(1)}ms`);
            imgEl.onload = () => { imgEl.onload = null; console.log(`[lightbox] imgEl onload fired  +${(performance.now()-_t0).toFixed(1)}ms`); };
            imgEl.src = fullUrl;
        } else {
            console.log(`[lightbox] imgEl.src unchanged, skipping reassign  +${(performance.now()-_t0).toFixed(1)}ms`);
        }
        // Reuse in-flight hover prefetch promise if available, otherwise start fresh.
        const _existingDecode = _decodePromises.get(fullUrl);
        if (_existingDecode) {
            _existingDecode.then(() => {
                console.log(`[lightbox] imgEl.decode() complete (bitmap ready to paint)  +${(performance.now()-_t0).toFixed(1)}ms (reused prefetch)`);
            }).catch(() => {});
        } else {
            const p = imgEl.decode().then(() => {
                console.log(`[lightbox] imgEl.decode() complete (bitmap ready to paint)  +${(performance.now()-_t0).toFixed(1)}ms`);
            }).catch(() => {});
            _decodePromises.set(fullUrl, p);
        }

        // Register in imageWrappers for global details system
        imageWrappers.set(item.id, { wrapper: imageWrapper, metadata: item.metadata || null, imageItem: item, compareButton: compareBtn, sdrToggle: sdrToggleBtn });
        currentVisibleImage = item.id;

        // Update cursor
        if (globalDetailsEnabled) {
            imgEl.classList.add('cursor-nit-hunt');
        } else {
            imgEl.classList.remove('cursor-nit-hunt');
        }

        // Re-show details overlay if global mode is on
        if (globalDetailsEnabled) {
            showDetailsForImage(item.id);
        }

        // Update image header tags and title
        imageHeaderTags.innerHTML = '';
        imageHeaderRight.innerHTML = '';
        _setLightboxTitle(item.gameName);
        const _navAdditionalInfo = item.additionalInfo || '';
        imageHeaderSubtitle.textContent = _navAdditionalInfo;
        imageHeaderSubtitle.style.display = _navAdditionalInfo ? '' : 'none';
        const hdrTypeDef = HDR_TYPES.find(t => t.id === item.hdrType);
        let lbHdrLabel = null;
        let lbHdrClass = '';
        if (hdrTypeDef && item.hdrType !== 'unknown') {
            lbHdrLabel = hdrTypeDef.label;
            lbHdrClass = `collage-hdr-type--${item.hdrType}`;
        } else if (!item.hdrType) {
            const tc = item.metadata?.luminanceStats?.transferCharacteristic;
            if (tc === 16 || tc === 18) { lbHdrLabel = 'Native HDR'; lbHdrClass = 'collage-hdr-type--nativeHdr'; }
        }
        if (lbHdrLabel) {
            const badge = document.createElement('span');
            badge.className = `collage-hdr-type ${lbHdrClass}`;
            badge.textContent = lbHdrLabel;
            imageHeaderRight.appendChild(badge);
        }

        // Update filmstrip active state
        filmstrip.querySelectorAll('.lightbox-filmstrip-item').forEach((item, i) => {
            item.classList.toggle('lightbox-filmstrip-thumb-active', i === lightboxIndex);
        });
        // Scroll active thumbnail into view (touch / keyboard navigation)
        requestAnimationFrame(() => {
            const _activeThumb = filmstrip.querySelector('.lightbox-filmstrip-thumb-active');
            if (_activeThumb) _activeThumb.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
        });

        // Nav arrow visibility
        prevBtn.style.opacity = lightboxIndex === 0 ? '0.25' : '1';
        prevBtn.style.pointerEvents = lightboxIndex === 0 ? 'none' : '';
        nextBtn.style.opacity = lightboxIndex === lightboxBatch.length - 1 ? '0.25' : '1';
        nextBtn.style.pointerEvents = lightboxIndex === lightboxBatch.length - 1 ? 'none' : '';

        // Show/hide owner-only buttons based on whether the current user uploaded this image
        editBtn.style.display       = 'none';
        sep2.style.display          = 'none';
        deleteBtn.style.display     = 'none';
        isCurrentUserOwner(item).then(isOwner => {
            editBtn.style.display      = isOwner ? '' : 'none';
            sep2.style.display         = isOwner ? '' : 'none';
            deleteBtn.style.display    = isOwner ? '' : 'none';
        });

        // Start pixel decode only if analysis tool is active
        if (globalDetailsEnabled) _startPixelDecode(item);
        const bufPromise = lightboxPixelBuffers.get(item.id);
        if (bufPromise) {
            // Show loading indicator immediately if mouse is already over the image
            if (lbMouseInside && globalDetailsEnabled) {
                nitTooltip.style.display = 'block';
                nitTooltip.innerHTML = _NIT_LOADING_HTML;
            }
            bufPromise.then(buf => {
                lbPixelBuffer = buf;
                if (lbMouseInside && globalDetailsEnabled && buf) {
                    nitTooltip.style.display = 'block';
                    const { imgX, imgY } = cursorToPixel(lastCursorX, lastCursorY, buf);
                    lbLastPixelX = imgX; lbLastPixelY = imgY;
                    const { rNits, gNits, bNits, luminance, gamut } = getNitsAtPixel(buf, imgX, imgY);
                    nitTooltip.innerHTML = _nitTooltipHTML(rNits, gNits, bNits, luminance, gamut);
                }
            });
        }


        // Wire up action buttons for current item
        editBtn.onclick = async () => {
            if (editBtn.disabled) return;
            editBtn.disabled = true;
            const result = await showEditModal(item.hdrType, item.gameName, item.spoiler, item.thumbUrl || item.sdrUrl, item.additionalInfo);
            editBtn.disabled = false;
            if (result === null) return;
            const { hdrType: newHdrType, gameName: newGameName, spoiler: newSpoiler, additionalInfo: newAdditionalInfo } = result;
            // Update all items in the batch in memory so navigation picks up the new name immediately
            lightboxBatch.forEach(batchItem => {
                if (batchItem.batchId === item.batchId || batchItem.id === item.id) {
                    batchItem.gameName = newGameName;
                    batchItem.hdrType  = newHdrType;
                    batchItem.spoiler  = newSpoiler;
                }
                if (batchItem.id === item.id) {
                    batchItem.additionalInfo = newAdditionalInfo;
                }
            });
            // Also update the toolbar center title which is set once on open
            _setLightboxTitle(newGameName);
            const _editAdditionalInfo = newAdditionalInfo || '';
            imageHeaderSubtitle.textContent = _editAdditionalInfo;
            imageHeaderSubtitle.style.display = _editAdditionalInfo ? '' : 'none';
            try {
                await updateImageHdrType(item.id, newHdrType);
                if (item.batchId) await updateBatchGameName(item.batchId, newGameName);
                await updateBatchSpoiler(item.batchId, item.id, newSpoiler);
                await updateAdditionalInfo(item.id, newAdditionalInfo);
                await refreshGallery();
                renderLightboxImage();
            } catch (err) { console.error('Edit error:', err); }
        };

        deleteBtn.onclick = async () => {
            if (!confirm(`Delete "${item.name}"?`)) return;
            try {
                await deleteImageFile(item.id);
                lightboxPixelBuffers.delete(item.id);
                lightboxBatch.splice(lightboxIndex, 1);
                if (lightboxBatch.length === 0) {
                    closeLightbox();
                    await refreshGallery();
                    return;
                }
                lightboxIndex = Math.min(lightboxIndex, lightboxBatch.length - 1);
                rebuildFilmstrip();
                renderLightboxImage();
                await refreshGallery();
            } catch (err) { console.error('Delete error:', err); }
        };

        compareBtn.onclick = (e) => {
            // Cancel Analysis Tool if active — only when user-initiated (not programmatic click)
            if (globalDetailsEnabled && e?.isTrusted) {
                globalDetailsEnabled = false;
                updateAllDetailButtons(false);
                const imgElQ = document.querySelector('.lightbox-image');
                if (imgElQ) imgElQ.classList.remove('cursor-nit-hunt');
                const conQ = document.querySelector('.lightbox-image-container');
                if (conQ) conQ.classList.remove('cursor-nit-hunt');
                hideAllDetailsOverlays();
                nitTooltip.style.display = 'none';
            }
            // Close full SDR view if active — the two modes are mutually exclusive
            if (lightboxSdrToggleActive) {
                const { fullUrl } = lightboxBlobUrls.get(item.id);
                imgEl.src = fullUrl;
                lightboxSdrToggleActive = false;
                sdrToggleBtn.classList.remove('sdr-active');
                sdrToggleBtn.querySelectorAll('.sdr-pill-seg').forEach(seg => seg.classList.toggle('sdr-pill-seg--active', seg.dataset.seg === 'hdr'));
            }

            const existingSlider = imageWrapper.querySelector('.inline-comparison-slider');
            if (existingSlider) {
                if (existingSlider._cleanup) existingSlider._cleanup();
                existingSlider.remove();
                lightboxSdrActive = false;
                compareBtn.classList.remove('button-active');
                compareBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12H3"/><path d="m7 8-4 4 4 4"/><path d="m17 8 4 4-4 4"/></svg><span class="btn-label"> <u>S</u>DR Slider</span>';
                // Restore analysis overlay and nit tooltip
                const metaOverlay = imageWrapper.querySelector('.image-meta-overlay');
                if (metaOverlay) metaOverlay.style.visibility = '';
                return;
            }
            const { sdrUrl } = lightboxBlobUrls.get(item.id);
            if (sdrUrl) {

                const slider = document.createElement('div');
                slider.className = 'inline-comparison-slider lightbox-comparison-slider';

                // No HDR img needed — imgEl underneath is the HDR layer
                const sdrImg = document.createElement('img');
                sdrImg.className = 'inline-comparison-sdr';

                const divider = document.createElement('div');
                divider.className = 'inline-comparison-divider';

                const sdrLabel = document.createElement('span');
                sdrLabel.className = 'inline-comparison-label inline-comparison-label-sdr';
                sdrLabel.textContent = 'SDR';

                const hdrLabel = document.createElement('span');
                hdrLabel.className = 'inline-comparison-label inline-comparison-label-hdr';
                hdrLabel.textContent = 'HDR';

                slider.appendChild(sdrImg);
                slider.appendChild(divider);
                slider.appendChild(sdrLabel);
                slider.appendChild(hdrLabel);

                // Position slider to exactly cover imgEl's rendered rect
                function positionSlider() {
                    if (imgEl.classList.contains('lightbox-image-zooming')) {
                        // CSS already makes it position:fixed full-viewport — clear inline overrides
                        slider.style.left   = '';
                        slider.style.top    = '';
                        slider.style.width  = '';
                        slider.style.height = '';
                        // imgEl is fixed full-viewport with object-fit:contain, so compute
                        // the actual letterboxed image rect to place labels correctly.
                        const natW = imgEl.naturalWidth  || imgEl.width;
                        const natH = imgEl.naturalHeight || imgEl.height;
                        const vw = window.innerWidth, vh = window.innerHeight;
                        const scale = Math.min(vw / natW, vh / natH);
                        const imgW = natW * scale, imgH = natH * scale;
                        const imgLeft = (vw - imgW) / 2, imgTop = (vh - imgH) / 2;
                        sdrLabel.style.left  = (imgLeft + 10) + 'px';
                        sdrLabel.style.right = '';
                        sdrLabel.style.top   = (imgTop  + 10) + 'px';
                        hdrLabel.style.right = (vw - imgLeft - imgW + 10) + 'px';
                        hdrLabel.style.left  = '';
                        hdrLabel.style.top   = (imgTop  + 10) + 'px';
                    } else {
                        // Reset labels to default CSS positioning
                        sdrLabel.style.left  = '';
                        sdrLabel.style.right = '';
                        sdrLabel.style.top   = '';
                        hdrLabel.style.right = '';
                        hdrLabel.style.left  = '';
                        hdrLabel.style.top   = '';
                        const rect = imgEl.getBoundingClientRect();
                        const containerRect = imgContainer.getBoundingClientRect();
                        slider.style.left   = (rect.left - containerRect.left) + 'px';
                        slider.style.top    = (rect.top  - containerRect.top)  + 'px';
                        slider.style.width  = rect.width  + 'px';
                        slider.style.height = rect.height + 'px';
                    }
                }

                slider._reposition = positionSlider; // expose for resize handler
                imgContainer.appendChild(slider);

                // Re-position whenever zoom mode is toggled (class change on imgEl)
                const zoomClassObserver = new MutationObserver(positionSlider);
                zoomClassObserver.observe(imgEl, { attributes: true, attributeFilter: ['class'] });

                function activateSlider() {
                    positionSlider();
                    slider.style.visibility = 'visible';

                    let isDragging = false;
                    const LABEL_WIDTH = 70;

                    function updateSlider(clientX) {
                        const rect = slider.getBoundingClientRect();
                        const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
                        sdrImg.style.clipPath = `inset(0 ${(1 - pct) * 100}% 0 0)`;
                        divider.style.left = `${pct * 100}%`;
                        const dividerX = pct * rect.width;
                        sdrLabel.style.opacity = dividerX < LABEL_WIDTH ? '0' : '1';
                        hdrLabel.style.opacity = dividerX > rect.width - LABEL_WIDTH ? '0' : '1';
                    }
                    updateSlider(slider.getBoundingClientRect().left + slider.getBoundingClientRect().width * 0.5);

                    const onMouseMove  = (e) => { if (isDragging) updateSlider(e.clientX); };
                    const onMouseUp    = () => { isDragging = false; };
                    const onTouchMove  = (e) => { if (isDragging) { updateSlider(e.touches[0].clientX); e.preventDefault(); } };
                    const onTouchEnd   = () => { isDragging = false; };

                    slider.addEventListener('mousedown', (e) => { isDragging = true; updateSlider(e.clientX); e.preventDefault(); });
                    document.addEventListener('mousemove', onMouseMove);
                    document.addEventListener('mouseup',   onMouseUp);
                    slider.addEventListener('touchstart', (e) => { isDragging = true; updateSlider(e.touches[0].clientX); }, { passive: true });
                    document.addEventListener('touchmove', onTouchMove, { passive: false });
                    document.addEventListener('touchend',  onTouchEnd);

                    // Forward nit-hunt events to imgEl so the tooltip works with SDR slider active
                    const onSliderMouseEnter = (e) => { if (globalDetailsEnabled) imgEl.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, clientX: e.clientX, clientY: e.clientY })); };
                    const onSliderMouseLeave = (e) => { imgEl.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false })); };
                    const onSliderMouseMove  = (e) => { if (globalDetailsEnabled) imgEl.dispatchEvent(new MouseEvent('mousemove', { bubbles: false, clientX: e.clientX, clientY: e.clientY })); };
                    slider.addEventListener('mouseenter', onSliderMouseEnter);
                    slider.addEventListener('mouseleave', onSliderMouseLeave);
                    slider.addEventListener('mousemove',  onSliderMouseMove);

                    // Store cleanup on the slider element so it can be called on remove
                    slider._cleanup = () => {
                        zoomClassObserver.disconnect();
                        document.removeEventListener('mousemove', onMouseMove);
                        document.removeEventListener('mouseup',   onMouseUp);
                        document.removeEventListener('touchmove', onTouchMove);
                        document.removeEventListener('touchend',  onTouchEnd);
                        slider.removeEventListener('mouseenter', onSliderMouseEnter);
                        slider.removeEventListener('mouseleave', onSliderMouseLeave);
                        slider.removeEventListener('mousemove',  onSliderMouseMove);
                    };
                }

                sdrImg.onload = activateSlider;
                // Snap to 1x if currently zoomed — keep zoom mode active, just reset scale/pan
                if (imgEl.classList.contains('lightbox-image-zooming')) {
                    scrollZoomVelocity = 0;
                    scrollZoomCurrent = 1;
                    snapGateActive = false;
                    if (scrollZoomRaf) { cancelAnimationFrame(scrollZoomRaf); scrollZoomRaf = null; }
                    zoomTx = 0; zoomTy = 0;
                    imgEl.style.transition = '';
                    imgEl.style.transformOrigin = '0 0';
                    imgEl.style.transform = 'translate(0px, 0px) scale(1)';
                    zoomTooltip.innerHTML = `<svg class="zoom-icon" xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>1.0× zoom`;
                }

                sdrImg.src = sdrUrl;
                // If already cached, onload won't fire
                if (sdrImg.complete && sdrImg.naturalWidth > 0) activateSlider();

                lightboxSdrActive = true;
                compareBtn.classList.add('button-active');
                // Hide analysis overlay and nit tooltip while SDR slider is active
                const metaOverlay = imageWrapper.querySelector('.image-meta-overlay');
                if (metaOverlay) metaOverlay.style.visibility = 'hidden';
                nitTooltip.style.display = 'none';
                _nitsRow.style.display = 'none';
            } else {
                showStatusMessage('SDR version not available', 'error');
            }
        };

        // Helper: update pill toggle visual state (sdrActive=true → SDR seg lit, false → HDR seg lit)
        function _setSdrPill(sdrActive) {
            sdrToggleBtn.classList.toggle('sdr-active', sdrActive);
            sdrToggleBtn.querySelectorAll('.sdr-pill-seg').forEach(seg => {
                seg.classList.toggle('sdr-pill-seg--active', sdrActive ? seg.dataset.seg === 'sdr' : seg.dataset.seg === 'hdr');
            });
        }

        sdrToggleBtn.onclick = () => {
            // Close the slider if it's open — the two modes are mutually exclusive
            const existingSlider = imageWrapper.querySelector('.inline-comparison-slider');
            if (existingSlider) {
                if (existingSlider._cleanup) existingSlider._cleanup();
                existingSlider.remove();
                lightboxSdrActive = false;
                compareBtn.classList.remove('button-active');
                compareBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12H3"/><path d="m7 8-4 4 4 4"/><path d="m17 8 4 4-4 4"/></svg><span class="btn-label"> <u>S</u>DR Slider</span>';
            }

            if (lightboxSdrToggleActive) {
                // ── Switch back to HDR ──────────────────────────────────────
                const { fullUrl } = lightboxBlobUrls.get(item.id);
                imgEl.src = fullUrl;
                lightboxSdrToggleActive = false;
                lbSdrMode = false;
                lbPixelBuffer = null;
                _setSdrPill(false);

                // Restore HDR metadata panel if analysis is active
                if (globalDetailsEnabled) {
                    const existing = imageWrapper.querySelector('.image-meta-overlay');
                    if (existing) existing.remove();
                    showDetailsForImage(item.id);
                    // Re-prime the HDR pixel buffer
                    _startPixelDecode(item);
                    lightboxPixelBuffers.get(item.id)?.then(buf => {
                        lbPixelBuffer = buf;
                    });
                } else {
                    const metaOverlay = imageWrapper.querySelector('.image-meta-overlay');
                    if (metaOverlay) metaOverlay.style.visibility = '';
                }
                return;
            }

            const { sdrUrl } = lightboxBlobUrls.get(item.id);
            if (sdrUrl) {
                imgEl.src = sdrUrl;
                lightboxSdrToggleActive = true;
                lbSdrMode = true;
                lbPixelBuffer = null;
                _setSdrPill(true);

                // If analysis tool is active, switch to SDR metadata panel and SDR pixel buffer
                if (globalDetailsEnabled) {
                    _startSdrPixelDecode(item);
                    const existing = imageWrapper.querySelector('.image-meta-overlay');
                    if (existing) existing.remove();
                    _showSdrMetadataOverlay(item, imageWrapper);
                    // Wire up SDR pixel buffer for nit tooltip
                    lightboxSdrPixelBuffers.get(item.id)?.then(buf => {
                        lbPixelBuffer = buf;
                        // If cursor is already over image, show nit tooltip immediately
                        if (lbMouseInside && globalDetailsEnabled && buf) {
                            const { imgX, imgY } = cursorToPixel(lastCursorX, lastCursorY, buf);
                            lbLastPixelX = imgX; lbLastPixelY = imgY;
                            nitTooltip.style.display = 'block';
                            const _r = _getNitsAtPixelSdr(buf, imgX, imgY);
                            nitTooltip.innerHTML = _nitTooltipHTML(_r.rNits, _r.gNits, _r.bNits, _r.luminance, _r.gamut);
                        }
                    });
                } else {
                    // Analysis not active — just hide meta overlay as before
                    const metaOverlay = imageWrapper.querySelector('.image-meta-overlay');
                    if (metaOverlay) metaOverlay.style.visibility = 'hidden';
                    nitTooltip.style.display = 'none';
                    _nitsRow.style.display = 'none';
                }
            } else {
                showStatusMessage('SDR version not available', 'error');
            }
        };
    } // end renderLightboxImage

    // ── Filmstrip builder ──
    function rebuildFilmstrip() {
        filmstrip.innerHTML = '';
        if (lightboxBatch.length <= 1) return;
        lightboxBatch.forEach((item, idx) => {
            const { url } = lightboxBlobUrls.get(item.id);
            const isSpoiler = item.spoiler && localStorage.getItem(`spoiler-revealed:${item.id}`) !== '1';

            const wrapper = document.createElement('div');
            wrapper.className = 'lightbox-filmstrip-item' + (idx === lightboxIndex ? ' lightbox-filmstrip-thumb-active' : '');

            const thumb = document.createElement('img');
            thumb.src = url;
            thumb.alt = item.name;
            thumb.className = 'lightbox-filmstrip-thumb';
            if (isSpoiler) thumb.classList.add('lightbox-filmstrip-thumb-spoiler');
            wrapper.appendChild(thumb);

            if (isSpoiler) {
                const label = document.createElement('span');
                label.className = 'lightbox-filmstrip-spoiler-label';
                wrapper.appendChild(label);
            }

            // Track mousedown position so a drag-scroll doesn't fire a spurious click
            let _thumbMousedownX = 0, _thumbMousedownY = 0;
            wrapper.addEventListener('mousedown', (e) => {
                _thumbMousedownX = e.clientX;
                _thumbMousedownY = e.clientY;
            });
            wrapper.addEventListener('click', (e) => {
                e.stopPropagation();
                if (Math.abs(e.clientX - _thumbMousedownX) > 4 || Math.abs(e.clientY - _thumbMousedownY) > 4) return;
                lightboxIndex = idx;
                renderLightboxImage();
            });
            filmstrip.appendChild(wrapper);
        });
    }

    rebuildFilmstrip();
    // Scroll active thumb into view after layout — block:nearest avoids moving the page vertically
    requestAnimationFrame(() => {
        const _activeThumb = filmstrip.querySelector('.lightbox-filmstrip-thumb-active');
        if (_activeThumb) _activeThumb.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'instant' });
    });
    _lightboxRender = renderLightboxImage;
    // Defer the first render by one rAF so the browser paints the overlay shell
    // immediately — the image load + decode then starts on the next frame rather
    // than blocking the initial open.
    console.log(`[lightbox] overlay built, queuing rAF  +${(performance.now()-_lbT0).toFixed(1)}ms`);
    requestAnimationFrame(() => {
        console.log(`[lightbox] rAF fired → renderLightboxImage()  +${(performance.now()-_lbT0).toFixed(1)}ms`);
        renderLightboxImage();
    });

    // Store cleanup ref on overlay for closeLightbox
    overlay._cleanupMouseUp = _mouseUpLightbox;
    window.addEventListener('resize', _onLightboxResize);
    overlay._cleanupResize  = _onLightboxResize;
}

let _lightboxRender = null; // set by openLightbox, called by navigateLightbox
let _arrowThrottleLast  = -Infinity; // timestamp of last throttled arrow render
let _arrowThrottleTimer = null;      // trailing-edge timer handle

// Keyed by sdrUrl — holds hidden Image objects to keep SDR images in the browser cache.
const _sdrPreloadCache = new Map();

// Preload the SDR image for the item at `index` and its immediate neighbours.
function _prefetchSdrImages(index) {
    for (const i of [index, index - 1, index + 1]) {
        const item = lightboxBatch[i];
        if (!item) continue;
        const entry = lightboxBlobUrls.get(item.id);
        const url   = entry?.sdrUrl;
        if (!url || _sdrPreloadCache.has(url)) continue;
        const img = new Image();
        img.src = url;
        _sdrPreloadCache.set(url, img);
    }
}

function navigateLightbox(direction) {
    const newIndex = lightboxIndex + direction;
    if (newIndex < 0 || newIndex >= lightboxBatch.length) return;
    lightboxIndex = newIndex;
    _prefetchSdrImages(newIndex);
    if (_lightboxRender) _lightboxRender();
}

function closeLightbox() {
    const overlay = document.getElementById('lightbox-overlay');
    if (overlay) {
        if (overlay._cleanupMouseUp) document.removeEventListener('mouseup', overlay._cleanupMouseUp);
        if (overlay._cleanupResize)  window.removeEventListener('resize', overlay._cleanupResize);
        overlay.classList.add('lightbox-closing');
        overlay.style.opacity = '0';
        const duration = parseFloat(getComputedStyle(overlay).transitionDuration) * 1000;
        setTimeout(() => overlay.remove(), duration);
    }
    document.body.style.overflow = '';
    document.documentElement.style.overflow = '';
    lightboxOpen = false;
    // Remove the ?img= param and restore ?game= if a filter is active
    _syncGameUrl(gameSearchQuery.trim());
    lightboxBatch = [];
    lightboxIndex = 0;
    lightboxSdrToggleActive = false;
    lightboxSdrPixelBuffers.clear();
    _lightboxRender = null;
    _lightboxResetZoomIdleTimer = null;
    _sdrPreloadCache.clear();
    _arrowThrottleLast  = -Infinity;
    clearTimeout(_arrowThrottleTimer);
    _arrowThrottleTimer = null;
    globalDetailsEnabled = false;
    nitTooltip.style.display = 'none';
    zoomTooltip.style.display = 'none';
    // Clear lightbox image wrapper from the map so details mode doesn't break
    imageWrappers.clear();
    currentVisibleImage = null;
    _prefetchedImages.clear();
    _lbPoolSlots.clear();
    if (_lbDecodePool) { _lbDecodePool.remove(); _lbDecodePool = null; }
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function isInsideRect(x, y, rect) {
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

// ─── Step Progress Bar ────────────────────────────────────────────────────────

let _progressSteps = [];
let _progressCurrentStep = -1;
let _progressFileLabel = '';
let _progressFileIndex = 0;
let _progressFileTotal = 0;

// Define the step sequence. conversionNeeded adds extra steps at the front.
function initProgress(fileTotal, conversionNeeded) {
    _progressFileTotal = fileTotal;
    _progressFileIndex = 0;
    _progressSteps = [
        ...(conversionNeeded ? [{ id: 'convert', label: 'Convert' }] : []),
        { id: 'metadata',  label: 'Metadata'  },
        { id: 'analysing', label: 'Analysing' },
    ];
    _progressCurrentStep = -1;
    _progressFileLabel = '';
    _renderProgress();
}


// advanceProgressFile() must be called exactly once per file, before setProgressStep.
// Passing the call through here rather than inferring it from counter state avoids
// the ambiguity that arises with mixed native/converted batches.
function advanceProgressFile() {
    _progressFileIndex++;
}

function setProgressStep(stepId, fileName) {
    _progressCurrentStep = _progressSteps.findIndex(s => s.id === stepId);
    if (fileName !== undefined) _progressFileLabel = fileName;
    _renderProgress();
}

// Legacy thin wrapper — called by old conversion code
function showProgress(label) {
    if (label.startsWith('Loading converter') || label.startsWith('Converting')) {
        const fileName = label.startsWith('Converting') ? label.replace('Converting ', '') : '';
        setProgressStep('convert', fileName);
    } else if (label.startsWith('Processing metadata')) {
        setProgressStep('metadata', label.replace('Processing metadata for ', ''));
    } else if (label.startsWith('Generating SDR') || label.startsWith('Generating thumbnail')) {
        setProgressStep('analysing');
    } else {
        _progressFileLabel = label;
        _renderProgress();
    }
}

function hideProgress() {
    statusMessage.innerHTML = '';
    _progressSteps = [];
    _progressCurrentStep = -1;
}

function _renderProgress() {
    if (_progressSteps.length === 0) return;

    const total = _progressFileTotal || 1;
    const currentStepId = _progressCurrentStep >= 0 ? _progressSteps[_progressCurrentStep]?.id : null;

    // _progressFileIndex is the single counter (1-based), advanced once per file
    // via advanceProgressFile() before any step is set for that file.
    const activeFileNum = _progressFileIndex;
    const effectiveActiveIdx = Math.max(0, activeFileNum - 1);
    const hasActive = activeFileNum > 0;

    const segments = Array.from({ length: total }, (_, i) => {
        let cls = '';
        if (hasActive && i < effectiveActiveIdx) cls = 'seg-done';
        else if (hasActive && i === effectiveActiveIdx) cls = 'seg-active';
        return `<div class="import-progress-segment ${cls}"></div>`;
    }).join('');
    const counter = total > 1
        ? `<span class="import-progress-counter"><em>${activeFileNum}</em> / ${total}</span>`
        : '';

    // Main label: derive a human-readable description from current step + file label.
    let mainLabel = 'Processing\u2026';
    if (currentStepId === 'convert') {
        mainLabel = _progressFileLabel === 'Loading converter\u2026' ? 'Loading converter\u2026' : `Converting\u2026`;
    } else if (currentStepId === 'metadata') {
        mainLabel = 'Reading metadata\u2026';
    } else if (currentStepId === 'analysing') {
        if (_progressFileLabel.startsWith('SDR tonemap'))      mainLabel = 'Generating SDR version\u2026';
        else if (_progressFileLabel.startsWith('Thumbnail'))   mainLabel = 'Generating thumbnail\u2026';
        else if (_progressFileLabel.startsWith('Saving'))      mainLabel = 'Saving\u2026';
        else                                                    mainLabel = 'Analysing\u2026';
    }

    statusMessage.innerHTML = `
        <div class="import-progress">
            <div class="import-progress-row">
                <div class="import-progress-spinner"></div>
                <span class="import-progress-label">${mainLabel}</span>
                <div class="import-progress-spacer"></div>
                ${counter}
            </div>
            <div class="import-progress-segments">${segments}</div>
        </div>
    `;
}

function showStatusMessage(message, type = 'info') {
    statusMessage.textContent = message;
    statusMessage.style.color = type === 'error' ? '#ff6b6b' : type === 'success' ? '#51cf66' : '#bbb';
    
    if (type === 'success' || type === 'error') {
        setTimeout(() => {
            statusMessage.style.color = '#bbb';
        }, 3000);
    }
}

function showItemStatusMessage(infoSection, message, type = 'info') {
    // Check if there's already a message element
    let messageElement = infoSection.querySelector('.item-status-message');
    
    if (!messageElement) {
        messageElement = document.createElement('div');
        messageElement.className = 'item-status-message';
        infoSection.appendChild(messageElement);
    }
    
    messageElement.textContent = message;
    messageElement.style.color = type === 'success' ? '#51cf66' : '#ff6b6b';
    messageElement.style.display = 'block';
    
    // Hide message after 2 seconds
    setTimeout(() => {
        messageElement.style.display = 'none';
    }, 2000);
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

// ─── Metadata Overlay Panels ─────────────────────────────────────────────────

// Builds and attaches the SDR metadata panel for a given item.
// Static info (resolution, format) is shown immediately; luminance stats are
// filled in once the SDR pixel buffer finishes decoding.
function _showSdrMetadataOverlay(item, imageWrapper) {
    const existing = imageWrapper.querySelector('.image-meta-overlay');
    if (existing) existing.remove();

    const hdrMeta = item.metadata;
    const res   = hdrMeta?.resolution ?? '—';
    const w     = hdrMeta?.width  ?? 0;
    const h     = hdrMeta?.height ?? 0;

    const LUMA_PLACEHOLDER_ID = `sdr-luma-rows-${item.id}`;

    let panelRows = '';
    panelRows += `<div class="imo-section-title imo-section-title--file">File Info</div>`;
    panelRows += imoRow('Resolution', res);
    if (w && h) panelRows += imoRow('Aspect', getAspectRatioLabel(w, h));

    // SDR file size — fetch via HEAD request on the Cloudinary URL
    const SIZE_PLACEHOLDER_ID = `sdr-size-${item.id}`;
    panelRows += `<span id="${SIZE_PLACEHOLDER_ID}"></span>`;

    panelRows += imoRow('Format', 'AVIF · 8-bit sRGB');

    panelRows += `<div class="imo-section-title imo-section-title--luminance">Luminance (SDR)</div>`;
    panelRows += `<div id="${LUMA_PLACEHOLDER_ID}">` +
        `<div class="imo-row imo-row--unavailable" style="display:flex;align-items:center;gap:6px;">` +
        `<svg class="nit-loading__spinner" xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>` +
        `Computing…</div></div>`;

    const overlay = document.createElement('div');
    overlay.className = 'image-meta-overlay';
    overlay.innerHTML = `
        <div class="imo-panels">
            <div class="imo-panel imo-panel-single imo-draggable">
                <div class="imo-drag-handle"></div>
                ${panelRows}
            </div>
        </div>`;

    const imgContainer = imageWrapper.querySelector('.lightbox-image-container') || imageWrapper;
    imgContainer.appendChild(overlay);
    _initImoPanel(overlay, imageWrapper);

    // Fetch SDR file size via HEAD request (non-blocking)
    const sdrUrl = lightboxBlobUrls.get(item.id)?.sdrUrl;
    if (sdrUrl) {
        fetch(sdrUrl, { method: 'HEAD' }).then(r => {
            const sizePlaceholder = document.getElementById(SIZE_PLACEHOLDER_ID);
            if (!sizePlaceholder) return;
            const bytes = parseInt(r.headers.get('content-length') || '0', 10);
            sizePlaceholder.outerHTML = bytes > 0 ? imoRow('Size', formatFileSize(bytes)) : '';
        }).catch(() => {
            const sizePlaceholder = document.getElementById(SIZE_PLACEHOLDER_ID);
            if (sizePlaceholder) sizePlaceholder.outerHTML = '';
        });
    }

    // Fill in luminance stats — use stored stats from Firestore if available (new images),
    // fall back to pixel buffer decode for older images that don't have them yet.
    if (item.sdrLuminanceStats) {
        const { maxLuminance, avgLuminance, minLuminance } = item.sdrLuminanceStats;
        document.getElementById(LUMA_PLACEHOLDER_ID).innerHTML =
            imoRow('Max', `${maxLuminance.toFixed(2)} cd/m²`) +
            imoRow('Avg', `${avgLuminance.toFixed(2)} cd/m²`) +
            imoRow('Min', `${minLuminance.toFixed(2)} cd/m²`);
    } else {
        _startSdrPixelDecode(item);
        lightboxSdrPixelBuffers.get(item.id)?.then(buf => {
            const placeholder = document.getElementById(LUMA_PLACEHOLDER_ID);
            if (!placeholder) return;
            if (!buf) {
                placeholder.innerHTML = `<div class="imo-row imo-row--unavailable">Not available</div>`;
                return;
            }

            const { pixels, width, height, samplesPerPixel } = buf;
            const bytesPerPx = samplesPerPixel * 2;
            let maxL = 0, sumL = 0, minL = Infinity;
            const total = width * height;
            for (let i = 0; i < total; i++) {
                const base = i * bytesPerPx;
                const r = _srgbEotf((pixels[base]     << 8 | pixels[base + 1]) / 65535);
                const g = _srgbEotf((pixels[base + 2] << 8 | pixels[base + 3]) / 65535);
                const b = _srgbEotf((pixels[base + 4] << 8 | pixels[base + 5]) / 65535);
                const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                if (lum > maxL) maxL = lum;
                if (lum < minL) minL = lum;
                sumL += lum;
            }
            const avgL = sumL / total;

            placeholder.innerHTML =
                imoRow('Max', `${maxL.toFixed(2)} cd/m²`) +
                imoRow('Avg', `${avgL.toFixed(2)} cd/m²`) +
                imoRow('Min', `${(minL === Infinity ? 0 : minL).toFixed(2)} cd/m²`);
        });
    }
}

function showMetadataOverlay(filename, metadata, imageWrapper) {
    const existing = imageWrapper.querySelector('.image-meta-overlay');
    if (existing) existing.remove();

    let panelRows = '';

    panelRows += `<div class="imo-section-title imo-section-title--file">File Info</div>`;
    panelRows += imoRow('Resolution', metadata.resolution);
    panelRows += imoRow('Aspect', getAspectRatioLabel(metadata.width, metadata.height));
    panelRows += imoRow('Size', formatFileSize(metadata.fileSize));

    const fileExt = getFileExtension(filename).replace('.', '').toUpperCase();
    const formatParts = [fileExt];
    if (metadata.hdr?.colorType && metadata.hdr.colorType !== 'Unknown') formatParts.push(metadata.hdr.colorType);
    if (metadata.hdr?.colorPrimaries) formatParts.push(metadata.hdr.colorPrimaries);
    panelRows += imoRow('Format', formatParts.join(' · '));

    if (metadata.hdr) {
        panelRows += `<div class="imo-section-title imo-section-title--hdr">HDR Metadata</div>`;
        panelRows += imoRow('Bit Depth', metadata.hdr.bitDepth);
        if (metadata.hdr.gamma && metadata.hdr.gamma !== 'Not specified' && metadata.hdr.gamma !== 'HDR transfer function') {
            panelRows += imoRow('Gamma', metadata.hdr.gamma);
        }
        panelRows += imoRow('Transfer', metadata.hdr.transferFunction);
        if (metadata.hdr.format) panelRows += imoRow('Format', metadata.hdr.format);
    }

    if (metadata.luminanceStats) {
        const tc = metadata.luminanceStats.transferCharacteristic;
        const maxCLLlabel = tc === 16 || tc === 18 ? 'MaxCLL' : 'MaxCLL (scRGB)';
        const maxCLLvalue = tc === 16 || tc === 18
            ? `${metadata.luminanceStats.maxCLL.toFixed(2)} cd/m²`
            : `${(metadata.luminanceStats.maxCLL / 80).toFixed(3)} (${metadata.luminanceStats.maxCLL.toFixed(2)} cd/m²)`;
        panelRows += `<div class="imo-section-title imo-section-title--luminance">Luminance</div>`;
        panelRows += imoRow(maxCLLlabel, maxCLLvalue);
        panelRows += imoRow('Max', `${metadata.luminanceStats.maxLuminance.toFixed(2)} cd/m²`);
        panelRows += imoRow('Avg', `${metadata.luminanceStats.avgLuminance.toFixed(2)} cd/m²`);
        panelRows += imoRow('Min', `${metadata.luminanceStats.minLuminance.toFixed(2)} cd/m²`);
    } else if (!metadata.hdr) {
        panelRows += `<div class="imo-section-title imo-section-title--luminance">Luminance</div>`;
        panelRows += `<div class="imo-row imo-row--unavailable">Not available for this file type</div>`;
    }

    if (metadata.gamutCoverage) {
        if (metadata.gamutCoverage.narrowSource) {
            panelRows += `<div class="imo-section-title imo-section-title--gamut">Gamut</div>`;
            panelRows += `<div class="imo-row imo-row--unavailable">Wide-gamut analysis requires a BT.2020 or P3 source</div>`;
        } else {
            panelRows += `<div class="imo-section-title imo-section-title--gamut">Gamut</div>`;
            panelRows += imoGamutRow('Rec. 709', metadata.gamutCoverage.rec709, '#60a5fa');
            panelRows += imoGamutRow('DCI-P3',   metadata.gamutCoverage.p3,    '#34d399');
            panelRows += imoGamutRow('BT.2020',  metadata.gamutCoverage.bt2020,'#f472b6');
        }
    }

    const overlay = document.createElement('div');
    overlay.className = 'image-meta-overlay';
    overlay.innerHTML = `
        <div class="imo-panels">
            <div class="imo-panel imo-panel-single imo-draggable">
                <div class="imo-drag-handle"></div>
                ${panelRows}
            </div>
        </div>`;

    const imgContainer = imageWrapper.querySelector('.lightbox-image-container') || imageWrapper;
    imgContainer.appendChild(overlay);
    _initImoPanel(overlay, imageWrapper);
}

// Positions and wires up drag behaviour for an .image-meta-overlay panel.
// Called by both showMetadataOverlay and _showSdrMetadataOverlay after the
// overlay element has been appended to the DOM.
function _initImoPanel(overlay, imageWrapper) {
    const panel = overlay.querySelector('.imo-panel');
    // Set grab cursor as inline style — beats inherited cursor-nit-hunt from parent wrapper
    panel.style.cursor = 'grab';

    requestAnimationFrame(() => {
        const overlayRect = overlay.getBoundingClientRect();
        panel.style.position = 'absolute';
        panel.style.margin   = '0';

        const imgEl = imageWrapper.querySelector('.lightbox-image');
        const boundsEl = imgEl || overlay;
        const bRect = boundsEl.getBoundingClientRect();
        const oRect = overlayRect;
        const minLeft = bRect.left - oRect.left;
        const minTop  = bRect.top  - oRect.top;

        // Compute and apply max-height so the panel never overflows the image area.
        // Called on first placement and after every drag move so the panel stays
        // scrollable regardless of where it's been dragged to.
        function setPanelMaxHeight(panelTop, imgBRect, overlayBRect) {
            // Bottom edge of image in overlay-relative coords
            const imgBottom = imgBRect.top - overlayBRect.top + imgBRect.height;
            const available = imgBottom - panelTop - 8; // 8px bottom breathing room
            panel.style.maxHeight = Math.max(80, available) + 'px';
        }

        if (imoPanelPositions.single) {
            const saved = imoPanelPositions.single;
            const pRect = panel.getBoundingClientRect();
            // Allow the panel to overflow the image bounds by 4 pixels
            const overflow = 4;
            const minLeftAllowed = minLeft - overflow;
            const maxLeftAllowed = minLeft + bRect.width  - pRect.width + overflow;
            const minTopAllowed  = minTop  - overflow;
            const maxTopAllowed  = minTop  + bRect.height - pRect.height + overflow;
            const l = Math.max(minLeftAllowed, Math.min(maxLeftAllowed, saved.left));
            const t = Math.max(minTopAllowed,  Math.min(maxTopAllowed,  saved.top));
            panel.style.left = l + 'px';
            panel.style.top  = t + 'px';
            setPanelMaxHeight(t, bRect, oRect);
        } else {
            panel.style.left = minLeft + 'px';
            panel.style.top  = minTop  + 'px';
            setPanelMaxHeight(minTop, bRect, oRect);
        }

        // Drag logic
        // Only block drag on actual interactive controls — not SPAN/LABEL which make up
        // nearly all visible panel content (imo-label, imo-value, imo-pct).
        const INTERACTIVE_TAGS = new Set(['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'A']);

        panel.addEventListener('mousedown', (e) => {
            const fromHandle      = e.target.classList.contains('imo-drag-handle');
            const fromInteractive = INTERACTIVE_TAGS.has(e.target.tagName);
            if (!fromHandle && fromInteractive) return;

            // Notify the lightbox overlay that drag started inside content,
            // so releasing outside doesn't trigger a spurious close click.
            const lbOverlay = document.getElementById('lightbox-overlay');
            if (lbOverlay?._setMousedownInsideContent) lbOverlay._setMousedownInsideContent(true);

            e.preventDefault();
            e.stopPropagation();

            const startLeft = parseFloat(panel.style.left);
            const startTop  = parseFloat(panel.style.top);
            const startX    = e.clientX;
            const startY    = e.clientY;
            // Lock current width to avoid it being reflowed/squished while dragging
            const startWidth = panel.getBoundingClientRect().width;
            panel.style.width = startWidth + 'px';

            function onMove(e) {
                const imgEl = imageWrapper.querySelector('.lightbox-image');
                const boundsEl = imgEl || overlay;
                const bRect = boundsEl.getBoundingClientRect();
                const oRect = overlay.getBoundingClientRect();
                const pRect = panel.getBoundingClientRect();
                const rawLeft = startLeft + e.clientX - startX;
                const rawTop  = startTop  + e.clientY - startY;
                // Clamp within image bounds, expressed as offsets relative to overlay,
                // but allow a small overflow so the panel can go slightly outside the image.
                const overflow = 4;
                const minLeft = bRect.left - oRect.left - overflow;
                const minTop  = bRect.top  - oRect.top  - overflow;
                const maxLeft = minLeft + bRect.width  - pRect.width + (overflow * 2);
                const maxTop  = minTop  + bRect.height - pRect.height + (overflow * 2);
                const newTop  = Math.max(minTop,  Math.min(maxTop,  rawTop));
                panel.style.left = Math.max(minLeft, Math.min(maxLeft, rawLeft)) + 'px';
                panel.style.top  = newTop + 'px';
                setPanelMaxHeight(newTop, bRect, oRect);
            }

            function onUp() {
                panel.style.cursor = 'grab';
                document.body.style.cursor = '';
                // Release width lock so panel can resize naturally again
                panel.style.width = '';
                imoPanelPositions.single = {
                    left: parseFloat(panel.style.left),
                    top:  parseFloat(panel.style.top)
                };
                saveImoPanelPositions();
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup',   onUp);
            }

            panel.style.cursor = 'grabbing';
            document.body.style.cursor = 'grabbing';
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup',   onUp);
        });

        // ── Touch drag (mirrors mouse logic, with max-height update) ────────
        panel.addEventListener('touchstart', (e) => {
            const fromInteractive = INTERACTIVE_TAGS.has(e.target.tagName);
            if (fromInteractive) return;

            // Single-finger drag only — two fingers are for pinch/pan on the image
            if (e.touches.length !== 1) return;

            const lbOverlay = document.getElementById('lightbox-overlay');
            if (lbOverlay?._setMousedownInsideContent) lbOverlay._setMousedownInsideContent(true);

            e.stopPropagation();

            const touch      = e.touches[0];
            const startLeft  = parseFloat(panel.style.left);
            const startTop   = parseFloat(panel.style.top);
            const startX     = touch.clientX;
            const startY     = touch.clientY;
            const startWidth = panel.getBoundingClientRect().width;
            let   dragging   = false;

            function onTouchMove(e) {
                if (e.touches.length !== 1) return;
                const t  = e.touches[0];
                const dx = t.clientX - startX;
                const dy = t.clientY - startY;

                // Small threshold before committing to drag so taps don't move the panel
                if (!dragging) {
                    if (Math.sqrt(dx * dx + dy * dy) < 6) return;
                    dragging = true;
                    panel.style.width = startWidth + 'px';
                }

                e.preventDefault(); // suppress page scroll once dragging

                const imgEl    = imageWrapper.querySelector('.lightbox-image');
                const boundsEl = imgEl || overlay;
                const bRect    = boundsEl.getBoundingClientRect();
                const oRect    = overlay.getBoundingClientRect();
                const pRect    = panel.getBoundingClientRect();
                const overflow = 4;
                const minLeft  = bRect.left - oRect.left - overflow;
                const minTop   = bRect.top  - oRect.top  - overflow;
                const maxLeft  = minLeft + bRect.width  - pRect.width  + (overflow * 2);
                const maxTop   = minTop  + bRect.height - pRect.height + (overflow * 2);
                const newTop   = Math.max(minTop, Math.min(maxTop, startTop + dy));
                panel.style.left = Math.max(minLeft, Math.min(maxLeft, startLeft + dx)) + 'px';
                panel.style.top  = newTop + 'px';
                setPanelMaxHeight(newTop, bRect, oRect);
            }

            function onTouchEnd() {
                if (dragging) {
                    panel.style.width = '';
                    imoPanelPositions.single = {
                        left: parseFloat(panel.style.left),
                        top:  parseFloat(panel.style.top)
                    };
                    saveImoPanelPositions();
                }
                document.removeEventListener('touchmove', onTouchMove);
                document.removeEventListener('touchend',  onTouchEnd);
            }

            document.addEventListener('touchmove', onTouchMove, { passive: false });
            document.addEventListener('touchend',  onTouchEnd);
        }, { passive: true });
    });
}

function imoRow(label, value) {
    return `<div class="imo-row"><span class="imo-label">${label}</span><span class="imo-value">${value}</span></div>`;
}

function imoGamutRow(label, pct, color) {
    return `<div class="imo-row imo-gamut-row">
        <span class="imo-label">${label}</span>
        <span class="gamut-bar-wrap"><span class="gamut-bar" style="width:${pct}%;background:${color}"></span></span>
        <span class="imo-pct">${pct}%</span>
    </div>`;
}

// ─── Shared Modal Helpers ─────────────────────────────────────────────────────

async function searchRawg(query) {
    const url = `https://api.rawg.io/api/games?key=${CONFIG.rawgKey}&search=${encodeURIComponent(query)}&page_size=8`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('RAWG request failed');
    const data = await res.json();
    return data.results || [];
}

// Wires up game-search behaviour on an already-rendered modal DOM.
// Expects: .game-search-input, .game-search-results inside `modal`.
// `onSelect(name)` is called whenever the user confirms a name (click or blur).
function _setupGameSearch(modal, initialValue, onSelect) {
    const searchInput = modal.querySelector('.game-search-input');
    const resultsEl   = modal.querySelector('.game-search-results');
    if (!searchInput || !resultsEl) return;

    if (initialValue) searchInput.value = initialValue;

    const modalEl = searchInput.closest('.modal');
    const modalBody = searchInput.closest('.modal-body');

    function showResults() {
        resultsEl.style.display = 'flex';
        if (modalBody) modalBody.style.overflow = 'visible';
        if (modalEl)   modalEl.style.overflow   = 'visible';
    }

    function hideResults() {
        resultsEl.innerHTML = '';
        resultsEl.style.display = 'none';
        if (modalBody) modalBody.style.overflow = '';
        if (modalEl)   modalEl.style.overflow   = '';
    }

    async function doSearch() {
        const q = searchInput.value.trim();
        if (!q) return;
        resultsEl.innerHTML = '<div class="game-search-status">Searching…</div>';
        showResults();
        try {
            const results = await searchRawg(q);
            resultsEl.innerHTML = '';
            if (results.length === 0) {
                resultsEl.innerHTML = '<div class="game-search-status">No results found</div>';
                showResults();
                return;
            }
            results.forEach(game => {
                const item = document.createElement('div');
                item.className = 'game-result-item';
                item.textContent = game.name + (game.released ? ` (${game.released.slice(0, 4)})` : '');
                item.onclick = () => {
                    onSelect(game.name);
                    searchInput.value = game.name;
                    hideResults();
                };
                resultsEl.appendChild(item);
            });
            showResults();
        } catch (_) {
            resultsEl.innerHTML = '<div class="game-search-status">Search failed</div>';
            showResults();
        }
    }

    let debounceTimer = null;
    let highlightedIndex = -1;

    searchInput.addEventListener('input', () => {
        onSelect(searchInput.value.trim() || null);
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(doSearch, 350);
    });

    function getItems() { return Array.from(resultsEl.querySelectorAll('.game-result-item')); }

    function setHighlight(idx) {
        const items = getItems();
        items.forEach(el => el.classList.remove('game-result-item-highlighted'));
        highlightedIndex = Math.max(-1, Math.min(idx, items.length - 1));
        if (highlightedIndex >= 0) {
            items[highlightedIndex].classList.add('game-result-item-highlighted');
            items[highlightedIndex].scrollIntoView({ block: 'nearest' });
        }
    }

    searchInput.addEventListener('keydown', (e) => {
        const items = getItems();
        if (e.key === 'ArrowDown')       { e.preventDefault(); setHighlight(highlightedIndex + 1); }
        else if (e.key === 'ArrowUp')    { e.preventDefault(); setHighlight(highlightedIndex - 1); }
        else if (e.key === 'Enter') {
            e.preventDefault();
            if (highlightedIndex >= 0 && items[highlightedIndex]) {
                items[highlightedIndex].click(); highlightedIndex = -1;
            } else { clearTimeout(debounceTimer); doSearch(); }
        } else if (e.key === 'Escape') {
            e.stopPropagation();
            hideResults(); highlightedIndex = -1;
        }
    });
    searchInput.addEventListener('blur', () => {
        setTimeout(() => {
            // If the HDR dropdown is open, only clear the results visually.
            // Resetting modal overflow here would collapse the HDR dropdown.
            if (modalEl?.querySelector('.hdr-trigger-open')) {
                resultsEl.innerHTML = '';
                resultsEl.style.display = 'none';
                return;
            }
            hideResults();
        }, 150);
    });
}

// Builds and wires up the custom HDR type dropdown inside `wrapEl`.
// Returns { getValue() } so callers can read the selected value on submit.
function _buildHdrDropdown(wrapEl, initialValue) {
    const trigger  = wrapEl.querySelector('.hdr-custom-trigger');
    const dropdown = wrapEl.querySelector('.hdr-custom-dropdown');
    const label    = wrapEl.querySelector('.hdr-custom-label');
    const modal    = wrapEl.closest('.modal');

    let selected = initialValue || null;

    function setValue(val) {
        selected = val || null;
        const def = HDR_TYPES.find(t => t.id === val);
        label.textContent = def ? def.label : 'Unspecified';
        dropdown.querySelectorAll('.hdr-custom-item').forEach(el =>
            el.classList.toggle('hdr-custom-item-active', el.dataset.value === (val || '')));
    }

    function closeDropdown() {
        dropdown.style.display = 'none';
        trigger.classList.remove('hdr-trigger-open');
        const mb = modal?.querySelector('.modal-body'); if (mb) mb.style.overflow = '';
        if (modal) modal.style.overflow = '';
    }

    // None item
    const noneItem = document.createElement('div');
    noneItem.className = 'hdr-custom-item';
    noneItem.dataset.value = '';
    noneItem.textContent = 'Unspecified';
    noneItem.addEventListener('mousedown', e => { e.preventDefault(); setValue(''); closeDropdown(); });
    dropdown.appendChild(noneItem);

    [...new Set(HDR_TYPES.map(t => t.group))].forEach(groupName => {
        const gh = document.createElement('div');
        gh.className = 'hdr-custom-group-header';
        gh.textContent = '▸ ' + groupName;
        dropdown.appendChild(gh);
        HDR_TYPES.filter(t => t.group === groupName).forEach(type => {
            const item = document.createElement('div');
            item.className = 'hdr-custom-item hdr-custom-item-indented';
            item.dataset.value = type.id;
            item.textContent = type.label;
            item.addEventListener('mousedown', e => { e.preventDefault(); setValue(type.id); closeDropdown(); });
            dropdown.appendChild(item);
        });
    });

    dropdown.addEventListener('mousedown', e => e.preventDefault());
    trigger.addEventListener('mousedown', e => {
        e.preventDefault();
        if (dropdown.style.display === 'flex') { closeDropdown(); } else {
            dropdown.style.display = 'flex';
            trigger.classList.add('hdr-trigger-open');
            const mb = modal?.querySelector('.modal-body'); if (mb) mb.style.overflow = 'visible';
            if (modal) modal.style.overflow = 'visible';
            // Blur any focused input (e.g. game search) to stop the cursor blinking.
            // Safe now: _setupGameSearch blur handler checks for hdr-trigger-open
            // and skips the overflow reset, so the HDR dropdown won't be occluded.
            const _focusedInput = modal?.querySelector('input:focus');
            if (_focusedInput) _focusedInput.blur();
        }
    });
    if (modal) {
        modal.addEventListener('mousedown', e => {
            if (dropdown.style.display === 'flex' && !e.target.closest(wrapEl.id ? `#${wrapEl.id}` : '.hdr-custom-select-wrap')) closeDropdown();
        });
    }

    setValue(initialValue ?? '');
    return { getValue: () => selected };
}

// ─── Import Modal ─────────────────────────────────────────────────────────────

function showImportModal(fileCount, files = []) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';

        const modal = document.createElement('div');
        modal.className = 'modal';

        const fileListItems = files.map(f => `<li class="modal-file-list-item">
            <svg class="modal-file-icon" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
            <span class="modal-file-name">${f.name}</span>
        </li>`).join('');

        modal.innerHTML = `
            <div class="modal-header">
                <span class="modal-title">${fileCount} image${fileCount === 1 ? '' : 's'} ready to import</span>
                <span class="modal-subtitle">Set game name and HDR type for this batch</span>
            </div>
            <div class="modal-body">
                ${fileListItems ? `<ul class="modal-file-list">${fileListItems}</ul>` : ''}
                <div class="modal-section-label">Game Name</div>
                <div class="game-search-wrap">
                    <div class="game-search-row">
                        <svg class="game-search-icon" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                        <input class="game-search-input" type="text" placeholder="Search game…" autocomplete="off" />
                    </div>
                    <div class="game-search-results"></div>
                </div>
                <div class="modal-section-label modal-section-label-hdr">HDR Type</div>
                <div class="hdr-custom-select-wrap" id="importHdrWrap">
                    <div class="game-search-row modal-select-row hdr-custom-trigger">
                        <svg class="game-search-icon" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                        <span class="hdr-custom-label">Unspecified</span>
                        <svg class="hdr-custom-chevron" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#888" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                    </div>
                    <div class="hdr-custom-dropdown"></div>
                </div>
                <div class="modal-section-label modal-section-label-info">Additional Info</div>
                <div class="game-search-row">
                    <svg class="game-search-icon" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
                    <input type="text" class="modal-additional-info-input" autocomplete="off" />
                </div>
                <label class="modal-spoiler-label">
                    <input type="checkbox" class="modal-spoiler-checkbox" />
                    Mark as spoiler
                </label>
            </div>
            <div class="modal-footer">
                <button class="button-secondary modal-cancel">Cancel</button>
                <button class="modal-import">Import</button>
            </div>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        document.body.style.overflow = 'hidden';
        document.documentElement.style.overflow = 'hidden';

        const importBtn   = modal.querySelector('.modal-import');
        const searchInput = modal.querySelector('.game-search-input');

        let selectedGameName = null;
        _setupGameSearch(modal, null, (name) => { selectedGameName = name; });

        const hdrDropdown = _buildHdrDropdown(modal.querySelector('#importHdrWrap'), null);

        modal.querySelector('.modal-cancel').onclick = () => {
            document.body.style.overflow = '';
            document.documentElement.style.overflow = '';
            overlay.remove();
            document.removeEventListener('keydown', onImportKeydown, true);
            resolve(null);
        };

        importBtn.onclick = () => {
            const spoiler = modal.querySelector('.modal-spoiler-checkbox').checked;
            const additionalInfo = modal.querySelector('.modal-additional-info-input').value.trim() || null;
            document.body.style.overflow = '';
            document.documentElement.style.overflow = '';
            overlay.remove();
            document.removeEventListener('keydown', onImportKeydown, true);
            resolve({ hdrType: hdrDropdown.getValue() ?? 'unknown', gameName: selectedGameName, spoiler, additionalInfo });
        };

        let importMousedownOnModal = false;
        modal.addEventListener('mousedown', () => { importMousedownOnModal = true; });
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) importMousedownOnModal = false; });
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay && !importMousedownOnModal) {
                document.body.style.overflow = '';
                document.documentElement.style.overflow = '';
                overlay.remove();
                document.removeEventListener('keydown', onImportKeydown, true);
                resolve(null);
            }
            importMousedownOnModal = false;
        });

        const onImportKeydown = (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                document.body.style.overflow = '';
                document.documentElement.style.overflow = '';
                overlay.remove();
                document.removeEventListener('keydown', onImportKeydown, true);
                resolve(null);
            }
        };
        document.addEventListener('keydown', onImportKeydown, true);

        // Focus search input on open
        requestAnimationFrame(() => searchInput.focus());
    });
}

// ─── Edit Modal ───────────────────────────────────────────────────────────────

function showEditModal(currentHdrType, currentGameName, currentSpoiler, thumbUrl, currentAdditionalInfo) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';

        const modal = document.createElement('div');
        modal.className = 'modal';

        modal.innerHTML = `
            <div class="modal-header">
                <span class="modal-title">Edit Details</span>
                <span class="modal-subtitle">Set game name and HDR type for this batch</span>
                ${thumbUrl ? `<img class="modal-thumb" src="${thumbUrl}" alt="Preview" />` : ''}
            </div>
            <div class="modal-body">
                <div class="modal-section-label">Game Name</div>
                <div class="game-search-wrap">
                    <div class="game-search-row">
                        <svg class="game-search-icon" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                        <input class="game-search-input" type="text" placeholder="Search game…" autocomplete="off" value="${currentGameName || ''}" />
                    </div>
                    <div class="game-search-results"></div>
                </div>
                <div class="modal-section-label modal-section-label-hdr">HDR Type</div>
                <div class="hdr-custom-select-wrap" id="editHdrWrap">
                    <div class="game-search-row modal-select-row hdr-custom-trigger">
                        <svg class="game-search-icon" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                        <span class="hdr-custom-label">Unspecified</span>
                        <svg class="hdr-custom-chevron" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#888" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                    </div>
                    <div class="hdr-custom-dropdown"></div>
                </div>
                <div class="modal-section-label modal-section-label-info">Additional Info</div>
                <div class="game-search-row">
                    <svg class="game-search-icon" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
                    <input type="text" class="modal-additional-info-input" autocomplete="off" value="${currentAdditionalInfo || ''}"/>
                </div>
                <label class="modal-spoiler-label">
                    <input type="checkbox" class="modal-spoiler-checkbox" ${currentSpoiler ? 'checked' : ''} />
                    Mark as spoiler
                </label>
            </div>
            <div class="modal-footer">
                <button class="button-secondary modal-cancel">Cancel</button>
                <button class="modal-import">Save</button>
            </div>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        document.body.style.overflow = 'hidden';
        document.documentElement.style.overflow = 'hidden';

        const saveBtn = modal.querySelector('.modal-import');

        let selectedGameName = currentGameName || null;
        _setupGameSearch(modal, currentGameName, (name) => { selectedGameName = name; });

        const hdrDropdown = _buildHdrDropdown(modal.querySelector('#editHdrWrap'), currentHdrType);

        // Escape closes the modal (without leaking to the lightbox behind)
        const onModalKeydown = (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                document.body.style.overflow = '';
                document.documentElement.style.overflow = '';
                overlay.remove();
                document.removeEventListener('keydown', onModalKeydown, true);
                resolve(null);
            }
        };
        document.addEventListener('keydown', onModalKeydown, true);

        modal.querySelector('.modal-cancel').onclick = () => {
            document.body.style.overflow = '';
            document.documentElement.style.overflow = '';
            overlay.remove();
            document.removeEventListener('keydown', onModalKeydown, true);
            resolve(null);
        };

        saveBtn.onclick = () => {
            const spoiler = modal.querySelector('.modal-spoiler-checkbox').checked;
            const additionalInfo = modal.querySelector('.modal-additional-info-input').value.trim() || null;
            document.body.style.overflow = '';
            document.documentElement.style.overflow = '';
            overlay.remove();
            document.removeEventListener('keydown', onModalKeydown, true);
            resolve({ hdrType: hdrDropdown.getValue() ?? 'unknown', gameName: selectedGameName, spoiler, additionalInfo });
        };

        let editMousedownOnModal = false;
        modal.addEventListener('mousedown', () => { editMousedownOnModal = true; });
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) editMousedownOnModal = false; });
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay && !editMousedownOnModal) {
            document.body.style.overflow = '';
            document.documentElement.style.overflow = '';
                overlay.remove();
                document.removeEventListener('keydown', onModalKeydown, true);
                resolve(null);
            }
            editMousedownOnModal = false;
        });

        // Focus search input
        requestAnimationFrame(() => searchInput.focus());
    });
}

// ─── Filter Bar ───────────────────────────────────────────────────────────────

// ─── Gallery Search Bar ───────────────────────────────────────────────────────

function buildFilterBar(allItems) {
    const bar = document.getElementById('filterBar');
    if (!bar || bar.dataset.built) return;
    bar.dataset.built = '1';

    // Collect all unique game names for autocomplete
    const gameNames = [...new Set(
        allItems.map(item => item.gameName).filter(Boolean)
    )].sort((a, b) => a.localeCompare(b));

    // Count images per game
    const gameCountMap = {};
    allItems.forEach(item => {
        if (item.gameName) gameCountMap[item.gameName] = (gameCountMap[item.gameName] || 0) + 1;
    });

    bar.innerHTML = `
        <div class="filter-bar-inner">
            <div class="gallery-search-wrap">
                <div class="gallery-search-field">
                    <svg class="gallery-search-icon" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                    <input
                        id="gallerySearchInput"
                        class="gallery-search-input"
                        type="text"
                        placeholder="Search game…"
                        autocomplete="off"
                        value="${gameSearchQuery}"
                    />
                    <button id="gallerySearchClear" class="gallery-search-clear" style="display:${gameSearchQuery ? 'flex' : 'none'};" aria-label="Clear search">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                </div>
                <div id="gallerySearchDropdown" class="gallery-search-dropdown"></div>
            </div>
            <div class="view-toggle" role="group" aria-label="Gallery view mode" style="display:${gameSearchQuery.trim() ? 'flex' : 'none'}">
                <button class="view-toggle-btn${gameViewMode === 'list' ? ' active' : ''}" data-view="list" title="List view" aria-label="List view">
                    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><rect x="3" y="11" width="18" height="4" rx="1"/><rect x="3" y="18" width="18" height="4" rx="1"/></svg>
                </button>
                <button class="view-toggle-btn${gameViewMode === 'grid2' ? ' active' : ''}" data-view="grid2" title="2-column view" aria-label="2-column view">
                    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
                </button>
                <button class="view-toggle-btn${gameViewMode === 'grid3' ? ' active' : ''}" data-view="grid3" title="3-column view" aria-label="3-column view">
                    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="5" height="7" rx="1"/><rect x="9.5" y="3" width="5" height="7" rx="1"/><rect x="17" y="3" width="5" height="7" rx="1"/><rect x="2" y="14" width="5" height="7" rx="1"/><rect x="9.5" y="14" width="5" height="7" rx="1"/><rect x="17" y="14" width="5" height="7" rx="1"/></svg>
                </button>
            </div>
            <span id="filterBarCount" class="filter-bar-count"></span>
        </div>
    `;

    const input      = bar.querySelector('#gallerySearchInput');
    const clearBtn   = bar.querySelector('#gallerySearchClear');
    const dropdown   = bar.querySelector('#gallerySearchDropdown');

    function showSuggestions(query) {
        const q = query.trim().toLowerCase();
        dropdown.innerHTML = '';

        if (!q) {
            // Show top 5 games by image count
            const countMap = new Map();
            _allGalleryItems.forEach(item => {
                if (item.gameName) countMap.set(item.gameName, (countMap.get(item.gameName) || 0) + 1);
            });
            const top5 = [...countMap.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5);

            if (top5.length === 0) { dropdown.style.display = 'none'; return; }

            const header = document.createElement('div');
            header.className = 'gallery-search-dropdown-header';
            header.textContent = '-Top Images-';
            dropdown.appendChild(header);

            top5.forEach(([name, count]) => {
                const item = document.createElement('div');
                item.className = 'gallery-search-suggestion';
                const nameSpan = document.createElement('span');
                nameSpan.textContent = name;
                const countSpan = document.createElement('span');
                countSpan.className = 'gallery-search-suggestion-count';
                countSpan.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>${count}`;
                item.appendChild(nameSpan);
                item.appendChild(countSpan);
                item.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    gameSearchQuery = name;
                    input.value = name;
                    clearBtn.style.display = 'flex';
                    dropdown.innerHTML = '';
                    dropdown.style.display = 'none';
                    renderGallery(_allGalleryItems);
                });
                dropdown.appendChild(item);
            });
            dropdown.style.display = 'flex';
            return;
        }

        const matches = gameNames.filter(n => n.toLowerCase().includes(q));
        if (matches.length === 0) { dropdown.style.display = 'none'; return; }

        matches.forEach(name => {
            const item = document.createElement('div');
            item.className = 'gallery-search-suggestion';
            // Highlight matching part
            const idx = name.toLowerCase().indexOf(q);
            const countSpan = document.createElement('span');
            countSpan.className = 'gallery-search-suggestion-count';
            countSpan.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>${gameCountMap[name] || 0}`;
            item.innerHTML = `<span>${name.slice(0, idx)}<mark>${name.slice(idx, idx + q.length)}</mark>${name.slice(idx + q.length)}</span>`;
            item.appendChild(countSpan);
            item.addEventListener('mousedown', (e) => {
                e.preventDefault(); // prevent input blur before click fires
                gameSearchQuery = name;
                input.value = name;
                clearBtn.style.display = 'flex';
                dropdown.innerHTML = '';
                dropdown.style.display = 'none';
                renderGallery(_allGalleryItems);
            });
            dropdown.appendChild(item);
        });
        dropdown.style.display = 'flex';
    }

    let debounce = null;
    input.addEventListener('input', () => {
        gameSearchQuery = input.value;
        clearBtn.style.display = input.value ? 'flex' : 'none';
        clearTimeout(debounce);
        debounce = setTimeout(() => {
            showSuggestions(input.value);
            renderGallery(_allGalleryItems);
        }, 180);
    });

    let galleryHighlightedIndex = -1;

    function getGallerySuggestions() {
        return Array.from(dropdown.querySelectorAll('.gallery-search-suggestion'));
    }

    function setGalleryHighlight(idx) {
        const items = getGallerySuggestions();
        items.forEach(el => el.classList.remove('gallery-search-suggestion-highlighted'));
        galleryHighlightedIndex = Math.max(-1, Math.min(idx, items.length - 1));
        if (galleryHighlightedIndex >= 0) {
            items[galleryHighlightedIndex].classList.add('gallery-search-suggestion-highlighted');
            items[galleryHighlightedIndex].scrollIntoView({ block: 'nearest' });
        }
    }

    input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setGalleryHighlight(galleryHighlightedIndex + 1);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setGalleryHighlight(galleryHighlightedIndex - 1);
        } else if (e.key === 'Enter') {
            const items = getGallerySuggestions();
            if (galleryHighlightedIndex >= 0 && items[galleryHighlightedIndex]) {
                items[galleryHighlightedIndex].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                galleryHighlightedIndex = -1;
            } else {
                dropdown.innerHTML = '';
                dropdown.style.display = 'none';
                renderGallery(_allGalleryItems);
            }
        } else if (e.key === 'Escape') {
            dropdown.innerHTML = '';
            dropdown.style.display = 'none';
            galleryHighlightedIndex = -1;
            input.blur();
        }
    });

    input.addEventListener('focus', () => showSuggestions(input.value));
    input.addEventListener('blur', () => {
        // Delay so mousedown on suggestion fires first
        setTimeout(() => { dropdown.innerHTML = ''; dropdown.style.display = 'none'; }, 160);
    });

    // Close dropdown when clicking anywhere outside the search bar.
    // blur alone isn't reliable — clicks on non-focusable elements (gallery
    // images, the banner, empty space) don't steal focus so blur never fires.
    const _searchBarRoot = bar.querySelector('.gallery-search-bar') || bar;
    function _galleryDropdownOutsideClick(e) {
        if (dropdown.style.display !== 'none' && !_searchBarRoot.contains(e.target)) {
            dropdown.innerHTML = '';
            dropdown.style.display = 'none';
            galleryHighlightedIndex = -1;
        }
    }
    document.addEventListener('mousedown', _galleryDropdownOutsideClick);

    clearBtn.addEventListener('mousedown', e => e.preventDefault());
    clearBtn.addEventListener('click', () => {
        gameSearchQuery = '';
        input.value = '';
        clearBtn.style.display = 'none';
        renderGallery(_allGalleryItems);
        showSuggestions('');
    });

    // View toggle buttons
    bar.querySelectorAll('.view-toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            setGalleryViewMode(btn.dataset.view);
        });
    });
}

function applyFilters(items) {
    if (!gameSearchQuery.trim()) return items;
    const q = gameSearchQuery.trim().toLowerCase();
    return items.filter(item => (item.gameName || '').toLowerCase().includes(q));
}

// ─── Event Listeners ─────────────────────────────────────────────────────────

fileInput.addEventListener('change', async () => {
    const selectedFiles = Array.from(fileInput.files || []);
    if (selectedFiles.length) await processFiles(selectedFiles);
});

// Initialize gallery on page load
document.addEventListener('DOMContentLoaded', async () => {
    // Read params BEFORE refreshGallery - renderGallery calls _syncGameUrl('')
    // which would wipe ?game= from the URL before we could read it.
    const _initialParams = new URLSearchParams(location.search);
    const _gameParam = _initialParams.get('game');
    const _imgParam  = _initialParams.get('img');

    if (_gameParam) gameSearchQuery = _gameParam;

    await refreshGallery();

    // Wire the search input to show the pre-set game filter
    if (_gameParam && _allGalleryItems.length) {
        const input    = document.getElementById('gallerySearchInput');
        const clearBtn = document.getElementById('gallerySearchClear');
        if (input)    input.value = _gameParam;
        if (clearBtn) clearBtn.style.display = 'flex';
    }

    // Deep-link: if the URL contains ?img=<firestoreId>, open that image's lightbox
    if (_imgParam && _allGalleryItems.length) {
        const _targetItem = _allGalleryItems.find(it => it.id === _imgParam);
        if (_targetItem) {
            const _visibleItems = applyFilters(_allGalleryItems);
            const _startIdx = _visibleItems.findIndex(it => it.id === _targetItem.id);
            openLightbox(_visibleItems, Math.max(0, _startIdx));
        }
    }
});

// Clean up URLs when page unloads
// Re-decode the current lightbox image (and neighbours) when the window becomes visible again.
// The GPU discards decoded bitmaps on minimize, so we kick off decode proactively
// while the OS is still compositing the window restore — by the time the first
// paint lands the bitmap is ready.
document.addEventListener('visibilitychange', () => {
    if (document.hidden || !lightboxOpen) return;

    // GPU dropped all bitmaps on minimize — clear stale promises and reset pool so we re-decode fresh.
    _decodePromises.clear();
    _prefetchedImages.clear();
    _lbPoolSlots.clear();
    if (_lbDecodePool) _lbDecodePool.innerHTML = '';

    // Build outward priority list: current first, then next/prev alternating outward
    const indices = [lightboxIndex];
    for (let d = 1; d < lightboxBatch.length; d++) {
        if (lightboxIndex + d < lightboxBatch.length) indices.push(lightboxIndex + d);
        if (lightboxIndex - d >= 0)                   indices.push(lightboxIndex - d);
    }

    indices.forEach((i, slot) => {
        const entry = lightboxBlobUrls.get(lightboxBatch[i]?.id);
        if (!entry) return;
        setTimeout(() => {
            const _t = performance.now();
            const poolImg = _poolPrefetch(entry.fullUrl);
            if (!poolImg) return;
            const promise = poolImg.decode().then(() => {
                console.log(`[lightbox] visibility restore decode complete: "${lightboxBatch[i].name}" (slot ${slot})  +${(performance.now()-_t).toFixed(1)}ms`);
            }).catch(() => {});
            _decodePromises.set(entry.fullUrl, promise);
        }, slot * 150);
    });
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
    // Ignore if typing in an input field
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    // All shortcuts only active when lightbox is open
    if (!lightboxOpen) return;

    // Escape: close lightbox
    if (e.key === 'Escape') {
        e.preventDefault();
        closeLightbox();
        return;
    }

    // Arrow navigation — throttle renders so holding an arrow key scrubs smoothly
    // through images (like Discord) rather than debouncing to the final image.
    // _arrowThrottleLast lives outside this handler so it persists across key-repeat events.
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const direction = e.key === 'ArrowLeft' ? -1 : 1;
        const newIndex = lightboxIndex + direction;
        if (newIndex < 0 || newIndex >= lightboxBatch.length) return;
        lightboxIndex = newIndex;

        // Always update filmstrip highlight immediately for visual feedback
        const filmstrip = document.querySelector('.lightbox-filmstrip');
        if (filmstrip) {
            filmstrip.querySelectorAll('.lightbox-filmstrip-item').forEach((t, i) => {
                t.classList.toggle('lightbox-filmstrip-thumb-active', i === lightboxIndex);
            });
            const active = filmstrip.querySelector('.lightbox-filmstrip-thumb-active');
            if (active) active.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'instant' });
        }

        // Throttle full renders to ~80ms — fires on the first press immediately,
        // then at most once per 80ms while held, so images flow smoothly.
        const now = performance.now();
        const elapsed = now - _arrowThrottleLast;
        clearTimeout(_arrowThrottleTimer);
        if (elapsed >= 80) {
            // Enough time has passed — render immediately
            _arrowThrottleLast = now;
            if (_lightboxRender) _lightboxRender();
        } else {
            // Too soon — schedule a trailing render for when the throttle window expires
            // so the final destination is always rendered after key-release.
            _arrowThrottleTimer = setTimeout(() => {
                _arrowThrottleLast = performance.now();
                if (_lightboxRender) _lightboxRender();
            }, 80 - elapsed);
        }
        return;
    }

    // Toggle Analysis Tool with 'A' key
    if (e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        toggleGlobalDetailsMode();
    }

    // Toggle SDR Slider with 'S' key
    if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        if (currentVisibleImage) {
            const imageData = imageWrappers.get(currentVisibleImage);
            if (imageData?.compareButton) imageData.compareButton.click();
        }
    }

    // Toggle SDR/HDR pill with 'D' key
    if (e.key === 'd' || e.key === 'D') {
        e.preventDefault();
        if (currentVisibleImage) {
            const imageData = imageWrappers.get(currentVisibleImage);
            if (imageData?.sdrToggle) imageData.sdrToggle.click();
        }
    }
});