/**
 * Lets a drag started inside the file explorer itself reorder rows, instead
 * of only ever moving the dragged item *into* whatever folder it's dropped
 * on.
 *
 * Same shape as `explorerSort.ts`: locate the file explorer leaf once from
 * `onLayoutReady`, retry on `layout-change` until it exists, then patch
 * something on its view — there it's `getSortedFolderItems`, here it's a set
 * of capture-phase DOM listeners on `view.containerEl` instead of a
 * prototype method. Same reason for going through undocumented territory at
 * all: Obsidian's own drag-and-drop for the file explorer has exactly one
 * outcome for a row drop ("move the dragged item into this folder" —
 * `attachDropHandler` wires every `.nav-folder`'s *entire subtree* as one
 * drop target, and the root container the same way for the vault root), and
 * there is no public API to add a second one ("insert it at this position")
 * alongside it.
 *
 * How the interception actually works (verified against obsidian.asar, not
 * guessed):
 * `DragManager.handleDrop` registers its `dragover`/`dragenter`/`drop`
 * listeners on each drop target in the *bubbling* phase, and every one of
 * those wrapped callbacks bails out immediately if the event already arrives
 * with `defaultPrevented` set. So a `preventDefault()` called from a
 * *capture*-phase listener on an ancestor — `view.containerEl`, which every
 * row and every `.nav-folder` subtree sits inside — runs before any of
 * those bubbling handlers do, and makes the whole chain of them no-ops for
 * that event. That is the entire mechanism this file relies on: it does not
 * patch, remove, or otherwise touch DragManager or the file explorer's own
 * handlers at all, it just gets there first, and only when it has actually
 * decided to take the drop over.
 *
 * The one thing that mechanism demands in return: never call
 * `stopPropagation()`. `DragManager` also has its own `dragover` listeners
 * directly on `window` — a capture-phase one that arms a microtask, and a
 * bubble-phase one that, if it runs, disarms it again before that microtask
 * fires. If the event's propagation were stopped anywhere along the way,
 * that bubble-phase `window` listener never gets a chance to run, the
 * microtask fires unopposed, and it clears DragManager's own idea of what's
 * being hovered *and* hides the drag preview it's drawing — which reads, on
 * screen, as the dragged item's ghost flickering out every time the pointer
 * crosses one of this plugin's own drop zones. `preventDefault()` alone
 * (which does not stop propagation) sidesteps this entirely: the event still
 * reaches `window` in both phases, DragManager's own bookkeeping keeps
 * running, only the file explorer's *reaction* to the event is suppressed.
 */
import { App, Notice, TFile, TFolder, type View } from 'obsidian';
import { dropSideFor, scrollStepFor, type DropSide, type RowKind } from './dropZone';
import { explorerViews } from './fileExplorerLeaves';
import { indexNotePath } from './indexFile';
import { applyDrop, type MoveItemHost } from './moveItem';
import { refusalNotice, reportApplied, repairPointer, unusableClause } from './notices';

/**
 * The window `el` actually lives in, not the main one.
 *
 * An explorer popped out into its own window has its own `requestAnimationFrame`
 * clock and its own event loop: frame callbacks scheduled on the main window's
 * are throttled or suspended while that window is in the background — which is
 * exactly when the popped-out one is being dragged in — and a `dragend` on the
 * main window never sees a drag that happened in the other. Falls back to the
 * main `window` only for an element attached to no view at all.
 */
function windowFor(el: HTMLElement): Window {
	return el.ownerDocument.defaultView ?? window;
}

/**
 * Auto-scroll tuning. `SCROLL_ZONE_PX` is the band, measured from
 * each edge of the scroll container, that counts as "close enough to the
 * edge to start scrolling" — passed straight through to `scrollStepFor`
 * (`dropZone.ts`), which is also where it gets shrunk if the container
 * itself is shorter than `2 * SCROLL_ZONE_PX`. `SCROLL_MAX_STEP_PX` is the
 * fastest this ever scrolls, in pixels per animation frame.
 */
const SCROLL_ZONE_PX = 36;
const SCROLL_MAX_STEP_PX = 12;

/**
 * `app.dragManager` is not part of Obsidian's public typed API — confirmed
 * absent from `obsidian.d.ts` entirely, unlike `getSortedFolderItems`/
 * `requestSort` (`explorerSort.ts`, `indexFile.ts`), which are at least
 * declared somewhere on an internal view subclass. A local interface plus a
 * runtime guard at each point of use, same discipline as everywhere else
 * this codebase reaches for an internal: never a bare `as any`, and nothing
 * declared as a `declare module 'obsidian'` augmentation of `App` itself
 * (that would make every *other* consumer of `App` believe it always has a
 * `dragManager` — the same trap a `View` augmentation sets for every view
 * that isn't the file explorer, applied here to a different class).
 *
 * Only the two members this file actually reads: `draggable`, to identify
 * what's being dragged (see `resolveDrop`'s judgment below), and
 * `updateHover`, to clear a stale native hover highlight after taking a drop
 * over (see `armCaptureListeners`'s doc comment). `file` on `draggable` is
 * typed `unknown`, not `TAbstractFile` — this codebase never casts to
 * `TFile`/`TFolder`, it narrows with `instanceof`, so there is no reason for
 * the *declared* type here to claim more than "some value" in the first
 * place.
 */
