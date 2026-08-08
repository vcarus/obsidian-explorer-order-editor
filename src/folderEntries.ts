/**
 * Derives a folder's rows for the reorder dialog and for move-target lookups:
 * one `Entry` per child in `folder.children`, excluding the order index note
 * itself (there is exactly one, vault-wide — see `entryForChild` below).
 */
import { TAbstractFile, TFile, TFolder } from 'obsidian';
import { fallbackEntryOrder, type Entry } from './types';

/**
 * Derives a single child's `Entry`, or `null` for the order index note
 * itself (identified by `indexNotePath`, the normalized vault path of
 * `settings.indexPath`) or for a node that is neither a file nor a folder.
 * Both files and folders use their full name, extension included — what the
 * index (`orderIndex.ts`) stores, and what `OrderModal.ts` needs so a row's
 * *identity* matches what `store.update` will write; `types.ts`'s
 * `displayLabel` is what strips `.md` for display.
 *
 * The index note is never offered: it's the file this plugin manages, and
 * listing it invites ordering the thing that describes the order. Leaving it
 * unlisted is harmless — an unlisted entry sorts to the end.
 *
 * Not exported: `entriesFor` below is its only caller.
 */
function entryForChild(child: TAbstractFile, indexNotePath: string): Entry | null {
	if (child instanceof TFolder) {
		return { name: child.name, kind: 'folder' };
	}
	if (child instanceof TFile) {
		if (child.path === indexNotePath) return null;
		return { name: child.name, kind: 'file' };
	}
	return null;
}

/**
 * Derives this folder's rows, in `fallbackEntryOrder` — see it for what that
 * order is and where it knowingly diverges from the file explorer.
 *
 * Only the name derivation (`entryForChild`) lives in this file, because
 * only it needs a `TFile`/`TFolder`; the ordering itself is pure and
 * unit-tested in `types.ts` rather than trapped behind this function's
 * `obsidian` import.
 */
export function entriesFor(folder: TFolder, indexNotePath: string): readonly Entry[] {
	const entries: Entry[] = [];
	for (const child of folder.children) {
		const entry = entryForChild(child, indexNotePath);
		if (entry !== null) entries.push(entry);
	}
	return fallbackEntryOrder(entries);
}
