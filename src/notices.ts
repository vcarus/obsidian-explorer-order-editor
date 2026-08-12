/**
 * The two things every action in this plugin says when it finishes, kept in
 * one place because five and seven copies of them respectively had already
 * drifted apart in wording, and because one of them went stale the moment
 * "start over" existed: every "this could not be written" notice still
 * pointed at repair alone.
 *
 * Deliberately not in `indexFile.ts`, which owns the index's runtime life and
 * has no business owning user-facing copy, and deliberately not taking the
 * settings object — `autoRefresh` is the only field any of this reads, and
 * asking for the whole shape would put a circular import between this and
 * `settings.ts` for no gain.
 */
import { Notice, type App } from 'obsidian';
import { requestFileExplorerResort, type IndexFileStore } from './indexFile';

/**
 * Reports a change that has already been written, and asks the file explorer
 * to show it.
 *
 * Two outcomes are worth telling the user about and one is not: a redraw that
 * happens is its own feedback, so it says nothing. `autoRefresh` off is the
 * user's own setting, named so the absence of a redraw doesn't read as a
 * failure; no file explorer leaf at all is rare, and reported for the same
 * reason — a change that is invisible everywhere must not be mistaken for one
 * that took effect.
 *
 * `done` is the verb the second case leads with. It is a closed set rather
 * than free text so a new caller has to pick one of the sentences that
 * actually exist.
 */
export function reportApplied(app: App, autoRefresh: boolean, done: 'Saved' | 'Cleared'): void {
	if (!autoRefresh) {
		new Notice('Automatic refresh is off. The file explorer will show this on its next refresh.');
		return;
	}
	if (!requestFileExplorerResort(app)) {
		new Notice(`${done}. The file explorer will show this when you next open it.`);
	}
}

/**
 * `data.json` could not be read at startup, so every setting is at its
 * default for this session.
 *
 * Said out loud rather than logged, because the settings tab will show the
 * defaults as though they were the user's own choices, and one of the values
 * behind them is where the order note lives: with a custom location
 * unreadable, the store looks at the default path and finds nothing. The
 * orders themselves are safe — this is the one thing worth saying about a
 * failure whose whole visible symptom is "my settings look wrong".
 */
export function dataUnreadable(): void {
	new Notice(
		'Could not read data.json, so the settings for this plugin are showing their defaults for now — including where the order note is kept. ' +
			'Saved orders are untouched and that file will not be overwritten. See the console, then reload the plugin once it can be read again.',
	);
}

/**
 * `data.json` became readable again and the real settings are back.
 *
 * The counterpart to `dataUnreadable`, and said out loud for the same reason:
 * the values in the settings tab just changed under the user without them
 * touching anything. Silence would leave the earlier warning as the last word
 * on a condition that has since resolved.
 */
export function settingsRecovered(): void {
	new Notice("Read this plugin's data.json again — your settings are back, and changes to them will be saved from now on.");
}

/**
 * A settings change that could not be persisted.
 *
 * The toggle stays where the user put it for this session, so silence here
 * would be a lie of exactly the kind `retryFailedWrite` exists to prevent on
 * the write side: the UI says the change took, and the next restart disagrees.
 *
 * `cause` separates the refusal (`updateData` would not replace a file it
 * could not read, and the file is intact) from a write that failed on its own
 * (it may not be) — the two send the user to look at different things. A
 * closed set rather than a boolean for the reason `reportApplied` gives above:
 * a third failure mode should have to pick a sentence that exists.
 */
export function settingNotSaved(cause: 'unreadable' | 'write-failed'): void {
	new Notice(
		cause === 'unreadable'
			? "Could not save this plugin's settings: data.json could not be read, so it was left as it is rather than overwritten. The change applies for this session only."
			: "Could not save this plugin's settings: writing data.json failed. See the console. The change applies for this session only.",
	);
}

