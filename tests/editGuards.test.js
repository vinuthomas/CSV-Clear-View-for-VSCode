/**
 * Edit-safety guards for CSV ClearView.
 *
 * Partial views (Head/Tail/Paged) and SQL results must never be saved over the
 * file, and oversized edits must tell the user they were not saved.
 * csv.js touches `document` at load time, so these are source-level checks,
 * matching tests/pagedSwitch.test.js.
 *
 * Run with: node tests/editGuards.test.js
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
const host = fs.readFileSync(path.join(__dirname, '..', 'src', 'csvEditor.ts'), 'utf8');
const editCase = (host.match(/case 'edit':[\s\S]*?\n\t+return;\n\n/) || [''])[0];

console.log('\n📋 Partial views are read-only');
assert(/viewMode === 'chunked' \|\| viewMode === 'head' \|\| viewMode === 'tail'\) \{[\s\S]*?return;/.test(editCase),
    'host ignores edits in Paged, Head and Tail views');
assert(/sourceIsReadOnly = [^;]*message\.viewMode === 'head' \|\| message\.viewMode === 'tail'/.test(csv),
    'webview makes Head and Tail views read-only');

console.log('\n📋 Oversized edits');
assert(/length > 100 \* 1024 \* 1024\) \{\s*vscode\.window\.showErrorMessage/.test(editCase),
    'an edit too large to save tells the user');

console.log('\n📋 SQL results are read-only');
assert(/queryResultHeader = newData\[0\];/.test(csv), 'query result remembers its header row');
assert(/if \(isShowingQueryResult\(\)\) \{/.test(csv), 'double-click edit is blocked on query results');
assert((csv.match(/!isFindReplaceAvailable\(\) \|\| isShowingQueryResult\(\)/g) || []).length === 2,
    'Replace and Replace All are blocked on query results');

console.log('\n📋 Own saves do not reload the view');
assert(/selfWrite = this\.saveDocument\(/.test(editCase), 'save records its write');
assert(/onDidChange\(async \(\) => \{[\s\S]{0,300}mtime === own\) \{ return; \}/.test(host),
    'watcher skips the change our own save made');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
