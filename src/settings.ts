/**
 * Two settings, deliberately. There is no "sortspec filename" setting:
 * custom-sort always reads `sortspec.md` specifically, so letting a user
 * rename the file this plugin writes would produce a silent no-op — the
 * plugin would write happily to a file custom-sort never looks at.
 */
import { App, Plugin, PluginSettingTab, Setting } from 'obsidian';

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
	 * mechanism that would back a "hide this file" feature). Takes effect
	 * the next time a folder's order is saved: the directive lives inside
	 * that folder's own authored section, so a folder no order has ever been
	 * saved for has no sortspec.md to hide in the first place.
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
				'Ask the custom file explorer sorting plugin to hide sortspec.md from folders where you save an order.',
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.hideSortspec).onChange(async (value) => {
					this.plugin.settings = { ...this.plugin.settings, hideSortspec: value };
					await this.plugin.saveSettings();
				}),
			);
	}
}
