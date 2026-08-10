import { App, ButtonComponent, Menu, Modal, Notice, normalizePath, Platform, setIcon, setTooltip, TFolder } from 'obsidian';
import Sortable from 'sortablejs';
import { SORT_CHOICES, sortEntries, timestampFor, type SortChoice, type SortableEntry, type SortKey } from './entrySort';
import { explorerOrderNames } from './explorerSort';
import { folderIndexKey, type IndexFileStore } from './indexFile';
import { reportApplied, repairPointer, unusableClause } from './notices';
import { breadcrumbSegments, folderShortName, isSameOrder, navigationLabel, type BreadcrumbSegment } from './navigation';
import { mergeOrder, setOrder } from './orderIndex';
import { targetIndexFor, type RowMove } from './rowMove';
import type { ExplorerOrderEditorSettings } from './settings';
import { entriesFor } from './folderEntries';
import { displayLabel } from './types';

const ICON_FOLDER = 'lucide-folder';
const ICON_FILE = 'lucide-file-text';
const ICON_GRIP = 'lucide-grip-vertical';
const ICON_MOVE_TOP = 'lucide-chevrons-up';
const ICON_MOVE_BOTTOM = 'lucide-chevrons-down';
/**
 * The per-row "enter subfolder" control. Circled rather than the bare
 * `lucide-chevron-right` it used to be, and that is what lets the row's
 * action group drop its separator line.
 *
 * The move buttons are `chevrons-up`/`chevrons-down`; a bare `chevron-right`
 * beside them is the same shape family in a third direction, which is why
 * "navigate into this folder" and "move this row" needed a hairline rule
 * between them to stay distinguishable at all. A chevron inside a circle is
 * a different shape at a glance, so the distinction is carried by the icons
 * themselves and the rule has nothing left to do.
 *
 * Verified present in Obsidian's bundled icon set rather than assumed — a
 * wrong id is accepted by `IconName` (a bare `string` alias), passes tsc and
 * eslint, and then silently renders nothing.
 */
const ICON_ENTER = 'lucide-circle-chevron-right';

/**
 * How many breadcrumb positions (folders plus, when truncated, the ellipsis
 * that stands in for the rest) the trail ever renders. The budget this
 * bounds is no longer horizontal width but *rendered lines*: each
 * position gets its own row now, and a line is cheap in a way a share of one
 * shared line's width never was — that's the whole reason for going
 * vertical. 5 keeps the vault root, two real ancestors and the current
 * folder all visible at once while still bounding how far the trail can
 * push the row list down.
 */
const MAX_VISIBLE_CRUMBS = 5;

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
 * kind, plus the timestamps `entrySort.ts`'s "sort by" needs) that gets
 * handed to `orderIndex.ts` on save — the save path only ever reads `.name`
 * off it, so carrying the wider `SortableEntry` here costs it nothing.
 */
interface OrderRow {
	readonly entry: SortableEntry;
}

/**
 * What `save()` actually did, so callers (the footer Save button, and
 * `navigateTo`'s save-before-leaving) can each decide for themselves what to
 * do next instead of `save()` closing the modal unilaterally — navigating
 * needs to keep the modal open on a successful save (to then switch levels),
 * where the footer button needs to close it.
 */
type SaveOutcome = 'saved' | 'unchanged' | 'blocked' | 'failed';

