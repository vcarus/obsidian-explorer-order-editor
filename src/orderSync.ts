/**
 * Keeps a folder's saved order (`sortspec.md`) in sync with renames, moves,
 * and deletes that happen while this plugin is running.
 *
 * Without this, `mergeStoredOrder` (see `sortspec.ts`) treats a renamed
 * entry as two unrelated things: the old name, which it can no longer find
 * among the folder's live children and so drops; and the new name, which it
 * has never heard of and so appends at the end (custom-sort sorts unlisted
 * entries last). Net effect: renaming anything with a saved position quietly
 * demotes it to the bottom of its folder. This module listens for the
 * vault's `rename`/`delete` events and rewrites the stored order before that
 * ever becomes visible, using `renameEntryInOrder` (rename) or plain
 * `mergeStoredOrder` (delete/move-away — dropping a gone entry is exactly
 * what it already does).
 *
 * Explicitly out of scope, not bugs:
 * - A rename that happens while this plugin isn't running (e.g. another
 *   device syncing an edit made with Obsidian closed) is never seen. The
 *   pre-existing fallback already covers it: `mergeStoredOrder` drops the
 *   stale entry the next time the folder's order is read at all (modal
 *   reopen, "hide sortspec.md" sync, ...), which rewrites the whole section
 *   anyway.
 * - Moving an item into a new folder never inserts it into that folder's
 *   order. There is no signal for where the user would want it, so it joins
 *   every other child that folder's order doesn't mention — exactly where a
 *   brand-new file would land.
 * - If the order modal is open in memory when a rename happens elsewhere,
 *   saving from the modal afterwards still writes the name the entry had
 *   when the modal opened. Known limitation, not addressed here.
 */
import { debounce, Notice, Plugin, TAbstractFile, TFile, TFolder, type Debouncer } from 'obsidian';
import type { ExplorerOrderEditorSettings } from './settings';
import { hasAuthoredSection, mergeStoredOrder, readFolderOrder, renameEntryInOrder, upsertFolderOrder } from './sortspec';
import { entriesFor, refreshCustomSort, sortspecPathFor, targetKeyFor, updateFolderSpec, SORTSPEC_FILENAME } from './sortspecFile';
import { entryNameForFileName, type Entry } from './types';

/** Structural slice of `Plugin`, matching `SettingsHost` in `settings.ts` — avoids a circular import against `main.ts`. */
export interface OrderSyncHost extends Plugin {
	settings: ExplorerOrderEditorSettings;
}

const REFRESH_DEBOUNCE_MS = 400;
const FAILURE_NOTICE_DEBOUNCE_MS = 400;

class OrderSyncCoordinator {
	private disposed = false;

	// Vault.process gives no ordering guarantee across concurrent calls on
	// the same file. A batch rename (drag-moving several files at once)
	// fires one event per file in quick succession; chaining every
	// reconciliation onto one FIFO promise serializes them so two
	// overlapping read-modify-write cycles on the same sortspec.md can never
	// interleave and clobber each other. As a side effect it also
	// rate-limits how fast this plugin reacts to a big batch.
	private chain: Promise<void> = Promise.resolve();

	private failureCount = 0;
	// Debounced rather than firing a Notice per failed file: a batch rename
	// that fails partway through (e.g. one folder's sortspec.md is briefly
	// locked by another process) would otherwise spam one Notice per file
	// instead of a single summary.
	private readonly runFailureNotice: Debouncer<[], void>;

	// refreshCustomSort's command is vault-wide, not scoped to one file, so
	// any sortspec.md still on disk is an equally good anchor to hand it —
	// only the most recently touched folder needs to be remembered, not
	// every folder queued during a burst.
	private refreshAnchorFolder: TFolder | null = null;
	private readonly runRefresh: Debouncer<[], void>;

	constructor(private readonly host: OrderSyncHost) {
		// resetTimer=false (trailing, fixed-delay, not extended by further
		// calls within the window): a burst of events during this window
		// still collapses into one flush, since only `flushRefresh`'s own
		// invocation is throttled — `refreshAnchorFolder` is written
		// synchronously on every call regardless, so whichever flush ends up
		// running always sees the most recently queued folder at that point.
		this.runRefresh = debounce(() => void this.flushRefresh(), REFRESH_DEBOUNCE_MS, false);
		this.runFailureNotice = debounce(() => this.flushFailureNotice(), FAILURE_NOTICE_DEBOUNCE_MS, false);
	}

