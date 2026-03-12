const vscode = acquireVsCodeApi();

// --- State ---
let currentConfig = {};
let originalDataObjects = []; // Array of Objects for SQL
let originalRawData = []; // Array of Arrays for Render
let currentDisplayData = []; // Data currently being shown (full or filtered)
let autocompleteOptions = []; // Shared source for autocomplete
let currentFocus = -1; // Shared focus state for autocomplete
let isUpdating = false; // Guard for overlapping updates

// --- Query History State ---
let queryHistory = [];  // Most-recent first; max 50 entries
let historyIndex = -1;  // -1 = not navigating; 0 = most recent entry
let historyDraft = '';  // Draft text saved before navigating history

// --- Virtual Scrolling State ---
let rowHeight = 30; // Matches CSS height
let totalRows = 0;
let lastScrollTop = 0;
let columnWidths = []; // Array of pixel widths for columns

// Browsers clamp scrollTop at ~16–33 million px depending on engine.
// We cap the virtual spacer at 10M px and scale logical row positions into
// that range so files with billions of rows remain fully scrollable.
const MAX_SPACER_PX = 10_000_000;

// Convert a logical row index (0-based data rows, i.e. excluding header) to
// a scrollTop pixel value within the capped spacer.
function rowToScrollTop(rowIndex, dataRowCount) {
    const totalPx = dataRowCount * rowHeight;
    if (totalPx <= MAX_SPACER_PX) {
        return rowIndex * rowHeight; // no scaling needed
    }
    return (rowIndex / dataRowCount) * MAX_SPACER_PX;
}

// Convert a scrollTop pixel value back to a logical 0-based data row index.
function scrollTopToRow(scrollTop, dataRowCount) {
    const totalPx = dataRowCount * rowHeight;
    let row;
    if (totalPx <= MAX_SPACER_PX) {
        row = Math.floor(scrollTop / rowHeight); // no scaling needed
    } else {
        row = Math.floor((scrollTop / MAX_SPACER_PX) * dataRowCount);
    }
    // Clamp to valid range so the last page is always reachable when scrolled
    // to the very bottom (scrollTop === spacerHeight may map to dataRowCount).
    return Math.min(row, Math.max(0, dataRowCount - 1));
}

// Return the spacer height to use (capped).
function spacerHeight(dataRowCount) {
    return Math.min(dataRowCount * rowHeight, MAX_SPACER_PX);
}

// --- Chunked Paging State ---
// Active only when viewMode === 'chunked' (files >500MB)
let isChunkedMode = false;
let chunkedTotalRows = 0;       // Total data rows (excludes header) reported by extension
let chunkSize = 500;            // Rows per page (mirrors CHUNK_ROWS in extension)
let chunkedHeader = [];         // Header row (array of strings)
let chunkedCache = new Map();   // page index -> array of row arrays
let chunkedPending = new Set(); // pages currently in-flight
let chunkedLoadedPage = -1;     // The page currently rendered in the virtual table
let chunkedLoadedPageHasData = false; // true if the current render shows real data (not placeholders)
let chunkedScrollRaf = null;    // rAF handle — cancelled on each new scroll event

// --- DOM Elements ---
const queryInput = document.getElementById('sql-query');
const runButton = document.getElementById('run-query');
const resetButton = document.getElementById('reset-query');
const historyBtn = document.getElementById('history-btn');
const historyListEl = document.getElementById('history-list');
const errorContainer = document.getElementById('error-container');
const loader = document.getElementById('loader');
const warningContainer = document.getElementById('warning-container');
const headerContainer = document.querySelector('.header-container');
const headerTable = document.getElementById('header-table');
const tableContainer = document.querySelector('.table-container');
const virtualSpacer = document.getElementById('virtual-spacer');
const textContainer = document.getElementById('text-container');
const rawTextArea = document.getElementById('raw-text');
const table = document.getElementById('csv-table'); // This is now the body table
const controls = document.getElementById('controls');
const errorRuler = document.getElementById('error-ruler');
const slowLoadModal = document.getElementById('slow-load-modal');
const switchToTextBtn = document.getElementById('switch-to-text');
const continueWaitingBtn = document.getElementById('continue-waiting');

