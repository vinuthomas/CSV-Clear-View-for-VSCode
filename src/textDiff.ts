/**
 * Smallest single-span change between two texts, for undo/redo.
 *
 * Each edit sends the whole file text. Holding a full copy per undo step would
 * cost file-size × edits of memory, so we store only the span that differs
 * (common prefix and suffix trimmed). A cell edit becomes a few bytes.
 */
export interface TextChange {
	start: number;
	removed: string;   // text in `before` at [start, start + removed.length)
	inserted: string;  // text in `after` at [start, start + inserted.length)
}

export function diffText(before: string, after: string): TextChange {
	const max = Math.min(before.length, after.length);
	let start = 0;
	while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) { start++; }
	let end = 0;
	while (end < max - start
		&& before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)) { end++; }
	return {
		start,
		removed: before.slice(start, before.length - end),
		inserted: after.slice(start, after.length - end)
	};
}

/** Apply `change` forward (before → after) or backward (after → before). */
export function applyChange(text: string, change: TextChange, backward: boolean): string {
	const [from, to] = backward ? [change.inserted, change.removed] : [change.removed, change.inserted];
	return text.slice(0, change.start) + to + text.slice(change.start + from.length);
}
