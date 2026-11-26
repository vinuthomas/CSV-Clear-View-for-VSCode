# CSV ClearView — Backlog

Planned work, roughly in priority order. Nothing here is scheduled for a release
until explicitly requested — see "Release Management Guidelines" in `AGENTS.md`.

---

## Expand nested JSON columns

**Status:** planned, not started
**Target:** minor bump (new user-facing feature)

JSONL and Parquet put nested objects/arrays in one cell as JSON text (lossless,
and SQL `LIKE` works on it). Add **Expand column** to the column-header menu:
split one level of a JSON object into `parent.child` columns, as Trifacta's
"Unnest values into new columns" and pandas `json_normalize` do. Arrays stay JSON.

- Works for any column whose cells are JSON objects, so JSONL, Parquet and CSV all get it.
- JSONL and Parquet are read-only, and structural edits are blocked there
  (`canEditStructure`). On those files Expand must change only the view and never
  save; on editable CSV it can be a normal undoable structural edit.
- Expanding one level at a time keeps the column count bounded; cap it like
  `MAX_SPLIT_COLUMNS`.

---

## Other gaps identified in competitive analysis

Not yet planned; listed so they are not lost.

| Gap | Notes |
| --- | --- |
| Copy as Excel | Markdown already exists as an export format; copying the selection as Excel/TSV does not |
| Quote-style preservation on write | Worth auditing what the editor currently does on save |
| Drag-to-autofill (Excel-like series) | |
| Multi-cursor / whole-column edit | Pairs naturally with Find & Replace |
| `.xlsx` write-back | Currently read-only |
| vscode.dev / browser support | Depends on whether the webview has node dependencies — needs verification |
