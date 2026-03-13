# CSV ClearView for VS Code or Compatible IDE

[![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/v/VinuThomas.csv-clearview.svg)](https://marketplace.visualstudio.com/items?itemName=VinuThomas.csv-clearview)

A clear and powerful CSV viewer for VS Code with colored columns, sticky headers, SQL queries, and data profiling tools for data engineers and data scientists.

## Features

- **Colored Columns:** Each column is color-coded for easy reading (theme-aware for dark and light themes).
- **Sticky Header:** The header row stays fixed at the top while scrolling.
- **Alternating Rows:** Zebra-striping for improved row readability.
- **SQL Queries:** Run SQL queries directly on your CSV data (e.g., `SELECT * FROM ? WHERE [Price] > 100`). Only `SELECT` statements are permitted.
- **SQL Query History:** Past queries are stored (up to 50 entries). Press `↑`/`↓` in the query box to navigate history bash-style, or click the **History** button for a visual dropdown panel.
- **CSV Linting:** Automatically detects and reports rows with inconsistent column counts, with error markers in the scrollbar for quick navigation.
- **Native Diagnostics:** Parsing errors are surfaced in the VS Code Problems pane.
- **Cell Editing:** Double-click any cell to edit it in-place. Undo/Redo is fully supported.
- **Large File Support:** Files 500MB+ are supported via virtual scrolling — only visible rows are ever rendered. Head/Tail sampling is available for instant previews of massive files.
- **Delimiter Auto-Detection:** Automatically detects comma, tab, pipe, and semicolon delimiters from file content. A badge in the toolbar shows the active delimiter and can be clicked to override it. `.tsv`, `.tab`, and `.psv` files are supported natively.
- **Data Type Inference:** Column types (`integer`, `float`, `date`, `boolean`, `string`) are inferred by sampling up to 1,000 rows and shown as compact badges in every column header.
- **Column Sorting:** Click any column header to sort ascending, click again for descending, click a third time to clear. Sort is type-aware. Empty values always sort last.
- **Column Stats Popover:** Shift+click any column header to open a statistics card showing min, max, mean, median, std dev, percentiles (numeric), earliest/latest (date), null count, distinct count, and top-5 most frequent values.
- **Schema Summary Panel:** Click the **Profile** button to open a full column profile panel docked at the bottom — showing type, non-empty count, null %, distinct count, and min/max for every column. Click any row to open the detailed stats popover.
- **Freeze Pane:** Right-click any column header to freeze all columns up to and including that column (Excel/Sheets style). The frozen pane stays fixed during horizontal scrolling. Right-click to unfreeze.

## Usage

1. Open any `.csv`, `.tsv`, `.tab`, or `.psv` file — the custom editor activates automatically.
2. Use the SQL bar at the top to filter and query data. Use `?` as the table name.
   - Example: `SELECT * FROM ? WHERE [Department] = 'Sales' ORDER BY [Salary] DESC`
3. **Sort:** Click a column header. Shift+click to open the stats popover instead.
4. **Stats:** Shift+click any column header for detailed statistics.
5. **Profile:** Click the **Profile** button in the toolbar for a full schema summary panel.
6. **Freeze pane:** Right-click any column header → "Freeze pane here".
7. **Delimiter:** Click the delimiter badge in the toolbar to override auto-detection.
8. **Edit:** Double-click any cell to edit in-place.
9. For large files, choose **Head**, **Tail**, or **Plain Text** mode from the prompt on open.

## Settings

| Setting | Default | Description |
|---|---|---|
| `csvClearView.stickyHeader` | `true` | Enable/disable sticky header row. |
| `csvClearView.alternatingRows` | `true` | Enable/disable zebra-stripe row colors. |
| `csvClearView.safeModeThreshold` | `20` | File size (MB) above which large-file mode options are shown. |
| `csvClearView.forceTextColumnColoring` | `false` | Force column coloring in Plain Text mode (may affect performance). |
| `csvClearView.delimiter` | `auto` | Delimiter to use when parsing: `auto`, `,`, `\t`, `\|`, or `;`. |

## SQL Guide

- **Table name:** Always use `?`
- **Spaces in column names:** Use brackets — `[First Name]`
- **String values:** Use single quotes — `'Smith'`
- **Allowed statements:** Only `SELECT` queries. `DROP`, `DELETE`, `INSERT`, `UPDATE`, etc. are blocked.

## Supported File Types

| Extension | Delimiter |
|---|---|
| `.csv` | Auto-detected (usually `,`) |
| `.tsv`, `.tab` | Tab |
| `.psv` | Pipe (`\|`) |

## Development

### Prerequisites
- [Node.js](https://nodejs.org/) (includes npm)
- [Visual Studio Code](https://code.visualstudio.com/)

### Build and Install Locally

```bash
# Install dependencies
npm install

# Compile, package, and install locally into your VS Code
npm run compile
npx @vscode/vsce package
code --install-extension csv-clearview-0.4.0.vsix
```

### Debugging
1. Open the project folder in VS Code.
2. Press `F5` to open a new Extension Development Host window.
3. Open any `.csv` file in the new window to test your changes.

## License
MIT