// --- Constants ---
const sqlKeywords = ['SELECT', 'FROM', 'WHERE', 'ORDER BY', 'GROUP BY', 'LIMIT', 'JOIN', 'ON', 'AS', 'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MAX', 'MIN', 'LIKE', 'IN', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END'];
const SLOW_LOAD_TIMEOUT = 25000; // 25 seconds
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

let slowLoadTimer;
let isRenderingInterrupted = false;
let currentText = "";

// --- Event Listeners (Attached Once) ---

if (tableContainer) {
    tableContainer.addEventListener('scroll', () => {
        // Sync horizontal scroll
        if (headerContainer) {
            headerContainer.scrollLeft = tableContainer.scrollLeft;
        }

        if (isChunkedMode) {
            handleChunkedScroll();
        } else if (currentDisplayData.length > 50) {
            // Virtual vertical scroll
            handleScroll();
        }
    });
}

function handleScroll() {
    requestAnimationFrame(() => {
        updateVirtualTable();
    });
}

// ---- Chunked paging scroll handler ----
// Cancels any pending rAF from a prior scroll event so only the final
// scroll position of a drag gesture triggers a page change.
function handleChunkedScroll() {
    if (chunkedScrollRaf !== null) {
        cancelAnimationFrame(chunkedScrollRaf);
    }
    chunkedScrollRaf = requestAnimationFrame(() => {
        chunkedScrollRaf = null;
        const scrollTop = tableContainer.scrollTop;
        const firstVisibleRow = scrollTopToRow(scrollTop, chunkedTotalRows); // 0-based data row
        const currentPage = Math.floor(firstVisibleRow / chunkSize);
        // Always render the current page — show placeholder rows if not cached yet
        renderChunkedPage(currentPage);

        // Fetch current page, one page ahead, and one page behind if not cached or in-flight.
        // Including currentPage-1 ensures backward scrolls don't flash placeholders.
        const maxPage = chunkedTotalRows > 0 ? Math.ceil(chunkedTotalRows / chunkSize) - 1 : 0;
        [currentPage - 1, currentPage, currentPage + 1].forEach(page => {
            if (page >= 0 && page <= maxPage && !chunkedCache.has(page) && !chunkedPending.has(page)) {
                fetchChunkedPage(page);
            }
        });
    });
}

function fetchChunkedPage(page) {
    chunkedPending.add(page);
    const startRow = page * chunkSize;
    vscode.postMessage({
        type: 'requestPage',
        startRow,
        rowCount: chunkSize
    });
}

// Render a cached page (or placeholder rows) into the virtual table body.
function renderChunkedPage(page) {
    const rows = chunkedCache.get(page) || null;
    const hasData = rows !== null;

    // Skip re-render only if we already rendered this page with real data.
    // If we previously rendered placeholders and data has now arrived, fall
    // through so the real rows replace the loading skeletons.
    if (chunkedLoadedPage === page && chunkedLoadedPageHasData) { return; }
    // Also skip if same page and still no data (nothing would change).
    if (chunkedLoadedPage === page && !hasData) { return; }

    chunkedLoadedPage = page;
    chunkedLoadedPageHasData = hasData;

    const pageStartDataRow = page * chunkSize; // 0-based in data space

    const tbody = table.querySelector('tbody');
    if (!tbody) { return; }

    // Move the tbody to the correct position BEFORE writing rows,
    // so the browser never briefly shows it at the wrong offset.
    tbody.style.transform = `translateY(${rowToScrollTop(pageStartDataRow, chunkedTotalRows)}px)`;

    const rowCount = hasData
        ? rows.length
        : Math.max(0, Math.min(chunkSize, chunkedTotalRows - pageStartDataRow));

    let html = '';
    for (let i = 0; i < rowCount; i++) {
        html += `<tr style="height: ${rowHeight}px">`;
        if (hasData) {
            const row = rows[i];
            for (let c = 0; c < columnWidths.length; c++) {
                html += `<td>${escapeHtml(row[c] || '')}</td>`;
            }
        } else {
            // Placeholder: empty cells while the page loads
            for (let c = 0; c < columnWidths.length; c++) {
                html += `<td class="chunked-loading-cell"></td>`;
            }
        }
        html += '</tr>';
    }
    tbody.innerHTML = html;
}

function updateVirtualTable() {
    if (isChunkedMode) { return; } // chunked mode manages its own rendering
    if (!currentDisplayData || currentDisplayData.length === 0) return;
    
    const scrollTop = tableContainer.scrollTop;
    const containerHeight = tableContainer.clientHeight;
    const visibleRowCount = Math.ceil(containerHeight / rowHeight);
    const dataRowCount = currentDisplayData.length - 1; // exclude header

    // Map scrollTop → logical data row index (accounts for spacer scaling)
    let startRow = scrollTopToRow(scrollTop, dataRowCount);
    // Data starts at index 1 (row 0 is header)
    startRow = Math.max(1, startRow);
    
    const buffer = 10;
    const renderStart = Math.max(1, startRow - buffer);
    const renderEnd = Math.min(currentDisplayData.length, startRow + visibleRowCount + buffer);
    
    const slice = currentDisplayData.slice(renderStart, renderEnd);
    
    const tbody = table.querySelector('tbody');
    if (!tbody) return;
    
    let html = '';
    for (let i = 0; i < slice.length; i++) {
        const row = slice[i];
        html += `<tr style="height: ${rowHeight}px">`;
        for (let colIndex = 0; colIndex < columnWidths.length; colIndex++) {
            const cell = row[colIndex] || '';
            html += `<td>${escapeHtml(cell)}</td>`;
        }
        html += '</tr>';
    }
    
    tbody.innerHTML = html;
    
    // Position the tbody using the scaled pixel offset for renderStart
    // (renderStart is 1-based; subtract 1 to get 0-based data row index)
    const tbodyOffset = rowToScrollTop(renderStart - 1, dataRowCount);
    tbody.style.transform = `translateY(${tbodyOffset}px)`;
}

function positionErrorRuler() {
    if (!errorRuler) return;
    const activeContainer = tableContainer.classList.contains('hidden') ? textContainer : tableContainer;
    const rect = activeContainer.getBoundingClientRect();
    errorRuler.style.top = rect.top + 'px';
    errorRuler.style.height = rect.height + 'px';
    errorRuler.style.bottom = 'auto';
}

window.addEventListener('resize', positionErrorRuler);

// Update ruler position when containers are shown/hidden
const layoutObserver = new MutationObserver(() => {
    positionErrorRuler();
});
if (errorContainer) layoutObserver.observe(errorContainer, { attributes: true, attributeFilter: ['class'] });
if (warningContainer) layoutObserver.observe(warningContainer, { attributes: true, attributeFilter: ['class'] });
if (tableContainer) layoutObserver.observe(tableContainer, { attributes: true, attributeFilter: ['class'] });
if (textContainer) layoutObserver.observe(textContainer, { attributes: true, attributeFilter: ['class'] });

// Modal handlers
if (switchToTextBtn) {
    switchToTextBtn.addEventListener('click', () => {
        isRenderingInterrupted = true;
        if (slowLoadModal) slowLoadModal.classList.add('hidden');
        switchToPlainTextMode();
    });
}

if (continueWaitingBtn) {
    continueWaitingBtn.addEventListener('click', () => {
        if (slowLoadModal) slowLoadModal.classList.add('hidden');
    });
}

function switchToPlainTextMode() {
    if (currentConfig.forceTextColumnColoring) {
        warningContainer.textContent = "Viewing as Plain Text: Row stripes & Column coloring enabled (Force Mode).";
        rawTextArea.innerHTML = colorizeCSV(currentText);
    } else {
        warningContainer.textContent = "Viewing as Plain Text: Row stripes enabled. Column coloring is disabled to ensure instant performance.";
        rawTextArea.textContent = currentText;
    }
    warningContainer.classList.remove('hidden');
    tableContainer.classList.add('hidden');
    textContainer.classList.remove('hidden');
    controls.classList.add('hidden');
    if (errorRuler) errorRuler.classList.add('hidden');
    hideLoader();
}

// 1. Message Handler
window.addEventListener('message', event => {
    // Only accept messages from the VS Code webview host
    // VS Code webview messages have origin set to the vscode-webview scheme
    if (event.origin && !event.origin.startsWith('vscode-webview://')) {
        console.warn('Ignoring message from unexpected origin:', event.origin);
        return;
    }
    const message = event.data;
    switch (message.type) {
        case 'update':
            currentText = message.text;
            // Reset guard — a fresh 'update' message always supersedes any prior render in progress
            isUpdating = false;
            showLoader();
            isRenderingInterrupted = false;
            clearTimeout(slowLoadTimer);

            if (message.config.showSlowLoadPrompt && message.viewMode !== 'chunked') {
                slowLoadTimer = setTimeout(() => {
                    if (loader && !loader.classList.contains('hidden')) {
                        if (slowLoadModal) slowLoadModal.classList.remove('hidden');
                    }
                }, SLOW_LOAD_TIMEOUT);
            }

            if (message.viewMode === 'chunked') {
                // ---- Chunked paging mode (files >500MB) ----
                isChunkedMode = true;
                chunkedTotalRows = message.totalRows || 0;
                chunkSize = message.chunkSize || 500;
                chunkedCache.clear();
                chunkedPending.clear();
                chunkedLoadedPage = -1;
                chunkedLoadedPageHasData = false;
                if (chunkedScrollRaf !== null) { cancelAnimationFrame(chunkedScrollRaf); chunkedScrollRaf = null; }
                chunkedPagePending = false;

                warningContainer.textContent =
                    chunkedTotalRows > 0
                        ? `Paged View: ${chunkedTotalRows.toLocaleString()} rows total. ` +
                          `Showing ${chunkSize} rows at a time. SQL queries and editing are disabled in this mode.`
                        : `Paged View: Indexing file\u2026 SQL queries and editing are disabled in this mode.`;
                warningContainer.classList.remove('hidden');
                tableContainer.classList.remove('hidden');
                headerContainer.classList.remove('hidden');
                textContainer.classList.add('hidden');
                controls.classList.add('hidden'); // SQL bar hidden
                if (errorRuler) errorRuler.classList.add('hidden');

                setTimeout(async () => {
                    try {
                        await initChunkedView(message.text, message.config);
                    } catch (e) {
                        console.error('Error initialising chunked view:', e);
                        errorContainer.textContent = 'Error loading CSV: ' + e.message;
                        errorContainer.classList.remove('hidden');
                    } finally {
                        hideLoader();
                    }
                }, 50);

            } else if (message.viewMode === 'head') {
                isChunkedMode = false;
                warningContainer.textContent = "Viewing Sample: Top 1000 rows. SQL queries will only run against this sample.";
                warningContainer.classList.remove('hidden');
                tableContainer.classList.remove('hidden');
                headerContainer.classList.remove('hidden');
                textContainer.classList.add('hidden');
                controls.classList.remove('hidden');
                if (errorRuler) errorRuler.classList.remove('hidden');
            } else if (message.viewMode === 'tail') {
                isChunkedMode = false;
                warningContainer.textContent = "Viewing Sample: Bottom 1000 rows. SQL queries will only run against this sample.";
                warningContainer.classList.remove('hidden');
                tableContainer.classList.remove('hidden');
                headerContainer.classList.remove('hidden');
                textContainer.classList.add('hidden');
                controls.classList.remove('hidden');
                if (errorRuler) errorRuler.classList.remove('hidden');
            } else if (message.viewMode === 'text') {
                isChunkedMode = false;
                if (message.config.forceTextColumnColoring) {
                    warningContainer.textContent = "Viewing as Plain Text: Row stripes & Column coloring enabled (Force Mode).";
                    rawTextArea.innerHTML = colorizeCSV(message.text);
                } else {
                    warningContainer.textContent = "Viewing as Plain Text: Row stripes enabled. Column coloring is disabled to ensure instant performance.";
                    rawTextArea.textContent = message.text;
                }
                warningContainer.classList.remove('hidden');
                tableContainer.classList.add('hidden');
                headerContainer.classList.add('hidden');
                textContainer.classList.remove('hidden');
                controls.classList.add('hidden');
                if (errorRuler) errorRuler.classList.add('hidden');
            } else if (message.isLargeFile) {
                isChunkedMode = false;
                const threshold = message.config.safeModeThreshold || 5;
                warningContainer.textContent = `Warning: This file is large (>${threshold}MB) and may cause performance issues.`;
                warningContainer.classList.remove('hidden');
                tableContainer.classList.remove('hidden');
                headerContainer.classList.remove('hidden');
                textContainer.classList.add('hidden');
                controls.classList.remove('hidden');
                if (errorRuler) errorRuler.classList.remove('hidden');
            } else {
                isChunkedMode = false;
                warningContainer.classList.add('hidden');
                tableContainer.classList.remove('hidden');
                headerContainer.classList.remove('hidden');
                textContainer.classList.add('hidden');
                controls.classList.remove('hidden');
                if (errorRuler) errorRuler.classList.remove('hidden');
            }

            // Use setTimeout to allow the browser to render the loader
            // (skip for chunked — it handles its own async path above)
            if (message.viewMode !== 'chunked') {
                setTimeout(async () => {
                    if (isUpdating) return;
                    isUpdating = true;

                    // Preserve scroll position
                    const savedScrollTop = tableContainer.scrollTop;
                    const savedScrollLeft = tableContainer.scrollLeft;

                    try {
                        if (message.viewMode !== 'text') {
                            await updateContent(message.text, message.config);

                            // Restore scroll position
                            tableContainer.scrollTop = savedScrollTop;
                            tableContainer.scrollLeft = savedScrollLeft;
                            // Trigger one manual virtual sync to ensure correct rows are shown
                            updateVirtualTable();
                        }
                    } catch (e) {
                        console.error("Error updating content:", e);
                        errorContainer.textContent = "Error loading CSV: " + e.message;
                        errorContainer.classList.remove('hidden');
                    } finally {
                        isUpdating = false;
                        hideLoader();
                    }
                }, 50);
            }
            break;

        case 'pageData':
            // Response to a 'requestPage' message — parse and cache, then render.
            handlePageData(message);
            break;

        case 'indexReady':
            // The extension has finished building the row index.
            // Update the total row count and resize the virtual spacer.
            chunkedTotalRows = message.totalRows;
            if (virtualSpacer) {
                virtualSpacer.style.height = spacerHeight(chunkedTotalRows) + 'px';
            }
            // Update the warning banner with the real row count.
            if (warningContainer && isChunkedMode) {
                warningContainer.textContent =
                    `Paged View: ${chunkedTotalRows.toLocaleString()} rows total. ` +
                    `Showing ${chunkSize} rows at a time. SQL queries and editing are disabled in this mode.`;
            }
            // Re-evaluate the current scroll position now that we know the true row
            // count. This matters when the user jumped (e.g. CMD+Down) before the
            // index was ready — at that point chunkedTotalRows was 0, so every scroll
            // mapped to row 0. Now that we have the real count, re-trigger the scroll
            // handler so the correct page is fetched and rendered.
            if (isChunkedMode) {
                chunkedLoadedPage = -1; // invalidate so renderChunkedPage isn't skipped
                chunkedLoadedPageHasData = false;
                handleChunkedScroll();
            }
            break;
    }
});

// ---- Chunked mode initialisation ----
// Called with the first chunk (header + first N rows) sent by the extension.
async function initChunkedView(text, config) {
    currentConfig = config;
    const { data } = await parseCSV(text);
    if (data.length === 0) { return; }

    chunkedHeader = data[0]; // first row is the header

    // Cache page 0 (data rows from the first chunk, excluding the header row)
    const page0Rows = data.slice(1); // rows 1..N
    chunkedCache.set(0, page0Rows);
    chunkedLoadedPage = -1; // force re-render
    chunkedLoadedPageHasData = false;

    // Build the table skeleton (header + empty body + correct spacer height)
    await renderChunkedTable();

    // Render page 0 immediately
    renderChunkedPage(0);
}

// Render table structure for chunked mode.
// Sets up the header, colgroup, empty tbody, and the virtual spacer height.
async function renderChunkedTable() {
    if (!table || !virtualSpacer) { return; }

    if (currentConfig.alternatingRows) {
        table.classList.add('alternating-rows');
    } else {
        table.classList.remove('alternating-rows');
    }

    // Calculate column widths from the header (no data sample available yet)
    columnWidths = chunkedHeader.map(h => {
        const charWidth = 9;
        const padding = 24;
        return Math.max(100, Math.min(600, (h.length * charWidth) + padding));
    });

    // Widen columns once page 0 rows arrive
    const page0 = chunkedCache.get(0) || [];
    const sample = page0.slice(0, 50);
    columnWidths = chunkedHeader.map((h, colIndex) => {
        let maxLen = h.length;
        sample.forEach(row => {
            const len = row[colIndex] ? row[colIndex].length : 0;
            if (len > maxLen) { maxLen = len; }
        });
        const charWidth = 9;
        const padding = 24;
        return Math.max(100, Math.min(600, (maxLen * charWidth) + padding));
    });

    const totalWidth = columnWidths.reduce((a, b) => a + b, 0);

    // Header table
    if (headerTable) {
        headerTable.innerHTML = '';
        headerTable.appendChild(createColGroup(columnWidths));
        headerTable.style.width = totalWidth + 'px';
        const thead = document.createElement('thead');
        const trHead = document.createElement('tr');
        chunkedHeader.forEach(colName => {
            const th = document.createElement('th');
            th.textContent = colName;
            trHead.appendChild(th);
        });
        thead.appendChild(trHead);
        headerTable.appendChild(thead);
    }

    // Body table
    table.innerHTML = '';
    table.appendChild(createColGroup(columnWidths));
    table.style.width = totalWidth + 'px';
    const tbody = document.createElement('tbody');
    table.appendChild(tbody);

    // Scrollbar compensation
    const scrollbarWidth = tableContainer.offsetWidth - tableContainer.clientWidth;
    if (headerContainer) {
        headerContainer.style.paddingRight = scrollbarWidth + 'px';
    }

    // Virtual spacer: capped height covering all data rows
    virtualSpacer.style.height = spacerHeight(chunkedTotalRows) + 'px';
}

// Handle a 'pageData' message from the extension host.
function handlePageData(message) {
    const startRow = message.startRow || 0; // 0-based data row
    const page = Math.floor(startRow / chunkSize);
    // Keep page in chunkedPending until parseCSV finishes so scroll handler
    // doesn't re-request it during the async parse gap.
    // Parse the raw CSV text (no header in this chunk)
    parseCSV(message.text).then(({ data }) => {
        chunkedPending.delete(page); // now safe to remove — cache is about to be set
        chunkedCache.set(page, data);

        // Evict pages that are far from the current view (keep a window of ±15 pages).
        // Use distance-based eviction, NOT count-based, so the current page is never
        // immediately evicted after being inserted.
        const currentViewPage = chunkedLoadedPage >= 0 ? chunkedLoadedPage : page;
        for (const key of [...chunkedCache.keys()]) {
            if (Math.abs(key - currentViewPage) > 15) {
                chunkedCache.delete(key);
            }
        }

        // If this page is currently displayed (possibly as placeholders), upgrade it.
        // renderChunkedPage() now detects the placeholder→data transition itself, so
        // we just need to clear the "has data" guard and call render.
        if (page === chunkedLoadedPage) {
            chunkedLoadedPageHasData = false; // allow re-render with real data
            renderChunkedPage(page);
        }
    });
}



function showLoader() {
    if (loader) loader.classList.remove('hidden');
}

function hideLoader() {
    if (loader) loader.classList.add('hidden');
}


// 2. Button Handlers
runButton.addEventListener('click', runQuery);
resetButton.addEventListener('click', resetQuery);

// History Button Handler
if (historyBtn) {
    historyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = historyListEl && !historyListEl.classList.contains('hidden');
        if (isOpen) {
            closeHistoryList();
        } else {
            openHistoryList();
        }
        queryInput.focus();
    });
}

