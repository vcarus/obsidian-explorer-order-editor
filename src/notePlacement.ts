/**
 * Pure decisions behind the settings tab's "Order note location" row: which
 * folders to offer, where the note would land in one, whether that is a move
 * at all, and what the row says and allows in each state the plugin can be in.
 *
 * Nothing here moves anything. The move itself is one
 * `fileManager.renameFile` in `settings.ts`, and *following* it — updating
 * `indexPath`, saving, announcing — is `IndexFileStore`'s existing rename
 * listener, the same one that follows a rename made by hand. This module only
 * decides, so the deciding can be tested; same discipline as `quarantine.ts`,
 * whose path vocabulary (`parentPathOf`/`baseNameOf`) it shares.
 *
 * Folder paths use the convention `parentPathOf` already has for a root-level
 * note: the vault root is `''`. A caller holding a `TFolder` maps
 * `isRoot()` to `''` once, rather than this module learning what
 * `TFolder.path` literally is for the root (`'/'`, as it happens, and the
 * reason `folderIndexKey` exists).
 */
import { baseNameOf, compareNames, parentPathOf } from './types';

/**
 * Where a note at `notePath` would be after moving it into `folderPath`,
 * keeping its file name. Renaming the file itself is not something this row
 * offers — only where it lives.
 */
export function notePathIn(folderPath: string, notePath: string): string {
	const name = baseNameOf(notePath);
	return folderPath === '' ? name : `${folderPath}/${name}`;
}

export type NoteMovePlan =
	| { readonly kind: 'move'; readonly target: string }
	/** Already there: nothing to do. The picker does not offer this folder, so this is the race where the note moved after it opened. */
	| { readonly kind: 'same-folder' }
	/** Something already has the target path. Refused before anything is touched, never resolved by renaming either file. */
	| { readonly kind: 'taken'; readonly target: string };

/**
 * What moving the note at `notePath` into `folderPath` would do.
 *
 * `normalize` is `obsidian`'s `normalizePath`, injected so this module stays
 * import-free; the target is normalized once, here, so the path `isTaken` is
 * asked about and the path the caller renames to cannot differ. `isTaken` is
 * injected for the same reason `findFreeQuarantinePath` takes one: it is a
 * vault lookup, and the answer it gives is the only thing this needs from
 * the vault.
 */
export function planNoteMove(
	notePath: string,
	folderPath: string,
	normalize: (path: string) => string,
	isTaken: (path: string) => boolean,
): NoteMovePlan {
	if (folderPath === parentPathOf(notePath)) return { kind: 'same-folder' };
	const target = normalize(notePathIn(folderPath, notePath));
	return isTaken(target) ? { kind: 'taken', target } : { kind: 'move', target };
}

/**
 * The folders the picker offers: every folder except the one the note is
 * already in, root first and the rest by path.
 *
 * Excluded rather than offered-and-refused: choosing the folder the note is
 * already in has exactly one answer, "nothing happened", and a list that can
 * only produce that answer for one of its entries is better off without it.
 * `planNoteMove` still answers `'same-folder'` for the race.
 *
 * `compareNames` rather than a bare `localeCompare` for the reason it exists
 * (`types.ts`): two folders whose names differ only in Unicode normalization
 * would otherwise list in whatever order the vault enumerated them. The root
 * needs no special case — `''` sorts before every non-empty path.
 */
export function folderChoices<T>(folders: readonly T[], pathOf: (folder: T) => string, notePath: string): T[] {
	const current = parentPathOf(notePath);
	return folders.filter((folder) => pathOf(folder) !== current).sort((a, b) => compareNames(pathOf(a), pathOf(b)));
}

export interface NoteLocationState {
	/** `indexNotePath(settings)` — normalized. */
	readonly notePath: string;
	/** Whether the vault has a file at `notePath` right now (`getFileByPath`). */
	readonly noteInVault: boolean;
	/** `settingsAreDefaulted()`: `data.json` could not be read, so `notePath` is the default rather than the user's. */
	readonly settingsDefaulted: boolean;
	/** How many kept copies of an unreadable version sit beside the note (`quarantineFiles()` on the settings tab). */
	readonly keptCopies: number;
}

export interface NoteLocationRow {
	readonly canMove: boolean;
	readonly desc: string;
}

/**
 * What the row says, and whether its button works.
 *
 * Two states disable it, and in both the reason is that a move could only
 * point the plugin at a path it has no note for — the failure the settings
 * tab's header comment gives for never offering a free-text path field:
 *
 * - **Settings unreadable.** `notePath` is the default, not the user's, and
 *   whatever the move changed could not be saved. A restart, or the settings
 *   coming back on their own (`onExternalSettingsChange`), would reload the
 *   real `indexPath` — which no longer names where the note is.
 * - **No note in the vault.** There is nothing to move, and the alternative —
 *   rewriting `indexPath` to the chosen folder and letting the next write
 *   create the note there — is a path change with no file attached. On a
 *   device still waiting for sync to deliver the note, it would point the
 *   plugin away from the note that is about to arrive, and every order
 *   would look gone. The note is created the next time an order is saved,
 *   and from then on it can be moved like any other.
 *
 * A third disables it for a different reason — not where the plugin would
 * point, but what the move would leave behind:
 *
 * - **Kept copies beside the note.** They are found by looking in the note's
 *   own folder (`quarantineFolderPath`), so a move would strand them in the
 *   old one, out of reach of the row that deletes them. Not lost — they stay
 *   visible in the file explorer — but no longer the plugin's to clean up.
 *   Moving them along was rejected: several renames, any of which can fail
 *   partway. A rename made by hand in the file explorer can still strand
 *   them; this only keeps the plugin's own button from doing it.
 *
 * Settings first: while they are unreadable, `notePath` is not the user's, so
 * even "it does not exist" would be a statement about the wrong file. A
 * missing note before kept copies: there is nothing to move either way, and
 * that is the more basic answer.
 */
export function noteLocationRow(state: NoteLocationState): NoteLocationRow {
	const { notePath } = state;
	if (state.settingsDefaulted) {
		return {
			canMove: false,
			desc: `Unavailable while this plugin's settings cannot be read: ${notePath} is only the default location, not necessarily yours.`,
		};
	}
	if (!state.noteInVault) {
		return {
			canMove: false,
			desc: `Saved orders will be kept in ${notePath}. It is not in the vault right now — it is created there the next time an order is saved, and can be moved after that.`,
		};
	}
	if (state.keptCopies > 0) {
		const one = state.keptCopies === 1;
		const copies = one ? 'a kept copy of an unreadable version is' : `${state.keptCopies} kept copies of an unreadable version are`;
		const them = one ? 'it' : 'them';
		return {
			canMove: false,
			desc: `Saved orders are kept in ${notePath}. It cannot be moved while ${copies} beside it: the move would leave ${them} behind, out of reach of the row that deletes ${them}. Delete ${them} below, or move ${them} out of this folder by hand, first.`,
		};
	}
	return {
		canMove: true,
		desc: `Saved orders are kept in ${notePath}. Moving it to another folder keeps its file name, and the plugin follows it there.`,
	};
}
