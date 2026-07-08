#!/usr/bin/env node
/**
 * CSV ClearView performance benchmark.
 *
 * Exercises the same hot paths the extension runs on a real file open,
 * outside of VS Code, so it can be run anywhere Node runs — including a
 * low-spec Windows machine with nothing but Node and this repo's
 * `node_modules/alasql` installed.
 *
 * Measures:
 *   1. Full-file parsing (read + delimiter detection + CSV parse) — the
 *      path used for any file under the 500MB chunked-mode threshold.
 *   2. Chunked-mode row indexing + paged reads — the path used above the
 *      500MB threshold (huge files never fully load into memory).
 *   3. SQL query latency via the real `alasql` dependency, against
 *      in-memory row-objects the way the SQL bar does.
 *
 * The parsing and indexing algorithms below are intentionally mirrored
 * verbatim from media/csv.js (parseCSV, detectDelimiter) and
 * src/csvEditor.ts (buildRowIndex, readRows) rather than imported,
 * because those live in a webview script and a VS Code extension host
 * respectively — neither runs standalone under plain Node. This mirrors
 * the same convention already used in tests/security.test.js.
 *
 * Usage:
 *   node benchmark/run.js [--sizes=5,25,100,300] [--chunked=600]
 *                         [--seed=42] [--keep] [--out=results.json]
 *                         [--queries-all]
 *
 * Run with `--expose-gc` (see the `npm run benchmark` script) for more
 * accurate memory-delta numbers.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ============================================================
// CLI args
// ============================================================

function printHelp() {
  console.log(`
CSV ClearView performance benchmark

Options:
  --sizes=5,25,100,300   MB tiers for the full-parse + SQL benchmark (default: 5,25,100,300)
  --chunked=600          MB tiers for the chunked-mode (>500MB) benchmark (default: 600)
  --seed=42              RNG seed for reproducible synthetic data (default: 42)
  --keep                 Keep generated CSV files in benchmark/.tmp instead of deleting them
  --out=path.json        Write a JSON report to this path (in addition to console output)
  --queries-all          Run the SQL benchmark on every tier, not just tiers <= 150MB
  -h, --help             Show this help
`);
}

function parseArgs(argv) {
  const args = {
    sizes: [5, 25, 100, 300],
    chunked: [600],
    seed: 42,
    keep: false,
    out: null,
    queriesAll: false
  };
  for (const arg of argv) {
    if (arg.startsWith('--sizes=')) { args.sizes = arg.slice(8).split(',').map(Number); }
    else if (arg.startsWith('--chunked=')) { args.chunked = arg.slice(10).split(',').map(Number); }
    else if (arg.startsWith('--seed=')) { args.seed = Number(arg.slice(7)); }
    else if (arg === '--keep') { args.keep = true; }
    else if (arg.startsWith('--out=')) { args.out = arg.slice(6); }
    else if (arg === '--queries-all') { args.queriesAll = true; }
    else if (arg === '-h' || arg === '--help') { printHelp(); process.exit(0); }
  }
  return args;
}

const ARGS = parseArgs(process.argv.slice(2));
const QUERY_MAX_MB = 150; // skip the SQL benchmark above this tier unless --queries-all
const TMP_DIR = path.join(__dirname, '.tmp');

// ============================================================
// Small helpers
// ============================================================

function nowMs() { return Number(process.hrtime.bigint()) / 1e6; }

function fmtMs(ms) { return ms < 1000 ? `${ms.toFixed(1)} ms` : `${(ms / 1000).toFixed(2)} s`; }

function fmtBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

function maybeGC() { if (typeof global.gc === 'function') { global.gc(); } }

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function machineInfo() {
  const cpus = os.cpus();
  return {
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
    cpuModel: cpus[0] ? cpus[0].model : 'unknown',
    cpuCount: cpus.length,
    totalMemGB: +(os.totalmem() / 1024 ** 3).toFixed(1),
    freeMemGB: +(os.freemem() / 1024 ** 3).toFixed(1),
    nodeVersion: process.version
  };
}

// ============================================================
// Synthetic CSV generator
// ============================================================

const CITIES = ['New York', 'London', 'Berlin', 'Tokyo', 'Sydney', 'Toronto', 'Mumbai', 'Cairo'];
const SYLLABLES = ['al', 'ber', 'car', 'don', 'el', 'fen', 'gil', 'hu', 'in', 'jor', 'ka', 'lin', 'mor', 'nu', 'or'];

function randomWord(rng, syllableCount) {
  let w = '';
  for (let i = 0; i < syllableCount; i++) { w += SYLLABLES[Math.floor(rng() * SYLLABLES.length)]; }
  return w[0].toUpperCase() + w.slice(1);
}

function randomDate(rng) {
  const start = new Date(2020, 0, 1).getTime();
  const end = new Date(2026, 11, 31).getTime();
  const d = new Date(start + rng() * (end - start));
  return d.toISOString().slice(0, 10);
}

/** Streams a synthetic CSV of at least `targetBytes` to `filePath`. Returns the actual byte count written. */
function generateCSV(filePath, targetBytes, rng) {
  const fd = fs.openSync(filePath, 'w');
  const header = 'Id,Name,Amount,Date,Active,City,Notes\n';
  fs.writeSync(fd, header);
  let written = Buffer.byteLength(header);

  let id = 1;
  let batch = '';
  const FLUSH_AT = 1024 * 1024; // 1 MB

  while (written < targetBytes) {
    const name = randomWord(rng, 2) + ' ' + randomWord(rng, 2);
    const amount = (rng() * 10000).toFixed(2);
    const date = randomDate(rng);
    const active = rng() > 0.5 ? 'true' : 'false';
    const city = CITIES[Math.floor(rng() * CITIES.length)];
    // ~5% of rows exercise the quoted-field path (embedded comma + escaped quote)
    const notes = rng() < 0.05 ? `"Note, with a ""quoted"" aside"` : 'ok';
    batch += `${id},${name},${amount},${date},${active},${city},${notes}\n`;
    id++;

    if (batch.length >= FLUSH_AT) {
      fs.writeSync(fd, batch);
      written += Buffer.byteLength(batch);
      batch = '';
    }
  }
  if (batch.length) {
    fs.writeSync(fd, batch);
    written += Buffer.byteLength(batch);
  }
  fs.closeSync(fd);
  return written;
}

