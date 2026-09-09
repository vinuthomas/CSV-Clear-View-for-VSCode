#!/usr/bin/env node
/**
 * PostToolUse hook (Edit|Write): type-check, then run the test suite.
 *
 * Gated: only files the build or the tests actually read trigger a run, so
 * editing a screenshot, a Markdown file or this hook itself costs nothing.
 * Everything else exits silently.
 *
 * Runs the npm scripts directly rather than through a shell pipeline, so the
 * hook does not depend on `tail`, `2>&1` or `|| true` — none of which behave
 * the same under PowerShell on Windows. Output is trimmed to the last few
 * lines here instead.
 *
 * Hooks run with the project root as the working directory, so no `cd` and no
 * absolute path is needed; CLAUDE_PROJECT_DIR is used only as a fallback.
 *
 * Exits 2 on failure so the error is reported back, and 0 when everything
 * passes. A missing toolchain is reported but never blocks.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';

const TAIL_LINES = 20;
const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// Files that feed `tsc -p ./`. Editing one of these means a type-check.
const TYPECHECK = [
	/^src\/.*\.ts$/,
	/^tsconfig\.json$/,
];

// Files the test suite reads. Keep this in step with tests/ — the suite asserts
// against media/csv.js and media/csv.css directly, and also reads .vscodeignore,
// package.json, src/csvEditor.ts and samples/valid_data.csv, so none of those
// can be treated as "docs" and skipped.
const TESTED = [
	/^src\/.*\.ts$/,
	/^media\/.*\.(js|css)$/,
	/^tests\/.*\.js$/,
	/^package\.json$/,
	/^\.vscodeignore$/,
	/^samples\/valid_data\.csv$/,
	/^webpack\.config\.js$/,
	/^tsconfig\.json$/,
];

/** Project-relative, forward-slashed path, or '' when the payload has none. */
function relativePath(filePath) {
	if (typeof filePath !== 'string' || filePath === '') { return ''; }
	const abs = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
	return path.relative(cwd, abs).split(path.sep).join('/');
}

/** Last N non-empty lines of a command's combined output. */
function tail(text) {
	return String(text || '')
		.split('\n')
		.filter(line => line.trim() !== '')
		.slice(-TAIL_LINES)
		.join('\n');
}

function run(label, args) {
	const result = spawnSync(npm, args, { cwd, encoding: 'utf8', shell: false });
	if (result.error) {
		// npm missing or not executable — report, but do not block the edit.
		console.error(`${label}: could not run npm (${result.error.message})`);
		return true;
	}
	if (result.status !== 0) {
		console.error(`${label} FAILED\n${tail(result.stdout + result.stderr)}`);
		return false;
	}
	return true;
}

function verify(rel) {
	// A file outside the project (a scratchpad note, say) affects nothing here.
	const outsideProject = rel === '' || rel.startsWith('..');

	// No usable path means we cannot tell what changed — run everything rather
	// than risk skipping a check that would have caught a regression.
	const unknown = rel === '';

	if (outsideProject && !unknown) { process.exit(0); }

	const needsTypeCheck = unknown || TYPECHECK.some(re => re.test(rel));
	const needsTests = unknown || TESTED.some(re => re.test(rel));

	if (!needsTypeCheck && !needsTests) { process.exit(0); }

	const typeChecked = needsTypeCheck ? run('Type-check', ['run', 'test-compile']) : true;
	const tested = needsTests ? run('Tests', ['test']) : true;

	process.exit(typeChecked && tested ? 0 : 2);
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
	let filePath = '';
	try {
		filePath = JSON.parse(raw)?.tool_input?.file_path ?? '';
	} catch {
		filePath = ''; // Unreadable payload — fall through to running everything.
	}
	verify(relativePath(filePath));
});
process.stdin.on('error', () => verify(''));
