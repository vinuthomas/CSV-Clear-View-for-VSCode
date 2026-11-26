/**
 * Slow-load prompt → Paged View tests for CSV ClearView
 *
 * When a full load is slow, the prompt offers Paged View. Switching must
 * cancel the in-flight parse (so it can't draw over the paged table later)
 * and ask the host to resend the file in chunked mode.
 *
 * csv.js touches `document` at load time, so these are source-level checks,
 * matching the approach in delimiter.test.js.
 *
 * Run with: node tests/pagedSwitch.test.js
 */

const fs = require('fs');
const path = require('path');

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

const csv = fs.readFileSync(path.join(__dirname, '..', 'media', 'csv.js'), 'utf8');
const host = fs.readFileSync(path.join(__dirname, '..', 'src', 'csvEditor.ts'), 'utf8');

console.log('\n📋 Slow-load prompt');

assert(/id="switch-to-paged"/.test(host), 'prompt has a Paged View button');
assert(/id="switch-to-text"/.test(host), 'prompt keeps the Plain Text button');
assert(/id="continue-waiting"/.test(host), 'prompt keeps the Continue button');
assert(/switchToPagedBtn\.classList\.toggle\('hidden',[^;]*readOnly/.test(csv), 'Paged View button is hidden for Excel workbooks');
// The webview CSP has no 'unsafe-inline' for style-src, so inline style=""
// attributes are silently ignored — all styling must live in media/csv.css.
assert(!/\sstyle="/.test(host), 'webview HTML has no inline style attributes (blocked by CSP)');
assert(/class="slow-load-actions"/.test(host) && /\.slow-load-actions\s*\{[^}]*display:\s*flex/.test(fs.readFileSync(path.join(__dirname, '..', 'media', 'csv.css'), 'utf8')),
    'prompt buttons are laid out by a CSS class');

console.log('\n📋 Switching to Paged View');

const handler = csv.match(/switchToPagedBtn\.addEventListener\('click',[\s\S]*?\n {4}\}\);/);
assert(!!handler, 'Paged View button has a click handler');
assert(!!handler && /loadGeneration\+\+/.test(handler[0]), 'click cancels the in-flight load immediately');
assert(!!handler && /postMessage\(\{ type: 'switchToPagedView' \}\)/.test(handler[0]), 'click asks the host to switch');

const hostCase = host.match(/case 'switchToPagedView': \{[\s\S]*?\n\t+\}/);
assert(!!hostCase, 'host handles switchToPagedView');
assert(!!hostCase && /isExcel/.test(hostCase[0]), 'host ignores the switch for Excel files');
assert(!!hostCase && /viewMode = 'chunked'/.test(hostCase[0]), 'host switches to chunked mode');
assert(!!hostCase && /await updateWebview\(\)/.test(hostCase[0]), 'host resends the file');

console.log('\n📋 Cancelling a superseded load');

assert(/async function parseCSV\(text, delimiter, isRegex, isCancelled\)/.test(csv), 'parseCSV takes an isCancelled callback');
assert(/if \(isCancelled && isCancelled\(\)\) \{\s*return \{ data: \[\], errors: \[\], cancelled: true \};/.test(csv), 'parseCSV stops at a yield point when cancelled');
assert(/const gen = loadGeneration;\s*(?:const extracted = .*\s*)?const parsed = await parseCSV\([^)]*\(\) => gen !== loadGeneration\)/.test(csv), 'updateContent passes a generation check to parseCSV');
assert(/if \(parsed\.cancelled \|\| gen !== loadGeneration\) \{ return; \}/.test(csv), 'updateContent leaves state alone when superseded');
assert(/case 'update':[\s\S]{0,400}?loadGeneration\+\+/.test(csv), "every 'update' message starts a new load generation");
assert(/finally \{\s*if \(gen === loadGeneration\) \{\s*isUpdating = false;\s*hideLoader\(\);/.test(csv), 'a superseded load does not hide the new load\'s spinner');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
