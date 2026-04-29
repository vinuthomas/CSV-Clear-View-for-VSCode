# Changelog

All notable changes to the "CSV ClearView" extension will be documented in this file.

## [1.0.6] - 2026-04-28

### Security

- **Dependency updates:** Updated `@vscode/vsce` (3.7.1 → 3.9.1), `alasql` (4.17.0 → 4.17.2), `webpack` (5.105.0 → 5.106.2), and `ts-loader` (9.5.4 → 9.5.7) to pull in latest security patches and bug fixes.

### Changed

- **Minimum VS Code version:** Bumped `engines.vscode` from `^1.75.0` to `^1.109.0` for compatibility with updated `@vscode/vsce` packaging tool.

## [1.0.5] - 2026-04-21

### Fixed

- **SQL aggregation functions (AVG, SUM, MIN, MAX):** Numeric CSV values are now correctly coerced to numbers before being passed to the SQL engine. Previously, all values were strings, causing aggregation functions like `AVG([Price])` to silently drop the result column. Queries such as `SELECT [Product], COUNT(*) as [count], AVG([Price]) as avg_price FROM ? GROUP BY [Product]` now return all expected columns.
- **`inferColumnTypes` crash on numeric query results:** Fixed a `trim is not a function` error that occurred when rendering SQL query results containing numeric values (e.g. from `COUNT(*)` or `AVG()`). Values are now safely coerced to strings before type inference.

### Changed

- **README:** Added a note to the SQL Query Guide clarifying that column names are case-sensitive and must match the header row exactly.

## [1.0.4] - 2026-04-21

### Fixed

- **SQL double-quote detection:** When a query uses double quotes around a string value (e.g. `WHERE [Col]="value"`), a clear, actionable error message is now shown — *"Use single quotes for string values, not double quotes. Example: WHERE [Column]='value'"* — instead of AlaSQL's cryptic internal parse error. Bracket-quoted column names (e.g. `[Col"Name]`) are correctly excluded from this check.

## [1.0.3] - 2026-04-21

### Security

- **Eliminated `unsafe-eval` from Content Security Policy:** SQL queries are now executed on the extension host (Node.js) instead of the webview. The `alasql` library is bundled into the extension host via webpack, and queries are dispatched via `postMessage`. The webview CSP is now nonce-only with no `unsafe-eval`.
- **Server-side SQL validation:** Added defence-in-depth SQL validation on the extension host in addition to the existing webview-side checks. Blocks semicolons (multi-statement injection), `ATTACH`, `DETACH`, `PRAGMA`, `SHOW TABLES`, `SHOW DATABASES`, and `SET OPTION` commands.
- **Expanded webview SQL validation:** Extended the blocked-keyword list with AlaSQL-specific bypass commands: `ATTACH`, `DETACH`, `SOURCE`, `PRAGMA`, `SHOW TABLES`, `SHOW DATABASES`, `SET OPTION`. Semicolons are now explicitly blocked.
- **Fixed message origin check:** The webview message listener now correctly handles VS Code's empty-string `event.origin` (previously a truthy guard skipped the check entirely when origin was `''`).

### Fixed

- **File system watcher listener leak:** The `onDidChange` listener disposable returned by `createFileSystemWatcher` is now stored and disposed when the editor panel closes.
- **`buildRowIndex` escaped-quote tracking:** The byte-level row-index scanner now correctly handles `""` (escaped double-quote inside a quoted field) without toggling `inQuotes` twice and misidentifying newlines inside quoted fields as row boundaries.
- **`escapeHtml` null/undefined safety:** `escapeHtml` now returns `''` for `null` or `undefined` inputs and coerces all values via `String()`, preventing uncaught `.replace()` errors when rendering cell data.
- **Date type inference:** Date columns now require a recognisable date pattern (ISO 8601, `YYYY/MM/DD`, `DD/MM/YYYY`, etc.) before falling back to `new Date()` parsing, preventing plain numbers and short strings from being mis-classified as dates.
- **`dataToCSV` CRLF preservation:** When serialising edited data back to CSV, the original file's line endings (CRLF vs LF) are now detected and preserved. Cells containing `\r` are also correctly quoted.
- **Tooltip row index on large files:** The hover tooltip row number now uses `scrollTopToRow()` (which accounts for virtual-spacer scaling on files with millions of rows) instead of the naive `Math.floor(scrollTop / rowHeight)` formula.
- **`saveDocument` error surfacing:** File-write errors are now reported to the user via `vscode.window.showErrorMessage` instead of being silently swallowed.

### Changed

