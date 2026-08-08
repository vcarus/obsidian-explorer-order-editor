/**
 * Lets a drag started inside the file explorer itself reorder rows, instead
 * of only ever moving the dragged item *into* whatever folder it's dropped
 * on (M12b).
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
 * guessed — see the git history for the M12 spec this implements):
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
import { App, normalizePath, Notice, TFile, TFolder, type View } from 'obsidian';
import { dropSideFor, type DropSide, type RowKind } from './dropZone';
import { requestFileExplorerResort } from './indexFile';
import { applyDrop, type MoveItemHost } from './moveItem';

/**
 * `app.dragManager` is not part of Obsidian's public typed API — confirmed
 * absent from `obsidian.d.ts` entirely, unlike `getSortedFolderItems`/
 * `requestSort` (`explorerSort.ts`, `indexFile.ts`), which are at least
 * declared somewhere on an internal view subclass. A local interface plus a
 * runtime guard at each point of use, same discipline as everywhere else
 * this codebase reaches for an internal: never a bare `as any`, and nothing
 * declared as a `declare module 'obsidian'` augmentation of `App` itself
 * (that would make every *other* consumer of `App` believe it always has a
 * `dragManager`, which is exactly the mistake CLAUDE.md's `View`-augmentation
 * warning is about, applied to a different class).
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
 * explorer, not a still-deferred placeholder" check — `explorerSort.ts`
 * already has one (`isFileExplorerView`, checking for both
 * `getSortedFolderItems` and `requestSort`), but it's private to that file
 * and this module's job list is scoped to six specific files that does not
 * include changing `explorerSort.ts` to export it. Rather than reach into
 * that file's internals, this declares its own minimal version of the same
 * check `indexFile.ts`'s `requestFileExplorerResort` already uses for
 * exactly this purpose: `requestSort` alone is enough of a signal, since
 * this file never calls it — it only exists here to prove the view is real
 * before this trusts its `containerEl` to still be the element the real
 * file explorer keeps using, rather than one a still-loading placeholder
 * view will discard.
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
 * The one judgment shared by `dragover`, `dragenter`, and `drop` (per the
 * M12 spec — deliberately not three separate copies, so a future change to
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
function resolveDrop(host: MoveItemHost, evt: DragEvent): ResolvedDrop | null {
	if (!host.settings.dragToReorder) return null;

	const dragManager = (host.app as AppWithDragManager).dragManager;
	const draggable = dragManager?.draggable;
	if (draggable === null || draggable === undefined) return null;
	if (draggable.type !== 'file' && draggable.type !== 'folder') return null;
	// Also excludes editor-originated link drags (`type: 'link'`, which also
	// carries a `.file`) and multi-select drags (`type: 'files'`, no `.file`
	// at all) — treating a dropped *link* as a request to move the file it
	// points at would move a file the user never picked up, and multi-select
	// is out of scope for this milestone (M12c).
	const draggedFile: unknown = draggable.file;
	if (!(draggedFile instanceof TFile) && !(draggedFile instanceof TFolder)) return null;
	const dragged: TFile | TFolder = draggedFile;

	if (!(evt.target instanceof Element)) return null;
	const rowEl = evt.target.closest('.nav-file-title, .nav-folder-title');
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
	const indexNotePath = normalizePath(host.settings.indexPath);
	if (anchor.path === indexNotePath || dragged.path === indexNotePath) return null;

	const dest = anchor.parent;
	if (dest === null) return null;

	// A folder can't be dropped into itself or anything already inside it —
	// the same guard `OrderModal.ts`'s navigation has for entering a
	// subfolder, applied here to the *destination* of a move instead.
	if (dragged instanceof TFolder && (dest.path === dragged.path || dest.path.startsWith(`${dragged.path}/`))) {
		return null;
	}

	const rect = rowEl.getBoundingClientRect();
	const side = dropSideFor(evt.clientY, rect.top, rect.height, rowKindFor(anchor, rowEl));
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
 * `resolveDrop` wrapped in a `try`/`catch` that treats any exception the
 * same as a deliberate `null`: Obsidian's internals changed under us, or
 * something above misbehaved, and the only safe response is to hand the
 * event back to native handling rather than let a thrown error leave the
 * drag in a broken state (or, worse, propagate out of a capture-phase
 * listener and break every *other* capture-phase listener on the same
 * element). Logged once per call, not deduplicated — same policy
 * `explorerSort.ts`'s replacement takes for the same reason.
 */