interface DraggableLike {
	readonly type?: string;
	readonly file?: unknown;
}

interface DragManagerLike {
	readonly draggable?: DraggableLike | null;
	updateHover?(targetEl: HTMLElement | null, action: string): void;
}

interface AppWithDragManager extends App {
	readonly dragManager?: DragManagerLike;
}

/**
 * A second, independent "is this leaf's view actually the loaded file
 * explorer, not a still-deferred placeholder" check. `explorerSort.ts` has a
 * richer one (`isFileExplorerView`, probing `getSortedFolderItems` too), but
 * that extra member is one this module never touches — and declaring
 * undocumented members where they are used, only the ones actually used, is
 * the discipline every internal-API touchpoint here follows. So this probes
 * `requestSort` alone, the same minimal signal `indexFile.ts`'s
 * `requestFileExplorerResort` uses: not to call it, only to prove the view
 * is real before trusting its `containerEl` to still be the element the
 * real file explorer keeps using, rather than one a still-loading
 * placeholder view will discard.
 *
 * The iteration this predicate feeds — walking every `file-explorer` leaf and
 * skipping deferred ones — moved to `fileExplorerLeaves.ts` (`explorerViews`)
 * once it turned out to be the same loop, copied, at every one of these
 * call sites. The predicate itself did not move with it, and stays here
 * independent of `explorerSort.ts`'s and `indexFile.ts`'s own predicates, for
 * the reason above: what "real" means is different at each call site, and
 * only the loop around it was ever duplicated.
 */
interface FileExplorerViewHandle {
	requestSort(): void;
}

function isFileExplorerViewHandle(view: View): view is View & FileExplorerViewHandle {
	const candidate = view as Partial<FileExplorerViewHandle>;
	return typeof candidate.requestSort === 'function';
}

/** What `resolveDrop` found, and what `performDrop` needs to act on it. */
interface ResolvedDrop {
	readonly dragged: TFile | TFolder;
	readonly anchor: TFile | TFolder;
	readonly rowEl: HTMLElement;
	readonly side: DropSide;
}

/**
 * The one judgment shared by `dragover`, `dragenter`, and `drop` — one
 * function deliberately, not three separate copies, so a future change to
 * any of these checks can't drift between the events that decide whether to
 * intercept and the one that actually acts). Returns `null` for "do not
 * intercept this event — let Obsidian's native drag-and-drop handle it
 * untouched," which callers must treat as "don't even call
 * `preventDefault()`."
 *
 * Every step below is a reason to bail out to native handling; there is no
 * step that can turn a `null` back into a resolved drop. Wrapped in its own
 * `try`/`catch` (`safeResolveDrop` below) rather than here, so this stays a
 * plain, directly-readable sequence of guards.
 */

/**
 * The whole of `resolveDrop`, in terms of the only two things it ever read
 * off the event: what the pointer is over, and how far down the viewport it
 * is.
 *
 * Split out so the auto-scroll loop can ask the same question. That loop moves
 * the tree under a stationary pointer at up to `SCROLL_MAX_STEP_PX` a frame,
 * and `dragover` — the only other thing that refreshes the indicator — is not
 * a clock: the DnD spec fires it roughly every ~350ms while the pointer sits
 * still, by which time a couple of hundred pixels have gone past. The line
 * would still be drawn on the row it was drawn on, while `handleDrop`
 * re-resolves against whatever is under the pointer *now*. Same question, two
 * answers, and the user only ever saw the stale one.
 */
