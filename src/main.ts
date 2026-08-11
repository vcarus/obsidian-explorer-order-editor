import { App, Menu, MenuItem, Notice, Plugin, TAbstractFile, TFile, TFolder, type View, type WorkspaceLeaf } from 'obsidian';
import { installExplorerDrag } from './explorerDrag';
import { installExplorerSort } from './explorerSort';
import { focusedExplorerView } from './fileExplorerLeaves';
import { folderIndexKey, IndexFileStore, isIndexNote } from './indexFile';
import { refusalNotice, reportApplied } from './notices';
import { applyMove, effectiveOrder } from './moveItem';
import { OrderModal } from './OrderModal';
import { registerOrderSync } from './orderSync';
import { removeOrder } from './orderIndex';
import { moveNameInOrder, type RowMove } from './rowMove';
import { DEFAULT_SETTINGS, ExplorerOrderEditorSettingTab, type ExplorerOrderEditorSettings } from './settings';

/**
 * The four direct move actions, each as `[move, title, icon]` — one
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
 * `MenuItem.setSubmenu()` — present at runtime since well before this
 * plugin's `minAppVersion` (Obsidian's own menus build submenus with it, and
 * its section-grouping code calls it to turn a registered section into one),
 * but absent from the published typings, checked against `obsidian` 1.13.1.
 * Declared here rather than reached for with a cast, and never used without
 * `menuSupportsSubmenus()` having answered first.
 */
interface MenuItemWithSubmenu extends MenuItem {
	setSubmenu(): Menu;
}

/**
 * The file explorer view's currently focused row. Undocumented, so it is
 * declared locally and the value that comes out of it is re-checked with
 * `instanceof` before use — `file` is typed `unknown` on purpose, so that
 * checking it is the only way to get anything out of it.
 *
 * Also the type `isFileExplorerFocusView` below narrows to: a deferred file
 * explorer leaf's view has no `tree` at all, only a real one does, so probing
 * for it is what tells the two apart before `focusedExplorerView` trusts
 * `containerEl`, or `moveHotkeyTarget` trusts `tree`, on the result.
 */
interface FileExplorerFocus extends View {
	tree?: { focusedItem?: { file?: unknown } | null } | null;
}

function isFileExplorerFocusView(view: View): view is FileExplorerFocus {
	const candidate = view as Partial<FileExplorerFocus>;
	return typeof candidate.tree === 'object' && candidate.tree !== null;
}

/**
 * Whether a menu item can hold a submenu. Called twice per menu, for two
 * different reasons: once on `MenuItem.prototype`, which needs no instance and
 * so can answer before the parent item is created at all, and once on the item
 * itself, which is what narrows the type enough to make the call. A build
 * where the method has gone away degrades to the flat layout this plugin
 * shipped through 1.2.x rather than producing a parent item that opens onto
 * nothing.
 */
function hasSubmenu(item: MenuItem): item is MenuItemWithSubmenu {
	const candidate = item as Partial<MenuItemWithSubmenu>;
	return typeof candidate.setSubmenu === 'function';
}

/**
 * What the move hotkeys act on: the file explorer's focused row while the
 * explorer holds keyboard focus, and the active note otherwise.
 *
 * That condition is the whole point. Reading `focusedItem` unconditionally is
 * what a competitor does, and it means a hotkey pressed while editing a note
 * moves whatever row the explorer happened to be left on — the wrong item,
 * silently, with no way for the user to connect cause to effect. Scoping it to
 * "the explorer has focus" makes the rule one sentence long: the hotkey moves
 * the row you are on when you are in the tree, and the note you are in
 * otherwise.
 *
 * Both halves of that sentence live here, and they did not always. This used
 * to answer `TFile | TFolder | null` and leave the caller to write
 * `?? getActiveFile()`, which collapsed two different `null`s: "no explorer
 * has focus" (fall through to the note — correct) and "the explorer has focus
 * but no row does" (nothing to act on). Click the explorer's empty space or
 * its header and press the hotkey, and the second one silently became the
 * first: the plugin reordered the note open in the editor, in some other
 * folder entirely, with no success Notice — because by design the reordered
 * row *is* the feedback, and that row was off screen. Three states cannot be
 * returned as two, so the fall-through happens in here, where the third one
 * still exists.
 *
 * `focusedExplorerView` (`fileExplorerLeaves.ts`) does the walking, with
 * `isFileExplorerFocusView` above as the realness probe, and reads focus
 * through `containerEl.ownerDocument` so a popped-out explorer answers
 * correctly.
 */