export class OrderModal extends Modal {
	private listEl: HTMLElement | null = null;
	private sortable: Sortable | null = null;
	private readonly entryByRowEl = new Map<HTMLElement, SortableEntry>();
	/**
	 * The move-to-top/move-to-bottom buttons for each sortable row, keyed the
	 * same way `entryByRowEl` is. Needed so `refreshRowActionsDisabled` can
	 * flip `.disabled` on exactly the two buttons that belong to the row now
	 * at each end, without re-querying the DOM for them on every move.
	 */
	private readonly rowActionsByRowEl = new Map<HTMLElement, { readonly top: HTMLButtonElement; readonly bottom: HTMLButtonElement }>();
	/**
	 * The date element for each row, keyed the same way `entryByRowEl` is.
	 * Created empty with every row and filled in (or emptied again) by
	 * `applySortChoice` — rather than being created and destroyed as sorts
	 * come and go, so that showing a date never changes the row's structure,
	 * only its text.
	 */
	private readonly dateByRowEl = new Map<HTMLElement, HTMLElement>();
	/**
	 * This level's child folders, keyed by name, rebuilt at the top of every
	 * `render()`. Folder names are unique within a folder, so name is an
	 * exact key. Used only to decide which orderable folder rows get an
	 * "enter" control (`renderRow`) — a folder that no longer exists (deleted
	 * between renders) simply has no entry here and gets no button.
	 */
	private readonly childFolderByName = new Map<string, TFolder>();
	/**
	 * Every navigation control on screen (each clickable breadcrumb crumb and
	 * each row's "enter" button), in creation order. `targetLabel` is the
	 * short name `navigationLabel` needs to phrase that control's tooltip;
	 * `refreshNavigationLabels` walks this list whenever dirtiness might have
	 * changed, so a control's label never goes stale.
	 */
	private navControls: { readonly button: HTMLElement; readonly targetLabel: string }[] = [];
	private closed = false;
	/**
	 * Guards both the footer Save button and every navigation control, so a
	 * click on either cannot land while a save or a level switch is already
	 * in flight. The footer button's own `setDisabled` toggle is the visual
	 * half of the same guard; the navigation controls have no equivalent
	 * visual state, only this logical one.
	 */
	private busy = false;
	/**
	 * Set by the most recent successful (changed) save, held until the modal
	 * closes and `flushRefresh` turns it into one file-explorer redraw for
	 * the whole session.
	 *
	 * The one piece of state `resetContent` must *not* clear: everything else
	 * there belongs to a single level, whereas this deliberately survives
	 * every level switch — that is the entire mechanism. Since 1.0 there is
	 * no metadata cache to wait for (the index is ours, already updated in
	 * memory the moment `save()` returns), so this is a plain boolean rather
	 * than an armed promise.
	 */
	private pendingRefresh = false;
	/**
	 * What `collectOrderedEntries()` returned right after this level's
	 * `render()` finished — i.e. exactly what a save would write at that
	 * moment. `isDirty` compares the live order against this, not against
	 * "what's stored right now": a folder with no stored order that the user
	 * only looked at (drilled through on the way to a subfolder, then came
	 * back up) must not get one written just because navigating triggers a
	 * save-if-dirty. Reset to `[]` by `resetContent` and set again at the end
	 * of every `render()`.
	 */
	private initialOrder: readonly SortableEntry[] = [];
	private folder: TFolder;

	constructor(
		app: App,
		folder: TFolder,
		private readonly settings: ExplorerOrderEditorSettings,
		private readonly store: IndexFileStore,
	) {
		super(app);
		this.folder = folder;
	}

	/**
	 * The class is what lets `styles.css` reach `.modal-content` without
	 * restyling every other modal in the app — Obsidian gives that element no
	 * hook of its own, and this dialog needs it to be a flex column that can
	 * shrink (see the `.eoe-modal .modal-content` rule for the full reason).
	 * Set on `modalEl` rather than `contentEl` because the rule has to select
	 * `.modal-content` as a descendant.
	 */
	onOpen(): void {
		this.modalEl.addClass('eoe-modal');
		void this.render();
	}

	onClose(): void {
		this.closed = true;
		// Read before resetContent, which deliberately leaves this field alone
		// (it has to outlive every level switch) — this is the only place it
		// is consumed and cleared.
		const needsRefresh = this.pendingRefresh;
		this.pendingRefresh = false;
		this.resetContent();
		if (needsRefresh) this.flushRefresh();
	}

