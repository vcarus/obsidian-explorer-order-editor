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
 * `the order note <why it cannot be written>` — the shared middle of every
 * refusal notice, so the fallback wording for "the store never said why" is
 * written once.
 *
 * A clause rather than a whole sentence on purpose: the seven callers open
 * differently ("Could not save:", "Could not remove stale entries:", and one
 * that leads with a move that *did* happen) and end differently ("then drag
 * it again", "or check the console for details"). Only the middle was ever
 * really the same, and forcing the rest through one template would have meant
 * a parameter per caller.
 */
export function unusableClause(store: IndexFileStore): string {
	return `the order note ${store.unusableReason() ?? 'could not be repaired'}`;
}

/**
 * Points at the one control that can do something about it.
 *
 * Single-sourced because of what it has to say now: repair is no longer the
 * only way out. When nothing is recoverable it offers to start over, and a
 * user told only to "repair" would keep pressing a button that correctly
 * refuses. That sentence had to reach seven notices, which is the whole
 * argument for it living here.
 *
 * `where` exists because the settings tab is one of those callers and cannot
 * sensibly tell the reader to go to the settings tab.
 */
export function repairPointer(where: 'in the settings tab' | 'from elsewhere'): string {
	const location = where === 'in the settings tab' ? 'above' : 'in settings';
	return `Use "Repair the order note" ${location} — it offers to start over when nothing can be recovered.`;
}
