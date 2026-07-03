# CSV ClearView VS Code Extension

## Project Overview
A VS Code extension that provides a powerful custom editor for CSV/TSV files with advanced features like colored columns, SQL queries, data profiling, and handling of files up to 500MB+.

**Publisher:** VinuThomas  
**Version:** 1.0.1  
**License:** MIT  
**Repository:** https://github.com/vinuthomas/CSV-Clear-View-for-VSCode

## Tech Stack
- **Language:** TypeScript
- **Platform:** VS Code Extension API (^1.75.0)
- **Build Tool:** Webpack
- **Key Dependencies:**
  - `alasql` (^4.17.0) - SQL query engine for in-memory CSV data
  - `@vscode/vsce` (^3.7.1) - VS Code extension packaging tool

## Architecture

### Core Components
1. **extension.ts** - Extension entry point, registers the custom editor provider
2. **csvEditor.ts** - Main editor implementation (~621 lines)
   - Implements `vscode.CustomEditorProvider<CsvDocument>`
   - Handles document lifecycle, webview communication
   - Manages large file support with chunked/streaming modes

### Custom Editor Model
- **View Type:** `csvClearView.edit`
- **File Patterns:** `*.csv`, `*.tsv`, `*.tab`, `*.psv`
- **Webview-based:** Uses HTML/CSS/JavaScript in webview for rendering
- **Retain Context:** `retainContextWhenHidden: true` for better UX

### Large File Handling Strategy
The extension has sophisticated large file support:

- **Full Mode:** Files < 20MB (configurable via `safeModeThreshold`)
- **Head/Tail Mode:** Sample first/last rows for large files
- **Chunked Mode:** Files > 500MB use virtual scrolling with sampled row index
  - `CHUNK_ROWS = 500` rows per page
  - Row index uses checkpoints every ~4MB to avoid memory overflow
  - Supports files with hundreds of millions of rows

### Key Features Implementation
1. **Colored Columns:** Theme-aware column coloring (dark/light mode)
2. **Sticky Header:** CSS-based fixed header row
3. **SQL Queries:** Uses AlaSQL library, only `SELECT` statements allowed, table name is `?`
4. **SQL History:** Stores up to 50 queries, bash-style ↑/↓ navigation
5. **CSV Linting:** Detects rows with inconsistent column counts
6. **Cell Editing:** Double-click to edit, undo/redo support
7. **Delimiter Auto-Detection:** Detects `,`, `\t`, `|`, `;` automatically
8. **Data Type Inference:** Samples up to 1,000 rows to infer column types (integer, float, date, boolean, string)
9. **Column Sorting:** Type-aware sorting, empty values always sort last, horizontal scroll position preserved during sort
10. **Column Stats:** Shift+click header for min/max/mean/median/std dev/percentiles
11. **Profile Panel:** Full schema summary with type, null %, distinct count
12. **Freeze Pane:** Right-click column header to freeze (Excel-style)

## Configuration Settings
All settings under `csvClearView.*` namespace:

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `stickyHeader` | boolean | `true` | Enable sticky header row |
| `alternatingRows` | boolean | `true` | Zebra-striping for rows |
| `forceTextColumnColoring` | boolean | `false` | Force coloring in Plain Text mode |
| `safeModeThreshold` | number | `20` | File size (MB) for large-file prompt |
| `showSlowLoadPrompt` | boolean | `true` | Prompt to switch to Plain Text if slow |
| `delimiter` | enum | `"auto"` | Delimiter: `auto`, `,`, `\t`, `\|`, `;` |

## Build & Development Commands

```bash
# Install dependencies
npm install

# Development build (watch mode)
npm run watch

# Production build
npm run package

# Compile TypeScript
npm run compile

# Package extension (IMPORTANT: use node_modules/.bin/vsce, not npx)
node_modules/.bin/vsce package

# Install locally for testing
code --install-extension csv-clearview-1.0.1.vsix
```

**Note:** Always use `node_modules/.bin/vsce package` instead of `npx @vscode/vsce package`. The npx command doesn't work properly with this project setup.

## Debugging
1. Open project in VS Code
2. Press F5 to launch Extension Development Host
3. Open a `.csv` file in the new window to test

## Project Structure
```
csv-vscode-plugin/
├── src/
│   ├── extension.ts          # Entry point
│   └── csvEditor.ts           # Main editor logic
├── media/                     # Static assets (icon, webview resources)
├── dist/                      # Compiled output (webpack)
├── tests/                     # Test files
├── samples/                   # Sample CSV files for testing
├── package.json               # Extension manifest
├── tsconfig.json              # TypeScript config
├── webpack.config.js          # Webpack config
└── README.md                  # User documentation
```

## Important Constants (csvEditor.ts)
```typescript
CHUNKED_MODE_THRESHOLD = 500 * 1024 * 1024  // 500 MB
CHUNK_ROWS = 500                            // Rows per page
SAMPLE_INTERVAL = ~4MB                      // Row index checkpoint interval
```

## Webview Communication Protocol
The extension communicates with the webview via `postMessage`:
- **Extension → Webview:** Send data chunks, configuration, SQL results
- **Webview → Extension:** Request data, execute SQL, save edits

