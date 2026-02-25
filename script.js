// ─── IndexedDB ───────────────────────────────────────────────────────────────

const DB_NAME = 'hdr-gallery-db';
const STORE_NAME = 'files';

// Database operations
function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 6);
        
        request.onupgradeneeded = (event) => {
            const database = request.result;
            const oldVersion = event.oldVersion;
            
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                database.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
            }
            
            // v1 → v2: metadata field added; existing records get null, computed on first Details open
            if (oldVersion < 2) { /* no data migration needed */ }
            // v2 → v3: hdrType field added; existing records default to null
            if (oldVersion < 3) { /* no data migration needed */ }
            // v3 → v4: batchId field added; existing records default to null (treated as solo batches)
            if (oldVersion < 4) { /* no data migration needed */ }
            // v4 → v5: thumbBlob field added; existing records default to null (thumb generated on next import)
            if (oldVersion < 5) { /* no data migration needed */ }
            // v5 → v6: gameName field added per batch; existing records default to null
            if (oldVersion < 6) { /* no data migration needed */ }
        };
        
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// Generate a unique batch ID for a group of images uploaded together
function generateBatchId() {
    return `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function addImageFile(file, metadata = null, sdrBlob = null, hdrType = null, batchId = null, thumbBlob = null) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const entry = {
            name: file.name,
            type: file.type,
            blob: file,
            created: Date.now(),
            metadata: metadata,
            sdrBlob: sdrBlob,
            hdrType: hdrType,
            batchId: batchId,
            thumbBlob: thumbBlob,
            gameName: null,
        };
        const request = store.add(entry);
        
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function getAllImageFiles() {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAll();
        
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function deleteImageFile(id) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.delete(id);
        
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

async function updateImageMetadata(id, metadata) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const getRequest = store.get(id);
        
        getRequest.onsuccess = () => {
            const record = getRequest.result;
            if (record) {
                record.metadata = metadata;
                const updateRequest = store.put(record);
                updateRequest.onsuccess = () => resolve();
                updateRequest.onerror = () => reject(updateRequest.error);
            } else {
                reject(new Error('Record not found'));
            }
        };
        
        getRequest.onerror = () => reject(getRequest.error);
    });
}

async function updateImageHdrType(id, hdrType) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const getRequest = store.get(id);
        
        getRequest.onsuccess = () => {
            const record = getRequest.result;
            if (record) {
                record.hdrType = hdrType;
                const updateRequest = store.put(record);
                updateRequest.onsuccess = () => resolve();
                updateRequest.onerror = () => reject(updateRequest.error);
            } else {
                reject(new Error('Record not found'));
            }
        };
        
        getRequest.onerror = () => reject(getRequest.error);
    });
}

async function updateBatchGameName(batchId, gameName) {
    const database = await openDatabase();
    const allRecords = await new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readonly');
        const request = transaction.objectStore(STORE_NAME).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    const toUpdate = allRecords.filter(r => r.batchId === batchId);
    if (toUpdate.length === 0) return;
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        let pending = toUpdate.length;
        toUpdate.forEach(record => {
            record.gameName = gameName;
            const req = store.put(record);
            req.onsuccess = () => { if (--pending === 0) resolve(); };
            req.onerror = () => reject(req.error);
        });
    });
}

async function clearAllImageFiles() {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.clear();
        
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

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
const NATIVE_EXTENSIONS = ['.png'];                  // browser handles natively
const CONVERT_EXTENSIONS = ['.avif', '.jxr', '.exr', '.hdr', '.tiff', '.tif', '.heic', '.heif'];
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
};

// Always-current cursor position, used to immediately sample pixels when details mode is toggled on
let lastCursorX = 0;
let lastCursorY = 0;

document.addEventListener('mousemove', (e) => {
    lastCursorX = e.clientX;
    lastCursorY = e.clientY;
    cursorTooltip.style.left = (e.clientX + 14) + 'px';
    cursorTooltip.style.top  = (e.clientY + 14) + 'px';
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
        // If lightbox is open, apply nit-hunt cursor to the lightbox image and show details
        if (lightboxOpen) {
            const imgEl = document.querySelector('.lightbox-image');
            if (imgEl) imgEl.classList.add('cursor-nit-hunt');
            const wrapper = document.querySelector('.lightbox-image-wrapper');
            if (wrapper) wrapper.classList.add('cursor-nit-hunt');
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
            const wrapper = document.querySelector('.lightbox-image-wrapper');
            if (wrapper) wrapper.classList.remove('cursor-nit-hunt');
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
        const database = await openDatabase();
        const freshImageItem = await new Promise((resolve, reject) => {
            const transaction = database.transaction(STORE_NAME, 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.get(imageItem.id);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        
        metadata = freshImageItem?.metadata;
        
        // If still no metadata, extract it
        if (!metadata) {
            const blob = imageItem.blob instanceof Blob 
                ? imageItem.blob 
                : new Blob([imageItem.blob], { type: imageItem.type });
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
    const allowedFiles = selectedFiles.filter(isAllowedFile);
    const rejectedFiles = selectedFiles.filter(file => !isAllowedFile(file));

    if (rejectedFiles.length) {
        const rejectedNames = rejectedFiles.map(f => f.name).join(', ');
        alert(`Unsupported format(s): ${rejectedNames}\n\nSupported: PNG, AVIF, JXR, EXR, HDR, TIFF, HEIC`);
    }

    if (allowedFiles.length === 0) {
        showStatusMessage('No valid files selected', 'error');
        return;
    }

    // Show import modal — user picks HDR type before processing begins
    const hdrType = await showImportModal(allowedFiles.length);
    if (hdrType === null) {
        fileInput.value = '';
        return; // User cancelled
    }

    const toConvert = allowedFiles.filter(needsConversion);
    const native = allowedFiles.filter(f => !needsConversion(f));

    try {
        // Pre-load ImageMagick if any files need conversion
        if (toConvert.length > 0) {
            showProgress('Loading converter...');
            await getMagick();
        }

        const finalFiles = [...native];

        for (const file of toConvert) {
            showProgress(`Converting ${file.name}`);
            try {
                const converted = await convertToPNG(file);
                finalFiles.push(converted);
            } catch (err) {
                hideProgress();
                showStatusMessage(`Failed to convert ${file.name}: ${err.message}`, 'error');
                console.error('Conversion error:', err);
            }
        }
        hideProgress();

        if (finalFiles.length === 0) {
            showStatusMessage('No files could be processed', 'error');
            return;
        }

        showStatusMessage(`Adding ${finalFiles.length} file${finalFiles.length === 1 ? '' : 's'}...`, 'info');
        const batchId = generateBatchId();
        for (const file of finalFiles) {
            // Extract metadata before storing
            showProgress(`Processing metadata for ${file.name}`);
            const metadata = await extractMetadataFromFile(file);
            
            // Generate SDR version
            showProgress(`Generating SDR version for ${file.name}`);
            let sdrBlob = null;
            try {
                sdrBlob = await convertToSDR(file, file.name);
            } catch (error) {
                console.error('SDR conversion failed:', error);
            }

            // Generate HDR WebP thumbnail
            showProgress(`Generating thumbnail for ${file.name}`);
            let thumbBlob = null;
            try {
                thumbBlob = await generateThumb(file, 1280);
            } catch (error) {
                console.error('Thumbnail generation failed:', error);
            }

            await addImageFile(file, metadata, sdrBlob, hdrType, batchId, thumbBlob);
        }

        fileInput.value = '';
        await refreshGallery();
        showStatusMessage(`Successfully added ${finalFiles.length} image${finalFiles.length === 1 ? '' : 's'}`, 'success');
    } catch (error) {
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

    statusMessage.textContent = `Found ${allItems.length} image${allItems.length === 1 ? '' : 's'}`;
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

    statusMessage.textContent = visibleCount === allItems.length
        ? `Found ${allItems.length} image${allItems.length === 1 ? '' : 's'}`
        : `Found ${visibleCount} of ${allItems.length} image${allItems.length === 1 ? '' : 's'}`;
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
        const blob = item.blob instanceof Blob
            ? item.blob
            : new Blob([item.blob], { type: item.type });

        // Use WebP thumbnail for gallery display if available, fall back to full blob
        const displayBlob = (item.thumbBlob instanceof Blob)
            ? item.thumbBlob
            : blob;
        const url = URL.createObjectURL(displayBlob);
        createdUrls.push(url);

        const cell = document.createElement('div');
        cell.className = 'collage-cell';
        if (n >= 4 && idx === 0) cell.className += ' collage-cell-hero';

        const img = document.createElement('img');
        img.src = url;
        img.alt = item.name;
        img.className = 'collage-thumb';
        img.draggable = false;

        cell.appendChild(img);



        cell.addEventListener('click', () => openLightbox(batchItems, idx));
        grid.appendChild(cell);
    });

    // ── HDR type label in header ──
    const hdrTypeId = batchItems[0].hdrType;
    const hdrTypeDef = HDR_TYPES.find(t => t.id === hdrTypeId);
    let hdrLabel = null;
    let hdrClass = '';
    if (hdrTypeDef) {
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

function openLightbox(batchItems, startIndex) {
    if (lightboxOpen) closeLightbox();

    lightboxOpen = true;
    lightboxBatch = batchItems;
    lightboxIndex = startIndex;
    lightboxSdrActive = false;

    // Pre-create blob URLs for all images in the batch — reused on every navigation, no re-creation
    const lightboxBlobUrls = new Map();
    lightboxBatch.forEach(item => {
        const blob = item.blob instanceof Blob ? item.blob : new Blob([item.blob], { type: item.type });
        // Full-res URL (used for pixel-worker and save)
        const fullUrl = URL.createObjectURL(blob);
        lightboxCreatedUrls.push(fullUrl);
        // Display URL — use WebP thumbnail if available, otherwise full blob
        const displayBlob = (item.thumbBlob instanceof Blob) ? item.thumbBlob : blob;
        const displayUrl = displayBlob === blob ? fullUrl : URL.createObjectURL(displayBlob);
        if (displayBlob !== blob) lightboxCreatedUrls.push(displayUrl);
        lightboxBlobUrls.set(item.id, { url: displayUrl, fullUrl, blob });
    });

    // Pre-decode pixel buffers for all images in batch
    lightboxBatch.forEach(item => {
        if (!lightboxPixelBuffers.has(item.id)) {
            const { blob } = lightboxBlobUrls.get(item.id);
            const p = new Promise(resolve => {
                const worker = new Worker('./pixel-worker.js');
                blob.arrayBuffer().then(ab => worker.postMessage({ arrayBuffer: ab }, [ab]));
                worker.onmessage = e => { worker.terminate(); resolve(e.data.error ? null : e.data); };
                worker.onerror   = () => { worker.terminate(); resolve(null); };
            });
            lightboxPixelBuffers.set(item.id, p);
        }
    });

    // Build overlay
    const overlay = document.createElement('div');
    overlay.id = 'lightbox-overlay';
    overlay.className = 'lightbox-overlay';

    // Close on backdrop click — fires when clicking empty black areas.
    // Nav buttons use pointer-events:none when inactive so we check by position too.
    overlay.addEventListener('click', (e) => {
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
    imageWrapper.appendChild(imgEl);

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

    const saveBtn = document.createElement('button');
    saveBtn.className = 'button-secondary';
    saveBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Save';
    toolbarCenter.appendChild(saveBtn);

    const editBtn = document.createElement('button');
    editBtn.className = 'button-secondary';
    editBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Edit';
    toolbarCenter.appendChild(editBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'button-danger';
    deleteBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg> Delete';
    toolbarCenter.appendChild(deleteBtn);

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
            zoomTooltip.textContent = `1.0× zoom`;
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
            zoomTooltip.textContent = `${scrollZoomCurrent.toFixed(1)}× zoom`;
            return;
        }
        applyTransform();
        zoomTooltip.textContent = `${scrollZoomCurrent.toFixed(1)}× zoom`;
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
        zoomTooltip.textContent = `${currentZoomScale.toFixed(1)}× zoom`;
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
        zoomTooltip.textContent = `${scrollZoomCurrent.toFixed(1)}× zoom`;
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
            zoomTooltip.textContent = `${currentZoomScale.toFixed(1)}× zoom`;
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

    imgEl.addEventListener('mouseenter', async () => {
        lbMouseInside = true;
        if (!imageWrapper.querySelector('.inline-comparison-slider')) {
            if (globalDetailsEnabled) {
                imgEl.classList.add('cursor-nit-hunt');
                imageWrapper.classList.add('cursor-nit-hunt');
            } else {
                imgEl.classList.remove('cursor-nit-hunt');
                imageWrapper.classList.remove('cursor-nit-hunt');
            }
        }
        if (!globalDetailsEnabled) return;
        if (!lbPixelBuffer) {
            const item = lightboxBatch[lightboxIndex];
            const bufPromise = lightboxPixelBuffers.get(item.id);
            if (bufPromise) lbPixelBuffer = await bufPromise;
        }
        if (!lbPixelBuffer || !lbMouseInside || !globalDetailsEnabled) return;
        nitTooltip.style.display = 'block';
        const rect = imgEl.getBoundingClientRect();
        const imgX = Math.floor((lastCursorX - rect.left) * (lbPixelBuffer.width  / rect.width));
        const imgY = Math.floor((lastCursorY - rect.top)  * (lbPixelBuffer.height / rect.height));
        lbLastPixelX = imgX; lbLastPixelY = imgY;
        const { rNits, gNits, bNits, luminance } = getNitsAtPixel(lbPixelBuffer, imgX, imgY);
        const fmt = v => v < 10 ? v.toFixed(2) : Math.round(v);
        nitTooltip.innerHTML = `<div style="display:grid;grid-template-columns:auto auto auto;gap:0 4px;align-items:baseline;"><span>Nits</span><span>:</span><span style="text-align:right;">${fmt(luminance)}</span><span style="color:#ff6b6b;">R</span><span style="color:#ff6b6b;">:</span><span style="text-align:right;color:#ff6b6b;">${fmt(rNits)}</span><span style="color:#51cf66;">G</span><span style="color:#51cf66;">:</span><span style="text-align:right;color:#51cf66;">${fmt(gNits)}</span><span style="color:#4dabf7;">B</span><span style="color:#4dabf7;">:</span><span style="text-align:right;color:#4dabf7;">${fmt(bNits)}</span></div>`;
    });
    imgEl.addEventListener('mouseleave', () => {
        lbMouseInside = false;
        nitTooltip.style.display = 'none';
        lbLastPixelX = -1; lbLastPixelY = -1;
    });
    imgEl.addEventListener('mousemove', (e) => {
        if (!lbPixelBuffer || !globalDetailsEnabled) return;
        if (lbRafPending) return;
        lbRafPending = true;
        requestAnimationFrame(() => {
            lbRafPending = false;
            const rect = imgEl.getBoundingClientRect();
            const imgX = Math.floor((e.clientX - rect.left) * (lbPixelBuffer.width  / rect.width));
            const imgY = Math.floor((e.clientY - rect.top)  * (lbPixelBuffer.height / rect.height));
            if (imgX === lbLastPixelX && imgY === lbLastPixelY) return;
            lbLastPixelX = imgX; lbLastPixelY = imgY;
            const { rNits, gNits, bNits, luminance } = getNitsAtPixel(lbPixelBuffer, imgX, imgY);
            const fmt = v => v < 10 ? v.toFixed(2) : Math.round(v);
            nitTooltip.innerHTML = `<div style="display:grid;grid-template-columns:auto auto auto;gap:0 4px;align-items:baseline;"><span>Nits</span><span>:</span><span style="text-align:right;">${fmt(luminance)}</span><span style="color:#ff6b6b;">R</span><span style="color:#ff6b6b;">:</span><span style="text-align:right;color:#ff6b6b;">${fmt(rNits)}</span><span style="color:#51cf66;">G</span><span style="color:#51cf66;">:</span><span style="text-align:right;color:#51cf66;">${fmt(gNits)}</span><span style="color:#4dabf7;">B</span><span style="color:#4dabf7;">:</span><span style="text-align:right;color:#4dabf7;">${fmt(bNits)}</span></div>`;
        });
    });

    // ── Render function (called on init and navigation) ──
    async function renderLightboxImage() {
        const item = lightboxBatch[lightboxIndex];
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

        // Remove existing details overlay
        const existingOverlay = imageWrapper.querySelector('.image-meta-overlay');
        if (existingOverlay) existingOverlay.remove();

        // Update main image — always use full-res original for accurate HDR rendering
        const { url: displayUrl, fullUrl, blob } = lightboxBlobUrls.get(item.id);
        imgEl.src = fullUrl;

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
        if (hdrTypeDef) {
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

        // Pre-decode pixel buffer eagerly; once ready, show tooltip if mouse is already inside
        const bufPromise = lightboxPixelBuffers.get(item.id);
        if (bufPromise) bufPromise.then(buf => {
            lbPixelBuffer = buf;
            if (lbMouseInside && globalDetailsEnabled && buf) {
                nitTooltip.style.display = 'block';
                const rect = imgEl.getBoundingClientRect();
                const imgX = Math.floor((lastCursorX - rect.left) * (buf.width  / rect.width));
                const imgY = Math.floor((lastCursorY - rect.top)  * (buf.height / rect.height));
                lbLastPixelX = imgX; lbLastPixelY = imgY;
                const { rNits, gNits, bNits, luminance } = getNitsAtPixel(buf, imgX, imgY);
                const fmt = v => v < 10 ? v.toFixed(2) : Math.round(v);
                nitTooltip.innerHTML = `<div style="display:grid;grid-template-columns:auto auto auto;gap:0 4px;align-items:baseline;"><span>Nits</span><span>:</span><span style="text-align:right;">${fmt(luminance)}</span><span style="color:#ff6b6b;">R</span><span style="color:#ff6b6b;">:</span><span style="text-align:right;color:#ff6b6b;">${fmt(rNits)}</span><span style="color:#51cf66;">G</span><span style="color:#51cf66;">:</span><span style="text-align:right;color:#51cf66;">${fmt(gNits)}</span><span style="color:#4dabf7;">B</span><span style="color:#4dabf7;">:</span><span style="text-align:right;color:#4dabf7;">${fmt(bNits)}</span></div>`;
            }
        });

        // Pre-load adjacent images at full res so navigation feels instant
        [-1, 1].forEach(offset => {
            const adj = lightboxBatch[lightboxIndex + offset];
            if (adj) {
                const adjEntry = lightboxBlobUrls.get(adj.id);
                if (adjEntry) { const p = new Image(); p.src = adjEntry.fullUrl; }
            }
        });

        // Wire up action buttons for current item
        saveBtn.onclick = async () => {
            try {
                if (window.showSaveFilePicker) {
                    const fh = await window.showSaveFilePicker({ suggestedName: item.name });
                    const w = await fh.createWritable();
                    await w.write(blob);
                    await w.close();
                } else {
                    downloadFile(fullUrl, item.name);
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
            toolbarCenter.textContent = newGameName || 'Unknown Game';
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

        compareBtn.onclick = async () => {
            const existingSlider = imageWrapper.querySelector('.inline-comparison-slider');
            if (existingSlider) {
                if (existingSlider._cleanup) existingSlider._cleanup();
                existingSlider.remove();
                lightboxSdrActive = false;
                compareBtn.classList.remove('button-active');
                compareBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 6H3"/><path d="m7 12-4-4 4-4"/><path d="M3 18h18"/><path d="m17 12 4 4-4 4"/></svg> <u>S</u>DR Slider';
                return;
            }
            const db = await openDatabase();
            const fresh = await new Promise((res, rej) => {
                const tx = db.transaction(STORE_NAME, 'readonly');
                const req = tx.objectStore(STORE_NAME).get(item.id);
                req.onsuccess = () => res(req.result);
                req.onerror  = () => rej(req.error);
            });
            if (fresh?.sdrBlob) {
                const sdrUrl = URL.createObjectURL(fresh.sdrBlob);
                lightboxCreatedUrls.push(sdrUrl);

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

                imageWrapper.appendChild(slider);

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
                    zoomTooltip.textContent = '1.0× zoom';
                }

                sdrImg.src = sdrUrl;
                // If already cached, onload won't fire
                if (sdrImg.complete && sdrImg.naturalWidth > 0) activateSlider();

                lightboxSdrActive = true;
                compareBtn.classList.add('button-active');
            } else {
                showStatusMessage('SDR version not available', 'error');
            }
        };
    }

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
    renderLightboxImage();

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

function showProgress(label = '') {
    statusMessage.innerHTML = `
        <div class="progress-label">${label}</div>
        <div class="progress-dots">
            <div class="progress-dot"></div>
            <div class="progress-dot"></div>
            <div class="progress-dot"></div>
        </div>
    `;
}

function hideProgress() {
    statusMessage.innerHTML = '';
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
    panelRows += `<div class="imo-section-title" style="color:#aaa;">File Info</div>`;
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
        panelRows += `<div class="imo-section-title" style="color:#2b6cff;margin-top:8px;">HDR Metadata</div>`;
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
        panelRows += `<div class="imo-section-title" style="color:#51cf66;margin-top:8px;">Luminance</div>`;
        panelRows += imoRow(maxCLLlabel, maxCLLvalue);
        panelRows += imoRow('Max', `${metadata.luminanceStats.maxLuminance.toFixed(2)} cd/m²`);
        panelRows += imoRow('Avg', `${metadata.luminanceStats.avgLuminance.toFixed(2)} cd/m²`);
        panelRows += imoRow('Min', `${metadata.luminanceStats.minLuminance.toFixed(2)} cd/m²`);
    } else if (!metadata.hdr) {
        panelRows += `<div class="imo-section-title" style="color:#51cf66;margin-top:8px;">Luminance</div>`;
        panelRows += `<div class="imo-row" style="color:#666;font-size:11px;">Not available for this file type</div>`;
    }

    // Gamut
    if (metadata.gamutCoverage) {
        if (metadata.gamutCoverage.narrowSource) {
            panelRows += `<div class="imo-section-title" style="color:#a78bfa;margin-top:8px;">Gamut</div>`;
            panelRows += `<div class="imo-row" style="color:#666;font-size:11px;">Wide-gamut analysis requires a BT.2020 or P3 source</div>`;
        } else {
            panelRows += `<div class="imo-section-title" style="color:#a78bfa;margin-top:8px;">Gamut</div>`;
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

    imageWrapper.appendChild(overlay);

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
            const l = Math.max(minLeft, Math.min(minLeft + bRect.width  - pRect.width,  saved.left));
            const t = Math.max(minTop,  Math.min(minTop  + bRect.height - pRect.height, saved.top));
            panel.style.left = l + 'px';
            panel.style.top  = t + 'px';
        } else {
            panel.style.left = (minLeft + 10) + 'px';
            panel.style.top  = (minTop  + 10) + 'px';
        }

        // Drag logic
        const TEXT_TAGS = new Set(['SPAN', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'LABEL', 'A']);

        panel.addEventListener('mousedown', (e) => {
            const fromHandle = e.target.classList.contains('imo-drag-handle');
            const fromText   = TEXT_TAGS.has(e.target.tagName);
            if (!fromHandle && fromText) return;

            e.preventDefault();
            e.stopPropagation();

            const startLeft = parseFloat(panel.style.left);
            const startTop  = parseFloat(panel.style.top);
            const startX    = e.clientX;
            const startY    = e.clientY;

            function onMove(e) {
                const imgEl = imageWrapper.querySelector('.lightbox-image');
                const boundsEl = imgEl || overlay;
                const bRect = boundsEl.getBoundingClientRect();
                const oRect = overlay.getBoundingClientRect();
                const pRect = panel.getBoundingClientRect();
                const rawLeft = startLeft + e.clientX - startX;
                const rawTop  = startTop  + e.clientY - startY;
                // Clamp within image bounds, expressed as offsets relative to overlay
                const minLeft = bRect.left - oRect.left;
                const minTop  = bRect.top  - oRect.top;
                const maxLeft = minLeft + bRect.width  - pRect.width;
                const maxTop  = minTop  + bRect.height - pRect.height;
                panel.style.left = Math.max(minLeft, Math.min(maxLeft, rawLeft)) + 'px';
                panel.style.top  = Math.max(minTop,  Math.min(maxTop,  rawTop))  + 'px';
            }

            function onUp() {
                panel.style.cursor = 'grab';
                document.body.style.cursor = '';
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
                <span class="modal-subtitle">Select HDR type for this batch</span>
            </div>
            <div class="modal-body">
                <div class="hdr-type-grid" id="importHdrGrid"></div>
            </div>
            <div class="modal-footer">
                <button class="button-secondary modal-cancel">Cancel</button>
                <button class="modal-import" disabled>Import</button>
            </div>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        const grid = modal.querySelector('#importHdrGrid');
        let selected = null;
        const importBtn = modal.querySelector('.modal-import');

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
                    grid.querySelectorAll('.hdr-type-chip').forEach(c => c.classList.remove('selected'));
                    chip.classList.add('selected');
                    selected = type.id;
                    importBtn.disabled = false;
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
            resolve(selected);
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
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); clearTimeout(debounceTimer); doSearch(); }
            if (e.key === 'Escape') { e.stopPropagation(); resultsEl.innerHTML = ''; resultsEl.style.display = 'none'; }
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
                        selectedHdrType = 'none';
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
            resolve({ hdrType: selectedHdrType, gameName: selectedGameName });
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
        if (!q) { dropdown.style.display = 'none'; return; }

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

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            dropdown.innerHTML = '';
            dropdown.style.display = 'none';
            input.blur();
        }
        if (e.key === 'Enter') {
            dropdown.innerHTML = '';
            dropdown.style.display = 'none';
            renderGallery(_allGalleryItems);
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