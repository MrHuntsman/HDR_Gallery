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
};
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

// ─── File Handling ────────────────────────────────────────────────────────────

// Supported formats
const NATIVE_EXTENSIONS = [];                        // all formats now go through AVIF re-encode pipeline
const CONVERT_EXTENSIONS = ['.png', '.jxr', '.exr', '.hdr', '.avif']; // all converted to AVIF on import
const ALL_EXTENSIONS = [...NATIVE_EXTENSIONS, ...CONVERT_EXTENSIONS];

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
    const filename = file && file.name ? file.name : '';
    const extension = getFileExtension(filename);
    return ALL_EXTENSIONS.includes(extension);
}

function needsConversion(file) {
    const ext = getFileExtension(file.name || '');
    return CONVERT_EXTENSIONS.includes(ext);
}

// ─── UI State & Globals ──────────────────────────────────────────────────────

const fileInput = document.getElementById('fileInput');
const galleryContainer = document.getElementById('gallery');
const statusMessage = document.getElementById('statusMessage');
const dropZone = document.getElementById('dropZone');

// Track created URLs for cleanup
let createdUrls = [];
// Lightbox blob URLs are tracked separately so refreshGallery() doesn't revoke them while lightbox is open
let lightboxCreatedUrls = [];

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
    const gamutClass = gamut === 'BT.2020' ? 'nit-grid__gamut--2020' : gamut === 'DCI-P3' ? 'nit-grid__gamut--p3' : 'nit-grid__gamut--709';
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

function revokeAllUrls() {
    createdUrls.forEach(url => URL.revokeObjectURL(url));
    createdUrls = [];
}

function revokeLightboxUrls() {
    lightboxCreatedUrls.forEach(url => URL.revokeObjectURL(url));
    lightboxCreatedUrls = [];
}

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
        // If lightbox is open, start pixel decode now and show details
        if (lightboxOpen) {
            const imgEl = document.querySelector('.lightbox-image');
            if (imgEl) imgEl.classList.add('cursor-nit-hunt');
            const container = document.querySelector('.lightbox-image-container');
            if (container) container.classList.add('cursor-nit-hunt');
            // Kick off decode for the current image now that analysis tool is on
            const currentItem = lightboxBatch[lightboxIndex];
            if (currentItem) _startPixelDecode(currentItem);
            if (currentVisibleImage) showDetailsForImage(currentVisibleImage);
            // If cursor is already over the image, show nit tooltip immediately
            const imgElActive = document.querySelector('.lightbox-image');
            if (imgElActive && imgElActive.matches(':hover')) {
                imgElActive.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
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
    }
}