	/**
	 * Renders the current `this.folder` from scratch. Navigating to a new
	 * level is `resetContent()` followed by another call to this — there is
	 * no cross-level screen state kept around, only whatever the fresh read
	 * produces, so a level revisited after saving always shows exactly what
	 * was just written.
	 */
	private async render(): Promise<void> {
		// Sentence case, and deliberately the same wording as the file-menu item
		// that opens this modal. The path itself now lives in the breadcrumb
		// trail below, which is why this no longer needs to vary per folder.
		this.setTitle('Set explorer order');

		this.childFolderByName.clear();
		for (const child of this.folder.children) {
			if (child instanceof TFolder) {
				this.childFolderByName.set(child.name, child);
			}
		}

		// The breadcrumb trail, rendered before anything else below —
		// including the `siblings.length <= 1` early return — so that even
		// an empty subfolder still has a way back out, rather than being a
		// dead end only reachable by navigating into it in the first place.
		const breadcrumbTail = this.renderBreadcrumbs();

		const siblings = entriesFor(this.folder, normalizePath(this.settings.indexPath));
		const soleEntry = siblings.length === 1 ? siblings[0] : undefined;
		if (siblings.length === 0 || soleEntry !== undefined) {
			if (soleEntry === undefined) {
				// Nothing at all to show, so the message *is* the screen and
				// gets the centred empty-state treatment.
				this.contentEl.createDiv({ cls: 'eoe-empty', text: 'This folder has nothing to order.' });
			} else {
				// The single item is still rendered, even though its position
				// can never change. Saying "nothing to order" and showing no
				// rows was a dead end: when that one item is a folder, its
				// *contents* may well need ordering, and with nothing on
				// screen there was no way to reach them — a chain of
				// single-child folders simply could not be walked through from
				// in here. The row is not sortable (there is nothing to move
				// it past) but it does carry the "enter" control, which is the
				// whole point of showing it.
				const listEl = this.contentEl.createDiv({ cls: 'eoe-static-list' });
				this.renderRow(listEl, { entry: soleEntry }, false);

				// Below the row and in `.eoe-hint`, not centred in
				// `.eoe-empty`: once there is a row on screen this sentence is
				// a footnote about it, the same role the keyboard-shortcut
				// hint plays under the sortable list. The centred empty-state
				// treatment only reads correctly when the message is the only
				// thing there.
				this.contentEl.createDiv({ cls: 'eoe-hint', text: 'Only one item here, so there is nothing to reorder.' });
			}

			// Reachable now that a user can navigate into such a folder rather
			// than only opening one directly — it needs a Cancel button (and,
			// via the breadcrumb rendered above, a way back up) same as every
			// other screen. Never a Save button: with no order to express,
			// saving would write a no-op entry to the index.
			this.renderFooter(false);
			this.finishRender();
			return;
		}

		const orderedEntries = this.orderedEntriesFor(siblings);

		const rows: OrderRow[] = orderedEntries.map((entry) => ({ entry }));

		if (rows.length > 0) {
			// Reached only when this folder has at least two entries — the
			// zero-and-one cases returned above — so there is always something
			// a sort could actually reorder. Same reasoning as why the
			// move-to-top/bottom buttons and the grip are gated on `sortable`
			// in `renderRow` below: a control that provably cannot change
			// anything is not offered at all.
			if (breadcrumbTail !== null) this.renderSortByButton(breadcrumbTail);

			const listEl = this.contentEl.createDiv({ cls: 'eoe-list' });
			this.listEl = listEl;

			for (const row of rows) {
				this.renderRow(listEl, row, true);
			}

			this.sortable = new Sortable(listEl, {
				// Obsidian mobile is a WebView where native HTML5 drag events are
				// unreliable, so we bypass them entirely — desktop and mobile
				// both go through the same fallback path.
				forceFallback: true,
				// Only the grip element starts a drag; the rest of the row (and
				// the modal itself) stays scrollable, including by touch. This
				// is also why the per-row "enter" button needs no `filter`
				// option to keep it from starting a drag — it isn't part of
				// `.eoe-row-handle` either.
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
				// first row's "move to top" button stuck enabled, the dropped
				// row's own buttons stuck disabled, and every navigation
				// control's label stuck describing the pre-drag dirtiness, all
				// until some unrelated change happened to refresh them.
				onEnd: () => this.afterOrderChanged(),
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

		// Nothing to drag into an order means nothing to save.
		this.renderFooter(rows.length > 0);
		this.finishRender();
	}

	/**
	 * The rows this level's `render()` should open with, in the order the
	 * file explorer is actually showing right now — so the dialog agrees with
	 * the tree next to it, including for a folder whose sort setting isn't
	 * A→Z by name, which `fallbackEntryOrder` can only ever guess at.
	 *
	 * `explorerOrderNames` goes through our own `getSortedFolderItems` patch,
	 * so its answer already *is* either this folder's saved order or the
	 * explorer's own current sort — there is nothing left for this method to
	 * merge against a separately-read `store.get()`, unlike the fallback path
	 * below. The index note is never among `siblings` (`entriesFor` excludes
	 * it), so any name `explorerOrderNames` returns that isn't in
	 * `siblingByName` — the index note itself, or anything else this dialog
	 * doesn't know how to order — is simply skipped rather than turned into a
	 * row.
	 *
	 * Falls back to `mergeOrder(store.get(...), siblings)` — today's
	 * behaviour — whenever the explorer can't be consulted (`null`): a closed
	 * file explorer, or anything unexpected about its internals, degrades to
	 * the old approximation rather than leaving the dialog with no order at
	 * all.
	 */
	private orderedEntriesFor(siblings: readonly SortableEntry[]): SortableEntry[] {
		const siblingByName = new Map(siblings.map((entry) => [entry.name, entry]));
		const explorerNames = explorerOrderNames(this.app, this.folder);

		if (explorerNames === null) {
			const stored = this.store.get(folderIndexKey(this.folder));
			return mergeOrder(
				stored,
				siblings.map((entry) => entry.name),
			)
				.map((name) => siblingByName.get(name))
				.filter((entry): entry is SortableEntry => entry !== undefined);
		}

		const seen = new Set<string>();
		const ordered: SortableEntry[] = [];
		for (const name of explorerNames) {
			const entry = siblingByName.get(name);
			// Not found for the index note (excluded from `siblings` on
			// purpose — see the doc comment above) or anything else this
			// dialog doesn't recognize as an orderable sibling.
			if (entry === undefined) continue;
			if (seen.has(name)) continue; // defensive: siblings are already unique by name
			seen.add(name);
			ordered.push(entry);
		}
		// Anything entriesFor knows about that the explorer didn't return —
		// should not happen once the explorer's own patch is installed, but a
		// stale row must still get a position rather than vanish from the
		// dialog entirely.
		for (const entry of siblings) {
			if (seen.has(entry.name)) continue;
			ordered.push(entry);
		}
		return ordered;
	}

	/**
	 * The last thing every `render()` exit path does, and the order of these
	 * two lines is the point: the baseline `isDirty()` measures against has
	 * to exist before anything asks, and `afterOrderChanged` asks
	 * immediately. Run the other way round, the live rows get compared
	 * against the empty list `resetContent` left behind, come out unequal,
	 * and every navigation control paints "Save and open …" onto a screen
	 * nobody has touched yet. What made that worth guarding against rather
	 * than shrugging at is that the *behaviour* was right either way —
	 * `navigateTo` reads `isDirty()` later, once this has run, so the click
	 * did the right thing while the label said otherwise. A control that
	 * announces what it does is this feature's only promise.
	 *
	 * Running on every exit path, not just the one that renders a sortable
	 * list, is also what gives the breadcrumb a label on the empty-folder and
	 * single-item screens — the screens where finding the way back out
	 * matters most. `refreshRowActionsDisabled` is a no-op there (no rows),
	 * which is why this can be one unconditional call.
	 */
	private finishRender(): void {
		this.initialOrder = this.collectOrderedEntries();
		this.afterOrderChanged();
	}

	/**
	 * Tears down everything the current render put on screen, without
	 * touching `this.closed` — the one difference from `onClose`, which calls
	 * this and then also sets that flag. Kept as a single function so the two
	 * teardown paths (closing the modal outright vs. clearing the screen to
	 * draw a new level) can never drift apart.
	 */
	private resetContent(): void {
		this.sortable?.destroy();
		this.sortable = null;
		this.listEl = null;
		this.entryByRowEl.clear();
		this.rowActionsByRowEl.clear();
		this.dateByRowEl.clear();
		this.childFolderByName.clear();
		this.navControls = [];
		this.initialOrder = [];
		this.contentEl.empty();
	}

	/**
	 * True when the on-screen order has changed since this level's `render()`
	 * finished. This has to mean "the user changed something", not "the
	 * index would change if saved now" — a folder with no stored order that
	 * the user merely looked at while passing through must not get one
	 * written just because navigating away triggers a save-if-dirty.
	 * Comparing against `initialOrder` (fixed at render time) is what keeps
	 * that distinction.
	 */
	private isDirty(): boolean {
		return !isSameOrder(this.collectOrderedEntries(), this.initialOrder);
	}

	/**
	 * Everything that needs to happen after the on-screen order might have
	 * changed: which move-to-top/bottom buttons are disabled, and every
	 * navigation control's label, since `navigationLabel` depends on
	 * `isDirty()` and dirtiness just changed underneath it.
	 */
	private afterOrderChanged(): void {
		this.refreshRowActionsDisabled();
		this.refreshNavigationLabels();
	}

	/**
	 * Navigates the whole modal to `target`: saves first if the current level
	 * has unsaved changes, then tears down and re-renders at the new level.
	 * Guarded by `busy` so a click here (or on the footer Save button) cannot
	 * land while a previous navigation or save is still in flight.
	 */
	private async navigateTo(target: TFolder): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		try {
			// A folder can be deleted between render and click. Obsidian mutates
			// a TFolder in place on rename (path and name both), so an identity
			// match here still succeeds for a renamed folder — which is what we
			// want; only a folder that is actually gone fails it.
			if (this.app.vault.getFolderByPath(target.path) !== target) {
				// Reported, but deliberately *not* followed by a redraw of this
				// level: these rows may hold an arrangement the user has
				// dragged and not yet saved, and rebuilding them from disk
				// would throw that away to fix nothing — what changed was the
				// target, not here. The now-dead row stays on screen, which is
				// consistent with the rest of the dialog: it never tracks vault
				// changes live at any other point either.
				new Notice('That folder is no longer there.');
				return;
			}
			if (this.isDirty()) {
				const outcome = await this.save();
				// blocked / failed: notices are already up, and entering now
				// would discard what the user arranged. Stay on this level.
				if (outcome === 'blocked' || outcome === 'failed') return;
				// `save()` is still async even though nothing inside it takes
				// long, which is enough for the user to have closed the dialog
				// underneath us while it was in flight. Calling render() into a
				// closed modal's detached contentEl would rebuild a whole level
				// nobody can see, so this has to be checked before doing that.
				if (this.closed) return;
			}
			this.folder = target;
			this.resetContent();
			await this.render();
		} finally {
			this.busy = false;
		}
	}

	/** Vault root first, `this.folder` last. */
	private folderChain(): TFolder[] {
		const chain: TFolder[] = [];
		let current: TFolder | null = this.folder;
		while (current !== null) {
			chain.unshift(current);
			current = current.parent;
		}
		return chain;
	}

	/**
	 * The breadcrumb trail, a stepped vertical hierarchy replacing the
	 * single horizontal line it grew out of: one folder per rendered line, each
	 * indented one step past the one above, so every level gets essentially
	 * the full modal width instead of several names fighting over one line —
	 * the horizontal version had no good answer for a long ancestor sitting
	 * next to a long current folder. Rendered unconditionally, including for
	 * the vault root itself — a one-line trail is still "you are here".
	 */
	/**
	 * Returns the trail's last row — always the current folder's — so the
	 * caller can hang the "sort by" control off its right-hand end (see
	 * `renderSortByButton`). `null` only if there were no segments at all,
	 * which `breadcrumbSegments` cannot produce for a chain that always
	 * contains at least the current folder; handled rather than asserted.
	 */
	private renderBreadcrumbs(): HTMLElement | null {
		const container = this.contentEl.createDiv({ cls: 'eoe-breadcrumb' });
		const chain = this.folderChain();
		const segments = breadcrumbSegments(chain.length, MAX_VISIBLE_CRUMBS);
		let tail: HTMLElement | null = null;

		segments.forEach((segment, position) => {
			// `position` is the *rendered* position, not the folder's real depth
			// in the vault — after a collapse the fourth line is still indented
			// four steps, not six. That's what keeps the indent bounded
			// regardless of how deep the actual folder nesting goes; it's also
			// why the depth classes below are a small fixed set rather than one
			// per possible vault depth.
			const row = container.createDiv({ cls: ['eoe-breadcrumb-row', `eoe-breadcrumb-depth-${position}`] });
			if (position > 0) {
				row.createSpan({ cls: 'eoe-breadcrumb-tee', text: '└', attr: { 'aria-hidden': 'true' } });
			}
			this.renderBreadcrumbSegment(row, chain, segment);
			tail = row;
		});

		return tail;
	}

	/**
	 * One position in the trail. Split out of `renderBreadcrumbs` because each
	 * of the three kinds — a clickable ancestor, the collapsed ellipsis, and
	 * the current folder — has its own element type and click behavior, and
	 * inlining all three into one loop body was harder to follow than naming
	 * them.
	 */
	private renderBreadcrumbSegment(row: HTMLElement, chain: TFolder[], segment: BreadcrumbSegment): void {
		if (segment.kind === 'ellipsis') {
			const ellipsis = row.createSpan({ cls: 'eoe-breadcrumb-ellipsis', text: '…' });
			const vaultName = this.app.vault.getName();
			const hiddenNames: string[] = [];
			for (const index of segment.hiddenIndices) {
				const hidden = chain[index];
				if (hidden !== undefined) hiddenNames.push(folderShortName(hidden.name, hidden.isRoot(), vaultName));
			}
			setTooltip(ellipsis, hiddenNames.join(' › '));
			return;
		}

		const f = chain[segment.index];
		if (f === undefined) return; // chain and segments are built from the same length; defensive only
		const targetLabel = folderShortName(f.name, f.isRoot(), this.app.vault.getName());
		const isCurrent = segment.index === chain.length - 1;

		if (isCurrent) {
			// Not a button, not in `navControls`: navigating to where you
			// already are would re-read from disk and silently discard
			// unsaved rows.
			row.createSpan({ cls: 'eoe-breadcrumb-current', text: targetLabel });
			return;
		}

		// The label lives in its own inner span rather than as the button's own
		// text — see the `.eoe-breadcrumb-crumb` / `.eoe-breadcrumb-label` rules
		// in styles.css for why a <button> can't truncate its own text with an
		// ellipsis no matter what's set on the button itself.
		const button = row.createEl('button', { cls: 'eoe-breadcrumb-crumb', attr: { type: 'button' } });
		button.createSpan({ cls: 'eoe-breadcrumb-label', text: targetLabel });
		button.addEventListener('click', () => void this.navigateTo(f));
		this.navControls.push({ button, targetLabel });
	}

	/**
	 * Reads the on-screen order back into `SortableEntry[]`: the sortable rows
	 * in their current on-screen order, after any dragging.
	 */
	private collectOrderedEntries(): SortableEntry[] {
		const entries: SortableEntry[] = [];
		const listEl = this.listEl;
		if (listEl) {
			for (const child of Array.from(listEl.children)) {
				if (!child.instanceOf(HTMLElement)) continue;
				const entry = this.entryByRowEl.get(child);
				if (entry) entries.push(entry);
			}
		}
		return entries;
	}

	/**
	 * The "sort by" control, hung off the right-hand end of the breadcrumb
	 * trail's last row — the current folder's row, which is exactly what the
	 * sort acts on.
	 *
	 * It had its own toolbar strip above the list at first, and that strip
	 * cost about 33px of a dialog whose height is its scarcest resource: its
	 * own margin, the button, and a gap under it, all to hold one control
	 * while the breadcrumb's last line sat half empty right above. Reusing
	 * that line spends no vertical space at all — the row is already as tall
	 * as this button, so it does not even grow.
	 *
	 * Only ever called from the branch that renders the sortable list
	 * (`rows.length > 0` in `render()`, reached only when the folder holds at
	 * least two entries) — a folder with nothing to reorder gets no control at
	 * all rather than one whose menu would do nothing.
	 *
	 * The control is a button that opens a `Menu`, not a `<select>`, because
	 * a choice here is a one-shot action — "rearrange the rows right now" —
	 * not a persistent piece of state describing the current order. A
	 * `<select>` would keep showing the last choice picked long after it
	 * stopped being true: the moment a row is dragged, or a *different* sort
	 * choice is applied and then a row moved, the dropdown would still claim
	 * the list is sorted by whatever it last displayed. A button has no such
	 * memory to go stale.
	 *
	 * Applying a choice never writes to the index — see `applySortChoice`.
	 * The dialog's existing Save/Cancel footer is the confirmation for that:
	 * without it, picking an item in this menu would silently discard
	 * whatever hand-made arrangement was on screen, with no undo.
	 */
	private renderSortByButton(row: HTMLElement): void {
		const button = row.createEl('button', { cls: 'eoe-sort-by-button', text: 'Sort by', attr: { type: 'button' } });
		button.addEventListener('click', () => this.openSortByMenu(button));
	}

	/**
	 * Builds and opens the "sort by" menu from `SORT_CHOICES`, in the order
	 * that array lists them.
	 *
	 * Positioned via `showAtPosition`, computed from `button`'s own
	 * `getBoundingClientRect()` — deliberately not `showAtMouseEvent(evt)`.
	 * This button is reachable and activatable from the keyboard (it's a
	 * plain `<button>`), and a `click` event synthesized by keyboard
	 * activation (Enter/Space) carries `clientX`/`clientY` of `(0, 0)` —
	 * `showAtMouseEvent` would happily open the menu in the screen's top-left
	 * corner for anyone who never touched a mouse to trigger it.
	 */
	private openSortByMenu(button: HTMLElement): void {
		const menu = new Menu();
		for (const choice of SORT_CHOICES) {
			menu.addItem((item) => item.setTitle(choice.label).onClick(() => this.applySortChoice(choice)));
		}
		const rect = button.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom });
	}

