import { App, ButtonComponent, Modal, Notice, Platform, setIcon, setTooltip, TFolder } from 'obsidian';
import Sortable from 'sortablejs';
import { FrontMatterError, type FrontMatterErrorCode } from './frontmatter';
import { targetIndexFor, type RowMove } from './rowMove';
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
const ICON_MOVE_TOP = 'lucide-chevrons-up';
const ICON_MOVE_BOTTOM = 'lucide-chevrons-down';

/**
 * Renders one of this modal's shortcuts the way the running platform writes
 * it: macOS uses modifier symbols, matching how Obsidian's own hotkey
 * settings display them, and every other platform spells the modifiers out.
 * Arrow glyphs are used everywhere — shorter than "Up"/"Down" and they read
 * the same on every platform.
 */
const shortcut = (withShift: boolean, arrow: '↑' | '↓'): string =>
	Platform.isMacOS ? `⌥${withShift ? '⇧' : ''}${arrow}` : `Alt+${withShift ? 'Shift+' : ''}${arrow}`;

// Shown as both the button tooltip and its `aria-label`, so a keyboard-only
// or screen-reader user can discover the shortcut without ever hovering.
//
// On mobile the shortcut is left out rather than named: there is no modifier
// key to press, so advertising one would describe something the reader cannot
// do. The buttons themselves are the mobile route, which is also why they are
// rendered unconditionally instead of on hover.
const MOVE_TOP_LABEL = Platform.isMobile ? 'Move to top' : `Move to top (${shortcut(true, '↑')})`;
const MOVE_BOTTOM_LABEL = Platform.isMobile ? 'Move to bottom' : `Move to bottom (${shortcut(true, '↓')})`;

/**
 * A run of hint text, or one shortcut to render as a key cap. Split this way
 * because the shortcuts have to be visually bounded: written inline as bare
 * glyphs, `⌥↑/⌥↓` reads as one long symbol rather than two alternatives —
 * adding spaces only softens that, whereas a box around each one states where
 * one key combination ends and the next begins.
 */
type HintPart = { readonly text: string } | { readonly key: string };

/**
 * One entry per rendered line. Lines are separate array entries rather than
 * one string with a newline in it because a line break inside text content
 * collapses to a space in HTML — the split has to exist in the markup, so it
 * has to exist here too.
 *
 * Mobile gets a single line with no key caps: with no modifier key to press
 * there is no shortcut to name.
 */
