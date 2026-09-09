/**
 * Multi-character & regex delimiter tests for CSV ClearView
 *
 * Covers the sentinel-rewrite pre-pass that lets the single-character fast
 * parser in csv.js handle multi-char and regex delimiters, plus the guards that
 * keep a user-supplied pattern from hanging on a 500MB file.
 *
 * Run with: node tests/delimiter.test.js
 */

const fs = require('fs');
const path = require('path');

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
// Functions mirrored from media/csv.js
// (csv.js touches `document` at load time, so it cannot be required here.
//  The source-parity checks at the end guard against these drifting.)
// ============================================================

const DELIM_SENTINELS = ['\u0000', '\u0001', '\u0002', '\u0003', '\u0004', '\u0005', '\u0006', '\u0007', '\u0008'];
const MAX_DELIMITER_LENGTH = 64;

function pickDelimiterSentinel(text) {
    for (const c of DELIM_SENTINELS) {
        if (text.indexOf(c) === -1) { return c; }
    }
    return null;
}

function compileDelimiterRegex(pattern) {
    if (!pattern) { return { error: 'Pattern is empty.' }; }
    if (pattern.length > MAX_DELIMITER_LENGTH) {
        return { error: 'Pattern is too long (max ' + MAX_DELIMITER_LENGTH + ' characters).' };
    }
    if (/\([^)]*[+*][^)]*\)\s*[+*{]/.test(pattern) || /\[[^\]]*\][+*]\s*[+*]/.test(pattern)) {
        return { error: 'Nested quantifiers are not allowed — they can hang on large files.' };
    }
    let re;
    try {
        re = new RegExp(pattern, 'g');
    } catch (e) {
        return { error: 'Invalid regular expression: ' + e.message };
    }
    if (new RegExp(pattern, 'g').test('')) { return { error: 'Pattern must not match an empty string.' }; }
    const probe = new RegExp(pattern, 'g').exec('abc');
    if (probe && probe[0] === '') { return { error: 'Pattern must not match an empty string.' }; }
    return { re };
}

function replaceDelimiterOutsideQuotes(text, matcher, sentinel) {
    const len = text.length;
    const parts = [];
    let copiedTo = 0;
    let scan = 0;
    let inQuotes = false;
    let pos = 0;

    const find = matcher.literal
        ? (from) => {
            const idx = text.indexOf(matcher.literal, from);
            return idx === -1 ? null : { index: idx, length: matcher.literal.length };
        }
        : (from) => {
            matcher.re.lastIndex = from;
            const m = matcher.re.exec(text);
            return m ? { index: m.index, length: m[0].length } : null;
        };

    while (pos < len) {
        const m = find(pos);
        if (!m) { break; }
        while (scan < m.index) {
            if (text.charCodeAt(scan) === 34) { inQuotes = !inQuotes; }
            scan++;
        }
        if (inQuotes) {
            pos = m.index + Math.max(1, m.length);
            continue;
        }
        let matchLen = m.length;
        if (matcher.re) {
            const matched = text.substr(m.index, m.length);
            const nl = matched.search(/[\r\n]/);
            if (nl === 0) { pos = m.index + 1; continue; }
            if (nl > 0) { matchLen = nl; }
        }
        parts.push(text.slice(copiedTo, m.index), sentinel);
        copiedTo = m.index + matchLen;
        while (scan < copiedTo) {
            if (text.charCodeAt(scan) === 34) { inQuotes = !inQuotes; }
            scan++;
        }
        pos = copiedTo;
    }
    parts.push(text.slice(copiedTo));
    return parts.join('');
}

function normalizeForFastParse(text, delim, isRegex) {
    if (!isRegex && delim.length === 1) { return { text: text, delim: delim }; }
    const sentinel = pickDelimiterSentinel(text);
    if (!sentinel) {
        return { error: 'This file already uses every available control character, so a multi-character delimiter cannot be applied to it.' };
    }
    let matcher;
    if (isRegex) {
        const compiled = compileDelimiterRegex(delim);
        if (compiled.error) { return { error: compiled.error }; }
        matcher = { re: compiled.re };
    } else {
        matcher = { literal: delim };
    }
    return { text: replaceDelimiterOutsideQuotes(text, matcher, sentinel), delim: sentinel };
}