	/**
	 * Rearranges the on-screen rows to match `choice` — and only that: no
	 * write to the index happens here (see `renderSortByButton`'s doc
	 * comment for why that's deliberate). The user still has to press Save
	 * for this to stick, same as a drag.
	 *
	 * Pairs each current row element with its `SortableEntry` via
	 * `entryByRowEl`, asks `entrySort.ts`'s `sortEntries` for the new order,
	 * then re-appends every row element to `listEl` in that order.
	 * `Node.appendChild` moves a node that is already a child rather than
	 * duplicating it, so one pass of appends is sufficient — no separate
	 * removal step, and nothing here touches the live SortableJS instance
	 * (no destroy/rebuild), exactly like `moveRow`'s top/bottom jump already
	 * doesn't.
	 *
	 * If a row element has no entry in `entryByRowEl` — should be impossible,
	 * every row is registered there in `renderRow` and never removed from the
	 * map until the whole level is torn down — this returns before touching
	 * the DOM at all, leaving the on-screen order exactly as it was, rather
	 * than throwing or silently dropping a row from the list.
	 */
	private applySortChoice(choice: SortChoice): void {
		const listEl = this.listEl;
		if (listEl === null) return;

		const rows = this.sortableRows();
		const entries: SortableEntry[] = [];
		const rowElByEntry = new Map<SortableEntry, HTMLElement>();
		for (const rowEl of rows) {
			const entry = this.entryByRowEl.get(rowEl);
			if (entry === undefined) return; // see doc comment above: trust the contract, don't crash or drop a row
			entries.push(entry);
			rowElByEntry.set(entry, rowEl);
		}

		// sortEntries only permutes its input (see its doc comment), so every
		// entry it hands back is one of the very objects `rowElByEntry` was
		// just built from — the lookup below always resolves.
		for (const entry of sortEntries(entries, choice.key, choice.descending)) {
			const rowEl = rowElByEntry.get(entry);
			if (rowEl !== undefined) listEl.appendChild(rowEl);
		}

		this.showDatesFor(choice.key);
		this.afterOrderChanged();
	}

