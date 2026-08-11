/**
 * Finds file explorer leaves — the one thing every caller that walks
 * `app.workspace.getLeavesOfType('file-explorer')` needs done identically,
 * and, until this module existed, the thing that had drifted into five
 * separate copies of the same loop (`explorerSort.ts` twice, `indexFile.ts`,
 * `main.ts`, `explorerDrag.ts`), each restating why in its own prose.
 *
 * `getLeavesOfType` matches on `view.getViewType()`, not on whether the view
 * has actually finished constructing. Obsidian defers leaves it has not yet
 * had to show — a background tab, a collapsed sidebar, a leaf restored from
 * the last session before the layout is ready — and a deferred leaf's stand-in
 * view answers `getViewType()` with `'file-explorer'` just like the real one
 * does. So it comes back from `getLeavesOfType` too, indistinguishable by type
 * alone from a fully-built file explorer view, and its `.view` carries none of
 * the members a real one has. "The leaf exists" and "the view is real" are two
 * different facts, and only a runtime probe on `.view` — the type guard every
 * caller here supplies as `isReal` — can tell them apart.
 *
 * Skip that probe, or worse, read `[0]` and assume a leaf that exists has
 * already passed it, and a real file explorer sitting behind a deferred one
 * in the leaf list reads as "no explorer at all" — silently, with nothing to
 * catch, because the deferred leaf is a legitimate object the whole way
 * through. It is simply not the one being asked for. That is the bug this
 * module exists to make impossible to reintroduce one call site at a time.
 *
 * `isReal` stays each caller's own type guard on purpose — it is not
 * something this module tries to centralize too. `explorerSort.ts` needs
 * `getSortedFolderItems`/`requestSort`, `indexFile.ts` needs only
 * `requestSort`, `main.ts` needs `containerEl`/`tree`, and `explorerDrag.ts`
 * needs `requestSort` again but declares it independently rather than sharing
 * `indexFile.ts`'s interface. Folding those into one shared predicate would
 * make every caller's realness check depend on members it never reads, so an
 * addition to one caller's probe could silently start rejecting (or start
 * accepting) another caller's leaves. What was actually duplicated, and what
 * had drifted, was never the probe — it was the iteration over
 * `getLeavesOfType`'s result and the knowledge that deferred leaves belong in
 * it. That, and only that, is what lives here now.
 */
import type { App, View } from 'obsidian';

const FILE_EXPLORER_VIEW_TYPE = 'file-explorer';

/**
 * Every leaf whose view passes `isReal`, in the order `getLeavesOfType`
 * returns them, with deferred (or otherwise not-yet-real) leaves silently
 * skipped rather than reported.
 *
 * For callers that must reach *every* open file explorer, not just one — e.g.
 * two explorers open side by side, both of which need to be told to
 * re-render after the same write.
 */
export function explorerViews<V extends View>(app: App, isReal: (view: View) => view is V): V[] {
	const views: V[] = [];
	for (const leaf of app.workspace.getLeavesOfType(FILE_EXPLORER_VIEW_TYPE)) {
		if (isReal(leaf.view)) views.push(leaf.view);
	}
	return views;
}

/**
 * The first leaf whose view passes `isReal`, or `undefined` if none does.
 *
 * Not `explorerViews(app, isReal)[0]`: most callers only need one file
 * explorer to act on (there is usually exactly one open), and this stops at
 * the first match instead of first filtering every leaf and then indexing
 * in. The two are equivalent in what they return — the difference is only
 * that this one never has to build the full list a caller is about to throw
 * most of away.
 */
export function firstExplorerView<V extends View>(app: App, isReal: (view: View) => view is V): V | undefined {
	for (const leaf of app.workspace.getLeavesOfType(FILE_EXPLORER_VIEW_TYPE)) {
		if (isReal(leaf.view)) return leaf.view;
	}
	return undefined;
}

/**
 * The first view whose `containerEl` holds focus, or `undefined` when none
 * does — which includes there being no real explorer to begin with.
 *
 * "Which explorer is the user acting in", for callers that would otherwise
 * silently answer `firstExplorerView` and act on a view nobody is looking at.
 * With one explorer open — the ordinary case — the two agree. With two, they
 * do not: `getSortedFolderItems` returns genuinely different rows per view for
 * a folder that has *no* stored order, because the patch falls through to the
 * original, and `sortOrder` is per-view state. (Folders that do have a stored
 * order agree everywhere; the patch answers those from the index.)
 *
 * Focus is read through `containerEl.ownerDocument` rather than the global
 * `document`, so this still answers correctly for an explorer popped out into
 * its own window.
 *
 * Not proof the user is looking at the returned view, and callers must not
 * treat it as such: each document has its own `activeElement`, so with a
 * popped-out explorer this can match a view whose window is not frontmost.
 *
 * `undefined` means "no explorer has focus", which is a different answer from
 * "there is no explorer" and callers use it differently: `moveHotkeyTarget`
 * (`main.ts`) needs exactly this, because the whole point there is to fall
 * through to the active note when the tree does not have focus. A caller that
 * wants "focused, else any" wants `actingExplorerView` below instead — one
 * pass rather than this one plus `firstExplorerView`.
 */
export function focusedExplorerView<V extends View>(app: App, isReal: (view: View) => view is V): V | undefined {
	for (const leaf of app.workspace.getLeavesOfType(FILE_EXPLORER_VIEW_TYPE)) {
		const { view } = leaf;
		if (!isReal(view)) continue;
		if (holdsFocus(view)) return view;
	}
	return undefined;
}

/**
 * The explorer the user is acting in: the focused one, or the first real one
 * when none has focus.
 *
 * "Which explorer is this action about" for callers that must name one either
 * way — reading a folder's rendered order, say, where there is no useful
 * "nobody has focus" answer. With a single explorer open, the ordinary case,
 * it is that one; the distinction only exists once two are.
 *
 * One walk, not `focusedExplorerView(...) ?? firstExplorerView(...)`: written
 * that way, the fallback path (which includes every command-palette
 * evaluation, since the palette input holds the focus) walked every leaf
 * twice, and the rule ended up spelled out at the call site instead of having
 * a name.
 */
export function actingExplorerView<V extends View>(app: App, isReal: (view: View) => view is V): V | undefined {
	let firstReal: V | undefined;
	for (const leaf of app.workspace.getLeavesOfType(FILE_EXPLORER_VIEW_TYPE)) {
		const { view } = leaf;
		if (!isReal(view)) continue;
		if (holdsFocus(view)) return view;
		firstReal ??= view;
	}
	return firstReal;
}

/** Read through the view's own `ownerDocument`, so a popped-out explorer is judged against its own window's focus rather than the main one's. */
function holdsFocus(view: View): boolean {
	const { containerEl } = view;
	return containerEl.contains(containerEl.ownerDocument.activeElement);
}