// Close history list when clicking outside
document.addEventListener('click', (e) => {
    if (historyListEl && e.target !== historyBtn && e.target !== queryInput && !historyListEl.contains(e.target)) {
        closeHistoryList();
    }
});

// --- History Helpers ---

function openHistoryList() {
    if (!historyListEl) return;
    renderHistoryList();
    historyListEl.classList.remove('hidden');
    if (historyBtn) historyBtn.classList.add('history-open');
}

function closeHistoryList() {
    if (!historyListEl) return;
    historyListEl.classList.add('hidden');
    if (historyBtn) historyBtn.classList.remove('history-open');
}

function renderHistoryList() {
    if (!historyListEl) return;
    historyListEl.innerHTML = '';

    if (queryHistory.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'history-empty';
        empty.textContent = 'No query history yet. Run a query to start.';
        historyListEl.appendChild(empty);
        return;
    }

    queryHistory.forEach((query, i) => {
        const item = document.createElement('div');
        item.className = 'history-item';
        item.dataset.query = query;
        item.dataset.index = i;

        const idxSpan = document.createElement('span');
        idxSpan.className = 'history-item-index';
        idxSpan.textContent = `#${i + 1}`;

        const textSpan = document.createElement('span');
        textSpan.className = 'history-item-text';
        textSpan.textContent = query;
        textSpan.title = query;

        item.appendChild(idxSpan);
        item.appendChild(textSpan);

        item.addEventListener('click', () => {
            queryInput.value = query;
            closeHistoryList();
            historyIndex = -1;
            historyDraft = '';
            queryInput.focus();
            queryInput.selectionStart = queryInput.selectionEnd = queryInput.value.length;
        });

        historyListEl.appendChild(item);
    });
}

