const vscode = acquireVsCodeApi();

// --- State ---
let currentConfig = {};
let originalDataObjects = []; // Array of Objects for SQL
let originalRawData = []; // Array of Arrays for Render
let autocompleteOptions = []; // Shared source for autocomplete
let currentFocus = -1; // Shared focus state for autocomplete

// --- DOM Elements ---
const queryInput = document.getElementById('sql-query');
const runButton = document.getElementById('run-query');
const resetButton = document.getElementById('reset-query');
const errorContainer = document.getElementById('error-container');
const loader = document.getElementById('loader');
const warningContainer = document.getElementById('warning-container');
const tableContainer = document.querySelector('.table-container');
const textContainer = document.getElementById('text-container');
const rawTextArea = document.getElementById('raw-text');
const controls = document.getElementById('controls');
const errorRuler = document.getElementById('error-ruler');

// --- Constants ---
const sqlKeywords = ['SELECT', 'FROM', 'WHERE', 'ORDER BY', 'GROUP BY', 'LIMIT', 'JOIN', 'ON', 'AS', 'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MAX', 'MIN', 'LIKE', 'IN', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END'];

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

// --- Event Listeners (Attached Once) ---

// 1. Message Handler
window.addEventListener('message', event => {
    const message = event.data;
    switch (message.type) {
        case 'update':
            showLoader();

            if (message.viewMode === 'head') {
                warningContainer.textContent = "Viewing Sample: Top 1000 rows. SQL queries will only run against this sample.";
                warningContainer.classList.remove('hidden');
                tableContainer.classList.remove('hidden');
                textContainer.classList.add('hidden');
                controls.classList.remove('hidden');
                if (errorRuler) errorRuler.classList.remove('hidden');
            } else if (message.viewMode === 'tail') {
                warningContainer.textContent = "Viewing Sample: Bottom 1000 rows. SQL queries will only run against this sample.";
                warningContainer.classList.remove('hidden');
                tableContainer.classList.remove('hidden');
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
                textContainer.classList.remove('hidden');
                controls.classList.add('hidden');
                if (errorRuler) errorRuler.classList.add('hidden');
            } else if (message.isLargeFile) {
                const threshold = message.config.safeModeThreshold || 5;
                warningContainer.textContent = `Warning: This file is large (>${threshold}MB) and may cause performance issues.`;
                warningContainer.classList.remove('hidden');
                tableContainer.classList.remove('hidden');
                textContainer.classList.add('hidden');
                controls.classList.remove('hidden');
                if (errorRuler) errorRuler.classList.remove('hidden');
            } else {
                warningContainer.classList.add('hidden');
                tableContainer.classList.remove('hidden');
                textContainer.classList.add('hidden');
                controls.classList.remove('hidden');
                if (errorRuler) errorRuler.classList.remove('hidden');
            }
            
            // Use setTimeout to allow the browser to render the loader
            setTimeout(async () => {
                try {
                    if (message.viewMode !== 'text') {
                        await updateContent(message.text, message.config);
                    }
                } catch (e) {
                    console.error("Error updating content:", e);
                    errorContainer.textContent = "Error loading CSV: " + e.message;
                    errorContainer.classList.remove('hidden');
                } finally {
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

// 3. Autocomplete: Input Event
queryInput.addEventListener("input", function(e) {
    var a, b, i, val = this.value;
    closeAllLists();
    if (!val) { return false;}
    currentFocus = -1;
    
    // Find word being typed at cursor
    const cursorMoved = this.selectionStart;
    const textBefore = val.substring(0, cursorMoved);
    // Regex to find the last word boundary. Matches alphanumeric, underscores, and brackets.
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

    // Use the global autocompleteOptions
    for (i = 0; i < autocompleteOptions.length; i++) {
        const item = autocompleteOptions[i];
        let isMatch = false;
        let displayHtml = "";
        let insertVal = item;

        // Strategy 1: Standard Prefix Match
        if (item.toUpperCase().startsWith(currentWord.toUpperCase())) {
            isMatch = true;
            displayHtml = "<strong>" + escapeHtml(item.substr(0, currentWord.length)) + "</strong>" + escapeHtml(item.substr(currentWord.length));
        } 
        // Strategy 2: Bracket Match (User typed '[', item is 'Name') -> Match 'Name' against 'Name'
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
            if (currentFocus >= x.length) currentFocus = 0; // Cycle back to top
            addActive(x);
            e.preventDefault();
        }
    } else if (e.key === "ArrowUp") {
        if (x) {
            currentFocus--;
            if (currentFocus < -1) currentFocus = x.length - 1; // Cycle to bottom, skipping 0 if coming from -1? No, from 0 to -1.
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
                runQuery(); // Only run query if no list is open or user explicitly closed it
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
                      // Trigger input event to refresh list
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
    originalDataObjects = await dataToObjects(data);

    // Update Autocomplete Options
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
    if (currentFocus < 0 || currentFocus >= x.length) return; // Allow -1 state (no selection)
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
            const result = alasql(query, [originalDataObjects]);
            
            if (!result || result.length === 0) {
                await renderTable([], []);
                return;
            }

            const newData = objectsToData(result);
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
    let currentField = '';
    let inQuotes = false;
    
    // Normalize newlines
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        const nextChar = text[i + 1];

        if (i % 50000 === 0 && i > 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        if (inQuotes) {
            if (char === '"') {
                if (nextChar === '"') {
                    currentField += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                currentField += char;
            }
        } else {
            if (char === '"') {
                inQuotes = true;
            } else if (char === ',') {
                currentRow.push(currentField);
                currentField = '';
            } else if (char === '\n') {
                currentRow.push(currentField);
                currentField = '';
                data.push(currentRow);
                currentRow = [];
            } else {
                currentField += char;
            }
        }
    }
    
    if (currentField || currentRow.length > 0 || text.endsWith(',')) {
        currentRow.push(currentField);
        data.push(currentRow);
    }

    if (inQuotes) {
        errors.push({
            line: data.length + 1,
            message: `Row ${data.length + 1}: Unclosed quote detected.`
        });
    }

    // Linting
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
    const row = parseInt(cell.dataset.row);
    const col = parseInt(cell.dataset.col);
    const newValue = cell.textContent;

    if (originalRawData[row] && originalRawData[row][col] === newValue) return;

    if (!originalRawData[row]) {
        // This shouldn't happen with correct data-row attributes
        return;
    }

    originalRawData[row][col] = newValue;

    // Update originalDataObjects if it's not the header
    if (row > 0) {
        const header = originalRawData[0];
        const objIndex = row - 1;
        if (originalDataObjects[objIndex]) {
            originalDataObjects[objIndex][header[col]] = newValue;
        }
    } else {
        // If header changed, we need to rebuild originalDataObjects because keys changed
        originalDataObjects = await dataToObjects(originalRawData);
        // Also update autocomplete options
        const columns = originalRawData[0].map(c => {
            return /^[a-zA-Z0-9_]+$/.test(c) ? c : `[${c.replace(/\]/g, ']]')}]`;
        });
        autocompleteOptions = [...sqlKeywords, ...columns];
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

async function renderTable(data, errors) {
    const table = document.getElementById('csv-table');
    const errorRuler = document.getElementById('error-ruler');
    
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

    table.innerHTML = '';
// ... (rest of renderTable)

    if (data.length === 0) return;

    if (currentConfig.stickyHeader) {
        table.classList.add('sticky-header');
    } else {
        table.classList.remove('sticky-header');
    }

    if (currentConfig.alternatingRows) {
        table.classList.add('alternating-rows');
    } else {
        table.classList.remove('alternating-rows');
    }

    const headerRow = data[0];
    const thead = document.createElement('thead');
    const trHead = document.createElement('tr');
    headerRow.forEach((colName, index) => {
        const th = document.createElement('th');
        th.textContent = colName;
        th.contentEditable = 'true';
        th.dataset.row = 0;
        th.dataset.col = index;
        th.title = `Index: ${index}\nName: ${colName}`;
        th.addEventListener('blur', onCellChange);
        trHead.appendChild(th);
    });
    thead.appendChild(trHead);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    table.appendChild(tbody);

    const CHUNK_SIZE = 1000;
    for (let i = 1; i < data.length; i += CHUNK_SIZE) {
        const chunkEnd = Math.min(i + CHUNK_SIZE, data.length);
        const fragment = document.createDocumentFragment();

        for (let j = i; j < chunkEnd; j++) {
            const row = data[j];
            const tr = document.createElement('tr');
            row.forEach((cell, colIndex) => {
                const td = document.createElement('td');
                td.textContent = cell;
                td.contentEditable = 'true';
                td.dataset.row = j;
                td.dataset.col = colIndex;
                const colName = headerRow[colIndex] || `Column ${colIndex}`;
                td.title = `Row: ${j}\nColumn: ${colName}`;
                td.addEventListener('blur', onCellChange);
                tr.appendChild(td);
            });
            fragment.appendChild(tr);
        }
        tbody.appendChild(fragment);

        // Yield to the main thread every chunk to keep UI responsive
        await new Promise(resolve => setTimeout(resolve, 0));
    }
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
    
    // Process only first 5000 lines max to prevent browser crash on huge files if force mode is on
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
        // Last field
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

    // Filter to get unique lines to avoid stacking markers
    const errorLines = [...new Set(errors.map(e => typeof e === 'string' ? -1 : e.line).filter(l => l !== -1))];
    
    errorLines.forEach(line => {
        const marker = document.createElement('div');
        marker.className = 'error-marker';
        const percentage = (line / totalLines) * 100;
        marker.style.top = percentage + '%';
        marker.title = 'Error on line ' + line;
        
        marker.onclick = (e) => {
            e.stopPropagation();
            const tableContainer = document.querySelector('.table-container');
            const rows = document.querySelectorAll('#csv-table tr');
            if (rows[line-1]) {
                rows[line-1].scrollIntoView({ behavior: 'smooth', block: 'center' });
                // Highlight the row temporarily
                const originalBg = rows[line-1].style.backgroundColor;
                rows[line-1].style.backgroundColor = 'var(--vscode-inputValidation-errorBackground)';
                setTimeout(() => {
                    rows[line-1].style.backgroundColor = originalBg;
                }, 2000);
            }
        };
        
        errorRuler.appendChild(marker);
    });
}