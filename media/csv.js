const vscode = acquireVsCodeApi();

// --- State ---
let currentConfig = {};
let originalDataObjects = []; // Array of Objects for SQL
let originalRawData = []; // Array of Arrays for Render
let currentDisplayData = []; // Data currently being shown (full or filtered)
let autocompleteOptions = []; // Shared source for autocomplete
let currentFocus = -1; // Shared focus state for autocomplete
let isUpdating = false; // Guard for overlapping updates

// --- Virtual Scrolling State ---
let rowHeight = 30; // Matches CSS height
let visibleRows = 40; 
let totalRows = 0;
let lastScrollTop = 0;
let columnWidths = []; // Array of pixel widths for columns

// --- DOM Elements ---
const queryInput = document.getElementById('sql-query');
const runButton = document.getElementById('run-query');
const resetButton = document.getElementById('reset-query');
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
        
        // Virtual vertical scroll
        if (currentDisplayData.length > 50) { 
            handleScroll();
        }
    });
}

function handleScroll() {
    requestAnimationFrame(() => {
        updateVirtualTable();
    });
}

function updateVirtualTable() {
    if (!currentDisplayData || currentDisplayData.length === 0) return;
    
    const scrollTop = tableContainer.scrollTop;
    
    // Calculate which rows are visible
    let startRow = Math.floor(scrollTop / rowHeight);
    // Data starts at index 1 (row 0 is header)
    startRow = Math.max(1, startRow);
    
    const buffer = 10;
    const renderStart = Math.max(1, startRow - buffer);
    const renderEnd = Math.min(currentDisplayData.length, startRow + visibleRows + buffer);
    
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
    
    // Position the tbody at the correct scroll offset
    const tbodyOffset = (renderStart - 1) * rowHeight;
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
    const message = event.data;
    switch (message.type) {
        case 'update':
            currentText = message.text;
            showLoader();
            isRenderingInterrupted = false;
            clearTimeout(slowLoadTimer);

            if (message.config.showSlowLoadPrompt) {
                slowLoadTimer = setTimeout(() => {
                    if (loader && !loader.classList.contains('hidden')) {
                        if (slowLoadModal) slowLoadModal.classList.remove('hidden');
                    }
                }, SLOW_LOAD_TIMEOUT);
            }

            if (message.viewMode === 'head') {
                warningContainer.textContent = "Viewing Sample: Top 1000 rows. SQL queries will only run against this sample.";
                warningContainer.classList.remove('hidden');
                tableContainer.classList.remove('hidden');
                headerContainer.classList.remove('hidden');
                textContainer.classList.add('hidden');
                controls.classList.remove('hidden');
                if (errorRuler) errorRuler.classList.remove('hidden');
            } else if (message.viewMode === 'tail') {
                warningContainer.textContent = "Viewing Sample: Bottom 1000 rows. SQL queries will only run against this sample.";
                warningContainer.classList.remove('hidden');
                tableContainer.classList.remove('hidden');
                headerContainer.classList.remove('hidden');
                textContainer.classList.add('hidden');
                controls.classList.remove('hidden');
                if (errorRuler) errorRuler.classList.remove('hidden');
            } else if (message.viewMode === 'text') {
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
                const threshold = message.config.safeModeThreshold || 5;
                warningContainer.textContent = `Warning: This file is large (>${threshold}MB) and may cause performance issues.`;
                warningContainer.classList.remove('hidden');
                tableContainer.classList.remove('hidden');
                headerContainer.classList.remove('hidden');
                textContainer.classList.add('hidden');
                controls.classList.remove('hidden');
                if (errorRuler) errorRuler.classList.remove('hidden');
            } else {
                warningContainer.classList.add('hidden');
                tableContainer.classList.remove('hidden');
                headerContainer.classList.remove('hidden');
                textContainer.classList.add('hidden');
                controls.classList.remove('hidden');
                if (errorRuler) errorRuler.classList.remove('hidden');
            }
            
            // Use setTimeout to allow the browser to render the loader
            setTimeout(async () => {
                if (isUpdating) return;
                isUpdating = true;
                try {
                    if (message.viewMode !== 'text') {
                        await updateContent(message.text, message.config);
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
            break;
    }
});

function showLoader() {
    if (loader) loader.classList.remove('hidden');
}

function hideLoader() {
    if (loader) loader.classList.add('hidden');
}


// 2. Button Handlers
runButton.addEventListener('click', runQuery);
resetButton.addEventListener('click', resetQuery);

// Event delegation for cell edits
if (tableContainer) {
    // Single-click to select, Double-click to edit
    tableContainer.addEventListener('dblclick', (e) => {
        const cell = e.target;
        if ((cell.tagName === 'TD' || cell.tagName === 'TH') && cell.contentEditable !== 'true') {
            cell.contentEditable = 'true';
            cell.focus();
        }
    });

    tableContainer.addEventListener('focusout', (e) => {
        if (e.target.tagName === 'TD' || e.target.tagName === 'TH') {
            onCellChange(e);
            e.target.contentEditable = 'false';
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
            b.innerHTML = displayHtml;
            b.innerHTML += "<input type='hidden' value='" + escapeHtml(insertVal) + "'>";
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
    
    if (e.key === "ArrowDown") {
        if (x) {
            currentFocus++;
            if (currentFocus >= x.length) currentFocus = 0; 
            addActive(x);
            e.preventDefault();
        }
    } else if (e.key === "ArrowUp") {
        if (x) {
            currentFocus--;
            if (currentFocus < -1) currentFocus = x.length - 1; 
            addActive(x);
            e.preventDefault();
        }
    } else if (e.key === "Enter") {
        if (currentFocus > -1) {
            if (x) {
                e.preventDefault();
                x[currentFocus].click();
            }
        } else {
            if (x) {
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
    const objects = [];
    for (let i = 1; i < data.length; i++) {
        const row = data[i];
        const obj = {};
        headers.forEach((h, index) => {
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

    const totalHeight = (data.length - 1) * rowHeight;
    virtualSpacer.style.height = totalHeight + 'px';

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
            const targetScrollTop = (line - 1) * rowHeight;
            tableContainer.scrollTop = targetScrollTop;
            setTimeout(() => {
                const scrollTop = tableContainer.scrollTop;
                const startRow = Math.max(1, Math.floor(scrollTop / rowHeight));
                const buffer = 10;
                const renderStart = Math.max(1, startRow - buffer);
                const relativeIndex = line - renderStart - 1; 
                const rows = table.querySelector('tbody').rows;
                if (rows[relativeIndex]) {
                    const row = rows[relativeIndex];
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
