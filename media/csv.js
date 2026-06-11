const vscode = acquireVsCodeApi();

// --- State ---
let currentConfig = {};
let originalDataObjects = []; // Array of Objects for SQL
let originalRawData = []; // Array of Arrays for Render
let currentDisplayData = []; // Data currently being shown (full or filtered)
let autocompleteOptions = []; // Shared source for autocomplete
let currentFocus = -1; // Shared focus state for autocomplete
let isUpdating = false; // Guard for overlapping updates
let pendingUpdateTimeout = null; // Tracks the scheduled render so a newer message can cancel it

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

// --- New Feature State ---
let detectedDelimiter = ',';    // auto-detected or user-overridden delimiter
let columnTypes = [];           // 'integer' | 'float' | 'date' | 'boolean' | 'string' per column
let sortState = { col: -1, dir: 'none' }; // col: index, dir: 'asc'|'desc'|'none'
let frozenCols = new Set();     // set of frozen column indices
let activePopoverCol = -1;      // which column's stats popover is open (-1 = none)
let isQueryResult = false;      // true when the table is showing SQL query results

// --- Column Filter State ---
let columnFilters = {};         // colIndex -> filter string (case-insensitive contains)
let filtersActive = false;      // true when filter row is visible

// --- Duplicate Detection State ---
let dupesMode = false;          // true when duplicate rows are highlighted
let dupesOnlyMode = false;      // true when table is filtered to show only dupes with line numbers

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
const tableArea = document.querySelector('.table-area');
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
const profileBtn = document.getElementById('profile-btn');
const schemaPanel = document.getElementById('schema-panel');
const schemaPanelBody = document.getElementById('schema-panel-body');
const schemaCloseBtn = document.getElementById('schema-close-btn');
const statsPopover = document.getElementById('stats-popover');
const delimiterDisplay = document.getElementById('delimiter-display');
const gotoRowBtn = document.getElementById('goto-row-btn');
const gotoRowModal = document.getElementById('goto-row-modal');
const gotoRowInput = document.getElementById('goto-row-input');
const gotoRowOk = document.getElementById('goto-row-ok');
const gotoRowCancel = document.getElementById('goto-row-cancel');
const filterBtn = document.getElementById('filter-btn');
const filterRowContainer = document.getElementById('filter-row-container');
const dupesBtn = document.getElementById('dupes-btn');
const saveResultBtn = document.getElementById('save-result-btn');
const dupesBanner = document.getElementById('dupes-banner');

// --- Constants ---
const sqlKeywords = ['SELECT', 'FROM', 'WHERE', 'ORDER BY', 'GROUP BY', 'LIMIT', 'JOIN', 'ON', 'AS', 'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MAX', 'MIN', 'LIKE', 'IN', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END'];
const SLOW_LOAD_TIMEOUT = 25000; // 25 seconds
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const DELIMITER_LABELS = { ',': ',  CSV', '\t': '⇥  TSV', '|': '|  PSV', ';': ';  semicolon' };
const TYPE_BADGES = { integer: '#', float: '1.0', date: 'date', boolean: 'T/F', string: 'abc' };
const TYPE_TITLES = { integer: 'Integer', float: 'Float/Decimal', date: 'Date/Time', boolean: 'Boolean', string: 'String/Text' };

let slowLoadTimer;
let isRenderingInterrupted = false;
let currentText = "";

// =============================================================================
// DELIMITER AUTO-DETECTION
// =============================================================================

/**
 * Detect the delimiter by sampling up to the first 8 KB of text.
 * Counts occurrences of each candidate per line and picks the one
 * with the most consistent (lowest CV) non-zero per-line count.
 * Returns one of: ',' | '\t' | '|' | ';'
 */
function detectDelimiter(text, hintExtension) {
    // Hard-wired extension hints
    if (hintExtension === 'tsv' || hintExtension === 'tab') { return '\t'; }
    if (hintExtension === 'psv') { return '|'; }

    const sample = text.slice(0, 8192);
    const lines = sample.split(/\r?\n/).filter(l => l.length > 0).slice(0, 20);
    if (lines.length === 0) { return ','; }

    const candidates = [',', '\t', '|', ';'];
    let bestDelim = ',';
    let bestScore = -1;

    for (const d of candidates) {
        const counts = lines.map(l => {
            let n = 0;
            let inQ = false;
            for (let i = 0; i < l.length; i++) {
                if (l[i] === '"') { inQ = !inQ; }
                else if (!inQ && l[i] === d) { n++; }
            }
            return n;
        });

        const nonZero = counts.filter(c => c > 0);
        if (nonZero.length === 0) { continue; }

        const mean = nonZero.reduce((a, b) => a + b, 0) / nonZero.length;
        if (mean < 1) { continue; }

        const variance = nonZero.reduce((acc, c) => acc + (c - mean) ** 2, 0) / nonZero.length;
        const cv = Math.sqrt(variance) / mean; // coefficient of variation — lower is more consistent

        // Score: high mean (many columns), low cv (consistent), and most lines have it
        const score = mean * (nonZero.length / lines.length) * (1 / (1 + cv));
        if (score > bestScore) {
            bestScore = score;
            bestDelim = d;
        }
    }

    return bestDelim;
}

function updateDelimiterBadge(delim) {
    if (!delimiterDisplay) { return; }
    const label = DELIMITER_LABELS[delim] || delim;
    delimiterDisplay.textContent = 'Delim: ' + label;
    delimiterDisplay.classList.remove('hidden');
    delimiterDisplay.title = 'Detected delimiter: ' + (label) + '\nClick to override';
}

// Delimiter override dropdown
if (delimiterDisplay) {
    delimiterDisplay.addEventListener('click', (e) => {
        e.stopPropagation();
        showDelimiterPicker();
    });
}

function showDelimiterPicker() {
    // Remove any existing picker
    document.querySelectorAll('.delimiter-picker').forEach(el => el.remove());

    const picker = document.createElement('div');
    picker.className = 'delimiter-picker';

    const options = [
        { label: 'Auto-detect', value: 'auto' },
        { label: ', CSV', value: ',' },
        { label: '⇥ Tab (TSV)', value: '\t' },
        { label: '| Pipe (PSV)', value: '|' },
        { label: '; Semicolon', value: ';' },
    ];

    options.forEach(opt => {
        const item = document.createElement('div');
        item.className = 'delimiter-picker-item';
        if ((opt.value === detectedDelimiter) || (opt.value === 'auto' && detectedDelimiter === 'auto')) {
            item.classList.add('delimiter-picker-active');
        }
        item.textContent = opt.label;
        item.addEventListener('click', () => {
            picker.remove();
            let newDelim;
            if (opt.value === 'auto') {
                newDelim = detectDelimiter(currentText, '');
            } else {
                newDelim = opt.value;
            }
            detectedDelimiter = newDelim;
            updateDelimiterBadge(newDelim);
            // Re-parse with new delimiter
            showLoader();
            setTimeout(async () => {
                try {
                    await updateContent(currentText, currentConfig);
                } finally {
                    hideLoader();
                }
            }, 50);
        });
        picker.appendChild(item);
    });

    const rect = delimiterDisplay.getBoundingClientRect();
    picker.style.top = (rect.bottom + 4) + 'px';
    picker.style.left = rect.left + 'px';
    document.body.appendChild(picker);

    // Close on outside click
    setTimeout(() => {
        document.addEventListener('click', function closePicker() {
            picker.remove();
            document.removeEventListener('click', closePicker);
        });
    }, 0);
}

// =============================================================================
// DATA TYPE INFERENCE
// =============================================================================

/**
 * Infer the data type of each column by scanning up to 1000 data rows.
 * Returns an array of type strings parallel to the header array.
 */
function inferColumnTypes(data) {
    if (data.length < 2) { return []; }
    const headers = data[0];
    const sampleRows = data.slice(1, Math.min(1001, data.length));
    const numCols = headers.length;
    const types = [];

    for (let c = 0; c < numCols; c++) {
        let isInt = true;
        let isFloat = true;
        let isDate = true;
        let isBool = true;
        let nonEmptyCount = 0;

        for (const row of sampleRows) {
            const raw = String(row[c] == null ? '' : row[c]).trim();
            if (raw === '' || raw === null || raw === undefined) { continue; }
            nonEmptyCount++;

            // Integer: optional sign, only digits
            if (isInt && !/^-?\d+$/.test(raw)) { isInt = false; }
            // Float: optional sign, digits, at most one dot
            if (isFloat && !/^-?\d*\.?\d+([eE][+-]?\d+)?$/.test(raw)) { isFloat = false; }
            // Boolean
            if (isBool && !/^(true|false|yes|no|1|0|y|n)$/i.test(raw)) { isBool = false; }
            // Date: require a recognisable date pattern first, then native parse + year sanity check.
            // This prevents plain numbers and booleans from being mis-classified as dates.
            if (isDate) {
                const DATE_PATTERN = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$|^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/;
                if (!DATE_PATTERN.test(raw)) {
                    isDate = false;
                } else {
                    const d = new Date(raw);
                    if (isNaN(d.getTime()) || d.getFullYear() < 1900 || d.getFullYear() > 2100) {
                        isDate = false;
                    }
                }
            }
        }

        if (nonEmptyCount === 0) {
            types.push('string');
        } else if (isBool && nonEmptyCount > 0) {
            types.push('boolean');
        } else if (isInt) {
            types.push('integer');
        } else if (isFloat) {
            types.push('float');
        } else if (isDate) {
            types.push('date');
        } else {
            types.push('string');
        }
    }

    return types;
}

// =============================================================================
// COLUMN STATISTICS
// =============================================================================

/**
 * Compute detailed statistics for a single column (0-based colIndex in data).
 * data[0] is header row; data[1..] are data rows.
 */
function computeColStats(data, colIndex) {
    if (data.length < 2) { return null; }
    const type = columnTypes[colIndex] || 'string';
    const values = [];
    const freqMap = Object.create(null);
    let nullCount = 0;

    for (let i = 1; i < data.length; i++) {
        const raw = (data[i][colIndex] || '').trim();
        if (raw === '') {
            nullCount++;
        } else {
            values.push(raw);
            freqMap[raw] = (freqMap[raw] || 0) + 1;
        }
    }

    const total = data.length - 1;
    const nonNull = values.length;
    const distinct = Object.keys(freqMap).length;

    // Top-5 most frequent values
    const topValues = Object.entries(freqMap)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([val, cnt]) => ({ val, cnt }));

    const stats = { type, total, nonNull, nullCount, distinct, topValues };

    if (type === 'integer' || type === 'float') {
        const nums = values.map(v => parseFloat(v)).filter(n => !isNaN(n));
        if (nums.length > 0) {
            nums.sort((a, b) => a - b);
            stats.min = nums[0];
            stats.max = nums[nums.length - 1];
            stats.mean = nums.reduce((a, b) => a + b, 0) / nums.length;
            stats.median = median(nums);
            stats.p25 = percentile(nums, 0.25);
            stats.p75 = percentile(nums, 0.75);
            const variance = nums.reduce((acc, n) => acc + (n - stats.mean) ** 2, 0) / nums.length;
            stats.stddev = Math.sqrt(variance);

            const NUM_BUCKETS = 10;
            if (stats.max > stats.min) {
                const bucketSize = (stats.max - stats.min) / NUM_BUCKETS;
                const buckets = Array.from({ length: NUM_BUCKETS }, (_, i) => ({
                    min: stats.min + i * bucketSize,
                    max: stats.min + (i + 1) * bucketSize,
                    count: 0
                }));
                for (const n of nums) {
                    let bi = Math.floor((n - stats.min) / bucketSize);
                    if (bi >= NUM_BUCKETS) { bi = NUM_BUCKETS - 1; }
                    buckets[bi].count++;
                }
                stats.histogram = buckets;
            } else {
                stats.histogram = [{ min: stats.min, max: stats.max, count: nums.length }];
            }
        }
    } else if (type === 'date') {
        const dates = values.map(v => new Date(v)).filter(d => !isNaN(d.getTime()));
        if (dates.length > 0) {
            dates.sort((a, b) => a - b);
            stats.minDate = dates[0].toLocaleDateString();
            stats.maxDate = dates[dates.length - 1].toLocaleDateString();
        }
    } else if (type === 'string') {
        const lens = values.map(v => v.length);
        if (lens.length > 0) {
            stats.minLen = Math.min(...lens);
            stats.maxLen = Math.max(...lens);
            stats.avgLen = (lens.reduce((a, b) => a + b, 0) / lens.length).toFixed(1);
        }
    }

    return stats;
}