	register(): void {
		const { app } = this.host;
		this.host.registerEvent(app.vault.on('rename', (file, oldPath) => this.onRename(file, oldPath)));
		this.host.registerEvent(app.vault.on('delete', (file) => this.onDelete(file)));
		// Vault event callbacks, the FIFO chain, and both debouncers can all
		// still be pending when the plugin starts unloading. Every entry
		// point below checks `disposed` before touching anything.
		this.host.register(() => {
			this.disposed = true;
		});
	}

	/**
	 * The `Entry` identity of a live vault node, or `null` for a node that is
	 * neither a file nor a folder (not a shape the vault currently produces).
	 *
	 * Reads Obsidian's own `extension`/`basename` rather than deriving the
	 * name from the path string: custom-sort matches against names derived
	 * from these same two fields, so this agrees with it by definition. Only
	 * the *former* name of a renamed node has to fall back to string
	 * derivation, because by the time the event fires this object already
	 * carries the new one — see `entryNameForFileName`.
	 */
	private identityOf(file: TAbstractFile): Entry | null {
		if (file instanceof TFolder) return { name: file.name, kind: 'folder' };
		if (file instanceof TFile) return { name: file.extension === 'md' ? file.basename : file.name, kind: 'file' };
		return null;
	}

	private onRename(file: TAbstractFile, oldPath: string): void {
		const to = this.identityOf(file);
		if (to === null) return;
		const kind = to.kind;

		const oldSlash = oldPath.lastIndexOf('/');
		// A root-level item's oldPath has no '/', so lastIndexOf returns -1.
		// Feeding that straight into String#slice(0, -1) would NOT yield ''
		// — slice treats a negative end index as "count back from the end",
		// so it would silently drop the path's last character instead of
		// producing an empty parent path. Guard the no-slash case explicitly
		// rather than lean on the arithmetic happening to work out.
		const oldFileName = oldSlash === -1 ? oldPath : oldPath.slice(oldSlash + 1);
		const oldParentPath = oldSlash === -1 ? '' : oldPath.slice(0, oldSlash);
		const oldName = kind === 'folder' ? oldFileName : entryNameForFileName(oldFileName);

		const { app } = this.host;
		const oldParentFolder = oldParentPath === '' ? app.vault.getRoot() : app.vault.getFolderByPath(oldParentPath);
		if (oldParentFolder === null) return; // the old parent isn't resolvable — nothing to reconcile against

		const from: Entry = { name: oldName, kind };

		// No special case for sortspec.md itself is needed in either
		// direction: `entriesFor` already excludes it from `siblings`, so
		// renaming *to* "sortspec.md" makes the next merge drop the
		// (renamed) line on write, and renaming *away from* it means the old
		// name was never in the stored order to begin with, so
		// `renameEntryInOrder` naturally returns null and nothing is
		// written.
		//
		// Comparing the two folders' own `.path` (rather than re-deriving
		// and normalizing a path string ourselves) sidesteps needing to know
		// whether the vault root's `TFolder.path` is `""` or `"/"` — both
		// `oldParentFolder` and `file.parent` resolve to the actual root
		// object when the item is at the root, so their `.path` values agree
		// whatever that literal value is.
		const currentParent = file.parent;
		if (currentParent !== null && currentParent.path === oldParentFolder.path) {
			this.enqueueRename(oldParentFolder, from, to, entriesFor(oldParentFolder));
		} else {
			// Moved to a different folder. Only the folder the item left
			// needs reconciling — its stored order now references something
			// that's gone. The destination folder is left untouched: see the
			// module doc comment for why.
			this.enqueueCoordinate(oldParentFolder, entriesFor(oldParentFolder));
		}
	}