// ============================================================
// Mirrored from media/csv.js — detectDelimiter, parseCSV
// (kept in sync manually; see file header comment)
// ============================================================

function detectDelimiter(text, hintExtension) {
  if (hintExtension === 'tsv' || hintExtension === 'tab') { return '\t'; }
  if (hintExtension === 'psv') { return '|'; }

  const sample = text.slice(0, 8192);
  const lines = sample.split(/\r?\n/).filter(l => l.length > 0).slice(0, 20);
  if (lines.length === 0) { return ','; }

  const candidates = [',', '\t', '|', ';'];
  let bestDelim = ',';
  let bestScore = -1;

  for (const d of candidates) {
    const counts = lines.map(l => {
      let n = 0;
      let inQ = false;
      for (let i = 0; i < l.length; i++) {
        if (l[i] === '"') { inQ = !inQ; }
        else if (!inQ && l[i] === d) { n++; }
      }
      return n;
    });

    const nonZero = counts.filter(c => c > 0);
    if (nonZero.length === 0) { continue; }

    const mean = nonZero.reduce((a, b) => a + b, 0) / nonZero.length;
    if (mean < 1) { continue; }

    const variance = nonZero.reduce((acc, c) => acc + (c - mean) ** 2, 0) / nonZero.length;
    const score = mean - variance;
    if (score > bestScore) { bestScore = score; bestDelim = d; }
  }
  return bestDelim;
}

async function parseCSV(text, delimiter) {
  const delim = delimiter || ',';
  const data = [];
  const errors = [];
  let currentRow = [];
  let fieldStart = 0;
  let inQuotes = false;
  const len = text.length;

  for (let i = 0; i < len; i++) {
    const char = text[i];

    if (i % 500000 === 0 && i > 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < len && text[i + 1] === '"') { i++; }
        else { inQuotes = false; }
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === delim) {
        let field = text.slice(fieldStart, i);
        if (field.startsWith('"') && field.endsWith('"')) { field = field.slice(1, -1).replace(/""/g, '"'); }
        currentRow.push(field);
        fieldStart = i + 1;
      } else if (char === '\n') {
        let field = text.slice(fieldStart, i);
        if (field.startsWith('"') && field.endsWith('"')) { field = field.slice(1, -1).replace(/""/g, '"'); }
        currentRow.push(field);
        data.push(currentRow);
        currentRow = [];
        fieldStart = i + 1;
      } else if (char === '\r') {
        let field = text.slice(fieldStart, i);
        if (field.startsWith('"') && field.endsWith('"')) { field = field.slice(1, -1).replace(/""/g, '"'); }
        currentRow.push(field);
        data.push(currentRow);
        currentRow = [];
        if (i + 1 < len && text[i + 1] === '\n') { i++; }
        fieldStart = i + 1;
      }
    }
  }

  if (fieldStart < len || text.endsWith(delim)) {
    let field = text.slice(fieldStart);
    if (field.startsWith('"') && field.endsWith('"')) { field = field.slice(1, -1).replace(/""/g, '"'); }
    currentRow.push(field);
    data.push(currentRow);
  }

  if (inQuotes) {
    errors.push({ line: data.length + 1, message: `Row ${data.length + 1}: Unclosed quote detected.` });
  }

  if (data.length > 0) {
    const headerLength = data[0].length;
    data.forEach((row, index) => {
      if (row.length !== headerLength) {
        errors.push({ line: index + 1, message: `Row ${index + 1}: Expected ${headerLength} columns, found ${row.length}.` });
      }
    });
  }

  return { data, errors };
}

