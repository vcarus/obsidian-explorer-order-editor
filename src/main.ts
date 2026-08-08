import { Menu, normalizePath, Notice, Plugin, TAbstractFile, TFile, TFolder } from 'obsidian';
import { installExplorerDrag } from './explorerDrag';
import { installExplorerSort } from './explorerSort';
import { folderIndexKey, IndexFileStore, requestFileExplorerResort } from './indexFile';
import { applyMove, effectiveOrder } from './moveItem';
import { OrderModal } from './OrderModal';
import { registerOrderSync } from './orderSync';
import { removeOrder } from './orderIndex';
import { moveNameInOrder, type RowMove } from './rowMove';
import { DEFAULT_SETTINGS, ExplorerOrderEditorSettingTab, type ExplorerOrderEditorSettings } from './settings';

/**
 * The four direct move actions (M11), each as `[move, title, icon]` — one
 * source of truth shared by the context menu items (`addMoveMenuItems`) and
 * the commands (`onload`), so the two entry points can never drift into
 * different labels or a different set of moves.
 */
const MOVE_MENU_ITEMS: readonly (readonly [RowMove, string, string])[] = [
	['up', 'Move up', 'lucide-arrow-up'],
	['down', 'Move down', 'lucide-arrow-down'],
	['top', 'Move to top', 'lucide-chevrons-up'],
	['bottom', 'Move to bottom', 'lucide-chevrons-down'],
];

/**
 * The shape `loadData()` can return from a pre-M10b install: `hideSortspec`
 * instead of today's `hideIndexFile`. Read once, in `loadSettings`, as a
 * fallback so an existing install keeps whatever choice it made rather than
 * silently reverting to the default the moment the key gets renamed.
 */
interface LegacySettingsShape {
	readonly hideSortspec?: boolean;
}

export default class ExplorerOrderEditorPlugin extends Plugin {
	settings: ExplorerOrderEditorSettings = DEFAULT_SETTINGS;
	store!: IndexFileStore;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.store = new IndexFileStore(this);
		// Must be awaited before the file explorer can render: `store.get` is
		// synchronous (`getSortedFolderItems` is), so if the index isn't in
		// memory yet by the time the explorer first paints, folders render in
		// default order and then visibly snap once this resolves.
		await this.store.load();

		this.addSettingTab(new ExplorerOrderEditorSettingTab(this.app, this));

		// Deferred to onLayoutReady to sit out the vault's startup indexing
		// flood of rename-like events.
		this.app.workspace.onLayoutReady(() => registerOrderSync(this));

		// A separate onLayoutReady call, for an unrelated reason: the file
		// explorer leaf itself need not exist yet (it can still be a
		// deferred/lazy leaf this early). installExplorerSort retries on its
		// own until it succeeds, so this only has to run once.
		this.app.workspace.onLayoutReady(() => installExplorerSort(this));

		// Same reasoning, same retry-until-success shape, for the tree's own
		// drag-and-drop (M12b): installExplorerDrag needs the same file
		// explorer leaf/view installExplorerSort does, and is independent of
		// it otherwise, so it gets its own onLayoutReady call rather than
		// being folded into the one above.
		this.app.workspace.onLayoutReady(() => installExplorerDrag(this));

		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (file instanceof TFolder) {
					menu.addItem((item) => {
						item.setTitle('Set explorer order')
							// The file explorer context menu renders no icons at all —
							// not even for Obsidian's own items — so this only shows
							// up in menu contexts that do. Registered ids carry a
							// `lucide-` prefix (see getIconIds()); bare Lucide names
							// are not in the map.
							.setIcon('lucide-arrow-up-down')
							.setSection('action')
							.onClick(() => {
								new OrderModal(this.app, file, this.settings, this.store).open();
							});
					});

					// Only offered when there is actually something of ours to
					// remove — a folder with no saved order gets no menu item at
					// all, rather than one that clicks through to "nothing to
					// clear".
					if (this.store.get(folderIndexKey(file)) !== undefined) {
						menu.addItem((item) => {
							item.setTitle('Clear explorer order')
								.setIcon('lucide-list-x')
								.setSection('action')
								.onClick(() => {
									void this.clearOrderFor(file);
								});
						});
					}
				}

