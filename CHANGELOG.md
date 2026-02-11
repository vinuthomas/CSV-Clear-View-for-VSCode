# Changelog

All notable changes to the "CSV ClearView" extension will be documented in this file.

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
