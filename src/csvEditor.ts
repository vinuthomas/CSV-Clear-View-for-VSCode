import * as vscode from 'vscode';

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
	private readonly diagnostics = vscode.languages.createDiagnosticCollection('csv-clearview');

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
		};

		webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

		type ViewMode = 'full' | 'head' | 'tail' | 'text';
		let viewMode: ViewMode = 'full';
		
		const config = vscode.workspace.getConfiguration('csvClearView');
		const safeModeThresholdMB = config.get<number>('safeModeThreshold') || 20;
		const LARGE_FILE_THRESHOLD = safeModeThresholdMB * 1024 * 1024;

		if (document.size > LARGE_FILE_THRESHOLD) {
			const options: (vscode.QuickPickItem & { id: ViewMode })[] = [
				{
					id: 'full',
					label: '$(file-binary) Open Full File',
					description: 'Load all data into the grid (may be slow)',
					detail: `Full file size: ${(document.size / (1024 * 1024)).toFixed(2)} MB`
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
				// User cancelled - we can't really "cancel" resolve, so fallback to head
				viewMode = 'head';
			}
		}

		const updateWebview = async () => {
			try {
				const config = vscode.workspace.getConfiguration('csvClearView');
				let text = '';
				
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

				webviewPanel.webview.postMessage({
					type: 'update',
					text: text,
					isLargeFile: isLargeFile,
					viewMode: viewMode,
					config: {
						stickyHeader: config.get('stickyHeader'),
						alternatingRows: config.get('alternatingRows'),
						forceTextColumnColoring: config.get('forceTextColumnColoring'),
						safeModeThreshold: safeModeThresholdMB,
						showSlowLoadPrompt: config.get('showSlowLoadPrompt')
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
		watcher.onDidChange(() => updateWebview());
		
		webviewPanel.onDidDispose(() => {
			watcher.dispose();
		});

		// Receive message from the webview.
		webviewPanel.webview.onDidReceiveMessage(e => {
			switch (e.type) {
				case 'edit':
					this.saveDocument(document, e.text);
					return;
			}
		});
	}

	private async readRange(uri: vscode.Uri, offset: number, length: number): Promise<Uint8Array> {
		// vscode.workspace.fs.readFile doesn't support ranges, so we use Node's fs for large files if needed
		// but for now, we'll try a slice if it's small enough or use a more robust method
		const stats = await vscode.workspace.fs.stat(uri);
		const actualLength = Math.min(length, stats.size - offset);
		
		if (actualLength <= 0) return new Uint8Array(0);

		// Fallback to Node.js fs for range reading
		const fs = require('fs');
		const fd = fs.openSync(uri.fsPath, 'r');
		const buffer = Buffer.alloc(actualLength);
		fs.readSync(fd, buffer, 0, actualLength, offset);
		fs.closeSync(fd);
		return buffer;
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
		const alasqlUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'alasql.min.js'));

		const nonce = getNonce();

		return `
			<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}' 'unsafe-eval';">
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
				</div>
				<div id="error-container" class="error-container hidden"></div>
				<div class="header-container">
					<table id="header-table"></table>
				</div>
				<div class="table-container">
					<div id="virtual-spacer" class="virtual-spacer"></div>
					<table id="csv-table"></table>
				</div>
				<div id="text-container" class="text-container hidden">
					<pre id="raw-text"></pre>
				</div>
				<script nonce="${nonce}" src="${alasqlUri}"></script>
				<script nonce="${nonce}" src="${scriptUri}"></script>
			</body>
			</html>`;
	}
}

function getNonce() {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}