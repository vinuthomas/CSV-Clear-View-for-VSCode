/** CSV-escape a single field: quote it if it contains a comma, quote, or newline. */
export function csvEscapeField(value: string): string {
	if (/[",\r\n]/.test(value)) {
		return `"${value.replace(/"/g, '""')}"`;
	}
	return value;
}

function jsonValueToString(value: unknown): string {
	if (value === null || value === undefined) { return ''; }
	if (typeof value === 'string') { return value; }
	if (typeof value === 'object') { return JSON.stringify(value); }
	return String(value);
}

/**
 * Convert JSON Lines text (one JSON value per line) to CSV text.
 * Columns are the top-level keys in first-seen order; nested values are
 * JSON-stringified. Lines that are not a JSON object (bad JSON, arrays,
 * plain values) keep their text in a `_raw` column, so nothing is dropped.
 * shortcut: integers past 2^53 lose precision in JSON.parse; parse them as text if users hit it.
 */
export function jsonlToCsv(text: string): string {
	const records: (Record<string, unknown> | string)[] = []; // string = a line that is not an object
	const columns = new Set<string>(); // insertion order = first-seen order
	let hasRaw = false;
	for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
		if (!line.trim()) { continue; }
		let value: unknown;
		try { value = JSON.parse(line); } catch { value = undefined; }
		if (value && typeof value === 'object' && !Array.isArray(value)) {
			Object.keys(value).forEach(k => columns.add(k));
			records.push(value as Record<string, unknown>);
		} else {
			hasRaw = true;
			records.push(line);
		}
	}
	const keys = [...columns];
	let rawColumn = '_raw';
	while (columns.has(rawColumn)) { rawColumn = '_' + rawColumn; }
	const header = hasRaw ? [...keys, rawColumn] : keys;
	const lines = [header.map(csvEscapeField).join(',')];
	for (const record of records) {
		const fields = typeof record === 'string'
			? [...keys.map(() => ''), record]
			: [...keys.map(k => jsonValueToString(record[k])), ...(hasRaw ? [''] : [])];
		lines.push(fields.map(csvEscapeField).join(','));
	}
	return lines.join('\r\n') + '\r\n';
}