	/**
	 * Annotates every row with the timestamp the arrangement was just sorted
	 * by, or clears the annotation when `key` has no date to show (see
	 * `timestampFor` in `entrySort.ts` for exactly when that is: a name sort,
	 * a folder, or a file with no `stat` value for the chosen key).
	 *
	 * The point is that a date sort can be *checked*. An order produced by
	 * comparing numbers nobody can see is one the user has to take on faith,
	 * and the first time it disagrees with their expectation there is no way
	 * to tell a bug from a file whose modification time is not what they
	 * assumed.
	 *
	 * The dates deliberately survive a subsequent drag. They describe the
	 * files, not the arrangement, so moving a row does not make them stale —
	 * and seeing "this one is out of date order because I put it there" is
	 * exactly the state a user who has just hand-adjusted a sorted list is in.
	 *
	 * Two formats, both locale-resolved by the runtime rather than pinned
	 * here, the same choice `fallbackEntryOrder` documents for collation: a
	 * short one on screen, where the column has to stay narrow enough to
	 * leave the name room, and a full one in the tooltip, where the short
	 * form's two-digit year and absent seconds would otherwise be lost.
	 */
	private showDatesFor(key: SortKey): void {
		for (const [rowEl, dateEl] of this.dateByRowEl) {
			const entry = this.entryByRowEl.get(rowEl);
			const stamp = entry === undefined ? null : timestampFor(entry, key);

			if (stamp === null) {
				dateEl.setText('');
				setTooltip(dateEl, '');
				continue;
			}

			const when = new Date(stamp);
			dateEl.setText(when.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }));
			setTooltip(dateEl, when.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'medium' }));
		}
	}

	/**
	 * Renders one row.
	 *
	 * `sortable` gates every control that changes a row's *position* — the
	 * grip and the move buttons — and it is false only for a folder holding a
	 * single item, where there is no second row to move past.
	 *
	 * The "enter" control is deliberately gated on none of that, because
	 * entering is navigation, not ordering: a folder's own position among its
	 * siblings is unrelated to whether its children can be reordered, and
	 * they always can.
	 */
	private renderRow(container: HTMLElement, row: OrderRow, sortable: boolean): void {
		const rowEl = container.createDiv({ cls: 'eoe-row' });
		this.entryByRowEl.set(rowEl, row.entry);

		if (sortable) {
			const handle = rowEl.createDiv({ cls: 'eoe-row-handle' });
			setIcon(handle, ICON_GRIP);
			setTooltip(handle, 'Drag to reorder');
		}

		const icon = rowEl.createDiv({ cls: 'eoe-row-icon' });
		setIcon(icon, row.entry.kind === 'folder' ? ICON_FOLDER : ICON_FILE);

		// Name and date share a wrapper rather than sitting directly in the
		// row, so that a name too long to leave room for the date pushes the
		// date onto its own line instead of being truncated to make space for
		// it. The name is the thing the user is reading; the date is an
		// annotation on it, and an annotation must not cost the name its
		// characters. See `.eoe-row-text` in styles.css for how the wrap is
		// actually provoked.
		const text = rowEl.createDiv({ cls: 'eoe-row-text' });
		text.createSpan({ cls: 'eoe-row-name', text: displayLabel(row.entry) });
		this.dateByRowEl.set(rowEl, text.createSpan({ cls: 'eoe-row-date' }));

		// Created for every row, even one that ends up holding only the
		// "enter" control (or nothing at all): it is what keeps the row's
		// right-hand edge aligned with its neighbours'.
		const actions = rowEl.createDiv({ cls: 'eoe-row-actions' });
		if (sortable) {
			this.renderRowActions(rowEl, actions);
		}

		// Any folder row still present among this folder's live children gets
		// a way to drill into it — see `childFolderByName`, rebuilt at the top
		// of `render()`.
		if (row.entry.kind === 'folder') {
			const childFolder = this.childFolderByName.get(row.entry.name);
			if (childFolder !== undefined) {
				this.renderEnterButton(actions, childFolder);
			}
		}

		if (sortable) {
			rowEl.setAttribute('tabindex', '0');
			rowEl.addEventListener('keydown', (evt) => this.onRowKeyDown(evt, rowEl));

			// Focus the row explicitly rather than relying on a click landing
			// on a `tabindex` element focusing it by default. SortableJS runs
			// its own pointer handling over this same container in fallback
			// mode (see `forceFallback` in `render`), and anything that calls
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
	 * (see the `forceFallback` comment in `render`), and touch has no hover
	 * state at all — a hover-only affordance would simply not exist there.
	 *
	 * `actions` is created by `renderRow` and passed in rather than created
	 * here, because a row can need that group without needing this pair — a
	 * non-sortable row still hosts the "enter" control in it.
	 */
	private renderRowActions(rowEl: HTMLElement, actions: HTMLElement): void {
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
	 * The per-row "enter subfolder" control. No SortableJS `filter`
	 * option is needed to keep this from starting a drag: dragging is already
	 * restricted to `.eoe-row-handle` (the `handle` option in `render`), and
	 * this button isn't part of it.
	 */
	private renderEnterButton(actions: HTMLElement, childFolder: TFolder): void {
		const targetLabel = folderShortName(childFolder.name, childFolder.isRoot(), this.app.vault.getName());
		const button = actions.createEl('button', { cls: 'clickable-icon eoe-row-action eoe-row-enter', attr: { type: 'button' } });
		setIcon(button, ICON_ENTER);
		button.addEventListener('click', () => void this.navigateTo(childFolder));
		this.navControls.push({ button, targetLabel });
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

		this.afterOrderChanged();
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
	 * Keeps every navigation control's tooltip and accessible name in sync
	 * with whether activating it right now would save first — same
	 * `setTooltip` + `aria-label` pairing as the move-to-top/bottom buttons
	 * above, and the same reason: `setTooltip` only gives a hover hint, not
	 * an accessible name.
	 */
	private refreshNavigationLabels(): void {
		// Hoisted out of the loop: `isDirty` walks every row in the list, and
		// there is one control per folder row plus one per breadcrumb level —
		// so leaving it inside made a single keystroke in a 62-item folder do
		// roughly sixty full passes over sixty rows. The answer is the same
		// for every control by construction; it describes the list, not the
		// control.
		const dirty = this.isDirty();
		for (const control of this.navControls) {
			const label = navigationLabel(dirty, control.targetLabel);
			setTooltip(control.button, label);
			control.button.setAttribute('aria-label', label);
		}
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

	/** `canSave` is false for the empty-folder and single-item screens — nothing was ever dragged into an order, so nothing to offer saving. */
	private renderFooter(canSave: boolean): void {
		const footer = this.contentEl.createDiv({ cls: 'eoe-footer' });

		new ButtonComponent(footer).setButtonText('Cancel').onClick(() => this.close());

		if (!canSave) return;

		const saveButton = new ButtonComponent(footer)
			.setButtonText('Save')
			.setCta()
			.onClick(() => {
				if (this.busy) return;
				this.busy = true;
				saveButton.setDisabled(true);
				void this.save()
					.then((outcome) => {
						// 'blocked'/'failed': a notice is already up, and the
						// order the user arranged is still on screen to retry.
						if (outcome === 'saved' || outcome === 'unchanged') this.close();
					})
					.finally(() => {
						this.busy = false;
						saveButton.setDisabled(false);
					});
			});
	}

	/**
	 * Writes the on-screen order to the index, keyed under this folder. Does
	 * not close the modal itself — the footer Save button and `navigateTo`
	 * each need to react to the outcome differently (the former closes on
	 * success, the latter needs the modal to stay open so it can then switch
	 * levels), so that decision is left to the caller.
	 *
	 * Genuinely `async`: `store.updateOrRepair` heals the order
	 * note first when it's unusable, rather than refusing outright, which
	 * needs real I/O (quarantining the unreadable text, rebuilding the
	 * note). There is no cheap pre-check to short-circuit on any more — the
	 * store can't know whether a save is recoverable without attempting the
	 * same repair a save would trigger, so this always calls
	 * `updateOrRepair` and reads the outcome from its result instead.
	 */
	private async save(): Promise<SaveOutcome> {
		const names = this.collectOrderedEntries().map((entry) => entry.name);
		const key = folderIndexKey(this.folder);

		let changed = false;
		let ok: boolean;
		try {
			ok = await this.store.updateOrRepair((index) => {
				const next = setOrder(index, key, names);
				changed = next !== index;
				return next;
			});
		} catch (err) {
			console.error('[explorer-order-editor] failed to save explorer order', err);
			new Notice('Could not save the explorer order: an unexpected error occurred.');
			return 'failed';
		}

		if (!ok) {
			// The store already logged why; a repair was attempted and found
			// nothing recoverable, which is the only way this is reachable
			// now — said here and now regardless, since silence at the point
			// of action reads as "nothing happened", not "this was refused".
			new Notice(`Could not save: ${unusableClause(this.store)}. ${repairPointer('from elsewhere')}`);
			return 'blocked';
		}

		if (!changed) {
			new Notice('Explorer order unchanged.');
			return 'unchanged';
		}

		new Notice('Explorer order saved.');
		// Arms the refresh — see `pendingRefresh` and `flushRefresh`. Unlike
		// the old sortspec.md-based version there is no cache to wait for: the
		// index is ours and `this.store` already holds the new value in
		// memory, so all that's left is asking the file explorer to redraw.
		this.pendingRefresh = true;
		return 'saved';
	}

	/**
	 * The one refresh a whole dialog session is worth, run after the modal
	 * has closed — this dialog saves once per folder visited, and walking
	 * five levels deep redrawing the file explorer five times, each behind
	 * the still-open modal, would be work nobody could see the result of.
	 */
	private flushRefresh(): void {
		reportApplied(this.app, this.settings.autoRefresh, 'Saved');
	}
}
