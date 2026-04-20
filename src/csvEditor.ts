import * as vscode from 'vscode';
import * as crypto from 'crypto';
import alasql = require('alasql');

const CHUNKED_MODE_THRESHOLD = 500 * 1024 * 1024; // 500 MB
const CHUNK_ROWS = 500; // rows per page delivered to the webview

/**
 * Define a custom document for CSV files.
 * This allows us to handle large files without VS Code's TextDocument limitations.
 */
class CsvDocument implements vscode.CustomDocument {
	constructor(
		public readonly uri: vscode.Uri,
		public readonly size: number
	) { }

	dispose(): void { }
}

/**
 * Sampled byte-offset index for a single file.
 *
 * Rather than recording every row (which overflows for 10GB+ files with hundreds
 * of millions of rows), we record one checkpoint every SAMPLE_INTERVAL bytes.
 * Each checkpoint stores the byte offset of a row boundary and the cumulative
 * row count up to that point.  When seeking to a specific row we jump to the
 * nearest checkpoint behind it and scan forward from there.
 *
 * Memory cost: ~16 bytes per checkpoint × (fileSize / SAMPLE_INTERVAL).
 * At 4MB intervals a 10 GB file produces ~2,500 checkpoints — tiny.
 */
interface RowIndex {
	/** Byte offset of the start of the row at each checkpoint. */
	checkpointBytes: number[];
	/** Cumulative row count at each checkpoint (0-based; row 0 = header). */
	checkpointRows: number[];
	/** Total number of rows in the file (including the header row). */
	totalRows: number;
	/** Path to the file (needed by readRows to re-open for scanning). */
	fsPath: string;
}

export class CsvEditorProvider implements vscode.CustomEditorProvider<CsvDocument> {

	public static register(context: vscode.ExtensionContext): vscode.Disposable {
		const provider = new CsvEditorProvider(context);
		const providerRegistration = vscode.window.registerCustomEditorProvider(CsvEditorProvider.viewType, provider, {
			webviewOptions: {
				retainContextWhenHidden: true
			},
			supportsMultipleEditorsPerDocument: false
		});
		return providerRegistration;
	}

	private static readonly viewType = 'csvClearView.edit';

	constructor(
		private readonly context: vscode.ExtensionContext
	) { }

	async openCustomDocument(
		uri: vscode.Uri,
		_openContext: vscode.CustomDocumentOpenContext,
		_token: vscode.CancellationToken
	): Promise<CsvDocument> {
		const stats = await vscode.workspace.fs.stat(uri);
		return new CsvDocument(uri, stats.size);
	}

	public async resolveCustomEditor(
		document: CsvDocument,
		webviewPanel: vscode.WebviewPanel,
		_token: vscode.CancellationToken
	): Promise<void> {
		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
		};

		webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

		type ViewMode = 'full' | 'head' | 'tail' | 'text' | 'chunked';
		let viewMode: ViewMode = 'full';

		const config = vscode.workspace.getConfiguration('csvClearView');
		const safeModeThresholdMB = config.get<number>('safeModeThreshold') || 20;
		const LARGE_FILE_THRESHOLD = safeModeThresholdMB * 1024 * 1024;

		// Row index built lazily for chunked mode
		let rowIndex: RowIndex | null = null;

		// Becomes true when the panel is closed — prevents postMessage on a dead webview
		let disposed = false;

