/**
 * Row/column editing tests for CSV ClearView (media/csv.js).
 * csv.js touches `document` at load time, so the functions are pulled out by
 * name and run against a stub originalRawData, as in tests/sqlLimits.test.js.
 *
 * Run with: node tests/structuralEdit.test.js
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
const names = ['padRows', 'uniqueColumnName', 'insertColumn', 'deleteColumn', 'swapColumns', 'insertRow', 'deleteRow'];
const src = names.map(n => {
    const m = csv.match(new RegExp(`function ${n}\\([\\s\\S]*?\\n}\\n`));
    if (!m) { throw new Error(`${n} not found in media/csv.js`); }
    return m[0];
}).join('\n');

function run(data, call) {
    let commits = 0;
    const fns = new Function('originalRawData', 'commitStructuralEdit',
        `${src}; return { ${names.join(', ')} };`)(data, () => { commits++; });
    call(fns);
    return commits;
}

const fresh = () => [['a', 'b'], ['1', '2'], ['3']]; // last row is ragged

console.log('\n📋 Columns');
let d = fresh();
let commits = run(d, f => f.insertColumn(1));
assert(JSON.stringify(d) === JSON.stringify([['a', 'New Column 1', 'b'], ['1', '', '2'], ['3', '']]),
    'insert column pads ragged rows so values stay aligned');
assert(commits === 1, 'each change is sent as one edit');

d = [['New Column 1', 'x'], ['1', '2']];
run(d, f => f.insertColumn(2));
assert(d[0][2] === 'New Column 2', 'new column name does not clash with an existing one');

d = fresh();
run(d, f => f.deleteColumn(0));
assert(JSON.stringify(d) === JSON.stringify([['b'], ['2'], []]), 'delete column removes it from every row');

d = fresh();
run(d, f => f.swapColumns(0, 1));
assert(JSON.stringify(d) === JSON.stringify([['b', 'a'], ['2', '1'], ['', '3']]), 'move column swaps values in every row');

console.log('\n📋 Rows');
d = fresh();
run(d, f => f.insertRow(1));
assert(JSON.stringify(d[1]) === '["",""]' && d.length === 4, 'insert row adds a blank row as wide as the header');
d = fresh();
run(d, f => f.deleteRow(1));
assert(JSON.stringify(d) === JSON.stringify([['a', 'b'], ['3']]), 'delete row removes only that row');

console.log('\n📋 Wiring');
const host = fs.readFileSync(path.join(__dirname, '..', 'src', 'csvEditor.ts'), 'utf8');
assert(/if \(e\.reload === true\) \{ await document\.refresh\(true\); \}/.test(host), 'host reloads the view after a row/column change');
assert(/function canEditStructure\(\) \{\s*return !isChunkedMode && !isReadOnly && !isShowingQueryResult\(\) && !dupesOnlyMode/.test(csv),
    'row/column editing is off in Paged, read-only, query-result and duplicates views');
assert(/if \(idx < 1\) \{ return; \}/.test(csv), 'the header row cannot be deleted from the row menu');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
