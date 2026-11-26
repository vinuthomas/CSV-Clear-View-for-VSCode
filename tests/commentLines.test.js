/**
 * Comment-line tests for CSV ClearView (media/csv.js): lines starting with the
 * comment prefix are kept out of the data and written back where they were.
 * Functions are pulled out by name, as in tests/structuralEdit.test.js.
 *
 * Run with: node tests/commentLines.test.js
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
const names = ['extractCommentLines', 'carryComments', 'commentLineCount', 'dataToCSV', 'parseCSV',
    'deleteRow', 'filterDataRows', 'removeDuplicateRows'];
const src = names.map(n => {
    const m = csv.match(new RegExp(`(async )?function ${n}\\([\\s\\S]*?\\n}\\n`));
    if (!m) { throw new Error(`${n} not found in media/csv.js`); }
    return m[0];
}).join('\n');

// Mirrors updateContent(): extract, parse, attach comments to row arrays; save mirrors debounceSave().
async function load(text) {
    const state = { rowComments: new Map(), data: null };
    const fns = new Function('state', 'currentText', 'detectedDelimiter', 'delimiterIsRegex', 'commitStructuralEdit',
        `let rowComments = state.rowComments; let originalRawData;
        ${src}
        return {
            async load(text, prefix) {
                const ex = extractCommentLines(text, prefix);
                const { data } = await parseCSV(ex.text, ',');
                ex.comments.forEach((lines, i) => rowComments.set(data[i] || 'end', lines));
                originalRawData = state.data = data;
            },
            save: () => dataToCSV(originalRawData, ',', true),
            exportCsv: () => dataToCSV(originalRawData, ','),
            count: () => commentLineCount(),
            deleteRow, removeDuplicateRows
        };`)(state, text, ',', false, () => {});
    await fns.load(text, '#');
    return { ...fns, state };
}

(async () => {
    console.log('\n📋 Extracting comment lines');
    let f = await load('# generated 2026\n# by tool\na,b\n1,2\n# middle\n3,4\n# end');
    assert(JSON.stringify(f.state.data) === JSON.stringify([['a', 'b'], ['1', '2'], ['3', '4']]), 'comments are not parsed as rows');
    assert(f.count() === 4, 'all four comment lines are counted');
    assert(f.save() === '# generated 2026\n# by tool\na,b\n1,2\n# middle\n3,4\n# end', 'save round-trips comments in place');
    assert(f.exportCsv() === 'a,b\n1,2\n3,4', 'export leaves comments out');

    f = await load('a,b\n1,"two\n#not a comment"\n3,4\n');
    assert(f.state.data.length === 3 && f.state.data[1][1] === 'two\n#not a comment', '# inside a quoted field stays data');
    assert(f.count() === 0, 'no comments counted inside quotes');

    f = await load('a,b\r\n# c\r\n1,2\r\n');
    assert(f.state.data.length === 2 && f.count() === 1, 'CRLF comment lines are extracted');

    const plain = 'a,b\n1,2\n';
    const ex = new Function(`${src}; return extractCommentLines;`)()(plain, '#');
    assert(ex.text === plain && ex.comments.size === 0, 'files without comments pass through untouched');
    const off = new Function(`${src}; return extractCommentLines;`)()('#x\na\n', '');
    assert(off.text === '#x\na\n', 'an empty prefix turns comment handling off');

    console.log('\n📋 Comments survive row edits');
    f = await load('a,b\n# about row 1\n1,2\n3,4\n');
    f.deleteRow(1);
    assert(f.save() === 'a,b\n# about row 1\n3,4', 'deleting a row hands its comment to the next row');

    f = await load('a,b\n1,2\n# about last\n3,4\n');
    f.deleteRow(2);
    assert(f.save() === 'a,b\n1,2\n# about last', 'deleting the last row keeps its comment at the end');

    f = await load('a\n# one\nx\n# two\nx\n# three\nx\ny\n');
    f.removeDuplicateRows();
    assert(f.save() === 'a\n# one\nx\n# two\n# three\ny', 'removed rows pass their comments on in file order');

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) { process.exit(1); }
})();
