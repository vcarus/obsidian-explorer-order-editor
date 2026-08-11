/**
 * Keeps the order index (`orderIndex.ts`) in sync with renames, moves, and
 * deletes that happen while this plugin is running.
 *
 * Without this, `mergeOrder` treats a renamed entry as two unrelated things:
 * the old name, which it can no longer find among the folder's live children
 * and so drops; and the new name, which it has never heard of and so appends
 * at the end. Net effect: renaming anything with a saved position quietly
 * demotes it to the bottom of its folder. This module listens for the
 * vault's `rename`/`delete` events and rewrites the stored index before that
 * ever becomes visible.
 *
 * The mutations here (`renameEntry`, `removeEntry`, `renameFolderPath`,
 * `removeOrder`, all from `orderIndex.ts`) need no live sibling context at
 * all: a stored name either is or isn't in a folder's order, with no
 * bare-line-kind ambiguity to resolve against what's currently on disk (see
 * `orderIndex.ts`'s module doc for why full names make that ambiguity
 * disappear). So there is nothing to snapshot at event time — only FIFO
 * ordering is worth keeping: `store.update()` is synchronous, but wrapping
 * each reaction in an `enqueue`/`chain` shape still isolates one failing op
 * from blocking the ones queued after it, and keeps this module's shape
 * stable for whatever builds on it next.
 *
 * Explicitly out of scope, not bugs:
 * - A rename that happens while this plugin isn't running (e.g. another
 *   device syncing an edit made with Obsidian closed) is never seen. The
 *   pre-existing fallback already covers it: `mergeOrder` drops the stale
 *   entry the next time the folder's order is read at all (any render after
 *   the index note itself catches up, e.g. via `IndexFileStore`'s own
 *   `modify` handling).
 * - Moving an item into a new folder never inserts it into that folder's
 *   order, *as far as this module's own rename handling is concerned* — a
 *   rename this module sees on its own, with no other signal attached, still
 *   has no way to know where in the destination the user would want the item,
 *   so it joins every other child that folder's order doesn't mention,
 *   exactly where a brand-new file would land. Since 1.2 that is no longer
 *   the only way an item can end up moved: `moveItem.ts`'s `applyDrop` is a
 *   signal for exactly that (a tree drag dropped on a specific row), and it
 *   supplies the position itself — by writing the destination folder's order
 *   *after* the rename it performs, once this module's own reaction to that
 *   same rename has already run and touched only the source folder's key.
 *   Nothing here has to know that happened; it is simply a second, later
 *   write to a key this module's own reaction to the rename never touches.
 * - If the order modal is open in memory when a rename happens elsewhere,
 *   saving from the modal afterwards still writes the name the entry had
 *   when the modal opened. Known limitation, not addressed here.
 */
import { debounce, Notice, Plugin, TAbstractFile, TFile, TFolder, type Debouncer } from 'obsidian';
import { folderIndexKey, requestFileExplorerResort, type IndexFileStore } from './indexFile';
import { removeEntry, removeOrder, renameEntry, renameFolderPath } from './orderIndex';
import type { ExplorerOrderEditorSettings } from './settings';

/** Structural slice of `Plugin`, matching `SettingsHost` in `settings.ts` — avoids a circular import against `main.ts`. */
export interface OrderSyncHost extends Plugin {
	settings: ExplorerOrderEditorSettings;
	store: IndexFileStore;
}

const REFRESH_DEBOUNCE_MS = 400;
const FAILURE_NOTICE_DEBOUNCE_MS = 400;

class OrderSyncCoordinator {
	private disposed = false;

	// `store.update()` itself cannot throw (it either applies a pure
	// mutation or refuses and logs), but chaining every reaction onto one
	// FIFO promise still means an op that somehow throws can never leave a
	// later op running out of order, and keeps this module's shape stable
	// for whatever builds on top of it.
	private chain: Promise<void> = Promise.resolve();

	private failureCount = 0;
	// Debounced rather than firing a Notice per failed op: a batch rename
	// that fails partway through would otherwise spam one Notice per file
	// instead of a single summary.
	private readonly runFailureNotice: Debouncer<[], void>;

	private readonly runRefresh: Debouncer<[], void>;

	constructor(private readonly host: OrderSyncHost) {
		// resetTimer=false (trailing, fixed-delay, not extended by further
		// calls within the window): a burst of events during this window
		// still collapses into one flush.
		this.runRefresh = debounce(() => this.flushRefresh(), REFRESH_DEBOUNCE_MS, false);
		this.runFailureNotice = debounce(() => this.flushFailureNotice(), FAILURE_NOTICE_DEBOUNCE_MS, false);
	}

	register(): void {
		const { app } = this.host;
		this.host.registerEvent(app.vault.on('rename', (file, oldPath) => this.onRename(file, oldPath)));
		this.host.registerEvent(app.vault.on('delete', (file) => this.onDelete(file)));
		// Vault event callbacks and the FIFO chain can still be pending when
		// the plugin starts unloading. Every entry point below checks
		// `disposed` before touching anything.
		this.host.register(() => {
			this.disposed = true;
		});
	}

