import { App, ButtonComponent, Modal, Notice, setIcon, setTooltip, TFolder } from 'obsidian';
import Sortable from 'sortablejs';
import { FrontMatterError, type FrontMatterErrorCode } from './frontmatter';
import type { ExplorerOrderEditorSettings } from './settings';
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
import {
	entriesFor,
	folderNoteConflict,
	readStoredOrder,
	refreshCustomSort,
	SORTSPEC_FILENAME,
	sortspecPathFor,
	targetKeyFor,
	updateFolderSpec,
} from './sortspecFile';
import type { Entry } from './types';

const ICON_FOLDER = 'lucide-folder';
const ICON_FILE = 'lucide-file-text';
const ICON_GRIP = 'lucide-grip-vertical';
const ICON_WARNING = 'lucide-triangle-alert';

/**
 * One row in the reorder list. `entry` is the immutable identity (name +
 * kind) that gets handed to the sortspec layer on save; everything else
 * here is UI-only bookkeeping.
 */
interface OrderRow {
	readonly entry: Entry;
	/**
	 * Reason this entry can't be expressed in sorting-spec syntax, if any. A
	 * defined value routes the row into the non-sortable "unorderable"
	 * region (greyed out, no drag handle) and surfaces this text as a
	 * tooltip; `undefined` keeps it in the draggable list.
	 */
	readonly disabledReason?: string;
}

export class OrderModal extends Modal {
	private listEl: HTMLElement | null = null;
	private sortable: Sortable | null = null;
	private readonly entryByRowEl = new Map<HTMLElement, Entry>();
	/**
	 * Entries that can't be represented in custom-sort's syntax, in the order
	 * they're rendered in the (non-sortable) second region. Not draggable, so
	 * `collectOrderedEntries` can't recover them from DOM order the way it
	 * does for `listEl`'s children — this is their fixed contribution instead.
	 */
	private unorderableEntries: readonly Entry[] = [];
	private closed = false;
	private saving = false;