function resolveDropAt(host: MoveItemHost, target: EventTarget | Element | null, clientY: number): ResolvedDrop | null {
	if (!host.settings.dragToReorder) return null;

	const dragManager = (host.app as AppWithDragManager).dragManager;
	const draggable = dragManager?.draggable;
	if (draggable === null || draggable === undefined) return null;
	if (draggable.type !== 'file' && draggable.type !== 'folder') return null;
	// Also excludes editor-originated link drags (`type: 'link'`, which also
	// carries a `.file`) and multi-select drags (`type: 'files'`, no `.file`
	// at all) — treating a dropped *link* as a request to move the file it
	// points at would move a file the user never picked up, and multi-select
	// is out of scope.
	const draggedFile: unknown = draggable.file;
	if (!(draggedFile instanceof TFile) && !(draggedFile instanceof TFolder)) return null;
	const dragged: TFile | TFolder = draggedFile;

	if (!(target instanceof Element)) return null;
	const rowEl = target.closest('.nav-file-title, .nav-folder-title');
	if (!(rowEl instanceof HTMLElement)) return null;

	const path = rowEl.getAttribute('data-path');
	if (path === null) return null;
	const anchorFile = host.app.vault.getAbstractFileByPath(path);
	if (!(anchorFile instanceof TFile) && !(anchorFile instanceof TFolder)) return null;
	const anchor: TFile | TFolder = anchorFile;

	if (anchor.path === dragged.path) return null;

	// Neither end of the drop may be the order index note. As an anchor it has
	// no position to insert beside — `effectiveOrder` filters it out of every
	// folder's order, so `insertNameBeside` could only ever answer `null` —
	// and as the dragged item it is worse than a no-op: its name would be
	// written into the folder's saved order, where `explorerSort.ts` (which
	// positions that note on its own terms, or hides it) will never render it,
	// leaving a stray entry in the user's note bought with no visible
	// movement at all. Same rule `main.ts`'s move menu applies by offering no
	// items for that note.
	const notePath = indexNotePath(host.settings);
	if (anchor.path === notePath || dragged.path === notePath) return null;

	const dest = anchor.parent;
	if (dest === null) return null;

	// A folder can't be dropped into itself or anything already inside it —
	// the same guard `OrderModal.ts`'s navigation has for entering a
	// subfolder, applied here to the *destination* of a move instead.
	if (dragged instanceof TFolder && (dest.path === dragged.path || dest.path.startsWith(`${dragged.path}/`))) {
		return null;
	}

	const rect = rowEl.getBoundingClientRect();
	const side = dropSideFor(clientY, rect.top, rect.height, rowKindFor(anchor, rowEl));
	if (side === null) return null;

	return { dragged, anchor, rowEl, side };
}

/**
 * `file` rows are never collapsible, so they're always `'file'`. A folder
 * row's `kind` depends on whether it's currently collapsed — verified
 * against obsidian.asar's `TreeItem#updateCollapsed`, which calls
 * `toggleClass('is-collapsed', this.collapsed)` on `this.el`, the
 * `tree-item nav-folder` wrapper div, *not* on `this.selfEl` (`tree-item-self
 * nav-folder-title`, what `resolveDrop` above calls `rowEl`) — `selfEl` is a
 * child of `el`, created alongside `childrenEl` (`nav-folder-children`)
 * inside the same wrapper. So the class to read lives one level up from the
 * row itself: `rowEl.parentElement`, not `rowEl`.
 *
 * If that parent is ever unreachable (defensive only — every rendered row
 * has one), this falls back to `'expanded-folder'` rather than
 * `'collapsed-folder'`: an expanded folder's hot zone is the *smaller* of
 * the two (25% before, no after band at all — see `dropZone.ts`), so
 * guessing wrong here can only ever turn a would-be `'after'` drop into a
 * pass-through to native "move into this folder," never produce a drop
 * whose meaning is ambiguous.
 */
function rowKindFor(anchor: TFile | TFolder, rowEl: HTMLElement): RowKind {
	if (anchor instanceof TFile) return 'file';
	const collapsed = rowEl.parentElement?.classList.contains('is-collapsed') === true;
	return collapsed ? 'collapsed-folder' : 'expanded-folder';
}

/**
 * `resolveDropAt` wrapped in a `try`/`catch` that treats any exception the
 * same as a deliberate `null`: Obsidian's internals changed under us, or
 * something above misbehaved, and the only safe response is to hand the
 * event back to native handling rather than let a thrown error leave the
 * drag in a broken state (or, worse, propagate out of a capture-phase
 * listener and break every *other* capture-phase listener on the same
 * element). Logged once per call, not deduplicated — same policy
 * `explorerSort.ts`'s replacement takes for the same reason.
 *
 * Takes the two fields rather than the event, so the auto-scroll loop — which
 * has coordinates and no event — gets this same policy instead of its own
 * copy of it.
 */
function safeResolveDrop(host: MoveItemHost, target: EventTarget | Element | null, clientY: number): ResolvedDrop | null {
	try {
		return resolveDropAt(host, target, clientY);
	} catch (err) {
		console.error('[explorer-order-editor] failed to resolve a file explorer drag target, falling back to native drag-and-drop', err);
		return null;
	}
}

/**
 * Owns the single "before"/"after" indicator line this file ever shows, as
 * one remembered element/side pair rather than a set — only one row can be
 * the current drop target at a time. `clear()` is idempotent and cheap to
 * call defensively (dragleave, dragend, drop, and unload all do), since it
 * no-ops instantly once there's nothing to remove.
 */
