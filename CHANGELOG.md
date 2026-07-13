# Changelog

All notable changes to the "CSV ClearView" extension will be documented in this file.

## [1.3.0] - 2026-07-13

### Added

- **Excel (.xlsx) viewing (#17):** Open `.xlsx` workbooks directly — no more converting to CSV first. Each worksheet is rendered through the same colored grid, and gets the existing SQL query, column filter, profile, and export tooling for free. Multi-sheet workbooks show a **sheet-tab switcher** in the toolbar (styled with VS Code's own tab tokens so it doesn't blend into the regular toolbar buttons). Read-only for this release — no cell editing or save-back to `.xlsx` yet, and no support for the legacy binary `.xls` format. Parsing is powered by `exceljs`.

## [1.2.0] - 2026-07-08

### Added

- **Header toggle for headerless files (#15):** A new **Headers** toolbar button toggles whether the first row is treated as a header. When off, generic `Column 1..N` names are generated and the first row is shown as data — so filtering, sorting, column stats, and SQL queries (`WHERE [Column 1] = '…'`) work on files without a header row (e.g. exported logs). The synthetic header is never written back on save and is excluded from CSV exports. The new `csvClearView.firstRowIsHeader` setting (default `true`) sets the default for newly opened files, including huge files in Paged view.
- **Row & column count badge (#14):** The toolbar now shows a live badge with the total data rows and column count (e.g. `1,234 rows × 12 cols`). When column filters, a SQL query, or the duplicates view reduce the visible set, it switches to `56 of 1,234 rows (1,178 hidden) × 12 cols`.
- **Raw file view toggle (#13):** A new **Raw** toolbar button flips between the table and the underlying file text without reopening the editor, making it easy to inspect a row flagged with an unexpected extra column. Table-only controls are greyed out while the raw view is active; click **Table** to flip back. Parse-error banners and the raw view both include an **Open in Text Editor** button that reopens the file in VS Code's default text editor so the offending line can be fixed directly.

### Changed

- **Two-row toolbar:** The toolbar is split into a query row (full-width SQL input with History/Run/Reset) and a tools row (Export, Headers, Go to Row, Filter, Profile, Duplicates, Raw, with the delimiter and row-count badges right-aligned). The SQL input now spans nearly the whole editor width instead of competing with ten buttons on one row.

## [1.1.0] - 2026-07-06

### Added

- **Export toolbar button:** Replaces the old query-only **Save CSV** button. Opens a modal with two export scopes: **Full File** (JSON, Markdown table, or HTML table) and **Current View** (CSV, JSON, Markdown, or HTML) — the current view honors whatever filters, sort order, or SQL query results are currently displayed, while the full-file export always exports the complete, unfiltered data.

### Changed

- **Export format buttons now show a visible outline:** The JSON/Markdown/HTML/CSV buttons in the Export modal have a themed 1px border (matching the filter input styling) so they read clearly as buttons; the existing hover highlight is unchanged, with the border additionally brightening on hover.

## [1.0.15] - 2026-07-03

### Added

- **Column filters re-enabled:** The **Filter** toolbar button is back, letting you show a per-column filter row and narrow rows by substring match. It had been hidden since 1.0.9-era builds due to a focus/scroll bug (see Fixed below).

### Fixed

- **Filter input lost focus and scroll position on every keystroke:** Typing into a column filter box re-rendered the whole table on each character, which blurred the input and reset horizontal scroll — making it impossible to type more than one character without re-clicking the field. The filter row's scroll position and the focused input's cursor position are now preserved across re-renders.

## [1.0.14] - 2026-06-11

### Added

- **Histogram distribution chart in column stats popover:** Shift+clicking a numeric (integer or float) column header now renders an inline SVG histogram below the existing statistics table. Values are bucketed into 10 equal-width ranges and drawn as vertical bars scaled to the tallest bucket. Hovering any bar shows the exact value range and row count in a tooltip. The chart adapts to the VS Code color theme. For columns where all values are identical, a single full-height bar is shown.
- **Save SQL query results as CSV:** After running a SQL query, a **Save CSV** button appears in the toolbar next to Reset. Clicking it opens a native VS Code save dialog (defaulting to `query-result.csv`) and writes the filtered or aggregated result as a properly quoted RFC-4180 CSV file. The button disappears when the view is reset to the original data.

## [1.0.13] - 2026-06-09

### Fixed

- **CSV parsing — bare embedded quotes no longer truncate field values:** Fields containing a `"` character in the middle of an otherwise unquoted value (e.g. `She said "hello"`) were being corrupted — everything up to and including the embedded quote was discarded, leaving only the partial text after the last quote. Values are now preserved verbatim.
- **Cell editing on large files now writes to the correct row:** When editing a cell in a file with more than ~333 000 rows, the virtual-scroll spacer scaling was not applied when calculating which row was visible. Edits were silently written to the wrong row, potentially thousands of rows away from the one the user clicked. The correct `scrollTopToRow()` helper is now used.
- **RFC-4180 mid-field escaped quotes handled correctly in paged (chunked) mode:** The byte-level row indexer (`buildRowIndex`) and row reader (`readRows`) each used different logic for handling `""` escape sequences inside quoted fields. `buildRowIndex` set `prevWasQuote` correctly only on the opening `"`, so any `""` pair not immediately at field-open was misread — `inQuotes` toggled off at the wrong byte, misaligning every subsequent row boundary for files opened in chunked (>500 MB) mode. Both scanners now use consistent deferred-close logic: a `"` inside a quoted field sets a flag and the decision is deferred to the next byte, correctly distinguishing a `""` escape from a closing quote.
- **Whitespace-only cells no longer coerced to `0` in SQL queries:** Cells containing only spaces or tabs passed the numeric-coercion guard (`Number(' ') === 0`, `isNaN(0) === false`) and were stored as the number `0` in the SQL query engine. This caused incorrect `SUM`, `AVG`, and `WHERE` results and could corrupt exported data. The guard now trims the value before testing.
- **Rapid file saves no longer drop the second render:** When two `update` messages arrived within the 50 ms debounce window, the second scheduled render found `isUpdating = true` (set by the first) and silently returned, leaving the view showing stale content. A `pendingUpdateTimeout` handle now cancels any in-flight timer so only the latest update is rendered.
- **Row index rebuild uses current file size after file growth:** `ensureIndex` was passing `document.size` (frozen at the time the editor was opened) to `buildRowIndex`. If the file grew after opening, the index stopped at the original EOF. The current size is now fetched with a fresh `stat` call before each rebuild.
- **Tail view no longer reads from past EOF after file shrinks:** The tail-mode offset calculation used the stale `document.size` to compute `currentSize - tailSize`. If the file shrank after the editor was opened, the offset exceeded the new file size and the read returned an empty buffer. The current file size is now obtained with a fresh `stat` call before computing the offset.
- **Page-load errors in chunked mode now shown to the user:** Errors thrown while serving a page request in chunked mode were only logged to the console. The loading spinner stayed active indefinitely with no feedback. Errors are now forwarded to the webview as a visible error message.
- **`readRange` TOCTOU eliminated:** `readRange` previously called `vscode.workspace.fs.stat` and then `fs.openSync` as two separate operations. A file replacement between the two calls could produce a buffer padded with zeros. The stat call is removed; `fs.readSync`'s actual return value is used to slice the buffer to the correct length, giving a consistent read in a single open/read/close sequence.

## [1.0.12] - 2026-05-21

### Fixed

- **SQL Module Lazy Loading:** Fixed an issue where running SQL queries would throw a `Cannot find module 'alasql'` error. The `alasql` dependency was accidentally omitted from the published extension package when moving to lazy loading. It is now properly bundled inside the VSIX.

## [1.0.11] - 2026-05-21

### Fixed

- **Security Updates:** Updated `alasql` from `4.17.0` to `4.17.2` to resolve potential vulnerabilities and improved lazy-loading mechanism.

## [1.0.10] - 2026-05-19

### Fixed

- **Open VSX Registration:** Resolved a casing issue with the `publisher` field in `package.json` that was preventing the extension's icon from displaying correctly on the Open VSX registry.

## [1.0.9] - 2026-05-19

### Fixed

- **Open VSX Support:** Added Open VSX support by publishing to the Open VSX registry. Updated `package.json` to properly declare the publisher namespace. Added installation instructions to the README.

## [1.0.8] - 2026-04-30

### Added

- **Open with CSV ClearView command:** Any file — regardless of extension — can now be opened in the CSV ClearView editor via a new command. Right-click any file in the Explorer or editor tab and choose **"Open with CSV ClearView"**, or invoke it from the Command Palette (`CSV ClearView: Open with CSV ClearView`). This makes it easy to inspect `.txt`, `.dat`, `.log`, or any other delimiter-separated file using the full CSV ClearView interface.

## [1.0.7] - 2026-04-29

### Added

- **Go to Row:** New toolbar button opens a modal where you can type any row number and jump directly to it. The target row flashes briefly to confirm navigation. Works in both normal and paged (chunked) view modes.
- **Duplicate Row Detection:** New **Duplicates** toolbar button scans all rows and highlights duplicates with an amber tint. A banner reports the number of duplicate rows and how many groups they form.
  - **Show only duplicates:** Switches to a focused view that hides all non-duplicate rows, groups matching rows together, and adds a **#** line number column showing the original CSV line number of each row — so you can immediately locate duplicates in the source file.
  - **Group separators:** A thin divider visually separates each duplicate group.
  - **Show all rows / Dismiss:** Restore the full table or clear the duplicate highlights at any time.
  - Not available in Paged View mode (chunked files).

### Changed

- **Toolbar redesign:** All toolbar buttons now use a unified ghost style. Only the **Run** (SQL execute) button uses the primary blue accent. Dividers separate the SQL tools from the analysis tools, reducing visual noise.

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
