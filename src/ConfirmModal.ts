/**
 * A small yes/no dialog, used only before the actions that destroy something
 * no undo brings back — the settings tab's delete-kept-copies, prune-stale,
 * clear-all and start-over rows. (It predates all four: it originally guarded
 * deleting migration-era sortspec.md files, a layer removed in 1.2.)
 *
 * Obsidian has no built-in confirm, and the alternatives are worse: a Notice
 * cannot ask anything, and a "click twice to confirm" button states its real
 * meaning only after the first click. Everything else this plugin does is
 * either reversible (an order can be re-dragged) or already gated by its own
 * safety property, which is why nothing else asks.
 */
import { App, Modal } from 'obsidian';

export class ConfirmModal extends Modal {
	private confirmed = false;

	private constructor(
		app: App,
		private readonly title: string,
		private readonly body: string,
		private readonly confirmLabel: string,
		private readonly resolve: (confirmed: boolean) => void,
	) {
		super(app);
	}

	/**
	 * Opens the dialog and resolves to what the user chose. Dismissing it any
	 * other way — Escape, the close button, clicking outside — resolves
	 * `false`: for a destructive action, anything that isn't an explicit yes
	 * has to mean no.
	 */
	static ask(app: App, title: string, body: string, confirmLabel: string): Promise<boolean> {
		return new Promise((resolve) => {
			new ConfirmModal(app, title, body, confirmLabel, resolve).open();
		});
	}

	onOpen(): void {
		this.setTitle(this.title);
		this.contentEl.createEl('p', { text: this.body });

		const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' });
		const cancel = buttons.createEl('button', { text: 'Cancel' });
		cancel.addEventListener('click', () => this.close());

		const confirm = buttons.createEl('button', { text: this.confirmLabel, cls: 'mod-warning' });
		confirm.addEventListener('click', () => {
			this.confirmed = true;
			this.close();
		});
		// Focus lands on the safe choice, so a stray Enter cancels rather than
		// confirms.
		cancel.focus();
	}

	onClose(): void {
		this.contentEl.empty();
		this.resolve(this.confirmed);
	}
}
