/**
 * Three exposed settings, plus one stored-but-not-yet-exposed value:
 *
 * - `autoRefresh`, `hideIndexFile`, and `dragToReorder` below have toggles on
 *   this tab.
 * - `indexPath` (the vault path of the order index note, read by
 *   `IndexFileStore`) is stored but deliberately not exposed. A text field
 *   here would let one typo point the plugin at a note that doesn't exist,
 *   whose only symptom is every saved order appearing to vanish at once —
 *   a bad trade for a need nobody has expressed. It lives in the settings
 *   type anyway so the path is configurable by hand, and so exposing it
 *   later is a UI change rather than a data-shape change.
 */
import { App, normalizePath, Notice, Plugin, PluginSettingTab, TFile, type SettingDefinitionItem } from 'obsidian';
import { ConfirmModal } from './ConfirmModal';
import { folderIndexKey, requestFileExplorerResort, type IndexFileStore } from './indexFile';
import { pruneMissing } from './orderIndex';
import { isQuarantinePath } from './quarantine';

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
	/**
	 * Let dragging a row in the file explorer itself reorder it (M12b,
	 * `explorerDrag.ts`) — same-folder reordering and dropping onto a
	 * specific position in a different folder, without opening "Set explorer
	 * order" first. Read at the moment each drag event fires
	 * (`explorerDrag.ts`'s judgment checks it first, before anything else),
	 * so toggling this off takes effect immediately and needs no listener to
	 * be re-registered: the next `dragover` simply stops being intercepted
	 * and Obsidian's native drop handling takes back over unchanged.
	 *
	 * Defaults to on: it changes nothing about how existing orders render,
	 * only adds a second way to change one, and the file explorer's native
	 * drag-and-drop (move into a folder) keeps working underneath it exactly
	 * as before everywhere this doesn't take over.
	 */
	readonly dragToReorder: boolean;
	/** See the module doc comment above. */
	readonly indexPath: string;
}