/**
 * A reason written as a standalone sentence ("Its json block is missing"),
 * re-cased to sit inside one.
 *
 * Every reason `IndexFileStore` can record is capitalized — they are authored
 * that way in `orderIndex.ts` and in `MISSING_BLOCK_REASON`, because each is
 * also shown as its own sentence in the Notice raised when the store goes
 * unusable. This is the one place they get embedded mid-sentence, so it is the
 * one place that has to lower the capital. Without it all seven refusal
 * notices read "Could not save: the order note Its json block is missing",
 * against `CLAUDE.md`'s "UI copy is sentence case".
 *
 * Only the first character, and nothing cleverer: every existing reason is an
 * ordinary sentence, and one that had to start with an acronym would be worth
 * rewording at the reason rather than special-casing here.
 */
function asClause(reason: string): string {
	return reason.charAt(0).toLowerCase() + reason.slice(1);
}

/**
 * `the order note <why it cannot be written>` — the shared middle of every
 * refusal notice, so the fallback wording for "the store never said why" is
 * written once.
 *
 * A clause rather than a whole sentence on purpose: callers open differently
 * ("Could not save:", "Could not remove stale entries:", and one that leads
 * with a move that *did* happen). Only the middle was ever really the same, and
 * forcing the openings through one template would have meant a parameter per
 * caller.
 *
 * Being that middle is also why the re-casing above belongs here and not at
 * the call sites, nor in the reasons themselves: a reason has to read as a
 * sentence where the store announces it, and as a clause here.
 *
 * No count of those callers is written down here, deliberately. The number was
 * stated once and was wrong within two commits, which is the whole reason the
 * console pointer below went missing without anything noticing.
 */
export function unusableClause(store: IndexFileStore): string {
	const reason = store.unusableReason();
	return `the order note ${reason === null ? 'could not be repaired' : asClause(reason)}`;
}

/**
 * Points at the one control that can do something about it.
 *
 * Single-sourced because of what it has to say now: repair is no longer the
 * only way out. When nothing is recoverable it offers to start over, and a
 * user told only to "repair" would keep pressing a button that correctly
 * refuses. Reaching every refusal notice with that is the whole argument for
 * it living here.
 *
 * The console sentence is part of it, and was lost once already: the notices
 * this replaced each ended "or check the console for details", and collapsing
 * their shared middle dropped their shared ending with it. That ending is not
 * decoration. Everything that explains *why* a refusal happened is written to
 * the console and nowhere else — the reason `markUnusable` logs, the error
 * `healThenUpdate` catches, and the two different causes that both surface as
 * "the attempt failed" — so a notice without it points the reader at a button
 * that will refuse again, with no route to the one place the answer is.
 *
 * `where` exists because the settings tab is one of those callers and cannot
 * sensibly tell the reader to go to the settings tab.
 */
export function repairPointer(where: 'in the settings tab' | 'from elsewhere'): string {
	const location = where === 'in the settings tab' ? 'above' : 'in settings';
	return `Use "Repair the order note" ${location} — it offers to start over when nothing can be recovered. See the console for details.`;
}

/**
 * The whole refusal Notice, for the callers whose sentence really is just
 * "Could not <verb phrase>: <clause>. <pointer>." — which is all of them but
 * one. The exception stays on the two parts directly: `explorerDrag.ts`'s
 * moved-unsaved case leads with a move that *did* happen, and forcing its
 * opening through this template is exactly the parameter-per-caller trap
 * `unusableClause`'s doc comment declines.
 *
 * Exists because that one-line scaffolding had been copied verbatim to seven
 * call sites, and E4 already showed what copies of a shared sentence do: drift
 * one word at a time with nothing to notice. The verb phrase is the only part
 * that was ever different, so it is the only parameter.
 */
export function refusalNotice(action: string, store: IndexFileStore, where: 'in the settings tab' | 'from elsewhere'): void {
	new Notice(`Could not ${action}: ${unusableClause(store)}. ${repairPointer(where)}`);
}
