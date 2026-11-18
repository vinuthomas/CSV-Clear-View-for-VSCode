/**
 * Column stats (Shift+click a header) on big columns.
 * Runs the real computeColStats from media/csv.js.
 *
 * Run with: node tests/colStats.test.js
 */

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function assert(condition, testName) {
    if (condition) { passed++; console.log(`  ✅ ${testName}`); }
    else { failed++; console.log(`  ❌ ${testName}`); }
}

const src = fs.readFileSync(path.join(__dirname, '..', 'media', 'csv.js'), 'utf8');
const fn = src.match(/function computeColStats\([\s\S]*?\n}\n/);
if (!fn) { throw new Error('computeColStats not found in media/csv.js'); }
// String columns need only columnTypes from the surrounding script.
const computeColStats = new Function('columnTypes', `${fn[0]}; return computeColStats;`)(['string']);

console.log('\n📋 computeColStats — string column');

{
    const data = [['name'], ['a'], ['abc'], [''], ['ab']];
    const s = computeColStats(data, 0);
    assert(s.minLen === 1 && s.maxLen === 3 && s.avgLen === '2.0', 'length stats are correct (min 1, max 3, avg 2.0)');
    assert(s.nullCount === 1 && s.nonNull === 3, 'empty cells count as nulls');
}

{
    // Math.min(...lens) threw "Maximum call stack size exceeded" above ~150k values.
    const data = [['name']];
    for (let i = 0; i < 300000; i++) { data.push(['x'.repeat(1 + (i % 7))]); }
    let s = null;
    try { s = computeColStats(data, 0); } catch (e) { /* reported below */ }
    assert(s !== null && s.minLen === 1 && s.maxLen === 7, '300,000-row text column does not overflow the stack');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
