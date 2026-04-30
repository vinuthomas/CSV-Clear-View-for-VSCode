# CSV ClearView - The Ultimate CSV Editor for VS Code

[![Visual Studio Marketplace](https://vsmarketplacebadges.dev/version/VinuThomas.csv-clearview.svg)](https://marketplace.visualstudio.com/items?itemName=VinuThomas.csv-clearview)
[![Downloads](https://vsmarketplacebadges.dev/downloads/VinuThomas.csv-clearview.svg)](https://marketplace.visualstudio.com/items?itemName=VinuThomas.csv-clearview)

**Transform your CSV workflow with a powerful, spreadsheet-like editor built for data engineers, analysts, and scientists.** CSV ClearView brings enterprise-grade CSV viewing and editing to VS Code with color-coded columns, in-editor SQL queries, advanced data profiling, duplicate detection, and seamless handling of files up to 500MB+.

## Why CSV ClearView?

Stop switching between VS Code and Excel. CSV ClearView delivers a **complete data exploration experience** without leaving your editor:

- **📊 Work with massive files** - Handle 500MB+ CSV files with virtual scrolling and instant head/tail sampling
- **🔍 Query your data instantly** - Run SQL SELECT queries directly on your CSV without external tools
- **📈 Understand your data** - Built-in statistics, type inference, and data profiling for every column
- **🎨 Stay oriented** - Color-coded columns, sticky headers, and freeze panes keep you focused
- **✏️ Edit with confidence** - In-place cell editing with full undo/redo support
- **🔎 Find duplicates instantly** - One-click duplicate detection with grouped, line-numbered results
- **⚡ Lightning fast** - Virtual rendering keeps even the largest files responsive

Perfect for data analysis, ETL pipeline debugging, machine learning dataset inspection, log file analysis, and database exports.

## Key Features

### 🎨 Visual Clarity
- **Colored Columns:** Each column is automatically color-coded for instant visual separation (adapts to dark/light themes)
- **Sticky Header:** Header row stays fixed at the top while scrolling through thousands of rows
- **Alternating Rows:** Zebra-striping for improved row readability
- **Freeze Panes:** Right-click any column header to freeze it Excel-style for easy comparison

### 🔍 Data Analysis & Profiling
- **SQL Queries:** Run full SQL SELECT statements on your CSV data (powered by AlaSQL)
  - Example: `SELECT * FROM ? WHERE [Price] > 100 ORDER BY [Date] DESC`
  - Query history with bash-style ↑/↓ navigation (stores up to 50 queries)
- **Column Statistics:** Shift+click any column header for instant stats
  - Numeric: min, max, mean, median, std dev, percentiles
  - Date: earliest, latest
  - String: length stats, frequency distribution
  - All: null count, distinct values, top-5 most common values
- **Data Type Inference:** Automatic detection of integers, floats, dates, booleans, and strings with visual badges
- **Schema Summary Panel:** Click **Profile** for a complete data dictionary showing type, nulls, distinct count, and ranges for every column

### 🔎 Duplicate Detection
- **One-click scan:** Click **Duplicates** to instantly find all duplicate rows across the entire file
- **Grouped view:** "Show only duplicates" hides non-duplicate rows and groups matching rows together with a thin divider between each group
- **Original line numbers:** A **#** column shows the exact CSV line number of every duplicate row so you can find it in the source file immediately
- **Amber highlights:** Duplicate rows are tinted amber in the normal view for quick visual scanning
- **Non-destructive:** Dismiss or restore the full table at any time — your data is never changed

### 🧭 Navigation
- **Go to Row:** Jump to any row by number instantly — the target row flashes to confirm navigation
- **Error markers:** Visual markers in the scrollbar for quick jumping to parsing errors

### 📊 Large File Support
- **Virtual Scrolling:** Handle 500MB+ files with only visible rows rendered
- **Head/Tail Sampling:** Instant preview of massive files without loading everything
- **Smart Chunking:** Files are processed in chunks to keep VS Code responsive
- **Configurable Thresholds:** Set your own limits for when large-file mode kicks in

### ✏️ Editing & Validation
- **In-Place Cell Editing:** Double-click any cell to edit with full undo/redo support
- **CSV Linting:** Automatic detection of rows with inconsistent column counts
- **Native Diagnostics:** Parsing errors surface in VS Code's Problems pane

### 🔧 Format Flexibility
- **Auto-Delimiter Detection:** Automatically recognizes comma, tab, pipe, and semicolon delimiters
- **Multi-Format Support:** `.csv`, `.tsv`, `.tab`, `.psv` files open natively
- **Manual Override:** Click the delimiter badge in the toolbar to change parsing
- **Type-Aware Sorting:** Click column headers to sort with intelligent handling of numbers, dates, and strings

## Use Cases

✅ **Data Engineers** - Debug ETL pipelines, validate transformations, inspect data quality  
✅ **Data Scientists** - Quick dataset exploration, feature analysis, ML data validation  
✅ **Analysts** - Ad-hoc SQL queries, statistical summaries, large report inspection  
✅ **Developers** - Log file analysis, database export review, test data generation  
✅ **DBAs** - Query result inspection, data migration validation, schema analysis

## Quick Start

1. **Open any CSV file** - Just open `.csv`, `.tsv`, `.tab`, or `.psv` files and CSV ClearView activates automatically
2. **Query your data** - Type SQL in the query bar at the top: `SELECT * FROM ? WHERE [Department] = 'Sales' ORDER BY [Salary] DESC`
3. **Find duplicates** - Click **Duplicates** to scan for duplicate rows, then **Show only duplicates** to see them grouped with original line numbers
4. **Jump to any row** - Click **Go to Row** and type a row number to navigate instantly
5. **Explore statistics** - Shift+click any column header for detailed stats or click **Profile** for a full data summary
6. **Sort and freeze** - Click column headers to sort, right-click to freeze panes
7. **Edit cells** - Double-click any cell to edit in-place with undo/redo support
8. **Handle large files** - For 20MB+ files, choose **Head**, **Tail**, or **Plain Text** mode when prompted

## Configuration

Customize CSV ClearView through VS Code settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `csvClearView.stickyHeader` | `true` | Keep header row fixed at top while scrolling |
| `csvClearView.alternatingRows` | `true` | Enable zebra-stripe row coloring |
| `csvClearView.safeModeThreshold` | `20` | File size (MB) to trigger large-file mode options |
| `csvClearView.forceTextColumnColoring` | `false` | Force column coloring in Plain Text mode (may impact performance) |
| `csvClearView.delimiter` | `auto` | Delimiter: `auto`, `,`, `\t`, `\|`, or `;` |

## SQL Query Guide

CSV ClearView includes a full SQL engine (AlaSQL) for ad-hoc data analysis:

- **Table name:** Always use `?` to reference your CSV data
- **Column names with spaces:** Wrap in brackets: `[First Name]`, `[Unit Price]`
- **Column names are case-sensitive:** `[Price]` and `[price]` are treated as different columns — use the exact casing from the header row
- **String literals:** Use single quotes: `'Smith'`, `'New York'`
- **Allowed operations:** Only `SELECT` statements (safety restriction)
- **Blocked operations:** `DROP`, `DELETE`, `INSERT`, `UPDATE`, `CREATE`, `ALTER`, etc.

**Example queries:**
```sql
-- Filter and sort
SELECT * FROM ? WHERE [Age] > 25 ORDER BY [Salary] DESC

-- Aggregate statistics
SELECT [Department], COUNT(*) as count, AVG([Salary]) as avg_salary 
FROM ? GROUP BY [Department]

-- Complex conditions
SELECT * FROM ? WHERE [Status] = 'Active' AND [Revenue] > 10000
```

## Supported File Formats

| Extension | Delimiter | Notes |
|-----------|-----------|-------|
| `.csv` | Auto-detected | Usually comma, but intelligently detects tab, pipe, semicolon |
| `.tsv`, `.tab` | Tab | Tab-separated values |
| `.psv` | Pipe (`\|`) | Pipe-separated values |

CSV ClearView automatically detects the delimiter but you can override it using the toolbar badge.

## What's New

See the [CHANGELOG](changelog.md) for detailed release notes.

### Latest Release (v1.0.7)
- **New: Duplicate Row Detection** — One-click scan finds all duplicate rows, highlights them in amber, and groups them in a focused view with original CSV line numbers so you can locate duplicates in the source file instantly
- **New: Go to Row** — Jump to any row by number with a single keystroke; the target row flashes to confirm
- **Toolbar redesign** — Cleaner unified button style with logical groupings

### Recent Highlights (v1.0.3–v1.0.6)
- Moved SQL execution to the extension host — removed `unsafe-eval` from Content Security Policy
- Fixed SQL aggregation functions (AVG, SUM, MIN, MAX) on numeric CSV columns
- Better SQL error messages for common mistakes (double quotes, etc.)
- Dependency and security updates

## Development

### Prerequisites
- [Node.js](https://nodejs.org/) (includes npm)
- [Visual Studio Code](https://code.visualstudio.com/)

### Build and Install Locally

```bash
# Install dependencies
npm install

# Compile and package the extension
npm run compile
node_modules/.bin/vsce package

# Install into your VS Code
code --install-extension csv-clearview-1.0.7.vsix
```

### Debugging
1. Open the project folder in VS Code
2. Press `F5` to launch the Extension Development Host
3. Open any `.csv` file in the new window to test your changes

## Keywords

CSV, TSV, viewer, editor, table, grid, spreadsheet, data analysis, SQL queries, data profiling, statistics, large files, virtual scrolling, duplicate detection, delimiter detection, data science, ETL, pipe-separated, tab-separated, data visualization, column sorting, data validation, go to row, row navigation

## License
MIT

---

**Made with ❤️ for the data community** | [Report Issues](https://github.com/vinuthomas/CSV-Clear-View-for-VSCode/issues) | [Contribute](https://github.com/vinuthomas/CSV-Clear-View-for-VSCode)