// The single-character fast parser, unchanged from csv.js, plus the normalize
// pre-pass that parseCSV() now runs ahead of it.
async function parseCSV(text, delimiter, isRegex) {
    let delim = delimiter || ',';
    if (isRegex || delim.length > 1) {
        const normalized = normalizeForFastParse(text, delim, isRegex);
        if (normalized.error) {
            return { data: [], errors: [{ line: 1, message: normalized.error }] };
        }
        text = normalized.text;
        delim = normalized.delim;
    }

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
                if (i + 1 < len && text[i + 1] === '"') { i++; } else { inQuotes = false; }
            }
        } else {
            if (char === '"') {
                inQuotes = true;
            } else if (char === delim) {
                let field = text.slice(fieldStart, i);
                if (field.startsWith('"') && field.endsWith('"')) { field = field.slice(1, -1).replace(/""/g, '"'); }
                currentRow.push(field);
                fieldStart = i + 1;
            } else if (char === '\n') {
                let field = text.slice(fieldStart, i);
                if (field.startsWith('"') && field.endsWith('"')) { field = field.slice(1, -1).replace(/""/g, '"'); }
                currentRow.push(field);
                data.push(currentRow);
                currentRow = [];
                fieldStart = i + 1;
            } else if (char === '\r') {
                let field = text.slice(fieldStart, i);
                if (field.startsWith('"') && field.endsWith('"')) { field = field.slice(1, -1).replace(/""/g, '"'); }
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
        if (field.startsWith('"') && field.endsWith('"')) { field = field.slice(1, -1).replace(/""/g, '"'); }
        currentRow.push(field);
        data.push(currentRow);
    }

    return { data, errors };
}

function dataToCSV(data, delimiter) {
    const delim = delimiter || ',';
    return data.map(row => row.map(cell => {
        const text = cell || '';
        if (text.includes(delim) || text.includes('"') || text.includes('\n') || text.includes('\r')) {
            return `"${text.replace(/"/g, '""')}"`;
        }
        return text;
    }).join(delim)).join('\n');
}

// Mirrored from src/csvEditor.ts — the savedDelimiters setting is user-editable
// JSON, so it cannot be trusted to match the contributed schema.
const MAX_SAVED_DELIMITERS = 50;
const MAX_DELIMITER_NAME_LENGTH = 40;
const MAX_DELIMITER_VALUE_LENGTH = 64;

function readSavedDelimiters(raw) {
    if (!Array.isArray(raw)) { return []; }
    const out = [];
    const seen = new Set();
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') { continue; }
        const name = typeof entry.name === 'string' ? entry.name.trim() : '';
        const value = typeof entry.value === 'string' ? entry.value : '';
        if (!name || !value) { continue; }
        if (name.length > MAX_DELIMITER_NAME_LENGTH || value.length > MAX_DELIMITER_VALUE_LENGTH) { continue; }
        const key = name.toLowerCase();
        if (seen.has(key)) { continue; }
        const isRegex = entry.isRegex === true;
        if (isRegex) {
            try { new RegExp(value); } catch { continue; }
        }
        seen.add(key);
        out.push({ name, value, isRegex });
        if (out.length >= MAX_SAVED_DELIMITERS) { break; }
    }
    return out;
}

// ============================================================

