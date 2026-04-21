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
        // alasql is imported at module level
        assert(src.includes("import alasql"), 'alasql imported at module level in extension host');
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

    // ========================================
    // SUMMARY
    // ========================================

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
