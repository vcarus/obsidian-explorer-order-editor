import { Plugin, TFolder } from 'obsidian';
import { OrderModal } from './OrderModal';

export default class ExplorerOrderEditorPlugin extends Plugin {
	onload(): void {
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
							new OrderModal(this.app, file).open();
						});
				});
			}),
		);

		this.addCommand({
			id: 'set-order-for-vault-root',
			name: 'Set explorer order for vault root',
			callback: () => {
				new OrderModal(this.app, this.app.vault.getRoot()).open();
			},
		});
	}
}