/** Navigate the visual history panel up (-1) or down (+1) */
function navigateHistoryPanel(direction) {
    if (!historyListEl) return;
    const items = Array.from(historyListEl.querySelectorAll('.history-item'));
    if (items.length === 0) return;

    const currentActiveIdx = items.findIndex(el => el.classList.contains('history-active'));
    let nextIdx = currentActiveIdx + direction;
    if (nextIdx < 0) nextIdx = 0;
    if (nextIdx >= items.length) nextIdx = items.length - 1;

    items.forEach(el => el.classList.remove('history-active'));
    const nextItem = items[nextIdx];
    nextItem.classList.add('history-active');
    nextItem.scrollIntoView({ block: 'nearest' });

    // Preview the query in the input
    queryInput.value = nextItem.dataset.query;
    queryInput.selectionStart = queryInput.selectionEnd = queryInput.value.length;
}


if (tableContainer) {
    // Single-click to select, Double-click to edit
    tableContainer.addEventListener('dblclick', (e) => {
        if (isChunkedMode) { return; } // editing disabled for large paged files
        const cell = e.target;
        if ((cell.tagName === 'TD' || cell.tagName === 'TH') && cell.contentEditable !== 'true') {
            cell.contentEditable = 'true';
            cell.focus();
            
            // Select all text for easier editing of long strings
            const range = document.createRange();
            range.selectNodeContents(cell);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        }
    });

    tableContainer.addEventListener('focusout', (e) => {
        if (e.target.tagName === 'TD' || e.target.tagName === 'TH') {
            onCellChange(e);
            e.target.contentEditable = 'false';
        }
    }, true);

    // Prevent arrow keys from bubbling up during edit mode to avoid defocusing/scrolling
    tableContainer.addEventListener('keydown', (e) => {
        const cell = e.target;
        if ((cell.tagName === 'TD' || cell.tagName === 'TH') && cell.contentEditable === 'true') {
            if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
                e.stopPropagation();
            }
        }
    }, true);

    // Show hover info dynamically
    tableContainer.addEventListener('mouseover', (e) => {
        const cell = e.target;
        if (cell.tagName === 'TD' || cell.tagName === 'TH') {
            if (!cell.title) {
                const colIndex = cell.cellIndex;
                const headerRow = currentDisplayData[0] || [];
                const colName = headerRow[colIndex] || `Column ${colIndex}`;
                
                const rowInTable = cell.parentElement.rowIndex;
                const scrollTop = tableContainer.scrollTop;
                const startRow = Math.max(1, Math.floor(scrollTop / rowHeight));
                const buffer = 10;
                const renderStart = Math.max(1, startRow - buffer);
                
                const absoluteRowIndex = renderStart + rowInTable; 
                cell.title = `Row: ${absoluteRowIndex}\nColumn: ${colName}`;
            }
        }
    });
}