				this.addMoveMenuItems(menu, file);
			}),
		);

		this.addCommand({
			id: 'set-order-for-vault-root',
			name: 'Set explorer order for vault root',
			callback: () => {
				new OrderModal(this.app, this.app.vault.getRoot(), this.settings, this.store).open();
			},
		});

		this.addCommand({
			id: 'clear-order-for-vault-root',
			name: 'Clear explorer order for vault root',
			// checkCallback so this doesn't sit uselessly in the command
			// palette when the vault root has no saved order to clear.
			checkCallback: (checking) => {
				const root = this.app.vault.getRoot();
				if (this.store.get(folderIndexKey(root)) === undefined) return false;
				if (!checking) {
					void this.clearOrderFor(root);
				}
				return true;
			},
		});

		// One command per direct move action (M11), so each can be given a
		// hotkey — the context menu items above cover the mouse case, but
		// hotkeys need commands regardless.
		//
		// The target is always `app.workspace.getActiveFile()` — the note
		// currently open — never the file explorer's focused/selected row.
		// Reaching for that would mean depending on two more undocumented
		// internals (`view.tree.focusedItem`, `view.activeDom`), on top of
		// the ones `explorerSort.ts`/`OrderModal.ts` already carry, for a case
		// the context menu already handles well. This project takes on
		// undocumented API only where there's no public alternative — that's
		// not true here, so the commands stay scoped to the active file.
		for (const [move, name] of MOVE_MENU_ITEMS) {
			this.addCommand({
				id: `move-${move}`,
				name,
				checkCallback: (checking) => {
					const activeFile = this.app.workspace.getActiveFile();
					if (activeFile === null) return false;
					const parent = activeFile.parent;
					if (parent === null) return false;

					const order = effectiveOrder(this, parent);
					if (moveNameInOrder(order, activeFile.name, move) === null) return false;

					if (!checking) void this.moveFile(activeFile, move);
					return true;
				},
			});
		}
	}

	onunload(): void {
		// Best-effort: performs any write `IndexFileStore`'s debounce hasn't
		// flushed yet, so disabling/reloading the plugin right after a save
		// can't drop it. Not awaited — `onunload` isn't guaranteed to be
		// awaited by Obsidian either — but the write is already scheduled
		// synchronously by `update()`, so this only affects *when* it lands,
		// not whether it's attempted.
		void this.store.flush();
	}

	private async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as (Partial<ExplorerOrderEditorSettings> & LegacySettingsShape) | null;
		const hideIndexFile = data?.hideIndexFile ?? data?.hideSortspec ?? DEFAULT_SETTINGS.hideIndexFile;
		// Picked field by field, not `{...DEFAULT_SETTINGS, ...data}`: `data`
		// is whatever `data.json` currently holds, which since M10e can also
		// carry `IndexFileStore`'s index backup (see `saveSettings` below).
		// Spreading the whole object would leak that stray key into
		// `this.settings` at runtime (the `Partial<...>` cast doesn't strip it),
		// and it would then ride along on every future `saveSettings()` call,
		// potentially overwriting a fresher backup with a stale one.
		this.settings = {
			autoRefresh: data?.autoRefresh ?? DEFAULT_SETTINGS.autoRefresh,
			hideIndexFile,
			dragToReorder: data?.dragToReorder ?? DEFAULT_SETTINGS.dragToReorder,
			showMoveActions: data?.showMoveActions ?? DEFAULT_SETTINGS.showMoveActions,
			indexPath: data?.indexPath ?? DEFAULT_SETTINGS.indexPath,
		};
	}

	async saveSettings(): Promise<void> {
		// Read-modify-write, not a blind `saveData(this.settings)`: `data.json`
		// is shared with `IndexFileStore`'s index backup (M10e part 2) under a
		// key this settings object doesn't know about, and a wholesale
		// overwrite from this stale-by-construction object would erase it.
		const data = (await this.loadData()) as Record<string, unknown> | null;
		await this.saveData({ ...data, ...this.settings });
	}

	private async clearOrderFor(folder: TFolder): Promise<void> {
		const key = folderIndexKey(folder);
		if (this.store.get(key) === undefined) {
			// The menu item and command are both gated on this same condition,
			// so this is only reachable if the folder's stored order changed
			// between the check and the click — report rather than pretend
			// success.
			new Notice('Nothing to clear for this folder.');
			return;
		}

		// `updateOrRepair`, not `update`: if the order note has since become
		// unreadable, this is one of the three explicit user actions M10e
		// heals on, so it gets a chance to repair the note before completing
		// the clear rather than refusing outright. Still checked, not
		// assumed — a repair with nothing left to recover still refuses, and
		// claiming "cleared" over that would be a plain lie about the user's
		// data.
		if (!(await this.store.updateOrRepair((index) => removeOrder(index, key)))) {
			new Notice(
				`Could not clear: the order note ${this.store.unusableReason() ?? 'could not be repaired'}. ` +
					'Use "Repair the order note" in settings, or check the console for details.',
			);
			return;
		}
		new Notice('Explorer order cleared.');

		if (!this.settings.autoRefresh) {
			new Notice('Automatic refresh is off. The file explorer will show this on its next refresh.');
			return;
		}

		if (!requestFileExplorerResort(this.app)) {
			// No file explorer leaf to ask — genuinely rare, but still
			// reported so a change that silently isn't visible anywhere isn't
			// mistaken for one that is.
			new Notice('Saved. The file explorer will show this when you next open it.');
		}
	}

	/**
	 * Adds whichever of the four direct move items (M11) would actually do
	 * something for `file`, grouped in their own section (`setSection`, not
	 * `MenuItem.setSubmenu()` — that method isn't in the public typings and
	 * would need a cast to reach, where a section achieves the same visual
	 * grouping with public API only) so they read as one group instead of
	 * crowding "Set explorer order"/"Clear explorer order" above.
	 *
	 * Silently adds nothing for: anything that isn't a `TFile`/`TFolder`, the
	 * vault root (no parent to move it within), and the order index note
	 * itself (never orderable — see `moveItem.ts`'s `effectiveOrder`).
	 *
	 * `effectiveOrder` is computed once here and reused for all four
	 * decisions below, rather than recomputed per item — it can read through
	 * the live file explorer, and there's no reason to pay for that four
	 * times to build one menu.
	 */
	private addMoveMenuItems(menu: Menu, file: TAbstractFile): void {
		// Off by default (see `showMoveActions` in `settings.ts`). Read here,
		// per menu, rather than gating the `file-menu` registration itself:
		// a menu is built fresh on every right-click, so toggling the setting
		// takes effect on the very next one with no event to re-register.
		if (!this.settings.showMoveActions) return;

		if (!(file instanceof TFile) && !(file instanceof TFolder)) return;

		const parent = file.parent;
		if (parent === null) return;

		if (file instanceof TFile && file.path === normalizePath(this.settings.indexPath)) return;

		const order = effectiveOrder(this, parent);

		for (const [move, title, icon] of MOVE_MENU_ITEMS) {
			if (moveNameInOrder(order, file.name, move) === null) continue; // would be a no-op — omit rather than offer a dead click

			menu.addItem((item) => {
				item.setTitle(title)
					.setIcon(icon)
					.setSection('explorer-order-editor-move')
					.onClick(() => {
						void this.moveFile(file, move);
					});
			});
		}
	}

	/**
	 * Moves `file` within its parent folder's saved order (`applyMove`,
	 * `moveItem.ts`) and reports the outcome — same shape as `clearOrderFor`
	 * above: `updateOrRepair`'s refusal is reported via `unusableReason()`
	 * rather than claimed as success, and a successful write gets the same
	 * auto-refresh handling.
	 *
	 * Deliberately does *not* also show a "Moved." success Notice the way
	 * `clearOrderFor` shows "Explorer order cleared.": a move is a small,
	 * often-repeated nudge (one hotkey press, or several in a row) where the
	 * reordered row itself is the feedback, and a Notice on every press would
	 * just be noise. The auto-refresh-off and no-file-explorer-leaf notices
	 * below still fire — those report a state the user can't otherwise see,
	 * which is a different thing from confirming a click landed.
	 */
	private async moveFile(file: TFile | TFolder, move: RowMove): Promise<void> {
		const outcome = await applyMove(this, file, move);

		// Silence, not a message: the item was already where this move would
		// put it, or stopped being movable between the check and the click.
		// Nothing happened and nothing is wrong.
		if (outcome === 'unchanged') return;

		if (outcome === 'refused') {
			new Notice(
				`Could not move: the order note ${this.store.unusableReason() ?? 'could not be repaired'}. ` +
					'Use "Repair the order note" in settings, or check the console for details.',
			);
			return;
		}

		if (!this.settings.autoRefresh) {
			new Notice('Automatic refresh is off. The file explorer will show this on its next refresh.');
			return;
		}

		if (!requestFileExplorerResort(this.app)) {
			new Notice('Saved. The file explorer will show this when you next open it.');
		}
	}
}
