import { Notice, Plugin, TFolder } from 'obsidian';
import { installExplorerSort } from './explorerSort';
import { folderIndexKey, IndexFileStore, requestFileExplorerResort } from './indexFile';
import { OrderModal } from './OrderModal';
import { registerOrderSync } from './orderSync';
import { removeOrder } from './orderIndex';
import { DEFAULT_SETTINGS, ExplorerOrderEditorSettingTab, type ExplorerOrderEditorSettings } from './settings';

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

		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (!(file instanceof TFolder)) return;

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
								this.clearOrderFor(file);
							});
					});
				}
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
					this.clearOrderFor(root);
				}
				return true;
			},
		});
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
		this.settings = { ...DEFAULT_SETTINGS, ...data, hideIndexFile };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private clearOrderFor(folder: TFolder): void {
		const key = folderIndexKey(folder);
		if (this.store.get(key) === undefined) {
			// The menu item and command are both gated on this same condition,
			// so this is only reachable if the folder's stored order changed
			// between the check and the click — report rather than pretend
			// success.
			new Notice('Nothing to clear for this folder.');
			return;
		}

		// Checked, not assumed: `update` refuses while the order note is
		// unparseable, and claiming "cleared" over a refusal would be a plain
		// lie about the user's data.
		if (!this.store.update((index) => removeOrder(index, key))) {
			new Notice(`Could not clear: the order note ${this.store.unusableReason() ?? 'could not be written'}. Fix it and try again.`);
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
}