// 3. Autocomplete: Input Event
queryInput.addEventListener("input", function(e) {
    var a, b, i, val = this.value;
    closeAllLists();
    if (!val) { return false;}
    currentFocus = -1;
    
    const cursorMoved = this.selectionStart;
    const textBefore = val.substring(0, cursorMoved);
    const match = textBefore.match(/([a-zA-Z0-9_[\]]+)$/); 
    
    if (!match) return false;
    
    const currentWord = match[0];
    const isBracketStart = currentWord.startsWith('[');
    const searchWord = isBracketStart ? currentWord.substring(1) : currentWord;

    a = document.createElement("DIV");
    a.setAttribute("id", this.id + "autocomplete-list");
    a.setAttribute("class", "autocomplete-items");
    this.parentNode.appendChild(a);
    
    let matches = [];

    for (i = 0; i < autocompleteOptions.length; i++) {
        const item = autocompleteOptions[i];
        let isMatch = false;
        let displayHtml = "";
        let insertVal = item;

        if (item.toUpperCase().startsWith(currentWord.toUpperCase())) {
            isMatch = true;
            displayHtml = "<strong>" + escapeHtml(item.substr(0, currentWord.length)) + "</strong>" + escapeHtml(item.substr(currentWord.length));
        } 
        else if (isBracketStart) {
            if (!item.startsWith('[') && item.toUpperCase().startsWith(searchWord.toUpperCase())) {
                isMatch = true;
                displayHtml = "<strong>[" + escapeHtml(item.substr(0, searchWord.length)) + "</strong>" + escapeHtml(item.substr(searchWord.length)) + "]";
                insertVal = /^[a-zA-Z0-9_]+$/.test(item) ? item : `[${item.replace(/\]/g, ']]')}]`;
            }
        }

        if (isMatch) {
            matches.push(insertVal);
            b = document.createElement("DIV");

            // Build autocomplete display using safe DOM methods instead of innerHTML
            const strongEl = document.createElement("strong");
            const trailingText = document.createTextNode("");
            if (item.toUpperCase().startsWith(currentWord.toUpperCase())) {
                strongEl.textContent = item.substr(0, currentWord.length);
                trailingText.textContent = item.substr(currentWord.length);
            } else if (isBracketStart) {
                strongEl.textContent = "[" + item.substr(0, searchWord.length);
                trailingText.textContent = item.substr(searchWord.length) + "]";
            }
            b.appendChild(strongEl);
            b.appendChild(trailingText);

            const hiddenInput = document.createElement("input");
            hiddenInput.type = "hidden";
            hiddenInput.value = insertVal;
            b.appendChild(hiddenInput);

            b.addEventListener("click", function(e) {
                insertValue(this.getElementsByTagName("input")[0].value);
                closeAllLists();
                queryInput.focus();
            });
            a.appendChild(b);
        }
    }
    
    a.dataset.matches = JSON.stringify(matches);
    a.dataset.word = currentWord;
});