function median(sorted) {
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(sorted, p) {
    const idx = p * (sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function fmtNum(n, decimals = 2) {
    if (n === undefined || n === null) { return '—'; }
    if (Number.isInteger(n)) { return n.toLocaleString(); }
    return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: decimals });
}

// =============================================================================
// STATS POPOVER
// =============================================================================

function showStatsPopover(colIndex, thElement) {
    if (!statsPopover) { return; }

    if (activePopoverCol === colIndex) {
        hideStatsPopover();
        return;
    }

    activePopoverCol = colIndex;
    const stats = computeColStats(currentDisplayData, colIndex);
    if (!stats) { return; }

    const colName = currentDisplayData[0] ? currentDisplayData[0][colIndex] : `Col ${colIndex}`;
    const type = columnTypes[colIndex] || 'string';
    const badge = TYPE_BADGES[type] || 'abc';
    const typeLabel = TYPE_TITLES[type] || 'String';

    let html = `
        <div class="sp-header">
            <span class="sp-colname">${escapeHtml(colName)}</span>
            <span class="sp-type-badge sp-type-${escapeHtml(type)}">${escapeHtml(badge)}</span>
            <span class="sp-close" id="sp-close-btn">✕</span>
        </div>
        <div class="sp-type-label">${escapeHtml(typeLabel)}</div>
        <table class="sp-table">
            <tr><td class="sp-label">Total rows</td><td class="sp-val">${stats.total.toLocaleString()}</td></tr>
            <tr><td class="sp-label">Non-empty</td><td class="sp-val">${stats.nonNull.toLocaleString()}</td></tr>
            <tr><td class="sp-label">Empty / null</td><td class="sp-val">${stats.nullCount.toLocaleString()} <span class="sp-pct">(${stats.total > 0 ? ((stats.nullCount / stats.total) * 100).toFixed(1) : 0}%)</span></td></tr>
            <tr><td class="sp-label">Distinct</td><td class="sp-val">${stats.distinct.toLocaleString()}</td></tr>
    `;

    if (type === 'integer' || type === 'float') {
        html += `
            <tr><td class="sp-label">Min</td><td class="sp-val">${fmtNum(stats.min)}</td></tr>
            <tr><td class="sp-label">Max</td><td class="sp-val">${fmtNum(stats.max)}</td></tr>
            <tr><td class="sp-label">Mean</td><td class="sp-val">${fmtNum(stats.mean)}</td></tr>
            <tr><td class="sp-label">Median</td><td class="sp-val">${fmtNum(stats.median)}</td></tr>
            <tr><td class="sp-label">Std Dev</td><td class="sp-val">${fmtNum(stats.stddev)}</td></tr>
            <tr><td class="sp-label">P25 / P75</td><td class="sp-val">${fmtNum(stats.p25)} / ${fmtNum(stats.p75)}</td></tr>
        `;
    } else if (type === 'date') {
        html += `
            <tr><td class="sp-label">Earliest</td><td class="sp-val">${escapeHtml(stats.minDate || '—')}</td></tr>
            <tr><td class="sp-label">Latest</td><td class="sp-val">${escapeHtml(stats.maxDate || '—')}</td></tr>
        `;
    } else if (type === 'string') {
        html += `
            <tr><td class="sp-label">Min length</td><td class="sp-val">${stats.minLen !== undefined ? stats.minLen : '—'}</td></tr>
            <tr><td class="sp-label">Max length</td><td class="sp-val">${stats.maxLen !== undefined ? stats.maxLen : '—'}</td></tr>
            <tr><td class="sp-label">Avg length</td><td class="sp-val">${stats.avgLen !== undefined ? stats.avgLen : '—'}</td></tr>
        `;
    }

    html += `</table>`;

    if ((type === 'integer' || type === 'float') && stats.histogram && stats.histogram.length > 0) {
        const maxCount = Math.max(...stats.histogram.map(b => b.count));
        const chartW = 258;
        const chartH = 52;
        const gap = 1;
        const barW = Math.floor((chartW - gap * (stats.histogram.length - 1)) / stats.histogram.length);
        let bars = '';
        stats.histogram.forEach((bucket, i) => {
            const barH = maxCount > 0 ? Math.max(2, Math.round((bucket.count / maxCount) * chartH)) : 0;
            const x = i * (barW + gap);
            const y = chartH - barH;
            const title = `${fmtNum(bucket.min)}–${fmtNum(bucket.max)}: ${bucket.count}`;
            bars += `<rect x="${x}" y="${y}" width="${barW}" height="${barH}" fill="var(--vscode-progressBar-background,#0078d4)" rx="1" opacity="0.85"><title>${escapeHtml(title)}</title></rect>`;
        });
        html += `
            <div class="sp-section-title">Distribution</div>
            <div class="sp-chart-wrap">
                <svg width="${chartW}" height="${chartH}" class="sp-chart" xmlns="http://www.w3.org/2000/svg">${bars}</svg>
                <div class="sp-chart-labels">
                    <span>${fmtNum(stats.min, 2)}</span>
                    <span>${fmtNum(stats.max, 2)}</span>
                </div>
            </div>`;
    }

    if (stats.topValues && stats.topValues.length > 0) {
        html += `<div class="sp-section-title">Top Values</div>`;
        const maxCnt = stats.topValues[0].cnt;
        stats.topValues.forEach(({ val, cnt }) => {
            const barPct = maxCnt > 0 ? (cnt / maxCnt) * 100 : 0;
            html += `
                <div class="sp-top-row">
                    <span class="sp-top-val" title="${escapeHtml(val)}">${escapeHtml(val.length > 20 ? val.slice(0, 20) + '…' : val)}</span>
                    <div class="sp-bar-wrap"><div class="sp-bar" style="width:${barPct.toFixed(1)}%"></div></div>
                    <span class="sp-top-cnt">${cnt}</span>
                </div>
            `;
        });
    }

    statsPopover.innerHTML = html;
    statsPopover.classList.remove('hidden');

    // Position: below the th element, clamped to viewport
    const thRect = thElement.getBoundingClientRect();
    const popWidth = 280;
    let left = thRect.left;
    if (left + popWidth > window.innerWidth - 10) {
        left = window.innerWidth - popWidth - 10;
    }
    statsPopover.style.left = left + 'px';
    statsPopover.style.top = (thRect.bottom + 4) + 'px';

    document.getElementById('sp-close-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        hideStatsPopover();
    });
}

