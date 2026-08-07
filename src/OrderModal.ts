import { App, ButtonComponent, Modal, Notice, Platform, setIcon, setTooltip, TFolder } from 'obsidian';
import Sortable from 'sortablejs';
import { FrontMatterError, type FrontMatterErrorCode } from './frontmatter';
import { breadcrumbSegments, folderShortName, isSameOrder, navigationLabel, type BreadcrumbSegment } from './navigation';
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
	awaitMetadataSettled,
	entriesFor,
	folderNoteConflict,
	readStoredOrder,
	SORTSPEC_FILENAME,
	sortspecPathFor,
	targetKeyFor,
	triggerCustomSortRefresh,
	updateFolderSpec,
} from './sortspecFile';
import type { Entry } from './types';

const ICON_FOLDER = 'lucide-folder';
const ICON_FILE = 'lucide-file-text';
const ICON_GRIP = 'lucide-grip-vertical';
const ICON_WARNING = 'lucide-triangle-alert';
const ICON_MOVE_TOP = 'lucide-chevrons-up';
const ICON_MOVE_BOTTOM = 'lucide-chevrons-down';
/** The per-row "enter subfolder" control (M8). */
const ICON_ENTER = 'lucide-chevron-right';

/**
 * How many breadcrumb positions (folders plus, when truncated, the ellipsis
 * that stands in for the rest) the trail ever renders. The budget this
 * bounds is no longer horizontal width but *rendered lines* (M8c): each
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
	 * The metadata-cache wait armed by the most recent successful save, held
	 * until the modal closes and `flushRefresh` turns it into custom-sort's
	 * one refresh for the whole session.
	 *
	 * The one piece of state `resetContent` must *not* clear: everything else
	 * there belongs to a single level, whereas this deliberately survives
	 * every level switch — that is the entire mechanism. A later save simply
	 * replaces it; the superseded promise resolves on its own and cleans up
	 * its own listener.
	 */
	private pendingRefresh: Promise<void> | null = null;
	/**
	 * Bumped at the start of every `render()`; a render checks its own token
	 * against this field after each `await` and bails out if they no longer
	 * match. Without this, navigating to a new level while a previous
	 * `render()` is still awaiting `folderNoteConflict`/`readStoredOrder`
	 * would let that stale render finish by appending the *old* folder's rows
	 * onto the *new* folder's already-drawn screen — `resetContent`/`render`
	 * for the new level runs first (navigation awaits the whole switch), but
	 * the old call is still suspended on the event loop and has no way to
	 * know it's obsolete without checking.
	 */
	private renderToken = 0;
	/**
	 * What `collectOrderedEntries()` returned right after this level's
	 * `render()` finished — i.e. exactly what a save would write at that
	 * moment. `isDirty` compares the live order against this, not against
	 * "what's on disk right now": a folder with no sortspec.md that the user
	 * only looked at (drilled through on the way to a subfolder, then came
	 * back up) must not get one written just because navigating triggers a
	 * save-if-dirty. Reset to `[]` by `resetContent` and set again at the end
	 * of every `render()`.
	 */
	private initialOrder: readonly Entry[] = [];
	private folder: TFolder;

	constructor(
		app: App,
		folder: TFolder,
		private readonly settings: ExplorerOrderEditorSettings,
	) {
		super(app);
		this.folder = folder;
	}

	onOpen(): void {
		void this.render();
	}

	onClose(): void {
		this.closed = true;
		// Read before resetContent, which deliberately leaves this field alone
		// (it has to outlive every level switch) — this is the only place it
		// is consumed and cleared.
		const pending = this.pendingRefresh;
		this.pendingRefresh = null;
		this.resetContent();
		// Deliberately not awaited: onClose is synchronous, and nothing here
		// touches the modal — it reads the command registry and may show a
		// notice, both of which are fine once the dialog is gone.
		if (pending !== null) void this.flushRefresh(pending);
	}

	/**
	 * Renders the current `this.folder` from scratch. Navigating to a new
	 * level is `resetContent()` followed by another call to this — there is
	 * no cross-level screen state kept around, only whatever the fresh read
	 * produces, so a level revisited after saving always shows exactly what
	 * was just written.
	 */
	private async render(): Promise<void> {
		const token = ++this.renderToken;

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
		// including the folder-note warning and the `siblings.length <= 1`
		// early return — so that even an empty or fully-unorderable subfolder
		// still has a way back out, rather than being a dead end only
		// reachable by navigating into it in the first place.
		this.renderBreadcrumbs();

		const hasFolderNoteConflict = await folderNoteConflict(this.app, this.folder);
		if (this.isStale(token)) return; // the modal was closed, or a newer render started, while the read was in flight
		if (hasFolderNoteConflict) {
			this.renderFolderNoteWarning();
		}

		const siblings = entriesFor(this.folder);
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
			// saving would write a sortspec.md that says nothing.
			this.renderFooter(false);
			this.finishRender();
			return;
		}

		// Restore whatever order is already stored for this folder, merged
		// against what's actually here now. Without this, reopening the modal
		// on an already-ordered folder would show alphabetical order and
		// saving would silently destroy the existing order.
		const stored = await readStoredOrder(this.app, this.folder, siblings);
		if (this.isStale(token)) return; // the modal was closed, or a newer render started, while the read was in flight
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

		if (unorderableRows.length > 0) {
			this.contentEl.createDiv({
				cls: 'eoe-unorderable-note',
				text: "These can't be ordered — custom file explorer sorting has no way to express their names. They always appear last.",
			});

			const unorderableListEl = this.contentEl.createDiv({ cls: 'eoe-unorderable-list' });
			for (const row of unorderableRows) {
				this.renderRow(unorderableListEl, row, false);
			}
		}

		// Nothing to drag into an order means nothing to save.
		this.renderFooter(orderableRows.length > 0);
		this.finishRender();
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
	 * everything-unorderable screens — the screens where finding the way back
	 * out matters most. `refreshRowActionsDisabled` is a no-op there (no
	 * rows), which is why this can be one unconditional call.
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
		this.childFolderByName.clear();
		this.navControls = [];
		this.unorderableEntries = [];
		this.initialOrder = [];
		this.contentEl.empty();
	}

	/**
	 * Whether the `render()` call identified by `token` should stop acting —
	 * see `renderToken`'s doc comment for why a render can go stale mid-await.
	 */
	private isStale(token: number): boolean {
		return this.closed || token !== this.renderToken;
	}

	/**
	 * True when the on-screen order has changed since this level's `render()`
	 * finished. This has to mean "the user changed something", not "the file
	 * on disk would change if saved now" — a folder with no sortspec.md that
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
				// A successful save awaits custom-sort's refresh, which is
				// easily long enough for the user to have closed the dialog
				// underneath us. `renderToken` only protects the awaits
				// *inside* render(); nothing stops us calling it in the first
				// place, and doing so would rebuild a whole level into a
				// closed modal's detached contentEl, listeners and all.
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
	 * The breadcrumb trail (M8c), a stepped vertical hierarchy replacing the
	 * single horizontal line of M8b: one folder per rendered line, each
	 * indented one step past the one above, so every level gets essentially
	 * the full modal width instead of several names fighting over one line —
	 * the horizontal version had no good answer for a long ancestor sitting
	 * next to a long current folder. Rendered unconditionally, including for
	 * the vault root itself — a one-line trail is still "you are here".
	 */
	private renderBreadcrumbs(): void {
		const container = this.contentEl.createDiv({ cls: 'eoe-breadcrumb' });
		const chain = this.folderChain();
		const segments = breadcrumbSegments(chain.length, MAX_VISIBLE_CRUMBS);

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
		});
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
			const hiddenNames = segment.hiddenIndices
				.map((index) => chain[index])
				.filter((f): f is TFolder => f !== undefined)
				.map((f) => folderShortName(f.name, f.isRoot(), this.app.vault.getName()));
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
	 * Renders one row.
	 *
	 * `sortable` gates every control that changes a row's *position* — the
	 * grip and the move buttons — and it is false in two cases: the
	 * unorderable region, whose rows never sit in a `Sortable`-managed
	 * container, and a folder holding a single item, where there is no second
	 * row to move past. A grip that does nothing is the same false promise
	 * the disabled styling used to make on its own.
	 *
	 * The "enter" control is deliberately gated on none of that, because
	 * entering is navigation, not ordering. Whether this plugin can express a
	 * folder's own name in its *parent's* spec says nothing about whether its
	 * children can be ordered — and they always can, since a folder's spec is
	 * written with `target-folder: .`, which never mentions the folder's name
	 * at all. Tying the two together is what left a folder you could see but
	 * could not open.
	 */
	private renderRow(container: HTMLElement, row: OrderRow, sortable: boolean): void {
		const rowEl = container.createDiv({ cls: 'eoe-row' });
		this.entryByRowEl.set(rowEl, row.entry);

		if (row.disabledReason !== undefined) {
			rowEl.addClass('eoe-row-disabled');
			setTooltip(rowEl, row.disabledReason);
		}

		if (sortable) {
			const handle = rowEl.createDiv({ cls: 'eoe-row-handle' });
			setIcon(handle, ICON_GRIP);
			setTooltip(handle, 'Drag to reorder');
		}

		const icon = rowEl.createDiv({ cls: 'eoe-row-icon' });
		setIcon(icon, row.entry.kind === 'folder' ? ICON_FOLDER : ICON_FILE);

		rowEl.createSpan({ cls: 'eoe-row-name', text: row.entry.name });

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
	 * The per-row "enter subfolder" control (M8). No SortableJS `filter`
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
		for (const control of this.navControls) {
			const label = navigationLabel(this.isDirty(), control.targetLabel);
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

	/** `canSave` is false when every entry is unorderable — nothing dragged into an order, so nothing to offer saving. */
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
	 * Writes the on-screen order to `this.folder`'s sortspec.md. Does not
	 * close the modal itself — the footer Save button and `navigateTo` each
	 * need to react to the outcome differently (the former closes on success,
	 * the latter needs the modal to stay open so it can then switch levels),
	 * so that decision is left to the caller.
	 */
	private async save(): Promise<SaveOutcome> {
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
				return 'failed';
			}
			console.error('[explorer-order-editor] failed to save explorer order', err);
			new Notice('Could not save the explorer order: an unexpected error occurred.');
			return 'failed';
		}

		switch (result.status) {
			case 'blocked':
				this.reportBlocked(result.diagnostics);
				return 'blocked';
			case 'unchanged':
				new Notice('Explorer order unchanged.');
				return 'unchanged';
			case 'replaced':
			case 'appended':
				this.reportSaved(result.diagnostics);
				return 'saved';
			case 'removed':
				// Save only ever upserts; unreachable from this modal.
				return 'saved';
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

	/**
	 * Per-save feedback, and the point where the refresh is *armed* rather
	 * than performed — see `pendingRefresh` and `flushRefresh`.
	 */
	private reportSaved(diagnostics: readonly Diagnostic[]): void {
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

		const file = this.app.vault.getFileByPath(sortspecPathFor(this.folder));
		if (file === null) return; // shouldn't happen right after a successful write
		// Start waiting for the metadata cache now, while the write that will
		// settle it has just happened. The wait is only awaited at close; see
		// `awaitMetadataSettled` for why it cannot be started there instead.
		this.pendingRefresh = awaitMetadataSettled(this.app, file);
	}

	/**
	 * The one refresh a whole dialog session is worth, run after the modal
	 * has closed.
	 *
	 * custom-sort's refresh command re-sorts the vault, and this dialog now
	 * saves once per folder visited — walking five levels deep used to mean
	 * five whole-vault re-sorts, each preceded by its own wait for the
	 * metadata cache, with the file explorer hidden behind the modal the
	 * entire time. Four of those five were work nobody could see the result
	 * of. Batching costs nothing in correctness: every save still lands on
	 * disk immediately and atomically: only the *display* of it is deferred,
	 * to the moment there is something to display it on.
	 */
	private async flushRefresh(settled: Promise<void>): Promise<void> {
		if (!this.settings.autoRefresh) {
			new Notice('Automatic refresh is off. Run the custom file explorer sorting plugin\'s refresh command to see the change.');
			return;
		}
		await settled;
		if (triggerCustomSortRefresh(this.app) === 'missing') {
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
