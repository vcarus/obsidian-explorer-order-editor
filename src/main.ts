import { Notice, Plugin, TFolder } from 'obsidian';
import { OrderModal } from './OrderModal';
import { DEFAULT_SETTINGS, ExplorerOrderEditorSettingTab, type ExplorerOrderEditorSettings } from './settings';
import {
	clearFolderOrder,
	folderHasClearableOrder,
	isCustomSortAvailable,
	refreshCustomSort,
	sortspecPathFor,
} from './sortspecFile';

export default class ExplorerOrderEditorPlugin extends Plugin {
	settings: ExplorerOrderEditorSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new ExplorerOrderEditorSettingTab(this.app, this));

		// This plugin only writes configuration; the custom-sort plugin is what
		// actually reorders the file explorer. Without it everything here still
		// works and sortspec.md is still written correctly, but nothing visibly
		// changes — so say so up front rather than letting someone arrange a
		// folder, save, and only then discover a piece is missing.
		//
		// Deferred to onLayoutReady because plugin load order is not guaranteed:
		// checking during onload can run before custom-sort has registered its
		// commands and report a false negative.
		this.app.workspace.onLayoutReady(() => {
			if (isCustomSortAvailable(this.app)) return;
			new Notice(
				'Orders you save are written correctly, but the file explorer will keep sorting alphabetically until the custom file explorer sorting plugin is installed and enabled.',
				10000,
			);
		});

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
			new Notice('Automatic refresh is off. Run the custom file explorer sorting plugin\'s refresh command to see the change.');
			return;
		}

		if (fileBeforeClear === null) return; // shouldn't happen — folderHasClearableOrder already confirmed a file existed
		const refreshResult = await refreshCustomSort(this.app, fileBeforeClear);
		if (refreshResult === 'missing') {
			new Notice('Install the custom file explorer sorting plugin to see the change in the file explorer.');
		}
	}
}