- **`onDidChangeCustomDocument` EventEmitter stored as class field:** The emitter is now held as `_onDidChangeCustomDocumentEmitter` so it can be properly disposed if needed, rather than being created inline and immediately discarded.
- **`chunkedCache` hard size cap:** Added a 50-page hard cap as a backstop against unbounded memory growth in paged view mode (the existing ±15-page eviction window remains the primary eviction mechanism).
- **`fs` module import hoisted to module level:** Replaced all inline `require('fs')` calls inside methods with a single `import * as fs from 'fs'` at the top of `csvEditor.ts`.
- **`@vscode/vsce` moved to devDependencies:** The packaging tool is a build-time dependency, not a runtime one.
- **TypeScript upgraded to 5.x (5.9.3):** Updated TypeScript and `@types/node` (to v18) for stricter type checking and modern language features.
- **Replaced `var` with `const`/`let`** in autocomplete and helper functions in `csv.js`.

### Tests

- Expanded test suite from 87 to 119 tests covering all new and changed behaviour: semicolon/AlaSQL SQL blocking, CRLF roundtrip, `escapeHtml` edge cases, backend source assertions (no `unsafe-eval`, alasql host import, `runQuery` handler, watcher listener disposal, `fs` module import), and frontend source assertions (origin check, postMessage dispatch, `DATE_PATTERN`, `MAX_CACHED_PAGES`).



### Added

- **PSV Language Support:** Added complete language definition for `.psv` (pipe-separated values) files in package.json with proper activation events, ensuring PSV files automatically open in CSV ClearView.
- **Sample PSV File:** Added `samples/sample_data.psv` with employee data for testing PSV functionality.

### Changed

- **README Improvements:** Completely overhauled README with more compelling marketplace copy, better organization, keyword optimization, and detailed use cases for data engineers, analysts, scientists, developers, and DBAs.
- **Documentation:** Updated context file (`.agents`) with correct packaging instructions and PSV support details.

### Fixed

- **CHANGELOG Completeness:** Added missing release notes for v1.0.0 and v0.3.6, ensuring all historical releases are properly documented.

## [1.0.1] - 2026-04-14

### Fixed

- **Column Sort Scroll Position:** Fixed an issue where clicking a column header to sort would reset the horizontal scroll position, causing the view to jump back to the left. The horizontal scroll position is now preserved when sorting, keeping users oriented in wide CSV files.
- **PSV Language Registration:** Added proper language definition and activation event for `.psv` (pipe-separated values) files. Previously PSV files lacked language registration in package.json, which could prevent automatic activation when opening PSV files.

## [1.0.0] - 2026-04-08

### Security

- **Cryptographic Nonce Generation:** Fixed CSP nonce generation to use `crypto.randomBytes()` instead of `Math.random()`, ensuring cryptographically secure random values for Content Security Policy.

### Changed

- **Dependency Updates:** Updated security-related dependencies:
  - `brace-expansion` 1.1.12 → 1.1.13 (security fix GHSA-f886-m6hf-6m8v)
  - `picomatch` 2.3.1 → 2.3.2 (fixes CVE-2026-33671 and CVE-2026-33672)
  - `yaml` 2.8.2 → 2.8.3 (stack overflow fix)
- **Version:** Bumped to 1.0.0 to signify production readiness and maturity of the extension.

## [0.4.0] - 2026-03-13

### Added

- **Delimiter Auto-Detection:** CSV ClearView now automatically detects the delimiter from file content (comma, tab, pipe, semicolon) using a statistical heuristic. File extension hints take priority (`.tsv`/`.tab` → tab, `.psv` → pipe). A delimiter badge in the toolbar shows the active delimiter and can be clicked to override it manually.
- **TSV and PSV support:** `.tsv`, `.tab`, and `.psv` files now open natively in CSV ClearView without any configuration.
- **Data Type Inference:** Column types (`integer`, `float`, `date`, `boolean`, `string`) are inferred automatically by sampling up to 1,000 rows. Types are re-evaluated after SQL queries and resets.
- **Type Badges:** A compact badge inside every column header shows the inferred type at a glance (`#` integer, `1.0` float, `date`, `T/F` boolean, `abc` string).
- **Column Sorting:** Click any column header to sort ascending, click again for descending, click a third time to clear. Sort is type-aware (numeric, date, locale string). Empty values always sort last. Sort direction is shown with `▲`/`▼` indicators.
- **Column Stats Popover:** Shift+click any column header to open a floating statistics card for that column.
  - All types: total rows, non-null count, null count, distinct count, top-5 most frequent values with a mini bar chart.
  - Numeric columns: min, max, mean, median, standard deviation, p25, p75.
  - Date columns: earliest and latest value.
  - String columns: min, max, and average character length.