	private onRename(file: TAbstractFile, oldPath: string): void {
		if (!(file instanceof TFile) && !(file instanceof TFolder)) return; // not a shape the vault currently produces

		// If the renamed/moved item is itself a folder, its own key (and
		// every descendant key) has to move with it — otherwise every order
		// saved *inside* it becomes unreachable, keyed under a path nothing
		// lives at any more. A folder can never be the vault root here
		// (Obsidian doesn't fire rename events for the root), so no
		// `folderIndexKey` special-case is needed for either side of this.
		if (file instanceof TFolder) {
			const oldFolderPath = oldPath;
			const newFolderPath = file.path;
			this.enqueue(() => {
				this.host.store.update((index) => renameFolderPath(index, oldFolderPath, newFolderPath));
			});
		}

		// Reconcile the entry's own position within its *parent* folder's
		// order — same for a renamed file and a renamed folder alike.
		const oldSlash = oldPath.lastIndexOf('/');
		// A root-level item's oldPath has no '/', so lastIndexOf returns -1.
		// Feeding that straight into String#slice(0, -1) would NOT yield ''
		// — slice treats a negative end index as "count back from the end",
		// so it would silently drop the path's last character instead of
		// producing an empty parent path. Guard the no-slash case explicitly
		// rather than lean on the arithmetic happening to work out.
		const oldName = oldSlash === -1 ? oldPath : oldPath.slice(oldSlash + 1);
		const oldParentPath = oldSlash === -1 ? '' : oldPath.slice(0, oldSlash);

		const { app } = this.host;
		const oldParentFolder = oldParentPath === '' ? app.vault.getRoot() : app.vault.getFolderByPath(oldParentPath);
		if (oldParentFolder === null) return; // the old parent isn't resolvable — nothing to reconcile against
		const parentKey = folderIndexKey(oldParentFolder);
		const newName = file.name;

		// Comparing the two folders' own `.path` (rather than re-deriving and
		// normalizing a path string ourselves) sidesteps needing to know
		// whether the vault root's `TFolder.path` is `""` or `"/"` — both
		// `oldParentFolder` and `file.parent` resolve to the actual root
		// object when the item is at the root, so their `.path` values agree
		// whatever that literal value is.
		const currentParent = file.parent;
		if (currentParent !== null && currentParent.path === oldParentFolder.path) {
			// Renamed in place.
			this.enqueue(() => {
				this.host.store.update((index) => renameEntry(index, parentKey, oldName, newName));
			});
		} else {
			// Moved to a different folder. Only the folder the item left needs
			// reconciling — its stored order now references something that's
			// gone. The destination folder is left untouched: see the module
			// doc comment for why.
			this.enqueue(() => {
				this.host.store.update((index) => removeEntry(index, parentKey, oldName));
			});
		}

		this.scheduleRefresh();
	}

	private onDelete(file: TAbstractFile): void {
		if (!(file instanceof TFile) && !(file instanceof TFolder)) return; // not a shape the vault currently produces

		// Not `file.parent`: Obsidian doesn't promise a deleted node still
		// points at its former parent by the time this event runs. Derive
		// the parent folder from the path text instead, exactly like
		// onRename's "moved away" branch does for the same reason.
		const slash = file.path.lastIndexOf('/');
		const parentPath = slash === -1 ? '' : file.path.slice(0, slash);
		const { app } = this.host;
		const parentFolder = parentPath === '' ? app.vault.getRoot() : app.vault.getFolderByPath(parentPath);
		if (parentFolder === null) return;
		const parentKey = folderIndexKey(parentFolder);
		const name = file.name;

		// Drop this entry's own position from its parent's order.
		this.enqueue(() => {
			this.host.store.update((index) => removeEntry(index, parentKey, name));
		});

		// A deleted folder's *own* stored order — the order of what used to
		// be inside it — is now orphaned: nothing else will ever remove that
		// key. Deleting a folder recursively fires an individual `delete`
		// event for every descendant file and folder too, so each nested
		// folder's own order gets cleaned up the same way, by its own event —
		// this only has to handle the one folder this particular event names.
		if (file instanceof TFolder) {
			const folderPath = file.path;
			this.enqueue(() => {
				this.host.store.update((index) => removeOrder(index, folderPath));
			});
		}

		this.scheduleRefresh();
	}

	private enqueue(op: () => void): void {
		this.chain = this.chain
			.then(() => {
				if (this.disposed) return;
				op();
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

	private scheduleRefresh(): void {
		if (this.disposed) return;
		this.runRefresh();
	}

	private flushRefresh(): void {
		if (this.disposed) return;
		// Checked here, not at schedule time: the setting can change while a
		// refresh is already pending in the debounce window.
		if (!this.host.settings.autoRefresh) return;
		// The result is intentionally ignored here, unlike the modal's save
		// button and the "Clear explorer order" command: this path fires on
		// every background rename/delete, and a Notice reminding the user
		// nothing could be redrawn on every single one would be pure noise.
		requestFileExplorerResort(this.host.app);
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
 * settled.
 */
export function registerOrderSync(host: OrderSyncHost): void {
	const coordinator = new OrderSyncCoordinator(host);
	coordinator.register();
}
