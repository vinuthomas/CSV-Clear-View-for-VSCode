# CSV ClearView for VS Code or Compatible IDE
A clear and powerful CSV viewer for VS Code with colored columns, sticky headers, and SQL query capabilities. This should work on other IDE which also load Visual Code style plugins. 

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
- `csvClearView.safeModeThreshold`: File size threshold (in MB) above which Safe Mode options are shown for large files (default: `5`).
- `csvClearView.forceTextColumnColoring`: Force column coloring in Plain Text mode. Performance may vary on very large files (default: `false`).

## SQL Guide
- **Table Name:** Always use `?`
- **Spaces in Columns:** Use brackets, e.g., `[First Name]`
- **Strings:** Use single quotes, e.g., `'Smith'`

## Development

### Prerequisites
- [Node.js](https://nodejs.org/) (includes npm)
- [Visual Studio Code](https://code.visualstudio.com/)

### Build and Install Locally
To build the extension and install it in your local VS Code instance, run:

```bash
# Install dependencies
npm install

# Compile, package, and install locally into your VS Code
npm run compile
npx @vscode/vsce package
code --install-extension csv-clearview-0.2.0.vsix --force
```

### Debugging
1. Open the project folder in VS Code.
2. Press `F5` to open a new Extension Development Host window.
3. Open any `.csv` file in the new window to test your changes.

## License
MIT
