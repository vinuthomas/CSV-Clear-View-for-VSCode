import * as vscode from 'vscode';

export class CsvEditorProvider implements vscode.CustomTextEditorProvider {

	public static register(context: vscode.ExtensionContext): vscode.Disposable {
		const provider = new CsvEditorProvider(context);
		const providerRegistration = vscode.window.registerCustomEditorProvider(CsvEditorProvider.viewType, provider);
		return providerRegistration;
	}

	private static readonly viewType = 'csvClearView.edit';

	constructor(
		private readonly context: vscode.ExtensionContext
	) { }

	public async resolveCustomTextEditor(
		document: vscode.TextDocument,
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
		const safeModeThresholdMB = config.get<number>('safeModeThreshold') || 5;
		const LARGE_FILE_THRESHOLD = safeModeThresholdMB * 1024 * 1024;

		const stats = await vscode.workspace.fs.stat(document.uri);
		if (stats.size > LARGE_FILE_THRESHOLD) {
			const options: (vscode.QuickPickItem & { id: ViewMode })[] = [
				{
					id: 'full',
					label: '$(file-binary) Open Full File',
					description: 'Load all data into the grid (may be slow)',
					detail: `Full file size: ${(stats.size / (1024 * 1024)).toFixed(2)} MB`
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
				placeHolder: `This file is large (${(stats.size / (1024 * 1024)).toFixed(2)} MB). How would you like to open it?`,
				ignoreFocusOut: true
			});

			if (selection) {
				viewMode = selection.id;
			} else {
				return; // User cancelled
			}
		}

		const updateWebview = () => {
			const config = vscode.workspace.getConfiguration('csvClearView');
			let text = '';
			
			if (viewMode === 'full' || viewMode === 'text') {
				text = document.getText();
			} else if (viewMode === 'head') {
				const lineCount = Math.min(document.lineCount, 1001); // 1000 rows + header
				text = document.getText(new vscode.Range(0, 0, lineCount, 0));
			} else if (viewMode === 'tail') {
				const startLine = Math.max(0, document.lineCount - 1000);
				const header = document.getText(new vscode.Range(0, 0, 1, 0));
				const body = document.getText(new vscode.Range(startLine, 0, document.lineCount, 0));
				text = header + body;
			}

			const isLargeFile = stats.size > LARGE_FILE_THRESHOLD;

			webviewPanel.webview.postMessage({
				type: 'update',
				text: text,
				isLargeFile: isLargeFile,
				viewMode: viewMode,
				config: {
					stickyHeader: config.get('stickyHeader'),
					alternatingRows: config.get('alternatingRows'),
					forceTextColumnColoring: config.get('forceTextColumnColoring'),
					safeModeThreshold: safeModeThresholdMB
				}
			});
		};

		const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
			if (e.document.uri.toString() === document.uri.toString()) {
				updateWebview();
			}
		});

		// Refresh the webview when it regains focus/visibility
		webviewPanel.onDidChangeViewState(e => {
			if (e.webviewPanel.visible) {
				updateWebview();
			}
		});

		// Make sure we get rid of the listener when our editor is closed.
		webviewPanel.onDidDispose(() => {
			changeDocumentSubscription.dispose();
		});

		// Receive message from the webview.
		webviewPanel.webview.onDidReceiveMessage(e => {
			switch (e.type) {
				case 'edit':
					this.updateTextDocument(document, e.text);
					return;
			}
		});

		// Initial update
		updateWebview();
	}

	private updateTextDocument(document: vscode.TextDocument, text: string) {
		const edit = new vscode.WorkspaceEdit();

		// Replace the entire document content
		edit.replace(
			document.uri,
			new vscode.Range(0, 0, document.lineCount, 0),
			text
		);

		return vscode.workspace.applyEdit(edit);
	}

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
				<div id="warning-container" class="warning-container hidden"></div>
				<div id="controls" class="controls">
					<div class="autocomplete-container">
						<input type="text" id="sql-query" placeholder="SELECT * FROM ? WHERE [Last Name] = 'Smith'" autocomplete="off" />
					</div>
					<button id="run-query">Run Query</button>
					<button id="reset-query">Reset</button>
				</div>
				<div id="error-container" class="error-container hidden"></div>
				<div class="table-container">
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
