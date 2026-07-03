---
name: package-extension
description: Compile, test, and package the VS Code extension into a .vsix file ready for publishing
disable-model-invocation: true
---

Run the full extension packaging pipeline from /Users/vinuthomas/code/CSV-Clear-View-for-VSCode:
1. `npm run test-compile` — type-check all TypeScript
2. `node tests/security.test.js` — run security tests
3. `npm run package` — webpack production build
4. `npx vsce package` — generate .vsix

Stop and report errors if any step fails. On success, show the output .vsix filename and size.