function safeResolveDrop(host: MoveItemHost, evt: DragEvent): ResolvedDrop | null {
	try {
		return resolveDrop(host, evt);
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

	show(rowEl: HTMLElement, side: DropSide): void {
		if (this.el === rowEl && this.side === side) return;
		this.clear();
		rowEl.classList.add(side === 'before' ? 'eoe-drop-before' : 'eoe-drop-after');
		this.el = rowEl;
		this.side = side;
	}

	clear(): void {
		this.el?.classList.remove('eoe-drop-before', 'eoe-drop-after');
		this.el = null;
		this.side = null;
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
 */
function handleDragOverLike(host: MoveItemHost, indicator: DropIndicator, evt: DragEvent): void {
	const resolved = safeResolveDrop(host, evt);
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
	indicator.show(resolved.rowEl, resolved.side);

	// Once `preventDefault()` above has run, the file explorer's own
	// `dragenter`/`dragover` handlers for this element never execute at all
	// for this event (see the module doc comment) — which means whatever
	// `is-being-dragged-over` highlight one of *those* handlers painted on a
	// previous frame is never revisited by them, and never gets cleared.
	// Left alone, that highlight and this plugin's own indicator line would
	// show at once — one saying "drop into this folder," the other "insert
	// here" — which is a direct contradiction, not just visual noise.
	// `updateHover(null, '')` is DragManager's own way of saying "nothing is
	// currently hovered," which is the accurate state once this has taken
	// the event over.
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
 */
function handleDragLeave(containerEl: HTMLElement, indicator: DropIndicator, evt: DragEvent): void {
	const related = evt.relatedTarget;
	if (related instanceof Node && containerEl.contains(related)) return;
	indicator.clear();
}

function handleDrop(host: MoveItemHost, indicator: DropIndicator, evt: DragEvent): void {
	// Recomputed rather than trusting whatever the last `dragover` decided:
	// the pointer position and the live vault state can both have changed in
	// the time between that event and this one (however short), and this is
	// the event that actually writes something — it gets its own fresh
	// answer, not a cached one.
	const resolved = safeResolveDrop(host, evt);
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
 * needs its own `'move-failed'` case (a cross-folder drop whose
 * `renameFile` call failed, most often a name collision at the destination)
 * that `moveFile`'s four move actions can never produce, since they never
 * rename anything.
 */
async function performDrop(host: MoveItemHost, dragged: TFile | TFolder, anchor: TFile | TFolder, side: DropSide): Promise<void> {
	const { outcome, error } = await applyDrop(host, dragged, anchor, side);

	// Silence, not a message: either nothing changed (dropped back where it
	// already was), or reordering itself is the feedback — same reasoning
	// `moveFile` gives for not showing a Notice on every direct move.
	if (outcome === 'unchanged') return;

	if (outcome === 'refused') {
		new Notice(
			`Could not move: the order note ${host.store.unusableReason() ?? 'could not be repaired'}. ` +
				'Use "Repair the order note" in settings, or check the console for details.',
		);
		return;
	}

	if (outcome === 'move-failed') {
		const dest = anchor.parent;
		const destLabel = dest === null || dest.isRoot() ? 'the vault root' : dest.name;
		new Notice(`Could not move ${dragged.name} into ${destLabel}. ${error ?? 'See the console for details.'}`);
		return;
	}

	// 'moved'
	if (!host.settings.autoRefresh) {
		new Notice('Automatic refresh is off. The file explorer will show this on its next refresh.');
		return;
	}

	if (!requestFileExplorerResort(host.app)) {
		new Notice('Saved. The file explorer will show this when you next open it.');
	}
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
 * `dragleave`/`drop` handling didn't anticipate.
 */
function armCaptureListeners(host: MoveItemHost, containerEl: HTMLElement): void {
	const indicator = new DropIndicator();

	host.registerDomEvent(containerEl, 'dragover', (evt) => handleDragOverLike(host, indicator, evt), { capture: true });
	host.registerDomEvent(containerEl, 'dragenter', (evt) => handleDragOverLike(host, indicator, evt), { capture: true });
	host.registerDomEvent(containerEl, 'drop', (evt) => handleDrop(host, indicator, evt), { capture: true });
	host.registerDomEvent(containerEl, 'dragleave', (evt) => handleDragLeave(containerEl, indicator, evt), { capture: true });
	host.registerDomEvent(window, 'dragend', () => indicator.clear());

	// Belt-and-suspenders alongside `registerDomEvent`'s own teardown: those
	// calls stop *future* events from reaching these handlers on unload, but
	// say nothing about a `eoe-drop-before`/`eoe-drop-after` class already
	// sitting on a row at the moment the plugin is disabled mid-drag. This
	// guarantees that class is gone too, so a disabled/reloaded plugin never
	// leaves a stray line on the tree.
	host.register(() => indicator.clear());
}

/**
 * Wires up self-rendered drag-and-drop for the file explorer. Call once,
 * from `onLayoutReady` — same reasoning as `installExplorerSort`
 * (`explorerSort.ts`): plugin load order does not guarantee the
 * `file-explorer` leaf exists yet, and it may still be a deferred, lazily
 * constructed leaf the first time this runs. When it isn't ready
 * (`isFileExplorerViewHandle` fails), this retries on every `layout-change`
 * until it succeeds once, then stops listening — a leaf that has already
 * produced a real file explorer view is not expected to stop being one.
 */
export function installExplorerDrag(host: MoveItemHost): void {
	const tryInstall = (): boolean => {
		const leaf = host.app.workspace.getLeavesOfType('file-explorer')[0];
		if (leaf === undefined) return false;
		if (!isFileExplorerViewHandle(leaf.view)) return false;
		armCaptureListeners(host, leaf.view.containerEl);
		return true;
	};

	if (tryInstall()) return;

	const ref = host.app.workspace.on('layout-change', () => {
		if (tryInstall()) host.app.workspace.offref(ref);
	});
	host.registerEvent(ref);
}
