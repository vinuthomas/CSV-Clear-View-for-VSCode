import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects, parquetSchema } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';

// The Node build of hyparquet exports this, but its typings live behind an
// `exports` condition our commonjs moduleResolution does not read.
declare module 'hyparquet' {
	export function asyncBufferFromFile(filename: string): Promise<import('hyparquet').AsyncBuffer>;
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

export interface ParquetTable {
	header: string[];
	rows: string[][];
	totalRows: number;
}

/**
 * Read a Parquet file as rows of cell text. Only whole leading row groups whose
 * uncompressed size fits in maxBytes are read (always at least one), so
 * rows.length < totalRows means the view is partial.
 */
export async function readParquet(fsPath: string, maxBytes: number): Promise<ParquetTable> {
	const file = await asyncBufferFromFile(fsPath);
	const metadata = await parquetMetadataAsync(file);
	let rowEnd = 0;
	let bytes = 0;
	for (const rg of metadata.row_groups) {
		bytes += Number(rg.total_byte_size);
		if (rowEnd > 0 && bytes > maxBytes) { break; }
		rowEnd += Number(rg.num_rows);
	}
	const header = parquetSchema(metadata).children.map(c => c.element.name);
	const objects = await parquetReadObjects({ file, metadata, compressors, rowEnd, utf8: false });
	return {
		header,
		rows: objects.map(o => header.map(h => parquetValueToString(o[h]))),
		totalRows: Number(metadata.num_rows)
	};
}
