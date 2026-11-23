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
const promptHandler = csv.match(/function handlePromptResult\([\s\S]*?\n}\n/);
if (!promptHandler) { throw new Error('handlePromptResult not found in media/csv.js'); }
const pending = new Map();
const handlePrompt = new Function('pendingPrompts', `${promptHandler[0]}; return handlePromptResult;`)(pending);
let promptValue;
pending.set(1, value => { promptValue = value; });
handlePrompt({ id: '__proto__', value: 'unexpected' });
assert(promptValue === undefined && pending.has(1), 'invalid prompt IDs do not invoke or remove callbacks');
handlePrompt({ id: 1, value: 'renamed' });
assert(promptValue === 'renamed' && !pending.has(1), 'valid prompt result invokes its callback once');
pending.set(2, () => { promptValue = 'unexpected'; });
handlePrompt({ id: 2 });
assert(promptValue === 'renamed' && !pending.has(2), 'cancelled prompts remove callbacks without invoking them');
pending.set(3, 'not a function');
handlePrompt({ id: 3, value: 'ignored' });
assert(!pending.has(3), 'non-function prompt entries are safely ignored');

const names = ['padRows', 'uniqueColumnName', 'insertColumn', 'deleteColumn', 'swapColumns', 'insertRow', 'deleteRow',
    'mapColumn', 'filterDataRows', 'toTitleCase', 'deleteRowsWhereEmpty', 'removeDuplicateRows', 'splitColumn'];
const src = names.map(n => {
    const m = csv.match(new RegExp(`function ${n}\\([\\s\\S]*?\\n}\\n`));
    if (!m) { throw new Error(`${n} not found in media/csv.js`); }
    return m[0];
}).join('\n') + '\n' + ['isBlank', 'MAX_SPLIT_COLUMNS'].map(n => {
    const m = csv.match(new RegExp(`const ${n} = .*;`));
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

console.log('\n📋 Cleaning');
d = [['name', 'city'], ['  ada  ', 'x'], ['bob', ''], ['ada', 'x']];
commits = run(d, f => f.mapColumn(0, v => v.trim()));
assert(d[1][0] === 'ada' && commits === 1, 'trim changes cells and sends one edit');
commits = run(d, f => f.mapColumn(0, v => v.trim()));
assert(commits === 0, 'a no-op cleaning step sends no edit (no empty undo step)');

let r;
run([], f => { r = [f.toTitleCase('mARY o\'neil-smith'), f.toTitleCase('  two  words')]; });
assert(r[0] === "Mary O'neil-smith" && r[1] === '  Two  Words', 'title case capitalises after spaces only');

d = [['name', 'city'], ['ada', 'x'], ['bob', ' '], ['cy']];
run(d, f => { r = f.deleteRowsWhereEmpty(1); });
assert(r === 2 && JSON.stringify(d) === JSON.stringify([['name', 'city'], ['ada', 'x']]), 'delete rows where empty treats blanks and missing cells as empty');

d = [['a', 'b'], ['1', '2'], ['1', '2'], ['3', '4'], ['1', '2']];
run(d, f => { r = f.removeDuplicateRows(); });
assert(r === 2 && JSON.stringify(d) === JSON.stringify([['a', 'b'], ['1', '2'], ['3', '4']]), 'remove duplicates keeps the first of each, header untouched');
d = [['a'], ['1,2']];
run(d, f => { r = f.removeDuplicateRows(); });
assert(r === 0, 'no duplicates means nothing removed');

d = [['id', 'name', 'z'], ['1', 'Ada Lovelace', 'q'], ['2', 'Bob', 'r'], ['3', 'A B C', 's']];
commits = run(d, f => { r = f.splitColumn(1, ' '); });
assert(r === 3 && commits === 1, 'split returns the new column count');
assert(JSON.stringify(d) === JSON.stringify([
    ['id', 'name 1', 'name 2', 'name 3', 'z'], ['1', 'Ada', 'Lovelace', '', 'q'], ['2', 'Bob', '', '', 'r'], ['3', 'A', 'B', 'C', 's']]),
    'split pads short rows and keeps later columns aligned');
d = [['a'], ['x']];
commits = run(d, f => { r = f.splitColumn(0, ','); });
assert(typeof r === 'string' && commits === 0, 'split with no matches explains instead of editing');
d = [['a'], ['x'.repeat(60).split('').join(',')]];
run(d, f => { r = f.splitColumn(0, ','); });
assert(typeof r === 'string' && d[0].length === 1, 'split refuses to create more than the column limit');

console.log('\n📋 Wiring');
const host = fs.readFileSync(path.join(__dirname, '..', 'src', 'csvEditor.ts'), 'utf8');
assert(/if \(e\.reload === true\) \{ await document\.refresh\(true\); \}/.test(host), 'host reloads the view after a row/column change');
assert(/function canEditStructure\(\) \{\s*return !isChunkedMode && !isReadOnly && !isShowingQueryResult\(\) && !dupesOnlyMode/.test(csv),
    'row/column editing is off in Paged, read-only, query-result and duplicates views');
assert(/if \(idx < 1\) \{ return; \}/.test(csv), 'the header row cannot be deleted from the row menu');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