/** Mirrors dataToObjects in media/csv.js (minus prototype-pollution key renaming — not perf relevant). */
function dataToObjects(data) {
  if (data.length < 2) { return []; }
  const headers = data[0];
  const objects = new Array(data.length - 1);
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const obj = {};
    for (let c = 0; c < headers.length; c++) { obj[headers[c]] = row[c]; }
    objects[i - 1] = obj;
  }
  return objects;
}

// ============================================================
// Mirrored from src/csvEditor.ts — buildRowIndex, readRows
// (pure fs-based in production already; only `vscode.Uri` is swapped
// for a plain fsPath string here)
// ============================================================

async function buildRowIndex(fsPath, fileSize) {
  const SCAN_BLOCK = 4 * 1024 * 1024;
  const SAMPLE_INTERVAL = 4 * 1024 * 1024;

  const fd = fs.openSync(fsPath, 'r');
  const checkpointBytes = [0];
  const checkpointRows = [0];

  let offset = 0;
  let rowCount = 0;
  let inQuotes = false;
  let prevWasQuote = false;
  let nextSample = SAMPLE_INTERVAL;
  let lastByteWasNewline = false;

  try {
    const buf = Buffer.alloc(SCAN_BLOCK);
    while (offset < fileSize) {
      await new Promise(resolve => setImmediate(resolve));

      const toRead = Math.min(SCAN_BLOCK, fileSize - offset);
      const bytesRead = fs.readSync(fd, buf, 0, toRead, offset);
      if (bytesRead === 0) { break; }

      for (let i = 0; i < bytesRead; i++) {
        const ch = buf[i];
        if (ch === 0x22) {
          if (!inQuotes) { inQuotes = true; prevWasQuote = false; }
          else if (prevWasQuote) { prevWasQuote = false; }
          else { prevWasQuote = true; }
        } else {
          if (inQuotes && prevWasQuote) { inQuotes = false; }
          prevWasQuote = false;
          if (!inQuotes && ch === 0x0a) {
            rowCount++;
            const nextRowByte = offset + i + 1;
            if (nextRowByte < fileSize && nextRowByte >= nextSample) {
              checkpointBytes.push(nextRowByte);
              checkpointRows.push(rowCount);
              nextSample = nextRowByte + SAMPLE_INTERVAL;
            }
          }
        }
        lastByteWasNewline = (ch === 0x0a);
      }
      offset += bytesRead;
    }
  } finally {
    fs.closeSync(fd);
  }

  const totalRows = lastByteWasNewline ? rowCount : rowCount + 1;
  return { checkpointBytes, checkpointRows, totalRows, fsPath };
}

