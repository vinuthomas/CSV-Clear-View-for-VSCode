/**
 * Server-side check for SQL sent from the webview. Only read-only SELECTs may
 * run. media/csv.js repeats BLOCKED_SQL for a fast error in the UI;
 * tests/security.test.js checks the two stay identical.
 */

// INTO is blocked in any form: AlaSQL's SELECT ... INTO CSV('path') writes files.
export const BLOCKED_SQL = /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|EXEC|EXECUTE|INTO|ATTACH|DETACH|SOURCE|PRAGMA|SHOW\s+TABLES|SHOW\s+DATABASES|SET\s+OPTION)\b/i;

/** Returns an error message, or null when the query may run. */
export function validateSqlQuery(query: string): string | null {
	const normalized = query.replace(/\/\*[\s\S]*?\*\//g, '').trim();
	if (!/^SELECT\s/i.test(normalized)) { return 'Only SELECT queries are allowed'; }
	if (/;/.test(normalized)) { return 'Semicolons are not allowed in queries'; }
	if (BLOCKED_SQL.test(normalized)) { return 'Data modification statements are not allowed'; }
	return null;
}
