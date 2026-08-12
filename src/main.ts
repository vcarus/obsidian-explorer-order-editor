import { App, Menu, MenuItem, Notice, Plugin, TAbstractFile, TFile, TFolder, type View, type WorkspaceLeaf } from 'obsidian';
import { installExplorerDrag } from './explorerDrag';
import { installExplorerSort } from './explorerSort';
import { focusedExplorerView } from './fileExplorerLeaves';
import { folderIndexKey, IndexFileStore, isIndexNote, requestFileExplorerResort } from './indexFile';
import { dataUnreadable, refusalNotice, reportApplied, settingNotSaved, settingsRecovered } from './notices';
import { boolField, classifyData, holdsAll, mergedData, stringField, type DataRead } from './pluginData';
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

		// Quitting the app is not an unload. Obsidian's own beforeunload handler
		// saves the layout and fires this event; it never unloads plugins, so
		// neither `onunload` below nor anything handed to `register()` runs on
		// the way out (verified in `obsidian-internals.md`). Without this, a
		// reorder made inside the debounce window and then followed by Cmd+Q
		// was lost — which is most of what the flush in `onunload` was written
		// to prevent, covered only for the disable/hot-reload path.
		//
		// `tasks.add` is the mechanism Obsidian gives for exactly this: a
		// non-empty task list makes it hold the quit behind a "Saving..."
		// notice until the promises settle, so the write actually lands rather
		// than racing the process going away. Best effort by the API's own
		// admission ("not guaranteed to actually run"), which is why the
		// debounce is short and this is a backstop rather than the plan.
		this.registerEvent(
			this.app.workspace.on('quit', (tasks) => {
				tasks.add(() => this.store.flush());
			}),
		);

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

	/**
	 * `data.json`, with "could not read it" kept apart from "nothing stored
	 * there" — see `DataRead` for why Obsidian's own API drops that difference
	 * and for the asar evidence that it never throws.
	 *
	 * The one owner of that classification, for the same reason
	 * `indexNotePath` owns "which file is the index note": three call sites
	 * read this file (settings, the settings write, the store's backup) and
	 * each had its own nullish check, all three of which read `undefined` as
	 * an empty file.
	 *
	 * Does not throw, which is what `IndexFileHost.readData` promises: a
	 * caller deciding what an unreadable file means must not also have to
	 * decide what a thrown one means.
	 */
	async readData(): Promise<DataRead> {
		try {
			const read = classifyData(await this.loadData());
			// Logged here, in the arm that is actually reachable, and not only
			// in the catch below: every notice this raises says "see the
			// console", and until this line existed there was nothing there to
			// see. Obsidian logs its own "failed to read JSON" for a failed
			// read, but says nothing at all for valid json that is not an
			// object — which `classifyData` also calls unreadable.
			if (read.status === 'unreadable') {
				console.error(`[explorer-order-editor] could not read ${this.manifest.dir ?? ''}/data.json: it is missing, unreadable or not a json object`);
			}
			return read;
		} catch (err) {
			// Obsidian does not throw here (`pluginData.ts`), so this is a belt
			// against a future where it does — and the reason the contract can
			// promise callers that every failure arrives as `'unreadable'`.
			console.error('[explorer-order-editor] failed to read data.json', err);
			return { status: 'unreadable' };
		}
	}

	/**
	 * True while `data.json` could not be read, so everything in `settings` is
	 * a default rather than the user's choice.
	 *
	 * Kept rather than announced and forgotten, for the reason `storeHealth`
	 * keeps the note's: the settings tab would otherwise render defaults as if
	 * they were chosen, `saveSettings` would have to rediscover the state by
	 * attempting a write, and a tab opened five minutes after the Notice would
	 * say nothing at all. `indexPath` is one of the defaulted values, so this
	 * is also what tells `onExternalSettingsChange` whether a recovered file
	 * means the store is now looking at the wrong note.
	 */
	private defaultedSettings = false;

	/** @see defaultedSettings — read by the settings tab for its warning row. */
	settingsAreDefaulted(): boolean {
		return this.defaultedSettings;
	}

	private async loadSettings(): Promise<void> {
		const read = await this.readData();
		const wasDefaulted = this.defaultedSettings;
		this.defaultedSettings = read.status === 'unreadable';
		// Once per unreadable stretch, the way `madeUnusable` does it for the
		// note: this now runs again on every external change and on the
		// settings tab's own retry, and a Notice per attempt would be noise
		// about a condition the tab is already showing.
		if (this.defaultedSettings && !wasDefaulted) dataUnreadable();
		const data = read.status === 'ok' ? read.data : {};
		// Picked field by field, not `{...DEFAULT_SETTINGS, ...data}`: `data`
		// is whatever `data.json` currently holds, which can also
		// carry `IndexFileStore`'s index backup (see `saveSettings` below).
		// Spreading the whole object would leak that stray key into
		// `this.settings` at runtime (the `Partial<...>` cast doesn't strip it),
		// and it would then ride along on every future `saveSettings()` call,
		// potentially overwriting a fresher backup with a stale one.
		//
		// Typed field readers rather than `??` for the reason `boolField`
		// documents: valid json is not the same as a usable value.
		this.settings = {
			autoRefresh: boolField(data, 'autoRefresh', DEFAULT_SETTINGS.autoRefresh),
			hideIndexFile: boolField(data, 'hideIndexFile', DEFAULT_SETTINGS.hideIndexFile),
			dragToReorder: boolField(data, 'dragToReorder', DEFAULT_SETTINGS.dragToReorder),
			showMoveActions: boolField(data, 'showMoveActions', DEFAULT_SETTINGS.showMoveActions),
			indexPath: stringField(data, 'indexPath', DEFAULT_SETTINGS.indexPath),
		};
	}

	/**
	 * Obsidian's own "someone else changed your `data.json`" hook, used for
	 * exactly one thing: recovering from having had to fall back to defaults.
	 *
	 * The chain is `raw` → `Plugins.onRaw` (path must be this plugin's
	 * `data.json`) → a 50ms-debounced `_onConfigFileChange`, which calls this
	 * only when the file's mtime is **strictly greater** than the last one this
	 * plugin wrote, then refreshes the settings tab itself. Decompiled in
	 * `docs/dev/obsidian-internals.md`.
	 *
	 * Two things make it work here, and both are worth stating because both
	 * are easy to break:
	 *
	 * - `Plugin.loadData()` records that mtime only when it actually read
	 *   something, so after an unreadable start the threshold stays at 0 and
	 *   *any* repair fires this — including a sync client's, which typically
	 *   preserves an older mtime and would otherwise be ignored.
	 * - `saveData` raises the threshold to `Date.now()` **before** writing, and
	 *   does so even when the write fails. Saving defaults over a file we could
	 *   not read would therefore have closed this door permanently. That
	 *   `updateData` refuses instead is what holds it open.
	 *
	 * Deliberately does nothing when the settings did load: adopting arbitrary
	 * mid-session settings changes from another device is a separate feature
	 * with its own questions (an `indexPath` moving under a loaded index), and
	 * nothing here regresses by leaving it alone — before this hook existed,
	 * every external change was ignored.
	 */
	async onExternalSettingsChange(): Promise<void> {
		if (!this.defaultedSettings) return;
		const before = this.settings.indexPath;
		await this.loadSettings();
		if (this.defaultedSettings) return;

		// The store spent this session pointed at the default path. Re-reading
		// is the whole point of recovering: whatever it loaded (usually
		// nothing, since the note is at the path we could not read) is answered
		// for a file that was never the user's.
		if (this.settings.indexPath !== before) await this.store.load();
		settingsRecovered();
		requestFileExplorerResort(this.app);
	}

	/**
	 * Re-reads `data.json` on demand — the settings tab's retry, and the belt
	 * for the two cases the hook above cannot cover: a failed `saveData` has
	 * already raised its mtime threshold to "now", and the `raw` pipeline for
	 * hidden config paths is unverified on mobile.
	 */
	async reloadSettings(): Promise<boolean> {
		await this.loadSettings();
		if (!this.defaultedSettings) requestFileExplorerResort(this.app);
		return !this.defaultedSettings;
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

	async updateData(mutate: (data: Record<string, unknown>) => Record<string, unknown>): Promise<'written' | 'refused'> {
		const run = this.dataChain.then(async () => {
			// The merge-or-refuse policy is `mergedData` (`pluginData.ts`), not
			// written out here, so the test double runs the same one: a double
			// that accepts writes in the case this refuses would let a test
			// assert "the backup was not clobbered" against the double.
			const next = mergedData(await this.readData(), mutate);
			if (next === null) return 'refused' as const;
			await this.saveData(next);
			return 'written' as const;
		});
		this.dataChain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/**
	 * Persists `settings`, and — unusually — checks that it worked.
	 *
	 * The check is not defensive programming: `Plugin.saveData` cannot fail out
	 * loud. It resolves through `Vault.writeJson`, whose catch discards the
	 * error and logs nothing, so a full disk or a read-only `.obsidian`
	 * produces a resolved promise, no console line, and a toggle that silently
	 * disagrees with the file. Reading the file back is the only signal there
	 * is (`docs/dev/obsidian-internals.md`), and it costs one small read on an
	 * action a user takes a handful of times.
	 *
	 * Only on this path. The index backup writes through the same
	 * `updateData` on every reorder, and there the extra read would be per
	 * order change to tell the user something they cannot act on — the note
	 * itself, which is where orders actually live, does report its own write
	 * failures (`retryFailedWrite`).
	 *
	 * Does not reject: `indexFile.ts`'s rename follower and the settings tab's
	 * toggles have nowhere to put an exception, which is why the outcome is a
	 * value.
	 */
	async saveSettings(): Promise<'saved' | 'not-saved'> {
		try {
			// Not a blind `saveData(this.settings)`: `data.json` is shared with
			// `IndexFileStore`'s index backup under a key this settings object
			// doesn't know about, and a wholesale overwrite from this
			// stale-by-construction object would erase it.
			if ((await this.updateData((data) => ({ ...data, ...this.settings }))) === 'refused') {
				settingNotSaved('unreadable');
				return 'not-saved';
			}
			// Read-back through the same serial queue the write used, and
			// through `readData` rather than any cache: `Vault.cachedRead` is
			// keyed by TFile and is not in this path at all, and `adapter.read`
			// is uncached.
			const after = await this.readData();
			// `{...this.settings}` because the settings type has no index
			// signature — a structural detail, not a copy anyone needs.
			if (after.status !== 'ok' || !holdsAll(after.data, { ...this.settings })) {
				settingNotSaved('write-failed');
				return 'not-saved';
			}
			return 'saved';
		} catch (err) {
			// A rejection can only come from something other than the write
			// itself now, but it still must not reach the callers: a promise
			// they don't await lands as an unhandled rejection. The setting
			// stays changed in memory for this session (undoing it would be a
			// second surprise), and saying so is what stops that from being a
			// silent lie about persistence.
			console.error('[explorer-order-editor] failed to save settings', err);
			settingNotSaved('write-failed');
			return 'not-saved';
		}
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