function moveHotkeyTarget(app: App): TFile | TFolder | null {
	const view = focusedExplorerView(app, isFileExplorerFocusView);
	if (view === undefined) return app.workspace.getActiveFile();

	const file: unknown = view.tree?.focusedItem?.file;
	return file instanceof TFile || file instanceof TFolder ? file : null;
}

export default class ExplorerOrderEditorPlugin extends Plugin {
	settings: ExplorerOrderEditorSettings = DEFAULT_SETTINGS;
	store!: IndexFileStore;

	/**
	 * Set by `onunload` and read by `whenLayoutReady` below. `Component` has
	 * `_loaded` already, but it is private and unexported, so this is the same
	 * fact stated in a member this plugin owns rather than reached for through
	 * the internals.
	 */
	private unloaded = false;

	/**
	 * `onLayoutReady`, minus the callbacks that would otherwise fire into a
	 * plugin that is already gone.
	 *
	 * Obsidian's queue has no cancel:
	 * `onLayoutReady=function(e){null===this.onLayoutReadyCallbacks?e():this.onLayoutReadyCallbacks.push({pluginId:…,callback:e})}`
	 * — it never checks whether the plugin that queued an entry is still
	 * enabled when it drains (verified in `obsidian-internals.md`). And
	 * `Component.unload` drains `_events` only `if(this._loaded)`, so anything
	 * `register()`ed *after* unload is pushed onto an array that will never be
	 * drained.
	 *
	 * Those two together make an unguarded callback permanent. Disable the
	 * plugin during startup before layout-ready — a multi-second window on a
	 * large vault, and the ordinary hot-reload cycle in `testvault/` — and
	 * `installExplorerSort` would still write its wrapper onto
	 * `FileExplorerView.prototype`, `installExplorerDrag` would still arm its
	 * capture listeners, and both would hand their removers to a `register()`
	 * that no longer drains. A disabled plugin then keeps rendering orders out
	 * of a dead store and keeps intercepting drops into it, and re-enabling
	 * stacks a live wrapper on top of the dead one.
	 */
	private whenLayoutReady(run: () => void): void {
		this.app.workspace.onLayoutReady(() => {
			if (this.unloaded) return;
			run();
		});
	}

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
		this.whenLayoutReady(() => registerOrderSync(this));

		// A separate onLayoutReady call, for an unrelated reason: the file
		// explorer leaf itself need not exist yet (it can still be a
		// deferred/lazy leaf this early). installExplorerSort retries on its
		// own until it succeeds, so this only has to run once.
		this.whenLayoutReady(() => installExplorerSort(this));

		// Same reasoning, same retry-until-success shape, for the tree's own
		// drag-and-drop: installExplorerDrag needs the same file
		// explorer leaf/view installExplorerSort does, and is independent of
		// it otherwise, so it gets its own onLayoutReady call rather than
		// being folded into the one above.
		this.whenLayoutReady(() => installExplorerDrag(this));

		this.registerEvent(
			// `leaf` is the file explorer the right-click happened in, and it is
			// carried all the way to `OrderModal` rather than dropped: see
			// `explorerOrderNames`'s `from` for why the dialog cannot work this
			// out for itself.
			this.app.workspace.on('file-menu', (menu, file, _source, leaf) => {
				this.addOrderMenu(menu, file, leaf ?? null);
			}),
		);

