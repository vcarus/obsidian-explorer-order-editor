/**
 * Two settings, deliberately. There is no "sortspec filename" setting:
 * custom-sort always reads `sortspec.md` specifically, so letting a user
 * rename the file this plugin writes would produce a silent no-op — the
 * plugin would write happily to a file custom-sort never looks at.
 */
import { App, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { refreshCustomSort, SORTSPEC_FILENAME, syncHideSetting, type HideSettingSyncResult } from './sortspecFile';

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
	 */
	readonly hideSortspec: boolean;
}

export const DEFAULT_SETTINGS: ExplorerOrderEditorSettings = {
	autoRefresh: true,
	hideSortspec: false,
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

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Automatically refresh after saving')
			.setDesc(
				'Re-run the custom file explorer sorting plugin\'s refresh command after saving or clearing an order, so the file explorer updates right away. When off, run that command yourself instead.',
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoRefresh).onChange(async (value) => {
					this.plugin.settings = { ...this.plugin.settings, autoRefresh: value };
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Hide sortspec.md in the file explorer')
			.setDesc(
				'Ask the custom file explorer sorting plugin to hide sortspec.md from folders where you save an order. ' +
					'Applies immediately to every such folder in the vault, in both directions — this also tidies each ' +
					"rewritten folder's section, dropping any stale sortspec.md entry left over from an older version of this plugin.",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.hideSortspec).onChange(async (value) => {
					// Disabled for the whole handler, not just the sync call: a
					// second click while `saveSettings`/`syncHideSetting` is still
					// in flight for the first must not fire a second, overlapping
					// vault-wide pass.
					toggle.setDisabled(true);
					try {
						this.plugin.settings = { ...this.plugin.settings, hideSortspec: value };
						await this.plugin.saveSettings();

						const result = await syncHideSetting(this.app, value);
						await this.reportSync(result);
					} finally {
						toggle.setDisabled(false);
					}
				}),
			);
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
