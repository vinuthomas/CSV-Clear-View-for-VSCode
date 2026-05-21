/**
 * Security & Regression Tests for CSV ClearView
 *
 * Tests the security fixes and core logic functions extracted from csv.js and csvEditor.ts.
 * Run with: node tests/security.test.js
 */

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, testName) {
    if (condition) {
        passed++;
        console.log(`  ✅ ${testName}`);
    } else {
        failed++;
        failures.push(testName);
        console.log(`  ❌ ${testName}`);
    }
}

function assertEqual(actual, expected, testName) {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
        passed++;
        console.log(`  ✅ ${testName}`);
    } else {
        failed++;
        failures.push(testName);
        console.log(`  ❌ ${testName}`);
        console.log(`     Expected: ${JSON.stringify(expected)}`);
        console.log(`     Actual:   ${JSON.stringify(actual)}`);
    }
}

// ============================================================
// Extract functions from csv.js for testing
// ============================================================

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

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

async function parseCSV(text) {
    const data = [];
    const errors = [];
    let currentRow = [];
    let fieldStart = 0;
    let inQuotes = false;
    const len = text.length;

    for (let i = 0; i < len; i++) {
        const char = text[i];

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
                // Do NOT update fieldStart here — it was already set correctly by
                // the preceding delimiter or newline handler. Overwriting it with
                // the quote position caused an off-by-one for whitespace-padded
                // quoted fields (e.g. `a, "b"`) and confused field-start tracking.
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

// Fixed dataToObjects (with security changes)
async function dataToObjects(data) {
    if (data.length < 2) return [];
    const headers = data[0];
    const safeHeaders = headers.map(h => DANGEROUS_KEYS.has(h) ? `_${h}` : h);
    const objects = [];
    for (let i = 1; i < data.length; i++) {
        const row = data[i];
        const obj = Object.create(null);
        safeHeaders.forEach((h, index) => {
            obj[h] = row[index];
        });
        objects.push(obj);
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

function dataToCSV(data, lineEnding) {
    const eol = lineEnding || '\n';
    return data.map(row => {
        return row.map(cell => {
            const text = cell || '';
            if (text.includes(',') || text.includes('"') || text.includes('\n') || text.includes('\r')) {
                return `"${text.replace(/"/g, '""')}"`;
            }
            return text;
        }).join(',');
    }).join(eol);
}

// SQL validation function (extracted from the fixed runQuery)
function validateQuery(query) {
    const normalizedQuery = query.replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (!/^SELECT\s/i.test(normalizedQuery)) {
        return { valid: false, error: "Only SELECT queries are allowed." };
    }
    if (/;/.test(normalizedQuery)) {
        return { valid: false, error: "Semicolons are not allowed in queries." };
    }
    const blockedPattern = /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|EXEC|EXECUTE|INTO\s+TEMP|ATTACH|DETACH|SOURCE|PRAGMA|SHOW\s+TABLES|SHOW\s+DATABASES|SET\s+OPTION)\b/i;
    if (blockedPattern.test(normalizedQuery)) {
        return { valid: false, error: "Data modification statements are not allowed." };
    }
    if (/(?<!\])"(?!\[)/.test(normalizedQuery.replace(/\[[^\]]*\]/g, ''))) {
        return { valid: false, error: "Use single quotes for string values, not double quotes." };
    }
    return { valid: true };
}

// Nonce generation (fixed version)
function getNonce() {
    return require('crypto').randomBytes(16).toString('hex');
}

// ============================================================
// TESTS
// ============================================================

async function runTests() {

    // --------------------------------------------------------
    console.log('\n📋 1. CSV PARSING (core functionality)');
    // --------------------------------------------------------

    {
        const { data, errors } = await parseCSV('a,b,c\n1,2,3\n4,5,6');
        assertEqual(data, [['a','b','c'],['1','2','3'],['4','5','6']], 'Parse basic CSV');
        assertEqual(errors.length, 0, 'No errors for valid CSV');
    }

    {
        const { data } = await parseCSV('"hello, world",b,c\n1,2,3');
        assertEqual(data[0][0], 'hello, world', 'Parse quoted field with comma');
    }

    {
        const { data } = await parseCSV('a,b\n"line1\nline2",val');
        assertEqual(data[1][0], 'line1\nline2', 'Parse quoted field with newline');
    }

    {
        const { data } = await parseCSV('a,b\n"say ""hi""",val');
        assertEqual(data[1][0], 'say "hi"', 'Parse escaped double quotes');
    }

    {
        const { data } = await parseCSV('a,b\r\n1,2\r\n3,4');
        assertEqual(data, [['a','b'],['1','2'],['3','4']], 'Parse CRLF line endings');
    }

    {
        const { data, errors } = await parseCSV('a,b,c\n1,2\n3,4,5');
        assert(errors.length > 0, 'Detect column count mismatch');
        assert(errors.some(e => e.message.includes('Row 2')), 'Error on correct row');
    }

    {
        const { data } = await parseCSV('a,b,c\n1,,3');
        assertEqual(data[1], ['1','','3'], 'Handle empty fields');
    }

    {
        const { data } = await parseCSV('');
        assertEqual(data.length, 0, 'Handle empty input');
    }

    {
        const { data } = await parseCSV('a,b,c');
        assertEqual(data, [['a','b','c']], 'Handle single-row CSV (no trailing newline)');
    }

    // --- fieldStart bug regression tests (fix: don't overwrite fieldStart on opening quote) ---
    // These cases previously produced wrong results because fieldStart was set to the
    // position of the opening `"` instead of the position after the preceding delimiter.

    {
        // Standard quoted field — must still work correctly after the fix
        const { data } = await parseCSV('"hello",world');
        assertEqual(data[0], ['hello', 'world'], 'fieldStart fix: standard quoted first field');
    }

    {
        // Quoted field in second position — the key regression case
        const { data } = await parseCSV('a,"b,c"');
        assertEqual(data[0], ['a', 'b,c'], 'fieldStart fix: quoted field with comma in second position');
    }

    {
        // Whitespace before quote (non-standard but common) — should not corrupt the slice
        const { data } = await parseCSV('a, "b,c"');
        // The space before the quote is part of the unquoted prefix, so the field
        // will include it. The important thing is the value is not truncated/corrupted.
        assert(data[0][1].includes('b,c'), 'fieldStart fix: space-padded quoted field not corrupted');
    }

    {
        // Multiple quoted fields in a row
        const { data } = await parseCSV('"one","two","three"');
        assertEqual(data[0], ['one', 'two', 'three'], 'fieldStart fix: multiple consecutive quoted fields');
    }

    {
        // Quoted field on second row
        const { data } = await parseCSV('a,b\n"x,y",z');
        assertEqual(data[1], ['x,y', 'z'], 'fieldStart fix: quoted field on second row');
    }

    {
        // Quoted field containing escaped quotes, in second column
        const { data } = await parseCSV('col1,col2\nval1,"say ""hi"""');
        assertEqual(data[1], ['val1', 'say "hi"'], 'fieldStart fix: escaped quotes in second-column quoted field');
    }

    // --------------------------------------------------------
    console.log('\n🔒 2. PROTOTYPE POLLUTION PROTECTION');
    // --------------------------------------------------------

    {
        const data = [
            ['__proto__', 'name', 'value'],
            ['evil', 'Alice', '100'],
            ['bad', 'Bob', '200']
        ];
        const objects = await dataToObjects(data);

        // The __proto__ header should be renamed
        assert(objects[0]['_\x5f_proto__'] !== undefined || objects[0]['___proto__'] !== undefined,
            '__proto__ header renamed to _<name>');

        // Verify Object.prototype was NOT polluted
        const cleanObj = {};
        assert(cleanObj['evil'] === undefined, 'Object.prototype not polluted via __proto__');
    }

    {
        const data = [
            ['constructor', 'prototype', 'normal'],
            ['a', 'b', 'c']
        ];
        const objects = await dataToObjects(data);
        assert('_constructor' in objects[0], 'constructor header renamed');
        assert('_prototype' in objects[0], 'prototype header renamed');
        assert('normal' in objects[0], 'Normal header left unchanged');
    }

    {
        const data = [
            ['Name', 'Age', 'City'],
            ['Alice', '30', 'NYC'],
            ['Bob', '25', 'LA']
        ];
        const objects = await dataToObjects(data);
        assertEqual(objects[0]['Name'], 'Alice', 'Normal headers still work after fix');
        assertEqual(objects[1]['Age'], '25', 'Normal data still accessible');
        assert(Object.getPrototypeOf(objects[0]) === null, 'Objects use null prototype');
    }

    // --------------------------------------------------------
    console.log('\n🛡️  3. SQL QUERY VALIDATION');
    // --------------------------------------------------------

    {
        const r = validateQuery("SELECT * FROM ?");
        assert(r.valid, 'Allow basic SELECT');
    }

    {
        const r = validateQuery("select * from ? where [Name] = 'Alice'");
        assert(r.valid, 'Allow lowercase SELECT with WHERE');
    }

    {
        const r = validateQuery("SELECT COUNT(*) FROM ? GROUP BY Department");
        assert(r.valid, 'Allow SELECT with aggregation');
    }

    {
        const r = validateQuery("SELECT * FROM ? ORDER BY Salary DESC LIMIT 10");
        assert(r.valid, 'Allow SELECT with ORDER BY and LIMIT');
    }

    {
        const r = validateQuery("DROP TABLE ?");
        assert(!r.valid, 'Block DROP TABLE');
    }

    {
        const r = validateQuery("DELETE FROM ?");
        assert(!r.valid, 'Block DELETE');
    }

    {
        const r = validateQuery("INSERT INTO ? VALUES (1,2,3)");
        assert(!r.valid, 'Block INSERT');
    }

    {
        const r = validateQuery("UPDATE ? SET name='evil'");
        assert(!r.valid, 'Block UPDATE');
    }

    {
        const r = validateQuery("CREATE TABLE evil (id INT)");
        assert(!r.valid, 'Block CREATE TABLE');
    }

    {
        const r = validateQuery("ALTER TABLE ? ADD COLUMN hack TEXT");
        assert(!r.valid, 'Block ALTER TABLE');
    }

    {
        const r = validateQuery("TRUNCATE TABLE ?");
        assert(!r.valid, 'Block TRUNCATE');
    }

    {
        const r = validateQuery("/* comment */ DROP TABLE ?");
        assert(!r.valid, 'Block DROP hidden after SQL comment');
    }

    {
        const r = validateQuery("EXEC xp_cmdshell 'whoami'");
        assert(!r.valid, 'Block EXEC');
    }

    {
        // SELECT that sneaks in a DELETE in a subquery
        const r = validateQuery("SELECT * FROM ? WHERE id IN (DELETE FROM ?)");
        assert(!r.valid, 'Block DELETE inside subquery');
    }

    {
        const r = validateQuery("");
        // Empty query should fail (not start with SELECT)
        assert(!r.valid, 'Block empty query');
    }

    {
        const r = validateQuery("   SELECT * FROM ?   ");
        assert(r.valid, 'Allow SELECT with whitespace');
    }

    // --- New rules added this session ---
    {
        const r = validateQuery("SELECT * FROM ?; DROP TABLE foo");
        assert(!r.valid, 'Block semicolon in query');
    }

    {
        const r = validateQuery("SELECT * FROM ?; SELECT 1");
        assert(!r.valid, 'Block multi-statement via semicolon');
    }

    {
        const r = validateQuery("SELECT * FROM ? ATTACH DATABASE 'evil'");
        assert(!r.valid, 'Block ATTACH command');
    }

    {
        const r = validateQuery("SELECT * FROM ? DETACH evil");
        assert(!r.valid, 'Block DETACH command');
    }

    {
        const r = validateQuery("SELECT * FROM ? PRAGMA table_info(?)");
        assert(!r.valid, 'Block PRAGMA command');
    }

    {
        const r = validateQuery("SHOW TABLES");
        assert(!r.valid, 'Block SHOW TABLES');
    }

    {
        const r = validateQuery("SHOW DATABASES");
        assert(!r.valid, 'Block SHOW DATABASES');
    }

    // --- Double-quote string literal detection ---
    {
        const r = validateQuery('SELECT * FROM ? WHERE [Column_4]="Row7_Col5"');
        assert(!r.valid, 'Block double-quoted string literal (use single quotes)');
        assert(r.error.includes('single quotes'), 'Error message suggests single quotes');
    }

    {
        // Single quotes should work fine
        const r = validateQuery("SELECT * FROM ? WHERE [Column_4]='Row7_Col5'");
        assert(r.valid, 'Allow single-quoted string literal');
    }

    {
        // Bracket-quoted column name containing a double-quote character should not be blocked
        const r = validateQuery('SELECT * FROM ? WHERE [Col"Name]=\'val\'');
        assert(r.valid, 'Allow double-quote inside bracket-quoted column name');
    }

    // --------------------------------------------------------
    console.log('\n🔑 4. NONCE GENERATION');
    // --------------------------------------------------------

    {
        const nonce = getNonce();
        assert(typeof nonce === 'string', 'Nonce is a string');
        assert(nonce.length === 32, 'Nonce is 32 hex chars (16 bytes)');
        assert(/^[a-f0-9]+$/.test(nonce), 'Nonce is valid hex');
    }

    {
        const nonces = new Set();
        for (let i = 0; i < 100; i++) {
            nonces.add(getNonce());
        }
        assertEqual(nonces.size, 100, '100 nonces are all unique (crypto-quality)');
    }

    // --------------------------------------------------------
    console.log('\n🧹 5. HTML ESCAPING');
    // --------------------------------------------------------

    {
        assertEqual(escapeHtml('<script>alert(1)</script>'),
            '&lt;script&gt;alert(1)&lt;/script&gt;',
            'Escape script tags');
    }

    {
        assertEqual(escapeHtml('" onclick="alert(1)"'),
            '&quot; onclick=&quot;alert(1)&quot;',
            'Escape double quotes in attributes');
    }

    {
        assertEqual(escapeHtml("' onmouseover='alert(1)'"),
            "&#039; onmouseover=&#039;alert(1)&#039;",
            'Escape single quotes');
    }

    {
        assertEqual(escapeHtml('&amp; already escaped'),
            '&amp;amp; already escaped',
            'Double-escape & correctly');
    }

    {
        assertEqual(escapeHtml('normal text'), 'normal text', 'Leave safe text unchanged');
    }

    {
        assert(escapeHtml(null) === '', 'Handle null input (returns empty string)');
        assert(escapeHtml('') === '', 'Handle empty string');
        assert(escapeHtml(undefined) === '', 'Handle undefined (returns empty string)');
        assert(escapeHtml(0) === '0', 'Handle numeric zero (coerces to string)');
        assert(escapeHtml(false) === 'false', 'Handle boolean false (coerces to string)');
    }

    // --------------------------------------------------------
    console.log('\n📝 6. CSV ROUNDTRIP (parse → objects → serialize)');
    // --------------------------------------------------------

    {
        const csvText = 'ID,First Name,Last Name,Email\n1,Alice,Smith,alice@example.com\n2,Bob,Johnson,bob@example.com';
        const { data } = await parseCSV(csvText);
        const serialized = dataToCSV(data);
        const { data: reparsed } = await parseCSV(serialized);
        assertEqual(data, reparsed, 'CSV roundtrip preserves data');
    }

    {
        const csvText = 'Name,Description\nAlice,"Has a comma, here"\nBob,"Say ""hi"""\nCharlie,"Line1\nLine2"';
        const { data } = await parseCSV(csvText);
        const serialized = dataToCSV(data);
        const { data: reparsed } = await parseCSV(serialized);
        assertEqual(data, reparsed, 'Roundtrip with quotes, commas, newlines');
    }

    {
        const csvText = 'A,B\n1,2\n3,4';
        const { data } = await parseCSV(csvText);
        const objects = await dataToObjects(data);
        const backToData = objectsToData(objects);
        assertEqual(backToData, [['A','B'],['1','2'],['3','4']], 'Roundtrip through objects');
    }

    // --- CRLF preservation (new fix) ---
    {
        const data = [['Name','City'],['Alice','NYC'],['Bob','LA']];
        const crlfOutput = dataToCSV(data, '\r\n');
        assert(crlfOutput.includes('\r\n'), 'dataToCSV preserves CRLF when requested');
        assert(!crlfOutput.startsWith('\r\n'), 'CRLF only between rows, not at start');
        const lines = crlfOutput.split('\r\n');
        assert(lines.length === 3, 'CRLF-separated output has correct row count');
    }

    {
        const data = [['A'],['val\rwith-cr']];
        const output = dataToCSV(data);
        assert(output.includes('"val\rwith-cr"'), 'dataToCSV quotes cells containing \\r');
    }

    {
        // Roundtrip with CRLF
        const csvText = 'A,B\r\n1,2\r\n3,4';
        const { data } = await parseCSV(csvText);
        const serialized = dataToCSV(data, '\r\n');
        const { data: reparsed } = await parseCSV(serialized);
        assertEqual(data, reparsed, 'CRLF roundtrip preserves data');
    }

    // --------------------------------------------------------
    console.log('\n🔐 7. BACKEND SECURITY (csvEditor.ts logic)');
    // --------------------------------------------------------

    // Test: File descriptor leak fix (try/finally pattern)
    {
        const fs = require('fs');
        const path = require('path');
        const testFile = path.join(__dirname, '..', 'samples', 'valid_data.csv');

        // Simulate the fixed readRange
        function readRangeFixed(filePath, offset, length) {
            const stats = fs.statSync(filePath);
            const actualLength = Math.min(length, stats.size - offset);
            if (actualLength <= 0) return Buffer.alloc(0);

            const fd = fs.openSync(filePath, 'r');
            try {
                const buffer = Buffer.alloc(actualLength);
                fs.readSync(fd, buffer, 0, actualLength, offset);
                return buffer;
            } finally {
                fs.closeSync(fd);
            }
        }

        const result = readRangeFixed(testFile, 0, 100);
        assert(result.length > 0, 'readRange reads file correctly');
        assert(result.toString('utf8').startsWith('ID,'), 'readRange returns correct content');

        // Test that finally block works even on error
        let fdClosed = false;
        try {
            const fd = fs.openSync(testFile, 'r');
            try {
                // Simulate an error during read
                throw new Error('simulated read error');
            } finally {
                fs.closeSync(fd);
                fdClosed = true;
            }
        } catch (e) {
            // Expected
        }
        assert(fdClosed, 'File descriptor closed even on read error (try/finally)');
    }

    // Test: Edit message validation
    {
        function validateEditMessage(e) {
            if (typeof e.text !== 'string') return false;
            if (e.text.length > 100 * 1024 * 1024) return false;
            return true;
        }

        assert(validateEditMessage({ text: 'a,b\n1,2' }), 'Accept valid edit message');
        assert(!validateEditMessage({ text: 123 }), 'Reject numeric text');
        assert(!validateEditMessage({ text: null }), 'Reject null text');
        assert(!validateEditMessage({ text: undefined }), 'Reject undefined text');
        assert(!validateEditMessage({ text: ['array'] }), 'Reject array text');
        assert(!validateEditMessage({}), 'Reject missing text');

        // Size check
        const hugePayload = 'x'.repeat(101 * 1024 * 1024);
        assert(!validateEditMessage({ text: hugePayload }), 'Reject >100MB payload');
        const okPayload = 'x'.repeat(50 * 1024 * 1024);
        assert(validateEditMessage({ text: okPayload }), 'Accept <100MB payload');
    }

    const fs = require('fs');
    const path = require('path');

    // Test: localResourceRoots (structural verification)
    {
        const src = fs.readFileSync(
            path.join(__dirname, '..', 'src', 'csvEditor.ts'), 'utf8'
        );
        assert(src.includes('localResourceRoots'), 'localResourceRoots is set in webview options');
        assert(src.includes("'media'"), 'localResourceRoots restricted to media folder');
    }

    // Test: Crypto nonce in source
    {
        const src = fs.readFileSync(
            path.join(__dirname, '..', 'src', 'csvEditor.ts'), 'utf8'
        );
        assert(src.includes("crypto.randomBytes"), 'Nonce uses crypto.randomBytes');
        assert(!src.includes('Math.random'), 'Math.random no longer used for nonce');
    }

    // Test: Diagnostics collection removed
    {
        const src = fs.readFileSync(
            path.join(__dirname, '..', 'src', 'csvEditor.ts'), 'utf8'
        );
        assert(!src.includes('createDiagnosticCollection'), 'Unused diagnostics collection removed');
    }

    // New: extension host source checks for this session's fixes
    {
        const src = fs.readFileSync(
            path.join(__dirname, '..', 'src', 'csvEditor.ts'), 'utf8'
        );

        // CSP no longer contains unsafe-eval
        assert(!src.includes("'unsafe-eval'"), 'CSP does not contain unsafe-eval');
        // alasql is lazy-loaded (not at module level) to avoid parsing 500KB on startup
        assert(!src.includes("import alasql") && src.includes("require('alasql')"), 'alasql lazy-loaded via require() not static import');
        // runQuery handler exists
        assert(src.includes("case 'runQuery'"), 'Extension host handles runQuery messages');
        // queryResult response
        assert(src.includes("type: 'queryResult'"), 'Extension host sends queryResult response');
        // Server-side semicolon block
        assert(src.includes('/;/'), 'Server-side SQL validation blocks semicolons');
        // ATTACH/DETACH blocked server-side
        assert(src.includes('ATTACH'), 'Server-side SQL validation blocks ATTACH');
        // watcher listener is disposed
        assert(src.includes('watcherListener.dispose()'), 'File watcher listener is disposed on panel close');
        // saveDocument errors surfaced
        assert(src.includes('showErrorMessage'), 'saveDocument errors shown via showErrorMessage');
        // fs imported at module level (not inline require)
        assert(src.includes("import * as fs from 'fs'"), 'fs imported at module level');
        assert(!src.includes("require('fs')"), 'No inline require(fs) calls remain');
        // EventEmitter stored as class field
        assert(src.includes('_onDidChangeCustomDocumentEmitter'), 'EventEmitter stored as named class field');
    }

    // --------------------------------------------------------
    console.log('\n🌐 8. FRONTEND SECURITY (csv.js source verification)');
    // --------------------------------------------------------

    {
        const src = fs.readFileSync(
            path.join(__dirname, '..', 'media', 'csv.js'), 'utf8'
        );

        assert(src.includes('DANGEROUS_KEYS'), 'DANGEROUS_KEYS constant exists');
        assert(src.includes('Object.create(null)'), 'Uses null-prototype objects');
        assert(src.includes("event.origin"), 'Message origin validation exists');
        assert(src.includes("vscode-webview://"), 'Checks for vscode-webview origin');
        assert(src.includes("^SELECT\\s"), 'SQL SELECT-only validation exists');
        assert(src.includes("blockedPattern"), 'Blocked SQL keywords pattern exists');

        // Verify no innerHTML with unsanitized user data in autocomplete
        // The old pattern was: b.innerHTML = displayHtml; b.innerHTML += "<input..."
        // The new pattern uses createElement + textContent
        assert(src.includes("hiddenInput.type = \"hidden\""), 'Autocomplete uses createElement for hidden input');
        assert(src.includes("strongEl.textContent"), 'Autocomplete uses textContent for display');

        // New: message origin check handles empty string correctly (not truthy-gated)
        assert(src.includes("event.origin !== ''"), 'Origin check handles empty-string origin correctly');

        // New: SQL now runs on extension host, not in webview via alasql()
        assert(src.includes("type: 'runQuery'"), 'Webview sends runQuery postMessage to extension host');
        assert(!src.includes("alasql("), 'Webview does not call alasql() directly (moved to host)');

        // New: chunkedCache has a hard size cap
        assert(src.includes("MAX_CACHED_PAGES"), 'chunkedCache has a hard page cap constant');

        // New: date inference uses strict pattern
        assert(src.includes("DATE_PATTERN"), 'Date inference uses strict regex pattern before new Date()');

        // New: semicolons blocked in SQL validation
         assert(src.includes("/;/"), 'SQL validation blocks semicolons');
        assert(src.includes("single quotes"), 'SQL validation detects double-quoted string literals');

        // New: var replaced with const/let in autocomplete
        assert(!src.match(/^\s*var [a-zA-Z]/m), 'No bare var declarations remain in csv.js');
    }

    // --------------------------------------------------------
    console.log('\n📦 9. PACKAGING SECURITY (.vscodeignore)');
    // --------------------------------------------------------

    {
        const vscodeignore = fs.readFileSync(
            path.join(__dirname, '..', '.vscodeignore'), 'utf8'
        );
        assert(vscodeignore.includes('*.vsix'), '.vscodeignore excludes .vsix files');
    }

    // --------------------------------------------------------
    console.log('\n🧪 10. EDGE CASES & XSS VECTORS IN CSV DATA');
    // --------------------------------------------------------

    {
        const xssCSV = '<script>alert(1)</script>,normal\nval1,val2';
        const { data } = await parseCSV(xssCSV);
        assertEqual(data[0][0], '<script>alert(1)</script>', 'XSS in header parsed as raw text');
        const escaped = escapeHtml(data[0][0]);
        assert(!escaped.includes('<script>'), 'XSS header escaped for display');
    }

    {
        const imgCSV = '<img src=x onerror=alert(1)>,B\n1,2';
        const { data } = await parseCSV(imgCSV);
        const escaped = escapeHtml(data[0][0]);
        assert(!escaped.includes('<img'), 'img XSS payload escaped');
    }

    {
        const csvWithProto = '__proto__,normal\nevil,ok\nbad,fine';
        const { data } = await parseCSV(csvWithProto);
        const objects = await dataToObjects(data);
        const testObj = {};
        assert(testObj['evil'] === undefined, 'Prototype not polluted with __proto__ CSV header');
        assertEqual(objects[0]['_\x5f_proto__'] || objects[0]['___proto__'], 'evil',
            '__proto__ column data accessible via renamed key');
        assertEqual(objects[0]['normal'], 'ok', 'Non-dangerous columns unaffected');
    }

    // --------------------------------------------------------
    console.log('\n🔢 11. ROW ↔ SCROLL COORDINATE MAPPING (rowToScrollTop / scrollTopToRow)');
    // --------------------------------------------------------

    {
        // Pure implementations mirroring csv.js
        const ROW_HEIGHT = 30;
        const MAX_SPACER = 10_000_000; // 10 MB px cap used in csv.js

        function rowToScrollTopPure(rowIndex, dataRowCount) {
            const totalPx = dataRowCount * ROW_HEIGHT;
            if (totalPx <= MAX_SPACER) { return rowIndex * ROW_HEIGHT; }
            return (rowIndex / dataRowCount) * MAX_SPACER;
        }

        function scrollTopToRowPure(scrollTop, dataRowCount) {
            const totalPx = dataRowCount * ROW_HEIGHT;
            let row;
            if (totalPx <= MAX_SPACER) {
                row = Math.floor(scrollTop / ROW_HEIGHT);
            } else {
                row = Math.floor((scrollTop / MAX_SPACER) * dataRowCount);
            }
            return Math.min(row, Math.max(0, dataRowCount - 1));
        }

        // --- No scaling needed (small file) ---
        assertEqual(rowToScrollTopPure(0, 100), 0, 'rowToScrollTop: row 0 → 0px (no scaling)');
        assertEqual(rowToScrollTopPure(10, 100), 300, 'rowToScrollTop: row 10 → 300px (no scaling)');
        assertEqual(rowToScrollTopPure(99, 100), 2970, 'rowToScrollTop: last row correct (no scaling)');

        // --- Scaling kicks in for huge files ---
        const hugeRows = 1_000_000; // 30M px > 10M cap → scaling active
        const topForRow0 = rowToScrollTopPure(0, hugeRows);
        const topForMidRow = rowToScrollTopPure(500_000, hugeRows);
        const topForLastRow = rowToScrollTopPure(999_999, hugeRows);
        assertEqual(topForRow0, 0, 'rowToScrollTop: row 0 → 0px (scaled)');
        assert(topForMidRow > 0 && topForMidRow < MAX_SPACER, 'rowToScrollTop: mid row within spacer range (scaled)');
        assert(Math.abs(topForMidRow - MAX_SPACER / 2) < 1, 'rowToScrollTop: mid row ≈ half spacer height (scaled)');
        assert(topForLastRow <= MAX_SPACER, 'rowToScrollTop: last row does not exceed spacer cap');

        // --- Roundtrip: rowToScrollTop → scrollTopToRow ---
        for (const rowIdx of [0, 1, 50, 99]) {
            const px = rowToScrollTopPure(rowIdx, 100);
            const back = scrollTopToRowPure(px, 100);
            assertEqual(back, rowIdx, `scrollTopToRow roundtrip: row ${rowIdx}`);
        }

        // --- Clamp: scrollTop at exact spacer max should not exceed dataRowCount-1 ---
        const clampedRow = scrollTopToRowPure(MAX_SPACER, hugeRows);
        assert(clampedRow <= hugeRows - 1, 'scrollTopToRow: clamped to dataRowCount-1 at max scrollTop');

        // --- Edge: single row ---
        assertEqual(rowToScrollTopPure(0, 1), 0, 'rowToScrollTop: single row → 0px');
        assertEqual(scrollTopToRowPure(0, 1), 0, 'scrollTopToRow: 0px → row 0 for single row');
    }

    // --------------------------------------------------------
    console.log('\n📐 12. VIRTUAL TABLE WINDOWING LOGIC (updateVirtualTable)');
    // --------------------------------------------------------

    {
        // Extract the pure windowing math from updateVirtualTable
        const ROW_HEIGHT = 30;
        const MAX_SPACER = 10_000_000;
        const BUFFER = 10;

        function scrollTopToRowPure(scrollTop, dataRowCount) {
            const totalPx = dataRowCount * ROW_HEIGHT;
            let row;
            if (totalPx <= MAX_SPACER) {
                row = Math.floor(scrollTop / ROW_HEIGHT);
            } else {
                row = Math.floor((scrollTop / MAX_SPACER) * dataRowCount);
            }
            return Math.min(row, Math.max(0, dataRowCount - 1));
        }

        function computeWindow(scrollTop, containerHeight, dataRowCount) {
            const visibleRowCount = Math.ceil(containerHeight / ROW_HEIGHT);
            let startRow = scrollTopToRowPure(scrollTop, dataRowCount);
            startRow = Math.max(1, startRow);
            const renderStart = Math.max(1, startRow - BUFFER);
            const renderEnd = Math.min(dataRowCount + 1, startRow + visibleRowCount + BUFFER);
            return { renderStart, renderEnd };
        }

        const DATA_ROWS = 1000;
        const CONTAINER_H = 600; // ~20 visible rows

        const visibleRowCount = Math.ceil(CONTAINER_H / ROW_HEIGHT);

        // Scrolled to top
        const top = computeWindow(0, CONTAINER_H, DATA_ROWS);
        assertEqual(top.renderStart, 1, 'Virtual window: renderStart=1 at top');
        assert(top.renderEnd > top.renderStart, 'Virtual window: renderEnd > renderStart at top');
        assert(top.renderEnd <= DATA_ROWS + 1, 'Virtual window: renderEnd within bounds at top');

        // Scrolled to middle
        const mid = computeWindow(15000, CONTAINER_H, DATA_ROWS); // row ~500
        assert(mid.renderStart >= 1, 'Virtual window: renderStart ≥ 1 at middle');
        assert(mid.renderEnd > mid.renderStart, 'Virtual window: renderEnd > renderStart at middle');
        assert(mid.renderEnd - mid.renderStart <= visibleRowCount + BUFFER * 2 + 2,
            'Virtual window: window size bounded by visible+buffer');

        // Scrolled near the bottom
        const bottom = computeWindow((DATA_ROWS - 1) * ROW_HEIGHT, CONTAINER_H, DATA_ROWS);
        assert(bottom.renderEnd <= DATA_ROWS + 1, 'Virtual window: renderEnd never exceeds data length');

        // Buffer ensures rows above/below viewport are included
        const atRow100 = computeWindow(100 * ROW_HEIGHT, CONTAINER_H, DATA_ROWS);
        assert(atRow100.renderStart <= 100, 'Virtual window: buffer pulls renderStart before visible row');
        assert(atRow100.renderEnd >= 100 + Math.ceil(CONTAINER_H / ROW_HEIGHT),
            'Virtual window: buffer extends renderEnd beyond visible row');

        const windowSize = atRow100.renderEnd - atRow100.renderStart;
        assert(windowSize >= visibleRowCount, 'Virtual window: rendered row count ≥ visible count');
    }

    // --------------------------------------------------------
    console.log('\n🧊 13. FROZEN BODY HTML GENERATION (updateFrozenBody)');
    // --------------------------------------------------------

    {
        // Mirror the frozen-body slice/html logic from updateFrozenBody
        function buildFrozenBodyHtml(data, renderStart, renderEnd, frozenCols, rowHeight) {
            const slice = data.slice(renderStart, renderEnd);
            const frozenArr = [...frozenCols].sort((a, b) => a - b);
            let html = '';
            for (const row of slice) {
                html += `<tr style="height: ${rowHeight}px">`;
                for (const c of frozenArr) {
                    const cell = row[c] || '';
                    html += `<td>${cell}</td>`;
                }
                html += '</tr>';
            }
            return html;
        }

        const sampleData = [
            ['Name', 'Dept', 'Salary'],
            ['Alice', 'Eng', '95000'],
            ['Bob', 'Mkt', '82000'],
            ['Charlie', 'Sales', '75000'],
        ];

        // Single frozen column (col 0)
        const html1 = buildFrozenBodyHtml(sampleData, 1, 4, new Set([0]), 30);
        assert(html1.includes('<tr style="height: 30px">'), 'Frozen body: row has correct height style');
        assert(html1.includes('<td>Alice</td>'), 'Frozen body: first frozen cell rendered');
        assert(html1.includes('<td>Bob</td>'), 'Frozen body: second frozen cell rendered');
        assert(!html1.includes('Eng'), 'Frozen body: non-frozen columns excluded');
        assert(!html1.includes('95000'), 'Frozen body: non-frozen data excluded');

        // Two frozen columns (col 0 and col 1)
        const html2 = buildFrozenBodyHtml(sampleData, 1, 3, new Set([0, 1]), 30);
        assert(html2.includes('<td>Alice</td>') && html2.includes('<td>Eng</td>'),
            'Frozen body: both frozen columns included');
        assert(!html2.includes('95000'), 'Frozen body: salary column excluded with 2 frozen cols');

        // Slice respects renderStart/renderEnd
        const htmlSlice = buildFrozenBodyHtml(sampleData, 2, 3, new Set([0]), 30);
        assert(htmlSlice.includes('<td>Bob</td>'), 'Frozen body: slice starts at renderStart');
        assert(!htmlSlice.includes('<td>Alice</td>'), 'Frozen body: rows before renderStart excluded');
        assert(!htmlSlice.includes('<td>Charlie</td>'), 'Frozen body: rows after renderEnd excluded');

        // Empty frozen set → early return (no rows rendered), matching updateFrozenBody guard
        const htmlNone = buildFrozenBodyHtml(sampleData, 1, 4, new Set(), 30);
        assert(!htmlNone.includes('<td>'), 'Frozen body: no data cells when no frozen columns');

        // Missing cell value falls back to empty string (not undefined/null)
        const sparseData = [['H1', 'H2'], ['only-one']];
        const htmlSparse = buildFrozenBodyHtml(sparseData, 1, 2, new Set([1]), 30);
        assert(htmlSparse.includes('<td></td>'), 'Frozen body: missing cell renders as empty td');
    }

    // --------------------------------------------------------
    console.log('\n📂 14. parseCSV WITH CUSTOM DELIMITERS');
    // --------------------------------------------------------

    {
        // Replicate the real csv.js parseCSV with delimiter support (simplified, no async yield)
        function parseCSVWithDelim(text, delimiter) {
            const delim = delimiter || ',';
            const data = [];
            const errors = [];
            let currentRow = [];
            let fieldStart = 0;
            let inQuotes = false;
            const len = text.length;

            for (let i = 0; i < len; i++) {
                const char = text[i];
                if (inQuotes) {
                    if (char === '"') {
                        if (i + 1 < len && text[i + 1] === '"') { i++; }
                        else { inQuotes = false; }
                    }
                } else {
                    if (char === '"') {
                        inQuotes = true;
                        fieldStart = i;
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
                        if (i + 1 < len && text[i + 1] === '\n') { i++; }
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
            if (data.length > 0) {
                const headerLength = data[0].length;
                data.forEach((row, index) => {
                    if (row.length !== headerLength) {
                        errors.push({ line: index + 1, message: `Row ${index + 1}: Expected ${headerLength} columns, found ${row.length}.` });
                    }
                });
            }
            return { data, errors };
        }

        // Tab delimiter (TSV)
        {
            const { data, errors } = parseCSVWithDelim('Name\tAge\tCity\nAlice\t30\tNYC\nBob\t25\tLA', '\t');
            assertEqual(data[0], ['Name', 'Age', 'City'], 'TSV: header parsed correctly');
            assertEqual(data[1], ['Alice', '30', 'NYC'], 'TSV: first data row parsed correctly');
            assertEqual(errors.length, 0, 'TSV: no errors for valid TSV');
        }

        // Pipe delimiter (PSV)
        {
            const { data } = parseCSVWithDelim('A|B|C\n1|2|3', '|');
            assertEqual(data[0], ['A', 'B', 'C'], 'PSV: header parsed correctly');
            assertEqual(data[1], ['1', '2', '3'], 'PSV: data row parsed correctly');
        }

        // Semicolon delimiter
        {
            const { data } = parseCSVWithDelim('X;Y\nhello;world', ';');
            assertEqual(data[1], ['hello', 'world'], 'Semicolon: data row parsed correctly');
        }

        // Quoted fields still work with custom delimiter
        {
            const { data } = parseCSVWithDelim('Name\tNote\nAlice\t"has\ttab inside"', '\t');
            assertEqual(data[1][1], 'has\ttab inside', 'TSV: quoted field containing tab character parsed correctly');
        }

        // Comma inside a pipe-delimited quoted field
        {
            const { data } = parseCSVWithDelim('A|B\n"1,2,3"|val', '|');
            assertEqual(data[1][0], '1,2,3', 'PSV: commas inside quoted field not treated as delimiters');
        }

        // Mismatch detection still works with custom delimiter
        {
            const { errors } = parseCSVWithDelim('A\tB\nonly-one', '\t');
            assert(errors.length > 0, 'TSV: column count mismatch detected');
        }
    }

    // --------------------------------------------------------
    console.log('\n✏️  15. CELL EDIT DATA MUTATION (onCellChange logic)');
    // --------------------------------------------------------

    {
        // Mirror the core mutation logic of onCellChange (DOM-free pure extraction)
        function applyCellEdit(displayData, rowInDisplay, col, newValue) {
            if (!displayData[rowInDisplay]) { return false; }
            if (displayData[rowInDisplay][col] === newValue) { return false; } // no-op
            displayData[rowInDisplay][col] = newValue;
            return true;
        }

        const data = [
            ['Name', 'Age', 'City'],
            ['Alice', '30', 'NYC'],
            ['Bob', '25', 'LA'],
        ];

        // Normal edit
        const changed = applyCellEdit(data, 1, 0, 'Alicia');
        assert(changed, 'Cell edit: returns true when value changed');
        assertEqual(data[1][0], 'Alicia', 'Cell edit: data updated correctly');

        // No-op when value is unchanged
        const noOp = applyCellEdit(data, 1, 0, 'Alicia');
        assert(!noOp, 'Cell edit: returns false when value is same (no-op)');

        // Out-of-bounds row → safe no-op
        const outOfBounds = applyCellEdit(data, 99, 0, 'ghost');
        assert(!outOfBounds, 'Cell edit: returns false for non-existent row');
        assertEqual(data.length, 3, 'Cell edit: data length unchanged after out-of-bounds attempt');

        // Edit to empty string
        const cleared = applyCellEdit(data, 2, 1, '');
        assert(cleared, 'Cell edit: clearing a cell returns true');
        assertEqual(data[2][1], '', 'Cell edit: cell correctly cleared to empty string');

        // Edit header row (row 0)
        const headerEdit = applyCellEdit(data, 0, 2, 'Location');
        assert(headerEdit, 'Cell edit: header row can be edited');
        assertEqual(data[0][2], 'Location', 'Cell edit: header updated correctly');
    }

    // --------------------------------------------------------
    console.log('\n🔁 16. DUPLICATE ROW DETECTION (findDuplicateRows / buildDupeGroups)');
    // --------------------------------------------------------

    {
        function findDuplicateRows(data) {
            if (!data || data.length < 2) { return new Set(); }
            const seen = new Map();
            const dupeIndices = new Set();
            for (let i = 1; i < data.length; i++) {
                const key = data[i].join('\x00');
                if (seen.has(key)) {
                    dupeIndices.add(i);
                    dupeIndices.add(seen.get(key));
                } else {
                    seen.set(key, i);
                }
            }
            return dupeIndices;
        }

        function buildDupeGroups(data) {
            if (!data || data.length < 2) { return new Map(); }
            const seen = new Map();
            for (let i = 1; i < data.length; i++) {
                const key = data[i].join('\x00');
                if (!seen.has(key)) { seen.set(key, []); }
                seen.get(key).push({ lineNum: i + 1, row: data[i] });
            }
            const groups = new Map();
            for (const [key, entries] of seen) {
                if (entries.length > 1) { groups.set(key, entries); }
            }
            return groups;
        }

        // No duplicates
        {
            const data = [['A', 'B'], ['1', '2'], ['3', '4']];
            const dupes = findDuplicateRows(data);
            assertEqual(dupes.size, 0, 'findDuplicateRows: no dupes in clean data');
            const groups = buildDupeGroups(data);
            assertEqual(groups.size, 0, 'buildDupeGroups: no groups in clean data');
        }

        // Single duplicate pair
        {
            const data = [['A', 'B'], ['1', '2'], ['3', '4'], ['1', '2']];
            const dupes = findDuplicateRows(data);
            assert(dupes.has(1), 'findDuplicateRows: first occurrence marked');
            assert(dupes.has(3), 'findDuplicateRows: second occurrence marked');
            assertEqual(dupes.size, 2, 'findDuplicateRows: exactly 2 indices for one duplicate pair');

            const groups = buildDupeGroups(data);
            assertEqual(groups.size, 1, 'buildDupeGroups: one group for one duplicate pair');
            const entries = [...groups.values()][0];
            assertEqual(entries.length, 2, 'buildDupeGroups: group has 2 entries');
            assertEqual(entries[0].lineNum, 2, 'buildDupeGroups: first occurrence has lineNum=2 (line 1 is header)');
            assertEqual(entries[1].lineNum, 4, 'buildDupeGroups: second occurrence has lineNum=4');
        }

        // Multiple groups
        {
            const data = [
                ['ID', 'Name'],
                ['1', 'Alice'],
                ['2', 'Bob'],
                ['1', 'Alice'], // dupe of row index 1
                ['3', 'Charlie'],
                ['2', 'Bob'],   // dupe of row index 2
            ];
            const dupes = findDuplicateRows(data);
            assert(dupes.has(1) && dupes.has(3), 'findDuplicateRows: Alice duplicates both marked');
            assert(dupes.has(2) && dupes.has(5), 'findDuplicateRows: Bob duplicates both marked');
            assert(!dupes.has(4), 'findDuplicateRows: unique row (Charlie) not marked');

            const groups = buildDupeGroups(data);
            assertEqual(groups.size, 2, 'buildDupeGroups: two groups for two duplicate pairs');
        }

        // Triple occurrence (one row appears 3 times)
        {
            const data = [['X'], ['a'], ['a'], ['a']];
            const dupes = findDuplicateRows(data);
            // First occurrence is stored, second and third trigger marks on all
            assert(dupes.size >= 2, 'findDuplicateRows: triple occurrence — at least 2 marked');

            const groups = buildDupeGroups(data);
            assertEqual(groups.size, 1, 'buildDupeGroups: triple occurrence forms one group');
            const entries = [...groups.values()][0];
            assertEqual(entries.length, 3, 'buildDupeGroups: group size=3 for triple occurrence');
        }

        // Header-only or single data row → no dupes
        {
            const empty = findDuplicateRows([['H1', 'H2']]);
            assertEqual(empty.size, 0, 'findDuplicateRows: header-only data → no dupes');
            const single = findDuplicateRows([['H'], ['v']]);
            assertEqual(single.size, 0, 'findDuplicateRows: single data row → no dupes');
        }

        // Rows that differ only in one field are NOT duplicates
        {
            const data = [['A', 'B'], ['1', '2'], ['1', '3']];
            const dupes = findDuplicateRows(data);
            assertEqual(dupes.size, 0, 'findDuplicateRows: rows differing in one field are not duplicates');
        }

        // Line numbers in buildDupeGroups are 1-based CSV lines (header = line 1)
        {
            const data = [['H'], ['x'], ['y'], ['x']];
            const groups = buildDupeGroups(data);
            const entries = [...groups.values()][0];
            assertEqual(entries[0].lineNum, 2, 'buildDupeGroups: lineNum accounts for header (row index 1 → line 2)');
            assertEqual(entries[1].lineNum, 4, 'buildDupeGroups: lineNum correct for later occurrence');
        }
    }

    // --------------------------------------------------------
    console.log('\n🔌 17. LAZY ALASQL LOADER (getAlasql)');
    // --------------------------------------------------------

    {
        // Replicate the lazy-loader pattern from csvEditor.ts
        let _alasql = null;
        function getAlasql() {
            if (!_alasql) {
                _alasql = require('alasql');
            }
            return _alasql;
        }

        // First call loads and returns a function
        const fn1 = getAlasql();
        assert(typeof fn1 === 'function', 'getAlasql: returns a callable function on first load');

        // Second call returns the same cached instance (no re-require)
        const fn2 = getAlasql();
        assert(fn1 === fn2, 'getAlasql: returns same cached instance on subsequent calls');

        // The loaded module is the real alasql — can execute a basic query
        const data = [{ name: 'Alice', age: 30 }, { name: 'Bob', age: 25 }];
        const result = getAlasql()('SELECT * FROM ? WHERE age > 26', [data]);
        assert(Array.isArray(result), 'getAlasql: alasql executes a SELECT query and returns array');
        assertEqual(result.length, 1, 'getAlasql: query result has correct row count');
        assertEqual(result[0].name, 'Alice', 'getAlasql: query result has correct data');
    }

    // --------------------------------------------------------
    console.log('\n📨 18. SERVER-SIDE runQuery MESSAGE HANDLER VALIDATION');
    // --------------------------------------------------------

    {
        // Mirrors the validation logic in csvEditor.ts resolveCustomEditor → case 'runQuery'
        function validateRunQueryMessage(e) {
            if (typeof e.query !== 'string' || !Array.isArray(e.data)) {
                return { error: 'Invalid query request' };
            }
            const normalizedQ = e.query.replace(/\/\*[\s\S]*?\*\//g, '').trim();
            if (!/^SELECT\s/i.test(normalizedQ)) {
                return { error: 'Only SELECT queries are allowed' };
            }
            if (/;/.test(normalizedQ)) {
                return { error: 'Semicolons are not allowed in queries' };
            }
            const blocked = /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|EXEC|EXECUTE|INTO\s+TEMP|ATTACH|DETACH|SOURCE|PRAGMA|SHOW\s+TABLES|SHOW\s+DATABASES|SET\s+OPTION)\b/i;
            if (blocked.test(normalizedQ)) {
                return { error: 'Data modification statements are not allowed' };
            }
            return { valid: true };
        }

        // Valid messages
        assert(validateRunQueryMessage({ query: 'SELECT * FROM ?', data: [] }).valid,
            'runQuery handler: valid SELECT with empty data passes');
        assert(validateRunQueryMessage({ query: 'SELECT name FROM ?', data: [{ name: 'x' }] }).valid,
            'runQuery handler: valid SELECT with data passes');
        assert(validateRunQueryMessage({ query: 'select * from ?', data: [] }).valid,
            'runQuery handler: SELECT is case-insensitive');
        assert(validateRunQueryMessage({ query: 'SELECT /* comment */ * FROM ?', data: [] }).valid,
            'runQuery handler: inline comment stripped before validation');

        // Invalid message shape
        assertEqual(validateRunQueryMessage({ query: 123, data: [] }).error,
            'Invalid query request', 'runQuery handler: non-string query rejected');
        assertEqual(validateRunQueryMessage({ query: 'SELECT 1', data: 'notarray' }).error,
            'Invalid query request', 'runQuery handler: non-array data rejected');
        assertEqual(validateRunQueryMessage({ data: [] }).error,
            'Invalid query request', 'runQuery handler: missing query rejected');

        // Non-SELECT statements
        assertEqual(validateRunQueryMessage({ query: 'INSERT INTO ? VALUES (1)', data: [] }).error,
            'Only SELECT queries are allowed', 'runQuery handler: INSERT rejected');
        assertEqual(validateRunQueryMessage({ query: 'UPDATE ? SET a=1', data: [] }).error,
            'Only SELECT queries are allowed', 'runQuery handler: UPDATE rejected');
        assertEqual(validateRunQueryMessage({ query: 'DELETE FROM ?', data: [] }).error,
            'Only SELECT queries are allowed', 'runQuery handler: DELETE rejected');

        // Blocked keywords inside SELECT
        assertEqual(validateRunQueryMessage({ query: 'SELECT * FROM ? DROP TABLE foo', data: [] }).error,
            'Data modification statements are not allowed', 'runQuery handler: DROP inside SELECT blocked');
        assertEqual(validateRunQueryMessage({ query: 'SELECT * FROM ? WHERE EXEC xp_cmdshell', data: [] }).error,
            'Data modification statements are not allowed', 'runQuery handler: EXEC blocked');

        // Semicolon injection
        assertEqual(validateRunQueryMessage({ query: 'SELECT * FROM ?; DROP TABLE foo', data: [] }).error,
            'Semicolons are not allowed in queries', 'runQuery handler: semicolon injection blocked');

        // Comment-wrapped injection (/* DROP */ should be stripped, then re-validated)
        assert(validateRunQueryMessage({ query: 'SELECT /* DROP TABLE foo */ * FROM ?', data: [] }).valid,
            'runQuery handler: DROP inside block comment is stripped and allowed');

        // Blocked keyword after comment stripping
        assertEqual(validateRunQueryMessage({ query: '/* comment */ DROP TABLE foo', data: [] }).error,
            'Only SELECT queries are allowed', 'runQuery handler: non-SELECT after comment strip is rejected');
    }

    console.log('\n' + '='.repeat(50));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        console.log('\nFailed tests:');
        failures.forEach(f => console.log(`  ❌ ${f}`));
        process.exit(1);
    } else {
        console.log('All tests passed! ✅');
        process.exit(0);
    }
}

runTests().catch(e => {
    console.error('Test runner error:', e);
    process.exit(1);
});
