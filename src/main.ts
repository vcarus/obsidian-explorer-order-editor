import { Notice, Plugin, TFolder } from 'obsidian';
import { installExplorerSort } from './explorerSort';
import { OrderModal } from './OrderModal';
import { registerOrderSync } from './orderSync';
import { DEFAULT_SETTINGS, ExplorerOrderEditorSettingTab, type ExplorerOrderEditorSettings } from './settings';
import {
	clearFolderOrder,
	folderHasClearableOrder,
	refreshCustomSort,
	sortspecPathFor,
} from './sortspecFile';

export default class ExplorerOrderEditorPlugin extends Plugin {
	settings: ExplorerOrderEditorSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new ExplorerOrderEditorSettingTab(this.app, this));

		// Deferred to onLayoutReady to sit out the vault's startup indexing
		// flood of rename-like events.
		//
		// Earlier versions had a third onLayoutReady call here, showing a
		// Notice when custom-sort was absent: saved orders were written
		// correctly but nothing in the file explorer would change. That was
		// true then and is not now — with nothing else installed, the patch
		// below renders the order itself, so there is nothing to warn about.
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
							new OrderModal(this.app, file, this.settings).open();
						});
				});

				// Only offered when there is actually something of ours to
				// remove — a folder with no saved order (or only a
				// hand-written, non-authored section) gets no menu item at
				// all, rather than one that clicks through to "nothing to
				// clear".
				if (folderHasClearableOrder(this.app, file)) {
					menu.addItem((item) => {
						item.setTitle('Clear explorer order')
							.setIcon('lucide-list-x')
							.setSection('action')
							.onClick(() => {
								void this.clearOrderFor(file);
							});
					});
				}
			}),
		);

		this.addCommand({
			id: 'set-order-for-vault-root',
			name: 'Set explorer order for vault root',
			callback: () => {
				new OrderModal(this.app, this.app.vault.getRoot(), this.settings).open();
			},
		});

		this.addCommand({
			id: 'clear-order-for-vault-root',
			name: 'Clear explorer order for vault root',
			// checkCallback so this doesn't sit uselessly in the command
			// palette when the vault root has no saved order to clear.
			checkCallback: (checking) => {
				const root = this.app.vault.getRoot();
				if (!folderHasClearableOrder(this.app, root)) return false;
				if (!checking) {
					void this.clearOrderFor(root);
				}
				return true;
			},
		});
	}

	private async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<ExplorerOrderEditorSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...data };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private async clearOrderFor(folder: TFolder): Promise<void> {
		// Captured before the mutation: clearing can trash the file (once
		// everything in it is gone), so it may no longer resolve via
		// getFileByPath afterward. refreshCustomSort only ever reads `.path`
		// off this object — it never dereferences it through the vault again
		// — so the pre-clear reference stays good for that even once the
		// file itself is gone, and the refresh still has to run in that case:
		// custom-sort's own cached copy of this folder's (now-removed) order
		// otherwise stays in effect until some unrelated refresh happens to
		// flush it.
		const fileBeforeClear = this.app.vault.getFileByPath(sortspecPathFor(folder));

		let result;
		try {
			result = await clearFolderOrder(this.app, folder);
		} catch (err) {
			console.error('[explorer-order-editor] failed to clear explorer order', err);
			new Notice('Could not clear the explorer order: an unexpected error occurred.');
			return;
		}

		if (result.status !== 'removed') {
			// folderHasClearableOrder gates both entry points on this same
			// condition, so this is only reachable if the folder changed
			// between the check and the click — report rather than pretend
			// success.
			new Notice('Nothing to clear for this folder.');
			return;
		}

		new Notice('Explorer order cleared.');

		if (!this.settings.autoRefresh) {
			new Notice('Automatic refresh is off. The file explorer will show this on its next refresh.');
			return;
		}

		if (fileBeforeClear === null) return; // shouldn't happen — folderHasClearableOrder already confirmed a file existed
		const refreshResult = await refreshCustomSort(this.app, fileBeforeClear);
		if (refreshResult === 'missing') {
			// Neither renderer could be reached: no custom-sort, and no file
			// explorer view to ask for a redraw either. The change is saved
			// regardless — only the redraw is missing.
			new Notice('Saved. The file explorer will show this when you next open it.');
		}
	}
}