class DropIndicator {
	private el: HTMLElement | null = null;
	private side: DropSide | null = null;

	/**
	 * Returns whether this call actually changed anything — i.e. whether the
	 * pointer just arrived at a new row/side rather than staying put on one
	 * already lit. `dragover` fires per mouse message, which on a high polling
	 * rate mouse is several hundred a second, and all but a handful of those
	 * describe a position this indicator is already showing. Callers use the
	 * return value to skip the work that only makes sense on an actual
	 * transition.
	 */
	show(rowEl: HTMLElement, side: DropSide): boolean {
		if (this.el === rowEl && this.side === side) return false;
		this.clear();
		rowEl.classList.add(side === 'before' ? 'eoe-drop-before' : 'eoe-drop-after');
		this.el = rowEl;
		this.side = side;
		return true;
	}

	clear(): void {
		this.el?.classList.remove('eoe-drop-before', 'eoe-drop-after');
		this.el = null;
		this.side = null;
	}
}

/**
 * Finds the nearest scrollable ancestor of `target`, walking up from it and
 * stopping at — but never past — `boundaryEl` (`containerEl` itself is
 * checked too, then the walk ends there either way). This can therefore
 * never reach out past the file explorer's own pane and start auto-scrolling
 * something else, such as the workspace split around it.
 *
 * Deliberately keyed off generic, always-true DOM properties
 * (`scrollHeight > clientHeight`, computed `overflow-y`) rather than a class
 * name such as `.nav-files-container`: Obsidian's internal markup for the
 * file explorer is not part of its public API and could change shape at any
 * release, but "this element actually overflows and is set to scroll" holds
 * for whatever element is *really* producing the scrollbar, regardless of
 * what it happens to be called this version. This adds no new dependency on
 * undocumented structure beyond what `resolveDrop` above already reads
 * (`data-path`, `.nav-file-title`/`.nav-folder-title`) — everything checked
 * here is standard DOM.
 */
function findScrollContainer(target: Element, boundaryEl: HTMLElement): HTMLElement | null {
	let el: Element | null = target;
	while (el !== null) {
		if (el.instanceOf(HTMLElement) && el.scrollHeight > el.clientHeight) {
			const overflowY = getComputedStyle(el).overflowY;
			if (overflowY === 'auto' || overflowY === 'scroll') return el;
		}
		if (el === boundaryEl) return null;
		el = el.parentElement;
	}
	return null;
}

/**
 * Drives auto-scrolling the file explorer while a self-rendered drag's
 * pointer sits near the top or bottom edge of whatever scroll container it's
 * over. Owns exactly one drag's worth of state, mirroring
 * `DropIndicator`'s lifecycle: `update()` on every `dragover`/`dragenter`,
 * `stop()` on every path that ends a drag.
 *
 * Two things make this need a `requestAnimationFrame` loop rather than just
 * reacting to each `dragover`: the container's rect can change out from
 * under a still-open drag (the pane can be resized), and `dragover` itself
 * is not a reliable clock — the DnD spec fires it roughly every ~350ms while
 * the pointer sits still, which reads as a stutter rather than a scroll if
 * that were the only thing advancing `scrollTop`. So `update()` only ever
 * records the latest pointer position and starts/stops the loop; the loop
 * itself re-measures the container and recomputes the step every frame.
 */
class AutoScroller {
	private scrollEl: HTMLElement | null = null;
	private pointerX = 0;
	private pointerY = 0;
	private step = 0;
	private rafId: number | null = null;

	/**
	 * `onScrolled` is called after each frame's scroll, with the pointer where
	 * it still is. The tree just moved under a pointer that did not, so
	 * whatever was resolved from the last `dragover` is now about a different
	 * row — and this loop is the only thing that knows it happened.
	 */
	constructor(
		private readonly boundaryEl: HTMLElement,
		private readonly onScrolled: (clientX: number, clientY: number) => void,
	) {}

	/** See `windowFor`: the rAF clock has to be the one belonging to the window this element is in. */
	private get win(): Window {
		return windowFor(this.boundaryEl);
	}

	/**
	 * Called from every `dragover`/`dragenter` this plugin sees on the file
	 * explorer, intercepted or not (see `handleDragOverLike`'s doc comment for
	 * why this runs even when the drop itself falls through to native
	 * handling). The scroll container is resolved from `evt.target` and then
	 * cached for the rest of the drag — `findScrollContainer` walking the DOM
	 * on every `dragover` would run far more often than needed for something
	 * that cannot change mid-drag.
	 *
	 * Only a *successful* resolution is cached, deliberately. Not every part
	 * of the file explorer's container is inside its scrollable region — its
	 * header row isn't — so an event that happens to land there resolves to
	 * nothing, and remembering that would switch auto-scroll off for the whole
	 * drag over one unlucky event. Retrying while it is still `null` costs a
	 * short walk up the DOM in exactly the case where nothing else is
	 * happening anyway, and the caching this is here for still holds from the
	 * first event that lands on a row onward.
	 */
	update(evt: DragEvent): void {
		if (this.scrollEl === null && evt.target instanceof Element) {
			this.scrollEl = findScrollContainer(evt.target, this.boundaryEl);
		}
		if (this.scrollEl === null) return;

		this.pointerX = evt.clientX;
		this.pointerY = evt.clientY;
		this.step = this.computeStep();
		this.syncLoop();
	}