const HINT_LINES: readonly (readonly HintPart[])[] = Platform.isMobile
	? [[{ text: 'Long-press the handle to drag a row, or use the buttons to send it to the top or bottom.' }]]
	: [
			[
				{ text: 'Drag by the handle, or click a row and press ' },
				{ key: shortcut(false, '↑') },
				{ text: ' or ' },
				{ key: shortcut(false, '↓') },
				{ text: ' to move it.' },
			],
			[
				{ key: shortcut(true, '↑') },
				{ text: ' or ' },
				{ key: shortcut(true, '↓') },
				{ text: ' sends it to the top or bottom.' },
			],
		];

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
	 * The move-to-top/move-to-bottom buttons for each sortable row, keyed the
	 * same way `entryByRowEl` is. Needed so `refreshRowActionsDisabled` can
	 * flip `.disabled` on exactly the two buttons that belong to the row now
	 * at each end, without re-querying the DOM for them on every move.
	 */
	private readonly rowActionsByRowEl = new Map<HTMLElement, { readonly top: HTMLButtonElement; readonly bottom: HTMLButtonElement }>();
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
			// First/last are now known (they're just the first/last rows just
			// rendered) — set their buttons' disabled state before the modal is
			// ever shown, rather than leaving both enabled until some later move
			// happens to refresh them.
			this.refreshRowActionsDisabled();

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
				// A drag can carry a row to or away from either end of the list
				// just as much as a button click or keyboard move can — without
				// this, dropping the last row at the top would leave the old
				// first row's "move to top" button stuck enabled and the dropped
				// row's own buttons stuck disabled until some unrelated move
				// happened to refresh them.
				onEnd: () => this.refreshRowActionsDisabled(),
			});

			// The shortcuts are otherwise undiscoverable: the buttons name them
			// in their tooltips, but only on hover, and a keyboard user is the
			// one person who never hovers. Placed after the list so it reads as
			// a footnote to it rather than competing with the rows themselves.
			const hint = this.contentEl.createDiv({ cls: 'eoe-hint' });
			for (const parts of HINT_LINES) {
				const lineEl = hint.createDiv({ cls: 'eoe-hint-line' });
				for (const part of parts) {
					if ('key' in part) {
						lineEl.createEl('kbd', { cls: 'eoe-kbd', text: part.key });
					} else {
						lineEl.appendText(part.text);
					}
				}
			}
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
		this.rowActionsByRowEl.clear();
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

		// Same condition as the grip above, for the same reason: an
		// unorderable row has no position to alter, so it gets neither a way
		// to drag it nor a way to nudge it — offering either would be a
		// control that visibly does nothing.
		if (row.disabledReason === undefined) {
			this.renderRowActions(rowEl);
			rowEl.setAttribute('tabindex', '0');
			rowEl.addEventListener('keydown', (evt) => this.onRowKeyDown(evt, rowEl));

			// Focus the row explicitly rather than relying on a click landing
			// on a `tabindex` element focusing it by default. SortableJS runs
			// its own pointer handling over this same container in fallback
			// mode (see `forceFallback` in `onOpen`), and anything that calls
			// preventDefault on the pointer-down that starts a gesture also
			// cancels the default focus — leaving the keyboard shortcuts with
			// nothing focused to act on, which is exactly how they were first
			// reported as "not working". Focusing here does not interfere with
			// a drag: Sortable tracks the gesture from its own listeners, not
			// from what happens to hold focus.
			rowEl.addEventListener('mousedown', (evt) => {
				// A click on one of the action buttons must leave focus on that
				// button, so it can be pressed repeatedly with Enter.
				if (evt.target instanceof HTMLElement && evt.target.closest('.eoe-row-actions') !== null) return;
				rowEl.focus();
			});
		}
	}

	/**
	 * The move-to-top/move-to-bottom button pair appended to a sortable row.
	 * Rendered unconditionally rather than only on `:hover`: this modal's
	 * drag path already has to support touch via SortableJS's fallback mode
	 * (see the `forceFallback` comment in `onOpen`), and touch has no hover
	 * state at all — a hover-only affordance would simply not exist there.
	 */
	private renderRowActions(rowEl: HTMLElement): void {
		const actions = rowEl.createDiv({ cls: 'eoe-row-actions' });

		const top = actions.createEl('button', { cls: 'clickable-icon eoe-row-action', attr: { type: 'button' } });
		setIcon(top, ICON_MOVE_TOP);
		setTooltip(top, MOVE_TOP_LABEL);
		top.setAttribute('aria-label', MOVE_TOP_LABEL); // setTooltip only shows a hover hint; it does not also give the button an accessible name
		top.addEventListener('click', () => this.moveRow(rowEl, 'top'));

		const bottom = actions.createEl('button', { cls: 'clickable-icon eoe-row-action', attr: { type: 'button' } });
		setIcon(bottom, ICON_MOVE_BOTTOM);
		setTooltip(bottom, MOVE_BOTTOM_LABEL);
		bottom.setAttribute('aria-label', MOVE_BOTTOM_LABEL);
		bottom.addEventListener('click', () => this.moveRow(rowEl, 'bottom'));

		this.rowActionsByRowEl.set(rowEl, { top, bottom });
	}

	/**
	 * `ArrowUp`/`ArrowDown` alone move *focus* to the neighboring row —
	 * ordinary list-navigation behavior. Repurposing the bare arrow keys to
	 * move the row itself would leave a keyboard user with no way to simply
	 * browse a long list (`bigfolder` has 62 rows) without also reordering
	 * it on every keystroke. `Alt+Arrow` nudges the row one step;
	 * `Alt+Shift+Arrow` jumps it to the relevant edge, mirroring the button
	 * pair. Every other key (including plain `Shift+Arrow`, which has no
	 * assigned meaning here) is left untouched.
	 */
	private onRowKeyDown(evt: KeyboardEvent, rowEl: HTMLElement): void {
		if (evt.key !== 'ArrowUp' && evt.key !== 'ArrowDown') return;
		// Every branch below consumes this keypress; without preventDefault
		// the modal's content area scrolls out from under the row list as a
		// side effect of the arrow key, on top of whatever we do here.
		evt.preventDefault();

		const isUp = evt.key === 'ArrowUp';
		if (evt.altKey && evt.shiftKey) {
			this.moveRow(rowEl, isUp ? 'top' : 'bottom');
		} else if (evt.altKey) {
			this.moveRow(rowEl, isUp ? 'up' : 'down');
		} else {
			this.focusAdjacentRow(rowEl, isUp ? -1 : 1);
		}
	}

	/** Moves focus by one row in `delta`'s direction; a no-op at either end of the list, where there is no neighbor to focus. */
	private focusAdjacentRow(rowEl: HTMLElement, delta: -1 | 1): void {
		const rows = this.sortableRows();
		const index = rows.indexOf(rowEl);
		if (index === -1) return;
		rows[index + delta]?.focus();
	}

	/**
	 * Moves `rowEl` to the position `move` implies, then restores focus and
	 * scroll position and refreshes the boundary buttons. The one place both
	 * the button clicks and the keyboard shortcuts end up, so the two
	 * trigger paths can never drift into moving things differently.
	 */
	private moveRow(rowEl: HTMLElement, move: RowMove): void {
		const listEl = this.listEl;
		if (listEl === null) return;

		const rows = this.sortableRows();
		const index = rows.indexOf(rowEl);
		const target = targetIndexFor(move, index, rows.length);
		if (target === null) return; // already at the edge `move` would go to (or rowEl isn't in the list at all) — nothing to do

		// `listEl.children[target]` is read only *after* `remove()`. `target`
		// is a position among the *remaining* `rows.length - 1` elements once
		// `rowEl` is out, so reading it beforehand would be off by one for
		// any move that crosses `rowEl`'s old slot. Doing it in this order is
		// what lets the same two lines handle all four move kinds with no
		// per-direction branch — see rowMove.ts's contract doc for the four
		// worked examples this is checked against (e.g. index 3 of 5 moving
		// 'up' needs target 2; index 0 of 5 moving 'bottom' needs target 4).
		rowEl.remove();
		listEl.insertBefore(rowEl, listEl.children[target] ?? null);

		// remove() unconditionally blurs the focused element. Without
		// restoring focus here, the first Alt+ArrowDown a keyboard user
		// presses would silently drop focus to <body>, and every further
		// arrow key would do nothing — nothing would be left listening.
		rowEl.focus();
		// The list is capped at 60vh and scrolls (`bigfolder` has 62 rows), so
		// a top/bottom jump can easily carry the row outside the visible slice.
		rowEl.scrollIntoView({ block: 'nearest' });

		this.refreshRowActionsDisabled();
	}

	/**
	 * Disables each row's "move to top"/"move to bottom" button exactly when
	 * that row is already at the relevant end of the list; every other
	 * button is enabled. Recomputed from live DOM order — on every move,
	 * not incrementally — because a SortableJS drag can change which row is
	 * first or last without going through `moveRow` at all, so there is no
	 * single choke point to update the two affected rows' buttons in place
	 * even if that looked cheaper.
	 */
	private refreshRowActionsDisabled(): void {
		const rows = this.sortableRows();
		rows.forEach((rowEl, index) => {
			const actions = this.rowActionsByRowEl.get(rowEl);
			if (actions === undefined) return; // every orderable row gets an entry in renderRowActions; nothing to do if one is ever missing
			actions.top.disabled = index === 0;
			actions.bottom.disabled = index === rows.length - 1;
		});
	}

	/**
	 * `listEl.children` narrowed to `HTMLElement[]`. Every row is built with
	 * `createDiv`, so nothing else can ever be a child of `listEl` — the
	 * `instanceOf` check exists only because `HTMLCollection` is typed
	 * element-agnostic (`Element`, not `HTMLElement`), not because a
	 * non-`HTMLElement` child is actually expected. Shared by every method
	 * above that needs "the rows, in on-screen order" so the DOM-reading
	 * logic exists in exactly one place.
	 */
	private sortableRows(): HTMLElement[] {
		const listEl = this.listEl;
		if (listEl === null) return [];
		return Array.from(listEl.children).filter((child): child is HTMLElement => child.instanceOf(HTMLElement));
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
		case 'group-attribute':
			return 'a leading phrase the sorting syntax treats as a matching rule';
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
		case 'group-attribute':
			return 'starts with a phrase the sorting syntax treats as a matching rule instead of a name';
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
