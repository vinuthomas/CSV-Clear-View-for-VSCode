#!/usr/bin/env node
/**
 * code-review-graph hook: `update` after edits, `status` at session start.
 *
 * The graph CLI is an optional local tool — contributors who have not
 * installed it must not see a failing hook on every edit, so a missing
 * binary, a non-git directory, or a non-zero exit are all reported quietly
 * and never block. Always exits 0.
 *
 * Usage: node .claude/hooks/graph.mjs <update|status>
 */

import { spawnSync } from 'node:child_process';

const mode = process.argv[2] === 'status' ? 'status' : 'update';
const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// Outside a git repo there is nothing to index.
const git = spawnSync('git', ['rev-parse', '--git-dir'], { cwd, encoding: 'utf8', shell: false });
if (git.error || git.status !== 0) {
	if (mode === 'status') { console.log('Not a git repo, skipping'); }
	process.exit(0);
}

const args = mode === 'status' ? ['status'] : ['update', '--skip-flows'];
const graph = spawnSync('code-review-graph', args, { cwd, encoding: 'utf8', shell: false });

if (graph.error) {
	// Optional tooling — absence is not an error worth interrupting anyone for.
	if (mode === 'status') { console.log('code-review-graph not installed, skipping'); }
	process.exit(0);
}
if (graph.stdout) { process.stdout.write(graph.stdout); }
if (graph.status !== 0 && graph.stderr) { console.error(graph.stderr.trim()); }
process.exit(0);