	/**
	 * Ends this drag's auto-scroll, if any is running: cancels a pending
	 * frame and drops the cached container so the next drag resolves its own
	 * fresh one rather than trusting an element the file explorer may have
	 * already re-rendered away. Idempotent and cheap to call defensively —
	 * every stop condition (`dragend`, `drop`, leaving the file explorer,
	 * plugin unload) calls this unconditionally.
	 */
	stop(): void {
		if (this.rafId !== null) {
			this.win.cancelAnimationFrame(this.rafId);
			this.rafId = null;
		}
		this.scrollEl = null;
		this.step = 0;
	}

	private computeStep(): number {
		if (this.scrollEl === null) return 0;
		const rect = this.scrollEl.getBoundingClientRect();
		return scrollStepFor(this.pointerY, rect.top, rect.bottom, SCROLL_ZONE_PX, SCROLL_MAX_STEP_PX);
	}

	private syncLoop(): void {
		if (this.step !== 0 && this.rafId === null) {
			this.rafId = this.win.requestAnimationFrame(this.tick);
		} else if (this.step === 0 && this.rafId !== null) {
			this.win.cancelAnimationFrame(this.rafId);
			this.rafId = null;
		}
	}

	// Re-measures the container and recomputes the step every frame, rather
	// than reusing what `update()` last computed — the container's rect can
	// change mid-drag (the pane can be resized) and the pointer's depth into
	// the hot zone should track that, not a stale measurement. Stops itself
	// the moment the step goes to 0, rather than scheduling one more frame
	// to notice that — `syncLoop()` will start a fresh loop the next time
	// `update()` computes a nonzero step.
	private readonly tick = (): void => {
		this.rafId = null;
		if (this.scrollEl === null) return;
		this.step = this.computeStep();
		if (this.step === 0) return;
		this.scrollEl.scrollTop += this.step;
		// After the scroll, not before: the callback resolves what is under the
		// pointer now, and "now" is after this frame's movement.
		this.onScrolled(this.pointerX, this.pointerY);
		this.rafId = this.win.requestAnimationFrame(this.tick);
	};
}

/**
 * Redraws the insertion line for wherever the pointer is now, after
 * auto-scroll has moved the tree beneath it.
 *
 * `elementFromPoint` on the boundary element's *own* document, because a
 * popped-out explorer is not in the main one. `null` from it, or a position
 * this file would not claim, clears the line rather than leaving it where it
 * was — the same rule `handleDragOverLike` follows, and for the same reason:
 * a line promising "insert here" over a spot that will drop natively is worse
 * than no line, because the native drop moves the item *into* a folder.
 *
 * Never throws, for the reason every other entry point in this file is
 * wrapped: auto-scroll is a convenience on top of the drop, and a fault in it
 * must not take the drag with it. That guarantee comes from `safeResolveDrop`
 * rather than a second `try`/`catch` here, so there is one error policy for
 * resolving a drop and not one per caller.
 */
function refreshIndicatorAfterScroll(host: MoveItemHost, indicator: DropIndicator, boundaryEl: HTMLElement, clientX: number, clientY: number): void {
	const under = boundaryEl.ownerDocument.elementFromPoint(clientX, clientY);
	const resolved = safeResolveDrop(host, under, clientY);
	if (resolved === null) {
		indicator.clear();
		return;
	}
	indicator.show(resolved.rowEl, resolved.side);
}

/**
 * The single gate on auto-scrolling, wrapping `AutoScroller.update()`:
 * `host.settings.dragToReorder` — the same first check `resolveDrop` makes
 * — so there is exactly one setting a user (or a future reader) needs to
 * find to turn this feature off, not two that could drift apart. Any
 * exception here is caught and treated as "stop scrolling for this drag":
 * auto-scroll is a convenience layered on top of the drop itself, and a bug
 * in it must never be allowed to affect whether the drop underneath still
 * works.
 */
function updateAutoScroll(host: MoveItemHost, scroller: AutoScroller, evt: DragEvent): void {
	try {
		if (!host.settings.dragToReorder) {
			scroller.stop();
			return;
		}
		scroller.update(evt);
	} catch (err) {
		console.error('[explorer-order-editor] auto-scroll failed, stopping it for this drag', err);
		scroller.stop();
	}
}