// 4. Autocomplete: Keydown Event
queryInput.addEventListener("keydown", function(e) {
    var x = document.getElementById(this.id + "autocomplete-list");
    if (x) x = x.getElementsByTagName("div");
    
    const autocompleteOpen = x && x.length > 0;
    const historyOpen = historyListEl && !historyListEl.classList.contains('hidden');

    if (e.key === "ArrowDown") {
        if (autocompleteOpen) {
            currentFocus++;
            if (currentFocus >= x.length) currentFocus = 0; 
            addActive(x);
            e.preventDefault();
        } else if (historyOpen) {
            // Navigate down through history panel
            navigateHistoryPanel(1);
            e.preventDefault();
        } else {
            // History navigation: go forward (newer entry)
            if (historyIndex > -1) {
                historyIndex--;
                queryInput.value = historyIndex === -1 ? historyDraft : queryHistory[historyIndex];
                queryInput.selectionStart = queryInput.selectionEnd = queryInput.value.length;
                e.preventDefault();
            }
        }
    } else if (e.key === "ArrowUp") {
        if (autocompleteOpen) {
            currentFocus--;
            if (currentFocus < -1) currentFocus = x.length - 1; 
            addActive(x);
            e.preventDefault();
        } else if (historyOpen) {
            // Navigate up through history panel
            navigateHistoryPanel(-1);
            e.preventDefault();
        } else {
            // History navigation: go back (older entry)
            if (queryHistory.length > 0) {
                if (historyIndex === -1) {
                    historyDraft = queryInput.value; // save current draft
                }
                if (historyIndex < queryHistory.length - 1) {
                    historyIndex++;
                    queryInput.value = queryHistory[historyIndex];
                    queryInput.selectionStart = queryInput.selectionEnd = queryInput.value.length;
                }
                e.preventDefault();
            }
        }
    } else if (e.key === "Escape") {
        if (historyOpen) {
            closeHistoryList();
            e.preventDefault();
        }
    } else if (e.key === "Enter") {
        if (historyOpen) {
            // Select active history item
            const activeItem = historyListEl.querySelector('.history-item.history-active');
            if (activeItem) {
                const query = activeItem.dataset.query;
                queryInput.value = query;
                closeHistoryList();
                historyIndex = -1;
                historyDraft = '';
                queryInput.focus();
                e.preventDefault();
                return;
            }
        }
        if (currentFocus > -1) {
            if (autocompleteOpen) {
                e.preventDefault();
                x[currentFocus].click();
            }
        } else {
            if (autocompleteOpen) {
                closeAllLists();
            } else {
                runQuery(); 
            }
        }
    } else if (e.key === "Tab") {
         if (x && x.length > 0) {
             e.preventDefault();
             const container = document.getElementById(this.id + "autocomplete-list");
             if (!container) return;
             
             const matches = JSON.parse(container.dataset.matches || "[]");
             const currentWord = container.dataset.word;
             
             if (matches.length === 1) {
                 insertValue(matches[0]);
                 closeAllLists();
             } else if (matches.length > 1) {
                 const common = sharedStart(matches);
                 if (common.length > currentWord.length) {
                      insertValue(common);
                      var event = new Event('input', { bubbles: true });
                      this.dispatchEvent(event);
                 }
             }
         }
    }
});

// 5. Global Click (Close lists)
document.addEventListener("click", function (e) {
    closeAllLists(e.target);
});

// --- Core Logic ---

async function updateContent(text, config) {
    currentConfig = config;
    const { data, errors } = await parseCSV(text);
    
    originalRawData = data;
    currentDisplayData = data;
    originalDataObjects = []; 

    const columns = data.length > 0 ? data[0].map(c => {
        return /^[a-zA-Z0-9_]+$/.test(c) ? c : `[${c.replace(/\]/g, ']]')}]`;
    }) : [];
    
    autocompleteOptions = [...sqlKeywords, ...columns];

    await renderTable(data, errors);
}

// --- Autocomplete Helpers ---

function addActive(x) {
    if (!x) return false;
    removeActive(x);
    if (currentFocus < 0 || currentFocus >= x.length) return; 
    x[currentFocus].classList.add("autocomplete-active");
    x[currentFocus].scrollIntoView({ block: 'nearest' });
}

function removeActive(x) {
    for (var i = 0; i < x.length; i++) {
        x[i].classList.remove("autocomplete-active");
    }
}

function closeAllLists(elmnt) {
    var x = document.getElementsByClassName("autocomplete-items");
    for (var i = 0; i < x.length; i++) {
        if (elmnt != x[i] && elmnt != queryInput) {
            x[i].parentNode.removeChild(x[i]);
        }
    }
}

function insertValue(val) {
    const cursor = queryInput.selectionStart;
    const text = queryInput.value;
    const textBefore = text.substring(0, cursor);
    const match = textBefore.match(/([a-zA-Z0-9_[\]]+)$/);
    if (match) {
        const wordToReplace = match[0];
        const newTextBefore = textBefore.substring(0, textBefore.length - wordToReplace.length);
        const textAfter = text.substring(cursor);
        queryInput.value = newTextBefore + val + textAfter;
        queryInput.selectionStart = queryInput.selectionEnd = newTextBefore.length + val.length;
    }
}

function sharedStart(array){
    var A= array.concat().sort(), 
    a1= A[0], a2= A[A.length-1], L= a1.length, i= 0;
    while(i<L && a1.charAt(i).toLowerCase()=== a2.charAt(i).toLowerCase()) i++;
    return a1.substring(0, i);
}

// --- CSV & Query Logic ---

