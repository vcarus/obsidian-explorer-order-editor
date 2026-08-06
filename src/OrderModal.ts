import { App, ButtonComponent, Modal, Notice, setIcon, setTooltip, TFolder } from 'obsidian';
import Sortable from 'sortablejs';
import { FrontMatterError, type FrontMatterErrorCode } from './frontmatter';
import {
	buildNameIndex,
	encodeEntry,
	mergeStoredOrder,
	upsertFolderOrder,
	type Diagnostic,
	type MutationResult,
	type NameIndex,
	type UnencodableReason,
} from './sortspec';
import { entriesFor, readStoredOrder, refreshCustomSort, sortspecPathFor, targetKeyFor, updateFolderSpec } from './sortspecFile';
import type { Entry } from './types';

const ICON_FOLDER = 'lucide-folder';
const ICON_FILE = 'lucide-file-text';
const ICON_GRIP = 'lucide-grip-vertical';

/**
 * One row in the reorder list. `entry` is the immutable identity (name +
 * kind) that gets handed to the sortspec layer on save; everything else
 * here is UI-only bookkeeping.
 */
interface OrderRow {
	readonly entry: Entry;
	/**
	 * Reason this entry can't be expressed in sorting-spec syntax, if any.
	 * A defined value greys the row out and surfaces this text as a tooltip.
	 */
	readonly disabledReason?: string;
}

export class OrderModal extends Modal {
	private listEl: HTMLElement | null = null;
	private sortable: Sortable | null = null;
	private readonly entryByRowEl = new Map<HTMLElement, Entry>();
	private closed = false;
	private saving = false;

	constructor(
		app: App,
		private readonly folder: TFolder,
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		const displayPath = this.folder.isRoot() ? this.app.vault.getName() || 'Vault root' : this.folder.path;
		this.setTitle(displayPath);

		const siblings = entriesFor(this.folder);
		if (siblings.length === 0) {
			this.contentEl.createDiv({
				cls: 'eoe-empty',
				text: 'This folder has nothing to order.',
			});
			return;
		}

		// Restore whatever order is already stored for this folder, merged
		// against what's actually here now. Without this, reopening the modal
		// on an already-ordered folder would show alphabetical order and
		// saving would silently destroy the existing order.
		const stored = await readStoredOrder(this.app, this.folder, siblings);
		if (this.closed) return; // the modal was closed while the read was in flight
		const orderedEntries = mergeStoredOrder(stored, siblings);

		const index = buildNameIndex(siblings);
		const rows: OrderRow[] = orderedEntries.map((entry) => ({
			entry,
			disabledReason: this.computeDisabledReason(entry, index),
		}));

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
		this.closed = true;
		this.sortable?.destroy();
		this.sortable = null;
		this.listEl = null;
		this.entryByRowEl.clear();
		this.contentEl.empty();
	}

	/**
	 * Reads the on-screen order back into `Entry[]`, in the order the rows
	 * currently appear after any dragging.
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

	/** The real representability check: can `encodeEntry` actually write this entry? */
	private computeDisabledReason(entry: Entry, index: NameIndex): string | undefined {
		const result = encodeEntry(entry, index);
		if (result.ok) return undefined;
		return describeUnencodableReason(result.reason);
	}

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

