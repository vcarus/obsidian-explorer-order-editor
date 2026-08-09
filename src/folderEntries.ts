/**
 * Derives a folder's rows for the reorder dialog and for move-target lookups:
 * one `SortableEntry` per child in `folder.children`, excluding the order
 * index note itself (there is exactly one, vault-wide — see `entryForChild`
 * below).
 *
 * Rows carry `ctime`/`mtime` (`SortableEntry`, from `entrySort.ts`) rather
 * than the bare `Entry` this file used to return, because this is the only
 * place in the plugin that ever holds a real `TFile` — `entrySort.ts` is
 * deliberately obsidian-free so its sort logic stays unit-testable (see its
 * doc comment), which means it has no way to reach into `TFile.stat` itself.
 * The timestamps have to be read here, once, while a `TFile` is still in
 * hand, and carried along on the `Entry` from this point on.
 */
import { TAbstractFile, TFile, TFolder } from 'obsidian';
import type { SortableEntry } from './entrySort';
import { fallbackEntryOrder } from './types';

/**
 * Derives a single child's `SortableEntry`, or `null` for the order index
 * note itself (identified by `indexNotePath`, the normalized vault path of
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
 * `ctime`/`mtime` are `null` for a folder — not a placeholder or a lazy
 * shortcut, but the honest reading of Obsidian's data model: `TFolder` has
 * no `stat` at all, so there is no timestamp to report. A `TFile` always has
 * a `stat`, so its two fields come straight from it.
 *
 * Not exported: `entriesFor` below is its only caller.
 */
function entryForChild(child: TAbstractFile, indexNotePath: string): SortableEntry | null {
	if (child instanceof TFolder) {
		return { name: child.name, kind: 'folder', ctime: null, mtime: null };
	}
	if (child instanceof TFile) {
		if (child.path === indexNotePath) return null;
		return { name: child.name, kind: 'file', ctime: child.stat.ctime, mtime: child.stat.mtime };
	}
	return null;
}

/**
 * Derives this folder's rows, in `fallbackEntryOrder` — see it for what that
 * order is and where it knowingly diverges from the file explorer.
 *
 * Only the name (and timestamp) derivation (`entryForChild`) lives in this
 * file, because only it needs a `TFile`/`TFolder`; the ordering itself is
 * pure and unit-tested in `types.ts` rather than trapped behind this
 * function's `obsidian` import.
 *
 * `fallbackEntryOrder` is generic in its entry type (`types.ts`), so passing
 * `SortableEntry` here returns `SortableEntry[]` with no cast: it only ever
 * permutes what it is given, and its signature says so. `types.ts` itself
 * still knows nothing of `SortableEntry`, and must not — see `entrySort.ts`'s
 * doc comment on why that module imports `compareNames` from `types.ts`
 * rather than the reverse.
 */
export function entriesFor(folder: TFolder, indexNotePath: string): readonly SortableEntry[] {
	const entries: SortableEntry[] = [];
	for (const child of folder.children) {
		const entry = entryForChild(child, indexNotePath);
		if (entry !== null) entries.push(entry);
	}
	return fallbackEntryOrder(entries);
}