function hideStatsPopover() {
    if (statsPopover) { statsPopover.classList.add('hidden'); }
    activePopoverCol = -1;
}

// Close popover on outside click
document.addEventListener('click', (e) => {
    if (statsPopover && !statsPopover.classList.contains('hidden')) {
        if (!statsPopover.contains(e.target) && !e.target.closest('.col-stats-trigger')) {
            hideStatsPopover();
        }
    }
});

// =============================================================================
// SCHEMA SUMMARY PANEL
// =============================================================================

if (profileBtn) {
    profileBtn.addEventListener('click', () => {
        if (!schemaPanel) { return; }
        if (schemaPanel.classList.contains('hidden')) {
            buildSchemaPanel();
            schemaPanel.classList.remove('hidden');
            profileBtn.classList.add('profile-btn-active');
        } else {
            schemaPanel.classList.add('hidden');
            profileBtn.classList.remove('profile-btn-active');
        }
    });
}

if (schemaCloseBtn) {
    schemaCloseBtn.addEventListener('click', () => {
        if (schemaPanel) { schemaPanel.classList.add('hidden'); }
        if (profileBtn) { profileBtn.classList.remove('profile-btn-active'); }
    });
}

function buildSchemaPanel() {
    if (!schemaPanelBody || !currentDisplayData || currentDisplayData.length < 2) { return; }
    const headers = currentDisplayData[0];
    const numRows = currentDisplayData.length - 1;

    let html = `
        <table class="schema-table">
            <thead>
                <tr>
                    <th>#</th>
                    <th>Column</th>
                    <th>Type</th>
                    <th>Non-empty</th>
                    <th>Null %</th>
                    <th>Distinct</th>
                    <th>Min / Max</th>
                </tr>
            </thead>
            <tbody>
    `;

    headers.forEach((colName, colIndex) => {
        const type = columnTypes[colIndex] || 'string';
        const badge = TYPE_BADGES[type] || 'abc';
        const stats = computeColStats(currentDisplayData, colIndex);
        const nullPct = stats && numRows > 0 ? ((stats.nullCount / numRows) * 100).toFixed(1) : '0.0';
        const nullBarWidth = stats ? Math.min(100, parseFloat(nullPct)) : 0;
        let minMax = '—';
        if (stats) {
            if (type === 'integer' || type === 'float') {
                minMax = `${fmtNum(stats.min)} / ${fmtNum(stats.max)}`;
            } else if (type === 'date') {
                minMax = `${stats.minDate || '—'} / ${stats.maxDate || '—'}`;
            } else if (type === 'string' && stats.minLen !== undefined) {
                minMax = `len ${stats.minLen}–${stats.maxLen}`;
            }
        }

        html += `
            <tr class="schema-row" data-col="${colIndex}" title="Click to view column stats">
                <td class="schema-idx">${colIndex + 1}</td>
                <td class="schema-name">${escapeHtml(colName)}</td>
                <td class="schema-type"><span class="type-badge type-${escapeHtml(type)}">${escapeHtml(badge)}</span></td>
                <td class="schema-nonnull">${stats ? stats.nonNull.toLocaleString() : '—'}</td>
                <td class="schema-null-pct">
                    <div class="null-bar-wrap">
                        <div class="null-bar" style="width:${nullBarWidth}%"></div>
                    </div>
                    <span class="null-pct-label">${nullPct}%</span>
                </td>
                <td class="schema-distinct">${stats ? stats.distinct.toLocaleString() : '—'}</td>
                <td class="schema-minmax">${escapeHtml(minMax)}</td>
            </tr>
        `;
    });

    html += `</tbody></table>`;
    schemaPanelBody.innerHTML = html;

    // Click on a schema row to show full stats popover anchored to the header column
    schemaPanelBody.querySelectorAll('.schema-row').forEach(row => {
        row.addEventListener('click', () => {
            const colIndex = parseInt(row.dataset.col, 10);
            // Find the th element in headerTable for this column
            const ths = headerTable ? headerTable.querySelectorAll('th') : [];
            const th = ths[colIndex];
            if (th) {
                showStatsPopover(colIndex, th);
            }
        });
    });
}

// =============================================================================
// COLUMN SORTING
// =============================================================================

function applySortToData(data, colIndex, dir) {
    if (data.length < 2 || dir === 'none') { return data; }
    const header = data[0];
    const rows = data.slice(1);
    const type = columnTypes[colIndex] || 'string';

    rows.sort((a, b) => {
        const av = (a[colIndex] || '').trim();
        const bv = (b[colIndex] || '').trim();

        // Empty values always sort last
        if (av === '' && bv === '') { return 0; }
        if (av === '') { return 1; }
        if (bv === '') { return -1; }

        let cmp = 0;
        if (type === 'integer' || type === 'float') {
            cmp = parseFloat(av) - parseFloat(bv);
        } else if (type === 'date') {
            cmp = new Date(av) - new Date(bv);
        } else {
            cmp = av.localeCompare(bv, undefined, { sensitivity: 'base' });
        }

        return dir === 'asc' ? cmp : -cmp;
    });

    return [header, ...rows];
}

function cycleSortDir(colIndex) {
    if (sortState.col !== colIndex) {
        sortState.col = colIndex;
        sortState.dir = 'asc';
    } else {
        if (sortState.dir === 'asc') { sortState.dir = 'desc'; }
        else if (sortState.dir === 'desc') { sortState.dir = 'none'; sortState.col = -1; }
        else { sortState.dir = 'asc'; sortState.col = colIndex; }
    }
}

function updateSortIndicators() {
    if (!headerTable) { return; }
    const ths = headerTable.querySelectorAll('th');
    ths.forEach((th, i) => {
        const indicator = th.querySelector('.sort-indicator');
        if (indicator) {
            if (i === sortState.col) {
                indicator.textContent = sortState.dir === 'asc' ? ' ▲' : ' ▼';
            } else {
                indicator.textContent = '';
            }
        }
    });
}

// =============================================================================
// COLUMN FREEZE/PIN
// =============================================================================

// Context menu for freeze
let contextMenu = null;

function showFreezeContextMenu(colIndex, e) {
    if (contextMenu) { contextMenu.remove(); contextMenu = null; }

    const menu = document.createElement('div');
    menu.className = 'context-menu';

    // "Freeze pane here" means freeze all columns 0..colIndex as a contiguous pane.
    // The pane is already frozen at this column if frozenCols covers exactly 0..colIndex.
    const currentFreezeAt = frozenCols.size > 0 ? Math.max(...frozenCols) : -1;
    const isPaneFrozenHere = currentFreezeAt === colIndex;

    const item1 = document.createElement('div');
    item1.className = 'context-menu-item';
    item1.textContent = isPaneFrozenHere ? 'Unfreeze pane' : 'Freeze pane here';
    item1.addEventListener('click', () => {
        frozenCols.clear();
        if (!isPaneFrozenHere) {
            // Freeze all columns from 0 up to and including colIndex
            for (let i = 0; i <= colIndex; i++) {
                frozenCols.add(i);
            }
        }
        menu.remove();
        contextMenu = null;
        renderTable(currentDisplayData, []);
    });

    const item2 = document.createElement('div');
    item2.className = 'context-menu-item context-menu-item-danger';
    item2.textContent = 'Unfreeze all';
    item2.addEventListener('click', () => {
        frozenCols.clear();
        menu.remove();
        contextMenu = null;
        renderTable(currentDisplayData, []);
    });

    menu.appendChild(item1);
    if (frozenCols.size > 0) { menu.appendChild(item2); }

    // Position near cursor
    menu.style.left = Math.min(e.clientX, window.innerWidth - 200) + 'px';
    menu.style.top = Math.min(e.clientY, window.innerHeight - 100) + 'px';
    document.body.appendChild(menu);
    contextMenu = menu;

    // Close on outside click
    setTimeout(() => {
        document.addEventListener('click', function closeMenu() {
            if (contextMenu) { contextMenu.remove(); contextMenu = null; }
            document.removeEventListener('click', closeMenu);
        });
    }, 0);
}

// =============================================================================
// EVENT LISTENERS (Attached Once)
// =============================================================================

