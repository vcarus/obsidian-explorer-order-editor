/**
 * Pure geometry for reading a file-explorer row during a self-rendered drag:
 * which band of the row the pointer is over decides whether a drop reorders
 * "before" the row, "after" it, or should fall through to Obsidian's own
 * drop handling. For a folder row, the native behavior a fall-through drop
 * gets is "move the dragged item into this folder" — so the middle of a
 * folder row is deliberately left unclaimed here.
 *
 * Zero imports — including `./types` — so this stays as directly
 * unit-testable as `rowMove.ts`. The (not yet written) drag handler owns
 * turning live DOM measurements into the plain numbers this takes.
 */

export type DropSide = 'before' | 'after';

/**
 * `file` rows have no native drop target to protect — Obsidian has nothing
 * to do with a note dropped "into" it — so a file row splits into exactly
 * two halves. Folder rows do have a native target (drop into the folder),
 * and how much of the row that target claims differs between a collapsed
 * folder (no children visible to drop "before" instead) and an expanded one
 * (see `dropSideFor`'s doc comment for why expanded folders also lose the
 * `after` zone entirely).
 */
export type RowKind = 'file' | 'collapsed-folder' | 'expanded-folder';

// Fraction of a folder row's height claimed by the "before"/"after" bands
// before the rest falls through to Obsidian's native drop-into-folder
// handling.
const EDGE_BAND = 0.25;

/**
 * Reads which hot zone `pointerY` falls into within the row spanning
 * `[rowTop, rowTop + rowHeight)`, given the row's `kind`. Returns `null`
 * when the pointer is over the band that should fall through to Obsidian's
 * native drop handling rather than being intercepted by this plugin.
 *
 * `rowHeight <= 0` returns `null` as a division-by-zero guard (and, for a
 * negative height, a guard against a fraction whose sign would invert every
 * comparison below) — a row with no measured height can't sensibly host a
 * drop zone at all.
 *
 * `fraction` is clamped to `[0, 1]` rather than the function returning
 * `null` for an out-of-range value. The caller only ever asks this about the
 * row directly under the pointer, so a fraction outside `[0, 1]` can only be
 * sub-pixel rounding right at that row's own edge, never the pointer
 * actually being over some other row. Returning `null` there instead of
 * clamping would carve out a dead band on the row's boundary that responds
 * to nothing.
 *
 * Every band is a half-open interval so each fraction in `[0, 1]` lands in
 * exactly one of them — no overlap, no gap:
 * - `file`: `[0, 0.5)` before, `[0.5, 1]` after. No native target to protect,
 *   so the whole row splits in two.
 * - `collapsed-folder`: `[0, 0.25)` before, `[0.25, 0.75)` native (`null`),
 *   `[0.75, 1]` after.
 * - `expanded-folder`: `[0, 0.25)` before, `[0.25, 1]` native (`null`).
 *   There is no `after` band here, on purpose: an expanded folder's bottom
 *   edge is, visually, the exact same line as its first child's top edge (or
 *   just the folder's own bottom edge, if it happens to be empty or fully
 *   collapsed-away inside). "After this expanded folder" and "before its
 *   first child" would be the same pixels meaning two different parent
 *   folders, and there is no reliable way to tell which one the pointer
 *   meant. Rather than guess, that whole band is left native (drop into the
 *   folder); a drop actually meant to land right after an expanded folder
 *   can still be made by dropping before its first child instead.
 */
export function dropSideFor(pointerY: number, rowTop: number, rowHeight: number, kind: RowKind): DropSide | null {
	if (rowHeight <= 0) return null;

	const raw = (pointerY - rowTop) / rowHeight;
	const fraction = Math.min(1, Math.max(0, raw));

	switch (kind) {
		case 'file':
			return fraction < 0.5 ? 'before' : 'after';
		case 'collapsed-folder':
			if (fraction < EDGE_BAND) return 'before';
			if (fraction >= 1 - EDGE_BAND) return 'after';
			return null;
		case 'expanded-folder':
			return fraction < EDGE_BAND ? 'before' : null;
	}
}

/**
 * How many pixels the drag-driven auto-scroll (`explorerDrag.ts`)
 * should move a scroll container by this frame, given the pointer's current
 * `pointerY` and the container's own `[rectTop, rectBottom)` — negative
 * scrolls up, positive scrolls down, `0` means "don't scroll." Same
 * discipline as `dropSideFor` above: this only turns plain numbers into a
 * plain number, the caller owns finding the container, measuring its rect
 * every frame, and actually writing `scrollTop`.
 *
 * Three guards return `0` outright, since none of them describe a container
 * that can sensibly be scrolled at all: a non-positive height (`rectBottom -
 * rectTop <= 0`, same division-by-zero/inverted-sign concern `dropSideFor`
 * guards against), a non-positive `zone`, or a non-positive `maxStep`.
 *
 * The container is split into an upper hot zone `[rectTop, rectTop + zone)`,
 * a lower hot zone `(rectBottom - zone, rectBottom]`, and a dead middle that
 * returns `0`. **The two hot zones are never allowed to overlap**: if the
 * container is shorter than `2 * zone`, `zone` is shrunk in place to exactly
 * `height / 2` before anything else is computed. That makes the two zones
 * meet at the container's exact midpoint with nothing left over — every
 * `pointerY` still lands in at most one of them, so there is no case where
 * both the "scroll up" and "scroll down" answers would both claim the same
 * point and something else has to arbitrate which one wins.
 *
 * Within a hot zone, speed scales linearly with how deep the pointer is
 * past the zone's *outer* edge — 0 right at the boundary with the dead
 * middle, up to `maxStep` right at the container's own edge — rather than
 * being a flat "in the zone or not." A pointer beyond the container
 * entirely (above `rectTop` or below `rectBottom`, which can happen since
 * `dragover` still fires while the pointer is over a sibling pane or a gap)
 * is depth-clamped to exactly `maxStep`: without the `Math.min(1, …)` below,
 * a pointer far off in open space would compute an ever-larger step with no
 * upper bound, which reads as the tree suddenly snapping instead of
 * scrolling.
 *
 * Both hot-zone checks are written as half-open on the side facing the dead
 * middle (`pointerY < rectTop + zone`, `pointerY > rectBottom - zone`) and
 * inclusive on the side facing outward, so a `pointerY` exactly on either
 * boundary — or, in the shrunk case, exactly on the shared midpoint — falls
 * through to the dead-middle `0` rather than either hot zone claiming it.
 * That boundary is a single point (measure zero), not a dead *band*: moving
 * one unit to either side immediately produces a nonzero step, so nothing
 * in a hot zone ever computes to a false `0`.
 */
export function scrollStepFor(pointerY: number, rectTop: number, rectBottom: number, zone: number, maxStep: number): number {
	const height = rectBottom - rectTop;
	if (height <= 0 || zone <= 0 || maxStep <= 0) return 0;

	const effectiveZone = height < 2 * zone ? height / 2 : zone;

	if (pointerY < rectTop + effectiveZone) {
		const depth = Math.min(1, (rectTop + effectiveZone - pointerY) / effectiveZone);
		return -depth * maxStep;
	}

	if (pointerY > rectBottom - effectiveZone) {
		const depth = Math.min(1, (pointerY - (rectBottom - effectiveZone)) / effectiveZone);
		return depth * maxStep;
	}

	return 0;
}
