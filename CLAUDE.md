<!-- AGENTS.md cross-reference -->
## Also Read AGENTS.md

This repo has an `AGENTS.md` at the project root with additional project conventions and workflows (including the full release process under "Release Management Guidelines"). Treat it as part of these project instructions — read it alongside this file, not just when a section here explicitly links to it.

<!-- code-review-graph MCP tools -->
## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep
- **Understanding impact**: `get_impact_radius` instead of manually tracing imports
- **Code review**: `detect_changes` + `get_review_context` instead of reading entire files
- **Finding relationships**: `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview` + `list_communities`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool | Use when |
| ------ | ---------- |
| `detect_changes` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context` | Need source snippets for review — token-efficient |
| `get_impact_radius` | Understanding blast radius of a change |
| `get_affected_flows` | Finding which execution paths are impacted |
| `query_graph` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes` | Finding functions/classes by name or keyword |
| `get_architecture_overview` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes` for code review.
3. Use `get_affected_flows` to understand impact.
4. Use `query_graph` pattern="tests_for" to check coverage.

## Release Versioning

Full release process lives in AGENTS.md ("Release Management Guidelines") — never package, version-bump, or publish without explicit user instruction. When a release does happen, bump `package.json` following semver by change type:

- **Minor (1.X.0):** the release includes any new or re-enabled user-facing feature, even alongside bug fixes.
- **Patch (1.0.X):** bug fixes / internal changes only, no new feature.
- **Major (X.0.0):** breaking changes — only when the user explicitly calls for it.

A feature bundled with bug fixes still means a minor bump, not a patch.
