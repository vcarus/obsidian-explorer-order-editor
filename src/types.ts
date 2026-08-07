/**
 * Shared vocabulary between the pure sortspec layer and the UI.
 *
 * `name` is the exact string custom-sort matches against, already resolved:
 * `.md` files use their basename (no extension), every other file uses its
 * full name including the extension, and folders use the folder name.
 * Resolving that is `sortspecFile.ts`'s job — nothing downstream re-derives it.
 */
export type EntryKind = 'file' | 'folder';

export interface Entry {
	readonly name: string;
	readonly kind: EntryKind;
}

/**
 * Derives `Entry.name` from a *file* name that exists only as a string:
 * `.md` files use their basename, every other file keeps its full name
 * including the extension.
 *
 * Used in exactly one place — reconstructing the name a renamed file used to
 * have, from a rename event's `oldPath`. That is the only case with no
 * `TFile` to ask, because the object handed to the event already carries the
 * *new* name. Everywhere a `TFile` exists (`entriesFor`, and the new-name
 * side of a rename) reads Obsidian's own `extension`/`basename` instead, and
 * says why: custom-sort matches on names derived from those same two fields,
 * so reading them is what keeps our output in agreement with it by
 * definition. This function can only ever be a faithful re-implementation of
 * that rule, so it is kept off the path that decides what gets written.
 *
 * Consequence of that asymmetry, and the reason it is the safe direction: if
 * Obsidian's `extension` turns out to differ from a plain case-sensitive
 * `.md` suffix (the API docs don't say whether it is lower-cased), the old
 * name reconstructed here won't match what was stored, `renameEntryInOrder`
 * returns null, and the rename is simply not followed — that one entry loses
 * its position, exactly as it did before this feature existed. The reverse
 * arrangement would instead write a name custom-sort doesn't recognize.
 *
 * Folders never go through this — a folder's `Entry.name` is always just its
 * own name, with no extension logic at all.
 */
export function entryNameForFileName(fileName: string): string {
	return fileName.endsWith('.md') ? fileName.slice(0, -'.md'.length) : fileName;
}
