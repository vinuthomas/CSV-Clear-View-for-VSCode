/**
 * JSONL -> CSV conversion tests for CSV ClearView (src/toCsv.ts), plus checks
 * that JSONL opens read-only and as an optional editor.
 *
 * Run with: node tests/jsonl.test.js
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

const srcPath = path.join(__dirname, '..', 'src', 'toCsv.ts');
const js = ts.transpileModule(fs.readFileSync(srcPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
const mod = new Module(srcPath);
mod._compile(js, srcPath);
const { jsonlToCsv } = mod.exports;

console.log('\n📋 jsonlToCsv');
assert(jsonlToCsv('{"a":1,"b":"x"}\n{"a":2,"b":"y"}\n') === 'a,b\r\n1,x\r\n2,y\r\n', 'flat records become rows');
assert(jsonlToCsv('{"a":1}\n{"b":2,"a":3}\n') === 'a,b\r\n1,\r\n3,2\r\n', 'columns are the union of keys in first-seen order');
assert(jsonlToCsv('{"a":{"x":[1,2]},"b":null,"c":true}\n') === 'a,b,c\r\n"{""x"":[1,2]}",,true\r\n', 'nested values are JSON, null is empty');
assert(jsonlToCsv('{"a":"has, comma\\nand newline"}\n') === 'a\r\n"has, comma\nand newline"\r\n', 'fields are CSV-escaped');
assert(jsonlToCsv('﻿{"a":1}\r\n\r\n{"a":2}') === 'a\r\n1\r\n2\r\n', 'BOM, CRLF, blank lines and a missing final newline are handled');
assert(jsonlToCsv('{"a":1}\n{"a":2\n[1,2]\n') === 'a,_raw\r\n1,\r\n,"{""a"":2"\r\n,"[1,2]"\r\n', 'bad JSON and non-objects keep their text in _raw');
assert(jsonlToCsv('{"_raw":1}\noops\n') === '_raw,__raw\r\n1,\r\n,oops\r\n', 'the raw column never collides with a real key');
assert(jsonlToCsv('{"__proto__":"p","constructor":"c"}\n') === '__proto__,constructor\r\np,c\r\n', '__proto__ and constructor keys are ordinary columns');
assert(jsonlToCsv('{"__proto__":"p","constructor":"c"}\n{"other":1}\n') === '__proto__,constructor,other\r\np,c,\r\n,,1\r\n', 'missing prototype-named keys are empty');
assert(jsonlToCsv('') === '\r\n', 'empty file gives an empty header');

console.log('\n📋 Wiring');
const editor = fs.readFileSync(path.join(__dirname, '..', 'src', 'csvEditor.ts'), 'utf8');
const pkg = require('../package.json');
assert(/readOnly: isTableFormat/.test(editor), 'JSONL opens read-only');
assert(/if \(isTableFormat\) \{\s*console\.warn\('CSV ClearView: edit ignored/.test(editor), 'host refuses edits to JSONL');
assert(/delimiter: isTableFormat \? ','/.test(editor), 'converted text is always parsed as comma-delimited');
const jsonlEditor = pkg.contributes.customEditors.find(e => e.viewType === 'csvClearView.jsonl');
assert(!!jsonlEditor && jsonlEditor.priority === 'option', 'JSONL is an optional editor, so text stays the default');
assert(pkg.keywords.length <= 30, 'Marketplace allows at most 30 keywords');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
