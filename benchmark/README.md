# Performance Benchmark

A standalone Node script that exercises CSV ClearView's hot paths — full-file
parsing, chunked-mode row indexing/paging, and SQL query latency — outside of
VS Code. Because it only needs Node and the `alasql` dependency, it can run
on any machine, including a low-spec Windows box, without installing VS Code
or the extension itself.

## Running it here

```bash
npm run benchmark
```

Or directly, with options:

```bash
node --expose-gc benchmark/run.js --sizes=5,25,100,300 --chunked=600
```

| Flag | Default | Meaning |
|---|---|---|
| `--sizes=5,25,100,300` | `5,25,100,300` | MB tiers for the full-parse + SQL benchmark (files under the 500MB chunked-mode threshold) |
| `--chunked=600` | `600` | MB tiers for the chunked-mode benchmark (files at/above the 500MB threshold) |
| `--seed=42` | `42` | RNG seed for the synthetic data generator — keep this fixed across machines/runs so the data is identical |
| `--keep` | off | Keep the generated CSVs in `benchmark/.tmp/` instead of deleting them after each tier |
| `--out=path.json` | none | Also write a full JSON report to this path |
| `--queries-all` | off | Run the SQL benchmark on every tier, not just tiers ≤150MB (large tiers make querying slow, so it's opt-in) |

`--expose-gc` (already wired into `npm run benchmark`) forces a GC pass before
each memory measurement so the reported RSS delta reflects the parse itself
rather than leftover garbage from a previous tier.

## Running it on a low-spec Windows machine

You don't need the whole repo or VS Code — just Node and the `alasql` package:

1. Copy `benchmark/run.js`, `package.json`, and `package-lock.json` to the target machine.
2. `npm install --omit=dev` (installs only `alasql`; skips webpack/vsce/etc.)
3. `node --expose-gc benchmark/run.js --out=windows-results.json`
4. Bring `windows-results.json` back and compare it against a run from your dev
   machine (`--out=mac-results.json`) — same `--seed`, same `--sizes`/`--chunked`,
   so the generated data is identical and the timings are directly comparable.

## What it measures, and why

- **Full-file open path** (`benchmarkParseTier`) — read + decode, delimiter
  detection, and CSV parsing, mirroring exactly what happens when you open a
  file under 500MB (`updateWebview` → `parseCSV` in `media/csv.js`). This is
  the path most sensitive to CPU speed and available RAM, since the whole
  file is held in memory as a parsed array-of-arrays.
- **Chunked-mode open path** (`benchmarkChunkedTier`) — row-index building and
  paged reads, mirroring the >500MB path (`buildRowIndex`/`readRows` in
  `src/csvEditor.ts`) that lets huge files open without loading them fully
  into memory. `indexMs` is the one-time cost paid on open; the page-read
  timings simulate scrolling to different parts of the file.
- **SQL queries** — runs four representative queries (full scan, `WHERE`
  filter, `GROUP BY` aggregation, `ORDER BY ... LIMIT`) against the real
  `alasql` dependency, on the in-memory row-objects the SQL bar actually
  queries against.

The parsing/indexing algorithms are mirrored verbatim from `media/csv.js` and
`src/csvEditor.ts` rather than imported, because those files depend on a
browser webview and the `vscode` extension-host API respectively — neither
runs standalone under plain Node. This follows the same convention already
used in `tests/security.test.js`. If you change `parseCSV`, `detectDelimiter`,
`buildRowIndex`, or `readRows` in the real source, update the copies here too.

## Interpreting results

There's no fixed pass/fail threshold — the point is relative comparison:

- Compare the same machine before/after a code change to catch regressions.
- Compare two machines (e.g. your dev Mac vs. the low-spec Windows target)
  using identical `--seed`/`--sizes`/`--chunked` to see the real-world
  slowdown a lower-spec user would feel.
- The chunked-mode tier's `indexMs` is what determines how long a user waits
  before a huge file becomes interactive at all — that's usually the number
  that matters most for "does this feel broken on my machine."