async function runTests() {
    console.log('\n1. Single-character delimiters take the untouched fast path');

    const single = await parseCSV('a,b,c\n1,2,3', ',', false);
    assertEqual(single.data, [['a', 'b', 'c'], ['1', '2', '3']], 'Comma parsing is unchanged');

    const quotedSingle = await parseCSV('a,"b,c",d', ',', false);
    assertEqual(quotedSingle.data, [['a', 'b,c', 'd']], 'Quoted comma still protected on the fast path');

    const tabbed = await parseCSV('a\tb\n1\t2', '\t', false);
    assertEqual(tabbed.data, [['a', 'b'], ['1', '2']], 'Tab parsing is unchanged');

    console.log('\n2. Multi-character delimiters');

    const pipes = await parseCSV('a||b||c\n1||2||3', '||', false);
    assertEqual(pipes.data, [['a', 'b', 'c'], ['1', '2', '3']], 'Double-pipe splits into three columns');

    const colons = await parseCSV('name::age::city\nada::36::london', '::', false);
    assertEqual(colons.data, [['name', 'age', 'city'], ['ada', '36', 'london']], 'Double-colon delimiter');

    const longDelim = await parseCSV('a<SEP>b<SEP>c', '<SEP>', false);
    assertEqual(longDelim.data, [['a', 'b', 'c']], 'Multi-character word delimiter');

    // A single `|` inside a field must not split when the delimiter is `||`.
    const partial = await parseCSV('a||b|c||d', '||', false);
    assertEqual(partial.data, [['a', 'b|c', 'd']], 'A partial delimiter match does not split');

    const quotedMulti = await parseCSV('a||"b||c"||d', '||', false);
    assertEqual(quotedMulti.data, [['a', 'b||c', 'd']], 'Delimiter inside a quoted field is preserved');

    const emptyFields = await parseCSV('a||||c', '||', false);
    assertEqual(emptyFields.data, [['a', '', 'c']], 'Consecutive delimiters produce an empty field');

    const crlf = await parseCSV('a||b\r\n1||2', '||', false);
    assertEqual(crlf.data, [['a', 'b'], ['1', '2']], 'CRLF line endings with a multi-char delimiter');

    console.log('\n3. Regex delimiters');

    const ws = await parseCSV('a   b \t c', '\\s+', true);
    assertEqual(ws.data, [['a', 'b', 'c']], 'Whitespace-run regex collapses runs into one split');

    const mixed = await parseCSV('a,b;c', '[,;]', true);
    assertEqual(mixed.data, [['a', 'b', 'c']], 'Character-class regex matches either separator');

    const quotedRegex = await parseCSV('a,"b;c",d', '[,;]', true);
    assertEqual(quotedRegex.data, [['a', 'b;c', 'd']], 'Regex delimiter still respects quoted fields');

    const digits = await parseCSV('a1b22c', '\\d+', true);
    assertEqual(digits.data, [['a', 'b', 'c']], 'Variable-length regex match consumes the full match');

    // A regex like \s+ matches the newline between rows too. If the pre-pass let it
    // consume that newline, the entire file would fuse into a single row.
    const multiline = await parseCSV('a b\nc d', '\\s+', true);
    assertEqual(multiline.data, [['a', 'b'], ['c', 'd']], 'Regex delimiter does not swallow row boundaries');

    const trailingWs = await parseCSV('a b \nc d', '\\s+', true);
    assertEqual(trailingWs.data.length, 2, 'Trailing whitespace before a newline keeps two rows');

    const crlfRegex = await parseCSV('a b\r\nc d', '\\s+', true);
    assertEqual(crlfRegex.data, [['a', 'b'], ['c', 'd']], 'Regex delimiter handles CRLF row boundaries');

    // A column-aligned log: the last field contains single spaces, so \s+ is too
    // greedy and splits it, while a two-or-more-spaces pattern gets it right.
    const aligned = 'ts    level   message\n1     INFO    user login ok\n2     ERROR   upstream timed out';
    const greedy = await parseCSV(aligned, '\\s+', true);
    assert(greedy.data.some(r => r.length !== 3),
        '\\s+ over-splits an aligned log (single spaces inside the last field)');
    const strict = await parseCSV(aligned, ' {2,}', true);
    assertEqual(strict.data, [['ts', 'level', 'message'], ['1', 'INFO', 'user login ok'], ['2', 'ERROR', 'upstream timed out']],
        ' {2,} splits an aligned log on column gaps only');

    console.log('\n4. Rejected patterns (guards against hanging on large files)');

    assert(compileDelimiterRegex('a*').error === 'Pattern must not match an empty string.',
        'Zero-width pattern a* is rejected');
    assert(compileDelimiterRegex('\\s*').error === 'Pattern must not match an empty string.',
        'Zero-width pattern \\s* is rejected');
    assert(!!compileDelimiterRegex('(a+)+').error, 'Nested quantifier (a+)+ is rejected');
    assert(!!compileDelimiterRegex('(a*)*').error, 'Nested quantifier (a*)* is rejected');
    assert(!!compileDelimiterRegex('[a-z]*+').error || !!compileDelimiterRegex('[a-z]*+').re === false,
        'Nested quantifier on a character class is rejected');
    assert(!!compileDelimiterRegex('(').error, 'Syntactically invalid pattern is rejected');
    assert(!!compileDelimiterRegex('x'.repeat(MAX_DELIMITER_LENGTH + 1)).error,
        'Over-long pattern is rejected');
    assert(!!compileDelimiterRegex('').error, 'Empty pattern is rejected');
    assert(!compileDelimiterRegex('\\s+').error, 'Well-formed pattern \\s+ is accepted');
    assert(!compileDelimiterRegex('[,;]').error, 'Well-formed pattern [,;] is accepted');

    // A rejected pattern must surface as a parse error, never as a hang or a crash.
    const badParse = await parseCSV('a b c', 'a*', true);
    assertEqual(badParse.data, [], 'A rejected pattern yields no data');
    assert(badParse.errors.length === 1 && /empty string/.test(badParse.errors[0].message),
        'A rejected pattern yields an explanatory error');

    console.log('\n5. Sentinel selection');

    assert(pickDelimiterSentinel('plain text') === '\u0000', 'First sentinel used when the file is clean');
    assert(pickDelimiterSentinel('has \u0000 null') === '\u0001', 'Next sentinel used when the first collides');

    const collide = await parseCSV('a\u0000x||b', '||', false);
    assertEqual(collide.data, [['a\u0000x', 'b']], 'A file already containing NUL still parses correctly');

    console.log('\n6. Round-trip: multi-char delimiters are writable, regex is not');

    const rt = await parseCSV('a||b||c\n1||2||3', '||', false);
    assertEqual(dataToCSV(rt.data, '||'), 'a||b||c\n1||2||3', 'Multi-char delimiter round-trips through dataToCSV');

    const rtQuoted = await parseCSV('a||"b||c"', '||', false);
    assertEqual(dataToCSV(rtQuoted.data, '||'), 'a||"b||c"', 'A field containing the delimiter is re-quoted on write');

    console.log('\n7. Saved (named) delimiters');

    assertEqual(readSavedDelimiters([{ name: 'Double pipe', value: '||' }]),
        [{ name: 'Double pipe', value: '||', isRegex: false }],
        'A well-formed entry survives with isRegex defaulted to false');

    assertEqual(readSavedDelimiters([{ name: 'Aligned', value: ' {2,}', isRegex: true }]),
        [{ name: 'Aligned', value: ' {2,}', isRegex: true }],
        'A valid regex entry is kept');

    assertEqual(readSavedDelimiters('not an array'), [], 'A non-array setting yields an empty list');
    assertEqual(readSavedDelimiters([null, 42, 'x']), [], 'Non-object entries are discarded');
    assertEqual(readSavedDelimiters([{ name: '', value: '||' }]), [], 'An unnamed entry is discarded');
    assertEqual(readSavedDelimiters([{ name: 'x', value: '' }]), [], 'A valueless entry is discarded');
    assertEqual(readSavedDelimiters([{ name: '   ', value: '||' }]), [], 'A whitespace-only name is discarded');
    assertEqual(readSavedDelimiters([{ name: 'Bad', value: '(', isRegex: true }]), [],
        'An entry whose regex does not compile is discarded');
    assertEqual(readSavedDelimiters([{ name: 'x'.repeat(41), value: '||' }]), [],
        'An over-long name is discarded');
    assertEqual(readSavedDelimiters([{ name: 'ok', value: 'x'.repeat(65) }]), [],
        'An over-long value is discarded');

    const dupes = readSavedDelimiters([
        { name: 'Pipes', value: '||' },
        { name: 'pipes', value: '::' },
    ]);
    assertEqual(dupes, [{ name: 'Pipes', value: '||', isRegex: false }],
        'Names are de-duplicated case-insensitively, first wins');

    const many = readSavedDelimiters(
        Array.from({ length: 60 }, (_, i) => ({ name: 'd' + i, value: '||' })));
    assert(many.length === MAX_SAVED_DELIMITERS, 'The saved list is capped at ' + MAX_SAVED_DELIMITERS);

    // A trimmed name is what gets stored, so the picker and delete-by-name agree.
    assertEqual(readSavedDelimiters([{ name: '  Padded  ', value: '||' }]),
        [{ name: 'Padded', value: '||', isRegex: false }], 'Names are trimmed before storage');

    console.log('\n8. Source parity with media/csv.js');

    const src = fs.readFileSync(path.join(__dirname, '..', 'media', 'csv.js'), 'utf8');
    const extSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'csvEditor.ts'), 'utf8');
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

    assert(src.includes('function normalizeForFastParse'), 'normalizeForFastParse exists in csv.js');
    assert(src.includes('function compileDelimiterRegex'), 'compileDelimiterRegex exists in csv.js');
    assert(src.includes('function replaceDelimiterOutsideQuotes'), 'replaceDelimiterOutsideQuotes exists in csv.js');
    assert(src.includes('function delimiterIsLossy'), 'delimiterIsLossy exists in csv.js');
    assert(src.includes('function positionPopupUnder'), 'positionPopupUnder exists in csv.js');
    // Both popups must clamp to the viewport — the delimiter badge is right-aligned
    // in the toolbar, so a left-aligned popup is clipped in a narrow editor.
    assert(!/picker\.style\.left = rect\.left/.test(src), 'Delimiter picker no longer hard-codes its left edge');
    assert(!/box\.style\.left = rect\.left/.test(src), 'Custom dialog no longer hard-codes its left edge');
    assert(src.includes('MAX_DELIMITER_LENGTH = ' + MAX_DELIMITER_LENGTH),
        'MAX_DELIMITER_LENGTH matches the value under test');
    assert(src.includes('async function parseCSV(text, delimiter, isRegex)'),
        'parseCSV accepts the isRegex argument');

    // The lossy-delimiter write guard must stay in place.
    assert(/function debounceSave\(\)[\s\S]{0,400}?delimiterIsLossy\(\)/.test(src),
        'debounceSave refuses to write through a lossy delimiter');
    assert(src.includes('isReadOnly = sourceIsReadOnly || delimiterIsLossy()'),
        'Regex mode forces read-only alongside the source read-only flag');

    // Config plumbing.
    assert(extSrc.includes("delimiterIsRegex: cfg.get('delimiterIsRegex') === true"),
        'csvEditor.ts forwards delimiterIsRegex to the webview');
    const props = pkg.contributes.configuration.properties;
    assert(!!props['csvClearView.delimiterIsRegex'], 'delimiterIsRegex setting is contributed');
    assert(!props['csvClearView.delimiter'].enum,
        'delimiter setting is no longer restricted to an enum');
    assert(!!props['csvClearView.savedDelimiters'], 'savedDelimiters setting is contributed');
    assert(props['csvClearView.savedDelimiters'].type === 'array', 'savedDelimiters is an array setting');
    assert(src.includes('function showManageDelimitersDialog'), 'Manage dialog exists in csv.js');
    assert(src.includes("type: 'saveDelimiter'"), 'csv.js posts saveDelimiter to the host');
    assert(src.includes("type: 'deleteDelimiter'"), 'csv.js posts deleteDelimiter to the host');
    assert(extSrc.includes("case 'saveDelimiter'"), 'csvEditor.ts handles saveDelimiter');
    assert(extSrc.includes("case 'deleteDelimiter'"), 'csvEditor.ts handles deleteDelimiter');
    assert(extSrc.includes('function readSavedDelimiters'), 'csvEditor.ts sanitises the stored list');
    assert(extSrc.includes('ConfigurationTarget.Global'), 'Saved delimiters persist to global settings');

    const css = fs.readFileSync(path.join(__dirname, '..', 'media', 'csv.css'), 'utf8');
    assert(/\.delimiter-custom\s*\{[^}]*max-width:\s*calc\(100vw/.test(css),
        'Custom delimiter dialog is capped to the viewport width');
    assert(/\.delimiter-custom-preview\s*\{[^}]*overflow-wrap/.test(css),
        'Validation messages wrap instead of clipping');

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