/**
 * `dragover`/`dragenter` share this: both mean "the pointer is currently
 * over something inside the file explorer, decide whether to claim it." A
 * `dragenter` that isn't intercepted still needs the native chain to run its
 * own `dragenter` handling normally (e.g. the hover-to-expand-a-folder timer
 * `DragManager` drives off it), which is exactly what happens by default —
 * this only ever prevents that by calling `preventDefault()`, and only when
 * `safeResolveDrop` actually found a drop this plugin wants to own.
 *
 * Auto-scroll runs first, before `safeResolveDrop`'s own early return below
 * — deliberately, not an oversight. The pointer sitting over the middle of a
 * folder row (native "move into this folder" territory, not a position this
 * plugin claims) is exactly when a user is most likely to still be hunting
 * for a target further up or down the tree, so the edges must keep scrolling
 * there too, not only while the pointer happens to be over a row this plugin
 * has decided to intercept.
 */
function handleDragOverLike(host: MoveItemHost, indicator: DropIndicator, scroller: AutoScroller, evt: DragEvent): void {
	updateAutoScroll(host, scroller, evt);

	const resolved = safeResolveDrop(host, evt.target, evt.clientY);
	if (resolved === null) {
		// Not merely "do nothing". The pointer has moved from a zone this file
		// claimed into one it doesn't — the middle of a folder row, a row it
		// refuses to anchor on, or simply out of the rows entirely — and
		// nothing else will take the indicator down: `dragleave` fires on
		// every row-to-row crossing but is deliberately ignored unless the
		// pointer left the file explorer altogether, and the native handlers
		// know nothing about this line. Left uncleared, the previous row would
		// stay lit while the pointer sits over a zone that is about to drop
		// natively, promising "insert here" for a drop that will instead move
		// the item into a folder.
		indicator.clear();
		return;
	}

	evt.preventDefault();
	if (evt.dataTransfer !== null) evt.dataTransfer.dropEffect = 'move';

	// Only on an actual transition, not on every event. Once `preventDefault()`
	// above has run, the file explorer's own `dragenter`/`dragover` handlers
	// for this element never execute at all for this event (see the module doc
	// comment) — which means whatever `is-being-dragged-over` highlight one of
	// *those* handlers painted on a previous frame is never revisited by them,
	// and never gets cleared. Left alone, that highlight and this plugin's own
	// indicator line would show at once — one saying "drop into this folder,"
	// the other "insert here" — which is a direct contradiction, not just
	// visual noise. `updateHover(null, '')` is DragManager's own way of saying
	// "nothing is currently hovered," which is the accurate state once this has
	// taken the event over.
	//
	// Clearing it once is enough, and calling it per event was measurably
	// harmful: `dragover` arrives per mouse message — 392/s measured on a
	// high-polling-rate mouse, over eight seconds of hovering — and this is a
	// DOM write interleaved with the `getBoundingClientRect()` `resolveDrop`
	// does just above, which is the classic shape of layout thrashing. While
	// this plugin keeps intercepting, nothing repaints that highlight anyway:
	// the handlers that would are the ones `preventDefault()` is stopping.
	if (!indicator.show(resolved.rowEl, resolved.side)) return;

	const dragManager = (host.app as AppWithDragManager).dragManager;
	if (typeof dragManager?.updateHover === 'function') {
		dragManager.updateHover(null, '');
	}
}

/**
 * Only clears the indicator when the pointer has actually left
 * `containerEl` altogether — `dragleave` also fires every time the pointer
 * crosses from one child element into another (e.g. row to row), which would
 * otherwise flicker the indicator off between every pair of adjacent rows.
 * `relatedTarget` is the element the pointer is entering; `null`/non-`Node`
 * covers leaving the window entirely, which `Node.contains` can't be asked
 * about.
 *
 * A real leave also stops auto-scroll: the pointer is no longer anywhere
 * inside the file explorer, so there is nothing left for it to be near the
 * edge of.
 */
function handleDragLeave(containerEl: HTMLElement, indicator: DropIndicator, scroller: AutoScroller, evt: DragEvent): void {
	const related = evt.relatedTarget;
	if (related instanceof Node && containerEl.contains(related)) return;
	indicator.clear();
	scroller.stop();
}

function handleDrop(host: MoveItemHost, indicator: DropIndicator, scroller: AutoScroller, evt: DragEvent): void {
	// Unconditional, even before knowing whether this drop is one this
	// plugin claims: either way the drag is over, and there is nothing left
	// to auto-scroll toward.
	scroller.stop();

	// Recomputed rather than trusting whatever the last `dragover` decided:
	// the pointer position and the live vault state can both have changed in
	// the time between that event and this one (however short), and this is
	// the event that actually writes something — it gets its own fresh
	// answer, not a cached one.
	const resolved = safeResolveDrop(host, evt.target, evt.clientY);
	if (resolved === null) return;

	evt.preventDefault();
	indicator.clear();
	void performDrop(host, resolved.dragged, resolved.anchor, resolved.side);
}

