/**
 * SQL size-limit tests for CSV ClearView
 *
 * Covers the guard that stops a SQL query on a very large file from crashing
 * the webview: the per-machine limit (src/sqlLimits.ts) and the payload
 * estimators on both sides (host: estimateJsonBytes, webview:
 * estimateSqlPayloadBytes in media/csv.js).
 *
 * Run with: node tests/sqlLimits.test.js
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');

let passed = 0;
let failed = 0;

function assert(condition, testName) {
    if (condition) {
        passed++;
        console.log(`  ✅ ${testName}`);
    } else {
        failed++;
        console.log(`  ❌ ${testName}`);
    }
}

// --- load src/sqlLimits.ts (no vscode dependency) -------------------------
const srcPath = path.join(__dirname, '..', 'src', 'sqlLimits.ts');
const js = ts.transpileModule(fs.readFileSync(srcPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
const mod = new Module(srcPath);
mod._compile(js, srcPath);
const {
    computeSqlPayloadLimit, estimateJsonBytes,
    SQL_HARD_PAYLOAD_LIMIT, SQL_MIN_PAYLOAD_LIMIT
} = mod.exports;

// --- pull the real estimateSqlPayloadBytes out of media/csv.js ------------
// (csv.js touches `document` at load time, so it can't be required whole.)
const csvSrc = fs.readFileSync(path.join(__dirname, '..', 'media', 'csv.js'), 'utf8');
const fnMatch = csvSrc.match(/function estimateSqlPayloadBytes\([\s\S]*?\n}\n/);
if (!fnMatch) { throw new Error('estimateSqlPayloadBytes not found in media/csv.js'); }
const estimateSqlPayloadBytes = new Function(`${fnMatch[0]}; return estimateSqlPayloadBytes;`)();

const MB = 1024 * 1024;
const GB = 1024 * MB;

console.log('\n📋 computeSqlPayloadLimit');

{
    const l8 = computeSqlPayloadLimit(8 * GB);
    assert(l8 < SQL_HARD_PAYLOAD_LIMIT && Math.abs(l8 - 364 * MB) < MB, `8GB machine → ~364MB (got ${Math.round(l8 / MB)}MB)`);
    assert(computeSqlPayloadLimit(16 * GB) === SQL_HARD_PAYLOAD_LIMIT, '16GB machine → hard cap');
    assert(computeSqlPayloadLimit(24 * GB) === SQL_HARD_PAYLOAD_LIMIT, '24GB machine → hard cap');
    assert(computeSqlPayloadLimit(256 * GB) === SQL_HARD_PAYLOAD_LIMIT, 'huge machine never exceeds the hard cap');
    assert(SQL_HARD_PAYLOAD_LIMIT < 512 * MB, 'hard cap stays below V8\'s ~512MB string limit');
    assert(computeSqlPayloadLimit(256 * MB) === SQL_MIN_PAYLOAD_LIMIT, 'tiny machine falls back to the minimum');
}

// --- synthetic data shaped like a real export ------------------------------
let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const headers = ['order_id', 'order_date', 'customer', 'region', 'quantity', 'unit_price', 'discount', 'notes'];
const data = [headers];
for (let i = 1; i <= 50000; i++) {
    data.push([
        String(i), '2024-05-' + String(1 + (i % 28)).padStart(2, '0'),
        ['Ada Lovelace', 'Alan Turing', 'Grace Hopper'][i % 3],
        ['North', 'South', 'East', 'West'][i % 4],
        String(1 + Math.floor(rnd() * 20)), (rnd() * 2500).toFixed(2),
        rnd() < 0.05 ? '' : String(Math.floor(rnd() * 4) * 5),
        rnd() < 0.5 ? '' : 'Leave at door, side gate ' + 'x'.repeat(Math.floor(rnd() * 40))
    ]);
}
// Exactly what dataToObjects + postMessage would serialise.
const objects = data.slice(1).map(row => {
    const o = {};
    headers.forEach((h, j) => {
        const v = row[j];
        o[h] = (v != null && v.trim() !== '' && !isNaN(Number(v.trim()))) ? Number(v.trim()) : v;
    });
    return o;
});
const actual = JSON.stringify(objects).length;

console.log('\n📋 estimateSqlPayloadBytes (webview, media/csv.js)');

{
    const est = estimateSqlPayloadBytes(data);
    const err = Math.abs(est - actual) / actual;
    assert(err < 0.05, `estimate within 5% of the real message size (off by ${(err * 100).toFixed(2)}%)`);
    assert(estimateSqlPayloadBytes([headers]) === 0, 'header-only data → 0');
    assert(estimateSqlPayloadBytes([]) === 0, 'empty data → 0');
    const t = Date.now();
    const big = [headers].concat(new Array(2000000).fill(data[1]));
    estimateSqlPayloadBytes(big);
    assert(Date.now() - t < 500, '2M-row estimate is fast (samples, does not serialise everything)');
}

console.log('\n📋 estimateJsonBytes (host, src/sqlLimits.ts)');

{
    const est = estimateJsonBytes(objects);
    const err = Math.abs(est - actual) / actual;
    assert(err < 0.05, `estimate within 5% of JSON.stringify (off by ${(err * 100).toFixed(2)}%)`);
    assert(estimateJsonBytes([]) === 2, 'empty result → "[]"');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
