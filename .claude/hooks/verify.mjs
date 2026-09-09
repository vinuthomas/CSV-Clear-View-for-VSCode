#!/usr/bin/env node
/**
 * PostToolUse hook (Edit|Write): type-check, then run the test suite.
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

const TAIL_LINES = 20;
const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

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

const typeChecked = run('Type-check', ['run', 'test-compile']);
const tested = run('Tests', ['test']);

process.exit(typeChecked && tested ? 0 : 2);
