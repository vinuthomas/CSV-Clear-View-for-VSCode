import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects, parquetSchema } from 'hyparquet';
import type { AsyncBuffer, FileMetaData } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';

// The Node build of hyparquet exports this, but its typings live behind an
// `exports` condition our commonjs moduleResolution does not read.
declare module 'hyparquet' {
	export function asyncBufferFromFile(filename: string): Promise<AsyncBuffer>;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function binaryToString(bytes: Uint8Array): string {
	// Older writers omit the STRING annotation, so show valid UTF-8 as text.
	try { return utf8.decode(bytes); } catch { return `<binary ${bytes.length} bytes>`; }
}

/** Render one decoded Parquet value as cell text. BigInt never goes through Number. */
export function parquetValueToString(value: unknown): string {
	if (value === null || value === undefined) { return ''; }
	if (typeof value === 'bigint') { return value.toString(); }
	if (value instanceof Date) { return isNaN(value.getTime()) ? '' : value.toISOString(); }
	if (value instanceof Uint8Array) { return binaryToString(value); }
	if (typeof value === 'object') {
		// shortcut: nested LIST/MAP/STRUCT shown as JSON, flatten into columns if users ask
		return JSON.stringify(value, (_k, v) =>
			typeof v === 'bigint' ? (Number.isSafeInteger(Number(v)) ? Number(v) : v.toString()) : v instanceof Uint8Array ? binaryToString(v) : v);
	}
	return String(value);
}

export interface ParquetFile {
	file: AsyncBuffer;
	metadata: FileMetaData;
	header: string[];
	totalRows: number;
	/** Sum of the row groups' uncompressed sizes: roughly what a full load holds in memory. */
	uncompressedBytes: number;
}

/** Read a Parquet file's footer. Rows are read later, a range at a time. */
export async function openParquet(fsPath: string): Promise<ParquetFile> {
	const file = await asyncBufferFromFile(fsPath);
	const metadata = await parquetMetadataAsync(file);
	return {
		file,
		metadata,
		header: parquetSchema(metadata).children.map(c => c.element.name),
		totalRows: Number(metadata.num_rows),
		uncompressedBytes: metadata.row_groups.reduce((sum, rg) => sum + Number(rg.total_byte_size), 0)
	};
}

/**
 * Read `count` lines of cell text starting at line `start`, where line 0 is the
 * header and line i is data row i - 1 (the same numbering as a CSV file's lines).
 * hyparquet decodes only the row groups that overlap the range.
 */
export async function readParquetLines(pq: ParquetFile, start: number, count: number): Promise<string[][]> {
	const lines = start === 0 && count > 0 ? [pq.header] : [];
	const rowStart = Math.max(0, start - 1);
	const rowEnd = Math.min(pq.totalRows, start + count - 1);
	if (rowEnd > rowStart) {
		const objects = await parquetReadObjects({ file: pq.file, metadata: pq.metadata, compressors, rowStart, rowEnd, utf8: false });
		for (const o of objects) { lines.push(pq.header.map(h => parquetValueToString(o[h]))); }
	}
	return lines;
}