function runQuery() {
    const query = queryInput.value.trim();
    if (!query) return;

    // Security: Only allow SELECT queries to prevent data manipulation/code execution
    const normalizedQuery = query.replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (!/^SELECT\s/i.test(normalizedQuery)) {
        errorContainer.textContent = "Query Error: Only SELECT queries are allowed.";
        errorContainer.classList.remove('hidden');
        return;
    }
    // Block dangerous keywords even within SELECT (e.g. subqueries with side effects)
    const blockedPattern = /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|EXEC|EXECUTE|INTO\s+TEMP)\b/i;
    if (blockedPattern.test(normalizedQuery)) {
        errorContainer.textContent = "Query Error: Data modification statements are not allowed.";
        errorContainer.classList.remove('hidden');
        return;
    }

    // Add to history (skip if identical to the most recent entry)
    if (queryHistory.length === 0 || queryHistory[0] !== query) {
        queryHistory.unshift(query);
        if (queryHistory.length > 50) queryHistory.pop();
    }
    // Reset history navigation pointer
    historyIndex = -1;
    historyDraft = '';
    // Close history panel if open
    closeHistoryList();

    showLoader();

    setTimeout(async () => {
        try {
            if (originalDataObjects.length === 0 && originalRawData.length > 0) {
                originalDataObjects = await dataToObjects(originalRawData);
            }

            const result = alasql(query, [originalDataObjects]);
            
            if (!result || result.length === 0) {
                currentDisplayData = [];
                await renderTable([], []);
                return;
            }

            const newData = objectsToData(result);
            currentDisplayData = newData;
            await renderTable(newData, []);
            errorContainer.classList.add('hidden');
        } catch (e) {
            errorContainer.textContent = "Query Error: " + e.message;
            errorContainer.classList.remove('hidden');
        } finally {
            hideLoader();
        }
    }, 50);
}

function resetQuery() {
    queryInput.value = '';
    historyIndex = -1;
    historyDraft = '';
    closeHistoryList();
    showLoader();
    setTimeout(async () => {
        try {
            currentDisplayData = originalRawData;
            await renderTable(originalRawData, []);
            errorContainer.classList.add('hidden');
        } finally {
            hideLoader();
        }
    }, 50);
}

async function dataToObjects(data) {
    if (data.length < 2) return [];
    const headers = data[0];
    // Sanitize headers: rename any that could cause prototype pollution
    const safeHeaders = headers.map(h => DANGEROUS_KEYS.has(h) ? `_${h}` : h);
    const objects = [];
    for (let i = 1; i < data.length; i++) {
        const row = data[i];
        const obj = Object.create(null);
        safeHeaders.forEach((h, index) => {
            obj[h] = row[index];
        });
        objects.push(obj);

        if (i % 5000 === 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }
    return objects;
}

function objectsToData(objects) {
    if (objects.length === 0) return [];
    const headers = Object.keys(objects[0]);
    const data = [headers];
    objects.forEach(obj => {
        const row = headers.map(h => obj[h]);
        data.push(row);
    });
    return data;
}

async function parseCSV(text) {
    const data = [];
    const errors = [];
    let currentRow = [];
    let fieldStart = 0;
    let inQuotes = false;
    const len = text.length;

    for (let i = 0; i < len; i++) {
        const char = text[i];

        if (i % 500000 === 0 && i > 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        if (inQuotes) {
            if (char === '"') {
                if (i + 1 < len && text[i + 1] === '"') {
                    i++;
                } else {
                    inQuotes = false;
                }
            }
        } else {
            if (char === '"') {
                inQuotes = true;
                fieldStart = i;
            } else if (char === ',') {
                let field = text.slice(fieldStart, i);
                if (field.startsWith('"') && field.endsWith('"')) {
                    field = field.slice(1, -1).replace(/""/g, '"');
                }
                currentRow.push(field);
                fieldStart = i + 1;
            } else if (char === '\n') {
                let field = text.slice(fieldStart, i);
                if (field.startsWith('"') && field.endsWith('"')) {
                    field = field.slice(1, -1).replace(/""/g, '"');
                }
                currentRow.push(field);
                data.push(currentRow);
                currentRow = [];
                fieldStart = i + 1;
            } else if (char === '\r') {
                let field = text.slice(fieldStart, i);
                if (field.startsWith('"') && field.endsWith('"')) {
                    field = field.slice(1, -1).replace(/""/g, '"');
                }
                currentRow.push(field);
                data.push(currentRow);
                currentRow = [];
                if (i + 1 < len && text[i + 1] === '\n') {
                    i++;
                }
                fieldStart = i + 1;
            }
        }
    }
    
    if (fieldStart < len || text.endsWith(',')) {
        let field = text.slice(fieldStart);
        if (field.startsWith('"') && field.endsWith('"')) {
            field = field.slice(1, -1).replace(/""/g, '"');
        }
        currentRow.push(field);
        data.push(currentRow);
    }

    if (inQuotes) {
        errors.push({
            line: data.length + 1,
            message: `Row ${data.length + 1}: Unclosed quote detected.`
        });
    }

    if (data.length > 0) {
        const headerLength = data[0].length;
        data.forEach((row, index) => {
            if (row.length !== headerLength) {
                errors.push({
                    line: index + 1,
                    message: `Row ${index + 1}: Expected ${headerLength} columns, found ${row.length}.`
                });
            }
        });
    }

    return { data, errors };
}

let saveTimeout;
function debounceSave() {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
        const csvContent = dataToCSV(originalRawData);
        vscode.postMessage({
            type: 'edit',
            text: csvContent
        });
    }, 300);
}

async function onCellChange(e) {
    const cell = e.target;
    const scrollTop = tableContainer.scrollTop;
    const startRow = Math.max(1, Math.floor(scrollTop / rowHeight));
    const buffer = 10;
    const renderStart = Math.max(1, startRow - buffer);
    
    const rowInDisplay = renderStart + cell.parentElement.rowIndex;
    const col = cell.cellIndex;
    const newValue = cell.textContent;

    if (currentDisplayData[rowInDisplay] && currentDisplayData[rowInDisplay][col] === newValue) return;

    if (!currentDisplayData[rowInDisplay]) return;

    currentDisplayData[rowInDisplay][col] = newValue;

    if (currentDisplayData === originalRawData) {
        // Updated
    }

    debounceSave();
}

function dataToCSV(data) {
    return data.map(row => {
        return row.map(cell => {
            const text = cell || '';
            if (text.includes(',') || text.includes('"') || text.includes('\n')) {
                return `"${text.replace(/"/g, '""')}"`;
            }
            return text;
        }).join(',');
    }).join('\n');
}

function createColGroup(widths) {
    const colgroup = document.createElement('colgroup');
    widths.forEach(w => {
        const col = document.createElement('col');
        col.style.width = w + 'px';
        colgroup.appendChild(col);
    });
    return colgroup;
}

