# Contributing to CSV ClearView

Bug reports, ideas, and pull requests are welcome. Please open an
[issue](https://github.com/vinuthomas/CSV-Clear-View-for-VSCode/issues) first for
anything larger than a small fix, so we can agree on the approach.

## Prerequisites

- [Node.js](https://nodejs.org/) (includes npm)
- [Visual Studio Code](https://code.visualstudio.com/)

## Build and install locally

```bash
# Install dependencies
npm install

# Compile and package the extension
npm run compile
node_modules/.bin/vsce package

# Install into your VS Code (use the version that was just built)
code --install-extension csv-clearview-x.x.x.vsix
```

## Debugging

1. Open the project folder in VS Code
2. Press `F5` to launch the Extension Development Host
3. Open any `.csv` file in the new window to test your changes

## Tests and benchmarks

```bash
npm test            # unit tests (no VS Code needed)
npm run benchmark   # parse, paging, and SQL timings — see benchmark/README.md
```