async function readRows(index, startRowIndex, rowCount) {
  if (index.totalRows === 0) { return ''; }

  const clampedStart = Math.max(0, Math.min(startRowIndex, index.totalRows - 1));
  const clampedEnd = Math.min(clampedStart + rowCount, index.totalRows);
  if (clampedStart >= clampedEnd) { return ''; }

  const { checkpointBytes, checkpointRows } = index;
  let lo = 0, hi = checkpointRows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (checkpointRows[mid] <= clampedStart) { lo = mid; } else { hi = mid - 1; }
  }
  const cpByte = checkpointBytes[lo];
  const cpRow = checkpointRows[lo];

  const fd = fs.openSync(index.fsPath, 'r');
  try {
    const SCAN_BLOCK = 256 * 1024;
    const buf = Buffer.alloc(SCAN_BLOCK);
    let offset = cpByte;
    let currentRow = cpRow;
    let inQuotes = false;
    let prevWasQuoteR = false;

    while (currentRow < clampedStart) {
      const bytesRead = fs.readSync(fd, buf, 0, SCAN_BLOCK, offset);
      if (bytesRead === 0) { return ''; }

      for (let i = 0; i < bytesRead; i++) {
        const ch = buf[i];
        if (ch === 0x22) {
          if (!inQuotes) { inQuotes = true; prevWasQuoteR = false; }
          else if (prevWasQuoteR) { prevWasQuoteR = false; }
          else { prevWasQuoteR = true; }
        } else {
          if (inQuotes && prevWasQuoteR) { inQuotes = false; }
          prevWasQuoteR = false;
          if (!inQuotes && ch === 0x0a) {
            currentRow++;
            if (currentRow >= clampedStart) {
              offset = offset + i + 1;
              break;
            }
          }
        }
      }
      if (currentRow < clampedStart) { offset += bytesRead; }
    }

    const chunks = [];
    let rowsCollected = 0;
    const needed = clampedEnd - clampedStart;

    while (rowsCollected < needed) {
      const bytesRead = fs.readSync(fd, buf, 0, SCAN_BLOCK, offset);
      if (bytesRead === 0) { break; }

      let segEnd = -1;
      for (let i = 0; i < bytesRead; i++) {
        const ch = buf[i];
        if (ch === 0x22) {
          if (!inQuotes) { inQuotes = true; prevWasQuoteR = false; }
          else if (prevWasQuoteR) { prevWasQuoteR = false; }
          else { prevWasQuoteR = true; }
        } else {
          if (inQuotes && prevWasQuoteR) { inQuotes = false; }
          prevWasQuoteR = false;
          if (!inQuotes && ch === 0x0a) {
            rowsCollected++;
            if (rowsCollected >= needed) { segEnd = i + 1; break; }
          }
        }
      }

      if (segEnd !== -1) {
        chunks.push(buf.slice(0, segEnd));
        break;
      } else {
        chunks.push(Buffer.from(buf.slice(0, bytesRead)));
        offset += bytesRead;
      }
    }

    return Buffer.concat(chunks).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// ============================================================
// Benchmark tiers
// ============================================================

async function benchmarkParseTier(sizeMB, seed) {
  const filePath = path.join(TMP_DIR, `parse_${sizeMB}mb.csv`);
  const targetBytes = sizeMB * 1024 * 1024;

  process.stdout.write(`  generating ${sizeMB}MB synthetic file... `);
  const genT0 = nowMs();
  generateCSV(filePath, targetBytes, mulberry32(seed));
  console.log(fmtMs(nowMs() - genT0));

  const actualBytes = fs.statSync(filePath).size;

  maybeGC();
  const rssBefore = process.memoryUsage().rss;

  const t0 = nowMs();
  const buf = fs.readFileSync(filePath);
  const text = buf.toString('utf8');
  const t1 = nowMs();
  const delimiter = detectDelimiter(text, 'csv');
  const t2 = nowMs();
  const { data, errors } = await parseCSV(text, delimiter);
  const t3 = nowMs();

  const rssAfter = process.memoryUsage().rss;

  let queryResults = null;
  if (ARGS.queriesAll || sizeMB <= QUERY_MAX_MB) {
    const objects = dataToObjects(data);
    queryResults = benchmarkQueries(objects);
  }

  if (!ARGS.keep) { fs.rmSync(filePath, { force: true }); }

  return {
    sizeMB,
    actualBytes,
    readMs: t1 - t0,
    detectDelimiterMs: t2 - t1,
    parseMs: t3 - t2,
    totalMs: t3 - t0,
    rows: data.length,
    errors: errors.length,
    rssDeltaBytes: rssAfter - rssBefore,
    queryResults
  };
}

function benchmarkQueries(objects) {
  const alasql = require('alasql');
  const queries = [
    ['Full scan', 'SELECT * FROM ?'],
    ['Filter (WHERE)', 'SELECT * FROM ? WHERE [Amount] > 5000'],
    ['Aggregate (GROUP BY)', 'SELECT [City], COUNT(*) AS cnt, AVG([Amount]) AS avgAmount FROM ? GROUP BY [City]'],
    ['Sort + limit', 'SELECT * FROM ? ORDER BY [Date] DESC LIMIT 100']
  ];
  const results = [];
  for (const [label, sql] of queries) {
    const t0 = nowMs();
    const res = alasql(sql, [objects]);
    const t1 = nowMs();
    results.push({ label, sql, ms: t1 - t0, resultRows: res.length });
  }
  return results;
}

async function benchmarkChunkedTier(sizeMB, seed) {
  const filePath = path.join(TMP_DIR, `chunked_${sizeMB}mb.csv`);
  const targetBytes = sizeMB * 1024 * 1024;

  process.stdout.write(`  generating ${sizeMB}MB synthetic file... `);
  const genT0 = nowMs();
  generateCSV(filePath, targetBytes, mulberry32(seed));
  console.log(fmtMs(nowMs() - genT0));

  const fileSize = fs.statSync(filePath).size;

  const t0 = nowMs();
  const index = await buildRowIndex(filePath, fileSize);
  const t1 = nowMs();

  const CHUNK_ROWS = 500;
  const samplePoints = [0, Math.floor(index.totalRows / 2), Math.max(0, index.totalRows - CHUNK_ROWS)];
  const pageTimings = [];
  for (const startRow of samplePoints) {
    const tp0 = nowMs();
    const text = await readRows(index, startRow, CHUNK_ROWS);
    const tp1 = nowMs();
    pageTimings.push({ startRow, ms: tp1 - tp0, bytesReturned: Buffer.byteLength(text) });
  }

  if (!ARGS.keep) { fs.rmSync(filePath, { force: true }); }

  return {
    sizeMB,
    fileSize,
    indexMs: t1 - t0,
    totalRows: index.totalRows,
    checkpoints: index.checkpointBytes.length,
    pageTimings
  };
}

// ============================================================
// Report
// ============================================================

function printParseReport(r) {
  console.log(`  File:              ${fmtBytes(r.actualBytes)} (${r.rows.toLocaleString()} rows, ${r.errors} parse errors)`);
  console.log(`  Read + decode:     ${fmtMs(r.readMs)}`);
  console.log(`  Detect delimiter:  ${fmtMs(r.detectDelimiterMs)}`);
  console.log(`  Parse:             ${fmtMs(r.parseMs)}`);
  console.log(`  Total (open path): ${fmtMs(r.totalMs)}`);
  console.log(`  RSS delta:         ${fmtBytes(r.rssDeltaBytes)}`);
  if (r.queryResults) {
    console.log('  SQL queries:');
    for (const q of r.queryResults) {
      console.log(`    ${q.label.padEnd(22)} ${fmtMs(q.ms).padStart(10)}  (${q.resultRows.toLocaleString()} rows)`);
    }
  } else {
    console.log(`  SQL queries:       skipped (tier > ${QUERY_MAX_MB}MB; pass --queries-all to include)`);
  }
}

function printChunkedReport(r) {
  console.log(`  File:              ${fmtBytes(r.fileSize)} (${r.totalRows.toLocaleString()} rows, ${r.checkpoints.toLocaleString()} index checkpoints)`);
  console.log(`  Build row index:   ${fmtMs(r.indexMs)}`);
  console.log('  Page reads (500 rows each):');
  for (const p of r.pageTimings) {
    console.log(`    row ${String(p.startRow).padStart(10)}:  ${fmtMs(p.ms).padStart(10)}  (${fmtBytes(p.bytesReturned)})`);
  }
}

// ============================================================
// Main
// ============================================================

async function main() {
  fs.mkdirSync(TMP_DIR, { recursive: true });

  const info = machineInfo();
  console.log('CSV ClearView performance benchmark');
  console.log('='.repeat(50));
  console.log(`Platform:  ${info.platform} ${info.arch} (${info.release})`);
  console.log(`CPU:       ${info.cpuModel} x${info.cpuCount}`);
  console.log(`Memory:    ${info.totalMemGB} GB total, ${info.freeMemGB} GB free`);
  console.log(`Node:      ${info.nodeVersion}${typeof global.gc === 'function' ? ' (--expose-gc active)' : ' (run with --expose-gc for accurate memory deltas)'}`);
  console.log('='.repeat(50));

  const report = { machine: info, generatedAt: new Date().toISOString(), parseTiers: [], chunkedTiers: [] };

  console.log('\n--- Full-file open path (parse, applies to files under 500MB) ---');
  for (const sizeMB of ARGS.sizes) {
    console.log(`\n[${sizeMB}MB]`);
    const r = await benchmarkParseTier(sizeMB, ARGS.seed);
    printParseReport(r);
    report.parseTiers.push(r);
  }

  console.log('\n--- Chunked-mode open path (row indexing + paging, applies above 500MB) ---');
  for (const sizeMB of ARGS.chunked) {
    console.log(`\n[${sizeMB}MB]`);
    const r = await benchmarkChunkedTier(sizeMB, ARGS.seed);
    printChunkedReport(r);
    report.chunkedTiers.push(r);
  }

  if (!ARGS.keep) {
    try { fs.rmdirSync(TMP_DIR); } catch (e) { /* not empty or already gone — fine */ }
  }

  if (ARGS.out) {
    fs.writeFileSync(ARGS.out, JSON.stringify(report, null, 2));
    console.log(`\nJSON report written to ${ARGS.out}`);
  }

  console.log('\nDone. Compare this output (or --out=file.json) against a run on another machine to see the relative slowdown.');
}

main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exitCode = 1;
});