		const saveButton = new ButtonComponent(footer)
			.setButtonText('Save')
			.setCta()
			.onClick(() => {
				if (this.saving) return;
				this.saving = true;
				saveButton.setDisabled(true);
				void this.save().finally(() => {
					this.saving = false;
					saveButton.setDisabled(false);
				});
			});
	}

	private async save(): Promise<void> {
		const orderedEntries = this.collectOrderedEntries();

		let result: MutationResult;
		try {
			result = await updateFolderSpec(this.app, this.folder, (spec) =>
				upsertFolderOrder(spec, targetKeyFor(this.folder), orderedEntries),
			);
		} catch (err) {
			if (err instanceof FrontMatterError) {
				new Notice(`Could not save the explorer order: ${describeFrontMatterError(err.code)}.`);
				return;
			}
			console.error('[explorer-order-editor] failed to save explorer order', err);
			new Notice('Could not save the explorer order: an unexpected error occurred.');
			return;
		}

		switch (result.status) {
			case 'blocked':
				this.reportBlocked(result.diagnostics);
				return;
			case 'unchanged':
				new Notice('Explorer order unchanged.');
				this.close();
				return;
			case 'replaced':
			case 'appended':
				await this.reportSaved(result.diagnostics);
				this.close();
				return;
			case 'removed':
				// Save only ever upserts; unreachable from this modal.
				this.close();
				return;
		}
	}

	private reportBlocked(diagnostics: readonly Diagnostic[]): void {
		const conflict = diagnostics.find(
			(d): d is Extract<Diagnostic, { kind: 'multi-target-conflict' }> => d.kind === 'multi-target-conflict',
		);
		if (conflict !== undefined) {
			const fragment = createFragment((el) => {
				el.createSpan({
					text: `Found a section in sortspec.md that also controls other folders (target-folder: ${conflict.targets.join(', ')}), so editing it here would change those too.`,
				});
				const button = el.createEl('button', { text: 'Open sortspec.md', cls: 'eoe-notice-action' });
				button.addEventListener('click', () => {
					void this.openSortspecFile();
				});
			});
			new Notice(fragment, 0);
			return;
		}

		const duplicate = diagnostics.find(
			(d): d is Extract<Diagnostic, { kind: 'duplicate-section' }> => d.kind === 'duplicate-section',
		);
		if (duplicate !== undefined) {
			new Notice(`Found ${duplicate.count} conflicting sections for this folder in sortspec.md; it needs manual attention.`);
			return;
		}

		new Notice('Could not save the explorer order.');
	}

	private async reportSaved(diagnostics: readonly Diagnostic[]): Promise<void> {
		const skipped = diagnostics.filter(
			(d): d is Extract<Diagnostic, { kind: 'unrepresentable-entry' }> => d.kind === 'unrepresentable-entry',
		);
		const replacedForeign = diagnostics.some((d) => d.kind === 'foreign-section-replaced');

		let message = 'Explorer order saved.';
		if (replacedForeign) {
			message += ' Replaced a hand-written section for this folder.';
		}
		if (skipped.length > 0) {
			const names = skipped.map((d) => `"${d.name}" (${describeUnencodableReason(d.reason)})`).join(', ');
			message += ` Skipped ${skipped.length} item(s) that cannot be represented: ${names}.`;
		}
		new Notice(message);

		const file = this.app.vault.getFileByPath(sortspecPathFor(this.folder));
		if (file === null) return; // shouldn't happen right after a successful write
		const refreshResult = await refreshCustomSort(this.app, file);
		if (refreshResult === 'missing') {
			new Notice('Install the custom file explorer sorting plugin to see the new order in the file explorer.');
		}
	}

	private async openSortspecFile(): Promise<void> {
		const file = this.app.vault.getFileByPath(sortspecPathFor(this.folder));
		if (file === null) return;
		await this.app.workspace.getLeaf(false).openFile(file);
		this.close();
	}
}

function describeUnencodableReason(reason: UnencodableReason): string {
	switch (reason) {
		case 'empty':
			return 'the name is empty';
		case 'whitespace':
			return 'has leading or trailing whitespace';
		case 'newline':
			return 'contains a line break';
		case 'wildcard':
			return "contains '...'";
		case 'backslash':
			return 'contains a backslash';
	}
}

function describeFrontMatterError(code: FrontMatterErrorCode): string {
	switch (code) {
		case 'invalid-yaml':
			return "the file's front matter is not valid YAML";
		case 'duplicate-key':
			return 'the file has more than one sorting-spec key';
		case 'unsupported-shape':
			return 'the existing sorting-spec value has a shape this plugin cannot safely rewrite';
		case 'verification-failed':
			return 'the write could not be verified, so nothing was changed';
	}
}
