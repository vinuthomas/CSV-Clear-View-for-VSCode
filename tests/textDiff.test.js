/**
 * Undo/redo diff tests for CSV ClearView (src/textDiff.ts), plus source-level
 * checks that edits go through VS Code's undo stack instead of straight to disk.
 *
 * Run with: node tests/textDiff.test.js
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');

let passed = 0;
let failed = 0;
function assert(condition, testName) {
    if (condition) { passed++; console.log(`  ✅ ${testName}`); }
    else { failed++; console.log(`  ❌ ${testName}`); }
}

const srcPath = path.join(__dirname, '..', 'src', 'textDiff.ts');
const js = ts.transpileModule(fs.readFileSync(srcPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
const mod = new Module(srcPath);
mod._compile(js, srcPath);
const { diffText, applyChange } = mod.exports;

console.log('\n📋 diffText / applyChange round-trip');
const cases = [
    ['same', 'a,b\n1,2\n', 'a,b\n1,2\n'],
    ['cell edit', 'a,b\n1,2\n3,4\n', 'a,b\n1,22\n3,4\n'],
    ['cell cleared', 'a,b\n1,2\n', 'a,b\n1,\n'],
    ['from empty', '', 'a,b\n'],
    ['to empty', 'a,b\n', ''],
    ['repeated chars', 'aaaa', 'aaaaaa'],
    ['repeated chars shrink', 'x,aaa,y', 'x,a,y'],
    ['CRLF normalised', 'a,b\r\n1,2\r\n', 'a,b\n1,2\n'],
    ['row removed', 'h\n1\n2\n3\n', 'h\n1\n3\n'],
];
for (const [name, before, after] of cases) {
    const c = diffText(before, after);
    assert(applyChange(before, c, false) === after && applyChange(after, c, true) === before, name);
}

const big = 'x,'.repeat(100000) + '\n';
const edited = big.slice(0, 50000) + 'CHANGED' + big.slice(50002);
const c = diffText(big, edited);
assert(c.removed.length + c.inserted.length < 20, 'a cell edit in a large file stores only the changed span');

console.log('\n📋 Host wiring');
const host = fs.readFileSync(path.join(__dirname, '..', 'src', 'csvEditor.ts'), 'utf8');
const editCase = (host.match(/case 'edit':[\s\S]*?case 'runQuery'/) || [''])[0];
assert(/_onDidChangeCustomDocumentEmitter\.fire\(/.test(editCase), 'edits are reported to VS Code (undo + dirty state)');
assert(!/saveDocument\(/.test(editCase), 'edits are no longer written to disk immediately');
assert(/async backupCustomDocument[\s\S]{0,400}writeFile\(context\.destination/.test(host), 'unsaved edits are backed up (hot exit)');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