export const DEFAULT_SETTINGS: ExplorerOrderEditorSettings = {
	autoRefresh: true,
	hideIndexFile: true,
	dragToReorder: true,
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
			{
				name: 'Drag to reorder in the file explorer',
				desc: 'Drag a file or folder onto another one in the file explorer to reorder it, without opening "Set explorer order" first.',
				control: { type: 'toggle', key: 'dragToReorder' },
			},
			// The cold-start repair action (M10e part 5): only ever visible
			// while the store is unusable, so a healthy vault never shows it.
			// Saving or clearing an order already attempts this same repair
			// automatically the moment it needs to write — this row exists for
			// the case that doesn't happen to run first, e.g. right after
			// startup finds the note broken and the user just wants it fixed
			// without touching anything else yet.
			{
				name: 'Repair the order note',
				desc:
					'The order note could not be read. Repairing keeps the unreadable note as a copy beside it, ' +
					'then rebuilds the note from everything still recoverable: the note itself, what is currently loaded, and the last backup.',
				visible: () => !this.plugin.store.isUsable(),
				disabled: () => this.busy,
				action: () => void this.runRepair(),
			},
			// Housekeeping for the copies `IndexFileStore` keeps when it has to
			// repair the order note. Named and described in full sentences on
			// purpose: "quarantined copies" means nothing to someone who has
			// never seen one, and these appear in the vault unannounced, so
			// the row has to answer "what is this file and why is it here"
			// before it offers to delete anything.
			{
				name: 'Delete the kept copies of unreadable order notes',
				desc:
					'When the order note cannot be read — a bad hand edit, or a sync conflict — this plugin rebuilds it from whatever it can recover, ' +
					'and keeps the unreadable version beside it as a separate note so nothing is thrown away. ' +
					'Those kept copies are only useful for checking whether an order went missing in the rebuild. ' +
					'Once you are satisfied nothing is, they can go.',
				visible: () => this.quarantineFiles().length > 0,
				disabled: () => this.busy,
				action: () => void this.runDeleteQuarantines(),
			},
			// Manual escape hatch for `pruneMissing` (`orderIndex.ts`), which
			// nothing else ever calls: a key whose folder is missing at startup
			// is never pruned automatically, since that could just as easily be
			// sync lag or a rename made while the plugin was off, and pruning it
			// behind the user's back would be indistinguishable from silently
			// losing an order. This row is the only place a stale key can ever
			// be removed, so it stays visible for as long as one exists rather
			// than being a one-time migration control.
			{
				name: 'Remove orders for missing folders',
				desc:
					'A stale entry is a saved order for a folder that is no longer in the vault — usually because it was deleted or renamed while this plugin was not running. ' +
					'This removes those entries from the order note. Folders that still exist are never affected.',
				visible: () => this.staleKeys().length > 0,
				disabled: () => this.busy,
				action: () => void this.runPruneMissing(),
			},
		];
	}

	/**
	 * Guards every action row on this tab while any one of them is running:
	 * several walk the whole vault, and two overlapping passes would race
	 * each other's writes (to the vault, or to the order note itself).
	 */
	private busy = false;

	/** Every kept copy of an unreadable order note currently in the vault. */
	private quarantineFiles(): readonly TFile[] {
		const notePath = normalizePath(this.plugin.settings.indexPath);
		return this.app.vault.getFiles().filter((file) => isQuarantinePath(notePath, file.path));
	}

	/**
	 * Every folder currently in the vault, keyed exactly the way the index
	 * keys its own entries — via `folderIndexKey`, not raw `TFolder.path` —
	 * so this set and the index can never disagree about what the vault root
	 * is called. `getAllFolders(true)` includes the root itself, which is why
	 * this doesn't also need to special-case it the way `folderIndexKey`'s own
	 * callers elsewhere do.
	 */
	private existingFolderKeys(): ReadonlySet<string> {
		return new Set(this.app.vault.getAllFolders(true).map((folder) => folderIndexKey(folder)));
	}

	/**
	 * Index keys with no corresponding folder in the vault right now — see
	 * "Remove orders for missing folders" below. Recomputed on each call,
	 * same as `quarantineFiles`: cheap enough to run on every settings
	 * render, and always current with no cached flag to go stale after a
	 * prune removes the last one.
	 */
	private staleKeys(): readonly string[] {
		const existing = this.existingFolderKeys();
		return [...this.plugin.store.keys()].filter((key) => !existing.has(key));
	}

	private async runDeleteQuarantines(): Promise<void> {
		const files = this.quarantineFiles();
		if (files.length === 0) return;

		const confirmed = await ConfirmModal.ask(
			this.app,
			`Delete ${files.length} kept cop${files.length === 1 ? 'y' : 'ies'}?`,
			'These are the unreadable versions of your order note, kept when it was repaired. ' +
				"Your current order note is not affected. This moves them to your vault's trash.",
			'Delete',
		);
		if (!confirmed) return;

		this.busy = true;
		this.update();
		try {
			let deleted = 0;
			let failed = 0;
			for (const file of files) {
				try {
					await this.app.fileManager.trashFile(file);
					deleted++;
				} catch (err) {
					console.error('[explorer-order-editor] failed to delete a kept copy of the order note', err);
					failed++;
				}
			}
			new Notice(failed > 0 ? `Deleted ${deleted}. ${failed} could not be deleted — see the console.` : `Deleted ${deleted}.`);
		} finally {
			this.busy = false;
			this.update();
		}
	}

	/**
	 * "Remove orders for missing folders" — the manual escape hatch for
	 * `pruneMissing` (`orderIndex.ts`), which nothing else in the plugin ever
	 * calls (see its doc comment: pruning automatically at startup risks
	 * discarding an order over sync lag or an offline rename, not an actual
	 * deletion). `updateOrRepair`, not `update`: a broken order note gets the
	 * same chance to heal here as saving or clearing gives it, same as
	 * `main.ts`'s `clearOrderFor`, which this otherwise mirrors — a single
	 * mutation, counted from the size difference `pruneMissing` itself
	 * produces rather than from the pre-confirmation snapshot (which could in
	 * principle be stale by the time this actually runs).
	 */
	private async runPruneMissing(): Promise<void> {
		const stale = this.staleKeys();
		if (stale.length === 0) return;

		const confirmed = await ConfirmModal.ask(
			this.app,
			`Remove ${stale.length} stale ${stale.length === 1 ? 'entry' : 'entries'}?`,
			'A stale entry is a saved order for a folder that is no longer in the vault — usually because it was deleted or renamed while this plugin was not running. ' +
				'Folders that still exist are never affected.',
			'Remove',
		);
		if (!confirmed) return;

		this.busy = true;
		this.update();
		try {
			const existing = this.existingFolderKeys();
			let removed = 0;
			const ok = await this.plugin.store.updateOrRepair((index) => {
				const pruned = pruneMissing(index, existing);
				removed = index.size - pruned.size;
				return pruned;
			});

			if (!ok) {
				new Notice(
					`Could not remove stale entries: the order note ${this.plugin.store.unusableReason() ?? 'could not be repaired'}. ` +
						'Use "Repair the order note" above, or check the console for details.',
				);
				return;
			}
			new Notice(`Removed ${removed} stale ${removed === 1 ? 'entry' : 'entries'}.`);
		} finally {
			this.busy = false;
			this.update();
		}
	}

	/**
	 * "Repair the order note" (M10e part 5). Only ever visible while the
	 * store is unusable, so this row is the explicit, discoverable action for
	 * the cold-start case: a bad note found at load time leaves nothing in
	 * memory, and healing automatically at that point would risk clobbering
	 * an edit the user made deliberately while Obsidian was closed — so
	 * nothing repairs until this (or a save/clear/migration row) is actually
	 * clicked. `store.repair()` runs the identical recovery machinery those
	 * other actions trigger automatically, already reports its own outcome
	 * via a Notice (success naming the quarantine note, failure logged), so
	 * this only has to redraw the tab — the row disappears on success because
	 * `visible` is re-evaluated — and ask the file explorer to re-sort.
	 */
	private async runRepair(): Promise<void> {
		this.busy = true;
		this.update();
		try {
			const healed = await this.plugin.store.repair();
			if (healed) requestFileExplorerResort(this.app);
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
			case 'dragToReorder':
				return this.plugin.settings.dragToReorder;
			default:
				return undefined;
		}
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		// The signature is `unknown` for every control type the API supports;
		// all of ours are toggles, so anything else means we were handed a
		// key we never declared.
		if (typeof value !== 'boolean') return;

		if (key === 'autoRefresh') {
			this.plugin.settings = { ...this.plugin.settings, autoRefresh: value };
			await this.plugin.saveSettings();
			return;
		}

		if (key === 'hideIndexFile') {
			// Unlike the old `hideSortspec` toggle, there is no vault-wide file to
			// rewrite: hiding is purely a rendering choice `explorerSort.ts` makes
			// on every call, driven straight off this setting. So the toggle only
			// has to save and ask for a re-sort.
			this.plugin.settings = { ...this.plugin.settings, hideIndexFile: value };
			await this.plugin.saveSettings();
			requestFileExplorerResort(this.app);
			return;
		}

		if (key !== 'dragToReorder') return;

		// No re-sort needed: `explorerDrag.ts` reads this setting fresh on
		// every drag event (see its own doc comment), so a save is the whole
		// story — there is no listener to tear down or re-install, unlike
		// `hideIndexFile` above, which changes what the tree renders.
		this.plugin.settings = { ...this.plugin.settings, dragToReorder: value };
		await this.plugin.saveSettings();
	}
}