		// ----------------------------------------------------------------
		// Determine view mode for large files
		// ----------------------------------------------------------------
		if (document.size > LARGE_FILE_THRESHOLD) {
			const isHuge = document.size > CHUNKED_MODE_THRESHOLD;

			const options: (vscode.QuickPickItem & { id: ViewMode })[] = [
				...(isHuge ? [] : [{
					id: 'full' as ViewMode,
					label: '$(file-binary) Open Full File',
					description: 'Load all data into the grid (may be slow)',
					detail: `Full file size: ${(document.size / (1024 * 1024)).toFixed(2)} MB`
				}]),
				{
					id: 'chunked' as ViewMode,
					label: '$(list-flat) Paged View',
					description: 'Stream rows on demand — works for any file size',
					detail: isHuge
						? `File is ${(document.size / (1024 * 1024 * 1024)).toFixed(2)} GB — full load is disabled`
						: undefined
				},
				{
					id: 'head',
					label: '$(arrow-up) Show Head',
					description: 'Preview the first 1,000 rows'
				},
				{
					id: 'tail',
					label: '$(arrow-down) Show Tail',
					description: 'Preview the last 1,000 rows'
				},
				{
					id: 'text',
					label: '$(file-code) Open as Plain Text',
					description: 'Fast raw text view without grid features'
				}
			];

			const selection = await vscode.window.showQuickPick(options, {
				placeHolder: `This file is large (${(document.size / (1024 * 1024)).toFixed(2)} MB). How would you like to open it?`,
				ignoreFocusOut: true
			}, _token);

			if (selection) {
				viewMode = selection.id;
			} else {
				// User cancelled — default to chunked for huge files, head otherwise
				viewMode = isHuge ? 'chunked' : 'head';
			}
		}

		// ----------------------------------------------------------------
		// Build row-offset index (chunked mode only).
		// buildRowIndex is async and yields the event loop between blocks,
		// so it does not block the extension host.
		// ----------------------------------------------------------------
		let indexReady = false;
		const ensureIndex = async (): Promise<RowIndex> => {
			if (rowIndex) { return rowIndex; }
			rowIndex = await this.buildRowIndex(document.uri, document.size);
			indexReady = true;
			return rowIndex;
		};

