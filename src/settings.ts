/**
 * Two settings, deliberately. There is no "sortspec filename" setting:
 * custom-sort always reads `sortspec.md` specifically, so letting a user
 * rename the file this plugin writes would produce a silent no-op — the
 * plugin would write happily to a file custom-sort never looks at.
 */
import { App, Notice, Plugin, PluginSettingTab, type SettingDefinitionItem } from 'obsidian';
import {
	isCustomSortAvailable,
	refreshCustomSort,
	SORTSPEC_FILENAME,
	syncHideSetting,
	type HideSettingSyncResult,
} from './sortspecFile';

export interface ExplorerOrderEditorSettings {
	/**
	 * After a successful save/clear, run custom-sort's refresh command so the
	 * file explorer updates immediately. When off, the plugin still writes
	 * the change — only the automatic refresh is skipped — and the Notice
	 * tells the user to run custom-sort's own refresh command instead.
	 */
	readonly autoRefresh: boolean;
	/**
	 * Ask custom-sort to hide `sortspec.md` from the file explorer, via its
	 * own `/--hide:` directive (verified against custom-sort's bundled
	 * source — it filters the named child out before rendering, the same
	 * mechanism that would back a "hide this file" feature). The directive
	 * lives inside a folder's own authored section, so toggling this setting
	 * runs `syncHideSetting` to rewrite every folder that already has one —
	 * a folder no order has ever been saved for has no sortspec.md to hide
	 * in the first place, so it's left alone either way. That rewrite also
	 * re-encodes each section from scratch, which incidentally drops any
	 * stale entries left over from before `entriesFor` excluded
	 * `sortspec.md` from the orderable list.
	 *
	 * Defaults to on. `sortspec.md` is a byproduct of using this plugin, not
	 * something the user wrote, and ordering twenty folders otherwise drops
	 * twenty files into the tree they never asked for — in a tool people
	 * choose partly for keeping their vault tidy. The argument the other way
	 * is real but weaker: hiding a file that holds the user's own
	 * configuration makes it harder to find when something looks wrong. That
	 * is answered by the setting being right here, and by the file being
	 * documented prominently rather than treated as internal. Note the hide
	 * only covers the file explorer — search, the quick switcher and the
	 * graph still show it, so nothing is truly out of reach.
	 */
	readonly hideSortspec: boolean;
}

export const DEFAULT_SETTINGS: ExplorerOrderEditorSettings = {
	autoRefresh: true,
	hideSortspec: true,
};

/**
 * Typed as a structural slice of `Plugin` rather than importing the concrete
 * plugin class, so this module doesn't need a circular import against
 * `main.ts` (which imports this module for the tab and the settings type).
 */
export interface SettingsHost extends Plugin {
	settings: ExplorerOrderEditorSettings;
	saveSettings(): Promise<void>;
}

export class ExplorerOrderEditorSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: SettingsHost,
	) {
		super(app, plugin);
	}

	/**
	 * True while `syncHideSetting` is walking the vault. Backs the hide
	 * toggle's `disabled`, which the declarative API re-evaluates on each
	 * render — so flipping this and calling `update()` is how a second click
	 * is kept from starting an overlapping vault-wide pass. The imperative
	 * version disabled the toggle object directly; there is no toggle object
	 * to reach for here, and there does not need to be.
	 */
	private syncing = false;

	/**
	 * Declared rather than rendered, so Obsidian can put these settings in its
	 * own settings search (1.13+). `display()` is deliberately absent: the
	 * base class only falls back to it when this returns nothing, and
	 * supporting both would mean two descriptions of three settings that have
	 * to agree forever.
	 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		// Rebuilt on every render, so this reflects custom-sort being enabled
		// or disabled while the tab is open.
		const available = isCustomSortAvailable(this.app);

		return [
			// Both settings below are about talking to custom-sort, and neither
			// has any visible effect without it, so its status belongs above
			// them rather than buried in a note at the bottom.
			//
			// Rendered imperatively only because the status is the one row
			// whose *styling* carries meaning — a missing dependency is a real
			// warning, not a neutral line — and a definition has no way to ask
			// for a class. Name and description are still declared above the
			// callback so they reach the settings search.
			{
				name: 'Custom file explorer sorting',
				desc: available
					? 'Detected. Orders you save here will be applied to the file explorer.'
					: 'Not detected. Orders are still saved to sortspec.md correctly, but the file explorer will keep sorting alphabetically until this plugin is installed and enabled.',
				render: (setting) => {
					setting.setClass(available ? 'eoe-dependency-ok' : 'eoe-dependency-missing');
				},
			},
			{
				name: 'Automatically refresh after saving',
				desc: "Re-run the custom file explorer sorting plugin's refresh command after saving or clearing an order, so the file explorer updates right away. When off, run that command yourself instead.",
				control: { type: 'toggle', key: 'autoRefresh' },
			},
			{
				name: 'Hide sortspec.md in the file explorer',
				desc:
					'Ask the custom file explorer sorting plugin to hide sortspec.md from folders where you save an order. ' +
					'Applies immediately to every such folder in the vault, in both directions — this also tidies each ' +
					"rewritten folder's section, dropping any stale sortspec.md entry left over from an older version of this plugin.",
				control: { type: 'toggle', key: 'hideSortspec', disabled: () => this.syncing },
			},
		];
	}

	getControlValue(key: string): unknown {
		switch (key) {
			case 'autoRefresh':
				return this.plugin.settings.autoRefresh;
			case 'hideSortspec':
				return this.plugin.settings.hideSortspec;
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

		if (key !== 'hideSortspec') return;

		// Guarded for the whole handler, not just the sync call: a second
		// click while `saveSettings`/`syncHideSetting` is still in flight for
		// the first must not fire a second, overlapping vault-wide pass.
		this.syncing = true;
		this.update();
		try {
			this.plugin.settings = { ...this.plugin.settings, hideSortspec: value };
			await this.plugin.saveSettings();

			const result = await syncHideSetting(this.app, value);
			await this.reportSync(result);
		} finally {
			this.syncing = false;
			this.update();
		}
	}

	/**
	 * Turns a `syncHideSetting` result into user-facing feedback, and — same
	 * as every other mutation in this plugin — triggers custom-sort's
	 * refresh command afterwards, but only when something actually changed
	 * and only when "automatically refresh after saving" is on. Unlike a
	 * single-folder save, this pass has no one particular file to anchor the
	 * refresh's metadata-cache wait on; any sortspec.md still on disk serves
	 * equally well as that anchor, since the refresh command itself is
	 * vault-wide, not scoped to whichever file we pass in.
	 */
	private async reportSync(result: HideSettingSyncResult): Promise<void> {
		let message =
			result.changed === 0 ? 'Nothing to update.' : `Updated ${result.changed} sortspec.md file${result.changed === 1 ? '' : 's'}.`;
		if (result.failed > 0) {
			message += ` ${result.failed} file${result.failed === 1 ? '' : 's'} could not be updated and ${result.failed === 1 ? 'was' : 'were'} left unchanged.`;
		}
		new Notice(message);

		if (result.changed === 0 || !this.plugin.settings.autoRefresh) return;

		const anchor = this.app.vault.getFiles().find((f) => f.name === SORTSPEC_FILENAME);
		if (anchor === undefined) return; // shouldn't happen: result.changed > 0 implies at least one still exists
		const refreshResult = await refreshCustomSort(this.app, anchor);
		if (refreshResult === 'missing') {
			new Notice('Install the custom file explorer sorting plugin to see the change in the file explorer.');
		}
	}
}
