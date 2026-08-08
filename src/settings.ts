/**
 * Two exposed settings, plus one stored-but-not-yet-exposed value:
 *
 * - `autoRefresh` and `hideIndexFile` below have toggles on this tab.
 * - `indexPath` (the vault path of the order index note, read by
 *   `IndexFileStore`) is stored but deliberately not exposed. A text field
 *   here would let one typo point the plugin at a note that doesn't exist,
 *   whose only symptom is every saved order appearing to vanish at once —
 *   a bad trade for a need nobody has expressed. It lives in the settings
 *   type anyway so the path is configurable by hand, and so exposing it
 *   later is a UI change rather than a data-shape change.
 */
import { App, Notice, Plugin, PluginSettingTab, type SettingDefinitionItem } from 'obsidian';
import { ConfirmModal } from './ConfirmModal';
import { requestFileExplorerResort, type IndexFileStore } from './indexFile';
import { deleteImportedSortspecFiles, importOrdersFromSortspec } from './sortspecMigration';
import { SORTSPEC_FILENAME } from './sortspecFile';

export interface ExplorerOrderEditorSettings {
	/**
	 * After a successful save/clear, ask the file explorer to redraw so it
	 * updates immediately. When off, the plugin still writes the change —
	 * only the automatic refresh is skipped.
	 */
	readonly autoRefresh: boolean;
	/**
	 * Hide the order index note from the file explorer — this plugin's own
	 * renderer (`explorerSort.ts`) simply omits that one row, the same way
	 * it renders every other saved order.
	 *
	 * Defaults to on, for the same reason the old `hideSortspec` setting
	 * did: the note is a byproduct of using this plugin, not something the
	 * user wrote. Note the hide only covers the file explorer — search, the
	 * quick switcher and the graph still show it.
	 */
	readonly hideIndexFile: boolean;
	/** See the module doc comment above. */
	readonly indexPath: string;
}

export const DEFAULT_SETTINGS: ExplorerOrderEditorSettings = {
	autoRefresh: true,
	hideIndexFile: true,
	indexPath: 'explorer-order.md',
};

/**
 * Typed as a structural slice of `Plugin` rather than importing the concrete
 * plugin class, so this module doesn't need a circular import against
 * `main.ts` (which imports this module for the tab and the settings type).
 */
export interface SettingsHost extends Plugin {
	settings: ExplorerOrderEditorSettings;
	saveSettings(): Promise<void>;
	store: IndexFileStore;
}

