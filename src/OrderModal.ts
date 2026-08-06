import { App, Modal, TFolder } from 'obsidian';

export class OrderModal extends Modal {
	constructor(
		app: App,
		private readonly folder: TFolder,
	) {
		super(app);
	}

	onOpen(): void {
		const displayPath = this.folder.isRoot() ? this.app.vault.getName() || 'Vault root' : this.folder.path;

		this.setTitle(displayPath);

		this.contentEl.createEl('p', {
			text: `${displayPath} — ${this.folder.children.length} direct children`,
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