/**
 * Runs `applyDrop` (`moveItem.ts`) and reports the outcome. Deliberately
 * separate from `main.ts`'s `moveFile`, which this otherwise mirrors
 * outcome-by-outcome (same auto-refresh/no-leaf handling for `'moved'`, same
 * `unusableReason()`-based text for `'refused'`): a drag-and-drop failure
 * needs two cases of its own that `moveFile`'s four move actions can never
 * produce, since they never rename anything — `'move-failed'` (a cross-folder
 * drop whose `renameFile` call failed, most often a name collision at the
 * destination) and `'moved-unsaved'` (the rename landed but the order behind
 * it did not).
 */
async function performDrop(host: MoveItemHost, dragged: TFile | TFolder, anchor: TFile | TFolder, side: DropSide): Promise<void> {
	const { outcome, error } = await applyDrop(host, dragged, anchor, side);

	// Silence, not a message: either nothing changed (dropped back where it
	// already was), or reordering itself is the feedback — same reasoning
	// `moveFile` gives for not showing a Notice on every direct move.
	if (outcome === 'unchanged') return;

	if (outcome === 'refused') {
		refusalNotice('move', host.store, 'from elsewhere');
		return;
	}

	// Named once for both outcomes below, which are the two that mention where
	// the drop was headed.
	const dest = anchor.parent;
	const destLabel = dest === null || dest.isRoot() ? 'the vault root' : dest.name;

	if (outcome === 'move-failed') {
		new Notice(`Could not move ${dragged.name} into ${destLabel}. ${error ?? 'See the console for details.'}`);
		return;
	}

	// Deliberately not worded as a failure, unlike the two above: the file is
	// at its destination and will stay there. Saying "could not move" here
	// would send somebody looking for it where it no longer is, so this names
	// what did happen first and what was lost second.
	if (outcome === 'moved-unsaved') {
		new Notice(
			`Moved ${dragged.name} into ${destLabel}, but its position there could not be saved: ` +
				`${unusableClause(host.store)}. ${repairPointer('from elsewhere')}`,
		);
		return;
	}

	// 'moved'
	reportApplied(host.app, host.settings.autoRefresh, 'Saved');
}

/**
 * Registers every listener this file needs on one file explorer view's
 * `containerEl`, once. `dragover`/`dragenter`/`drop` are capture-phase (see
 * the module doc comment for why capture matters); `dragleave` is capture
 * too, purely so all four share one consistent phase rather than mixing
 * them for no reason. `dragend` goes on `window`, not `containerEl`: a drag
 * can end (drop, or Escape) with the pointer anywhere, including outside the
 * file explorer entirely, and this is the one event guaranteed to fire
 * either way — the backstop that guarantees the indicator line never
 * survives past the drag that drew it, even on a path this file's own
 * `dragleave`/`drop` handling didn't anticipate. The same backstop covers
 * `AutoScroller`: `dragend` stopping it is what guarantees a drag that ends
 * with the pointer outside `containerEl` entirely (so neither `drop` nor a
 * "real" `dragleave` on this element necessarily fired first) still leaves
 * no rAF loop running.
 *
 * Returns its own disarm function instead of routing teardown through
 * `host.registerDomEvent`/`host.register`. Those hold until the *plugin*
 * unloads, and this is armed per view: `registerDomEvent` is
 * `addEventListener` plus a `register()` closure capturing the element
 * (verified in `obsidian-internals.md`), so every rebuilt file explorer added
 * four dead-element listeners, one more `window` `dragend` handler firing on
 * every drag anywhere in the app, and a strong reference pinning a detached
 * 150-row subtree — the exact opposite of what the `WeakSet` in
 * `installExplorerDrag` was there to achieve. The caller owns these and reaps
 * them when the view goes away.
 *
 * `dragend` goes on the window `containerEl` actually lives in, so a
 * popped-out explorer's drags are covered by their own window rather than by
 * a background one that never sees them.
 */