async function renderTable(data, errors) {
    if (!table || !virtualSpacer) return;

    if (errors.length > 0) {
        const errorMessages = errors.map(e => typeof e === 'string' ? e : e.message);
        errorContainer.textContent = "CSV Parsing Errors:\n" + errorMessages.slice(0, 10).join('\n') + (errorMessages.length > 10 ? `\n...and ${errorMessages.length - 10} more.` : '');
        errorContainer.classList.remove('hidden');
    } else {
        if (errors.length === 0 && !errorContainer.textContent.startsWith("Query Error")) {
             errorContainer.classList.add('hidden');
        }
    }

    updateErrorRuler(errors, data.length);

    if (headerTable) headerTable.innerHTML = '';
    table.innerHTML = '';
    
    if (data.length === 0) {
        virtualSpacer.style.height = '0px';
        return;
    }

    if (currentConfig.alternatingRows) {
        table.classList.add('alternating-rows');
    } else {
        table.classList.remove('alternating-rows');
    }

    const headerRow = data[0] || [];
    
    // Calculate Column Widths based on header AND data content
    // We sample the first 100 rows to get a better estimate
    const sampleRows = data.slice(1, 101);
    columnWidths = headerRow.map((h, colIndex) => {
        let maxWidth = h.length;
        sampleRows.forEach(row => {
            const cellLength = row[colIndex] ? row[colIndex].length : 0;
            if (cellLength > maxWidth) maxWidth = cellLength;
        });
        
        const charWidth = 9; // Approximate average char width in pixels
        const padding = 24;  // Padding + border
        return Math.max(100, Math.min(600, (maxWidth * charWidth) + padding));
    });

    // Add colgroups to both tables for perfect alignment
    if (headerTable) headerTable.appendChild(createColGroup(columnWidths));
    table.appendChild(createColGroup(columnWidths));

    // Ensure both tables have the exact same total width
    const totalTableWidth = columnWidths.reduce((a, b) => a + b, 0);
    if (headerTable) headerTable.style.width = totalTableWidth + 'px';
    table.style.width = totalTableWidth + 'px';

    // Compensate header for the body's vertical scrollbar width to ensure right-edge alignment
    const scrollbarWidth = tableContainer.offsetWidth - tableContainer.clientWidth;
    if (headerContainer) {
        headerContainer.style.paddingRight = scrollbarWidth + 'px';
    }

    // Build Header Table
    const thead = document.createElement('thead');
    const trHead = document.createElement('tr');
    headerRow.forEach((colName, index) => {
        const th = document.createElement('th');
        th.textContent = colName;
        trHead.appendChild(th);
    });
    thead.appendChild(trHead);
    if (headerTable) headerTable.appendChild(thead);

    // Build Body Table Structure
    const tbody = document.createElement('tbody');
    table.appendChild(tbody);

    const dataRowCount = data.length - 1; // exclude header
    virtualSpacer.style.height = spacerHeight(dataRowCount) + 'px';

    updateVirtualTable();

    clearTimeout(slowLoadTimer);
    if (slowLoadModal) slowLoadModal.classList.add('hidden');
}

function escapeHtml(text) {
    if (!text) return text;
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function colorizeCSV(text) {
    const lines = text.split(/\r?\n/);
    let html = '';
    const limit = Math.min(lines.length, 5000); 
    for (let i = 0; i < limit; i++) {
        const line = lines[i];
        let rowHtml = '';
        let colIndex = 0;
        let currentField = '';
        let inQuotes = false;
        for (let j = 0; j < line.length; j++) {
            const char = line[j];
            if (inQuotes) {
                if (char === '"' && line[j+1] === '"') {
                     currentField += '"';
                     j++;
                } else if (char === '"') {
                    inQuotes = false;
                    currentField += char;
                } else {
                    currentField += char;
                }
            } else {
                if (char === '"') {
                    inQuotes = true;
                    currentField += char;
                } else if (char === ',') {
                    const colorClass = 'col-color-' + ((colIndex % 10) + 1);
                    rowHtml += `<span class="${colorClass}">${escapeHtml(currentField)}</span>,`;
                    currentField = '';
                    colIndex++;
                } else {
                    currentField += char;
                }
            }
        }
        const colorClass = 'col-color-' + ((colIndex % 10) + 1);
        rowHtml += `<span class="${colorClass}">${escapeHtml(currentField)}</span>`;
        html += rowHtml + '\n';
    }
    if (lines.length > limit) {
        html += `\n... (Coloring limited to first ${limit} rows for performance)`;
    }
    return html;
}

function updateErrorRuler(errors, totalLines) {
    if (!errorRuler) return;
    positionErrorRuler();
    errorRuler.innerHTML = '';
    if (errors.length === 0 || totalLines === 0) return;
    const errorLines = [...new Set(errors.map(e => typeof e === 'string' ? -1 : e.line).filter(l => l !== -1))];
    errorLines.forEach(line => {
        const marker = document.createElement('div');
        marker.className = 'error-marker';
        const percentage = (line / totalLines) * 100;
        marker.style.top = percentage + '%';
        marker.title = 'Error on line ' + line;
                marker.onclick = (e) => {
                    e.stopPropagation();
                    // Data starts at line 2 (line 1 is header). 
                    // So line 2 should scroll to offset 0.
                    const targetScrollTop = Math.max(0, (line - 2) * rowHeight);
                    tableContainer.scrollTop = targetScrollTop;
                    
                    setTimeout(() => {
                        const scrollTop = tableContainer.scrollTop;
                        const startRow = Math.max(1, Math.floor(scrollTop / rowHeight));
                        const buffer = 10;
                        const renderStart = Math.max(1, startRow - buffer);
                        
                        // Header is separate, so relative index is simple
                        const relativeIndex = line - renderStart - 1; 
                        const tbody = table.querySelector('tbody');
                        if (tbody && tbody.rows[relativeIndex]) {
                            const row = tbody.rows[relativeIndex];
                            const originalBg = row.style.backgroundColor;
                            row.style.backgroundColor = 'var(--vscode-inputValidation-errorBackground)';
                            setTimeout(() => {
                                row.style.backgroundColor = originalBg;
                            }, 2000);
                        }
                    }, 100);
                };
        
        errorRuler.appendChild(marker);
    });
}
