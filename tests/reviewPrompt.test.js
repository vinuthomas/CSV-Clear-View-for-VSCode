/**
 * Review-prompt decision logic tests for CSV ClearView
 *
 * Exercises the pure parts of src/reviewPrompt.ts (recordOpen, reviewUrlFor).
 * The TS source is transpiled in-memory with the `typescript` dev dependency
 * and the `vscode` import is stubbed, so no extension host is needed.
 *
 * Run with: node tests/reviewPrompt.test.js
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

// --- load src/reviewPrompt.ts with a stubbed `vscode` module ---------------
const srcPath = path.join(__dirname, '..', 'src', 'reviewPrompt.ts');
const js = ts.transpileModule(fs.readFileSync(srcPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
const mod = new Module(srcPath);
mod.paths = Module._nodeModulePaths(path.dirname(srcPath));
const origLoad = Module._load;
Module._load = (request, ...rest) => (request === 'vscode' ? {} : origLoad(request, ...rest));
mod._compile(js, srcPath);
Module._load = origLoad;
const { recordOpen, reviewUrlFor, MIN_OPENS, MIN_DAYS } = mod.exports;

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1);

function openNTimes(n, startState, at) {
    let state = startState;
    let last;
    for (let i = 0; i < n; i++) {
        last = recordOpen(state, at);
        state = last.state;
    }
    return last;
}

console.log('\n📋 recordOpen');

{
    const r = recordOpen(undefined, T0);
    assert(r.state.openCount === 1 && r.state.firstOpenAt === T0, 'first open initialises state');
    assert(r.shouldPrompt === false, 'first open never prompts');
}

{
    const r = openNTimes(MIN_OPENS + 5, undefined, T0);
    assert(r.shouldPrompt === false, 'many opens on day one do not prompt (minimum age not reached)');
}

{
    const early = openNTimes(MIN_OPENS - 1, undefined, T0).state;
    const r = recordOpen(early, T0 + MIN_DAYS * DAY);
    assert(r.state.openCount === MIN_OPENS && r.shouldPrompt === true, 'prompts once both open-count and age thresholds are met');
}

{
    const few = openNTimes(MIN_OPENS - 2, undefined, T0).state;
    const r = recordOpen(few, T0 + 30 * DAY);
    assert(r.shouldPrompt === false, 'old install with too few opens does not prompt');
}

{
    const s = { openCount: 50, firstOpenAt: T0, nextPromptAt: 10, done: true };
    assert(recordOpen(s, T0 + 30 * DAY).shouldPrompt === false, 'never prompts after done');
}

{
    const deferred = { openCount: 10, firstOpenAt: T0, nextPromptAt: 35, done: false };
    assert(recordOpen(deferred, T0 + 30 * DAY).shouldPrompt === false, '"Later" defers until nextPromptAt');
    const atNext = { ...deferred, openCount: 34 };
    assert(recordOpen(atNext, T0 + 30 * DAY).shouldPrompt === true, 'prompts again when nextPromptAt is reached');
}

console.log('\n📋 reviewUrlFor');

assert(new URL(reviewUrlFor('Visual Studio Code')).hostname === 'marketplace.visualstudio.com', 'VS Code → Microsoft Marketplace');
assert(new URL(reviewUrlFor('Visual Studio Code - Insiders')).hostname === 'marketplace.visualstudio.com', 'VS Code Insiders → Microsoft Marketplace');
assert(new URL(reviewUrlFor('Cursor')).hostname === 'open-vsx.org', 'Cursor → Open VSX');
assert(new URL(reviewUrlFor('VSCodium')).hostname === 'open-vsx.org', 'VSCodium → Open VSX');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