- **Schema Summary Panel:** Click the **Profile** button in the toolbar to open a docked bottom panel showing a full column profile — name, type, non-empty count, null % bar, distinct count, and min/max for every column. Clicking any row in the panel opens the full stats popover for that column.
- **Freeze Pane:** Right-click any column header to freeze all columns from the first column through that column as a contiguous pane (Excel/Sheets style). The frozen pane scrolls with the vertical axis but stays fixed during horizontal scrolling. Right-click again to unfreeze.
- **New config setting:** `csvClearView.delimiter` — set to `auto` (default), `,`, `\t`, `|`, or `;`.

### Fixed

- **Stats Popover not opening on Shift+click:** The outside-click dismiss handler was checking `e.target.classList` directly, which failed when clicking a child element (badge or label span) inside the header cell. Changed to `e.target.closest()` so the popover stays open correctly.
- **Freeze pane header displacement:** The frozen overlay was being inserted into the flex layout flow rather than as an absolutely positioned layer, pushing the header row downward. Introduced a `.table-area` wrapper with `position: relative` so the overlay sits on top without affecting layout.
- **Freeze pane column misalignment:** Using `padding-left` on the scrollable containers to offset the main table past the frozen pane caused misalignment between the header and body rows under horizontal scrolling. Replaced with a real spacer `<col>`/`<th>`/`<td>` as the first element of both the header and body tables, guaranteeing pixel-perfect alignment via shared `table-layout: fixed` geometry.

## [0.3.6] - 2026-03-13

### Fixed

- **Paged View — Last Page Loading:** Fixed issue where scrolling to the very bottom of a large file (including CMD+Down) failed to show the final rows. Row index calculations are now properly clamped to valid ranges.
- **Paged View — Jump-to-End Timing:** Fixed bug where pressing CMD+Down immediately after opening a large file (before row index finished building) would show the wrong page. The indexReady handler now properly invalidates and refetches the correct page.
- **Paged View — Placeholder Rendering:** Fixed issue where loading placeholders were never replaced with actual data due to an overly aggressive deduplication guard. Added `chunkedLoadedPageHasData` flag to allow placeholder-to-data upgrades.
- **Paged View — Backward Scrolling:** Added backward prefetch (currentPage - 1) to eliminate brief placeholder flashes when scrolling upward through large files.

## [0.3.2] - 2026-03-09

### Security
- **Prototype Pollution Protection:** CSV headers like `__proto__`, `constructor`, and `prototype` are now safely renamed, and data objects use null prototypes to prevent pollution attacks.
- **SQL Query Restriction:** Only `SELECT` queries are now allowed. Dangerous statements (`DROP`, `DELETE`, `INSERT`, `UPDATE`, `CREATE`, `ALTER`, `TRUNCATE`, `EXEC`) are blocked.
- **Webview Message Validation:** Added origin validation on incoming webview messages and type/size validation on edit payloads before writing to disk.
- **Cryptographic Nonce:** Replaced `Math.random()` with `crypto.randomBytes()` for CSP nonce generation.
- **Restricted Resource Access:** Added `localResourceRoots` to limit webview file access to the `media/` folder only.
- **Safe DOM Construction:** Replaced `innerHTML`-based autocomplete rendering with `createElement`/`textContent` to eliminate DOM injection risks.
- **File Descriptor Safety:** Fixed a potential file descriptor leak in the range-read function using `try/finally`.
- **Dependency Updates:** Resolved all known npm audit vulnerabilities (ajv, minimatch, serialize-javascript).

### Fixed
- **Scrollbar Dragging:** Fixed a bug where the vertical scrollbar could not be dragged because the error ruler overlay was intercepting pointer events.

### Removed
- Cleaned up unused diagnostics collection that was allocated but never populated.

## [0.3.1] - 2026-03-02

### Added
- **SQL Query History:** Past queries are stored (up to 50 entries, most-recent first) and can be navigated directly from the query input.
  - Press `↑` / `↓` in the query box to step through history bash-style; your current draft is preserved and restored when you navigate back.
  - Click the new **History** button to open a visual dropdown panel listing all past queries.
  - Use `↑` / `↓` inside the panel to highlight an entry (the input previews it live), then press `Enter` or click to select it for editing and re-running as a new query.
  - Press `Escape` to dismiss the panel without changing the input.

## [0.3.0] - 2026-02-11

