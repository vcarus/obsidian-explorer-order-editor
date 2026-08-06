import { App, ButtonComponent, Modal, setIcon, setTooltip, TFile, TFolder } from 'obsidian';
import Sortable from 'sortablejs';
import type { Entry } from './types';

const ICON_FOLDER = 'lucide-folder';
const ICON_FILE = 'lucide-file-text';
const ICON_GRIP = 'lucide-grip-vertical';

/**
 * One row in the reorder list. `entry` is the immutable identity (name +
 * kind) that M4 will hand to the sortspec layer; everything else here is
 * UI-only bookkeeping.
 */
interface OrderRow {
	readonly entry: Entry;
	/**
	 * Reason this entry can't be expressed in sorting-spec syntax, if any.
	 * A defined value greys the row out and surfaces this text as a tooltip.
	 *
	 * TODO(M4): compute this from the real predicate once sortspec.ts
	 * exposes one — it will know which names collide with reserved tokens,
	 * contain the literal "...", etc. See computeDisabledReason() below: it
	 * currently forwards to demoDisabledReason(), a hard-coded stand-in that
	 * exists only so this styling has something to preview. Delete that call
	 * (and demoDisabledReason itself) once the real predicate lands.
	 */
	readonly disabledReason?: string;
}

export class OrderModal extends Modal {
	private listEl: HTMLElement | null = null;
	private sortable: Sortable | null = null;
	private readonly entryByRowEl = new Map<HTMLElement, Entry>();

	constructor(
		app: App,
		private readonly folder: TFolder,
	) {
		super(app);
	}

	onOpen(): void {
		const displayPath = this.folder.isRoot() ? this.app.vault.getName() || 'Vault root' : this.folder.path;
		this.setTitle(displayPath);

		const rows = this.deriveRows(this.folder);

		if (rows.length === 0) {
			this.contentEl.createDiv({
				cls: 'eoe-empty',
				text: 'This folder has nothing to order.',
			});
			return;
		}

		const listEl = this.contentEl.createDiv({ cls: 'eoe-list' });
		this.listEl = listEl;

		for (const row of rows) {
			this.renderRow(listEl, row);
		}

		this.sortable = new Sortable(listEl, {
			// Obsidian mobile is a WebView where native HTML5 drag events are
			// unreliable, so we bypass them entirely — desktop and mobile
			// both go through the same fallback path.
			forceFallback: true,
			// Only the grip element starts a drag; the rest of the row (and
			// the modal itself) stays scrollable, including by touch.
			handle: '.eoe-row-handle',
			// Long-press to start a drag on touch so a swipe scrolls instead
			// of immediately dragging. Desktop mouse users get no delay.
			delay: 200,
			delayOnTouchOnly: true,
			// A few pixels of slop before a drag is recognized, so a tap
			// isn't swallowed as an accidental drag.
			fallbackTolerance: 5,
			animation: 150,
			ghostClass: 'eoe-row-ghost',
			chosenClass: 'eoe-row-chosen',
			dragClass: 'eoe-row-drag',
		});

		this.renderFooter();
	}

	onClose(): void {
		this.sortable?.destroy();
		this.sortable = null;
		this.listEl = null;
		this.entryByRowEl.clear();
		this.contentEl.empty();
	}

	/**
	 * Reads the on-screen order back into `Entry[]`. This is the one seam
	 * M4 needs: call this, hand the array to the sortspec layer. The save
	 * handler below stays a thin call site around it.
	 */
	private collectOrderedEntries(): Entry[] {
		const listEl = this.listEl;
		if (!listEl) return [];

		const entries: Entry[] = [];
		for (const child of Array.from(listEl.children)) {
			if (!child.instanceOf(HTMLElement)) continue;
			const entry = this.entryByRowEl.get(child);
			if (entry) entries.push(entry);
		}
		return entries;
	}

	/**
	 * Derives the initial row order from `folder.children`. There's no
	 * public API for "the file explorer's current visual order", so this
	 * approximates it: folders first, then files, each group alphabetical
	 * by display name via `localeCompare`.
	 */
	private deriveRows(folder: TFolder): OrderRow[] {
		const folderEntries: Entry[] = [];
		const fileEntries: Entry[] = [];

		for (const child of folder.children) {
			if (child instanceof TFolder) {
				folderEntries.push({ name: child.name, kind: 'folder' });
			} else if (child instanceof TFile) {
				const name = child.extension === 'md' ? child.basename : child.name;
				fileEntries.push({ name, kind: 'file' });
			}
		}

		folderEntries.sort((a, b) => a.name.localeCompare(b.name));
		fileEntries.sort((a, b) => a.name.localeCompare(b.name));

		return [...folderEntries, ...fileEntries].map((entry) => ({
			entry,
			disabledReason: this.computeDisabledReason(entry),
		}));
	}

	private computeDisabledReason(entry: Entry): string | undefined {
		// TODO(M4): replace this with the real predicate from sortspec.ts
		// once M2 exposes one.
		return this.demoDisabledReason(entry);
	}

	// ---- temporary demo — delete this method and the call to it above once M2 lands ----
	private demoDisabledReason(entry: Entry): string | undefined {
		if (!entry.name.startsWith('Untitled')) return undefined;
		return 'Preview only: this is a hard-coded stand-in for M4, not a real check yet.';
	}
	// ---- end temporary demo ----

	private renderRow(container: HTMLElement, row: OrderRow): void {
		const rowEl = container.createDiv({ cls: 'eoe-row' });
		this.entryByRowEl.set(rowEl, row.entry);

		if (row.disabledReason !== undefined) {
			rowEl.addClass('eoe-row-disabled');
			setTooltip(rowEl, row.disabledReason);
		}

		const handle = rowEl.createDiv({ cls: 'eoe-row-handle' });
		setIcon(handle, ICON_GRIP);
		setTooltip(handle, 'Drag to reorder');

		const icon = rowEl.createDiv({ cls: 'eoe-row-icon' });
		setIcon(icon, row.entry.kind === 'folder' ? ICON_FOLDER : ICON_FILE);

		rowEl.createSpan({ cls: 'eoe-row-name', text: row.entry.name });
	}

	private renderFooter(): void {
		const footer = this.contentEl.createDiv({ cls: 'eoe-footer' });

		new ButtonComponent(footer).setButtonText('Cancel').onClick(() => this.close());

		new ButtonComponent(footer)
			.setButtonText('Save')
			.setCta()
			.onClick(() => {
				const orderedEntries = this.collectOrderedEntries();
				// M4 replaces this with a call into sortspecFile.ts. Cancel
				// (and closing the modal any other way) never reaches here,
				// so it stays a pure no-op. `console.debug` (not `.log`) is
				// the one the lint config allows — see the "recommended"
				// no-console override in eslint.config.mts's dependency.
				console.debug('[explorer-order-editor] order to save:', orderedEntries);
				this.close();
			});
	}
}