	private onDelete(file: TAbstractFile): void {
		if (this.identityOf(file) === null) return; // the identity itself is unused here — only the parent folder matters — but a node that is neither file nor folder still isn't ours to react to

		// Not `file.parent`: Obsidian doesn't promise a deleted node still
		// points at its former parent by the time this event runs. Derive
		// the parent folder from the path text instead, exactly like
		// onRename's "moved away" branch does for the same reason.
		const slash = file.path.lastIndexOf('/');
		const parentPath = slash === -1 ? '' : file.path.slice(0, slash);
		const { app } = this.host;
		const parentFolder = parentPath === '' ? app.vault.getRoot() : app.vault.getFolderByPath(parentPath);
		if (parentFolder === null) return;

		this.enqueueCoordinate(parentFolder, entriesFor(parentFolder));
	}

	/**
	 * `siblings` is captured by the caller, synchronously inside the event
	 * handler, and must not be re-derived here. Queued ops run after an
	 * `await`, by which time later events in the same burst — a sync client
	 * landing a batch of renames, which is squarely this plugin's use case —
	 * have already changed the folder. Re-reading the children at run time
	 * would make this op see a world its own event knows nothing about: the
	 * entry a *later* rename is about to fix looks simply gone, so
	 * `mergeStoredOrder` drops it from the order this op writes, and when that
	 * later op finally runs its old name is no longer stored, so
	 * `renameEntryInOrder` returns null and that rename silently loses its
	 * position after all. One snapshot per event, applied in event order,
	 * keeps each op's view consistent with the change it is describing.
	 */
	private enqueueRename(folder: TFolder, from: Entry, to: Entry, siblings: readonly Entry[]): void {
		this.enqueue(async () => {
			const { app, settings } = this.host;

			// readFolderOrder needs a *pre*-rename sibling view: it resolves
			// a bare, unprefixed line's kind only by looking its name up
			// among siblings (see readFolderOrder's own doc comment). With
			// the live siblings, the old name is no longer there at all, so
			// a bare line for it would default to 'file' regardless of its
			// real kind — renaming a folder that happened to be written
			// unprefixed would then never match `from`, and the rename would
			// be missed entirely. Swapping `to` back out for `from`
			// reconstructs the view `readFolderOrder` needs without a second
			// disk read.
			const readSiblings = [...siblings.filter((s) => !(s.name === to.name && s.kind === to.kind)), from];
			const hideNames = settings.hideSortspec ? [SORTSPEC_FILENAME] : [];
			const target = targetKeyFor(folder);

			const result = await updateFolderSpec(app, folder, (spec) => {
				// Never create a section for a folder nobody has ever
				// ordered — that would be upserting a brand-new order into
				// existence off the back of an unrelated rename, not
				// "preserving" one. Also keeps `updateFolderSpec` from ever
				// creating a sortspec.md that wasn't there before, purely
				// because something nearby got renamed.
				if (!hasAuthoredSection(spec, target)) return { spec, status: 'unchanged', diagnostics: [] };
				const stored = readFolderOrder(spec, target, readSiblings);
				// null: no single section for this folder, folded into a
				// multi-target section, or an ambiguous hand-edited
				// duplicate. Don't guess at an order in any of those cases.
				if (stored === null) return { spec, status: 'unchanged', diagnostics: [] };
				// `renamed === null` means `from` had no line to move, which is
				// not a reason to bail — it is the interesting case. An entry
				// whose name custom-sort can't express is never written at all
				// (`encodeEntry` refuses it, `upsertFolderOrder` omits it), so
				// renaming *away* from such a name finds nothing to rename
				// while producing an entry that, for the first time, can hold a
				// position. Falling through to a plain reconcile is what lets
				// `mergeStoredOrder` pick it up and append it; returning
				// `unchanged` here instead left it unlisted, which in the file
				// explorer means still sitting among the other unrepresentable
				// names at the very bottom (custom-sort puts every unlisted
				// child after every listed one) until some later save happened
				// to rewrite the section. Same fall-through covers an entry
				// that simply joined the folder after the last save.
				const renamed = renameEntryInOrder(stored, from, to);
				return upsertFolderOrder(spec, target, mergeStoredOrder(renamed ?? stored, siblings), hideNames);
			});

			if (result.status === 'replaced' || result.status === 'appended') {
				this.scheduleRefresh(folder);
			}

			// A new name custom-sort's line format simply can't express
			// (`unrepresentable-entry`) isn't an error: the entry just falls
			// to the end, the same place any other unlisted child lands,
			// instead of us writing a line that would suspend custom-sort's
			// whole plugin (see CLAUDE.md's "无法表达的名字" section). Not
			// worth a Notice on every such rename — log and move on.
			for (const diagnostic of result.diagnostics) {
				if (diagnostic.kind === 'unrepresentable-entry') {
					console.debug('[explorer-order-editor] renamed entry has no representable sortspec line:', diagnostic.name, diagnostic.reason);
				}
			}
		});
	}