		this.addCommand({
			id: 'set-order-for-vault-root',
			name: 'Set explorer order for vault root',
			callback: () => {
				new OrderModal(this.app, this.app.vault.getRoot(), this.settings, this.store, null).open();
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

		// One command per direct move action, so each can be given a
		// hotkey — the context menu items above cover the mouse case, but
		// hotkeys need commands regardless.
		//
		// The target is the file explorer's focused row while the explorer has
		// keyboard focus, and `app.workspace.getActiveFile()` otherwise.
		//
		// Through 1.2.x it was the active file alone, on the stated principle
		// that this project takes on undocumented API only where there is no
		// public alternative. The principle stands; the claim that a public
		// alternative existed here does not. `getActiveFile()` returns a
		// `TFile`, so no folder can ever be its target — which left every one
		// of these commands, and therefore every hotkey, unable to move a
		// folder at all. There is no public way to name a folder the user is
		// looking at, so this is exactly the case the principle admits.
		for (const [move, name] of MOVE_MENU_ITEMS) {
			this.addCommand({
				id: `move-${move}`,
				name,
				checkCallback: (checking) => {
					const target = moveHotkeyTarget(this.app);
					if (target === null) return false;
					const parent = target.parent;
					if (parent === null) return false;

					// The index note is never orderable. `effectiveOrder`
					// already leaves it out, so this only turns "the move would
					// be a no-op" into "the command is not offered".
					if (isIndexNote(target, this.settings)) return false;

					const order = effectiveOrder(this, parent);
					if (moveNameInOrder(order, target.name, move) === null) return false;

					if (!checking) void this.moveFile(target, move);
					return true;
				},
			});
		}
	}

	onunload(): void {
		// Read by `whenLayoutReady`. Set here rather than from a `register()`
		// teardown: `Component.unload` drains those and *then* calls this, both
		// in the same synchronous block, so either place is set long before the
		// layout-ready queue drains — and this one needs no note about
		// registration order to stay correct.
		this.unloaded = true;

		// Best-effort: performs any write `IndexFileStore`'s debounce hasn't
		// flushed yet, so disabling/reloading the plugin right after a save
		// can't drop it. Not awaited — `onunload` isn't guaranteed to be
		// awaited by Obsidian either — but the write is already scheduled
		// synchronously by `update()`, so this only affects *when* it lands,
		// not whether it's attempted.
		void this.store.flush();
	}

	private async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<ExplorerOrderEditorSettings> | null;
		// Picked field by field, not `{...DEFAULT_SETTINGS, ...data}`: `data`
		// is whatever `data.json` currently holds, which can also
		// carry `IndexFileStore`'s index backup (see `saveSettings` below).
		// Spreading the whole object would leak that stray key into
		// `this.settings` at runtime (the `Partial<...>` cast doesn't strip it),
		// and it would then ride along on every future `saveSettings()` call,
		// potentially overwriting a fresher backup with a stale one.
		this.settings = {
			autoRefresh: data?.autoRefresh ?? DEFAULT_SETTINGS.autoRefresh,
			hideIndexFile: data?.hideIndexFile ?? DEFAULT_SETTINGS.hideIndexFile,
			dragToReorder: data?.dragToReorder ?? DEFAULT_SETTINGS.dragToReorder,
			showMoveActions: data?.showMoveActions ?? DEFAULT_SETTINGS.showMoveActions,
			indexPath: data?.indexPath ?? DEFAULT_SETTINGS.indexPath,
		};
	}

	/**
	 * Serializes every read-modify-write of `data.json`, so the two writers
	 * that share the file — this plugin's settings and `IndexFileStore`'s
	 * index backup — cannot interleave.
	 *
	 * Merging alone is not enough, which is what both writers used to do.
	 * `loadData` → `saveData` is a read and a write with an `await` between
	 * them; two of those started close together both read the same snapshot,
	 * and the one that writes second silently reverts the other's key. The
	 * chain makes the pair atomic with respect to the other writer.
	 *
	 * `catch` on the stored chain, not on the returned promise: a failed write
	 * must not wedge every later one, but it still has to reach the caller.
	 */
	private dataChain: Promise<void> = Promise.resolve();

	async updateData(mutate: (data: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
		const run = this.dataChain.then(async () => {
			const data = (await this.loadData()) as Record<string, unknown> | null;
			await this.saveData(mutate({ ...data }));
		});
		this.dataChain = run.catch(() => undefined);
		return run;
	}

	async saveSettings(): Promise<void> {
		// Not a blind `saveData(this.settings)`: `data.json` is shared with
		// `IndexFileStore`'s index backup under a key this settings object
		// doesn't know about, and a wholesale overwrite from this
		// stale-by-construction object would erase it.
		await this.updateData((data) => ({ ...data, ...this.settings }));
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
		// unreadable, this is one of the explicit user actions the store heals
		// on (`updateOrRepair`'s doc lists them), so it gets a chance to repair
		// the note before completing the clear rather than refusing outright. Still checked, not
		// assumed — a repair with nothing left to recover still refuses, and
		// claiming "cleared" over that would be a plain lie about the user's
		// data.
		if (!(await this.store.updateOrRepair((index) => removeOrder(index, key)))) {
			refusalNotice('clear', this.store, 'from elsewhere');
			return;
		}
		new Notice('Explorer order cleared.');
		// 'Cleared', not 'Saved': with no file explorer leaf open this is the
		// second sentence the user reads, right after "Explorer order cleared."
		// — `settings.ts`'s vault-wide clear passes the same verb for the same
		// reason. The closed set exists so a caller has to pick a sentence that
		// is actually true; picking the wrong one is the only way left to get
		// this wrong.
		reportApplied(this.app, this.settings.autoRefresh, 'Cleared');
	}

	/**
	 * Everything this plugin contributes to a right-click menu, behind a
	 * single parent item.
	 *
	 * This reverses an earlier decision, and the note is kept because what
	 * changed is the reasoning, not the API. These items used to be added flat
	 * and merely grouped with `setSection`, on the grounds that
	 * `MenuItem.setSubmenu()` is absent from the public typings and reaching
	 * for it would need a cast. It is still absent (1.13.1) — but it is
	 * present at runtime and Obsidian's own menus are built with it, so the
	 * honest shape is a local interface plus a runtime guard, which is the
	 * treatment every other undocumented internal here already gets. The
	 * reason to want it: since 1.2 most reordering happens by dragging in the
	 * tree, so this plugin should cost one line in a menu the user opened to
	 * do something else, not six.
	 *
	 * Adds nothing at all when nothing of ours applies, rather than a parent
	 * item that opens onto an empty submenu.
	 */
	private addOrderMenu(menu: Menu, file: TAbstractFile, from: WorkspaceLeaf | null): void {
		const folder = file instanceof TFolder ? file : null;
		// Narrowed once here rather than inside `fillOrderMenu`: `moves` is
		// non-empty only for a `TFile`/`TFolder` (see `availableMoves`), but
		// that is a fact about two functions agreeing, not one the compiler can
		// see, so the narrowed value is what gets passed.
		const movable = file instanceof TFile || file instanceof TFolder ? file : null;
		const moves = this.availableMoves(file);

		if (folder === null && moves.length === 0) return;

		if (!hasSubmenu(MenuItem.prototype)) {
			this.fillOrderMenu(menu, folder, movable, moves, false, from);
			return;
		}

		menu.addItem((item) => {
			item.setTitle('Explorer order')
				// The file explorer context menu renders no icons at all — not
				// even for Obsidian's own items — so this only shows up in menu
				// contexts that do. Registered ids carry a `lucide-` prefix
				// (see getIconIds()); bare Lucide names are not in the map.
				.setIcon('lucide-arrow-up-down')
				.setSection('action');

			if (hasSubmenu(item)) this.fillOrderMenu(item.setSubmenu(), folder, movable, moves, true, from);
		});
	}

	/**
	 * Fills either the submenu or, if this build has no submenus, the
	 * right-click menu itself.
	 *
	 * `inSubmenu` decides two things that differ between those cases and
	 * nothing else. Titles: inside a parent item already named "Explorer
	 * order", repeating the word would read as "Explorer order ▸ Set explorer
	 * order", while flat among Obsidian's own items the short titles would
	 * belong to no one. Grouping: a submenu holds only our items, so a plain
	 * separator divides them, where the flat layout needs `setSection` to keep
	 * them together among items this plugin did not add.
	 */
	private fillOrderMenu(
		menu: Menu,
		folder: TFolder | null,
		file: TFile | TFolder | null,
		moves: readonly (readonly [RowMove, string, string])[],
		inSubmenu: boolean,
		from: WorkspaceLeaf | null,
	): void {
		if (folder !== null) {
			menu.addItem((item) => {
				item.setTitle(inSubmenu ? 'Set order' : 'Set explorer order')
					.setIcon('lucide-arrow-up-down')
					.onClick(() => {
						new OrderModal(this.app, folder, this.settings, this.store, from).open();
					});
				if (!inSubmenu) item.setSection('action');
			});

			// Only offered when there is actually something of ours to remove —
			// a folder with no saved order gets no menu item at all, rather
			// than one that clicks through to "nothing to clear".
			if (this.store.get(folderIndexKey(folder)) !== undefined) {
				menu.addItem((item) => {
					item.setTitle(inSubmenu ? 'Clear order' : 'Clear explorer order')
						.setIcon('lucide-list-x')
						.onClick(() => {
							void this.clearOrderFor(folder);
						});
					if (!inSubmenu) item.setSection('action');
				});
			}
		}

		if (moves.length === 0 || file === null) return;
		if (inSubmenu && folder !== null) menu.addSeparator();

		for (const [move, title, icon] of moves) {
			menu.addItem((item) => {
				item.setTitle(title)
					.setIcon(icon)
					.onClick(() => {
						void this.moveFile(file, move);
					});
				if (!inSubmenu) item.setSection('explorer-order-editor-move');
			});
		}
	}

	/**
	 * Whichever of the four direct move actions would actually do
	 * something for `file` — a move that is already a no-op is omitted rather
	 * than offered as a dead click.
	 *
	 * Empty for: the setting being off, anything that isn't a `TFile`/
	 * `TFolder`, the vault root (no parent to move it within), and the order
	 * index note itself (never orderable — see `moveItem.ts`'s
	 * `effectiveOrder`).
	 *
	 * `effectiveOrder` is computed once here and reused for all four
	 * decisions, rather than recomputed per item — it can read through the
	 * live file explorer, and there's no reason to pay for that four times to
	 * build one menu.
	 */
	private availableMoves(file: TAbstractFile): readonly (readonly [RowMove, string, string])[] {
		// Off by default (see `showMoveActions` in `settings.ts`). Read here,
		// per menu, rather than gating the `file-menu` registration itself:
		// a menu is built fresh on every right-click, so toggling the setting
		// takes effect on the very next one with no event to re-register.
		if (!this.settings.showMoveActions) return [];

		if (!(file instanceof TFile) && !(file instanceof TFolder)) return [];

		const parent = file.parent;
		if (parent === null) return [];

		if (isIndexNote(file, this.settings)) return [];

		const order = effectiveOrder(this, parent);
		return MOVE_MENU_ITEMS.filter(([move]) => moveNameInOrder(order, file.name, move) !== null);
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
			refusalNotice('move', this.store, 'from elsewhere');
			return;
		}

		reportApplied(this.app, this.settings.autoRefresh, 'Saved');
	}
}
