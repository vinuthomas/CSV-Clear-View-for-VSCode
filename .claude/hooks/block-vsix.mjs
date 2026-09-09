#!/usr/bin/env node
/**
 * PreToolUse hook (Edit|Write): refuse direct edits to packaged .vsix files.
 *
 * Claude Code delivers the tool payload as JSON on stdin. Exit 2 blocks the
 * tool call; any other exit lets it through. Anything unexpected — no stdin,
 * malformed JSON, a payload shape we don't recognise — must fall through to
 * "allow": a guard that fails closed would block every edit in the repo.
 *
 * Plain node with no dependencies, so this behaves the same on macOS, Linux
 * and Windows whether Claude Code runs from the terminal or the VS Code
 * extension. (An earlier version shelled out to jq, which is not installed
 * by default on macOS or Windows.)
 */

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
	let filePath = '';
	try {
		const payload = JSON.parse(raw);
		filePath = payload?.tool_input?.file_path ?? '';
	} catch {
		process.exit(0); // Unreadable payload — never block on it.
	}
	if (typeof filePath === 'string' && filePath.toLowerCase().endsWith('.vsix')) {
		console.error('Blocked: .vsix files are build artifacts. Run `npm run package` instead of editing them.');
		process.exit(2);
	}
	process.exit(0);
});
process.stdin.on('error', () => process.exit(0));