function updateAllDetailButtons(isActive) {
    document.querySelectorAll('.detail-button').forEach(button => {
        if (isActive) {
            button.classList.add('button-active');
            button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> <u>A</u>nalysis Tool';
        } else {
            button.classList.remove('button-active');
            button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" opacity="0.3"></path><circle cx="12" cy="12" r="3"></circle></svg> <u>A</u>nalysis Tool';
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
        showMetadataOverlay(imageItem.name, metadata, wrapper, null);
    }
}

function hideAllDetailsOverlays() {
    imageWrappers.forEach((imageData) => {
        const existing = imageData.wrapper.querySelector('.image-meta-overlay');
        if (existing) existing.remove();
    });
}

function checkVisibleImage() {
    const visibleImageId = findVisibleImageId();
    
    // If we found a visible image and it's different from current, update it
    if (visibleImageId && currentVisibleImage !== visibleImageId) {
        const previousImage = currentVisibleImage;
        currentVisibleImage = visibleImageId;
        
        // Only show/hide overlays if details mode is active
        if (globalDetailsEnabled) {
            // Hide previous image's overlay
            if (previousImage && imageWrappers.has(previousImage)) {
                const prevData = imageWrappers.get(previousImage);
                const existing = prevData.wrapper.querySelector('.image-meta-overlay');
                if (existing) existing.remove();
            }
            
            // Show new image's overlay
            showDetailsForImage(visibleImageId);
        }
    }
    // If no image is visible (null) but we had one before, keep the previous selection
    // This prevents losing track when scrolling quickly or during transitions
}

// Find the most visible image in the viewport
function findVisibleImageId() {
    const allWrappers = Array.from(document.querySelectorAll('.image-wrapper'));
    if (allWrappers.length === 0) return null;
    
    const viewportCenter = window.innerHeight / 2;
    let closestImage = null;
    let minDistance = Infinity;
    
    allWrappers.forEach(wrapper => {
        const rect = wrapper.getBoundingClientRect();
        const imageCenter = (rect.top + rect.bottom) / 2;
        const distance = Math.abs(imageCenter - viewportCenter);
        
        if (distance < minDistance) {
            minDistance = distance;
            closestImage = wrapper;
        }
    });
    
    return closestImage ? parseInt(closestImage.dataset.imageId) : null;
}

let visibilityCheckInterval = null;

function startVisibilityChecker() {
    if (visibilityCheckInterval) return;
    
    let scrollTimeout = null;
    
    // Check on scroll with debounce
    const handleScroll = () => {
        if (scrollTimeout) return; // Already scheduled
        
        scrollTimeout = setTimeout(() => {
            checkVisibleImage();
            scrollTimeout = null;
        }, 50); // 50ms debounce
    };
    
    window.addEventListener('scroll', handleScroll, { passive: true });
    
    // Also check periodically in case images load/resize
    visibilityCheckInterval = setInterval(checkVisibleImage, 100);
    
    // Initial check
    setTimeout(checkVisibleImage, 100);
    
    // Store cleanup function
    visibilityCheckInterval.cleanup = () => {
        window.removeEventListener('scroll', handleScroll);
        if (scrollTimeout) clearTimeout(scrollTimeout);
        clearInterval(visibilityCheckInterval);
        visibilityCheckInterval = null;
    };
}

function stopVisibilityChecker() {
    if (visibilityCheckInterval && visibilityCheckInterval.cleanup) {
        visibilityCheckInterval.cleanup();
    }
}

// ─── File Processing ─────────────────────────────────────────────────────────

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
    const importResult = await showImportModal(allowedFiles.length);
    if (importResult === null) {
        fileInput.value = '';
        return; // User cancelled
    }
    const { hdrType, gameName: importGameName } = importResult;

    const toConvert = allowedFiles.filter(needsConversion);
    const native = allowedFiles.filter(f => !needsConversion(f));

    // ── Per-step timing helpers ──────────────────────────────────────────────────
    const _importT0 = performance.now();
    function _importLog(label, startMs) {
        const elapsed = (performance.now() - startMs).toFixed(0);
        console.log(`[import] ${label}: ${elapsed} ms`);
    }

    try {
        // Pre-load ImageMagick if any files need conversion
        initProgress(allowedFiles.length, toConvert.length > 0);

        if (toConvert.length > 0) {
            const needsMagick = toConvert.some(f => getFileExtension(f.name) !== '.jxr');
            if (needsMagick) {
                setProgressStep('convert', 'Loading converter…');
                const _t = performance.now();
                await getMagick();
                _importLog('getMagick', _t);
            }
        }

        const batchId = generateBatchId();
        for (const file of allowedFiles) {
            // Advance the unified file counter once, before any step is set for this file
            advanceProgressFile();

            let hdrFile = file;
            let prebuiltSdr = null;
            let prebuiltThumb = null;

            // Convert to PNG first if needed
            if (needsConversion(file)) {
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


            let thumbBlob = prebuiltThumb;
            if (!thumbBlob) {
                _progressFileLabel = `Thumbnail: ${hdrFile.name}`;
                _renderProgress();
                const _t = performance.now();
                try {
                    thumbBlob = await generateThumb(hdrFile, 1280);
                    _importLog(`generateThumb: ${hdrFile.name}`, _t);
                    console.log('[processFiles] generateThumb done:', thumbBlob?.size);
                } catch (error) {
                    console.error('Thumbnail generation failed:', error);
                }
            } else {
                console.log('[processFiles] skipping generateThumb, using prebuilt thumb:', prebuiltThumb?.size);
            }


            _progressFileLabel = `Saving: ${hdrFile.name}`;
            _renderProgress();
            const _tSave = performance.now();
            console.log('[processFiles] storing — thumb:', thumbBlob?.size, 'sdr:', sdrBlob?.size);
            await addImageFile(hdrFile, metadata, sdrBlob, hdrType, batchId, thumbBlob, importGameName);
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
    revokeAllUrls();
    galleryContainer.innerHTML = '';
    imageWrappers.clear();
    currentVisibleImage = null;
    _galleryCards.clear();

    if (!allItems.length) {
        statusMessage.textContent = 'No HDR images yet. Drop or upload PNG, AVIF, JXR, EXR, HDR, TIFF, or HEIC files.';
        return;
    }

    // Build one card per batch
    const batchMap = new Map();
    for (const item of allItems) {
        const key = item.batchId || `solo_${item.id}`;
        if (!batchMap.has(key)) batchMap.set(key, []);
        batchMap.get(key).push(item);
    }
    for (const [key, batchItems] of batchMap.entries()) {
        const card = createCollageCard(batchItems);
        _galleryCards.set(key, card);
        galleryContainer.appendChild(card);
    }

    // statusMessage.textContent = `Found ${allItems.length} image${allItems.length === 1 ? '' : 's'}`;
}

// Detach/re-attach cards to match the current search query.
// Cards stay alive in _galleryCards (blob URLs preserved), only their DOM presence changes.
function renderGallery(allItems) {
    if (!allItems.length) return;

    const filtered = applyFilters(allItems);
    const visibleKeys = new Set();
    for (const item of filtered) {
        visibleKeys.add(item.batchId || `solo_${item.id}`);
    }

    // Use a DocumentFragment to batch all insertions in one reflow
    const fragment = document.createDocumentFragment();
    let visibleCount = 0;
    for (const [key, card] of _galleryCards.entries()) {
        if (visibleKeys.has(key)) {
            fragment.appendChild(card);
            visibleCount++;
        } else {
            // Detach without destroying — card retains its blob URLs and event listeners
            if (card.parentNode) card.parentNode.removeChild(card);
        }
    }
    galleryContainer.appendChild(fragment);

    // status message disabled
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

function createCollageCard(batchItems) {
    const card = document.createElement('div');
    card.className = 'collage-card';

    // Header: left spacer | centered game name | HDR type badge
    const header = document.createElement('div');
    header.className = 'collage-header';

    // Left spacer (keeps title visually centered when badge is present)
    header.appendChild(document.createElement('div'));

    const titleEl = document.createElement('span');
    titleEl.className = 'collage-title';
    titleEl.textContent = batchItems[0].gameName || 'Unknown Game';
    header.appendChild(titleEl);

    card.appendChild(header);

    // Collage grid
    const grid = document.createElement('div');
    const n = batchItems.length;
    grid.className = `collage-grid collage-grid-${Math.min(n, 5)}`;
    card.appendChild(grid);

    batchItems.forEach((item, idx) => {
        // Use Cloudinary thumbnail URL for gallery display, fall back to full HDR URL
        const url = item.thumbUrl || item.hdrUrl;

        const cell = document.createElement('div');
        cell.className = 'collage-cell';
        if (n >= 4 && idx === 0) cell.className += ' collage-cell-hero';

        const img = document.createElement('img');
        img.src = url;
        img.alt = item.name;
        img.className = 'collage-thumb';
        img.draggable = false;

        cell.appendChild(img);

        // On hover, pre-decode the full HDR image so the bitmap is GPU-ready
        // before the user clicks — eliminates the visible decode stall in the lightbox.
        cell.addEventListener('mouseenter', () => {
            if (_decodePromises.has(item.hdrUrl)) return; // already started
            const img = new Image();
            img.src = item.hdrUrl;
            const _pt = performance.now();
            const p = img.decode().then(() => {
                console.log(`[lightbox] hover prefetch decode complete for "${item.name}"  +${(performance.now()-_pt).toFixed(1)}ms`);
            }).catch(() => {});
            _decodePromises.set(item.hdrUrl, p);
        });

        cell.addEventListener('click', () => openLightbox(batchItems, idx));
        grid.appendChild(cell);
    });

    // ── HDR type label in header ──
    const hdrTypeId = batchItems[0].hdrType;
    const hdrTypeDef = HDR_TYPES.find(t => t.id === hdrTypeId);
    let hdrLabel = null;
    let hdrClass = '';
    if (hdrTypeDef && hdrTypeId !== 'unknown') {
        hdrLabel = hdrTypeDef.label;
        hdrClass = `collage-hdr-type--${hdrTypeId}`;
    } else if (!hdrTypeId) {
        const tc = batchItems[0].metadata?.luminanceStats?.transferCharacteristic;
        if (tc === 16 || tc === 18) { hdrLabel = 'Native HDR'; hdrClass = 'collage-hdr-type--nativeHdr'; }
    }
    if (hdrLabel) {
        const hdrEl = document.createElement('span');
        hdrEl.className = `collage-hdr-type ${hdrClass}`;
        hdrEl.textContent = hdrLabel;
        header.appendChild(hdrEl);
    } else {
        header.appendChild(document.createElement('div'));
    }

    return card;
}

// ─── Lightbox ─────────────────────────────────────────────────────────────────

let lightboxOpen = false;
let lightboxBatch = [];
let lightboxIndex = 0;
let lightboxPixelBuffer = null;
let lightboxPixelBuffers = new Map(); // imageId → buffer promise
let lightboxIsZooming = false;
let lightboxZoomScale = CONFIG.zoomScale;
let lightboxSdrActive = false;
let lightboxSdrToggleActive = false; // full SDR view (no slider)
let lightboxBlobUrls = new Map(); // imageId → { url, fullUrl, blob, sdrUrl }

// Shared decode promise cache — keyed by hdrUrl so hover prefetch and lightbox
// can share the same in-flight promise rather than racing each other.
const _decodePromises = new Map(); // hdrUrl → Promise<void>

// Lazily start pixel decode for a single item on demand.
// Called when the analysis tool is enabled or when navigating while it's on.
function _startPixelDecode(item) {
    if (lightboxPixelBuffers.has(item.id)) return;
    const entry = lightboxBlobUrls.get(item.id);
    if (!entry) return;
    const _t0 = window._lbT0 || performance.now();
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

function openLightbox(batchItems, startIndex) {
    if (lightboxOpen) closeLightbox();

    const _lbT0 = performance.now();
    console.log(`[lightbox] openLightbox() called  +0ms`);

    lightboxOpen = true;
    lightboxBatch = batchItems;
    lightboxIndex = startIndex;
    lightboxSdrActive = false;

    // Pre-create blob URLs for all images in the batch — reused on every navigation, no re-creation
    lightboxBlobUrls = new Map();
    lightboxBatch.forEach(item => {
        // Use Cloudinary URLs directly — no blob URL creation needed
        const fullUrl    = item.hdrUrl;
        const displayUrl = item.thumbUrl || item.hdrUrl;
        const sdrUrl     = item.sdrUrl   || null;
        lightboxBlobUrls.set(item.id, { url: displayUrl, fullUrl, blob: null, sdrUrl });
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
            const thumbs = filmstrip.querySelectorAll('.lightbox-filmstrip-thumb');
            if (thumbs.length === 0) { closeLightbox(); return; }
            const first = thumbs[0].getBoundingClientRect();
            const last  = thumbs[thumbs.length - 1].getBoundingClientRect();
            if (e.clientX < first.left || e.clientX > last.right) closeLightbox();
        }

        // Toolbar: close when clicking the empty left/center areas, not the buttons
        if ((e.target === toolbar || e.target === toolbarLeft || e.target === toolbarRight) && !toolbarCenter.contains(e.target)) {
            closeLightbox();
        }
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
    imageHeaderTitle.textContent = lightboxBatch[startIndex].gameName || 'Unknown Game';

    imageHeader.appendChild(imageHeaderTags);
    imageHeader.appendChild(imageHeaderTitle);
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

    // Left side: tags
    const toolbarLeft = document.createElement('div');
    toolbarLeft.className = 'lightbox-toolbar-left';
    toolbar.appendChild(toolbarLeft);

    // Center: game name
    const toolbarCenter = document.createElement('div');
    toolbarCenter.className = 'lightbox-toolbar-center';
    
    toolbar.appendChild(toolbarCenter);

    // Right side: action buttons
    const toolbarRight = document.createElement('div');
    toolbarRight.className = 'lightbox-toolbar-right';
    toolbar.appendChild(toolbarRight);

    // ── Filmstrip ──
    const filmstrip = document.createElement('div');
    filmstrip.className = 'lightbox-filmstrip';
    overlay.appendChild(filmstrip);

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

    // ── Action buttons ──

    const detailsBtn = document.createElement('button');
    detailsBtn.className = 'button-secondary detail-button' + (globalDetailsEnabled ? ' button-active' : '');
    detailsBtn.innerHTML = globalDetailsEnabled
        ? '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> <u>A</u>nalysis Tool'
        : '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" opacity="0.3"></path><circle cx="12" cy="12" r="3"></circle></svg> <u>A</u>nalysis Tool';
    detailsBtn.onclick = () => toggleGlobalDetailsMode();
    toolbarCenter.appendChild(detailsBtn);

    const compareBtn = document.createElement('button');
    compareBtn.className = 'button-secondary';
    compareBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 6H3"/><path d="m7 12-4-4 4-4"/><path d="M3 18h18"/><path d="m17 12 4 4-4 4"/></svg> <u>S</u>DR Slider';
    toolbarCenter.appendChild(compareBtn);

    const sdrToggleBtn = document.createElement('button');
    sdrToggleBtn.className = 'button-secondary';
    sdrToggleBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/></svg> SDR Toggle';
    toolbarCenter.appendChild(sdrToggleBtn);

    const saveBtn = document.createElement('button');
    saveBtn.className = 'button-secondary';
    saveBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Save HDR Image';

    function updateSaveBtn() {
        const isSdr = lightboxSdrToggleActive;
        saveBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Save ${isSdr ? 'SDR' : 'HDR'} Image`;
    }
    toolbarCenter.appendChild(saveBtn);

    const editBtn = document.createElement('button');
    editBtn.className = 'button-secondary';
    editBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Edit';
    toolbarCenter.appendChild(editBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'button-danger';
    deleteBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg> Delete';
    toolbarCenter.appendChild(deleteBtn);

    const deleteAllBtn = document.createElement('button');
    deleteAllBtn.className = 'button-danger';
    deleteAllBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg> Delete All';
    // Only show if batch has more than one image
    deleteAllBtn.style.display = lightboxBatch.length > 1 ? '' : 'none';
    toolbarCenter.appendChild(deleteAllBtn);

    // ── Hold-to-zoom ──
    let isZooming = false;
    let currentZoomScale = CONFIG.zoomScale;

    // ── Scroll-to-zoom (velocity + friction momentum) ──
    let scrollZoomCurrent = 1;    // displayed scale (the only truth)
    let scrollZoomVelocity = 0;   // scale units per frame
    let scrollZoomOriginX = 50;
    let scrollZoomOriginY = 50;
    let scrollZoomRaf = null;
    const SCROLL_FRICTION = 0.92; // velocity multiplied each frame (0=instant stop, 1=no stop)

    // Snap gate: hold at 1x when first entering zoom so it's easy to land there
    const SNAP_GATE_MS    = 300;
    const SNAP_GATE_TICKS = 2;
    let snapGateActive  = false;
    let snapGateExpiry  = 0;
    let snapGateTicks   = 0;
    let panLastX = -1, panLastY = -1;
    let panX = 0, panY = 0; // translate offset (viewport-%) — kept separate from transformOrigin

    // scrollZoomScale is now just an alias for scrollZoomCurrent (kept for compat with reset code)
    Object.defineProperty(window, '_szs_compat', { value: true });

    function scrollZoomTick() {
        scrollZoomVelocity *= SCROLL_FRICTION;
        const next = scrollZoomCurrent + scrollZoomVelocity;

        // Hit the floor — clamp to 1x, kill velocity, but stay in zoom mode
        if (next <= 1) {
            scrollZoomCurrent = 1;
            scrollZoomVelocity = 0;
            scrollZoomRaf = null;
            panX = 0; panY = 0;
            panLastX = -1; panLastY = -1;
            imgEl.style.transform = `scale(1)`;
            imgEl.style.transformOrigin = '50% 50%';
            zoomTooltip.innerHTML = `<svg class="zoom-icon" xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>1.0× zoom`;
            return;
        }

        const prevScale = scrollZoomCurrent;
        scrollZoomCurrent = Math.min(10, next);

        // Settled at ceiling
        if (scrollZoomCurrent >= 10) scrollZoomVelocity = 0;

        // Zoom toward cursor: shift pan so the point under cursor stays fixed.
        // scrollZoomOriginX/Y holds the cursor position in viewport-% at scroll time.
        const cx = scrollZoomOriginX - 50; // cursor offset from centre (viewport-%)
        const cy = scrollZoomOriginY - 50;
        const scaleFactor = scrollZoomCurrent / prevScale;
        panX = cx + (panX - cx) * scaleFactor;
        panY = cy + (panY - cy) * scaleFactor;

        if (Math.abs(scrollZoomVelocity) < 0.0002) {
            scrollZoomVelocity = 0;
            scrollZoomRaf = null;
            applyTransform();
            zoomTooltip.innerHTML = `<svg class="zoom-icon" xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>${scrollZoomCurrent.toFixed(1)}× zoom`;
            return;
        }
        applyTransform();
        zoomTooltip.innerHTML = `<svg class="zoom-icon" xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>${scrollZoomCurrent.toFixed(1)}× zoom`;
        scrollZoomRaf = requestAnimationFrame(scrollZoomTick);
    }

    function startScrollZoomRaf() {
        imgEl.style.transition = 'none';
        imgEl.style.cursor = 'zoom-out';
        imgEl.classList.add('lightbox-image-zooming');
        zoomTooltip.style.display = 'block';
        if (!scrollZoomRaf) scrollZoomRaf = requestAnimationFrame(scrollZoomTick);
    }

    function applyScrollZoom(instant) {
        if (scrollZoomScale <= 1 && instant) {
            // Instant reset (e.g. click to exit)
            if (scrollZoomRaf) { cancelAnimationFrame(scrollZoomRaf); scrollZoomRaf = null; } if (panRaf) { cancelAnimationFrame(panRaf); panRaf = null; } panLastX = -1; panLastY = -1; panX = 0; panY = 0;
            scrollZoomCurrent = 1;
            imgEl.style.transition = `transform ${CONFIG.zoomOutMs}ms cubic-bezier(0.2, 0, 0, 1)`;
            imgEl.style.transform = '';
            imgEl.style.cursor = globalDetailsEnabled ? '' : 'zoom-in';
            imgEl.classList.remove('lightbox-image-zooming');
            zoomTooltip.style.display = 'none';
            const cleanup = () => { imgEl.style.transition = ''; imgEl.style.transformOrigin = ''; imgEl.removeEventListener('transitionend', cleanup); };
            imgEl.addEventListener('transitionend', cleanup);
        } else {
            startScrollZoomRaf();
        }
    }

    function applyZoom(clientX, clientY, animate) {
        // While zooming, imgEl is position:fixed and fills the viewport
        const pctX = (clientX / window.innerWidth)  * 100;
        const pctY = (clientY / window.innerHeight) * 100;
        imgEl.style.transition = animate ? `transform ${CONFIG.zoomInMs}ms cubic-bezier(0.2, 0, 0, 1)` : 'none';
        imgEl.style.transformOrigin = `${pctX}% ${pctY}%`;
        imgEl.style.transform = `scale(${currentZoomScale})`;
        imgEl.style.cursor = 'zoom-out';
        imgEl.classList.add('lightbox-image-zooming');
        zoomTooltip.innerHTML = `<svg class="zoom-icon" xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>${currentZoomScale.toFixed(1)}× zoom`;
        zoomTooltip.style.display = 'block';
    }

    function releaseZoom() {
        isZooming = false;
        // Hand off to scroll zoom at the current hold-zoom scale so it stays in zoom mode
        scrollZoomCurrent = currentZoomScale;
        scrollZoomVelocity = 0;
        currentZoomScale = CONFIG.zoomScale;
        panX = 0; panY = 0;
        imgEl.style.transition = 'none';
        applyTransform();
        imgEl.style.cursor = 'zoom-out';
        imgEl.classList.add('lightbox-image-zooming');
        zoomTooltip.innerHTML = `<svg class="zoom-icon" xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>${scrollZoomCurrent.toFixed(1)}× zoom`;
        zoomTooltip.style.display = 'block';
    }

    imgEl.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (globalDetailsEnabled) return;
        if (imageWrapper.querySelector('.inline-comparison-slider')) return;
        // If in zoom mode (any scale), click exits
        if (imgEl.classList.contains('lightbox-image-zooming')) {
            scrollZoomVelocity = 0;
            scrollZoomCurrent = 1;
            if (scrollZoomRaf) { cancelAnimationFrame(scrollZoomRaf); scrollZoomRaf = null; } if (panRaf) { cancelAnimationFrame(panRaf); panRaf = null; } panLastX = -1; panLastY = -1; panX = 0; panY = 0;
            imgEl.style.transition = `transform ${CONFIG.zoomOutMs}ms cubic-bezier(0.2, 0, 0, 1)`;
            imgEl.style.transform = '';
            imgEl.style.cursor = globalDetailsEnabled ? '' : 'zoom-in';
            imgEl.classList.remove('lightbox-image-zooming');
            zoomTooltip.style.display = 'none';
            const cleanup = () => { imgEl.style.transition = ''; imgEl.style.transformOrigin = ''; imgEl.removeEventListener('transitionend', cleanup); };
            imgEl.addEventListener('transitionend', cleanup);
            e.preventDefault();
            return;
        }
        // Otherwise enter zoom mode at 1x
        isZooming = true;
        currentZoomScale = 1;
        applyZoom(e.clientX, e.clientY, true);
        e.preventDefault();
    });
    // Pan state — translate offset in viewport-% units, origin fixed at 50% 50%
    let panRaf = null;

    function applyTransform() {
        imgEl.style.transformOrigin = '50% 50%';
        imgEl.style.transform = `translate(${panX}%, ${panY}%) scale(${scrollZoomCurrent})`;
    }

    imgEl.addEventListener('mousemove', (e) => {
        if (isZooming) { applyZoom(e.clientX, e.clientY, false); return; }
        if (imgEl.classList.contains('lightbox-image-zooming') && !isZooming && scrollZoomCurrent > 1.01) {
            // Pan sensitivity decreases with zoom
            const sensitivity = scrollZoomCurrent <= 5 ? 1 : Math.max(0.2, 5 / scrollZoomCurrent);
            const mouseX = (e.clientX / window.innerWidth)  * 100;
            const mouseY = (e.clientY / window.innerHeight) * 100;
            if (panLastX === -1) { panLastX = mouseX; panLastY = mouseY; }
            const dx = (mouseX - panLastX) * sensitivity;
            const dy = (mouseY - panLastY) * sensitivity;
            panLastX = mouseX;
            panLastY = mouseY;
            panX -= dx;
            panY -= dy;
            imgEl.style.transition = 'none';
            applyTransform();
        } else {
            // Not panning — reset so re-entry never has a stale delta or offset
            panLastX = -1;
            panLastY = -1;
            panX = 0;
            panY = 0;
        }
    });
    imgEl.addEventListener('wheel', (e) => {
        e.preventDefault();
        if (isZooming) {
            // Hold-to-zoom: adjust scale while holding mouse button
            currentZoomScale = Math.max(1, Math.min(10, currentZoomScale + (e.deltaY > 0 ? -0.5 : 0.5)));
            imgEl.style.transition = 'transform 80ms cubic-bezier(0.2, 0, 0, 1)';
            imgEl.style.transformOrigin = `${(e.clientX / window.innerWidth) * 100}% ${(e.clientY / window.innerHeight) * 100}%`;
            imgEl.style.transform = `scale(${currentZoomScale})`;
            zoomTooltip.innerHTML = `<svg class="zoom-icon" xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>${currentZoomScale.toFixed(1)}× zoom`;
        } else {
            // Scroll-to-zoom: inject velocity, RAF loop coasts to stop
            const step = e.deltaY > 0 ? -0.1 : 0.1;
            // Scrolling down at 1x — exit zoom
            if (step < 0 && scrollZoomCurrent <= 1 && imgEl.classList.contains('lightbox-image-zooming')) {
                scrollZoomVelocity = 0;
                scrollZoomCurrent = 1;
                snapGateActive = false;
                if (scrollZoomRaf) { cancelAnimationFrame(scrollZoomRaf); scrollZoomRaf = null; } if (panRaf) { cancelAnimationFrame(panRaf); panRaf = null; } panLastX = -1; panLastY = -1; panX = 0; panY = 0;
                imgEl.style.transition = `transform ${CONFIG.zoomOutMs}ms cubic-bezier(0.2, 0, 0, 1)`;
                imgEl.style.transform = '';
                imgEl.style.cursor = globalDetailsEnabled ? '' : 'zoom-in';
                imgEl.classList.remove('lightbox-image-zooming');
                zoomTooltip.style.display = 'none';
                const cleanup = () => { imgEl.style.transition = ''; imgEl.style.transformOrigin = ''; imgEl.removeEventListener('transitionend', cleanup); };
                imgEl.addEventListener('transitionend', cleanup);
                return;
            }
            // Only zoom in if already in zoom mode or scrolling up (entering zoom)
            if (step < 0 && !imgEl.classList.contains('lightbox-image-zooming')) return;

            // On first scroll-up that enters zoom, open the 1x snap gate
            if (!imgEl.classList.contains('lightbox-image-zooming')) {
                snapGateActive = true;
                snapGateExpiry = performance.now() + SNAP_GATE_MS;
                snapGateTicks  = 0;
                scrollZoomOriginX = (e.clientX / window.innerWidth)  * 100;
                scrollZoomOriginY = (e.clientY / window.innerHeight) * 100;
                panX = 0; panY = 0;
                startScrollZoomRaf();
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

            // Capture cursor position for zoom-toward-cursor in scrollZoomTick
            scrollZoomOriginX = (e.clientX / window.innerWidth)  * 100;
            scrollZoomOriginY = (e.clientY / window.innerHeight) * 100;
            scrollZoomVelocity += step;
            startScrollZoomRaf();
        }
    }, { passive: false });

    const _mouseUpLightbox = (e) => { if (e.button === 0 && isZooming) releaseZoom(); };
    document.addEventListener('mouseup', _mouseUpLightbox);

    // ── Per-pixel nit-hunt ──
    let lbPixelBuffer = null;
    let lbRafPending = false;
    let lbLastPixelX = -1, lbLastPixelY = -1;

    let lbMouseInside = false;

    // ── Zoom-aware cursor → pixel coordinate mapping ──
    // When zoomed, imgEl is position:fixed full-viewport with object-fit:contain,
    // so getBoundingClientRect() returns the whole viewport, not the actual image rect.
    // We must compute the letterboxed image rect manually and then invert the
    // translate(panX%, panY%) scale(scrollZoomCurrent) transform.
    function cursorToPixel(clientX, clientY, buf) {
        const natW = imgEl.naturalWidth  || buf.width;
        const natH = imgEl.naturalHeight || buf.height;

        if (imgEl.classList.contains('lightbox-image-zooming')) {
            const vw = window.innerWidth;
            const vh = window.innerHeight;

            // Step 1: compute the un-zoomed letterboxed rect (object-fit:contain inside viewport)
            const fitScale = Math.min(vw / natW, vh / natH);
            const fitW = natW * fitScale;
            const fitH = natH * fitScale;
            const fitLeft = (vw - fitW) / 2;
            const fitTop  = (vh - fitH) / 2;

            // Step 2: invert the CSS transform: translate(panX%, panY%) scale(scrollZoomCurrent)
            // The transform origin is 50% 50% of the viewport.
            // A point P in viewport space maps to image space as:
            //   P_img = (P_viewport - viewport_centre - pan_px) / scrollZoomCurrent + viewport_centre
            // where pan_px = panX/100 * vw, panY/100 * vh
            const cx = vw / 2;
            const cy = vh / 2;
            const panPxX = (panX / 100) * vw;
            const panPxY = (panY / 100) * vh;

            const unscaledX = (clientX - cx - panPxX) / scrollZoomCurrent + cx;
            const unscaledY = (clientY - cy - panPxY) / scrollZoomCurrent + cy;

            // Step 3: map from viewport coords back to pixel coords via the fit rect
            const imgX = Math.floor((unscaledX - fitLeft) * (natW / fitW));
            const imgY = Math.floor((unscaledY - fitTop)  * (natH / fitH));

            return {
                imgX: Math.max(0, Math.min(natW - 1, imgX)),
                imgY: Math.max(0, Math.min(natH - 1, imgY)),
            };
        } else {
            // Not zoomed — simple mapping via getBoundingClientRect()
            const rect = imgEl.getBoundingClientRect();
            return {
                imgX: Math.max(0, Math.min(natW - 1, Math.floor((clientX - rect.left) * (natW / rect.width)))),
                imgY: Math.max(0, Math.min(natH - 1, Math.floor((clientY - rect.top)  * (natH / rect.height)))),
            };
        }
    }

    imgEl.addEventListener('mouseenter', async () => {
        lbMouseInside = true;
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
        if (lightboxSdrActive) return;
        if (!lbPixelBuffer) {
            const item = lightboxBatch[lightboxIndex];
            const bufPromise = lightboxPixelBuffers.get(item.id);
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
        const { rNits, gNits, bNits, luminance, gamut } = getNitsAtPixel(lbPixelBuffer, imgX, imgY);
        nitTooltip.innerHTML = _nitTooltipHTML(rNits, gNits, bNits, luminance, gamut);
    });
    imgEl.addEventListener('mouseleave', () => {
        lbMouseInside = false;
        nitTooltip.style.display = 'none';
        lbLastPixelX = -1; lbLastPixelY = -1;
    });
    imgEl.addEventListener('mousemove', (e) => {
        if (!lbPixelBuffer || !globalDetailsEnabled) return;
        if (lightboxSdrActive) return;
        lbRafPending = true;
        requestAnimationFrame(() => {
            lbRafPending = false;
            const { imgX, imgY } = cursorToPixel(e.clientX, e.clientY, lbPixelBuffer);
            if (imgX === lbLastPixelX && imgY === lbLastPixelY) return;
            lbLastPixelX = imgX; lbLastPixelY = imgY;
            const { rNits, gNits, bNits, luminance, gamut } = getNitsAtPixel(lbPixelBuffer, imgX, imgY);
            nitTooltip.innerHTML = _nitTooltipHTML(rNits, gNits, bNits, luminance, gamut);
        });
    });

    // ── Render function (called on init and navigation) ──
    async function renderLightboxImage() {
        const item = lightboxBatch[lightboxIndex];
        const _t0 = performance.now();
        console.log(`[lightbox] renderLightboxImage() start  +0ms`);
        lbPixelBuffer = null; // reset buffer for new image
        lbLastPixelX = -1; lbLastPixelY = -1;

        // Reset zoom
        isZooming = false;
        scrollZoomCurrent = 1;
        scrollZoomVelocity = 0;
        scrollZoomOriginX = 50;
        scrollZoomOriginY = 50;
        if (scrollZoomRaf) { cancelAnimationFrame(scrollZoomRaf); scrollZoomRaf = null; } if (panRaf) { cancelAnimationFrame(panRaf); panRaf = null; } panLastX = -1; panLastY = -1; panX = 0; panY = 0;
        imgEl.style.transform = '';
        imgEl.style.transformOrigin = '';
        imgEl.style.transition = '';
        imgEl.classList.remove('lightbox-image-zooming');
        zoomTooltip.style.display = 'none';

        // Close SDR slider if open
        const existingSlider = imageWrapper.querySelector('.inline-comparison-slider');
        if (existingSlider) {
            if (existingSlider._cleanup) existingSlider._cleanup();
            existingSlider.remove();
        }
        lightboxSdrActive = false;
        compareBtn.classList.remove('button-active');
        compareBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 6H3"/><path d="m7 12-4-4 4-4"/><path d="M3 18h18"/><path d="m17 12 4 4-4 4"/></svg> <u>S</u>DR Slider';

        // Reset SDR full-view toggle
        lightboxSdrToggleActive = false;
        sdrToggleBtn.classList.remove('button-active');
        updateSaveBtn();

        // Remove existing details overlay
        const existingOverlay = imageWrapper.querySelector('.image-meta-overlay');
        if (existingOverlay) existingOverlay.remove();

        // Update main image — always use full-res original for accurate HDR rendering
        const { url: displayUrl, fullUrl, blob } = lightboxBlobUrls.get(item.id);
        console.log(`[lightbox] setting imgEl.src  +${(performance.now()-_t0).toFixed(1)}ms`);
        imgEl.onerror = () => console.warn(`[lightbox] imgEl onerror fired  +${(performance.now()-_t0).toFixed(1)}ms`);
        imgEl.src = fullUrl;
        imgEl.onload = () => console.log(`[lightbox] imgEl onload fired  +${(performance.now()-_t0).toFixed(1)}ms`);
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
        imageWrappers.set(item.id, { wrapper: imageWrapper, metadata: item.metadata || null, imageItem: item, compareButton: compareBtn });
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
        imageHeaderTitle.textContent = item.gameName || 'Unknown Game';
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
        filmstrip.querySelectorAll('.lightbox-filmstrip-thumb').forEach((thumb, i) => {
            thumb.classList.toggle('lightbox-filmstrip-thumb-active', i === lightboxIndex);
        });

        // Nav arrow visibility
        prevBtn.style.opacity = lightboxIndex === 0 ? '0.25' : '1';
        prevBtn.style.pointerEvents = lightboxIndex === 0 ? 'none' : '';
        nextBtn.style.opacity = lightboxIndex === lightboxBatch.length - 1 ? '0.25' : '1';
        nextBtn.style.pointerEvents = lightboxIndex === lightboxBatch.length - 1 ? 'none' : '';

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

        // Pre-decode adjacent images outward from current index so navigation feels instant.
        // Works outward (next, prev, next+1, prev-1…) with a staggered delay so we don't
        // saturate the GPU decoder all at once. Capped at 6 neighbours total.
        const _adjOrder = [];
        for (let d = 1; d <= 3; d++) {
            if (lightboxIndex + d < lightboxBatch.length) _adjOrder.push(lightboxIndex + d);
            if (lightboxIndex - d >= 0)                   _adjOrder.push(lightboxIndex - d);
        }
        _adjOrder.slice(0, 6).forEach((i, slot) => {
            const adj = lightboxBatch[i];
            if (!adj) return;
            const adjEntry = lightboxBlobUrls.get(adj.id);
            if (!adjEntry) return;
            if (_decodePromises.has(adjEntry.fullUrl)) return; // already decoded or in flight
            setTimeout(() => {
                const p = new Image();
                p.src = adjEntry.fullUrl;
                const _pt = performance.now();
                const promise = p.decode().then(() => {
                    console.log(`[lightbox] adj prefetch decode done: "${adj.name}" (slot ${slot+1})  +${(performance.now()-_pt).toFixed(1)}ms`);
                }).catch(() => {});
                _decodePromises.set(adjEntry.fullUrl, promise);
            }, slot * 150); // stagger by 150 ms per slot
        });

        // Wire up action buttons for current item
        saveBtn.onclick = async () => {
            try {
                const isSdr = lightboxSdrToggleActive;
                const { sdrUrl, fullUrl } = lightboxBlobUrls.get(item.id);
                const saveUrl = isSdr && sdrUrl ? sdrUrl : fullUrl;
                const dotIdx = item.name.lastIndexOf('.');
                const base = dotIdx >= 0 ? item.name.slice(0, dotIdx) : item.name;
                const ext  = dotIdx >= 0 ? item.name.slice(dotIdx).toLowerCase() : '';
                const suffix = isSdr ? '_SDR' : '_HDR';
                const saveExt = isSdr ? '.png' : ext;
                const saveName = base + suffix + saveExt;
                if (window.showSaveFilePicker) {
                    const EXT_TYPES = {
                        '.png':  [{ description: 'PNG Image',            accept: { 'image/png':  ['.png']  } }],
                        '.avif': [{ description: 'AVIF Image',           accept: { 'image/avif': ['.avif'] } }],
                        '.jxr':  [{ description: 'JPEG XR Image',        accept: { 'image/jxr':  ['.jxr']  } }],
                        '.exr':  [{ description: 'OpenEXR Image',        accept: { 'image/x-exr': ['.exr'] } }],
                        '.hdr':  [{ description: 'Radiance HDR Image',   accept: { 'image/vnd.radiance': ['.hdr'] } }],
                    };
                    const types = EXT_TYPES[saveExt];
                    const fh = await window.showSaveFilePicker({ suggestedName: saveName, ...(types ? { types, excludeAcceptAllOption: true } : {}) });
                    const saveResp = await fetch(saveUrl);
                    const saveBlob = await saveResp.blob();
                    const w = await fh.createWritable();
                    await w.write(saveBlob);
                    await w.close();
                } else {
                    downloadFile(saveUrl, saveName);
                }
            } catch (err) {
                if (err.name !== 'AbortError') console.error('Save error:', err);
            }
        };

        editBtn.onclick = async () => {
            if (editBtn.disabled) return;
            editBtn.disabled = true;
            const result = await showEditModal(item.hdrType, item.gameName);
            editBtn.disabled = false;
            if (result === null) return;
            const { hdrType: newHdrType, gameName: newGameName } = result;
            // Update all items in the batch in memory so navigation picks up the new name immediately
            lightboxBatch.forEach(batchItem => {
                if (batchItem.batchId === item.batchId || batchItem.id === item.id) {
                    batchItem.gameName = newGameName;
                    batchItem.hdrType  = newHdrType;
                }
            });
            // Also update the toolbar center title which is set once on open
            imageHeaderTitle.textContent = newGameName || 'Unknown Game';
            try {
                await updateImageHdrType(item.id, newHdrType);
                if (item.batchId) await updateBatchGameName(item.batchId, newGameName);
                await refreshGallery();
                renderLightboxImage();
            } catch (err) { console.error('Edit error:', err); }
        };

        deleteBtn.onclick = async () => {
            if (!confirm(`Delete "${item.name}"?`)) return;
            try {
                await deleteImageFile(item.id);
                // Revoke and clean up this item's lightbox URLs before splicing
                const entry = lightboxBlobUrls.get(item.id);
                if (entry) {
                    URL.revokeObjectURL(entry.fullUrl);
                    if (entry.url !== entry.fullUrl) URL.revokeObjectURL(entry.url);
                    lightboxCreatedUrls = lightboxCreatedUrls.filter(u => u !== entry.fullUrl && u !== entry.url);
                    lightboxBlobUrls.delete(item.id);
                }
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

        deleteAllBtn.onclick = async () => {
            const count = lightboxBatch.length;
            const gameName = lightboxBatch[0]?.gameName || 'this batch';
            if (!confirm(`Delete all ${count} image${count === 1 ? '' : 's'} from "${gameName}"?`)) return;
            try {
                const ids = lightboxBatch.map(b => b.id);
                await deleteBatchImageFiles(ids);
                // Revoke all lightbox URLs for the batch
                ids.forEach(id => {
                    const entry = lightboxBlobUrls.get(id);
                    if (entry) {
                        URL.revokeObjectURL(entry.fullUrl);
                        if (entry.url !== entry.fullUrl) URL.revokeObjectURL(entry.url);
                        lightboxCreatedUrls = lightboxCreatedUrls.filter(u => u !== entry.fullUrl && u !== entry.url);
                        lightboxBlobUrls.delete(id);
                    }
                    lightboxPixelBuffers.delete(id);
                });
                closeLightbox();
                await refreshGallery();
            } catch (err) { console.error('Delete all error:', err); }
        };

        compareBtn.onclick = () => {
            // Close full SDR view if active — the two modes are mutually exclusive
            if (lightboxSdrToggleActive) {
                const { fullUrl } = lightboxBlobUrls.get(item.id);
                imgEl.src = fullUrl;
                lightboxSdrToggleActive = false;
                sdrToggleBtn.classList.remove('button-active');
            }

            const existingSlider = imageWrapper.querySelector('.inline-comparison-slider');
            if (existingSlider) {
                if (existingSlider._cleanup) existingSlider._cleanup();
                existingSlider.remove();
                lightboxSdrActive = false;
                compareBtn.classList.remove('button-active');
                compareBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 6H3"/><path d="m7 12-4-4 4-4"/><path d="M3 18h18"/><path d="m17 12 4 4-4 4"/></svg> <u>S</u>DR Slider';
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
                        const wrapRect = imageWrapper.getBoundingClientRect();
                        slider.style.left   = (rect.left - wrapRect.left) + 'px';
                        slider.style.top    = (rect.top  - wrapRect.top)  + 'px';
                        slider.style.width  = rect.width  + 'px';
                        slider.style.height = rect.height + 'px';
                    }
                }

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
                    if (panRaf) { cancelAnimationFrame(panRaf); panRaf = null; }
                    panLastX = -1; panLastY = -1; panX = 0; panY = 0;
                    imgEl.style.transition = '';
                    imgEl.style.transform = 'scale(1)';
                    imgEl.style.transformOrigin = '50% 50%';
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

        sdrToggleBtn.onclick = () => {
            // Close the slider if it's open — the two modes are mutually exclusive
            const existingSlider = imageWrapper.querySelector('.inline-comparison-slider');
            if (existingSlider) {
                if (existingSlider._cleanup) existingSlider._cleanup();
                existingSlider.remove();
                lightboxSdrActive = false;
                compareBtn.classList.remove('button-active');
                compareBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 6H3"/><path d="m7 12-4-4 4-4"/><path d="M3 18h18"/><path d="m17 12 4 4-4 4"/></svg> <u>S</u>DR Slider';
            }

            if (lightboxSdrToggleActive) {
                // Switch back to HDR
                const { fullUrl } = lightboxBlobUrls.get(item.id);
                imgEl.src = fullUrl;
                lightboxSdrToggleActive = false;
                sdrToggleBtn.classList.remove('button-active');
                updateSaveBtn();
                const metaOverlay = imageWrapper.querySelector('.image-meta-overlay');
                if (metaOverlay) metaOverlay.style.visibility = '';
                return;
            }

            const { sdrUrl } = lightboxBlobUrls.get(item.id);
            if (sdrUrl) {
                imgEl.src = sdrUrl;
                lightboxSdrToggleActive = true;
                sdrToggleBtn.classList.add('button-active');
                updateSaveBtn();
                // Hide analysis overlay while SDR view is active
                const metaOverlay = imageWrapper.querySelector('.image-meta-overlay');
                if (metaOverlay) metaOverlay.style.visibility = 'hidden';
                nitTooltip.style.display = 'none';
                _nitsRow.style.display = 'none';
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
            const thumb = document.createElement('img');
            thumb.src = url;
            thumb.alt = item.name;
            thumb.className = 'lightbox-filmstrip-thumb' + (idx === lightboxIndex ? ' lightbox-filmstrip-thumb-active' : '');
            thumb.addEventListener('click', (e) => { e.stopPropagation(); lightboxIndex = idx; renderLightboxImage(); });
            filmstrip.appendChild(thumb);
        });
    }

    rebuildFilmstrip();
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
}

let _lightboxRender = null; // set by openLightbox, called by navigateLightbox

function navigateLightbox(direction) {
    const newIndex = lightboxIndex + direction;
    if (newIndex < 0 || newIndex >= lightboxBatch.length) return;
    lightboxIndex = newIndex;
    if (_lightboxRender) _lightboxRender();
}

function closeLightbox() {
    const overlay = document.getElementById('lightbox-overlay');
    if (overlay) {
        if (overlay._cleanupMouseUp) document.removeEventListener('mouseup', overlay._cleanupMouseUp);
        overlay.classList.add('lightbox-closing');
        overlay.style.opacity = '0';
        const duration = parseFloat(getComputedStyle(overlay).transitionDuration) * 1000;
        setTimeout(() => overlay.remove(), duration);
    }
    document.body.style.overflow = '';
    document.documentElement.style.overflow = '';
    lightboxOpen = false;
    lightboxBatch = [];
    lightboxIndex = 0;
    lightboxPixelBuffer = null;
    lightboxSdrToggleActive = false;
    _lightboxRender = null;
    globalDetailsEnabled = false;
    nitTooltip.style.display = 'none';
    zoomTooltip.style.display = 'none';
    // Clear lightbox image wrapper from the map so details mode doesn't break
    imageWrappers.clear();
    currentVisibleImage = null;
    revokeLightboxUrls();
}

// Keep old createGalleryItem stub so nothing breaks if referenced elsewhere
function createGalleryItem(imageItem) {
    return createCollageCard([imageItem]);
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function isInsideRect(x, y, rect) {
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function downloadFile(url, filename) {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
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

// ─── HDR / SDR Comparison Slider ─────────────────────────────────────────────

function buildInlineComparison(galleryItem, originalEl, hdrBlob, sdrBlob, onReady) {
    const slider = document.createElement('div');
    slider.className = 'inline-comparison-slider';

    // HDR image (base layer, sets the size)
    const hdrImg = document.createElement('img');
    hdrImg.className = 'inline-comparison-hdr';
    hdrImg.src = URL.createObjectURL(hdrBlob);
    createdUrls.push(hdrImg.src);

    // SDR image (clipped overlay)
    const sdrImg = document.createElement('img');
    sdrImg.className = 'inline-comparison-sdr';
    sdrImg.src = URL.createObjectURL(sdrBlob);
    createdUrls.push(sdrImg.src);

        const divider = document.createElement('div');
    divider.className = 'inline-comparison-divider';

        const sdrLabel = document.createElement('span');
    sdrLabel.className = 'inline-comparison-label inline-comparison-label-sdr';
    sdrLabel.textContent = 'SDR';

    const hdrLabel = document.createElement('span');
    hdrLabel.className = 'inline-comparison-label inline-comparison-label-hdr';
    hdrLabel.textContent = 'HDR';

    slider.appendChild(hdrImg);
    slider.appendChild(sdrImg);
    slider.appendChild(divider);
    slider.appendChild(sdrLabel);
    slider.appendChild(hdrLabel);

    // Keep out of flow until ready to avoid reflowing other gallery items
    slider.style.visibility = 'hidden';
    slider.style.position = 'absolute';

    // Insert before the info section (after any existing img)
    galleryItem.insertBefore(slider, originalEl.nextSibling);

    hdrImg.onload = () => {
        if (onReady) onReady();
        slider.style.position = '';
        slider.style.visibility = '';
        let isDragging = false;

        const LABEL_WIDTH = 70; // px — enough to cover label + padding

        function updateSlider(clientX) {
            const rect = slider.getBoundingClientRect();
            const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
            const dividerX = pct * rect.width;
            sdrImg.style.clipPath = `inset(0 ${(1 - pct) * 100}% 0 0)`;
            divider.style.left = `${pct * 100}%`;

            // Hide SDR label (left side) when divider sweeps over it
            sdrLabel.style.opacity = dividerX < LABEL_WIDTH ? '0' : '1';
            // Hide HDR label (right side) when divider sweeps over it
            hdrLabel.style.opacity = dividerX > rect.width - LABEL_WIDTH ? '0' : '1';
        }

        updateSlider(slider.getBoundingClientRect().left + slider.getBoundingClientRect().width * 0.5);

        slider.addEventListener('mousedown', (e) => {
            isDragging = true;
            updateSlider(e.clientX);
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (isDragging) updateSlider(e.clientX);
        });
        document.addEventListener('mouseup', () => { isDragging = false; });

        slider.addEventListener('touchstart', (e) => {
            isDragging = true;
            updateSlider(e.touches[0].clientX);
        }, { passive: true });
        document.addEventListener('touchmove', (e) => {
            if (isDragging) {
                updateSlider(e.touches[0].clientX);
                e.preventDefault();
            }
        }, { passive: false });
        document.addEventListener('touchend', () => { isDragging = false; });
    };
}

// ─── Metadata Overlay Panels ─────────────────────────────────────────────────

function showMetadataOverlay(filename, metadata, imageWrapper) {
    // In global mode, just remove existing and show new
    const existing = imageWrapper.querySelector('.image-meta-overlay');
    if (existing) {
        existing.remove();
    }

    // --- Build single panel: File Info on top, then HDR Metadata, Luminance, Gamut ---
    let panelRows = '';

    // File Info (top section)
    panelRows += `<div class="imo-section-title imo-section-title--file">File Info</div>`;
    panelRows += imoRow('Resolution', metadata.resolution);
    panelRows += imoRow('Aspect', getAspectRatioLabel(metadata.width, metadata.height));
    panelRows += imoRow('Size', formatFileSize(metadata.fileSize));

    // Build a descriptive format string from available metadata
    const fileExt = getFileExtension(filename).replace('.', '').toUpperCase();
    const formatParts = [fileExt];
    if (metadata.hdr?.colorType && metadata.hdr.colorType !== 'Unknown') formatParts.push(metadata.hdr.colorType);
    if (metadata.hdr?.colorPrimaries) formatParts.push(metadata.hdr.colorPrimaries);
    panelRows += imoRow('Format', formatParts.join(' · '));

    // HDR Metadata
    if (metadata.hdr) {
        panelRows += `<div class="imo-section-title imo-section-title--hdr">HDR Metadata</div>`;
        panelRows += imoRow('Bit Depth', metadata.hdr.bitDepth);
        if (metadata.hdr.gamma && metadata.hdr.gamma !== 'Not specified' && metadata.hdr.gamma !== 'HDR transfer function') {
            panelRows += imoRow('Gamma', metadata.hdr.gamma);
        }
        panelRows += imoRow('Transfer', metadata.hdr.transferFunction);
        if (metadata.hdr.format) panelRows += imoRow('Format', metadata.hdr.format);
    }

    // Luminance
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

    // Gamut
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
        </div>
    `;

    // Append to the image container so the overlay is bounded to the image area,
    // not the full wrapper (which includes the header above the image).
    const imgContainer = imageWrapper.querySelector('.lightbox-image-container') || imageWrapper;
    imgContainer.appendChild(overlay);

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
        } else {
            panel.style.left = minLeft + 'px';
            panel.style.top  = minTop  + 'px';
        }

        // Drag logic
        const TEXT_TAGS = new Set(['SPAN', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'LABEL', 'A']);

        panel.addEventListener('mousedown', (e) => {
            const fromHandle = e.target.classList.contains('imo-drag-handle');
            const fromText   = TEXT_TAGS.has(e.target.tagName);
            if (!fromHandle && fromText) return;

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
                panel.style.left = Math.max(minLeft, Math.min(maxLeft, rawLeft)) + 'px';
                panel.style.top  = Math.max(minTop,  Math.min(maxTop,  rawTop))  + 'px';
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

// ─── Import Modal ─────────────────────────────────────────────────────────────

function showImportModal(fileCount) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';

        const modal = document.createElement('div');
        modal.className = 'modal';

        modal.innerHTML = `
            <div class="modal-header">
                <span class="modal-title">${fileCount} image${fileCount === 1 ? '' : 's'} ready to import</span>
                <span class="modal-subtitle">Set game name and HDR type for this batch</span>
            </div>
            <div class="modal-body">
                <div class="modal-section-label">Game Name</div>
                <div class="game-search-wrap">
                    <div class="game-search-row">
                        <svg class="game-search-icon" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                        <input class="game-search-input" type="text" placeholder="Search game…" autocomplete="off" />
                    </div>
                    <div class="game-search-results"></div>
                </div>
                <div class="modal-section-label modal-section-label-hdr">HDR Type</div>
                <div class="hdr-type-grid" id="importHdrGrid"></div>
            </div>
            <div class="modal-footer">
                <button class="button-secondary modal-cancel">Cancel</button>
                <button class="modal-import">Import</button>
            </div>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        const grid        = modal.querySelector('#importHdrGrid');
        const searchInput = modal.querySelector('.game-search-input');
        const resultsEl   = modal.querySelector('.game-search-results');
        const importBtn   = modal.querySelector('.modal-import');

        let selected = null;
        let selectedGameName = null;

        // ── Game search ──
        async function doSearch() {
            const q = searchInput.value.trim();
            if (!q) return;
            resultsEl.innerHTML = '<div class="game-search-status">Searching…</div>';
            resultsEl.style.display = 'flex';
            try {
                const results = await searchRawg(q);
                resultsEl.innerHTML = '';
                resultsEl.style.display = 'none';
                if (results.length === 0) {
                    resultsEl.innerHTML = '<div class="game-search-status">No results found</div>';
                    resultsEl.style.display = 'flex';
                    return;
                }
                results.forEach(game => {
                    const item = document.createElement('div');
                    item.className = 'game-result-item';
                    item.textContent = game.name;
                    if (game.released) item.textContent += ` (${game.released.slice(0, 4)})`;
                    item.onclick = () => {
                        selectedGameName = game.name;
                        searchInput.value = game.name;
                        resultsEl.innerHTML = '';
                        resultsEl.style.display = 'none';
                    };
                    resultsEl.appendChild(item);
                });
                resultsEl.style.display = 'flex';
            } catch (err) {
                resultsEl.innerHTML = '<div class="game-search-status">Search failed</div>';
                resultsEl.style.display = 'flex';
            }
        }

        let debounceTimer = null;
        searchInput.addEventListener('input', () => {
            selectedGameName = searchInput.value.trim() || null;
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(doSearch, 350);
        });
        let highlightedIndex = -1;

        function getResultItems() {
            return Array.from(resultsEl.querySelectorAll('.game-result-item'));
        }

        function setHighlight(idx) {
            const items = getResultItems();
            items.forEach(el => el.classList.remove('game-result-item-highlighted'));
            highlightedIndex = Math.max(-1, Math.min(idx, items.length - 1));
            if (highlightedIndex >= 0) {
                items[highlightedIndex].classList.add('game-result-item-highlighted');
                items[highlightedIndex].scrollIntoView({ block: 'nearest' });
            }
        }

        searchInput.addEventListener('keydown', (e) => {
            const items = getResultItems();
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setHighlight(highlightedIndex + 1);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setHighlight(highlightedIndex - 1);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (highlightedIndex >= 0 && items[highlightedIndex]) {
                    items[highlightedIndex].click();
                    highlightedIndex = -1;
                } else {
                    clearTimeout(debounceTimer);
                    doSearch();
                }
            } else if (e.key === 'Escape') {
                e.stopPropagation();
                resultsEl.innerHTML = '';
                resultsEl.style.display = 'none';
                highlightedIndex = -1;
            }
        });
        searchInput.addEventListener('blur', () => {
            setTimeout(() => { resultsEl.innerHTML = ''; resultsEl.style.display = 'none'; }, 150);
        });

        // Build grouped chips
        const groups = [...new Set(HDR_TYPES.map(t => t.group))];
        groups.forEach(groupName => {
            const groupEl = document.createElement('div');
            groupEl.className = 'hdr-type-group';

            const groupLabel = document.createElement('div');
            groupLabel.className = 'hdr-type-group-label';
            groupLabel.textContent = groupName;
            groupEl.appendChild(groupLabel);

            const row = document.createElement('div');
            row.className = 'hdr-type-row';

            HDR_TYPES.filter(t => t.group === groupName).forEach(type => {
                const chip = document.createElement('button');
                chip.className = 'hdr-type-chip';
                chip.textContent = type.label;
                chip.dataset.id = type.id;
                chip.onclick = () => {
                    const isSelected = chip.classList.contains('selected');
                    grid.querySelectorAll('.hdr-type-chip').forEach(c => c.classList.remove('selected'));
                    if (!isSelected) {
                        chip.classList.add('selected');
                        selected = type.id;
                    } else {
                        selected = null;
                    }
                };
                row.appendChild(chip);
            });

            groupEl.appendChild(row);
            grid.appendChild(groupEl);
        });

        modal.querySelector('.modal-cancel').onclick = () => {
            overlay.remove();
            document.removeEventListener('keydown', onImportKeydown, true);
            resolve(null);
        };

        importBtn.onclick = () => {
            overlay.remove();
            document.removeEventListener('keydown', onImportKeydown, true);
            resolve({ hdrType: selected ?? 'unknown', gameName: selectedGameName });
        };

        let importMousedownOnModal = false;
        modal.addEventListener('mousedown', () => { importMousedownOnModal = true; });
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) importMousedownOnModal = false; });
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay && !importMousedownOnModal) {
                overlay.remove();
                document.removeEventListener('keydown', onImportKeydown, true);
                resolve(null);
            }
            importMousedownOnModal = false;
        });

        const onImportKeydown = (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
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

const RAWG_KEY = '2ed92fc542034b3ea93847700be1043b';

async function searchRawg(query) {
    const url = `https://api.rawg.io/api/games?key=${RAWG_KEY}&search=${encodeURIComponent(query)}&page_size=8`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('RAWG request failed');
    const data = await res.json();
    return data.results || [];
}

function showEditModal(currentHdrType, currentGameName) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';

        const modal = document.createElement('div');
        modal.className = 'modal';

        modal.innerHTML = `
            <div class="modal-header">
                <span class="modal-title">Edit Details</span>
                <span class="modal-subtitle">Set game name and HDR type for this batch</span>
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
                <div class="hdr-type-grid" id="editHdrGrid"></div>
            </div>
            <div class="modal-footer">
                <button class="button-secondary modal-cancel">Cancel</button>
                <button class="modal-import">Save</button>
            </div>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        const grid        = modal.querySelector('#editHdrGrid');
        const searchInput = modal.querySelector('.game-search-input');
        const resultsEl   = modal.querySelector('.game-search-results');
        const saveBtn     = modal.querySelector('.modal-import');

        let selectedHdrType = currentHdrType;
        let selectedGameName = currentGameName || null;

        // ── Game search ──
        async function doSearch() {
            const q = searchInput.value.trim();
            if (!q) return;
            resultsEl.innerHTML = '<div class="game-search-status">Searching…</div>';
            resultsEl.style.display = 'flex';
            try {
                const results = await searchRawg(q);
                resultsEl.innerHTML = '';
                resultsEl.style.display = 'none';
                if (results.length === 0) {
                    resultsEl.innerHTML = '<div class="game-search-status">No results found</div>';
                    resultsEl.style.display = 'flex';
                    return;
                }
                results.forEach(game => {
                    const item = document.createElement('div');
                    item.className = 'game-result-item';
                    item.textContent = game.name;
                    if (game.released) item.textContent += ` (${game.released.slice(0, 4)})`;
                    item.onclick = () => {
                        selectedGameName = game.name;
                        searchInput.value = game.name;
                        resultsEl.innerHTML = '';
                        resultsEl.style.display = 'none';
                    };
                    resultsEl.appendChild(item);
                });
                resultsEl.style.display = 'flex';
            } catch (err) {
                resultsEl.innerHTML = '<div class="game-search-status">Search failed</div>';
                resultsEl.style.display = 'flex';
            }
        }


        let debounceTimer = null;
        searchInput.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(doSearch, 350);
        });
        let highlightedIndex = -1;

        function getResultItems() {
            return Array.from(resultsEl.querySelectorAll('.game-result-item'));
        }

        function setHighlight(idx) {
            const items = getResultItems();
            items.forEach(el => el.classList.remove('game-result-item-highlighted'));
            highlightedIndex = Math.max(-1, Math.min(idx, items.length - 1));
            if (highlightedIndex >= 0) {
                items[highlightedIndex].classList.add('game-result-item-highlighted');
                items[highlightedIndex].scrollIntoView({ block: 'nearest' });
            }
        }

        searchInput.addEventListener('keydown', (e) => {
            const items = getResultItems();
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setHighlight(highlightedIndex + 1);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setHighlight(highlightedIndex - 1);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (highlightedIndex >= 0 && items[highlightedIndex]) {
                    items[highlightedIndex].click();
                    highlightedIndex = -1;
                } else {
                    clearTimeout(debounceTimer);
                    doSearch();
                }
            } else if (e.key === 'Escape') {
                e.stopPropagation();
                resultsEl.innerHTML = '';
                resultsEl.style.display = 'none';
                highlightedIndex = -1;
            }
        });
        searchInput.addEventListener('blur', () => {
            // Delay so a click on a result fires before the list disappears
            setTimeout(() => { resultsEl.innerHTML = ''; resultsEl.style.display = 'none'; }, 150);
        });

        // Escape closes the modal (without leaking to the lightbox behind)
        const onModalKeydown = (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                overlay.remove();
                document.removeEventListener('keydown', onModalKeydown, true);
                resolve(null);
            }
        };
        document.addEventListener('keydown', onModalKeydown, true);

        // ── HDR type chips ──
        const groups = [...new Set(HDR_TYPES.map(t => t.group))];
        groups.forEach(groupName => {
            const groupEl = document.createElement('div');
            groupEl.className = 'hdr-type-group';

            const groupLabel = document.createElement('div');
            groupLabel.className = 'hdr-type-group-label';
            groupLabel.textContent = groupName;
            groupEl.appendChild(groupLabel);

            const row = document.createElement('div');
            row.className = 'hdr-type-row';

            HDR_TYPES.filter(t => t.group === groupName).forEach(type => {
                const chip = document.createElement('button');
                chip.className = 'hdr-type-chip';
                chip.textContent = type.label;
                chip.dataset.id = type.id;
                if (type.id === currentHdrType) chip.classList.add('selected');
                chip.onclick = () => {
                    const isSelected = chip.classList.contains('selected');
                    grid.querySelectorAll('.hdr-type-chip').forEach(c => c.classList.remove('selected'));
                    if (!isSelected) {
                        chip.classList.add('selected');
                        selectedHdrType = type.id;
                    } else {
                        selectedHdrType = 'unknown';
                    }
                };
                row.appendChild(chip);
            });

            groupEl.appendChild(row);
            grid.appendChild(groupEl);
        });

        modal.querySelector('.modal-cancel').onclick = () => {
            overlay.remove();
            document.removeEventListener('keydown', onModalKeydown, true);
            resolve(null);
        };

        saveBtn.onclick = () => {
            overlay.remove();
            document.removeEventListener('keydown', onModalKeydown, true);
            resolve({ hdrType: selectedHdrType ?? 'unknown', gameName: selectedGameName });
        };

        let editMousedownOnModal = false;
        modal.addEventListener('mousedown', () => { editMousedownOnModal = true; });
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) editMousedownOnModal = false; });
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay && !editMousedownOnModal) {
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

    bar.innerHTML = `
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
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
            </div>
            <div id="gallerySearchDropdown" class="gallery-search-dropdown"></div>
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
            header.textContent = 'Most images';
            dropdown.appendChild(header);

            top5.forEach(([name, count]) => {
                const item = document.createElement('div');
                item.className = 'gallery-search-suggestion';
                const nameSpan = document.createElement('span');
                nameSpan.textContent = name;
                const countSpan = document.createElement('span');
                countSpan.className = 'gallery-search-suggestion-count';
                countSpan.textContent = `${count} img${count === 1 ? '' : 's'}`;
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
            item.innerHTML = name.slice(0, idx)
                + `<mark>${name.slice(idx, idx + q.length)}</mark>`
                + name.slice(idx + q.length);
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

    clearBtn.addEventListener('click', () => {
        gameSearchQuery = '';
        input.value = '';
        clearBtn.style.display = 'none';
        dropdown.innerHTML = '';
        dropdown.style.display = 'none';
        renderGallery(_allGalleryItems);
        input.focus();
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
document.addEventListener('DOMContentLoaded', () => {
    refreshGallery();
});

// Clean up URLs when page unloads
// Re-decode the current lightbox image (and neighbours) when the window becomes visible again.
// The GPU discards decoded bitmaps on minimize, so we kick off decode proactively
// while the OS is still compositing the window restore — by the time the first
// paint lands the bitmap is ready.
document.addEventListener('visibilitychange', () => {
    if (document.hidden || !lightboxOpen) return;

    // GPU dropped all bitmaps on minimize — clear stale promises so we re-decode fresh.
    _decodePromises.clear();

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
            const p = new Image();
            p.src = entry.fullUrl;
            const promise = p.decode().then(() => {
                console.log(`[lightbox] visibility restore decode complete: "${lightboxBatch[i].name}" (slot ${slot})  +${(performance.now()-_t).toFixed(1)}ms`);
            }).catch(() => {});
            _decodePromises.set(entry.fullUrl, promise);
        }, slot * 150);
    });
});

window.addEventListener('beforeunload', () => {
    revokeAllUrls();
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

    // Arrow navigation
    if (e.key === 'ArrowLeft')  { e.preventDefault(); navigateLightbox(-1); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); navigateLightbox(1);  return; }

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
});