	constructor(
		app: App,
		private readonly folder: TFolder,
		private readonly settings: ExplorerOrderEditorSettings,
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		const displayPath = this.folder.isRoot() ? this.app.vault.getName() || 'Vault root' : this.folder.path;
		this.setTitle(displayPath);

		const hasFolderNoteConflict = await folderNoteConflict(this.app, this.folder);
		if (this.closed) return; // the modal was closed while the read was in flight
		if (hasFolderNoteConflict) {
			this.renderFolderNoteWarning();
		}

		const siblings = entriesFor(this.folder);
		if (siblings.length <= 1) {
			this.contentEl.createDiv({
				cls: 'eoe-empty',
				text: siblings.length === 0 ? 'This folder has nothing to order.' : 'This folder has only one item — nothing to order.',
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

		// Split into two regions: only entries `encodeEntry` can actually
		// represent get a sortable, draggable row — dragging an entry that
		// can never be written to the spec (or dropping one below such an
		// entry) would imply an ordering this plugin cannot deliver. See
		// `collectOrderedEntries` for how the unorderable ones still make it
		// into the saved result despite living outside the sortable list.
		const orderableRows = rows.filter((row) => row.disabledReason === undefined);
		const unorderableRows = rows.filter((row) => row.disabledReason !== undefined);
		this.unorderableEntries = unorderableRows.map((row) => row.entry);

		if (orderableRows.length > 0) {
			const listEl = this.contentEl.createDiv({ cls: 'eoe-list' });
			this.listEl = listEl;

			for (const row of orderableRows) {
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
				// The list is capped at 60vh and scrolls, so a folder with many
				// children needs the dragged row to scroll the list when it nears
				// an edge. SortableJS's auto-scroll does not engage on the fallback
				// path unless forceAutoScrollFallback is set — and forceFallback
				// above puts us on that path always, including on desktop.
				scroll: true,
				forceAutoScrollFallback: true,
				scrollSensitivity: 60,
				scrollSpeed: 12,
				animation: 150,
				ghostClass: 'eoe-row-ghost',
				chosenClass: 'eoe-row-chosen',
				dragClass: 'eoe-row-drag',
			});
		}

		if (unorderableRows.length > 0) {
			this.contentEl.createDiv({
				cls: 'eoe-unorderable-note',
				text: "These can't be ordered — custom file explorer sorting has no way to express their names. They always appear last.",
			});

			const unorderableListEl = this.contentEl.createDiv({ cls: 'eoe-unorderable-list' });
			for (const row of unorderableRows) {
				this.renderRow(unorderableListEl, row);
			}
		}

		// Nothing to drag into an order means nothing to save.
		this.renderFooter(orderableRows.length > 0);
	}

	onClose(): void {
		this.closed = true;
		this.sortable?.destroy();
		this.sortable = null;
		this.listEl = null;
		this.entryByRowEl.clear();
		this.unorderableEntries = [];
		this.contentEl.empty();
	}

	/**
	 * Reads the on-screen order back into `Entry[]`: the sortable rows in
	 * their current on-screen order (after any dragging), followed by the
	 * unorderable ones. The unorderable entries still need to reach
	 * `upsertFolderOrder` even though they live outside the sortable list and
	 * are never actually written — passing them through is what makes it emit
	 * the `unrepresentable-entry` diagnostics the "Skipped N item(s)…" notice
	 * depends on.
	 */
	private collectOrderedEntries(): Entry[] {
		const entries: Entry[] = [];
		const listEl = this.listEl;
		if (listEl) {
			for (const child of Array.from(listEl.children)) {
				if (!child.instanceOf(HTMLElement)) continue;
				const entry = this.entryByRowEl.get(child);
				if (entry) entries.push(entry);
			}
		}
		entries.push(...this.unorderableEntries);
		return entries;
	}

	/** The real representability check: can `encodeEntry` actually write this entry? */
	private computeDisabledReason(entry: Entry, index: NameIndex): string | undefined {
		const result = encodeEntry(entry, index);
		if (result.ok) return undefined;
		return describeUnencodableReason(result.reason);
	}

	/**
	 * custom-sort also reads `Folder/Folder.md` as a sorting spec for this
	 * folder. If that note also targets this folder, its section is a
	 * second, independent source of truth custom-sort has no documented
	 * precedence rule for — surfaced here, before the user invests effort
	 * dragging rows, rather than only discovered after saving. We never
	 * touch the note itself.
	 */
	private renderFolderNoteWarning(): void {
		const banner = this.contentEl.createDiv({ cls: 'eoe-warning' });
		setIcon(banner.createSpan({ cls: 'eoe-warning-icon' }), ICON_WARNING);
		banner.createSpan({
			cls: 'eoe-warning-text',
			text: `${this.folder.name}.md also has a sorting-spec for this folder and may override the order saved here.`,
		});
	}

	/**
	 * Renders one row. A row with a `disabledReason` gets no drag handle at
	 * all — not just a non-functional one — since these rows never sit in a
	 * `Sortable`-managed container and dragging them would do nothing; a grip
	 * that does nothing is the same false promise the disabled styling used
	 * to make on its own.
	 */
	private renderRow(container: HTMLElement, row: OrderRow): void {
		const rowEl = container.createDiv({ cls: 'eoe-row' });
		this.entryByRowEl.set(rowEl, row.entry);

		if (row.disabledReason !== undefined) {
			rowEl.addClass('eoe-row-disabled');
			setTooltip(rowEl, row.disabledReason);
		} else {
			const handle = rowEl.createDiv({ cls: 'eoe-row-handle' });
			setIcon(handle, ICON_GRIP);
			setTooltip(handle, 'Drag to reorder');
		}

		const icon = rowEl.createDiv({ cls: 'eoe-row-icon' });
		setIcon(icon, row.entry.kind === 'folder' ? ICON_FOLDER : ICON_FILE);

		rowEl.createSpan({ cls: 'eoe-row-name', text: row.entry.name });
	}

	/** `canSave` is false when every entry is unorderable — nothing dragged into an order, so nothing to offer saving. */
	private renderFooter(canSave: boolean): void {
		const footer = this.contentEl.createDiv({ cls: 'eoe-footer' });

		new ButtonComponent(footer).setButtonText('Cancel').onClick(() => this.close());

		if (!canSave) return;

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
			const hideNames = this.settings.hideSortspec ? [SORTSPEC_FILENAME] : [];
			result = await updateFolderSpec(this.app, this.folder, (spec) =>
				upsertFolderOrder(spec, targetKeyFor(this.folder), orderedEntries, hideNames),
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
			message += ` ${describeSkipped(skipped)}`;
		}
		new Notice(message);

		if (!this.settings.autoRefresh) {
			new Notice('Automatic refresh is off. Run the custom file explorer sorting plugin\'s refresh command to see the change.');
			return;
		}

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

/**
 * Groups skipped entries by reason rather than repeating the explanation
 * once per name — with several items sharing a cause, the per-name form
 * grew into a wall of identical clauses.
 *
 * Says where they end up, not just that they were skipped: they are still
 * in the folder, they just cannot be given a position, so custom-sort's
 * default puts them after everything that was listed.
 */
function describeSkipped(skipped: readonly { name: string; reason: UnencodableReason }[]): string {
	const byReason = new Map<UnencodableReason, string[]>();
	for (const { name, reason } of skipped) {
		const names = byReason.get(reason);
		if (names === undefined) {
			byReason.set(reason, [name]);
		} else {
			names.push(name);
		}
	}

	const clauses = [...byReason].map(
		([reason, names]) => `${names.map((n) => `"${n}"`).join(', ')} — ${describeUnencodableCause(reason)}`,
	);
	const count = skipped.length === 1 ? '1 item' : `${skipped.length} items`;
	return `${count} could not be given a position and will sort last: ${clauses.join('; ')}.`;
}

/**
 * The same causes as `describeUnencodableReason`, phrased as noun phrases so
 * they read correctly after a list of several names. The tooltip form is a
 * verb phrase because it describes exactly one row.
 *
 * Note `backslash` is close to unreachable in practice: Obsidian does not
 * index files whose name contains a backslash, so such a file never reaches
 * `folder.children` and never gets this far. Kept because the encoder must
 * still refuse the name if one ever does.
 */
function describeUnencodableCause(reason: UnencodableReason): string {
	switch (reason) {
		case 'empty':
			return 'an empty name';
		case 'whitespace':
			return 'leading or trailing whitespace';
		case 'newline':
			return 'a line break';
		case 'wildcard':
			return "the wildcard sequence '...'";
		case 'backslash':
			return 'a backslash';
		case 'reserved-token':
			return 'a leading symbol reserved by the sorting syntax';
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
		case 'reserved-token':
			return 'starts with a symbol sequence reserved by the sorting syntax';
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