## SQL Query Engine
- Library: AlaSQL
- Table name: Always `?`
- Column names with spaces: Use brackets `[Column Name]`
- String literals: Use single quotes `'value'`
- Allowed: Only `SELECT` statements
- Blocked: `DROP`, `DELETE`, `INSERT`, `UPDATE`, etc.

## Extension Activation
- **Activation Events:** `onLanguage:csv`, `onLanguage:tsv`, `onLanguage:psv`
- Auto-activates when CSV/TSV/PSV files are opened
- Custom editor has `"priority": "default"` (user can switch to text editor)
- **Supported File Types:** `.csv`, `.tsv`, `.tab`, `.psv`
- **Language IDs:** `csv`, `tsv`, `psv`

## Testing Considerations
- Test with files of various sizes: <1MB, 20MB, 100MB, 500MB+
- Test delimiter detection with different formats
- Test SQL queries with edge cases (special characters, NULL values)
- Test editing with undo/redo
- Verify memory usage with extremely large files

## Common Development Tasks

### Adding a new feature to the webview
1. Modify `getHtmlForWebview()` in csvEditor.ts to include HTML/CSS/JS
2. Add message handlers in the webview script
3. Add corresponding message handlers in the extension code

### Changing delimiter detection logic
1. Locate delimiter detection code in csvEditor.ts
2. Modify the auto-detection algorithm (likely scanning first N bytes)
3. Update configuration if adding new delimiter options

### Modifying large file thresholds
1. Update constants at top of csvEditor.ts
2. Consider memory implications
3. Test with real large files

### Adding new configuration options
1. Add to `contributes.configuration.properties` in package.json
2. Read config in csvEditor.ts via `vscode.workspace.getConfiguration('csvClearView')`
3. Pass to webview or use in extension logic

## Known Patterns & Conventions
- Webview HTML is generated as a string in TypeScript (not separate HTML file)
- Heavy use of async/await for file I/O
- Configuration is read fresh on each file open (not cached)
- Webview retains context when hidden (preserves state during tab switches)
- Row index uses sampling strategy to handle multi-GB files without OOM

## Performance Considerations
- Virtual scrolling for large datasets (only render visible rows)
- Chunked loading to avoid blocking UI
- Type inference samples max 1,000 rows (not entire file)
- Row index checkpoints prevent O(n) memory usage for massive files

## Release Management Guidelines

### ⚠️ CRITICAL: Release Approval Required
**NEVER package, version-bump, create a GitHub release, or publish to the marketplace without explicit user instruction.** The workflow is:
1. Make and commit code changes
2. Run tests
3. **Stop and wait** — ask the user if they want to test locally before releasing
4. Only proceed with packaging/releasing when the user explicitly says to

Local testing install command (for user reference, do NOT run automatically):
```bash
node_modules/.bin/vsce package
code --install-extension csv-clearview-x.x.x.vsix
```

### Version Release Process (only when explicitly requested)
1. **Changelog Update:** Always update the changelog before creating a new version. Ensure the changelog is complete and up to date before any release is made.
2. **README Update:** Update the README when a release is made to ensure:
   - The extension blurb is appealing to users searching the marketplace
   - The feature list is current and complete
   - Keywords are optimized for marketplace discoverability
   - Text is compelling for potential users
   - **Any new user-facing feature included in the release is documented here** — check the changelog entry against the README's feature list before tagging the release
3. **Version Bump:** Update the version number in package.json following semver by change type:
   - **Minor (1.X.0):** the release includes any new user-facing feature or re-enabled feature, even alongside bug fixes
   - **Patch (1.0.X):** the release is bug fixes / internal changes only, no new feature
   - **Major (X.0.0):** breaking changes — only when the user explicitly calls for it
   - When a release mixes a feature with bug fixes, the feature decides: bump minor, not patch.
4. **Build and Package:** Compile and package the extension:
   ```bash
   npm run compile
   node_modules/.bin/vsce package
   ```
5. **Git Commit and Tag:** Create commit and tag for the release:
   ```bash
   git add .
   git commit -m "chore: bump version to x.x.x"
   git tag -a vx.x.x -m "Release vx.x.x"
   git push && git push --tags
   ```
6. **Marketplace Publishing:** Do NOT push releases to the marketplace automatically. Always allow the user to explicitly request publishing. When approved, publish to BOTH the VS Code Marketplace and the Open VSX Registry:
   ```bash
   node_modules/.bin/vsce publish
   npx ovsx publish
   ```
7. **GitHub Release:** Create a GitHub release with the VSIX file attached:
   ```bash
   gh release create vx.x.x csv-clearview-x.x.x.vsix --title "vx.x.x - Release Title" --notes "Release notes from CHANGELOG"
   ```
   - Include release notes from the CHANGELOG
   - Attach the VSIX file for manual installation
   - Provide installation instructions

## Recent Bug Fixes (v1.0.1)
- **Scroll Position Preservation:** Fixed issue where sorting columns would reset horizontal scroll position. Now saves and restores `scrollLeft` on both `tableContainer` and `headerContainer` when sorting is triggered (media/csv.js lines ~2102-2110 and ~2199-2207)
- **PSV File Support:** Added proper language definition and activation event for `.psv` (pipe-separated values) files. Previously PSV files were only handled via custom editor selector without proper language registration, which prevented automatic activation.

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
|------|----------|
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
