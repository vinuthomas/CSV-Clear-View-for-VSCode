import * as vscode from 'vscode';

/**
 * One-time, non-nagging "leave a review" prompt.
 *
 * Shown only after the user has opened files in CSV ClearView a number of times
 * across at least a few days, so it reaches people who actually use the
 * extension. "Later" (or dismissing the toast) defers it; "Don't ask again" or
 * rating ends it for good. State lives in globalState, so it follows the user
 * across workspaces.
 */

export interface ReviewPromptState {
	/** Files opened in CSV ClearView since install. */
	openCount: number;
	/** Epoch ms of the first recorded open. */
	firstOpenAt: number;
	/** Open count at which the prompt may next be shown. */
	nextPromptAt: number;
	/** True once the user has rated or chosen "Don't ask again". */
	done: boolean;
}

export const MIN_OPENS = 10;
export const MIN_DAYS = 3;
export const DEFER_OPENS = 25;
const DAY_MS = 24 * 60 * 60 * 1000;

const STATE_KEY = 'csvClearView.reviewPrompt';

const MARKETPLACE_REVIEW_URL =
	'https://marketplace.visualstudio.com/items?itemName=VinuThomas.csv-clearview&ssr=false#review-details';
const OPEN_VSX_REVIEW_URL = 'https://open-vsx.org/extension/vinuthomas/csv-clearview/reviews';

export function initialState(now: number): ReviewPromptState {
	return { openCount: 0, firstOpenAt: now, nextPromptAt: MIN_OPENS, done: false };
}

/** Pure: record one open and decide whether to show the prompt now. */
export function recordOpen(
	prev: ReviewPromptState | undefined,
	now: number
): { state: ReviewPromptState; shouldPrompt: boolean } {
	const base = prev ?? initialState(now);
	const state: ReviewPromptState = { ...base, openCount: base.openCount + 1 };
	const shouldPrompt =
		!state.done &&
		state.openCount >= state.nextPromptAt &&
		now - state.firstOpenAt >= MIN_DAYS * DAY_MS;
	return { state, shouldPrompt };
}

/**
 * VS Code itself installs from the Microsoft Marketplace; forks (Cursor,
 * Windsurf, VSCodium, …) typically install from Open VSX.
 */
export function reviewUrlFor(appName: string): string {
	return /^Visual Studio Code/i.test(appName) ? MARKETPLACE_REVIEW_URL : OPEN_VSX_REVIEW_URL;
}

let promptShownThisSession = false;

export async function maybePromptForReview(context: vscode.ExtensionContext): Promise<void> {
	const { state, shouldPrompt } = recordOpen(
		context.globalState.get<ReviewPromptState>(STATE_KEY),
		Date.now()
	);
	await context.globalState.update(STATE_KEY, state);

	if (!shouldPrompt || promptShownThisSession) {
		return;
	}
	promptShownThisSession = true;

	const rate = 'Rate CSV ClearView';
	const later = 'Later';
	const never = "Don't ask again";
	const choice = await vscode.window.showInformationMessage(
		"Finding CSV ClearView useful? A quick rating helps other people find it — it's the single biggest thing you can do to support the project.",
		rate,
		later,
		never
	);

	// Re-read so we don't overwrite opens recorded while the toast was up.
	const latest = context.globalState.get<ReviewPromptState>(STATE_KEY) ?? state;
	if (choice === rate) {
		await vscode.env.openExternal(vscode.Uri.parse(reviewUrlFor(vscode.env.appName)));
		await context.globalState.update(STATE_KEY, { ...latest, done: true });
	} else if (choice === never) {
		await context.globalState.update(STATE_KEY, { ...latest, done: true });
	} else {
		await context.globalState.update(STATE_KEY, {
			...latest,
			nextPromptAt: latest.openCount + DEFER_OPENS
		});
	}
}
