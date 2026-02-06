# Changelog

All notable changes to the "CSV ClearView" extension will be documented in this file.

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