		// ----------------------------------------------------------------
		// updateWebview — sends initial data to the webview
		// ----------------------------------------------------------------
		const updateWebview = async () => {
			try {
				const cfg = vscode.workspace.getConfiguration('csvClearView');
				let text = '';

				if (viewMode === 'chunked') {
					// Fast path: send the first ~512 KB immediately so the webview
					// can show the header and first rows while the index builds in
					// the background.
					const FIRST_CHUNK_BYTES = 512 * 1024;
					const firstBytes = await this.readRange(document.uri, 0, FIRST_CHUNK_BYTES);
					let firstText = Buffer.from(firstBytes).toString('utf8');
					// Trim to a complete line
					const lastNl = firstText.lastIndexOf('\n');
					if (lastNl !== -1) { firstText = firstText.substring(0, lastNl + 1); }

					// Send with totalRows = -1 to signal "index still building"
				webviewPanel.webview.postMessage({
					type: 'update',
					text: firstText,
					isLargeFile: true,
					viewMode: 'chunked',
					totalRows: -1,        // placeholder — updated once index is ready
					chunkSize: CHUNK_ROWS,
					fileExtension: document.uri.fsPath.split('.').pop()?.toLowerCase() || 'csv',
					config: {
						stickyHeader: cfg.get('stickyHeader'),
						alternatingRows: cfg.get('alternatingRows'),
						forceTextColumnColoring: cfg.get('forceTextColumnColoring'),
						safeModeThreshold: safeModeThresholdMB,
						showSlowLoadPrompt: cfg.get('showSlowLoadPrompt'),
						delimiter: cfg.get('delimiter') || 'auto'
					}
				});

				// Build the index in the background; when done, update the webview
				// with the real total row count.
				ensureIndex().then(idx => {
					if (disposed) { return; }
					webviewPanel.webview.postMessage({
							type: 'indexReady',
							totalRows: idx.totalRows - 1 // exclude header
						});
					}).catch(err => {
						console.error('Error building row index:', err);
						vscode.window.showErrorMessage('CSV ClearView: Failed to index large file.');
					});

					return;
				}

				if (viewMode === 'full' || viewMode === 'text') {
					const uint8Array = await vscode.workspace.fs.readFile(document.uri);
					text = Buffer.from(uint8Array).toString('utf8');
				} else if (viewMode === 'head') {
					// Read the first 256KB as a safe "head" buffer
					const headSize = Math.min(document.size, 256 * 1024);
					const uint8Array = await this.readRange(document.uri, 0, headSize);
					text = Buffer.from(uint8Array).toString('utf8');
					// Ensure we don't end with a partial line
					const lastNewline = text.lastIndexOf('\n');
					if (lastNewline !== -1) {
						text = text.substring(0, lastNewline + 1);
					}
				} else if (viewMode === 'tail') {
					// Read header (first 10KB)
					const headerSize = Math.min(document.size, 10 * 1024);
					const headerBytes = await this.readRange(document.uri, 0, headerSize);
					let headerText = Buffer.from(headerBytes).toString('utf8');
					const firstNewline = headerText.indexOf('\n');
					if (firstNewline !== -1) {
						headerText = headerText.substring(0, firstNewline + 1);
					}

					// Read tail (last 256KB)
					const tailSize = Math.min(document.size, 256 * 1024);
					const tailBytes = await this.readRange(document.uri, document.size - tailSize, tailSize);
					let tailText = Buffer.from(tailBytes).toString('utf8');
					// Ensure we start with a full line
					const firstNewlineInTail = tailText.indexOf('\n');
					if (firstNewlineInTail !== -1) {
						tailText = tailText.substring(firstNewlineInTail + 1);
					}
					text = headerText + tailText;
				}

			const isLargeFile = document.size > LARGE_FILE_THRESHOLD;

			if (disposed) { return; }
			webviewPanel.webview.postMessage({
					type: 'update',
					text: text,
					isLargeFile: isLargeFile,
					viewMode: viewMode,
					fileExtension: document.uri.fsPath.split('.').pop()?.toLowerCase() || 'csv',
					config: {
						stickyHeader: cfg.get('stickyHeader'),
						alternatingRows: cfg.get('alternatingRows'),
						forceTextColumnColoring: cfg.get('forceTextColumnColoring'),
						safeModeThreshold: safeModeThresholdMB,
						showSlowLoadPrompt: cfg.get('showSlowLoadPrompt'),
						delimiter: cfg.get('delimiter') || 'auto'
					}
				});
			} catch (err) {
				console.error('Error updating webview:', err);
				vscode.window.showErrorMessage('Error loading CSV file contents.');
			}
		};

		// Initial update
		updateWebview();

		// Handle file changes
		const watcher = vscode.workspace.createFileSystemWatcher(document.uri.fsPath);
		watcher.onDidChange(() => {
			// Invalidate row index so it is rebuilt on next access
			rowIndex = null;
			updateWebview();
		});

		webviewPanel.onDidDispose(() => {
			disposed = true;
			watcher.dispose();
		});

