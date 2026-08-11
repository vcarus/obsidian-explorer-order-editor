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
