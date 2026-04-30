import * as vscode from 'vscode';
import { CsvEditorProvider } from './csvEditor';

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(CsvEditorProvider.register(context));

	context.subscriptions.push(
		vscode.commands.registerCommand('csvClearView.openWithCsvEditor', async (uri?: vscode.Uri) => {
			// If called from the command palette (no uri), use the active editor's file
			if (!uri) {
				const activeEditor = vscode.window.activeTextEditor;
				if (activeEditor) {
					uri = activeEditor.document.uri;
				}
			}

			if (!uri) {
				vscode.window.showErrorMessage('CSV ClearView: No file selected or open.');
				return;
			}

			await vscode.commands.executeCommand(
				'vscode.openWith',
				uri,
				'csvClearView.edit'
			);
		})
	);
}
