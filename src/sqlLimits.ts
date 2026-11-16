/**
 * Size limits for SQL queries.
 *
 * A query ships the whole dataset from the webview to the extension host as
 * one message, and the result comes back the same way. Measured on a
 * 12-column sales CSV (see CHANGELOG 1.5.0):
 *
 *   - The JSON message is ~2.25× the file size (100MB file → ~226MB message).
 *   - Producing it costs extra memory in three processes at once: the row
 *     objects in the webview (~1.05× message), the serialised message
 *     (~1×), its structured-clone copy (~1×) and the rows re-created on the
 *     host (~1.1×) — about 4.5× the message size in total, on top of what
 *     the open file already uses.
 *   - V8 cannot build a string longer than ~512MB, so a message above that
 *     fails on every machine, regardless of RAM.
 *
 * The limit is therefore the smaller of a hard cap (safely under V8's string
 * ceiling) and a share of physical memory, so 8GB machines get a lower limit
 * than 24GB ones.
 */

/** Hard ceiling on the query message, safely below V8's ~512MB string limit. */
export const SQL_HARD_PAYLOAD_LIMIT = 400 * 1024 * 1024;

/** Extra memory needed across processes, as a multiple of the message size. */
export const SQL_MEMORY_MULTIPLIER = 4.5;

/** Share of physical memory a single query may use. */
export const SQL_MEMORY_SHARE = 0.2;

/** Never go below this, so small machines can still query typical files. */
export const SQL_MIN_PAYLOAD_LIMIT = 32 * 1024 * 1024;

/** Largest SQL message (in bytes of JSON) this machine should attempt. */
export function computeSqlPayloadLimit(totalMemBytes: number): number {
	const byMemory = Math.floor((totalMemBytes * SQL_MEMORY_SHARE) / SQL_MEMORY_MULTIPLIER);
	return Math.max(SQL_MIN_PAYLOAD_LIMIT, Math.min(SQL_HARD_PAYLOAD_LIMIT, byMemory));
}

/**
 * Estimate the JSON size of an array of rows by serialising an evenly spaced
 * sample, so a 5-million-row result can be checked in milliseconds.
 */
export function estimateJsonBytes(rows: readonly unknown[], sampleSize = 1000): number {
	const n = rows.length;
	if (n === 0) { return 2; }
	const step = Math.max(1, Math.floor(n / sampleSize));
	let sampled = 0;
	let bytes = 0;
	for (let i = 0; i < n; i += step) {
		bytes += JSON.stringify(rows[i]).length + 1; // +1 for the separating comma
		sampled++;
	}
	return Math.ceil((bytes / sampled) * n) + 2;
}

export function formatMB(bytes: number): string {
	return `${Math.round(bytes / (1024 * 1024))}MB`;
}