	/** `siblings` is captured at event time by the caller, for the reason spelled out on `enqueueRename`. */
	private enqueueCoordinate(folder: TFolder, siblings: readonly Entry[]): void {
		this.enqueue(async () => {
			const { app, settings } = this.host;
			const hideNames = settings.hideSortspec ? [SORTSPEC_FILENAME] : [];
			const target = targetKeyFor(folder);

			const result = await updateFolderSpec(app, folder, (spec) => {
				if (!hasAuthoredSection(spec, target)) return { spec, status: 'unchanged', diagnostics: [] };
				const stored = readFolderOrder(spec, target, siblings);
				if (stored === null) return { spec, status: 'unchanged', diagnostics: [] };
				// mergeStoredOrder itself drops any stored entry no longer
				// present among the live siblings — that is the entire
				// mechanism a delete/move-away needs. upsertFolderOrder then
				// no-ops (status 'unchanged') if the resulting order doesn't
				// actually change the file's bytes, e.g. the deleted entry
				// was never in the stored order to begin with.
				return upsertFolderOrder(spec, target, mergeStoredOrder(stored, siblings), hideNames);
			});

			if (result.status === 'replaced' || result.status === 'appended') {
				this.scheduleRefresh(folder);
			}
		});
	}

	private enqueue(op: () => Promise<void>): void {
		this.chain = this.chain
			.then(() => {
				if (this.disposed) return undefined;
				return op();
			})
			.catch((err: unknown) => {
				this.failureCount++;
				console.error('[explorer-order-editor] failed to update the saved explorer order after a rename or delete', err);
				this.runFailureNotice();
			});
		// The `.catch` above always resolves `this.chain` to a fulfilled
		// promise, so one failed op can never poison every op queued after
		// it — the whole point of a FIFO chain that outlives individual
		// failures.
	}

	private scheduleRefresh(folder: TFolder): void {
		if (this.disposed) return;
		this.refreshAnchorFolder = folder;
		this.runRefresh();
	}

	private async flushRefresh(): Promise<void> {
		if (this.disposed) return;
		// Checked here, not at schedule time: the setting can change while a
		// refresh is already pending in the debounce window.
		if (!this.host.settings.autoRefresh) return;
		const folder = this.refreshAnchorFolder;
		this.refreshAnchorFolder = null;
		if (folder === null) return;
		const anchor = this.host.app.vault.getFileByPath(sortspecPathFor(folder));
		if (anchor === null) return; // gone again by the time the debounce fired

		// 'missing' (custom-sort not installed/enabled) intentionally gets
		// no Notice here, unlike the modal's save button: this path fires on
		// every background rename/delete, and reminding the user to install
		// custom-sort on every single one would be pure noise —
		// `onLayoutReady` in main.ts already told them once, when the plugin
		// loaded.
		await refreshCustomSort(this.host.app, anchor);
	}

	private flushFailureNotice(): void {
		if (this.disposed) return;
		const count = this.failureCount;
		this.failureCount = 0;
		if (count === 0) return;
		new Notice(`Could not update the saved explorer order for ${count} item${count === 1 ? '' : 's'}. See the console for details.`);
	}
}

/**
 * Wires up automatic order maintenance for `host`. Call once, from
 * `onLayoutReady` — registering during `onload` risks the vault's startup
 * indexing pass firing a flood of rename-like events before things have
 * settled, and (per `isCustomSortAvailable`'s own doc comment) plugin load
 * order isn't guaranteed that early either.
 */
export function registerOrderSync(host: OrderSyncHost): void {
	const coordinator = new OrderSyncCoordinator(host);
	coordinator.register();
}