export class ExplorerOrderEditorSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: SettingsHost,
	) {
		super(app, plugin);
	}

	/**
	 * Declared rather than rendered, so Obsidian can put these settings in its
	 * own settings search (1.13+). `display()` is deliberately absent: the
	 * base class only falls back to it when this returns nothing, and
	 * supporting both would mean two descriptions of these settings that have
	 * to agree forever.
	 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: 'Automatically refresh after saving',
				desc: 'Update the file explorer as soon as an order is saved or cleared, instead of waiting for its next refresh.',
				control: { type: 'toggle', key: 'autoRefresh' },
			},
			{
				name: 'Hide the order note in the file explorer',
				desc: 'Hide the note that stores saved orders from the file explorer.',
				control: { type: 'toggle', key: 'hideIndexFile' },
			},
			// Migration, for vaults carrying orders from a version before 1.0.
			// `visible` is re-evaluated on every render, so both rows are
			// absent entirely in a vault that has no sortspec.md — which is
			// every vault that started on 1.0 or later. A one-time migration
			// control has no business being permanent furniture, and settings
			// search skips a hidden row too.
			{
				name: 'Import orders from sortspec.md files',
				desc:
					'Copies orders saved by versions before 1.0 into the order note. ' +
					'Imports only orders this plugin wrote, skips folders that already have one, and is safe to run more than once. ' +
					'It deletes nothing: the sortspec.md files stay where they are.',
				visible: () => this.hasSortspecFiles(),
				disabled: () => this.busy,
				action: () => void this.runImport(),
			},
			{
				name: 'Delete imported sortspec.md files',
				desc:
					'Removes the old files once you are satisfied with the import. ' +
					'Only touches folders whose order is now in the order note, and only sections this plugin wrote — anything you wrote by hand is left alone.',
				visible: () => this.hasSortspecFiles(),
				disabled: () => this.busy,
				action: () => void this.runCleanup(),
			},
		];
	}

	/**
	 * Whether this vault still holds anything the migration rows could act on.
	 * Walks the file list on each settings render, which is rare enough that a
	 * scan costs nothing and is always current — no cached flag to go stale
	 * after an import deletes the last one.
	 */
	private hasSortspecFiles(): boolean {
		return this.app.vault.getFiles().some((file) => file.name === SORTSPEC_FILENAME);
	}

	/**
	 * Guards both migration rows while either is running: they walk the whole
	 * vault, and two overlapping passes would race each other's writes.
	 */
	private busy = false;

	/**
	 * Reports and stops when the order note cannot be written. Both migration
	 * rows walk the whole vault and report counts afterwards; without this the
	 * import would count every folder it "imported" into a store that refused
	 * every single write.
	 */
	private refuseWhileUnusable(): boolean {
		const reason = this.plugin.store.unusableReason();
		if (reason === null) return false;
		new Notice(`The order note ${reason}. Fix it before importing or deleting anything.`, 0);
		return true;
	}

	private async runImport(): Promise<void> {
		if (this.refuseWhileUnusable()) return;
		this.busy = true;
		this.update();
		try {
			const summary = await importOrdersFromSortspec(this.app, this.plugin.store);

			// Persistent (duration 0) rather than the default timeout: this
			// runs once and the counts are the whole point of running it.
			const lines = [
				`Imported ${summary.imported} folder order${summary.imported === 1 ? '' : 's'} from sortspec.md files.`,
				`Skipped ${summary.skippedAlreadyOrdered} already in the order note, ${summary.skippedNoAuthoredOrder} with no order of ours.`,
			];
			if (summary.failed > 0) lines.push(`${summary.failed} failed — see the console for details.`);
			lines.push('The sortspec.md files were left in place. If Custom File Explorer sorting is enabled, it keeps rendering from them until they are removed below.');
			new Notice(lines.join('\n'), 0);

			if (summary.imported > 0 && this.plugin.settings.autoRefresh) {
				requestFileExplorerResort(this.app);
			}
		} finally {
			this.busy = false;
			this.update();
		}
	}

	private async runCleanup(): Promise<void> {
		// Guarded before the confirmation, not after: this deletes the files
		// that are the fallback for a broken order note, and doing that while
		// the note itself cannot be written is the one ordering that could
		// leave a vault with neither copy.
		if (this.refuseWhileUnusable()) return;

		const confirmed = await ConfirmModal.ask(
			this.app,
			'Delete imported sortspec.md files?',
			'This moves them to your vault\'s trash, and only for folders whose order is already in the order note. Sections you wrote by hand are never removed.',
			'Delete files',
		);
		if (!confirmed) return;

		this.busy = true;
		this.update();
		try {
			const summary = await deleteImportedSortspecFiles(this.app, this.plugin.store);

			const lines = [
				`Deleted ${summary.deleted} sortspec.md file${summary.deleted === 1 ? '' : 's'}.`,
				`Edited and kept ${summary.editedKept} (other content remained).`,
				`Left ${summary.untouched} untouched (nothing of ours in them).`,
			];
			if (summary.skippedNotImported > 0) {
				lines.push(`Left ${summary.skippedNotImported} alone because their folders have no order in the order note — import first if you want those removed too.`);
			}
			if (summary.failed > 0) lines.push(`${summary.failed} failed — see the console for details.`);
			new Notice(lines.join('\n'), 0);
		} finally {
			this.busy = false;
			this.update();
		}
	}

	getControlValue(key: string): unknown {
		switch (key) {
			case 'autoRefresh':
				return this.plugin.settings.autoRefresh;
			case 'hideIndexFile':
				return this.plugin.settings.hideIndexFile;
			default:
				return undefined;
		}
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		// The signature is `unknown` for every control type the API supports;
		// both of ours are toggles, so anything else means we were handed a
		// key we never declared.
		if (typeof value !== 'boolean') return;

		if (key === 'autoRefresh') {
			this.plugin.settings = { ...this.plugin.settings, autoRefresh: value };
			await this.plugin.saveSettings();
			return;
		}

		if (key !== 'hideIndexFile') return;

		// Unlike the old `hideSortspec` toggle, there is no vault-wide file to
		// rewrite: hiding is purely a rendering choice `explorerSort.ts` makes
		// on every call, driven straight off this setting. So the toggle only
		// has to save and ask for a re-sort.
		this.plugin.settings = { ...this.plugin.settings, hideIndexFile: value };
		await this.plugin.saveSettings();
		requestFileExplorerResort(this.app);
	}
}
