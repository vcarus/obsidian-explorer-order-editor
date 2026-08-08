/**
 * Two one-time, explicitly user-triggered commands (see `main.ts`) that
 * bridge the old per-folder sortspec.md format to the vault-level order
 * index (`orderIndex.ts`) this plugin has stored orders in since M10b:
 *
 * - `importOrdersFromSortspec`: copies every order this plugin previously
 *   authored in a sortspec.md into the index, skipping folders the index
 *   already has an order for and leaving every sortspec.md untouched.
 * - `deleteImportedSortspecFiles`: once the user is satisfied with the
 *   import, removes what it left behind — this plugin's own section from
 *   each sortspec.md, trashing the file entirely if nothing else was in it.
 *
 * Both only ever touch a sortspec.md section carrying this plugin's own
 * `// explorer-order-editor` marker (`hasAuthoredSection`/`removeFolderOrder`
 * in `sortspec.ts`), never a hand-written one — the same safety property the
 * old per-folder write path relied on.
 *
 * The import is deliberately non-destructive on its own: nothing here
 * deletes or edits a sortspec.md until the separate cleanup command is run.
 * That is so the old files keep working as a fallback for the Custom File
 * Explorer sorting plugin (which can still read them) if this plugin's own
 * file-explorer patch (`explorerSort.ts`) ever stops working on a user's
 * setup — the entire reason the two steps are separate commands rather than
 * one.
 */
import { App, normalizePath, parseYaml, TFile, TFolder } from 'obsidian';
import type { FrontMatterDeps } from './frontmatter';
import { readSortingSpecValue } from './frontmatter';
import type { IndexFileStore } from './indexFile';
import { folderIndexKey } from './indexFile';
import { setOrder } from './orderIndex';
import { hasAuthoredSection, parseSortingSpec, readFolderOrder } from './sortspec';
import { clearFolderOrder, SORTSPEC_FILENAME, specFolderKeyFor, targetKeyFor } from './sortspecFile';
import type { Entry, EntryKind } from './types';

const yamlDeps: FrontMatterDeps = { parseYaml };

// ---------------------------------------------------------------------------
// Part 1: import
// ---------------------------------------------------------------------------

export interface ImportSummary {
	readonly imported: number;
	readonly skippedAlreadyOrdered: number;
	readonly skippedNoAuthoredOrder: number;
	readonly failed: number;
}

/**
 * `readFolderOrder` speaks the OLD sortspec.md name convention: a `.md`
 * file's basename with the extension stripped, everything else (folders,
 * non-markdown files) full. `entriesFor`/the index no longer produce that
 * convention anywhere (M10b moved storage to full names throughout), so it
 * has to be reconstructed here, from `folder.children`, for this one
 * read — paired with each child's actual FULL name so the decoded order can
 * be mapped back to what the index expects.
 */
interface OldConventionIndex {
	/** `folder`'s children, in the old (partly `.md`-stripped) naming convention `readFolderOrder` expects. */
	readonly entries: readonly Entry[];
	/** `"<kind> <old name>"` -> the live child that old name/kind pair belongs to. */
	readonly liveByOldKey: ReadonlyMap<string, TFile | TFolder>;
}

function oldConventionKey(kind: EntryKind, oldName: string): string {
	return `${kind} ${oldName}`;
}

function buildOldConventionIndex(folder: TFolder): OldConventionIndex {
	const entries: Entry[] = [];
	const liveByOldKey = new Map<string, TFile | TFolder>();

	for (const child of folder.children) {
		let oldName: string;
		let kind: EntryKind;
		if (child instanceof TFolder) {
			oldName = child.name;
			kind = 'folder';
		} else if (child instanceof TFile) {
			// Excluded exactly as the old `entriesFor` excluded it, so an
			// authored section that still lists `sortspec` — which older
			// versions of this plugin could leave behind, and which the M9-era
			// hide toggle's rewrite existed partly to tidy up — resolves to
			// nothing rather than importing a name for a file the cleanup
			// command is about to trash.
			if (child.name === SORTSPEC_FILENAME) continue;
			oldName = child.extension === 'md' ? child.basename : child.name;
			kind = 'file';
		} else {
			continue;
		}
		entries.push({ name: oldName, kind });
		liveByOldKey.set(oldConventionKey(kind, oldName), child);
	}

	return { entries, liveByOldKey };
}

/**
 * Imports whatever order this plugin previously authored in every
 * sortspec.md in the vault into the order index, via `IndexFileStore`.
 *
 * A folder already holding an order in the index is skipped outright
 * (`skippedAlreadyOrdered`) — checked before anything about the sortspec.md
 * itself is even read, which is what makes running this command twice safe:
 * nothing the user has since reordered through the modal is ever touched.
 *
 * A sortspec.md with no section this plugin authored for its own folder
 * (unreadable front matter, no `sorting-spec`, a section that's entirely
 * hand-written, ...) is skipped as `skippedNoAuthoredOrder` — there is
 * nothing of ours to import there. An authored section that
 * `hasAuthoredSection` sees but `readFolderOrder` can't resolve to a single
 * order (folded into a multi-target section, or duplicated) is counted as
 * `failed` instead: that shouldn't normally happen from anything this
 * plugin itself would have written, so it's surfaced rather than silently
 * treated as "nothing to import".
 *
 * Never modifies or deletes a sortspec.md — see the module doc comment for
 * why that is deliberate.
 */