if (tableContainer) {
    tableContainer.addEventListener('scroll', () => {
        // Sync horizontal scroll
        if (headerContainer) {
            headerContainer.scrollLeft = tableContainer.scrollLeft;
        }
        // Sync frozen table vertical scroll
        const frozenBody = document.getElementById('frozen-body-table');
        if (frozenBody) {
            frozenBody.style.transform = `translateY(-${tableContainer.scrollTop}px)`;
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
    if (chunkedLoadedPage === page && chunkedLoadedPageHasData) { return; }
    // Also skip if same page and still no data (nothing would change).
    if (chunkedLoadedPage === page && !hasData) { return; }

    chunkedLoadedPage = page;
    chunkedLoadedPageHasData = hasData;

    const pageStartDataRow = page * chunkSize; // 0-based in data space

    const tbody = table.querySelector('tbody');
    if (!tbody) { return; }

    // Move the tbody to the correct position BEFORE writing rows,
    tbody.style.transform = `translateY(${rowToScrollTop(pageStartDataRow, chunkedTotalRows)}px)`;

    const rowCount = hasData
        ? rows.length
        : Math.max(0, Math.min(chunkSize, chunkedTotalRows - pageStartDataRow));

    let html = '';
    const chunkFrozenSpacerWidth = frozenCols.size > 0
        ? [...frozenCols].reduce((sum, i) => sum + (columnWidths[i] || 0), 0)
        : 0;
    for (let i = 0; i < rowCount; i++) {
        html += `<tr style="height: ${rowHeight}px">`;
        if (chunkFrozenSpacerWidth > 0) {
            html += `<td style="width:${chunkFrozenSpacerWidth}px;min-width:${chunkFrozenSpacerWidth}px;padding:0;border:none;" aria-hidden="true"></td>`;
        }
        if (hasData) {
            const row = rows[i];
            for (let c = 0; c < columnWidths.length; c++) {
                if (frozenCols.has(c)) { continue; }
                html += `<td>${escapeHtml(row[c] || '')}</td>`;
            }
        } else {
            // Placeholder: empty cells while the page loads
            for (let c = 0; c < columnWidths.length; c++) {
                if (frozenCols.has(c)) { continue; }
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
    // Compute frozen spacer width once for the body rows
    const frozenSpacerWidth = frozenCols.size > 0
        ? [...frozenCols].reduce((sum, i) => sum + (columnWidths[i] || 0), 0)
        : 0;
    for (let i = 0; i < slice.length; i++) {
        const row = slice[i];
        const absoluteRowIdx = renderStart + i; // index into currentDisplayData (1-based data)
        const isDupe = dupesMode && dupeIndicesGlobal.has(absoluteRowIdx);
        // In dupes-only mode, blank rows are group separators
        const isSeparator = dupesOnlyMode && row.every(c => c === '');
        const rowClass = isSeparator ? 'dupe-separator-row' : (isDupe ? 'dupe-row' : '');
        html += `<tr style="height: ${rowHeight}px"${rowClass ? ` class="${rowClass}"` : ''}>`;
        // Spacer td that sits under the frozen overlay
        if (frozenCols.size > 0) {
            html += `<td style="width:${frozenSpacerWidth}px;min-width:${frozenSpacerWidth}px;padding:0;border:none;" aria-hidden="true"></td>`;
        }
        for (let colIndex = 0; colIndex < columnWidths.length; colIndex++) {
            if (frozenCols.has(colIndex)) { continue; } // rendered in frozen overlay
            const cell = row[colIndex] || '';
            if (dupesOnlyMode && colIndex === 0) {
                // Line number column — styled as a pin, not editable
                html += `<td class="dupe-linenum-cell">${escapeHtml(cell)}</td>`;
            } else {
                html += `<td>${escapeHtml(cell)}</td>`;
            }
        }
        html += '</tr>';
    }
    
    tbody.innerHTML = html;
    
    // Position the tbody using the scaled pixel offset for renderStart
    const tbodyOffset = rowToScrollTop(renderStart - 1, dataRowCount);
    tbody.style.transform = `translateY(${tbodyOffset}px)`;

    // Update frozen columns
    updateFrozenBody(renderStart, renderEnd, tbodyOffset);
}

function updateFrozenBody(renderStart, renderEnd, tbodyOffset) {
    const frozenBodyTable = document.getElementById('frozen-body-table');
    if (!frozenBodyTable || frozenCols.size === 0) { return; }

    const slice = currentDisplayData.slice(renderStart, renderEnd);
    const frozenArr = [...frozenCols].sort((a, b) => a - b);

    let html = '';
    for (let i = 0; i < slice.length; i++) {
        const row = slice[i];
        html += `<tr style="height: ${rowHeight}px">`;
        for (const c of frozenArr) {
            const cell = row[c] || '';
            html += `<td>${escapeHtml(cell)}</td>`;
        }
        html += '</tr>';
    }
    frozenBodyTable.querySelector('tbody').innerHTML = html;
    frozenBodyTable.querySelector('tbody').style.transform = `translateY(${tbodyOffset}px)`;
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

// =============================================================================
// MESSAGE HANDLER
// =============================================================================

window.addEventListener('message', event => {
    // Only accept messages from the VS Code webview host.
    // event.origin is '' in most VS Code webview contexts; block any non-empty
    // origin that does not match the expected vscode-webview:// scheme.
    if (event.origin !== '' && !event.origin.startsWith('vscode-webview://')) {
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

            // Determine delimiter
            if (message.config && message.config.delimiter && message.config.delimiter !== 'auto') {
                detectedDelimiter = message.config.delimiter;
            } else {
                detectedDelimiter = detectDelimiter(message.text, message.fileExtension || '');
            }
            updateDelimiterBadge(detectedDelimiter);

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
                if (pendingUpdateTimeout !== null) {
                    clearTimeout(pendingUpdateTimeout);
                    pendingUpdateTimeout = null;
                }
                pendingUpdateTimeout = setTimeout(async () => {
                    pendingUpdateTimeout = null;
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
            if (isChunkedMode) {
                chunkedLoadedPage = -1;
                chunkedLoadedPageHasData = false;
                handleChunkedScroll();
            }
            break;

        case 'queryResult':
            // Response from the extension host after running an AlaSQL query.
            (async () => {
                try {
                    const result = message.result;
                    if (!result || result.length === 0) {
                        currentDisplayData = [];
                        columnTypes = [];
                        await renderTable([], []);
                    } else {
                        const newData = objectsToData(result);
                        currentDisplayData = newData;
                        columnTypes = inferColumnTypes(newData);
                        sortState = { col: -1, dir: 'none' };
                        await renderTable(newData, []);
                        errorContainer.classList.add('hidden');
                        isQueryResult = true;
                        if (saveResultBtn) { saveResultBtn.classList.remove('hidden'); }
                    }
                } catch (e) {
                    errorContainer.textContent = "Query Error: " + e.message;
                    errorContainer.classList.remove('hidden');
                } finally {
                    hideLoader();
                }
            })();
            break;

        case 'queryError':
            errorContainer.textContent = "Query Error: " + message.message;
            errorContainer.classList.remove('hidden');
            hideLoader();
            break;
    }
});

// =============================================================================
// CHUNKED MODE INIT
// =============================================================================

async function initChunkedView(text, config) {
    currentConfig = config;
    const { data } = await parseCSV(text, detectedDelimiter);
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
    parseCSV(message.text, detectedDelimiter).then(({ data }) => {
        chunkedPending.delete(page);
        chunkedCache.set(page, data);

        // Evict pages far from the current view (keep a window of ±15 pages).
        const currentViewPage = chunkedLoadedPage >= 0 ? chunkedLoadedPage : page;
        for (const key of [...chunkedCache.keys()]) {
            if (Math.abs(key - currentViewPage) > 15) {
                chunkedCache.delete(key);
            }
        }
        // Hard size cap as a backstop against runaway memory usage.
        const MAX_CACHED_PAGES = 50;
        if (chunkedCache.size > MAX_CACHED_PAGES) {
            // Evict the oldest entries (Map preserves insertion order)
            const toDelete = chunkedCache.size - MAX_CACHED_PAGES;
            let deleted = 0;
            for (const key of chunkedCache.keys()) {
                chunkedCache.delete(key);
                if (++deleted >= toDelete) { break; }
            }
        }

        if (page === chunkedLoadedPage) {
            chunkedLoadedPageHasData = false;
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

// =============================================================================
// BUTTON HANDLERS
// =============================================================================

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

    queryInput.value = nextItem.dataset.query;
    queryInput.selectionStart = queryInput.selectionEnd = queryInput.value.length;
}

if (tableContainer) {
    // Double-click to edit
    tableContainer.addEventListener('dblclick', (e) => {
        if (isChunkedMode) { return; }
        const cell = e.target;
        if ((cell.tagName === 'TD' || cell.tagName === 'TH') && cell.contentEditable !== 'true') {
            cell.contentEditable = 'true';
            cell.focus();
            
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

    tableContainer.addEventListener('keydown', (e) => {
        const cell = e.target;
        if ((cell.tagName === 'TD' || cell.tagName === 'TH') && cell.contentEditable === 'true') {
            if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
                e.stopPropagation();
            }
        }
    }, true);

    // Hover tooltip
    tableContainer.addEventListener('mouseover', (e) => {
        const cell = e.target;
        if (cell.tagName === 'TD' || cell.tagName === 'TH') {
            if (!cell.title) {
                const colIndex = cell.cellIndex;
                const headerRow = currentDisplayData[0] || [];
                const colName = headerRow[colIndex] || `Column ${colIndex}`;
                
                const rowInTable = cell.parentElement.rowIndex;
                const scrollTop = tableContainer.scrollTop;
                const dataRowCount = currentDisplayData.length - 1;
                const startRow = Math.max(1, scrollTopToRow(scrollTop, dataRowCount));
                const buffer = 10;
                const renderStart = Math.max(1, startRow - buffer);
                
                const absoluteRowIndex = renderStart + rowInTable; 
                cell.title = `Row: ${absoluteRowIndex}\nColumn: ${colName}`;
            }
        }
    });
}

// =============================================================================
// AUTOCOMPLETE
// =============================================================================

queryInput.addEventListener("input", function(e) {
    let a, b, i, val = this.value;
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
        let insertVal = item;

        if (item.toUpperCase().startsWith(currentWord.toUpperCase())) {
            isMatch = true;
        } 
        else if (isBracketStart) {
            if (!item.startsWith('[') && item.toUpperCase().startsWith(searchWord.toUpperCase())) {
                isMatch = true;
                insertVal = /^[a-zA-Z0-9_]+$/.test(item) ? item : `[${item.replace(/\]/g, ']]')}]`;
            }
        }

        if (isMatch) {
            matches.push(insertVal);
            b = document.createElement("DIV");

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

queryInput.addEventListener("keydown", function(e) {
    let x = document.getElementById(this.id + "autocomplete-list");
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
            navigateHistoryPanel(1);
            e.preventDefault();
        } else {
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
            navigateHistoryPanel(-1);
            e.preventDefault();
        } else {
            if (queryHistory.length > 0) {
                if (historyIndex === -1) {
                    historyDraft = queryInput.value;
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
                      const event = new Event('input', { bubbles: true });
                      this.dispatchEvent(event);
                 }
             }
         }
    }
});

document.addEventListener("click", function (e) {
    closeAllLists(e.target);
});

// =============================================================================
// GO TO ROW
// =============================================================================

function openGotoRowModal() {
    if (!gotoRowModal || !gotoRowInput) { return; }
    gotoRowModal.classList.remove('hidden');
    gotoRowInput.value = '';
    gotoRowInput.focus();
}

function closeGotoRowModal() {
    if (gotoRowModal) { gotoRowModal.classList.add('hidden'); }
}

function executeGotoRow() {
    if (!gotoRowInput) { return; }
    const raw = parseInt(gotoRowInput.value, 10);
    if (isNaN(raw) || raw < 1) { return; }
    closeGotoRowModal();
    scrollToDataRow(raw - 1); // 0-based data row
}

/** Scroll the table so that 0-based data row `dataRowIndex` is visible. */
function scrollToDataRow(dataRowIndex) {
    if (!tableContainer) { return; }
    const rowCount = isChunkedMode ? chunkedTotalRows : (currentDisplayData.length - 1);
    const clamped = Math.max(0, Math.min(dataRowIndex, rowCount - 1));
    const targetScrollTop = rowToScrollTop(clamped, rowCount);
    tableContainer.scrollTop = targetScrollTop;
    if (!isChunkedMode) {
        updateVirtualTable();
        // Brief highlight on target row
        setTimeout(() => {
            highlightDataRow(clamped);
        }, 60);
    }
}

function highlightDataRow(dataRowIndex) {
    // dataRowIndex is 0-based (excluding header)
    const scrollTop = tableContainer.scrollTop;
    const rowCount = currentDisplayData.length - 1;
    const startRow = scrollTopToRow(scrollTop, rowCount);
    const buffer = 10;
    const renderStart = Math.max(1, startRow - buffer);
    const absoluteIndex = dataRowIndex + 1; // +1 for header
    const relativeIndex = absoluteIndex - renderStart;
    const tbody = table ? table.querySelector('tbody') : null;
    if (tbody && tbody.rows[relativeIndex]) {
        const row = tbody.rows[relativeIndex];
        row.classList.add('goto-row-highlight');
        setTimeout(() => row.classList.remove('goto-row-highlight'), 1500);
    }
}

if (gotoRowBtn) {
    gotoRowBtn.addEventListener('click', openGotoRowModal);
}
if (gotoRowOk) {
    gotoRowOk.addEventListener('click', executeGotoRow);
}
if (gotoRowCancel) {
    gotoRowCancel.addEventListener('click', closeGotoRowModal);
}
if (gotoRowInput) {
    gotoRowInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { executeGotoRow(); }
        if (e.key === 'Escape') { closeGotoRowModal(); }
    });
}
// Close on outside click
document.addEventListener('click', (e) => {
    if (gotoRowModal && !gotoRowModal.classList.contains('hidden')) {
        if (!gotoRowModal.contains(e.target) && e.target !== gotoRowBtn) {
            closeGotoRowModal();
        }
    }
});

// =============================================================================
// COLUMN FILTERS
// =============================================================================

function buildFilterRow() {
    if (!headerTable || !currentDisplayData || currentDisplayData.length === 0) { return; }
    const headers = currentDisplayData[0];
    const thead = headerTable.querySelector('thead');
    if (!thead) { return; }

    // Remember which visible column index had focus so we can restore it
    let focusedVisibleIdx = -1;
    thead.querySelectorAll('.filter-input').forEach((inp, i) => {
        if (document.activeElement === inp) { focusedVisibleIdx = i; }
    });

    // Remove any existing filter row
    const existing = thead.querySelector('#filter-tr');
    if (existing) { existing.remove(); }

    const tr = document.createElement('tr');
    tr.id = 'filter-tr';

    // Frozen spacer cell — mirrors the spacer th in the header row
    const frozenArr = [...frozenCols].sort((a, b) => a - b);
    if (frozenArr.length > 0) {
        const frozenTotalWidth = frozenArr.reduce((sum, i) => sum + (columnWidths[i] || 0), 0);
        const td = document.createElement('td');
        td.style.width = frozenTotalWidth + 'px';
        td.style.padding = '0';
        td.style.border = 'none';
        td.setAttribute('aria-hidden', 'true');
        tr.appendChild(td);
    }

    // Ensure columnWidths covers all header columns
    while (columnWidths.length < headers.length) { columnWidths.push(150); }

    let visibleIdx = 0;
    headers.forEach((colName, colIndex) => {
        if (frozenCols.has(colIndex)) { return; }

        const td = document.createElement('td');
        td.className = 'filter-cell';

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'filter-input';
        input.placeholder = 'Filter…';
        input.title = `Filter: ${colName}`;
        input.value = columnFilters[colIndex] || '';
        input.dataset.colIndex = colIndex;

        input.addEventListener('input', () => {
            columnFilters[colIndex] = input.value;
            applyFilters();
        });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { clearAllFilters(); }
        });

        td.appendChild(input);
        tr.appendChild(td);

        if (visibleIdx === focusedVisibleIdx) {
            const captured = input;
            Promise.resolve().then(() => {
                captured.focus();
                captured.selectionStart = captured.selectionEnd = captured.value.length;
            });
        }
        visibleIdx++;
    });

    thead.appendChild(tr);
}

function applyFilters() {
    if (!originalRawData || originalRawData.length === 0) { return; }
    const activeFilters = Object.entries(columnFilters).filter(([, v]) => v.trim() !== '');
    if (activeFilters.length === 0) {
        currentDisplayData = originalRawData.slice();
    } else {
        const header = originalRawData[0];
        const filtered = originalRawData.slice(1).filter(row => {
            return activeFilters.every(([colIdx, filterVal]) => {
                const cell = (row[colIdx] || '').toLowerCase();
                return cell.includes(filterVal.toLowerCase());
            });
        });
        currentDisplayData = [header, ...filtered];
    }
    // Re-apply sort if active
    if (sortState.col >= 0 && sortState.dir !== 'none') {
        currentDisplayData = applySortToData(currentDisplayData, sortState.col, sortState.dir);
    }
    renderTable(currentDisplayData, []);
    updateFilterBtnState();
}

function clearAllFilters() {
    columnFilters = {};
    currentDisplayData = originalRawData.slice();
    if (sortState.col >= 0 && sortState.dir !== 'none') {
        currentDisplayData = applySortToData(currentDisplayData, sortState.col, sortState.dir);
    }
    renderTable(currentDisplayData, []);
    if (filtersActive) { buildFilterRow(); } // reset input values
    updateFilterBtnState();
}

function updateFilterBtnState() {
    if (!filterBtn) { return; }
    const hasActiveFilters = Object.values(columnFilters).some(v => v.trim() !== '');
    if (hasActiveFilters) {
        filterBtn.classList.add('filter-btn-active');
        filterBtn.title = 'Filters active — click to toggle filter row';
    } else {
        filterBtn.classList.remove('filter-btn-active');
        filterBtn.title = 'Toggle column filters';
    }
}

if (filterBtn) {
    filterBtn.addEventListener('click', () => {
        filtersActive = !filtersActive;
        if (filtersActive) {
            buildFilterRow();
            filterBtn.classList.add('filter-row-open');
            filterBtn.title = 'Hide filter row';
        } else {
            removeFilterRow();
            filterBtn.classList.remove('filter-row-open');
            clearAllFilters();
        }
    });
}

function removeFilterRow() {
    if (!headerTable) { return; }
    const tr = headerTable.querySelector('#filter-tr');
    if (tr) { tr.remove(); }
}

// =============================================================================
// DUPLICATE ROW DETECTION
// =============================================================================

function findDuplicateRows(data) {
    // Returns a Set of 1-based row indices (in data[]) that are duplicates.
    if (!data || data.length < 2) { return new Set(); }
    const seen = new Map(); // serialized row -> first occurrence index
    const dupeIndices = new Set();
    for (let i = 1; i < data.length; i++) {
        const key = data[i].join('\x00'); // use null byte as safe separator
        if (seen.has(key)) {
            dupeIndices.add(i);
            dupeIndices.add(seen.get(key)); // also mark the first occurrence
        } else {
            seen.set(key, i);
        }
    }
    return dupeIndices;
}

// Returns Map<key, originalLineNumbers[]> — groups of duplicate rows with their
// 1-based CSV line numbers (header = line 1, first data row = line 2).
function buildDupeGroups(data) {
    if (!data || data.length < 2) { return new Map(); }
    const seen = new Map(); // key -> [ {lineNum, row} ]
    for (let i = 1; i < data.length; i++) {
        const key = data[i].join('\x00');
        if (!seen.has(key)) { seen.set(key, []); }
        seen.get(key).push({ lineNum: i + 1, row: data[i] }); // line 1 = header
    }
    // Keep only keys with >1 occurrence
    const groups = new Map();
    for (const [key, entries] of seen) {
        if (entries.length > 1) { groups.set(key, entries); }
    }
    return groups;
}

let dupeIndicesGlobal = new Set(); // currently highlighted dupe rows

function runDuplicateDetection() {
    if (isChunkedMode) {
        if (dupesBanner) {
            dupesBanner.innerHTML = '<span>Duplicate detection is not available in Paged View mode.</span>';
            dupesBanner.classList.remove('hidden');
        }
        return;
    }
    const dupeIndices = findDuplicateRows(currentDisplayData);
    dupeIndicesGlobal = dupeIndices;
    dupesMode = dupeIndices.size > 0;

    if (!dupesBanner) { return; }

    if (dupeIndices.size === 0) {
        dupesBanner.innerHTML = '<span class="dupes-none">✓ No duplicate rows found.</span> <button id="dupes-clear-btn" class="dupes-clear-btn">Dismiss</button>';
        dupesBanner.classList.remove('hidden');
    } else {
        const groups = buildDupeGroups(currentDisplayData);
        dupesBanner.innerHTML =
            `<span class="dupes-found">⚠ ${dupeIndices.size} duplicate rows found across ${groups.size} group(s).</span>` +
            ` <button id="dupes-show-only-btn" class="dupes-action-btn">Show only duplicates</button>` +
            ` <button id="dupes-clear-btn" class="dupes-clear-btn">Dismiss</button>`;
        dupesBanner.classList.remove('hidden');
    }
    // Attach banner button handlers
    const clearBtn = document.getElementById('dupes-clear-btn');
    if (clearBtn) { clearBtn.addEventListener('click', dismissDupesBanner); }

    const showOnlyBtn = document.getElementById('dupes-show-only-btn');
    if (showOnlyBtn) {
        showOnlyBtn.addEventListener('click', () => showDupesOnly(currentDisplayData));
    }

    // Re-render to apply highlight classes
    renderTable(currentDisplayData, []);
}

// Build and display the grouped duplicate-only view with a leading # (line number) column.
function showDupesOnly(data) {
    const groups = buildDupeGroups(data);
    if (groups.size === 0) { return; }

    // Build flat display data:
    // Row 0 = header with "#" prepended
    // Then for each group: its rows (with line number prepended), followed by a blank separator row
    const header = data[0];
    const lineNumHeader = ['#', ...header];
    const displayRows = [lineNumHeader];

    let groupIdx = 0;
    for (const entries of groups.values()) {
        for (const { lineNum, row } of entries) {
            displayRows.push([String(lineNum), ...row]);
        }
        // Blank separator between groups (except after the last one)
        groupIdx++;
        if (groupIdx < groups.size) {
            displayRows.push(new Array(lineNumHeader.length).fill(''));
        }
    }

    dupesOnlyMode = true;
    dupesMode = false;
    dupeIndicesGlobal = new Set();
    currentDisplayData = displayRows;
    dupeIndicesGlobal = findDuplicateRows(displayRows);
    dupesMode = true;
    renderTable(displayRows, []);

    if (dupesBanner) {
        const totalRows = displayRows.length - 1 - (groups.size - 1); // subtract separator rows
        dupesBanner.innerHTML =
            `<span class="dupes-found">Showing ${totalRows} duplicate rows in ${groups.size} group(s).</span>` +
            ` <button id="dupes-reset-btn" class="dupes-action-btn">Show all rows</button>` +
            ` <button id="dupes-clear-btn" class="dupes-clear-btn">Dismiss</button>`;
        const resetBtn = document.getElementById('dupes-reset-btn');
        if (resetBtn) { resetBtn.addEventListener('click', resetFromDupes); }
        const cb = document.getElementById('dupes-clear-btn');
        if (cb) { cb.addEventListener('click', dismissDupesBanner); }
    }
}

function dismissDupesBanner() {
    dupesMode = false;
    dupesOnlyMode = false;
    dupeIndicesGlobal = new Set();
    if (dupesBanner) { dupesBanner.classList.add('hidden'); }
    if (dupesBtn) { dupesBtn.classList.remove('dupes-btn-active'); }
    // If we were in dupes-only mode, restore the full dataset
    currentDisplayData = originalRawData.slice();
    if (sortState.col >= 0 && sortState.dir !== 'none') {
        currentDisplayData = applySortToData(currentDisplayData, sortState.col, sortState.dir);
    }
    renderTable(currentDisplayData, []);
}

function resetFromDupes() {
    dupesMode = false;
    dupesOnlyMode = false;
    dupeIndicesGlobal = new Set();
    currentDisplayData = originalRawData.slice();
    if (sortState.col >= 0 && sortState.dir !== 'none') {
        currentDisplayData = applySortToData(currentDisplayData, sortState.col, sortState.dir);
    }
    renderTable(currentDisplayData, []);
    if (dupesBanner) { dupesBanner.classList.add('hidden'); }
    if (dupesBtn) { dupesBtn.classList.remove('dupes-btn-active'); }
}

if (dupesBtn) {
    dupesBtn.addEventListener('click', () => {
        if (dupesMode) {
            dismissDupesBanner();
        } else {
            dupesBtn.classList.add('dupes-btn-active');
            runDuplicateDetection();
        }
    });
}

// =============================================================================
// CORE LOGIC
// =============================================================================

async function updateContent(text, config) {
    currentConfig = config;
    const { data, errors } = await parseCSV(text, detectedDelimiter);
    
    originalRawData = data;
    currentDisplayData = data;
    originalDataObjects = [];

    // Infer column types after parsing
    columnTypes = inferColumnTypes(data);

    // Reset sort state on fresh data
    sortState = { col: -1, dir: 'none' };
    frozenCols = new Set();

    // Reset filter and dupe state on fresh data
    columnFilters = {};
    filtersActive = false;
    dupesMode = false;
    dupesOnlyMode = false;
    dupeIndicesGlobal = new Set();
    removeFilterRow();
    if (filterBtn) { filterBtn.classList.remove('filter-row-open', 'filter-btn-active'); }
    if (dupesBanner) { dupesBanner.classList.add('hidden'); }
    if (dupesBtn) { dupesBtn.classList.remove('dupes-btn-active'); }

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
    const x = document.getElementsByClassName("autocomplete-items");
    for (let i = 0; i < x.length; i++) {
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
    const A = array.concat().sort();
    const a1 = A[0], a2 = A[A.length-1];
    let L = a1.length, i = 0;
    while(i<L && a1.charAt(i).toLowerCase()=== a2.charAt(i).toLowerCase()) i++;
    return a1.substring(0, i);
}

// =============================================================================
// SQL QUERY ENGINE
// =============================================================================

function runQuery() {
    const query = queryInput.value.trim();
    if (!query) return;

    const normalizedQuery = query.replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (!/^SELECT\s/i.test(normalizedQuery)) {
        errorContainer.textContent = "Query Error: Only SELECT queries are allowed.";
        errorContainer.classList.remove('hidden');
        return;
    }
    // Block semicolons (prevent multi-statement injection)
    if (/;/.test(normalizedQuery)) {
        errorContainer.textContent = "Query Error: Semicolons are not allowed in queries.";
        errorContainer.classList.remove('hidden');
        return;
    }
    const blockedPattern = /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|EXEC|EXECUTE|INTO\s+TEMP|ATTACH|DETACH|SOURCE|PRAGMA|SHOW\s+TABLES|SHOW\s+DATABASES|SET\s+OPTION)\b/i;
    if (blockedPattern.test(normalizedQuery)) {
        errorContainer.textContent = "Query Error: Data modification statements are not allowed.";
        errorContainer.classList.remove('hidden');
        return;
    }
    // Detect double-quoted string literals (invalid in AlaSQL — use single quotes)
    // Match a " that is not part of a bracket-quoted identifier like [col]
    if (/(?<!\])"(?!\[)/.test(normalizedQuery.replace(/\[[^\]]*\]/g, ''))) {
        errorContainer.textContent = "Query Error: Use single quotes for string values, not double quotes. Example: WHERE [Column]='value'";
        errorContainer.classList.remove('hidden');
        return;
    }

    if (queryHistory.length === 0 || queryHistory[0] !== query) {
        queryHistory.unshift(query);
        if (queryHistory.length > 50) queryHistory.pop();
    }
    historyIndex = -1;
    historyDraft = '';
    closeHistoryList();

    showLoader();

    setTimeout(async () => {
        try {
            if (originalDataObjects.length === 0 && originalRawData.length > 0) {
                originalDataObjects = await dataToObjects(originalRawData);
            }

            // Execute query on the extension host (avoids unsafe-eval in CSP).
            vscode.postMessage({ type: 'runQuery', query, data: originalDataObjects });
            // Result handled asynchronously via 'queryResult' / 'queryError' messages.
        } catch (e) {
            errorContainer.textContent = "Query Error: " + e.message;
            errorContainer.classList.remove('hidden');
            hideLoader();
        }
    }, 50);
}

function resetQuery() {
    queryInput.value = '';
    historyIndex = -1;
    historyDraft = '';
    closeHistoryList();
    isQueryResult = false;
    if (saveResultBtn) { saveResultBtn.classList.add('hidden'); }
    showLoader();
    sortState = { col: -1, dir: 'none' };
    setTimeout(async () => {
        try {
            currentDisplayData = originalRawData;
            columnTypes = inferColumnTypes(originalRawData);
            await renderTable(originalRawData, []);
            errorContainer.classList.add('hidden');
        } finally {
            hideLoader();
        }
    }, 50);
}

function serializeToCSV(data) {
    return data.map(row =>
        row.map(cell => {
            const s = cell == null ? '' : String(cell);
            return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        }).join(',')
    ).join('\n');
}

if (saveResultBtn) {
    saveResultBtn.addEventListener('click', () => {
        if (!isQueryResult || !currentDisplayData || currentDisplayData.length === 0) { return; }
        const csv = serializeToCSV(currentDisplayData);
        vscode.postMessage({ type: 'saveQueryResult', csv });
    });
}

async function dataToObjects(data) {
    if (data.length < 2) return [];
    const headers = data[0];
    const safeHeaders = headers.map(h => DANGEROUS_KEYS.has(h) ? `_${h}` : h);
    const objects = [];
    for (let i = 1; i < data.length; i++) {
        const row = data[i];
        const obj = Object.create(null);
        safeHeaders.forEach((h, index) => {
            const val = row[index];
            // Coerce numeric strings to numbers so AlaSQL aggregates (AVG, SUM, etc.) work correctly.
            if (val != null && val.trim() !== '' && !isNaN(Number(val.trim()))) {
                obj[h] = Number(val.trim());
            } else {
                obj[h] = val;
            }
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
        const row = headers.map(h => obj[h] == null ? '' : String(obj[h]));
        data.push(row);
    });
    return data;
}

// =============================================================================
// CSV PARSER — now accepts a delimiter parameter
// =============================================================================

async function parseCSV(text, delimiter) {
    const delim = delimiter || detectedDelimiter || ',';
    const delimCode = delim.charCodeAt(0);

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
            } else if (char === delim) {
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
    
    if (fieldStart < len || text.endsWith(delim)) {
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
        const csvContent = dataToCSV(originalRawData, detectedDelimiter);
        vscode.postMessage({
            type: 'edit',
            text: csvContent
        });
    }, 300);
}

async function onCellChange(e) {
    const cell = e.target;
    const scrollTop = tableContainer.scrollTop;
    const dataRowCount = currentDisplayData.length - 1;
    const startRow = Math.max(1, scrollTopToRow(scrollTop, dataRowCount));
    const buffer = 10;
    const renderStart = Math.max(1, startRow - buffer);
    
    const rowInDisplay = renderStart + cell.parentElement.rowIndex;
    const col = cell.cellIndex;
    const newValue = cell.textContent;

    if (currentDisplayData[rowInDisplay] && currentDisplayData[rowInDisplay][col] === newValue) return;
    if (!currentDisplayData[rowInDisplay]) return;

    currentDisplayData[rowInDisplay][col] = newValue;
    debounceSave();
}

function dataToCSV(data, delimiter) {
    const delim = delimiter || ',';
    // Preserve the original file's line endings (CRLF vs LF).
    const lineEnding = currentText && currentText.includes('\r\n') ? '\r\n' : '\n';
    return data.map(row => {
        return row.map(cell => {
            const text = cell || '';
            if (text.includes(delim) || text.includes('"') || text.includes('\n') || text.includes('\r')) {
                return `"${text.replace(/"/g, '""')}"`;
            }
            return text;
        }).join(delim);
    }).join(lineEnding);
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

// =============================================================================
// RENDER TABLE — with type badges, sort headers, frozen columns
// =============================================================================

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

    // Remove any existing frozen table overlay
    const existingFrozen = document.getElementById('frozen-overlay');
    if (existingFrozen) { existingFrozen.remove(); }

    // Detach the filter row before wiping the header so we can reattach it
    // afterwards without rebuilding — this preserves focus during keystroke filtering.
    const existingFilterTr = headerTable ? headerTable.querySelector('#filter-tr') : null;
    if (existingFilterTr) { existingFilterTr.remove(); }

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
    const frozenArr = [...frozenCols].sort((a, b) => a - b);
    const hasFrozen = frozenArr.length > 0;

    // Apply current sort
    let displayData = data;
    if (sortState.col >= 0 && sortState.dir !== 'none') {
        displayData = applySortToData(data, sortState.col, sortState.dir);
        currentDisplayData = displayData;
    }
    
    // Calculate Column Widths (sample first 100 rows).
    // Skip recalculation when filters are active — preserve the widths from the
    // full dataset so filter fields stay aligned even with zero result rows.
    const hasExistingWidths = filtersActive && columnWidths.length === headerRow.length;
    if (!hasExistingWidths) {
        const sampleRows = displayData.slice(1, 101);
        columnWidths = headerRow.map((h, colIndex) => {
            let maxWidth = h.length;
            sampleRows.forEach(row => {
                const cellLength = row[colIndex] ? row[colIndex].length : 0;
                if (cellLength > maxWidth) maxWidth = cellLength;
            });
            const charWidth = 9;
            const padding = 24;
            return Math.max(100, Math.min(600, (maxWidth * charWidth) + padding));
        });
    }

    // Widths for visible (non-frozen) columns
    const visibleWidths = columnWidths.filter((_, i) => !frozenCols.has(i));
    const frozenWidths = frozenArr.map(i => columnWidths[i]);

    const totalTableWidth = (hasFrozen ? visibleWidths : columnWidths).reduce((a, b) => a + b, 0);
    const frozenTotalWidth = frozenWidths.reduce((a, b) => a + b, 0);

    // Build colgroup for main tables.
    // When frozen: prepend one spacer <col> that is exactly frozenTotalWidth wide,
    // followed by the visible column widths. This keeps header and body perfectly aligned
    // without relying on padding-left (which has cross-browser scroll quirks).
    function buildMainColGroup() {
        const colgroup = document.createElement('colgroup');
        if (hasFrozen) {
            const spacerCol = document.createElement('col');
            spacerCol.style.width = frozenTotalWidth + 'px';
            colgroup.appendChild(spacerCol);
        }
        visibleWidths.forEach(w => {
            const col = document.createElement('col');
            col.style.width = w + 'px';
            colgroup.appendChild(col);
        });
        return colgroup;
    }

    // Add colgroups to both tables for perfect alignment
    if (headerTable) headerTable.appendChild(hasFrozen ? buildMainColGroup() : createColGroup(columnWidths));
    table.appendChild(hasFrozen ? buildMainColGroup() : createColGroup(columnWidths));

    const mainTableWidth = frozenTotalWidth + totalTableWidth;
    if (headerTable) headerTable.style.width = (hasFrozen ? mainTableWidth : totalTableWidth) + 'px';
    table.style.width = (hasFrozen ? mainTableWidth : totalTableWidth) + 'px';

    // No padding-left needed — the spacer col handles the offset.
    const scrollbarWidth = tableContainer.offsetWidth - tableContainer.clientWidth;
    if (headerContainer) {
        headerContainer.style.paddingRight = scrollbarWidth + 'px';
        headerContainer.style.paddingLeft = '0';
    }
    if (tableContainer) {
        tableContainer.style.paddingLeft = '0';
    }

    // Build Header Table
    const thead = document.createElement('thead');
    const trHead = document.createElement('tr');

    // Spacer th to reserve space under the frozen overlay
    if (hasFrozen) {
        const spacerTh = document.createElement('th');
        spacerTh.style.width = frozenTotalWidth + 'px';
        spacerTh.style.minWidth = frozenTotalWidth + 'px';
        spacerTh.style.padding = '0';
        spacerTh.style.border = 'none';
        spacerTh.setAttribute('aria-hidden', 'true');
        trHead.appendChild(spacerTh);
    }
    headerRow.forEach((colName, index) => {
        if (frozenCols.has(index)) { return; } // frozen headers rendered separately
        const th = document.createElement('th');
        th.dataset.colIndex = index;

        // In dupes-only mode, column 0 is the line-number pin — render simply
        if (dupesOnlyMode && index === 0) {
            th.className = 'dupe-linenum-header';
            th.textContent = '#';
            trHead.appendChild(th);
            return;
        }

        // Type badge
        const type = columnTypes[index] || 'string';
        const badgeSpan = document.createElement('span');
        badgeSpan.className = `type-badge type-${type}`;
        badgeSpan.textContent = TYPE_BADGES[type] || 'abc';
        badgeSpan.title = TYPE_TITLES[type] || 'String';
        th.appendChild(badgeSpan);

        // Column name
        const nameSpan = document.createElement('span');
        nameSpan.className = 'col-name-text';
        nameSpan.textContent = ' ' + colName;
        th.appendChild(nameSpan);

        // Sort indicator
        const sortSpan = document.createElement('span');
        sortSpan.className = 'sort-indicator';
        if (index === sortState.col) {
            sortSpan.textContent = sortState.dir === 'asc' ? ' ▲' : ' ▼';
        }
        th.appendChild(sortSpan);

        // Click: sort on single click, stats popover on shift+click
        th.addEventListener('click', (e) => {
            if (e.shiftKey) {
                showStatsPopover(index, th);
            } else {
                hideStatsPopover();
                cycleSortDir(index);
                updateSortIndicators();
                // Re-render with sort applied
                showLoader();
                setTimeout(async () => {
                    try {
                        // Preserve horizontal scroll position
                        const savedScrollLeft = tableContainer.scrollLeft;
                        
                        const sorted = applySortToData(currentDisplayData, sortState.col, sortState.dir);
                        currentDisplayData = sorted;
                        await renderTable(sorted, []);
                        
                        // Restore horizontal scroll position
                        tableContainer.scrollLeft = savedScrollLeft;
                        headerContainer.scrollLeft = savedScrollLeft;
                    } finally {
                        hideLoader();
                    }
                }, 10);
            }
        });

        // Right-click: freeze context menu
        th.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            showFreezeContextMenu(index, e);
        });

        th.title = `${colName} (${TYPE_TITLES[type] || 'String'})\nClick to sort | Shift+click for stats | Right-click to freeze pane`;
        th.classList.add('col-stats-trigger');
        trHead.appendChild(th);
    });
    thead.appendChild(trHead);
    if (headerTable) headerTable.appendChild(thead);

    // Build Body Table Structure
    const tbody = document.createElement('tbody');
    table.appendChild(tbody);

    const dataRowCount = displayData.length - 1; // exclude header
    virtualSpacer.style.height = spacerHeight(dataRowCount) + 'px';

    // Build Frozen overlay (header + body) if any columns are frozen
    if (hasFrozen) {
        buildFrozenOverlay(displayData, frozenArr, frozenWidths, frozenTotalWidth, dataRowCount);
    }

    updateVirtualTable();

    // Rebuild schema panel if it's open
    if (schemaPanel && !schemaPanel.classList.contains('hidden')) {
        buildSchemaPanel();
    }

    // Reattach or build the filter row
    if (filtersActive) {
        const thead = headerTable ? headerTable.querySelector('thead') : null;
        if (thead) {
            if (existingFilterTr) {
                // Reattach the existing row — inputs, values and focus intact
                thead.appendChild(existingFilterTr);
            } else {
                buildFilterRow();
            }
        }
    }

    clearTimeout(slowLoadTimer);
    if (slowLoadModal) slowLoadModal.classList.add('hidden');
}

/**
 * Build the frozen column overlay: a fixed-position div containing
 * a header table and a body table (for visible rows).
 */
function buildFrozenOverlay(data, frozenArr, frozenWidths, totalFrozenWidth, dataRowCount) {
    // Remove old
    const old = document.getElementById('frozen-overlay');
    if (old) { old.remove(); }

    const overlay = document.createElement('div');
    overlay.id = 'frozen-overlay';
    overlay.className = 'frozen-overlay';
    overlay.style.width = totalFrozenWidth + 'px';

    // Frozen header table
    const frozenHeaderWrap = document.createElement('div');
    frozenHeaderWrap.className = 'frozen-header-wrap';
    frozenHeaderWrap.style.height = headerContainer ? (headerContainer.offsetHeight || 33) + 'px' : '33px';

    const fHeaderTable = document.createElement('table');
    fHeaderTable.id = 'frozen-header-table';
    fHeaderTable.className = 'frozen-header-table';
    fHeaderTable.appendChild(createColGroup(frozenWidths));
    fHeaderTable.style.width = totalFrozenWidth + 'px';
    const fThead = document.createElement('thead');
    const fTrHead = document.createElement('tr');
    frozenArr.forEach((colIndex) => {
        const th = document.createElement('th');
        th.className = 'frozen-col-header';
        th.dataset.colIndex = colIndex;

        const type = columnTypes[colIndex] || 'string';
        const badgeSpan = document.createElement('span');
        badgeSpan.className = `type-badge type-${type}`;
        badgeSpan.textContent = TYPE_BADGES[type] || 'abc';
        th.appendChild(badgeSpan);

        const nameSpan = document.createElement('span');
        nameSpan.className = 'col-name-text';
        nameSpan.textContent = ' ' + (data[0][colIndex] || '');
        th.appendChild(nameSpan);

        // Sort on frozen header click
        th.addEventListener('click', (e) => {
            if (e.shiftKey) {
                showStatsPopover(colIndex, th);
            } else {
                cycleSortDir(colIndex);
                showLoader();
                setTimeout(async () => {
                    try {
                        // Preserve horizontal scroll position
                        const savedScrollLeft = tableContainer.scrollLeft;
                        
                        const sorted = applySortToData(currentDisplayData, sortState.col, sortState.dir);
                        currentDisplayData = sorted;
                        await renderTable(sorted, []);
                        
                        // Restore horizontal scroll position
                        tableContainer.scrollLeft = savedScrollLeft;
                        headerContainer.scrollLeft = savedScrollLeft;
                    } finally {
                        hideLoader();
                    }
                }, 10);
            }
        });

        th.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            showFreezeContextMenu(colIndex, e);
        });

        fTrHead.appendChild(th);
    });
    fThead.appendChild(fTrHead);
    fHeaderTable.appendChild(fThead);
    frozenHeaderWrap.appendChild(fHeaderTable);
    overlay.appendChild(frozenHeaderWrap);

    // Frozen body wrap — clips to table container height
    const frozenBodyWrap = document.createElement('div');
    frozenBodyWrap.className = 'frozen-body-wrap';

    const fBodyTable = document.createElement('table');
    fBodyTable.id = 'frozen-body-table';
    fBodyTable.className = 'frozen-body-table';
    if (currentConfig.alternatingRows) { fBodyTable.classList.add('alternating-rows'); }
    fBodyTable.appendChild(createColGroup(frozenWidths));
    fBodyTable.style.width = totalFrozenWidth + 'px';
    fBodyTable.appendChild(document.createElement('tbody'));
    frozenBodyWrap.appendChild(fBodyTable);
    overlay.appendChild(frozenBodyWrap);

    // Append overlay into the positioned .table-area wrapper so it sits
    // on top of both header and body without affecting flex flow.
    const area = tableArea || tableContainer.parentElement;
    if (area) {
        area.appendChild(overlay);
    }
}

// =============================================================================
// HTML ESCAPE
// =============================================================================

function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    const str = String(text);
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// =============================================================================
// PLAIN TEXT COLORIZER
// =============================================================================

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
        const delim = detectedDelimiter || ',';
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
                } else if (char === delim) {
                    const colorClass = 'col-color-' + ((colIndex % 10) + 1);
                    rowHtml += `<span class="${colorClass}">${escapeHtml(currentField)}</span>${escapeHtml(delim)}`;
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

// =============================================================================
// ERROR RULER
// =============================================================================

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
                    const targetScrollTop = Math.max(0, (line - 2) * rowHeight);
                    tableContainer.scrollTop = targetScrollTop;
                    
                    setTimeout(() => {
                        const scrollTop = tableContainer.scrollTop;
                        const startRow = Math.max(1, Math.floor(scrollTop / rowHeight));
                        const buffer = 10;
                        const renderStart = Math.max(1, startRow - buffer);
                        
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