### Added
- **Architectural Overhaul:** Migrated from `CustomTextEditorProvider` to `CustomEditorProvider`. This allows the extension to bypass VS Code's internal `TextDocument` memory limits for extremely large files.
- **Improved Large File Support:** Successfully tested with files up to 500MB. Users can now instantly "Show Head" or "Show Tail" of massive files by reading only the necessary chunks from disk.

### Fixed
- **Assertion Failed Error:** Fixed a critical "Assertion Failed" error that occurred when attempting to open CSV files larger than 50-100MB.

## [0.2.9] - 2026-02-10

### Optimized
- **Editing Performance:** Eliminated the full webview refresh when editing cells. The extension now intelligently bypasses re-rendering for local changes while still maintaining full support for Undo/Redo and external file edits.

## [0.2.8] - 2026-02-10

### Fixed
- **Header Alignment:** Resolved a pixel-mismatch issue when scrolling all the way to the right by adding scrollbar compensation.
- **Error Navigation:** Fixed the scroll offset when jumping to errors from the scrollbar markers.
- **Edit Mode:** Improved the editing experience for extremely long text fields.

## [0.2.7] - 2026-02-10

### Added
- **Scroll Preservation:** The extension now remembers and restores your exact scroll position (vertical and horizontal) when saving or refreshing the file.
- **Improved Editing:** Cells now automatically select all text on double-click and expand to show full content without ellipses during editing.

### Fixed
- **Edit-Mode Navigation:** Fixed a bug where using arrow keys at the end of a cell would cause it to lose focus.
- **Internal Overlays:** Hidden internal scrollbars in editing cells to prevent them from obscuring text content.

## [0.2.6] - 2026-02-10

### Changed
- **Large File Threshold:** Increased the default threshold for safe mode from 5MB to 20MB.


### Added
- **Virtual Scrolling:** Implemented a high-performance virtual rendering engine. Large CSV files (100MB+) now load and scroll instantly by only rendering visible rows.
- **Split-Table Architecture:** Rewrote the grid layout to separate headers from the body, ensuring perfectly stationary sticky headers even during virtual scrolling.
- **Data-Aware Sizing:** Column widths are now intelligently calculated by sampling the actual data content, ensuring long text is readable.

### Fixed
- **Persistent Dialogs:** The large-file selection menu now correctly closes if you switch to another file or close the editor.
- **SQL Virtualization:** Fixed a bug where SQL queries would incorrectly display the full file instead of filtered results when virtual scrolling was enabled.
- **Column Alignment:** Guaranteed pixel-perfect alignment between headers and data using synchronized `<colgroup>` elements.

## [0.2.3] - 2026-02-09

### Added
- **Theme-Aware Colors:** Column colors now automatically adjust for light themes to ensure high contrast and readability.

## [0.2.2] - 2026-02-09

### Added
- **Extension Icon:** Added a official logo for the extension to the VS Marketplace.

## [0.2.1] - 2026-02-09

### Changed
- **Marketplace Preparation:** Updated package manifest with publisher information, repository links, and bug tracker for official release.

## [0.2.0] - 2026-02-06

### Added
- **Enhanced Large File Handling:** New QuickPick menu when opening large files with options for Head, Tail, or Plain Text views.
- **Plain Text Mode:** Instant view for very large files with high-performance CSS-based row stripes.
- **Error Ruler:** Visual markers in the scrollbar area for quick navigation to parsing errors.
- **Native Diagnostics:** Integration with the VS Code "Problems" pane for CSV structural errors.
- **Async Rendering:** Chunked table generation to ensure the UI remains responsive during large file loads.
- **New Settings:** 
  - `csvClearView.safeModeThreshold`: Configure the file size limit for safe mode.
  - `csvClearView.forceTextColumnColoring`: Enable experimental column coloring in plain text mode.
- **Loading UI:** Added a progress bar and overlay during data processing.

## [0.1.1] - 2026-02-06

### Fixed
- **Error Ruler Position:** Fixed alignment of the error ruler when error banners are displayed.
- **CSV Linting:** Improved parsing logic to correctly handle quoted fields containing newlines.

## [0.1.0] - 2026-02-04

### Added
- **Colored Columns:** Each column is color-coded for easy reading.
- **Sticky Header:** The header row stays at the top while scrolling.
- **Alternating Rows:** Improved readability with zebra-striping.
- **SQL Queries:** Run SQL queries directly on your CSV data using `alasql`.
- **CSV Linting:** Automatically detects and reports rows with inconsistent column counts.
- **Hover Info:** Tooltips display column name and index.
- Initial release of CSV ClearView.