export async function importOrdersFromSortspec(app: App, store: IndexFileStore): Promise<ImportSummary> {
	let imported = 0;
	let skippedAlreadyOrdered = 0;
	let skippedNoAuthoredOrder = 0;
	let failed = 0;

	const files = app.vault.getFiles().filter((file) => file.name === SORTSPEC_FILENAME);

	for (const file of files) {
		try {
			const folder = file.parent;
			if (folder === null) {
				failed++;
				continue;
			}

			const key = folderIndexKey(folder);
			if (store.get(key) !== undefined) {
				skippedAlreadyOrdered++;
				continue;
			}

			const data = await app.vault.cachedRead(file);
			const read = readSortingSpecValue(data, yamlDeps);
			if (read.status !== 'ok') {
				skippedNoAuthoredOrder++;
				continue;
			}

			const specFolderKey = specFolderKeyFor(folder);
			const spec = parseSortingSpec(read.value, specFolderKey);
			const targetRaw = targetKeyFor(folder);
			if (!hasAuthoredSection(spec, targetRaw)) {
				skippedNoAuthoredOrder++;
				continue;
			}

			const { entries: oldSiblings, liveByOldKey } = buildOldConventionIndex(folder);
			const storedOld = readFolderOrder(spec, targetRaw, oldSiblings);
			if (storedOld === null) {
				// An authored section exists but can't be resolved to a single
				// order (folded into a multi-target section, or an ambiguous
				// hand-edited duplicate) -- nothing safe to import.
				failed++;
				continue;
			}

			const fullNames: string[] = [];
			for (const entry of storedOld) {
				const live = liveByOldKey.get(oldConventionKey(entry.kind, entry.name));
				if (live !== undefined) fullNames.push(live.name);
			}

			if (fullNames.length === 0) {
				// Every listed entry has since been renamed or removed -- there is
				// nothing left that would actually change the index.
				skippedNoAuthoredOrder++;
				continue;
			}

			store.update((index) => setOrder(index, key, fullNames));
			imported++;
		} catch (err) {
			console.error('[explorer-order-editor] failed to import an order from sortspec.md', err);
			failed++;
		}
	}

	// A one-time, user-triggered batch import is worth landing on disk right
	// away rather than riding IndexFileStore's usual debounce -- the whole
	// point is the user can trust the report they're about to see.
	await store.flush();

	return { imported, skippedAlreadyOrdered, skippedNoAuthoredOrder, failed };
}

// ---------------------------------------------------------------------------
// Part 2: cleanup
// ---------------------------------------------------------------------------

export interface CleanupSummary {
	readonly deleted: number;
	readonly editedKept: number;
	readonly untouched: number;
	/** Held an order of ours the index does not have — never imported, so not ours to remove. */
	readonly skippedNotImported: number;
	readonly failed: number;
}

/**
 * Removes what `importOrdersFromSortspec` leaves behind: this plugin's own
 * section from every sortspec.md in the vault, via `clearFolderOrder` — the
 * existing removal path, built on `removeFolderOrder`, which is structurally
 * incapable of touching a section that lacks this plugin's own
 * `// explorer-order-editor` marker. That property is the whole safety
 * argument for this command, so it is reused rather than reimplemented.
 *
 * `clearFolderOrder` already trashes a sortspec.md once removing our
 * section leaves it with nothing else to say (no other front matter keys,
 * no body). Whether that happened for a given file is read back from the
 * vault afterward rather than threaded through `clearFolderOrder`'s return
 * value, so its signature doesn't have to grow a field only this one caller
 * needs.
 *
 * **A folder whose order is not in the index is left completely alone**
 * (`skippedNotImported`). Nothing else enforces that this command runs after
 * the import — a user who reaches for it first would otherwise have the
 * order removed from the sortspec.md while the index never held a copy,
 * which is the one way this pair of commands could actually lose an order.
 * The guard makes the command mean literally what it is called: it removes
 * what was imported, and only that.
 */
export async function deleteImportedSortspecFiles(app: App, store: IndexFileStore): Promise<CleanupSummary> {
	let deleted = 0;
	let editedKept = 0;
	let untouched = 0;
	let skippedNotImported = 0;
	let failed = 0;

	const files = app.vault.getFiles().filter((file) => file.name === SORTSPEC_FILENAME);

	for (const file of files) {
		const path = file.path;
		try {
			const folder = file.parent;
			if (folder === null) {
				failed++;
				continue;
			}

			if (store.get(folderIndexKey(folder)) === undefined) {
				skippedNotImported++;
				continue;
			}

			const result = await clearFolderOrder(app, folder);
			if (result.status !== 'removed') {
				// 'unchanged': nothing of ours was in this file. 'blocked': its
				// target is folded into a multi-target section, unsafe to touch.
				// Either way, nothing was removed.
				untouched++;
				continue;
			}

			if (app.vault.getFileByPath(normalizePath(path)) === null) {
				deleted++;
			} else {
				editedKept++;
			}
		} catch (err) {
			console.error('[explorer-order-editor] failed to delete an imported sortspec.md', err);
			failed++;
		}
	}

	return { deleted, editedKept, untouched, skippedNotImported, failed };
}
