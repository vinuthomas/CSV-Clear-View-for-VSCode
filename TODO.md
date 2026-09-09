# CSV ClearView — Backlog

Planned work, roughly in priority order. Nothing here is scheduled for a release
until explicitly requested — see "Release Management Guidelines" in `AGENTS.md`.

---

## Parquet support (read-only)

**Status:** planned, not started
**Target:** minor bump (new user-facing feature)
**Estimate:** ~1.5–2 days

Closes the main format gap against Python-notebook-based tooling: Parquet is the
default interchange format for data-engineering work, and today it means leaving
the editor. Nothing in the competitive set reads Parquet without a Python kernel.

### Why this is cheaper than it looks

The `.xlsx` path already does the hard part. In `src/csvEditor.ts`, ExcelJS parses
the workbook **in the extension host**, `worksheetToCsv()` flattens a sheet to CSV
text, and that text is posted to the webview, which then runs the entire normal
pipeline (grid, SQL, profile, filters, export) with `readOnly: true`.

Parquet is the same shape with a different reader. **No webview changes required.**

### Library choice

`hyparquet` (MIT, **zero dependencies**, actively maintained) plus
`hyparquet-compressors` (MIT, 2 small deps) for snappy/zstd, which most real-world
Parquet uses. Zero-dep matters: it adds no Dependabot surface. The alternatives are
worse on that axis — `@dsnp/parquetjs` pulls in the AWS SDK, `parquet-wasm` a large
wasm tree.

### Steps

1. **`package.json`** — add `hyparquet` + `hyparquet-compressors` to `dependencies`;
   add `*.parquet` to the `customEditors` selector; add a `parquet` keyword. No
   language contribution (Parquet is binary, so there is no `onLanguage` event).
2. **`src/csvEditor.ts`** — generalise the Excel branch:
   - keep `isExcelFile()`, add `isParquetFile()`, and a shared `isBinaryFile()`
     for the read-only / `ensureWorkbook` gating.
   - add `parquetToCsv(bytes)` mirroring `worksheetToCsv()`:
     `parquetReadObjects({ file, compressors })`, then rows → CSV with the same
     quoting rules.
   - cache the parsed result the way `workbook` / `ensureWorkbook` already does,
     so re-renders do not re-decode.
3. **Type coercion** — the real work. Parquet is typed, CSV text is not:
   - `INT64` / `BigInt` → string (do **not** go via `Number`, it loses precision)
   - `TIMESTAMP` / `DATE` → ISO 8601, matching `excelCellToString`'s date handling
   - `BYTE_ARRAY` binary → `0x…` or a `<binary>` placeholder
   - `null` must stay distinguishable from empty string
   - nested `LIST` / `MAP` / `STRUCT` → JSON-stringified. **Open question:**
     acceptable for v1, or is real column flattening required? Flattening is a
     significantly larger scope.
4. **Row-group streaming for large files** — `parquetReadObjects` materialises
   everything. Parquet files are routinely 100MB+ compressed and much larger
   expanded, so read `metadata.num_rows` first and, above `safeModeThreshold`,
   read only the first N row groups and surface the existing large-file banner.
   Without this we would ship a size ceiling in the exact feature we market as
   having none.
5. **Toolbar** — reuse the sheet-tab row for a `Parquet · N rows · M cols · SNAPPY`
   badge; wire the existing read-only flag.
6. **Tests** — `tests/parquet.test.js` alongside `excel.test.js`: a fixture with
   each physical type, a nullable column, a nested column, and a snappy-compressed
   file. Round-trip through `parquetToCsv` and assert on the CSV.

### Risks

- **Bundling `hyparquet-compressors`** under webpack — it ships wasm for zstd.
  Worth a 30-minute spike **before** committing to the library; this is the one
  thing that could force a different choice.
- BigInt precision loss if `INT64` is coerced carelessly.
- Unsupported encodings (`DELTA_BINARY_PACKED` and friends) must produce a clean
  error, not a crash.

Export is free: it already goes through `dataToCSV`, so "open Parquet → export CSV"
works with no extra work.

---

## Other gaps identified in competitive analysis

Not yet planned; listed so they are not lost.

| Gap | Notes |
| --- | --- |
| Column/row structural edits (insert, delete, move) | Biggest functional hole — we only do in-place cell edits |
| Copy as Markdown / copy as Excel | Cheap to add, very visible in a feature list |
| Comment-line support (`#` rows preserved, not parsed as data) | Treated as table stakes elsewhere; we currently lint these as broken rows |
| Quote-style preservation on write | Worth auditing what the editor currently does on save |
| Column resize / auto-fit by drag | Expected ergonomics in any grid |
| Drag-to-autofill (Excel-like series) | |
| Multi-cursor / whole-column edit | Pairs naturally with Find & Replace |
| `.xlsx` write-back | Currently read-only |
| JSONL support | Smaller lift than Parquet, same audience |
| vscode.dev / browser support | Depends on whether the webview has node dependencies — needs verification |
