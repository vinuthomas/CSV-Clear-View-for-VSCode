/**
 * Excel (.xlsx) Read-Only Viewing Tests for CSV ClearView
 *
 * Tests the worksheet -> CSV conversion logic used to render .xlsx files
 * through the existing CSV grid pipeline (src/csvEditor.ts).
 * Run with: node tests/excel.test.js
 */

const ExcelJS = require('exceljs');

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, testName) {
    if (condition) {
        passed++;
        console.log(`  ✅ ${testName}`);
    } else {
        failed++;
        failures.push(testName);
        console.log(`  ❌ ${testName}`);
    }
}

function assertEqual(actual, expected, testName) {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
        passed++;
        console.log(`  ✅ ${testName}`);
    } else {
        failed++;
        failures.push(testName);
        console.log(`  ❌ ${testName}`);
        console.log(`     Expected: ${JSON.stringify(expected)}`);
        console.log(`     Actual:   ${JSON.stringify(actual)}`);
    }
}

// ============================================================
// Mirrors the conversion helpers in src/csvEditor.ts
// ============================================================

function csvEscapeField(value) {
    if (/[",\r\n]/.test(value)) {
        return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
}

function excelCellToString(cell) {
    let value = cell.value;
    if (value === null || value === undefined) { return ''; }

    if (typeof value === 'object') {
        if ('result' in value) {
            value = value.result;
        } else if ('richText' in value) {
            value = value.richText.map(run => run.text).join('');
        } else if ('text' in value) {
            value = value.text;
        } else if (value instanceof Date) {
            return value.toISOString();
        } else if ('hyperlink' in value) {
            value = value.text ?? value.hyperlink;
        }
    }

    if (value === null || value === undefined) { return ''; }
    if (value instanceof Date) { return value.toISOString(); }
    return String(value);
}

function worksheetToCsv(worksheet) {
    const lines = [];
    worksheet.eachRow({ includeEmpty: true }, row => {
        const fields = [];
        const colCount = Math.max(worksheet.columnCount, row.cellCount);
        for (let col = 1; col <= colCount; col++) {
            fields.push(csvEscapeField(excelCellToString(row.getCell(col))));
        }
        lines.push(fields.join(','));
    });
    return lines.join('\r\n') + (lines.length ? '\r\n' : '');
}

async function runTests() {
    console.log('📊 Excel (.xlsx) Support Tests\n');

    // --------------------------------------------------------
    console.log('1. Basic worksheet -> CSV conversion');
    // --------------------------------------------------------
    {
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('Sheet1');
        ws.addRow(['Name', 'Age', 'City']);
        ws.addRow(['Alice', 30, 'NYC']);
        ws.addRow(['Bob', 25, 'LA']);

        const csv = worksheetToCsv(ws);
        assertEqual(
            csv,
            'Name,Age,City\r\nAlice,30,NYC\r\nBob,25,LA\r\n',
            'Simple grid converts to CSV with header + data rows'
        );
    }

    // --------------------------------------------------------
    console.log('\n2. CSV-escaping edge cases');
    // --------------------------------------------------------
    {
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('Sheet1');
        ws.addRow(['Smith, John', 'He said "hi"', 'Line1\nLine2']);

        const csv = worksheetToCsv(ws);
        assertEqual(
            csv,
            '"Smith, John","He said ""hi""","Line1\nLine2"\r\n',
            'Comma, quote, and embedded-newline cells are all correctly quoted/escaped'
        );
    }

    // --------------------------------------------------------
    console.log('\n3. Formulas, dates, and empty cells');
    // --------------------------------------------------------
    {
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('Sheet1');
        ws.getCell('A1').value = { formula: 'A2+A3', result: 42 };
        ws.getCell('B1').value = new Date('2026-01-15T00:00:00.000Z');
        ws.getCell('C1').value = null;

        const csv = worksheetToCsv(ws);
        assert(csv.startsWith('42,2026-01-15T00:00:00.000Z,'), 'Formula result and ISO date rendered; null cell renders as empty string');
    }

    // --------------------------------------------------------
    console.log('\n4. Multi-sheet workbook name extraction');
    // --------------------------------------------------------
    {
        const wb = new ExcelJS.Workbook();
        wb.addWorksheet('Summary');
        wb.addWorksheet('Raw Data');
        wb.addWorksheet('2026 Q1');

        const names = wb.worksheets.map(ws => ws.name);
        assertEqual(names, ['Summary', 'Raw Data', '2026 Q1'], 'Sheet names extracted in workbook order');
        assertEqual(!!wb.getWorksheet('Raw Data'), true, 'A known sheet name resolves via getWorksheet');
        assertEqual(!!wb.getWorksheet('Nonexistent'), false, 'An unknown sheet name does not resolve');
    }

    // --------------------------------------------------------
    console.log('\n5. Round-trip through ExcelJS xlsx buffer (load path used by the extension)');
    // --------------------------------------------------------
    {
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('Data');
        ws.addRow(['Col A', 'Col B']);
        ws.addRow([1, 2]);
        const buffer = await wb.xlsx.writeBuffer();

        const wb2 = new ExcelJS.Workbook();
        await wb2.xlsx.load(buffer);
        const csv = worksheetToCsv(wb2.getWorksheet('Data'));
        assertEqual(csv, 'Col A,Col B\r\n1,2\r\n', 'Workbook survives a full xlsx write/load round trip');
    }

    // --------------------------------------------------------
    console.log('\n' + '='.repeat(50));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        console.log('\nFailed tests:');
        failures.forEach(f => console.log(`  ❌ ${f}`));
        process.exit(1);
    } else {
        console.log('All tests passed! ✅');
        process.exit(0);
    }
}

runTests().catch(e => {
    console.error('Test runner error:', e);
    process.exit(1);
});