function armCaptureListeners(host: MoveItemHost, containerEl: HTMLElement): () => void {
	const indicator = new DropIndicator();
	const scroller = new AutoScroller(containerEl, (clientX, clientY) => refreshIndicatorAfterScroll(host, indicator, containerEl, clientX, clientY));
	const win = windowFor(containerEl);

	const removers: (() => void)[] = [];
	// `handler` is declared over `DragEvent` and cast once here, rather than at
	// each call site: every listener this file installs is a drag listener, and
	// four `evt as DragEvent` casts would say so four times.
	const on = (target: EventTarget, type: string, handler: (evt: DragEvent) => void, options?: AddEventListenerOptions): void => {
		const listener = handler as EventListener;
		target.addEventListener(type, listener, options);
		removers.push(() => target.removeEventListener(type, listener, options));
	};

	const onDragOverLike = (evt: DragEvent): void => handleDragOverLike(host, indicator, scroller, evt);
	on(containerEl, 'dragover', onDragOverLike, { capture: true });
	on(containerEl, 'dragenter', onDragOverLike, { capture: true });
	on(containerEl, 'drop', (evt) => handleDrop(host, indicator, scroller, evt), { capture: true });
	on(containerEl, 'dragleave', (evt) => handleDragLeave(containerEl, indicator, scroller, evt), { capture: true });
	on(win, 'dragend', () => {
		indicator.clear();
		scroller.stop();
	});

	// Belt-and-suspenders alongside removing the listeners: that stops *future*
	// events reaching these handlers, but says nothing about an
	// `eoe-drop-before`/`eoe-drop-after` class already sitting on a row, or a
	// rAF loop already scheduled, at the moment the view is destroyed or the
	// plugin disabled mid-drag. Clearing both here guarantees neither outlives
	// the listeners that would otherwise have cleaned them up.
	return () => {
		for (const remove of removers) remove();
		removers.length = 0;
		indicator.clear();
		scroller.stop();
	};
}

/**
 * Wires up self-rendered drag-and-drop for the file explorer. Call once, from
 * `onLayoutReady` — plugin load order does not guarantee the `file-explorer`
 * leaf exists yet, and it may still be a deferred, lazily constructed leaf the
 * first time this runs.
 *
 * Unlike `installExplorerSort` (`explorerSort.ts`), this **keeps listening for
 * the life of the plugin instead of stopping after one success**, because the
 * two install fundamentally different things. That patch goes on the file
 * explorer view's shared *prototype*, so it covers every instance Obsidian
 * ever constructs, including ones built long afterwards. These listeners live
 * on one view instance's own `containerEl`, and a rebuilt file explorer has a
 * new one.
 *
 * Confirmed by hand rather than assumed: detaching the `file-explorer` leaf
 * and reopening it yields a different `containerEl`, and dragging in the tree
 * then silently stops working until the plugin is reloaded. Rendering keeps
 * working throughout — the prototype patch is untouched — which is exactly
 * what made it invisible: the saved order still looks right, so nothing points
 * at the drag having come loose.
 *
 * `armed` maps each armed element to its disarm function, rather than being an
 * "installed" boolean. `layout-change` fires constantly, and arming the *same*
 * element twice would stack duplicate capture handlers, so a single drop would
 * be written more than once.
 *
 * It was a `WeakSet`, for the stated purpose of letting a destroyed view's
 * element stay collectable — which it never achieved, because
 * `host.registerDomEvent` retained that element strongly for the plugin's
 * whole life anyway. Weakness was the wrong tool for the job: nothing was ever
 * *disarmed*, so detached explorers kept their listeners (including a `window`
 * `dragend` each, all firing on every drag in the app) no matter how the
 * element was held. The reap below is the actual fix, and it needs the disarm
 * function, which means holding the entry strongly until it runs.
 *
 * Every real `file-explorer` view is armed, not just the first: `explorerViews`
 * (`fileExplorerLeaves.ts`) walks every leaf `getLeavesOfType` returns and
 * filters to the ones `isFileExplorerViewHandle` above recognizes as real,
 * which is what keeps a deferred leaf's placeholder view — sitting ahead of
 * or behind a real one in the list — from ever reaching `armCaptureListeners`.
 */
export function installExplorerDrag(host: MoveItemHost): void {
	const armed = new Map<HTMLElement, () => void>();

	const armAll = (): void => {
		const live = new Set<HTMLElement>();
		for (const view of explorerViews(host.app, isFileExplorerViewHandle)) {
			const { containerEl } = view;
			live.add(containerEl);
			if (armed.has(containerEl)) continue;
			armed.set(containerEl, armCaptureListeners(host, containerEl));
		}

		// Reap in the same pass that arms, and on the same event: a detached or
		// rebuilt file explorer is exactly what `layout-change` announces, so
		// the element stops being reachable here at the moment it stops being
		// used. Anything still armed but no longer belonging to a live view is
		// a detached subtree whose listeners can only misfire.
		for (const [containerEl, disarm] of armed) {
			if (live.has(containerEl)) continue;
			armed.delete(containerEl);
			disarm();
		}
	};

	armAll();
	host.registerEvent(host.app.workspace.on('layout-change', armAll));
	// The plugin outliving a view is handled by the reap above; this is the
	// other direction — views outliving the plugin, which is every armed
	// element at the moment it is disabled.
	host.register(() => {
		for (const disarm of armed.values()) disarm();
		armed.clear();
	});
}
