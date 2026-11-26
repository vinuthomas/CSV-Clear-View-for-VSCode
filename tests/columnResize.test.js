/**
 * Column resize tests for CSV ClearView (media/csv.js): auto-fit width and
 * which <col> a drag updates when columns are frozen.
 *
 * Run with: node tests/columnResize.test.js
 */

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function assert(condition, testName) {
    if (condition) { passed++; console.log(`  ✅ ${testName}`); }
    else { failed++; console.log(`  ❌ ${testName}`); }
}

const csv = fs.readFileSync(path.join(__dirname, '..', 'media', 'csv.js'), 'utf8');
const src = ['autoColumnWidth', 'setColumnWidth'].map(n => {
    const m = csv.match(new RegExp(`function ${n}\\([\\s\\S]*?\\n}\\n`));
    if (!m) { throw new Error(`${n} not found in media/csv.js`); }
    return m[0];
}).join('\n') + '\n' + ['MIN_COL_WIDTH', 'MAX_COL_WIDTH'].map(n => csv.match(new RegExp(`const ${n} = .*;`))[0]).join('\n');

// Minimal table stub: querySelectorAll('colgroup > col') returns n cols with a style.
function fakeTable(n) {
    const cols = Array.from({ length: n }, () => ({ style: {} }));
    return { cols, style: {}, querySelectorAll: () => cols };
}

function make(columnWidths, frozen) {
    const headerTable = fakeTable(columnWidths.length - frozen.length + (frozen.length ? 1 : 0));
    const table = fakeTable(headerTable.cols.length);
    const fns = new Function('columnWidths', 'frozenCols', 'headerTable', 'table',
        `${src}; return { autoColumnWidth, setColumnWidth };`)(columnWidths, new Set(frozen), headerTable, table);
    return { ...fns, headerTable, table, columnWidths };
}

console.log('\n📋 Auto-fit');
let f = make([], []);
assert(f.autoColumnWidth([['id'], ['1']], 0) === 100, 'short columns get the 100px minimum');
assert(f.autoColumnWidth([['x'], ['a'.repeat(200)]], 0) === 600, 'long columns are capped at 600px');
assert(f.autoColumnWidth([['name'], ['abcdefghijklmnopqrst']], 0) === 20 * 9 + 24, 'width fits the longest cell');

console.log('\n📋 Dragging');
f = make([150, 150, 150], []);
f.setColumnWidth(1, 300);
assert(f.table.cols[1].style.width === '300px' && f.headerTable.cols[1].style.width === '300px', 'header and body <col> both change');
assert(f.table.style.width === '600px', 'table width follows the new total');
f.setColumnWidth(1, 10);
assert(f.columnWidths[1] === 100, 'cannot shrink below the minimum');
f.setColumnWidth(1, 5000);
assert(f.columnWidths[1] === 800, 'cannot grow past the maximum');

f = make([120, 150, 150, 150], [0]);
f.setColumnWidth(2, 250);
// cols: [frozen spacer, col1, col2, col3] — col 2 is at position 2
assert(f.table.cols[2].style.width === '250px' && !f.table.cols[1].style.width, 'frozen spacer col is skipped when finding the <col>');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
