# CSV ClearView

A clear and powerful CSV viewer for VS Code with colored columns, sticky headers, and SQL query capabilities.

## Features

- **Colored Columns:** Each column is color-coded for easy reading.
- **Sticky Header:** The header row stays at the top while scrolling.
- **Alternating Rows:** Improved readability with zebra-striping.
- **SQL Queries:** Run SQL queries directly on your CSV data (e.g., `SELECT * FROM ? WHERE [Price] > 100`).
- **CSV Linting:** Automatically detects and reports rows with inconsistent column counts.
- **Hover Info:** Tooltips display column name and index.

## Usage

1. Open any `.csv` file.
2. The custom editor will automatically activate.
3. Use the search bar at the top to run SQL queries. Use `?` as the table name.
   - Example: `SELECT * FROM ? WHERE [Department] = 'Sales'`

## Settings

- `csvClearView.stickyHeader`: Enable/Disable sticky header (default: `true`).
- `csvClearView.alternatingRows`: Enable/Disable alternating row colors (default: `true`).

## SQL Guide
- **Table Name:** Always use `?`
- **Spaces in Columns:** Use brackets, e.g., `[First Name]`
- **Strings:** Use single quotes, e.g., `'Smith'`

## License
MIT