		// ----------------------------------------------------------------
		// Message handler — receives requests from the webview
		// ----------------------------------------------------------------
		webviewPanel.webview.onDidReceiveMessage(async e => {
			switch (e.type) {
				case 'edit':
					if (viewMode === 'chunked') {
						console.warn('CSV ClearView: edit ignored — file is in chunked (read-only) mode');
						return;
					}
					if (typeof e.text !== 'string') {
						console.error('Invalid edit message: text must be a string');
						return;
					}
					// Guard against implausibly large payloads (100MB)
					if (e.text.length > 100 * 1024 * 1024) {
						console.error('Edit payload too large, ignoring');
						return;
					}
					this.saveDocument(document, e.text);
					return;

				case 'runQuery': {
				// Execute an AlaSQL SELECT query on the extension host (avoids unsafe-eval in webview CSP).
				// e.query: SQL string, e.data: array of row-objects to query against
				if (typeof e.query !== 'string' || !Array.isArray(e.data)) {
					webviewPanel.webview.postMessage({ type: 'queryError', message: 'Invalid query request' });
					return;
				}
				try {
					const result = alasql(e.query, [e.data]);
					webviewPanel.webview.postMessage({ type: 'queryResult', result });
				} catch (err: any) {
					webviewPanel.webview.postMessage({ type: 'queryError', message: err.message || String(err) });
				}
				return;
			}

			case 'requestPage': {
					// Webview requests a specific page of rows.
					// e.startRow: 0-based data row index (excludes header)
					// e.rowCount: number of rows requested
					if (viewMode !== 'chunked') { return; }
					const startDataRow = typeof e.startRow === 'number' ? e.startRow : 0;
					const rowCount = typeof e.rowCount === 'number' ? e.rowCount : CHUNK_ROWS;

				try {
					const idx = await ensureIndex();
					if (disposed) { return; }
					// Row 0 in the index is the header; data rows start at index 1.
						const indexStart = startDataRow + 1; // skip header row in index
				const text = await this.readRows(idx, indexStart, rowCount);
					if (disposed) { return; }
					webviewPanel.webview.postMessage({
							type: 'pageData',
							startRow: startDataRow,
							text
						});
					} catch (err) {
						console.error('Error serving page request:', err);
					}
					return;
				}
			}
		});
	}

	// ----------------------------------------------------------------
	// Build a sampled byte-offset index.
	//
	// We scan the file in 4MB blocks, yielding the Node event loop between
	// blocks so the extension host stays responsive.  One checkpoint is
	// recorded every SAMPLE_INTERVAL bytes so the index stays tiny even for
	// 10 GB+ files (a 10 GB file at 4 MB intervals → ~2,500 checkpoints).
	// ----------------------------------------------------------------
	private async buildRowIndex(uri: vscode.Uri, fileSize: number): Promise<RowIndex> {
		const SCAN_BLOCK     = 4 * 1024 * 1024;  // 4 MB read blocks
		const SAMPLE_INTERVAL = 4 * 1024 * 1024; // one checkpoint per 4 MB

		const fs = require('fs') as typeof import('fs');
		const fd = fs.openSync(uri.fsPath, 'r');

		const checkpointBytes: number[] = [0]; // checkpoint 0: byte 0, row 0
		const checkpointRows:  number[] = [0];

		let offset    = 0;
		let rowCount  = 0; // rows seen so far (row 0 = header at byte 0)
		let inQuotes  = false;
		let nextSample = SAMPLE_INTERVAL; // next byte offset at which to save a checkpoint
		let lastByteWasNewline = false;

		try {
			const buf = Buffer.alloc(SCAN_BLOCK);
			while (offset < fileSize) {
				// Yield the event loop every block so the extension host stays responsive
				await new Promise<void>(resolve => setImmediate(resolve));

				const toRead   = Math.min(SCAN_BLOCK, fileSize - offset);
				const bytesRead = fs.readSync(fd, buf, 0, toRead, offset);
				if (bytesRead === 0) { break; }

			for (let i = 0; i < bytesRead; i++) {
				const ch = buf[i];
				if (ch === 0x22 /* " */) {
					inQuotes = !inQuotes;
				} else if (!inQuotes && ch === 0x0a /* \n */) {
					rowCount++;
					const nextRowByte = offset + i + 1;
					if (nextRowByte < fileSize && nextRowByte >= nextSample) {
						checkpointBytes.push(nextRowByte);
						checkpointRows.push(rowCount);
						nextSample = nextRowByte + SAMPLE_INTERVAL;
					}
				}
				lastByteWasNewline = (ch === 0x0a);
			}
				offset += bytesRead;
			}
		} finally {
			fs.closeSync(fd);
		}

		// If the file does NOT end with a newline, the final row wasn't counted yet — add 1.
		// If it does end with a newline, rowCount is already the total row count.
		const totalRows = lastByteWasNewline ? rowCount : rowCount + 1;

		return { checkpointBytes, checkpointRows, totalRows, fsPath: uri.fsPath };
	}

	// ----------------------------------------------------------------
	// Read `rowCount` rows starting at `startRowIndex` using the sampled index.
	//
	// 1. Binary-search checkpoints for the one just before startRowIndex.
	// 2. Open the file, seek to that checkpoint's byte offset.
	// 3. Scan forward row-by-row until we reach startRowIndex, then read
	//    rowCount rows and return them as a UTF-8 string.
	// ----------------------------------------------------------------
	private async readRows(index: RowIndex, startRowIndex: number, rowCount: number): Promise<string> {
		if (index.totalRows === 0) { return ''; }

		const clampedStart = Math.max(0, Math.min(startRowIndex, index.totalRows - 1));
		const clampedEnd   = Math.min(clampedStart + rowCount, index.totalRows);
		if (clampedStart >= clampedEnd) { return ''; }

		// Binary search: find the last checkpoint whose row index <= clampedStart
		const { checkpointBytes, checkpointRows } = index;
		let lo = 0, hi = checkpointRows.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (checkpointRows[mid] <= clampedStart) { lo = mid; } else { hi = mid - 1; }
		}
		const cpByte = checkpointBytes[lo];
		const cpRow  = checkpointRows[lo];

		const fs = require('fs') as typeof import('fs');
		const fd = fs.openSync(index.fsPath, 'r');

		try {
			const SCAN_BLOCK = 256 * 1024; // 256 KB forward-scan buffer
			const buf = Buffer.alloc(SCAN_BLOCK);
			let offset    = cpByte;
			let currentRow = cpRow;
			let inQuotes  = false;

			// Phase 1: scan forward until we reach clampedStart
			while (currentRow < clampedStart) {
				const bytesRead = fs.readSync(fd, buf, 0, SCAN_BLOCK, offset);
				if (bytesRead === 0) { return ''; }

				for (let i = 0; i < bytesRead; i++) {
					const ch = buf[i];
					if (ch === 0x22) { inQuotes = !inQuotes; }
					else if (!inQuotes && ch === 0x0a) {
						currentRow++;
						if (currentRow >= clampedStart) {
							// The next byte is the start of clampedStart
							offset = offset + i + 1;
							// Break both loops by jumping to Phase 2
							// eslint-disable-next-line no-labels
							break;
						}
					}
				}
				if (currentRow < clampedStart) {
					offset += bytesRead;
				}
			}

			// Phase 2: read from offset until we have collected (clampedEnd - clampedStart) rows
			const chunks: Buffer[] = [];
			let rowsCollected = 0;
			const needed = clampedEnd - clampedStart;

			while (rowsCollected < needed) {
				const bytesRead = fs.readSync(fd, buf, 0, SCAN_BLOCK, offset);
				if (bytesRead === 0) { break; }

				let segEnd = -1;
				for (let i = 0; i < bytesRead; i++) {
					const ch = buf[i];
					if (ch === 0x22) { inQuotes = !inQuotes; }
					else if (!inQuotes && ch === 0x0a) {
						rowsCollected++;
						if (rowsCollected >= needed) {
							segEnd = i + 1; // include the newline
							break;
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

	private async readRange(uri: vscode.Uri, offset: number, length: number): Promise<Uint8Array> {
		const stats = await vscode.workspace.fs.stat(uri);
		const actualLength = Math.min(length, stats.size - offset);

		if (actualLength <= 0) { return new Uint8Array(0); }

		const fs = require('fs');
		const fd = fs.openSync(uri.fsPath, 'r');
		try {
			const buffer = Buffer.alloc(actualLength);
			fs.readSync(fd, buffer, 0, actualLength, offset);
			return buffer;
		} finally {
			fs.closeSync(fd);
		}
	}

	private async saveDocument(document: CsvDocument, text: string) {
		const uint8Array = Buffer.from(text, 'utf8');
		await vscode.workspace.fs.writeFile(document.uri, uint8Array);
	}

	async saveCustomDocument(document: CsvDocument, _cancellation: vscode.CancellationToken): Promise<void> {
		// Since we save on every edit for now, this is just to satisfy the interface.
		// In a more complex app, we'd handle dirty states here.
	}

	async saveCustomDocumentAs(document: CsvDocument, destination: vscode.Uri, _cancellation: vscode.CancellationToken): Promise<void> {
		const uint8Array = await vscode.workspace.fs.readFile(document.uri);
		await vscode.workspace.fs.writeFile(destination, uint8Array);
	}

	// Unused for CustomEditorProvider but keeping for structure
	readonly onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<CsvDocument>>().event;
	async backupCustomDocument(_document: CsvDocument, _context: vscode.CustomDocumentBackupContext, _token: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
		return { id: '', delete: () => {} };
	}
	async revertCustomDocument(_document: CsvDocument, _token: vscode.CancellationToken): Promise<void> {}

	private getHtmlForWebview(webview: vscode.Webview): string {
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'csv.js'));
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'csv.css'));

		const nonce = getNonce();

		return `
			<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<link href="${styleUri}" rel="stylesheet" />
				<title>CSV ClearView</title>
			</head>
			<body>
				<div id="loader" class="loader-overlay hidden">
					<div class="loader-container">
						<div class="progress-container indeterminate">
							<div class="progress-bar"></div>
						</div>
						<div class="loader-text">Loading CSV...</div>
					</div>
				</div>

				<div id="slow-load-modal" class="loader-overlay hidden">
					<div class="loader-container" style="background: var(--vscode-editor-background); border: 1px solid var(--vscode-widget-border); padding: 20px; width: 300px; box-shadow: 0 4px 8px rgba(0,0,0,0.5);">
						<div class="loader-text" style="opacity: 1; margin-bottom: 15px; font-weight: bold;">Rendering is taking a while...</div>
						<div class="loader-text" style="opacity: 0.8; margin-bottom: 20px; text-align: center;">This file is very large. Would you like to switch to Plain Text mode for instant viewing?</div>
						<div style="display: flex; gap: 10px; width: 100%;">
							<button id="switch-to-text" style="flex: 1;">Plain Text</button>
							<button id="continue-waiting" style="flex: 1; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);">Continue</button>
						</div>
					</div>
				</div>
				<div id="error-ruler" class="error-ruler"></div>
				<div id="warning-container" class="warning-container hidden"></div>
				<div id="controls" class="controls">
					<div class="autocomplete-container">
						<input type="text" id="sql-query" placeholder="SELECT * FROM ? WHERE [Last Name] = 'Smith'" autocomplete="off" />
						<div id="history-list" class="history-list hidden"></div>
					</div>
					<button id="history-btn" title="Query History (↑/↓ to navigate)">History</button>
					<button id="run-query">Run Query</button>
					<button id="reset-query">Reset</button>
					<button id="profile-btn" title="Toggle column profile panel">Profile</button>
					<div id="delimiter-display" class="delimiter-badge hidden" title="Click to change delimiter">Delim: ,</div>
				</div>
				<div id="error-container" class="error-container hidden"></div>
				<div class="table-area">
					<div class="header-container">
						<table id="header-table"></table>
					</div>
					<div class="table-container">
						<div id="virtual-spacer" class="virtual-spacer"></div>
						<table id="csv-table"></table>
					</div>
				</div>
				<div id="schema-panel" class="schema-panel hidden">
					<div class="schema-panel-header">
						<span class="schema-panel-title">Column Profile</span>
						<button id="schema-close-btn" class="schema-close-btn" title="Close panel">✕</button>
					</div>
					<div id="schema-panel-body" class="schema-panel-body"></div>
				</div>
				<div id="stats-popover" class="stats-popover hidden"></div>
				<div id="text-container" class="text-container hidden">
					<pre id="raw-text"></pre>
			</div>
			<script nonce="${nonce}" src="${scriptUri}"></script>
			</body>
			</html>`;
	}
}

function getNonce(): string {
	return crypto.randomBytes(16).toString('hex');
}
