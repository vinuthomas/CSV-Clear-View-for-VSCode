import * as vscode from 'vscode';
import { CsvEditorProvider } from './csvEditor';

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(CsvEditorProvider.register(context));
}
